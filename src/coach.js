// The coach: turns Reppo's critiques into concrete playbook rules. This is the
// feedback loop the Reppo track asks for. SERV returns typed patches, the shadow
// agent rejects generic advice, and the new playbook is the old one plus patches.
import { servJSON } from './serv.js';
import { MODELS, VERSIONS } from './config.js';

export const COACH_PROMPT = `You coach an autonomous procurement agent so it earns a higher spending limit honestly. The agent may run on any model or framework; you can only change its playbook.
You receive: the agent's current playbook, its decisions on an audit pack, one independent Reppo verdict per task (score, route, the panel's reason, rubric scores and each evaluator's findings), and a ground-truth audit.
Write playbook rules that fix the specific weaknesses the critiques and failed checks expose.
Rules:
- Each patch is one imperative rule the agent can follow on any future task, not only this audit pack. Do not leak the answers (no vendor names or amounts from the pack).
- Each patch names the verdicts, rubric dimensions or checks it addresses, citing their IDs from the input exactly.
- Remove or replace current rules that caused the weaknesses; list them in rules_to_remove by their exact text.
- 3 to 6 patches. No generic advice such as "be careful" or "do better".
- Choose reasoning_effort for the agent: low, medium or high. Prefer the lowest that should fix the issues.`;

export const COACH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['diagnosis', 'patches', 'rules_to_remove', 'reasoning_effort', 'expected_effect'],
  properties: {
    diagnosis: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['evidence_id', 'problem'],
        properties: { evidence_id: { type: 'string' }, problem: { type: 'string' } },
      },
    },
    patches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rule', 'addresses'],
        properties: { rule: { type: 'string' }, addresses: { type: 'array', items: { type: 'string' } } },
      },
    },
    rules_to_remove: { type: 'array', items: { type: 'string' } },
    reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high'] },
    expected_effect: { type: 'string' },
  },
};

export const COACH_HINT =
  'Pass only if every patch is a concrete, reusable rule that cites at least one evidence ID from the input, no patch contains a vendor name or dollar amount from the audit pack, and every task verdict not routed ship and every failed audit check is addressed by some patch.';

export async function coach({ playbook, packet, verdicts, work, onStep }) {
  // Findings only where the panel saw a problem, to keep the coach focused (and within budget).
  const weak = (v) => v.route !== 'ship' || Object.values(v.rubric).some((x) => x < 90);
  const findings = Object.fromEntries(verdicts.filter(weak).map((v) => [`reppo:${v.id}`, v.findings.filter((f) => Object.values(f.scores || {}).some((x) => x < 90)).map((f) => ({ evaluator: f.evaluator, reasoning: f.reasoning }))]));
  const input = {
    current_playbook: { version: playbook.version, rules: playbook.rules },
    decisions: work.map((w) => ({ task: w.task.id, title: w.task.title, decision: w.decision })),
    reppo_verdicts: packet.reppo_verdicts.map((v) => ({ id: v.id, task: v.task, category: v.category, score_0_100: v.score_0_100, route: v.route, confidence: v.confidence, reason: v.reason, rubric: v.rubric, failed_gates: v.failed_gates, evaluator_findings: findings[v.id] || [] })),
    failed_checks: packet.ground_truth_audit.filter((a) => !a.pass),
  };
  const { output, step } = await servJSON({
    title: `SERV coach turns Reppo critiques into playbook rules (${playbook.version} -> next)`,
    model: MODELS.coach,
    system: COACH_PROMPT,
    promptVersion: VERSIONS.coachPrompt,
    user: input,
    schema: COACH_SCHEMA,
    schemaName: 'playbook_patch',
    schemaVersion: VERSIONS.coachSchema,
    shadowHint: COACH_HINT,
    maxIterations: 1,
    reasoningEffort: 'low',
    maxTokens: 12000,
  });
  onStep?.(step);
  const remove = new Set(output.rules_to_remove);
  const kept = playbook.rules.filter((r) => !remove.has(r));
  const next = {
    version: `v${Number(playbook.version.slice(1)) + 1}`,
    origin: `Written by the SERV coach from Reppo verdicts ${packet.reppo_verdicts.map((v) => v.id).join(', ')}`,
    reasoningEffort: output.reasoning_effort,
    rules: [...kept, ...output.patches.map((p) => p.rule)],
    patches: output.patches,
    removed: playbook.rules.filter((r) => remove.has(r)),
  };
  return { patch: output, playbook: next, step };
}
