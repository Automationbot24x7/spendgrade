# Spendgrade

**Credit checks for AI agents.** Before an agent gets a budget, Spendgrade has its work judged by Reppo's independent evaluators. SERV Reasoning then underwrites a spending limit, and every step goes on the record. Agents that aren't ready get told why and coached, and earn a higher limit by getting better.

- Live site: https://automationbot24x7.github.io/spendgrade/
- Credit report (recorded runs): https://automationbot24x7.github.io/spendgrade/app.html
- Demo video: https://automationbot24x7.github.io/spendgrade/#video
- Built for **SERV Hackathon 02, Reppo track** (OpenServ)

<!-- RESULTS -->

## The problem

Agents can now hold wallets and pay. Passports, x402 and payment rails answer *how* an agent pays. Nobody answers the question every finance team asks first: **how much should this agent be allowed to spend?** Today that number is a guess. Set too tight, the agent is useless; too loose, one bad decision is expensive.

Lenders solved this long ago: look at the track record, apply a written rulebook, set a limit, review it as new evidence arrives. Spendgrade does that for agents.

## How it works

```
 agent work ──▶ Reppo panel ──▶ code: score + ceiling ──▶ SERV underwriter ──▶ code: clamp ──▶ limit + receipt
 (audit pack)   (per action)    (deterministic)            (rulebook, typed)    (hard caps)     (Kite session draft)
                     │
                     └──▶ SERV coach ──▶ new playbook ──▶ agent re-applies
```

1. **Audit pack.** The agent works a pack of tasks for its category. The procurement pack has six: renew software seats, pay a reminder for an invoice that was already paid, buy a service priced in euros, buy laptops when the sales rep offers to split the order under the approval limit, pay an invoice with no purchase order, and pay a vendor whose "new bank details" arrived by email from a look-alike domain. Each task comes with a written purchasing policy and source documents.
2. **Independent verdicts (Reppo).** Every action goes to the Reppo Evaluation API as an `action` evaluation. A stake-weighted panel of independent evaluators returns a 0–100 score, `ship / review / block`, confidence, rubric scores (scope, safety, correctness, reversibility), hard gates and written findings.
3. **Deterministic layer (code).** A ground-truth audit checks the answers that have exactly one right value. Code computes the Spendgrade score (300–850) and the **tier ceiling**, the highest tier the evidence allows. A blocked task means deny; a manipulation signal means frozen.
4. **Underwriting (SERV Reasoning).** A ten-rule underwriting policy decides the tier within the ceiling, which spending categories are safe, the limits and the conditions. Every reason must cite evidence IDs from the packet (`reppo:<evalId>`, `reppo:<evalId>#safety`, `audit:GT-4`).
5. **Code has the last word.** Tier, limits and citations are clamped and validated again; any override is recorded.
6. **Hand-off.** The platform gets a tier, a daily and per-transaction limit, allowed categories, a draft **Kite Agent Passport** spending session (`kpass agent:session create ...`, approved by the owner with a passkey) and a SHA-256 receipt over the decision record.
7. **Feedback loop (Reppo track).** The SERV coach turns Reppo's findings and failed checks into concrete playbook rules. The agent re-applies with the new playbook and is graded again by a fresh evaluator panel. The improvement is measured, not claimed.

Spendgrade grades **any** agent. The demo has two applicants: **Kestrel**, a bring-your-own agent that calls a model directly with no SERV layer, and **Quill**, built on SERV Reasoning.

## How SERV Reasoning powers it

SERV is used where judgment is needed. Arithmetic and hard thresholds stay in code, following SERV's Day One guidance.

| Step | SERV features | What it does |
| --- | --- | --- |
| Underwriter (`src/underwriter.js`) | **Multipath** (`-serv-multipath`), **Shadow Agent** (`serv_shadow_agent` with a testable hint), **Prompt Guard** (`serv_prompt_guard`), **schema-forced JSON** (`decision-1`), medium reasoning effort | Applies the branching rulebook (R1–R10) to mixed evidence, picks categories, writes conditions that answer the evaluators' findings, cites evidence for every reason. The guard screens agent-written text inside the packet; a tripped guard freezes the agent. The shadow agent rejects drafts that exceed the ceiling, cite unknown evidence or skip a required condition. |
| Coach (`src/coach.js`) | Shadow Agent, schema-forced JSON (`coach-1`) | Turns Reppo findings into reusable playbook rules. The shadow agent rejects generic advice and any rule that leaks the audit pack's answers. |
| Quill, the SERV applicant (`src/applicant.js`) | Bounded reasoning, schema-forced JSON (`work-1`) | A procurement agent whose decisions are typed and validated. |
| Kronos (optional) | `-serv-kronos-multipath` | Audits and repairs the generated reasoning prompt before inference. Used for the first recorded run; the default configuration leaves it off to fit the free credit balance. |

