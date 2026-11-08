// Landing page: fills the hero card, proof section and unit economics from the
// recorded runs, so every number on the page traces back to data/runs/.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (n, d = 0) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const TIER = { frozen: 'Frozen', deny: 'Denied', probation: 'Probation', standard: 'Standard', trusted: 'Trusted' };
const ROUTE = { ship: 'ok', review: 'warn', block: 'bad' };
const MODEL_NAMES = /\b(claude|gpt|gemini|deepseek|kimi|glm|llama|qwen|grok|mistral|sonnet|opus|haiku)[\w.\-]*/gi;
const redact = (t) => String(t ?? '').replace(/\(\s*(claude|gpt|gemini|deepseek|kimi|glm|llama|qwen|grok|mistral)[\w.\-]*\s*\)/gi, '').replace(MODEL_NAMES, 'an evaluator').replace(/ {2,}/g, ' ');

addEventListener('scroll', () => $('.lp-top').classList.toggle('scrolled', scrollY > 8), { passive: true });

const mean = (a) => Math.round(a.reppo.reduce((s, r) => s + r.ev.result.score, 0) / a.reppo.length);
const passed = (a) => a.audit.filter((c) => c.pass).length;
const title = (run, id) => run.packSnapshot?.tasks?.find((t) => t.id === id)?.title || id;
const runtimeLabel = (a) => (a.runtime === 'external' ? 'Bring-your-own agent, no SERV' : 'Built on SERV Reasoning');

function heroCard(loop, compare) {
  const k0 = loop.applications[0];
  const k = loop.applications.at(-1);
  const q = compare?.applications?.[0];
  const col = (app, sub) => `
    <div class="hc-app">
      <span class="hc-label">${esc(app.agent)}</span>
      <span class="hc-sub">${sub}</span>
      <div class="hc-score"><b>${app.score.score}</b><span>Spendgrade score</span></div>
      <span class="tier ${esc(app.decision.tier)}">${esc(TIER[app.decision.tier])}</span>
      <div class="hc-row"><span>Daily limit</span><b>${usd(app.decision.daily_limit_usd)}</b></div>
      <div class="hc-row"><span>Ground-truth checks</span><b>${passed(app)} of ${app.audit.length}</b></div>
      <div class="hc-row"><span>Categories allowed</span><b>${app.decision.allowed_categories.length} of 3</b></div>
      <div class="hc-routes">${app.reppo.map((r) => `<span class="chip ${ROUTE[r.ev.result.route] || ''}">${esc(r.task)} ${esc(r.ev.result.route)}</span>`).join('')}</div>
    </div>`;
  $('#hero-card').innerHTML = `
    <div class="hc-top"><b>Same six tasks, same starting playbook</b><span>Recorded ${esc(new Date(loop.createdAt).toUTCString().slice(5, 16))}</span></div>
    <div class="hc-apps">${col(k, 'Bring-your-own agent, no SERV, after one coaching cycle')}${q ? col(q, 'Built on SERV Reasoning') : ''}</div>
    <div class="hc-foot"><b>${esc(k.agent)} improved:</b> score ${k0.score.score} to ${k.score.score}, checks ${passed(k0)} to ${passed(k)} of ${k.audit.length}. Its euro-pricing error persists, so software stays blocked. The two agents run on different models.</div>`;
}

function card(run, app, label, href) {
  return `
    <div class="card">
      <div class="p-h"><div class="p-t"><b>${esc(label)}</b><span>${esc(runtimeLabel(app))} · playbook ${esc(app.playbookVersion)}</span></div><span class="tier ${esc(app.decision.tier)}">${esc(TIER[app.decision.tier])}</span></div>
      <div class="p-metrics">
        <div class="pm"><b>${app.score.score}</b><span>Spendgrade score</span></div>
        <div class="pm"><b>${usd(app.decision.daily_limit_usd)}</b><span>a day</span></div>
        <div class="pm"><b>${passed(app)}/${app.audit.length}</b><span>ground-truth checks</span></div>
      </div>
      <div class="p-tasks">${app.reppo.map((r) => `<div class="pt"><span>${esc(r.task)} · ${esc(title(run, r.task))}</span><span class="s">${r.ev.result.score}</span><span class="chip ${ROUTE[r.ev.result.route] || ''}">${esc(r.ev.result.route)}</span></div>`).join('')}</div>
      <p class="p-sum">${esc(redact(app.decision.summary))}</p>
      <a class="p-link" href="${href}">Open this report</a>
    </div>`;
}

