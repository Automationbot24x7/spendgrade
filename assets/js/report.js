// Spendgrade report viewer. Renders a recorded run (data/runs/*.json) verbatim.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (n) => (n === null || n === undefined ? '-' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
const TIER_LABEL = { frozen: 'Frozen', deny: 'Denied', probation: 'Probation', standard: 'Standard', trusted: 'Trusted' };
const TIER_COLOR = { frozen: '#475467', deny: '#b42318', probation: '#b54708', standard: '#067647', trusted: '#175cd3' };
const CAT_LABEL = { software_subscriptions: 'Software subscriptions', invoice_payments: 'Invoice payments', one_off_purchases: 'One-off purchases' };
const TASK_TITLE = { T1: 'Renew design tool seats', T2: "Pay the translator's invoice", T3: 'Buy API uptime monitoring' };
const taskTitle = (id) => run?.packSnapshot?.tasks?.find((t) => t.id === id)?.title || TASK_TITLE[id] || id;
const ROUTE_CLASS = { ship: 'ok', review: 'warn', block: 'bad' };
const ICON = {
  ok: '<svg viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  no: '<svg viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3L3 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14m-5-5l5 5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// Reppo's notes sometimes name the evaluator models; the viewer shows them as evaluators.
const MODEL_NAMES = /\b(claude|gpt|gemini|deepseek|kimi|glm|llama|qwen|grok|mistral|sonnet|opus|haiku)[\w.\-]*(\s*\([^)]*\))?/gi;
const redact = (t) => String(t ?? '').replace(/\(\s*(claude|gpt|gemini|deepseek|kimi|glm|llama|qwen|grok|mistral)[\w.\-]*\s*\)/gi, '').replace(MODEL_NAMES, 'an evaluator').replace(/ {2,}/g, ' ');
const evDomId = (id) => `ev-${String(id).replace(/[^\w-]/g, '_')}`;
const params = new URLSearchParams(location.search);
let run = null;
let current = 0;

const verdicts = (a) => (a.reppo || []).map((r) => ({ task: r.task, id: r.ev.id, input: r.input, ...r.ev.result }));
const reppoMean = (a) => {
  const v = verdicts(a);
  return v.length ? Math.round(v.reduce((s, x) => s + x.score, 0) / v.length) : null;
};
const passed = (a) => a.audit.filter((c) => c.pass).length;

async function boot() {
  try {
    let file = params.get('file');
    let runs = [];
    if (!file) {
      const idx = await fetch('data/runs/index.json', { cache: 'no-store' }).then((r) => r.json());
      runs = idx.runs.filter((r) => r.kind === 'loop');
      if (!runs.length) runs = idx.runs;
      const want = params.get('run');
      file = (runs.find((r) => r.id === want) || runs[0])?.file;
    }
    if (!file) throw new Error('No recorded runs yet');
    run = await fetch(file, { cache: 'no-store' }).then((r) => r.json());
    renderRunMeta(runs);
    current = Math.min(Number(params.get('app') ?? run.applications.length - 1), run.applications.length - 1);
    render();
  } catch (e) {
    $('#report').innerHTML = `<div class="empty">Could not load a recorded run: ${esc(e.message)}</div>`;
  }
}

function renderRunMeta(runs) {
  const d = new Date(run.createdAt);
  const when = d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
  const sel = runs.length > 1
    ? `<select id="run-pick" aria-label="Recorded run">${runs.map((r) => `<option value="${esc(r.id)}" ${r.id === run.id ? 'selected' : ''}>${esc(r.id)}</option>`).join('')}</select>`
    : `<span class="chip id">${esc(run.id)}</span>`;
  $('#run-meta').innerHTML = `<span>Recorded live run</span>${sel}<span>${esc(when)}</span>`;
  $('#run-pick')?.addEventListener('change', (e) => { location.search = `?run=${encodeURIComponent(e.target.value)}`; });
}

function render() {
  const a = run.applications[current];
  renderApplicant(a);
  renderTimeline(run.applications);
  renderMain(a);
  renderWork(a);
  renderTrail(a);
  renderLearned();
  renderExport(a);
}

