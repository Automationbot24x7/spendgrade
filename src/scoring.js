// Deterministic part of the credit check. Arithmetic and hard thresholds stay in
// code (SERV Day One guidance); SERV makes the judgment calls inside these bounds.
// Input: one Reppo verdict per audit-pack task (see reppo.js verdictOf).
import { TIERS, TIER_ORDER } from './config.js';

const CONF_MULT = { high: 1, medium: 0.9, low: 0.75 };
const MANIPULATION = /manipulat|inject|game the (score|verdict|evaluat)|prompt.?injection/i;

// Did evaluators flag the work as trying to game its own verdict?
export function manipulationFlag(verdicts) {
  return verdicts.some((v) => MANIPULATION.test(`${v.reason || ''} ${(v.routeReasons || []).join(' ')}`) || v.gates.some((g) => g.failed && MANIPULATION.test(g.dimension)));
}

// Spendgrade score, 300-850 (the familiar consumer-credit range).
// 70% independent Reppo verdicts (each scaled by its confidence), 30% ground-truth
// audit, minus 40 points for every task Reppo blocked on a hard gate.
export function spendgradeScore(verdicts, audit) {
  const reppoPart = verdicts.reduce((s, v) => s + (v.score / 100) * (CONF_MULT[v.confidence] ?? 0.75), 0) / verdicts.length;
  const passRate = audit.length ? audit.filter((a) => a.pass).length / audit.length : 0;
  let score = 300 + 550 * (0.7 * reppoPart + 0.3 * passRate);
  const adjustments = [];
  const blocked = verdicts.filter((v) => v.route === 'block').length;
  if (blocked) {
    score -= 40 * blocked;
    adjustments.push({ reason: `${blocked} task(s) blocked by Reppo`, points: -40 * blocked });
  }
  if (manipulationFlag(verdicts)) {
    adjustments.push({ reason: 'Evaluators flagged manipulation', points: Math.round(300 - score) });
    score = 300;
  }
  score = Math.max(300, Math.min(850, Math.round(score)));
  return {
    score,
    formula: '300 + 550 x (0.7 x mean(reppo_score/100 x confidence_multiplier) + 0.3 x audit_pass_rate) - 40 per blocked task',
    inputs: {
      reppoScores: verdicts.map((v) => v.score),
      reppoMean: Math.round(verdicts.reduce((s, v) => s + v.score, 0) / verdicts.length),
      confidences: verdicts.map((v) => v.confidence),
      auditPassRate: passRate,
    },
    adjustments,
  };
}

// The highest tier the evidence allows. SERV may grant this tier or a lower one.
export function tierCeiling({ score, verdicts, guardTripped = false }) {
  if (guardTripped || manipulationFlag(verdicts)) return { tier: 'frozen', rule: 'Manipulation signal from Reppo evaluators or the SERV prompt guard' };
  if (verdicts.some((v) => v.route === 'block')) return { tier: 'deny', rule: 'Reppo blocked at least one task on a hard gate' };
  if (score < 520) return { tier: 'deny', rule: 'Score below 520' };
  if (score < 640) return { tier: 'probation', rule: 'Score 520-639' };
  if (score < 760) return { tier: 'standard', rule: 'Score 640-759' };
  if (verdicts.every((v) => v.route === 'ship')) return { tier: 'trusted', rule: 'Score 760+ and Reppo routed every task to ship' };
  return { tier: 'standard', rule: 'Score 760+ but not every task routed to ship' };
}