function proof(loop, compare) {
  const cards = loop.applications.map((app, i) => card(loop, app, `${app.agent} · application ${i + 1}`, `app.html?run=${encodeURIComponent(loop.id)}&app=${i}`));
  if (compare) cards.push(card(compare, compare.applications[0], `${compare.applications[0].agent} · same pack`, `app.html?run=${encodeURIComponent(compare.id)}`));
  $('#proof-body').style.gridTemplateColumns = `repeat(${cards.length}, 1fr)`;
  $('#proof-body').innerHTML = cards.join('');
}

async function econ(run) {
  let costs = null;
  try { costs = await fetch('data/costs.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)); } catch {}
  const app = run.applications.at(-1);
  const reppoCredits = app.reppo.reduce((s, r) => s + (r.ev.creditsCharged || 0), 0);
  const reppoUsd = reppoCredits * (costs?.reppoUsdPerCredit ?? 0.0005);
  const servUsd = costs?.servUsdPerApplication ?? null;
  const total = reppoUsd + (servUsd || 0);
  $('#econ-rows').innerHTML = `
    <div><span>Reppo verdicts (${app.reppo.length} x ${app.reppo[0]?.ev.creditsCharged || 0} credits)</span><b>${usd(reppoUsd, 2)}</b></div>
    <div><span>SERV Reasoning calls</span><b>${servUsd === null ? 'measuring' : usd(servUsd, 2)}</b></div>
    <div class="tot"><span>Cost per check</span><b>${usd(total, 2)}</b></div>
    <div class="tot"><span>Gross margin at $2.50</span><b>${Math.round((1 - total / 2.5) * 100)}%</b></div>
    <small>${esc(costs?.source || 'Reppo credits from the recorded run at the console price of $11 per 22,000 credits.')}</small>`;
}

function apiExample(run) {
  const app = run.applications.at(-1);
  const pre = document.querySelectorAll('.api-grid pre.code')[1];
  if (!pre) return;
  const d = app.decision;
  const sample = {
    status: 'decided',
    spendgrade_score: app.score.score,
    decision: {
      tier: d.tier,
      daily_limit_usd: d.daily_limit_usd,
      per_tx_limit_usd: d.per_tx_limit_usd,
      allowed_categories: d.allowed_categories,
      conditions: d.conditions.slice(0, 1).map(redact).concat(d.conditions.length > 1 ? ['...'] : []),
      reasons: d.reasons.slice(0, 1).map((r) => ({ statement: r.statement.length > 64 ? `${redact(r.statement).slice(0, 61)}...` : redact(r.statement), evidence: r.evidence.slice(0, 2) })),
      human_review_required: d.human_review_required,
    },
    kite_session_draft: app.kiteSession ? { command: 'kpass agent:session create ...' } : null,
    receipt: { algorithm: 'sha256', digest: `${app.receipt.digest.slice(0, 24)}...` },
  };
  pre.innerHTML = `<span class="s">${esc(JSON.stringify(sample, null, 2))}</span>`;
}

(async () => {
  try {
    const idx = await fetch('data/runs/index.json', { cache: 'no-store' }).then((r) => r.json());
    const loopEntry = idx.runs.find((r) => r.kind === 'loop');
    if (!loopEntry) return;
    const loop = await fetch(loopEntry.file, { cache: 'no-store' }).then((r) => r.json());
    const cmpEntry = idx.runs.find((r) => r.kind === 'single' && r.pack === loopEntry.pack && r.runtime !== loopEntry.runtime);
    const compare = cmpEntry ? await fetch(cmpEntry.file, { cache: 'no-store' }).then((r) => r.json()) : null;
    heroCard(loop, compare);
    proof(loop, compare);
    econ(loop);
    apiExample(loop);
  } catch (e) {
    console.warn('No recorded run available', e);
  }
})();
