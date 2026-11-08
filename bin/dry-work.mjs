#!/usr/bin/env node
// Development helper: run the applicant on a pack and print the ground-truth audit,
// without sending anything to Reppo. Usage:
//   SG_MODEL_APPLICANT=<model> node bin/dry-work.mjs <packFile> <playbookFile> [effort]
import { loadPack, loadPlaybook } from '../src/pipeline.js';
import { runApplicant, groundTruthAudit } from '../src/applicant.js';
import { MODELS } from '../src/config.js';

const [packFile = 'audit-pack-2', pbFile = 'v1-autonomy', effort] = process.argv.slice(2);
const pack = loadPack(packFile);
const pb = loadPlaybook(pbFile);
if (effort) pb.reasoningEffort = effort;
const work = await runApplicant(pack, pb, { onStep: (s) => console.log(`  ${s.taskId} ${s.latencyMs} ms ${s.usage?.total_tokens} tok`) });
const audit = groundTruthAudit(pack, work);
console.log(`model ${MODELS.applicant}, effort ${pb.reasoningEffort}`);
for (const w of work) console.log(w.task.id, w.decision.action, w.decision.vendor, w.decision.amount_usd, w.decision.needs_human_approval, '|', w.decision.rationale.slice(0, 140));
console.log(audit.map((a) => `${a.id}:${a.pass ? 'pass' : 'FAIL'}`).join(' '));
