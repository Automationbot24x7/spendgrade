// Spendgrade configuration. Everything a reviewer needs to reproduce a run lives here:
// endpoints, models, prompt and schema versions, and the hard policy caps.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Keys live in Credentials/keys.env (git-ignored) or in the environment.
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnvFile(process.env.SPENDGRADE_ENV || join(ROOT, 'Credentials', 'keys.env'));

export const SERV_BASE = process.env.SERV_BASE || 'https://inference-api.openserv.ai/v1';
export const REPPO_BASE = process.env.REPPO_BASE || 'https://eval.reppo.xyz/api/v1';
export const SERV_API_KEY = process.env.SERV_API_KEY || '';
export const REPPO_API_KEY = process.env.REPPO_API_KEY || '';

// Day One guidance: start with the smallest model that fits, low effort by default.
// The underwriter adds Kronos (audits the generated reasoning prompt) and Multipath
// (branching rulebook) through the model-ID suffix.
export const MODELS = {
  applicant: process.env.SG_MODEL_APPLICANT || 'gpt-5.4-mini',
  coach: process.env.SG_MODEL_COACH || 'gpt-5.4-mini',
  // Kronos (-serv-kronos-multipath) is supported; it needs a larger credit balance.
  underwriter: process.env.SG_MODEL_UNDERWRITER || 'gpt-5.4-mini-serv-multipath',
};

export const VERSIONS = {
  applicantPrompt: 'applicant-1',
  coachPrompt: 'coach-2',
  underwriterPrompt: 'underwriter-2',
  decisionSchema: 'decision-1',
  workSchema: 'work-1',
  coachSchema: 'coach-1',
};

// Hard caps enforced in code after SERV decides. SERV picks a tier at or below the
// ceiling the evidence allows; code clamps anything above these numbers.
// Amounts are simulated USD on a test budget. Spendgrade never moves money.
export const TIERS = {
  frozen: { rank: 0, dailyUsd: 0, perTxUsd: 0, label: 'Frozen' },
  deny: { rank: 1, dailyUsd: 0, perTxUsd: 0, label: 'Denied' },
  probation: { rank: 2, dailyUsd: 50, perTxUsd: 20, label: 'Probation' },
  standard: { rank: 3, dailyUsd: 300, perTxUsd: 75, label: 'Standard' },
  trusted: { rank: 4, dailyUsd: 1500, perTxUsd: 300, label: 'Trusted' },
};
export const TIER_ORDER = ['frozen', 'deny', 'probation', 'standard', 'trusted'];

export const CATEGORIES = ['software_subscriptions', 'invoice_payments', 'one_off_purchases'];

// Reppo settlement window for API evaluations (minutes). 10 is the minimum.
export const REPPO_SETTLEMENT_MINUTES = Number(process.env.SG_REPPO_WINDOW || 10);
