#!/usr/bin/env node
// Spendgrade CLI.
//   spendgrade check               verify both API keys (no Reppo credits spent)
//   spendgrade loop [runId]        v1 application -> coach -> v2 application (resumable)
//   spendgrade apply <playbook>    one application with a given playbook version
//   spendgrade serve [port]        local API + report viewer
import { SERV_API_KEY, REPPO_API_KEY, MODELS } from '../src/config.js';
import { servJSON } from '../src/serv.js';
import { getEvaluation } from '../src/reppo.js';
import { Checkpoint, loadPack, loadPlaybook, runApplication, runCoaching, DEFAULT_REQUEST } from '../src/pipeline.js';
import { writeIndex } from '../src/runs-index.js';

const [cmd = 'help', ...args] = process.argv.slice(2);

async function check() {
  console.log(`SERV key: ${SERV_API_KEY ? 'set' : 'MISSING'}   Reppo key: ${REPPO_API_KEY ? 'set' : 'MISSING'}`);
  if (SERV_API_KEY) {
    const { output, step } = await servJSON({
      title: 'Key check',
      model: MODELS.applicant,
      system: 'You confirm connectivity. Reply with the JSON object only.',
      promptVersion: 'check-1',
      user: 'Return ok=true.',
      schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
      schemaName: 'check',
      schemaVersion: 'check-1',
    });
    console.log('SERV:', JSON.stringify(output), `${step.latencyMs} ms`, JSON.stringify(step.usage), JSON.stringify(step.responseHeaders));
  }
  if (REPPO_API_KEY) {
    try {
      await getEvaluation('key-check');
    } catch (e) {
      console.log(e.status === 404 ? 'Reppo: key accepted' : `Reppo: ${e.message}`);
    }
  }
}

async function loop(runId = `run-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`, packFile = 'audit-pack', startPlaybook = 'v1', runtime = 'serv', agent = 'Quill') {
  const pack = loadPack(packFile);
  const cp = new Checkpoint(runId);
  cp.state.pack = pack.id;
  cp.state.packSnapshot = pack;
  cp.state.kind = 'loop';
  cp.save();
  console.log(`Run ${runId} -> ${cp.path}`);
  const v1 = loadPlaybook(startPlaybook);
  await runApplication(cp, 0, { pack, playbook: v1, request: DEFAULT_REQUEST, runtime, agent });
  const c = await runCoaching(cp, 0, { pack });
  await runApplication(cp, 1, { pack, playbook: c.playbook, request: DEFAULT_REQUEST, runtime, agent });
  cp.state.done = true;
  cp.save();
  writeIndex();
  const [a, b] = cp.state.applications;
  console.log('\nResult');
  for (const app of [a, b]) {
    console.log(`  ${app.playbookVersion}: Reppo ${app.reppo.map((r) => `${r.task} ${r.ev.result.score} ${r.ev.result.route}`).join(', ')} | audit ${app.audit.filter((x) => x.pass).length}/${app.audit.length} | Spendgrade ${app.score.score} -> ${app.decision.tier} $${app.decision.daily_limit_usd}/day`);
  }
}

async function apply(version = 'v1', runId, packFile = 'audit-pack', runtime = 'serv', agent = 'Quill') {
  const pack = loadPack(packFile);
  const id = runId || `apply-${version}-${Date.now()}`;
  const cp = new Checkpoint(id);
  cp.state.kind = 'single';
  cp.state.pack = pack.id;
  cp.state.packSnapshot = pack;
  const app = await runApplication(cp, 0, { pack, playbook: loadPlaybook(version), request: DEFAULT_REQUEST, runtime, agent });
  cp.state.done = true;
  cp.save();
  writeIndex();
  console.log(JSON.stringify(app.decision, null, 2));
}

// Re-run underwriting for one application, keeping the earlier attempt on record.
async function reunderwrite(runId, index = '0', note = 'superseded') {
  const cp = new Checkpoint(runId);
  const app = cp.state.applications[Number(index)];
  if (!app) throw new Error('No such application');
  app.superseded ||= [];
  app.superseded.push({ note, decision: app.decision, proposed: app.proposed, overrides: app.overrides, packet: app.packet, steps: app.steps.filter((s) => /underwriter|ceiling|Policy enforcement|receipt|score/i.test(s.title)) });
  app.steps = app.steps.filter((s) => !/underwriter|ceiling|Policy enforcement|receipt|score/i.test(s.title));
  for (const k of ['score', 'packet', 'proposed', 'decision', 'overrides', 'receipt', 'record', 'kiteSession']) delete app[k];
  cp.save();
  const pack = cp.state.packSnapshot || loadPack();
  const out = await runApplication(cp, Number(index), { pack, playbook: app.playbook, request: app.request });
  console.log(JSON.stringify(out.decision, null, 2));
}

// Finish one application in an existing run (no coaching), marking the run done.
async function finish(runId, index = '0') {
  const cp = new Checkpoint(runId);
  const app = cp.state.applications[Number(index)];
  const pack = cp.state.packSnapshot || loadPack();
  const out = await runApplication(cp, Number(index), { pack, playbook: app.playbook, request: app.request });
  if (cp.state.applications.length === 1) cp.state.kind = 'single';
  cp.state.done = true;
  cp.save();
  writeIndex();
  console.log(JSON.stringify(out.decision, null, 2));
}

const commands = {
  finish: () => finish(args[0], args[1]),
  reunderwrite: () => reunderwrite(args[0], args[1], args[2]),
  check,
  loop: () => loop(args[0], args[1], args[2], args[3], args[4]),
  apply: () => apply(args[0], args[1], args[2], args[3], args[4]),
  serve: async () => (await import('../server.mjs')).start(Number(args[0]) || 8787),
  index: async () => writeIndex(),
  help: async () => console.log('spendgrade check | loop [runId] [packFile] | apply <playbook> [runId] [packFile] | serve [port] | index'),
};

(commands[cmd] || commands.help)().catch((e) => {
  console.error('Error:', e.message);
  if (e.step) console.error(JSON.stringify({ error: e.step.error, http: e.step.httpStatus, raw: e.step.rawError || e.step.rawContent }, null, 2));
  process.exit(1);
});