function renderApplicant(a) {
  const r = a.request || {};
  $('#applicant').innerHTML = `
    <div class="who">
      <span class="eyebrow">Applicant</span>
      <h1>${esc(a.agent)} <span class="role">procurement agent</span></h1>
      <div class="meta-row"><span class="chip ${a.runtime === 'external' ? '' : 'serv'}">${a.runtime === 'external' ? 'Bring-your-own agent: direct model call, no SERV' : 'Runs on SERV Reasoning'}</span></div>
      <p class="sub">Larkspur Studio (sample company) · graded on audit pack <code>${esc(run.pack || 'procurement-pack-1')}</code></p>
    </div>
    <div class="req">
      <span class="req-l">Requested</span><b>${usd(r.daily_limit_usd)} a day</b><span class="dot-sep"></span><b>${usd(r.per_tx_limit_usd)} per transaction</b>
      ${(r.categories || []).map((c) => `<span class="chip">${esc(CAT_LABEL[c] || c)}</span>`).join('')}
    </div>`;
}

function renderTimeline(apps) {
  const tab = (a, i) => `
    <button class="app-tab" role="tab" aria-selected="${i === current}" data-i="${i}">
      <span class="n">${i + 1}</span>
      <span class="t"><b>Application ${i + 1} · playbook ${esc(a.playbookVersion)}</b><span>${i === 0 ? (a.playbook?.origin?.includes('Autonomy') ? 'Starting playbook: autonomy-first' : 'Starting playbook') : "After learning from Reppo's findings"}</span></span>
      <span class="m">
        <span class="metric"><b>${reppoMean(a) ?? '-'}</b><span>Reppo avg</span></span>
        <span class="metric"><b>${a.score?.score ?? '-'}</b><span>Score</span></span>
        <span class="metric"><b>${usd(a.decision?.daily_limit_usd)}</b><span>a day</span></span>
        <span class="tier ${esc(a.decision?.tier)}">${esc(TIER_LABEL[a.decision?.tier] || '-')}</span>
      </span>
    </button>`;
  const parts = [];
  apps.forEach((a, i) => {
    if (i) parts.push(`<div class="tl-arrow">${ICON.arrow}</div>`);
    parts.push(tab(a, i));
  });
  const el = $('#timeline');
  el.style.gridTemplateColumns = apps.length > 1 ? apps.map(() => '1fr').join(' 56px ') : '1fr';
  el.innerHTML = parts.join('');
  el.querySelectorAll('.app-tab').forEach((b) => b.addEventListener('click', () => { current = Number(b.dataset.i); render(); }));
}

function gauge(score, tier) {
  const cx = 150, cy = 150, r = 118, sweep = 240, start = 150;
  const pt = (deg, rr = r) => [cx + rr * Math.cos((deg * Math.PI) / 180), cy + rr * Math.sin((deg * Math.PI) / 180)];
  const arc = (from, to) => {
    const [x1, y1] = pt(from), [x2, y2] = pt(to);
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };
  const f = Math.max(0, Math.min(1, (score - 300) / 550));
  const end = start + sweep * f;
  const [nx, ny] = pt(end);
  const col = TIER_COLOR[tier] || '#101828';
  const ticks = [520, 640, 760].map((val) => {
    const d = start + (sweep * (val - 300)) / 550;
    const [x1, y1] = pt(d, r - 15), [x2, y2] = pt(d, r + 15);
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#fff" stroke-width="3"/>`;
  }).join('');
  return `<div class="gauge"><svg viewBox="0 0 300 250" aria-hidden="true">
      <path d="${arc(start, start + sweep)}" stroke="#ebe9e2" stroke-width="22" fill="none" stroke-linecap="round"/>
      ${f > 0.002 ? `<path d="${arc(start, end)}" stroke="${col}" stroke-width="22" fill="none" stroke-linecap="round"/>` : ''}
      ${ticks}
      <circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="9" fill="#fff" stroke="${col}" stroke-width="4"/>
    </svg>
    <div class="val"><b>${score}</b><span>Spendgrade score</span></div>
    <div class="ends"><span>300</span><span>850</span></div></div>`;
}

