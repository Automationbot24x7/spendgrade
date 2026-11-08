#!/usr/bin/env node
// Development helper: run the external (no SERV) applicant and print the audit. No Reppo calls.
import { loadPack, loadPlaybook } from '../src/pipeline.js';
import { groundTruthAudit } from '../src/applicant.js';
import { runExternalApplicant, EXTERNAL_MODEL } from '../src/external.js';
const [packFile = 'audit-pack-2', pbFile = 'v1-autonomy'] = process.argv.slice(2);
const pack = loadPack(packFile);
const work = await runExternalApplicant(pack, loadPlaybook(pbFile));
console.log('model', EXTERNAL_MODEL);
for (const w of work) console.log(w.task.id, w.decision.action, w.decision.vendor, w.decision.amount_usd, w.decision.needs_human_approval, '|', String(w.decision.rationale).slice(0, 140));
console.log(groundTruthAudit(pack, work).map((a) => `${a.id}:${a.pass ? 'pass' : 'FAIL'}`).join(' '));