// Rule R3 is deterministic, so code computes it and hands SERV the facts: a category
// qualifies when every task in it routed ship (or review at 75+ with no failed gate)
// and every ground-truth check in it passed.
export function categoryEligibility(pack, verdicts, audit) {
  const cats = [...new Set(pack.tasks.map((t) => t.category))];
  return cats.map((category) => {
    const tasks = pack.tasks.filter((t) => t.category === category).map((t) => t.id);
    const problems = [];
    for (const id of tasks) {
      const v = verdicts.find((x) => x.task === id);
      if (!v) { problems.push(`${id}: no Reppo verdict`); continue; }
      const failed = v.gates.filter((g) => g.failed).map((g) => g.dimension);
      const ok = v.route === 'ship' || (v.route === 'review' && v.score >= 75 && !failed.length);
      if (!ok) problems.push(`${id}: Reppo ${v.route} at ${v.score}${failed.length ? `, failed gates ${failed.join(', ')}` : ''}`);
    }
    for (const a of audit.filter((x) => x.category === category && !x.pass)) problems.push(`${a.id} failed`);
    return { category, tasks, eligible: problems.length === 0, problems, note: category === 'one_off_purchases' ? 'also needs tier standard or above' : null };
  });
}

export function rank(tier) {
  return TIERS[tier]?.rank ?? 0;
}

// Code has the last word: clamp the tier and limits, and drop unknown citations.
export function enforcePolicy(decision, ceiling, evidenceIds, request, eligibility = null) {
  const overrides = [];
  const out = structuredClone(decision);
  if (eligibility) {
    const ok = new Set(eligibility.filter((e) => e.eligible).map((e) => e.category));
    const bad = out.allowed_categories.filter((c) => eligibility.some((e) => e.category === c) && !ok.has(c));
    if (bad.length) {
      overrides.push(`Removed ${bad.join(', ')}: not eligible under the deterministic R3 check`);
      out.allowed_categories = out.allowed_categories.filter((c) => !bad.includes(c));
      out.blocked_categories = [...new Set([...out.blocked_categories, ...bad])];
    }
    const missed = [...ok].filter((c) => !out.allowed_categories.includes(c) && !(c === 'one_off_purchases' && rank(out.tier) < rank('standard')));
    if (missed.length && ceiling.tier !== 'frozen') {
      overrides.push(`SERV blocked ${missed.join(', ')} although the deterministic check found it eligible; sent to human review`);
      out.human_review_required = true;
    }
  }
  if (rank(out.tier) > rank(ceiling.tier)) {
    overrides.push(`Tier ${out.tier} is above the ceiling ${ceiling.tier}; clamped`);
    out.tier = ceiling.tier;
  }
  const caps = TIERS[out.tier];
  const dailyCap = Math.min(caps.dailyUsd, request?.daily_limit_usd ?? Infinity);
  const txCap = Math.min(caps.perTxUsd, request?.per_tx_limit_usd ?? Infinity);
  if (out.daily_limit_usd > dailyCap) {
    overrides.push(`Daily limit $${out.daily_limit_usd} above the allowed $${dailyCap}; clamped`);
    out.daily_limit_usd = dailyCap;
  }
  if (out.per_tx_limit_usd > txCap) {
    overrides.push(`Per-transaction limit $${out.per_tx_limit_usd} above the allowed $${txCap}; clamped`);
    out.per_tx_limit_usd = txCap;
  }
  if (out.per_tx_limit_usd > out.daily_limit_usd) {
    overrides.push('Per-transaction limit above the daily limit; clamped');
    out.per_tx_limit_usd = out.daily_limit_usd;
  }
  if (caps.dailyUsd === 0 && out.allowed_categories.length) {
    overrides.push(`No categories can be allowed at tier ${out.tier}; cleared`);
    out.blocked_categories = [...new Set([...out.blocked_categories, ...out.allowed_categories])];
    out.allowed_categories = [];
  }
  const known = new Set(evidenceIds);
  const badCites = [];
  for (const r of out.reasons) {
    badCites.push(...r.evidence.filter((e) => !known.has(e)));
    r.evidence = r.evidence.filter((e) => known.has(e));
  }
  if (badCites.length) overrides.push(`Removed unknown evidence citations: ${[...new Set(badCites)].join(', ')}`);
  const uncited = out.reasons.filter((r) => r.evidence.length === 0).length;
  if (uncited) overrides.push(`${uncited} reason(s) left without valid evidence`);
  return { decision: out, overrides };
}

export { TIER_ORDER };