Every SERV call is recorded with its prompt version and SHA-256, schema version, OpenServ request ID, completion ID, token usage, finish reason and Spendgrade's own validation result. The credit report shows all of it step by step.

## How Reppo powers it

- One `action` evaluation per task (`POST /api/v1/agents/evals`, then polling `GET /api/v1/agents/evals/{id}`), several in flight at once.
- Verdict fields drive the deterministic layer: `route` (a `block` caps the tier at deny), `score` and `confidence` (the score formula), failed hard `gates`, and the evaluators' findings (the coach's input).
- Low evaluator agreement is respected: a `review` with low confidence drops the tier one level and shortens the review cadence (rule R5).
- Raw Reppo records are saved verbatim in `data/runs/`.

## Who pays

| Customer | Product | Price |
| --- | --- | --- |
| Wallets, agent marketplaces, payment passports | Credit check before raising an agent's limit | $2.50 per application |
| Same | Monitoring: re-grades on a tier cadence, webhooks, custom rulebook, 200 checks included | $499 / month |
| Agent builders | Coaching cycle: findings turned into playbook rules, plus a fresh check | $3.00 per cycle |

A six-task check costs about $1.32 in Reppo evaluations (440 credits each at the console price of $11 per 22,000 credits) plus about $0.08 of SERV calls, measured in the OpenServ console: roughly $1.40, a 44% gross margin at $2.50.

## Run it

Requires Node 20+. No dependencies.

```bash
git clone https://github.com/Automationbot24x7/spendgrade && cd spendgrade
mkdir Credentials && printf "SERV_API_KEY=...\nREPPO_API_KEY=...\n" > Credentials/keys.env
npm test                       # deterministic layer: score, ceilings, clamps, audits
npm start                      # API + site on http://localhost:8787
node bin/spendgrade.mjs check  # verify both keys
node bin/spendgrade.mjs loop my-run audit-pack-3 v1-autonomy          # Quill on SERV: apply, coach, re-apply
node bin/spendgrade.mjs loop my-run audit-pack-3 v1-autonomy external Kestrel   # bring-your-own agent (needs Credentials/external-key.txt)
```

### API

```bash
curl localhost:8787/v1/packs/procurement-pack-3          # tasks, policy, documents (no answers)
curl -X POST localhost:8787/v1/applications -H 'Content-Type: application/json' \
  -d '{"agent":"my-buyer","work":[{"task_id":"T1", ...}], "request":{"daily_limit_usd":300,"per_tx_limit_usd":75}}'
curl localhost:8787/v1/applications/<id>                 # status, verdicts, decision, receipt
```

Runs checkpoint after every stage, so a crash never pays for the same Reppo evaluation twice.

## What was built during the hackathon

Everything in this repository is new, started on 9 November 2026: the pipeline, the Reppo and SERV clients, the underwriting rulebook, the coach, the audit packs, the credit report, the landing page and the recorded runs.

## Honesty notes

- Spending amounts are simulated. Spendgrade never moves money, and the Kite session is a draft the owner must approve.
- Larkspur Studio, its vendors and its documents are fictional test data.
- Starting playbooks are written to be realistic, not flattering. `v1-autonomy` tells the agent to act without asking, as many deployments do. Every later rule was written by the SERV coach from Reppo's findings, and the report shows the diff.
- In the first recorded run, a Spendgrade bug passed Reppo's *passing* gates to the underwriter as failed gates, and it denied a strong agent. The bug is fixed; the superseded decision stays in the run file under `superseded`.
- Evaluator identities are shown as evaluator-1..n in the report; the raw Reppo records in `data/runs/` are unedited.

## Layout

```
src/         pipeline, SERV and Reppo clients, underwriter, coach, scoring, applicants
bin/         CLI (check, loop, apply, finish, reunderwrite, serve)
data/        audit packs, playbooks, recorded runs
test/        node:test suite for the deterministic layer
index.html   landing page    app.html   credit report
```

MIT licensed.
