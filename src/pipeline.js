// One credit application, end to end, with a checkpoint after every stage so a
// crash never re-spends a Reppo evaluation or a SERV call.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, MODELS, VERSIONS, TIERS } from './config.js';
import { runApplicant, groundTruthAudit, reppoInput } from './applicant.js';
import { evaluate, verdictOf } from './reppo.js';
import { spendgradeScore, tierCeiling } from './scoring.js';
import { buildPacket, underwrite, kiteSessionDraft, receipt } from './underwriter.js';
import { coach } from './coach.js';
import { runExternalApplicant } from './external.js';
import { ServError, sha256 } from './serv.js';

export const RUNS_DIR = join(ROOT, 'data', 'runs');
export const PLAYBOOKS_DIR = join(ROOT, 'data', 'playbooks');

export function loadPack(id = 'audit-pack') {
  return JSON.parse(readFileSync(join(ROOT, 'data', `${id}.json`), 'utf8'));
}
export function loadPlaybook(version) {
  return JSON.parse(readFileSync(join(PLAYBOOKS_DIR, `${version}.json`), 'utf8'));
}
export function savePlaybook(pb, runId) {
  const dir = join(PLAYBOOKS_DIR, 'generated');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}-${pb.version}.json`), JSON.stringify(pb, null, 2));
}

function codeStep(title, detail) {
  return { kind: 'code', title, startedAt: new Date().toISOString(), ...detail };
}

export class Checkpoint {
  constructor(runId) {
    mkdirSync(RUNS_DIR, { recursive: true });
    this.path = join(RUNS_DIR, `${runId}.json`);
    this.state = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { id: runId, createdAt: new Date().toISOString(), applications: [], coaching: [] };
  }
  save() {
    this.state.updatedAt = new Date().toISOString();
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export function verdictsOf(app) {
  return app.reppo.map((r) => ({ ...verdictOf(r.ev), task: r.task }));
}

// Runs (or resumes) application `index` in the checkpoint.
export async function runApplication(cp, index, { pack, playbook, request, agent = 'Quill', runtime = 'serv' }) {
  const apps = cp.state.applications;
  const app = apps[index] || (apps[index] = { index, agent, runtime, playbookVersion: playbook.version, playbook, request, steps: [], stage: 'start' });
  const push = (s) => {
    app.steps.push(s);
    cp.save();
  };

  if (!app.work) {
    log(`[${playbook.version}] ${agent} works the audit pack (${app.runtime === 'external' ? 'external agent, no SERV' : 'on SERV'})`);
    const work = app.runtime === 'external' ? await runExternalApplicant(pack, playbook, { onStep: push }) : await runApplicant(pack, playbook, { onStep: push });
    app.work = work.map((w) => ({ taskId: w.task.id, decision: w.decision }));
    app.stage = 'worked';
    cp.save();
  }
  const work = app.work.map((w) => ({ task: pack.tasks.find((t) => t.id === w.taskId), decision: w.decision }));

  if (!app.audit) {
    app.audit = groundTruthAudit(pack, work);
    push(codeStep('Ground-truth audit (deterministic)', { output: app.audit }));
    log(`[${playbook.version}] audit ${app.audit.filter((a) => a.pass).length}/${app.audit.length} checks passed`);
  }

  // One independent Reppo evaluation per task, in parallel. Each verdict is saved as
  // soon as it lands, and in-flight IDs are saved too, so a resume polls instead of
  // paying for a new evaluation.
  app.reppo ||= [];
  app.reppoInFlight ||= {};
  const pending = work.filter((w) => !app.reppo.some((r) => r.task === w.task.id));
  if (pending.length) {
    log(`[${playbook.version}] sending ${pending.length} action(s) to Reppo's evaluator panel`);
    await Promise.all(
      pending.map(async (w) => {
        const input = reppoInput(pack, w.task, w.decision);
        const t0 = Date.now();
        const { ev, submitStep, attempts } = await evaluate(input, {
          taskType: 'action',
          existingId: app.reppoInFlight[w.task.id],
          onSubmit: (id) => {
            app.reppoInFlight[w.task.id] = id;
            cp.save();
          },
        });
        const r = { task: w.task.id, input, inputSha256: sha256(input), ev, submitStep, attempts, latencyMs: Date.now() - t0 };
        delete app.reppoInFlight[w.task.id];
        app.reppo.push({ task: r.task, input: r.input, inputSha256: r.inputSha256, ev: r.ev });
        const v = verdictOf(r.ev);
        push({
        kind: 'reppo',
        title: `Reppo panel judges task ${r.task}`,
        startedAt: r.submitStep.startedAt,
        latencyMs: r.latencyMs,
        endpoint: 'POST /api/v1/agents/evals, then GET /api/v1/agents/evals/{id}',
        taskId: r.task,
        evalId: r.ev.id,
        attempts: r.attempts,
        request: { taskType: 'action', input: r.input },
        verdict: { score: v.score, route: v.route, decision: v.decision, confidence: v.confidence, rubric: v.rubric, failedGates: v.gates.filter((g) => g.failed).map((g) => g.dimension), evaluators: v.evaluators.length },
        });
        log(`  ${r.task}: ${v.score}/100 ${v.route} (${v.confidence})`);
      }),
    );
    app.reppo.sort((a, b) => a.task.localeCompare(b.task));
    cp.save();
  }
  const verdicts = verdictsOf(app);

  if (!app.score) {
    app.score = spendgradeScore(verdicts, app.audit);
    push(codeStep('Spendgrade score (deterministic)', { output: app.score }));
  }

  if (!app.decision) {
    const prev = index > 0 ? apps[index - 1] : null;
    const previous = prev?.decision
      ? { playbook: prev.playbookVersion, spendgrade_score: prev.score.score, tier: prev.decision.tier, reppo_scores: prev.reppo.map((r) => r.ev.result.score) }
      : null;
    let ceiling = tierCeiling({ score: app.score.score, verdicts });
    push(codeStep('Tier ceiling from hard rules (deterministic)', { output: ceiling }));
    const packet = buildPacket({ agent: { name: agent, role: 'procurement agent', playbook: playbook.version, runtime: app.runtime === 'external' ? 'external agent (no SERV)' : 'SERV Reasoning' }, request, pack, verdicts, audit: app.audit, score: app.score, ceiling, previous });
    app.packet = packet;
    try {
      const uw = await underwrite(packet, { onStep: push });
      app.proposed = uw.proposed;
      app.decision = uw.decision;
      app.overrides = uw.overrides;
    } catch (e) {
      if (!(e instanceof ServError && e.step)) throw e;
      push(e.step);
      if (!/guard|injection|refus/i.test(`${e.step.error} ${e.step.rawContent || ''} ${JSON.stringify(e.step.rawError || '')}`)) throw e;
      ceiling = { tier: 'frozen', rule: 'SERV prompt guard blocked the evidence packet' };
      app.decision = frozenDecision(packet, ceiling);
      app.overrides = ['SERV prompt guard tripped: decision frozen by code'];
    }
    push(codeStep('Policy enforcement: code clamps tier, limits and citations', { output: { overrides: app.overrides, final: app.decision } }));
    log(`[${playbook.version}] decision: ${app.decision.tier} $${app.decision.daily_limit_usd}/day, $${app.decision.per_tx_limit_usd}/tx`);
  }

  if (!app.receipt) {
    app.kiteSession = kiteSessionDraft(agent, app.decision);
    const record = {
      agent,
      playbook: playbook.version,
      reppo_eval_ids: app.reppo.map((r) => r.ev.id),
      reppo_scores: app.reppo.map((r) => r.ev.result.score),
      spendgrade_score: app.score.score,
      tier: app.decision.tier,
      daily_limit_usd: app.decision.daily_limit_usd,
      per_tx_limit_usd: app.decision.per_tx_limit_usd,
      allowed_categories: app.decision.allowed_categories,
      serv_completion_id: app.steps.filter((s) => s.kind === 'serv').at(-1)?.completionId || null,
      underwriter_prompt: VERSIONS.underwriterPrompt,
      decision_schema: VERSIONS.decisionSchema,
      issued_at: new Date().toISOString(),
    };
    app.record = record;
    app.receipt = receipt(record);
    app.stage = 'done';
    push(codeStep('Issue decision receipt', { output: app.receipt }));
  }
  return app;
}

