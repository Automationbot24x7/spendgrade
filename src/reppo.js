// Reppo Evaluation API client (Eval Router). Each submission is scored 0-100 by a
// panel of independent, stake-weighted evaluators and routed ship / review / block,
// usually within 30-90 seconds. Several evaluations may be in flight at once.
import { REPPO_BASE, REPPO_API_KEY } from './config.js';

async function call(method, path, body) {
  if (!REPPO_API_KEY) throw new Error('REPPO_API_KEY is not set (Credentials/keys.env)');
  const res = await fetch(`${REPPO_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${REPPO_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { unparsed: text.slice(0, 500) };
  }
  if (!res.ok) {
    const err = new Error(`Reppo ${method} ${path} -> ${res.status}: ${json.error || json.message || text.slice(0, 160)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export async function submitEvaluation({ taskType = 'action', input }) {
  const startedAt = new Date().toISOString();
  const res = await call('POST', '/agents/evals', { taskType, input });
  return {
    id: res.id,
    status: res.status,
    step: { kind: 'reppo', title: 'Submit to Reppo', startedAt, endpoint: 'POST /api/v1/agents/evals', request: { taskType, inputChars: input.length }, response: { id: res.id, status: res.status, createdAt: res.createdAt } },
  };
}

export async function getEvaluation(id) {
  return call('GET', `/agents/evals/${encodeURIComponent(id)}`);
}

export async function waitForEvaluation(id, { pollMs = 5000, timeoutMs = 25 * 60000, onPoll } = {}) {
  const t0 = Date.now();
  for (;;) {
    const ev = await getEvaluation(id);
    onPoll?.(ev);
    if (ev.status === 'COMPLETED' || ev.status === 'FAILED') return ev;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Reppo evaluation ${id} not finished after ${timeoutMs / 60000} min`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// Submit, wait, and resubmit once if Reppo returns FAILED (failed runs are free).
// existingId resumes polling an evaluation submitted before a crash.
export async function evaluate(input, { taskType = 'action', onPoll, onSubmit, existingId } = {}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let sub;
    if (existingId && attempt === 1) {
      sub = { id: existingId, step: { kind: 'reppo', title: 'Resume Reppo evaluation', startedAt: new Date().toISOString(), response: { id: existingId } } };
    } else {
      sub = await submitEvaluation({ taskType, input });
      onSubmit?.(sub.id);
    }
    const ev = await waitForEvaluation(sub.id, { onPoll });
    if (ev.status === 'COMPLETED') return { ev, submitStep: sub.step, attempts: attempt };
    if (attempt === 2) throw new Error(`Reppo evaluation failed twice: ${JSON.stringify(ev.error || ev.result)}`);
  }
}

export const gateFailed = (g) => Boolean(g && g.severity && g.severity !== 'none' && (g.failingWeight > 0 || g.failingEvaluators?.length > 0));

// What the viewer and the underwriter need from a completed evaluation. Evaluator
// identities are kept as evaluator-1..n; the raw record stays in the run file.
export function verdictOf(ev) {
  const r = ev.result || {};
  return {
    id: ev.id,
    score: r.score ?? ev.score,
    route: r.route ?? ev.route,
    decision: r.decision,
    confidence: r.confidence,
    reason: r.reason,
    rubric: r.rubric_scores || {},
    // Reppo lists every gate it checked; a gate failed only if it carries a severity
    // and some evaluator weight fell below its floor.
    gates: (r.gates || []).map((g) => ({ dimension: g.dimension, severity: g.severity, floor: g.floor, failingWeight: g.failingWeight, failingEvaluators: g.failingEvaluators?.length || 0, failed: gateFailed(g) })),
    routeReasons: r.explain?.route_reasons || [],
    confidenceChecks: (r.explain?.confidence_checks || []).map((c) => ({ check: c.check, ok: c.ok, detail: c.detail })),
    evaluators: (r.consensus?.evaluators || []).map((e) => ({ evaluator: e.evaluator, weight: e.weight, overall: e.overall, stake: e.net_stake })),
    findings: (ev.trace?.evaluations || []).map((e) => ({ evaluator: e.evaluator, scores: e.scores, reasoning: e.reasoning, evidence: e.evidence })),
    policy: ev.trace?.policy || null,
    weighting: r.consensus?.weighting || null,
    creditsCharged: ev.creditsCharged,
    createdAt: ev.createdAt,
    completedAt: ev.completedAt,
  };
}
