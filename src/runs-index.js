// Builds data/runs/index.json, the manifest the report viewer reads.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

export function writeIndex() {
  const dir = join(ROOT, 'data', 'runs');
  const runs = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json')) {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (!r.done) continue;
    runs.push({
      id: r.id,
      file: `data/runs/${f}`,
      kind: r.kind,
      pack: r.pack || null,
      agent: r.applications[0]?.agent,
      runtime: r.applications[0]?.runtime || 'serv',
      createdAt: r.createdAt,
      applications: r.applications.map((a) => ({
        playbook: a.playbookVersion,
        reppoEvalIds: (a.reppo || []).map((r) => r.ev.id),
        reppoScores: (a.reppo || []).map((r) => r.ev.result?.score),
        score: a.score?.score,
        tier: a.decision?.tier,
        dailyLimit: a.decision?.daily_limit_usd,
      })),
    });
  }
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), runs }, null, 2));
  return runs;
}
