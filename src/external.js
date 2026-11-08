// An external applicant: the same agent prompts, sent straight to a model provider
// with no SERV reasoning layer. Spendgrade grades any agent; this one shows what a
// bring-your-own agent looks like when it applies through the API.
import { readFileSync, existsSync } from 'node:fs';
import { applicantSystemPrompt, taskMessage, WORK_SCHEMA } from './applicant.js';
import { validate } from './validate.js';
import { join } from 'node:path';
import { ROOT } from './config.js';

const KEY_FILE = process.env.EXTERNAL_KEY_FILE || join(ROOT, 'Credentials', 'external-key.txt');
export const EXTERNAL_MODEL = process.env.SG_EXTERNAL_MODEL || 'gemini-3.1-flash-lite';

function key() {
  if (process.env.EXTERNAL_API_KEY) return process.env.EXTERNAL_API_KEY;
  if (!existsSync(KEY_FILE)) throw new Error('No external model key configured');
  return readFileSync(KEY_FILE, 'utf8').trim();
}

const FORMAT = `Return one JSON object with exactly these fields:
task_id (string), action ("buy" | "pay" | "hold" | "escalate"), vendor (string or null), amount_usd (number: amount committed or paid now in USD, 0 if nothing),
needs_human_approval (boolean), rationale (string), checks_performed (string array), policy_refs (string array),
alternatives_considered (array of {option, why_not}).`;

export async function runExternalApplicant(pack, playbook, { onStep } = {}) {
  const system = `${applicantSystemPrompt(playbook)}\n\n${FORMAT}`;
  const results = [];
  for (const task of pack.tasks) {
    const t0 = Date.now();
    const startedAt = new Date().toISOString();
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: taskMessage(pack, task) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
    };
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EXTERNAL_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key() },
      body: JSON.stringify(body),
    });
    const raw = await res.json();
    if (!res.ok) throw new Error(`External model error ${res.status}: ${raw.error?.message}`);
    const text = raw.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    let decision;
    try {
      decision = JSON.parse(text);
    } catch {
      throw new Error(`External agent returned non-JSON for ${task.id}`);
    }
    decision.task_id = task.id;
    for (const k of ['checks_performed', 'policy_refs', 'alternatives_considered']) if (!Array.isArray(decision[k])) decision[k] = [];
    if (decision.vendor === undefined) decision.vendor = null;
    const validation = validate(WORK_SCHEMA, decision);
    const step = {
      kind: 'external',
      title: `External agent (${playbook.version}, no SERV) works task ${task.id}: ${task.title}`,
      startedAt,
      latencyMs: Date.now() - t0,
      taskId: task.id,
      runtime: 'direct model call, no SERV reasoning layer',
      usage: raw.usageMetadata ? { prompt_tokens: raw.usageMetadata.promptTokenCount, completion_tokens: raw.usageMetadata.candidatesTokenCount, total_tokens: raw.usageMetadata.totalTokenCount } : null,
      output: decision,
      validation,
    };
    onStep?.(step);
    results.push({ task, decision, step });
  }
  return results;
}