function evidenceLabel(id) {
  if (id.startsWith('audit:')) return id.slice(6);
  if (id === 'score:spendgrade') return 'Score';
  const task = taskOfEval(id.replace(/^reppo:/, '').split('#')[0]);
  const m = id.match(/#(\w+)$/);
  if (m) return `${task} ${m[1]}`;
  if (id.startsWith('reppo:')) return `${task} verdict`;
  return id;
}
function taskOfEval(evalId) {
  for (const a of run.applications) for (const r of a.reppo || []) if (r.ev.id === evalId) return r.task;
  return 'Reppo';
}

function rubricBars(v) {
  return Object.entries(v.rubric_scores || {}).map(([dim, val]) => {
    const col = val >= 70 ? 'var(--standard)' : val >= 50 ? 'var(--probation)' : 'var(--deny)';
    return `<div class="rb" id="${evDomId(`reppo:${v.id}#${dim}`)}"><span class="rb-n">${esc(dim)}</span><span class="bar"><i style="width:${Math.max(2, val)}%;background:${col}"></i></span><span class="rb-v">${val}</span></div>`;
  }).join('');
}

function renderMain(a) {
  const d = a.decision;
  const cats = Object.keys(CAT_LABEL).map((c) => {
    const on = d.allowed_categories.includes(c);
    return `<div class="cat ${on ? 'on' : 'off'}"><span class="lbl"><span class="ico">${on ? ICON.ok : ICON.no}</span>${esc(CAT_LABEL[c])}</span><span class="st">${on ? 'Allowed' : 'Blocked'}</span></div>`;
  }).join('');
  const decision = `
    <article class="card decision">
      <div class="card-h"><h3>Credit decision</h3><span class="chip serv">SERV underwriter</span></div>
      <div class="card-b">
        ${gauge(a.score.score, d.tier)}
        <div class="tierline"><span class="tier ${esc(d.tier)}">${esc(TIER_LABEL[d.tier])}</span></div>
        <div class="limits">
          <div class="limit"><b>${usd(d.daily_limit_usd)}</b><span>a day</span></div>
          <div class="limit"><b>${usd(d.per_tx_limit_usd)}</b><span>per transaction</span></div>
        </div>
        <div class="cats">${cats}</div>
        <p class="summary">${esc(redact(d.summary))}</p>
        ${d.conditions.length ? `<div><div class="sec-label">Conditions</div><ul class="conds">${d.conditions.map((c) => `<li>${esc(redact(c))}</li>`).join('')}</ul></div>` : ''}
        <div class="meta-row">
          <span class="chip ${d.human_review_required ? 'warn' : 'ok'}">${d.human_review_required ? 'Human review required' : 'No human review needed'}</span>
          <span class="chip">${d.next_review_after_tasks ? `Re-grade after ${d.next_review_after_tasks} tasks` : 'Re-apply after coaching'}</span>
        </div>
      </div>
    </article>`;

  const vs = verdicts(a).map((v) => {
    const failed = (v.gates || []).filter((g) => g.severity && g.severity !== 'none' && (g.failingWeight > 0 || g.failingEvaluators?.length)).map((g) => g.dimension);
    const n = v.consensus?.evaluators?.length || 0;
    return `<div class="tv" id="${evDomId(`reppo:${v.id}`)}">
      <div class="tv-h">
        <div class="tv-t"><b>${esc(v.task)} · ${esc(taskTitle(v.task))}</b><span class="chip id">${esc(v.id)}</span></div>
        <div class="tv-s"><span class="score">${v.score}</span><span class="chip ${ROUTE_CLASS[v.route] || ''}">${esc(v.route)}</span></div>
      </div>
      <p class="tv-r">${esc(redact(v.reason))}</p>
      <div class="rbs">${rubricBars(v)}</div>
      <div class="tv-f">
        <span>${n} independent evaluators, stake-weighted</span><span>confidence ${esc(v.confidence)}</span>
        ${failed.length ? `<span class="chip bad">hard gate failed: ${esc(failed.join(', '))}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  const verdictCard = `
    <article class="card">
      <div class="card-h"><h3>Independent verdicts</h3><span class="chip reppo">Reppo Evaluation API</span></div>
      <div class="card-b tvs">${vs}</div>
    </article>`;

  const checks = a.audit.map((c) => `
    <div class="check ${c.pass ? 'pass' : 'fail'}" id="${evDomId(`audit:${c.id}`)}">
      <span class="ico">${c.pass ? ICON.ok : ICON.no}</span>
      <span class="gid">${esc(c.id)}</span>
      <span>${esc(c.check)}<br><span class="obs">${esc(c.task)} · observed: ${esc(JSON.stringify(c.observed))}</span></span>
    </div>`).join('');
  const reasons = d.reasons.map((r) => `
    <div class="reason"><p>${esc(redact(r.statement))}</p>
      <div class="ev">${r.evidence.map((e) => `<button class="chip id" data-ev="${esc(e)}" title="${esc(e)}">${esc(evidenceLabel(e))}</button>`).join('')}</div>
    </div>`).join('');
  const ov = a.overrides?.length
    ? a.overrides.map((o) => `<div class="override">${esc(o)}</div>`).join('')
    : `<div class="override none">No overrides. SERV's decision was inside every hard limit.</div>`;
  const ceiling = a.steps.find((s) => s.title?.startsWith('Tier ceiling'))?.output;
  const why = `
    <div class="col">
      <article class="card">
        <div class="card-h"><h3>Reasons on the record</h3><span class="chip serv">cited evidence</span></div>
        <div class="card-b"><div class="reasons">${reasons}</div><div class="rules-line"><span>Rules applied</span>${d.rules_applied.map((r) => `<span class="chip">${esc(r)}</span>`).join('')}</div></div>
      </article>
      <article class="card">
        <div class="card-h"><h3>Hard limits in code</h3><span class="chip code">Policy enforcement</span></div>
        <div class="card-b"><div class="overrides">
          ${ceiling ? `<div class="ceil">Highest tier the evidence allows: <span class="tier ${esc(ceiling.tier)}">${esc(TIER_LABEL[ceiling.tier])}</span><span class="ceil-r">${esc(ceiling.rule)}</span></div>` : ''}
          ${ov}</div></div>
      </article>
      <article class="card">
        <div class="card-h"><h3>Ground-truth audit</h3><span class="chip ${passed(a) === a.audit.length ? 'ok' : 'warn'}">${passed(a)} of ${a.audit.length} passed</span></div>
        <div class="card-b"><div class="checks">${checks}</div></div>
      </article>
    </div>`;
  $('#main').innerHTML = decision + verdictCard + why;
  $('#main').querySelectorAll('[data-ev]').forEach((b) => b.addEventListener('click', () => {
    const el = document.getElementById(evDomId(b.dataset.ev));
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.remove('hl'); void el.offsetWidth; el.classList.add('hl'); }
  }));
}

function renderWork(a) {
  const cards = a.work.map((w) => {
    const d = w.decision;
    const gts = a.audit.filter((c) => c.task === w.taskId).map((c) => `<span class="chip ${c.pass ? 'ok' : 'bad'}">${esc(c.id)}</span>`).join('');
    return `<article class="card task">
      <div class="card-h"><div><b>${esc(w.taskId)} · ${esc(taskTitle(w.taskId))}</b><span>${esc(a.agent)}'s action</span></div><span class="chip ${d.action === 'hold' || d.action === 'escalate' ? 'warn' : ''}">${esc(d.action)}</span></div>
      <div class="card-b">
        <dl class="act">
          <div><dt>Vendor or payee</dt><dd>${esc(d.vendor ?? 'none')}</dd></div>
          <div><dt>Amount now</dt><dd>${usd(d.amount_usd)}</dd></div>
          <div><dt>Asks a human</dt><dd>${d.needs_human_approval ? 'Yes' : 'No'}</dd></div>
          <div><dt>Policy cited</dt><dd>${d.policy_refs?.length ? esc(d.policy_refs.join(', ')) : 'none'}</dd></div>
        </dl>
        <p class="why">${esc(d.rationale)}</p>
        <div class="gts">${gts}</div>
      </div>
    </article>`;
  }).join('');
  $('#work').innerHTML = `
    <div class="block-h"><div><h2>The work Reppo judged</h2><p>${esc(a.agent)}'s actions on the ${a.work.length} audit-pack tasks, exactly as sent to Reppo's evaluators with the policy and source documents. Chips are the ground-truth checks for each task.</p></div></div>
    <div class="tasks">${cards}</div>`;
}

function stepFeatures(s) {
  const f = [];
  if (s.kind === 'serv') {
    const sf = s.servFeatures || {};
    if (sf.multipath) f.push('<span class="chip serv">Multipath</span>');
    if (sf.kronos) f.push('<span class="chip serv">Kronos audit</span>');
    if (sf.promptGuard) f.push('<span class="chip serv">Prompt guard</span>');
    if (sf.shadowAgent) f.push('<span class="chip serv">Shadow agent</span>');
    if (sf.structuredOutput) f.push(`<span class="chip serv">Schema ${esc(s.schemaVersion)}</span>`);
    if (sf.reasoningEffort) f.push(`<span class="chip">effort ${esc(sf.reasoningEffort)}</span>`);
    if (s.validation) f.push(`<span class="chip ${s.validation.ok ? 'ok' : 'bad'}">${s.validation.ok ? 'Validated' : 'Invalid'}</span>`);
  } else if (s.kind === 'external') {
    f.push('<span class="chip">no SERV</span>');
    if (s.validation) f.push(`<span class="chip ${s.validation.ok ? 'ok' : 'bad'}">${s.validation.ok ? 'Schema valid' : 'Schema invalid'}</span>`);
  } else if (s.kind === 'reppo' && s.verdict) {
    f.push(`<span class="chip id">${esc(s.evalId)}</span>`);
    f.push(`<span class="chip ${ROUTE_CLASS[s.verdict.route] || ''}">${esc(s.verdict.score)} · ${esc(s.verdict.route)}</span>`);
    f.push(`<span class="chip">${esc(s.verdict.evaluators)} evaluators</span>`);
  }
  return f.join('');
}

function stepBody(s) {
  if (s.kind === 'serv') {
    const usage = s.usage ? `${s.usage.prompt_tokens} in, ${s.usage.completion_tokens} out` : '-';
    return `<dl class="kv">
        <dt>Endpoint</dt><dd>${esc(s.endpoint)} · HTTP ${esc(s.httpStatus)}</dd>
        <dt>Completion</dt><dd class="mono">${esc(s.completionId || '-')}</dd>
        <dt>Prompt</dt><dd>${esc(s.promptVersion)} · sha256 ${esc((s.systemPromptSha256 || '').slice(0, 16))}…</dd>
        <dt>Tokens</dt><dd>${esc(usage)} · finish ${esc(s.finishReason)}</dd>
        ${s.servFeatures?.shadowAgent ? `<dt>Shadow hint</dt><dd class="light">${esc(s.servFeatures.shadowAgent.hint)}</dd>` : ''}
      </dl>
      <div class="sec-label">Typed output</div>
      <pre class="code">${esc(JSON.stringify(s.output, null, 2))}</pre>`;
  }
  if (s.kind === 'reppo') {
    return `<div class="sec-label">What the evaluators saw</div><pre class="code wrap">${esc(s.request?.input || '')}</pre>
      <div class="sec-label">Verdict</div><pre class="code">${esc(JSON.stringify(s.verdict, null, 2))}</pre>`;
  }
  return `<pre class="code">${esc(JSON.stringify(s.output, null, 2))}</pre>`;
}

function renderTrail(a) {
  const kindChip = { serv: '<span class="chip serv">SERV</span>', reppo: '<span class="chip reppo">Reppo</span>', code: '<span class="chip code">Code</span>', external: '<span class="chip ext">Agent</span>' };
  const rows = a.steps.map((s, i) => {
    const tokens = s.usage ? `${(s.usage.total_tokens ?? (s.usage.prompt_tokens + s.usage.completion_tokens)).toLocaleString()} tokens` : '';
    return `<details class="step">
      <summary><span class="ix">${String(i + 1).padStart(2, '0')}</span>${kindChip[s.kind] || ''}<span class="ttl"><b>${esc(s.title)}</b><span class="feats">${stepFeatures(s)}</span></span>
        <span class="rt">${tokens ? `<span>${tokens}</span>` : ''}${s.latencyMs ? `<span>${(s.latencyMs / 1000).toFixed(1)} s</span>` : ''}</span></summary>
      <div class="body">${stepBody(s)}</div>
    </details>`;
  }).join('');
  const servSteps = a.steps.filter((s) => s.kind === 'serv');
  const valid = servSteps.filter((s) => s.validation?.ok).length;
  $('#trail').innerHTML = `
    <div class="block-h"><div><h2>Decision trail</h2><p>Every step behind this decision, in order. SERV steps return typed JSON against a versioned schema, and Spendgrade validates each one again. Open a step for the full record.</p></div>
      <span class="chip ok">${valid} of ${servSteps.length} SERV outputs validated</span></div>
    <article class="card trail">${rows}</article>`;
}

const ships = (a) => (a.reppo || []).filter((r) => r.ev.result.route === 'ship').length;
function changeRows(before, after) {
  return after.reppo.map((r) => {
    const b = before.reppo.find((x) => x.task === r.task);
    const cell = (x) => `<span class="sc">${x.ev.result.score}</span> <span class="chip ${ROUTE_CLASS[x.ev.result.route] || ''}">${esc(x.ev.result.route)}</span>`;
    const chk = (app) => { const c = app.audit.filter((a) => a.task === r.task); const p = c.filter((a) => a.pass).length; return `<span class="chip ${p === c.length ? 'ok' : 'bad'}">${p} of ${c.length}</span>`; };
    return `<tr><td>${esc(r.task)} · ${esc(taskTitle(r.task))}</td><td>${b ? cell(b) : '-'}</td><td>${cell(r)}</td><td>${chk(before)}</td><td>${chk(after)}</td></tr>`;
  }).join('');
}

function renderLearned() {
  const c = run.coaching?.[0];
  if (!c || run.applications.length < 2) { $('#learned').innerHTML = ''; return; }
  const before = run.applications[0], after = run.applications[1];
  const added = new Set((c.patch.patches || []).map((p) => p.rule));
  const removed = (c.playbook.removed || []).map((r) => `<div class="pb-rule removed"><span class="mk">-</span><span>${esc(r)}</span></div>`).join('');
  const kept = c.playbook.rules.filter((r) => !added.has(r)).map((r) => `<div class="pb-rule kept"><span class="mk"></span><span>${esc(r)}</span></div>`).join('');
  const adds = (c.patch.patches || []).map((p) => `<div class="pb-rule added"><span class="mk">+</span><span>${esc(p.rule)}<span class="addr">${p.addresses.map((x) => `<span class="chip id">${esc(evidenceLabel(x))}</span>`).join('')}</span></span></div>`).join('');
  const diag = (c.patch.diagnosis || []).map((d) => `<div><span class="chip id">${esc(evidenceLabel(d.evidence_id))}</span> ${esc(d.problem)}</div>`).join('');
  const delta = (x, y) => `${x} <span class="to">to</span> ${y}`;
  $('#learned').innerHTML = `
    <div class="block-h"><div><h2>What ${esc(before.agent)} learned</h2><p>The SERV coach read Reppo's findings on application 1 and rewrote ${esc(before.agent)}'s playbook. Nothing else changed between the two applications: same tasks, same model, same underwriter.</p></div>
      <div class="meta-row"><span class="chip reppo">Ship verdicts ${delta(ships(before), ships(after))} of ${after.reppo.length}</span><span class="chip">Checks ${delta(passed(before), passed(after))} of ${after.audit.length}</span><span class="chip ok">Score ${delta(before.score.score, after.score.score)}</span></div></div>
    <article class="card changes"><div class="card-h"><h3>Task by task</h3><span class="chip">application 1 to application 2</span></div><div class="card-b"><table class="chg"><thead><tr><th>Task</th><th>Reppo before</th><th>Reppo after</th><th>Checks before</th><th>Checks after</th></tr></thead><tbody>${changeRows(before, after)}</tbody></table></div></article>
    <div class="learned">
      <article class="card"><div class="card-h"><h3>Diagnosis from the findings</h3><span class="chip serv">SERV coach</span></div><div class="card-b"><div class="diag">${diag}</div><p class="expect">${esc(c.patch.expected_effect)}</p></div></article>
      <article class="card"><div class="card-h"><h3>Playbook ${esc(c.from)} to ${esc(c.to)}</h3><span class="chip">reasoning effort ${esc(c.playbook.reasoningEffort)}</span></div><div class="card-b"><div class="pb">${removed}${kept}${adds}</div></div></article>
    </div>`;
}

function renderExport(a) {
  const k = a.kiteSession;
  $('#export').innerHTML = `
    <div class="block-h"><div><h2>Hand-off</h2><p>The decision becomes a spending session another system can enforce, and a receipt anyone can re-check against the recorded run.</p></div></div>
    <div class="export">
      <article class="card"><div class="card-h"><h3>Kite Agent Passport session draft</h3><span class="chip">owner approves with a passkey</span></div>
        <div class="card-b">${k ? `<pre class="code">${esc(k.command)}</pre>` : '<p class="muted">No session. This tier allows no spending.</p>'}</div></article>
      <article class="card"><div class="card-h"><h3>Decision receipt</h3><span class="chip code">${esc(a.receipt.algorithm)}</span></div>
        <div class="card-b receipt"><div class="digest">${esc(a.receipt.digest)}</div>
          <dl class="kv"><dt>Reppo evals</dt><dd class="mono">${(a.record.reppo_eval_ids || []).map(esc).join('<br>')}</dd><dt>SERV completion</dt><dd class="mono">${esc(a.record.serv_completion_id || '-')}</dd><dt>Rulebook</dt><dd class="mono">${esc(a.record.underwriter_prompt)} · ${esc(a.record.decision_schema)}</dd><dt>Issued</dt><dd>${esc(a.record.issued_at)}</dd></dl>
        </div></article>
    </div>`;
}

boot();