function frozenDecision(packet, ceiling) {
  return {
    tier: 'frozen',
    daily_limit_usd: 0,
    per_tx_limit_usd: 0,
    allowed_categories: [],
    blocked_categories: ['software_subscriptions', 'invoice_payments', 'one_off_purchases'],
    conditions: ['A person must review this agent before any spending is allowed.'],
    reasons: [{ statement: ceiling.rule, evidence: packet.reppo_verdicts.map((v) => v.id) }],
    rules_applied: ['R2'],
    human_review_required: true,
    next_review_after_tasks: 0,
    summary: 'Spending is frozen until a person reviews this agent.',
  };
}

export async function runCoaching(cp, index, { pack }) {
  const app = cp.state.applications[index];
  const existing = cp.state.coaching[index];
  if (existing?.playbook) return existing;
  const work = app.work.map((w) => ({ task: pack.tasks.find((t) => t.id === w.taskId), decision: w.decision }));
  log(`[${app.playbookVersion}] SERV coach writes the next playbook from Reppo's findings`);
  const steps = [];
  const out = await coach({ playbook: app.playbook, packet: app.packet, verdicts: verdictsOf(app), work, onStep: (s) => steps.push(s) });
  cp.state.coaching[index] = { from: app.playbookVersion, to: out.playbook.version, patch: out.patch, playbook: out.playbook, steps };
  cp.save();
  savePlaybook(out.playbook, cp.state.id);
  log(`[${app.playbookVersion}] -> ${out.playbook.version}: ${out.patch.patches.length} new rules`);
  return cp.state.coaching[index];
}

export const DEFAULT_REQUEST = {
  daily_limit_usd: TIERS.standard.dailyUsd,
  per_tx_limit_usd: TIERS.standard.perTxUsd,
  categories: ['software_subscriptions', 'invoice_payments'],
  purpose: 'Renew team software and pay approved supplier invoices without asking each time',
};
