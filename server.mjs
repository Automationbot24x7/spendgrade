// Spendgrade local API and report viewer.
//   GET  /v1/packs/procurement-pack-1   audit pack for an agent to answer (no answers)
//   POST /v1/applications                start a credit application (async: Reppo window)
//   GET  /v1/applications/:id            status, verdict, decision, receipt
//   GET  /v1/runs                        recorded runs
// Static files (landing page, report viewer, recorded runs) are served from the repo root.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { ROOT, SERV_API_KEY, REPPO_API_KEY } from './src/config.js';
import { Checkpoint, loadPack, loadPlaybook, runApplication, DEFAULT_REQUEST } from './src/pipeline.js';
import { WORK_SCHEMA } from './src/applicant.js';
import { validate } from './src/validate.js';
import { writeIndex } from './src/runs-index.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const jobs = new Map();

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 200000) throw new Error('Body too large');
  }
  return data ? JSON.parse(data) : {};
}

function publicPack(pack) {
  const { groundTruth, ...rest } = pack;
  return rest;
}

function summary(state) {
  const a = state.applications[0] || {};
  return {
    id: state.id,
    status: a.stage === 'done' ? 'decided' : a.audit && !a.score ? 'evaluating' : a.stage || 'queued',
    error: jobs.get(state.id)?.error || null,
    reppo_verdicts: (a.reppo || []).map((r) => ({ task: r.task, eval_id: r.ev.id, score: r.ev.result?.score, route: r.ev.result?.route, confidence: r.ev.result?.confidence, reason: r.ev.result?.reason, rubric: r.ev.result?.rubric_scores })),
    audit: a.audit || null,
    spendgrade_score: a.score?.score ?? null,
    decision: a.decision || null,
    policy_overrides: a.overrides || null,
    kite_session_draft: a.kiteSession || null,
    receipt: a.receipt || null,
  };
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, { ok: true, serv: Boolean(SERV_API_KEY), reppo: Boolean(REPPO_API_KEY) });
  if (req.method === 'GET' && url.pathname.startsWith('/v1/packs/')) {
    const pack = loadPack();
    if (url.pathname.endsWith(pack.id)) return send(res, 200, publicPack(pack));
    return send(res, 404, { error: 'Unknown pack' });
  }
  if (req.method === 'GET' && url.pathname === '/v1/runs') return send(res, 200, { runs: writeIndex() });
  if (req.method === 'POST' && url.pathname === '/v1/applications') {
    const body = await readBody(req);
    const pack = loadPack();
    const id = `app-${Date.now().toString(36)}`;
    const cp = new Checkpoint(id);
    cp.state.kind = 'api';
    const request = { ...DEFAULT_REQUEST, ...(body.request || {}) };
    let playbook = { version: 'external', rules: [], origin: 'Submitted through the API' };
    if (Array.isArray(body.work)) {
      const errors = [];
      for (const w of body.work) errors.push(...validate(WORK_SCHEMA, w).errors);
      const missing = pack.tasks.filter((t) => !body.work.some((w) => w.task_id === t.id)).map((t) => t.id);
      if (missing.length) errors.push(`missing decisions for ${missing.join(', ')}`);
      if (errors.length) return send(res, 400, { error: 'Invalid work', details: errors });
      cp.state.applications[0] = { index: 0, agent: body.agent || 'external-agent', playbookVersion: 'external', playbook, request, steps: [], stage: 'worked', work: body.work.map((w) => ({ taskId: w.task_id, decision: w })) };
    } else {
      playbook = loadPlaybook(body.playbook || 'v1');
    }
    cp.save();
    const job = { error: null };
    jobs.set(id, job);
    runApplication(cp, 0, { pack, playbook, request, agent: body.agent || 'Quill' })
      .then(() => {
        cp.state.done = true;
        cp.save();
      })
      .catch((e) => {
        job.error = e.message;
      });
    return send(res, 202, { id, status: 'queued', poll: `/v1/applications/${id}` });
  }
  const m = url.pathname.match(/^\/v1\/applications\/([\w-]+)$/);
  if (req.method === 'GET' && m) {
    const path = join(ROOT, 'data', 'runs', `${m[1]}.json`);
    if (!existsSync(path)) return send(res, 404, { error: 'Unknown application' });
    return send(res, 200, summary(JSON.parse(readFileSync(path, 'utf8'))));
  }
  return send(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT) || /Credentials|\.git|node_modules/.test(file) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

export function start(port = 8787) {
  createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/v1/')) return await api(req, res, url);
      return serveStatic(req, res, url);
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  }).listen(port, () => console.log(`Spendgrade on http://localhost:${port}`));
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('server.mjs')) start(Number(process.argv[2]) || 8787);
