// SERV Reasoning client. Plain fetch against the OpenAI-format chat completions
// endpoint, plus the SERV Tools Spendgrade relies on:
//   serv_prompt_guard  - screens agent-written text for injection before the model runs
//   serv_shadow_agent  - validates the draft against a testable hint and revises it
// Every call returns a step record for the audit trail (never the API key).
import { createHash } from 'node:crypto';
import { SERV_BASE, SERV_API_KEY } from './config.js';
import { validate } from './validate.js';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export class ServError extends Error {
  constructor(message, step) {
    super(message);
    this.step = step;
  }
}

export async function servJSON({
  title,
  model,
  system,
  promptVersion,
  user,
  schema,
  schemaName,
  schemaVersion,
  shadowHint,
  maxIterations = 3,
  guard = false,
  reasoningEffort = 'low',
  maxTokens,
  timeoutMs = 300000,
}) {
  if (!SERV_API_KEY) throw new Error('SERV_API_KEY is not set (Credentials/keys.env)');
  const tools = [];
  if (guard) tools.push({ type: 'function', function: { name: 'serv_prompt_guard' } });
  if (shadowHint) {
    tools.push({
      type: 'function',
      function: {
        name: 'serv_shadow_agent',
        description: 'Enable SERV shadow-agent validation.',
        parameters: {
          type: 'object',
          properties: {
            hint: { type: 'string', default: shadowHint },
            max_iterations: { type: 'integer', default: maxIterations },
          },
        },
      },
    });
  }
  const userContent = typeof user === 'string' ? user : JSON.stringify(user, null, 2);
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
  };
  if (tools.length) body.tools = tools;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  // A generous ceiling keeps SERV's up-front balance estimate bounded; Day One
  // guidance warns against tight caps, so this sits well above observed usage.
  if (maxTokens) body.max_completion_tokens = maxTokens;

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res, text;
  try {
    res = await fetch(`${SERV_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERV_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - t0;
  const headers = {};
  res.headers.forEach((v, k) => {
    if (/^(x-|openserv|serv|request-id|cf-ray)/i.test(k) && !/key|auth|cookie/i.test(k)) headers[k] = v;
  });
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = { unparsed: text.slice(0, 4000) };
  }

  const step = {
    kind: 'serv',
    title,
    startedAt,
    latencyMs,
    endpoint: 'POST /v1/chat/completions',
    httpStatus: res.status,
    model,
    servFeatures: {
      kronos: /-serv-.*kronos/.test(model),
      multipath: /-serv-.*multipath/.test(model),
      promptGuard: guard,
      shadowAgent: shadowHint ? { hint: shadowHint, maxIterations } : null,
      maxCompletionTokens: maxTokens || null,
      structuredOutput: schemaName,
      reasoningEffort,
    },
    promptVersion,
    systemPromptSha256: sha256(system),
    schemaVersion,
    request: { user: userContent },
    responseHeaders: headers,
    completionId: raw?.id || null,
    finishReason: raw?.choices?.[0]?.finish_reason || null,
    usage: raw?.usage || null,
    output: null,
    validation: null,
    error: null,
  };

  if (!res.ok) {
    step.error = raw?.error?.message || `HTTP ${res.status}`;
    step.rawError = raw;
    throw new ServError(`SERV ${title} failed: ${step.error}`, step);
  }
  const msg = raw?.choices?.[0]?.message || {};
  const content = msg.content ?? '';
  step.rawContent = content;
  if (msg.refusal) step.refusal = msg.refusal;
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    step.error = step.finishReason === 'content_filter' ? 'Blocked by SERV content filter' : step.finishReason === 'length' ? 'Ran out of output tokens before answering (finish_reason length)' : 'Output was not valid JSON';
    step.validation = { ok: false, errors: [step.error] };
    throw new ServError(`SERV ${title}: ${step.error}`, step);
  }
  step.output = parsed;
  step.validation = validate(schema, parsed);
  if (!step.validation.ok) {
    step.error = 'Schema validation failed';
    throw new ServError(`SERV ${title}: schema validation failed: ${step.validation.errors.join('; ')}`, step);
  }
  return { output: parsed, step };
}
