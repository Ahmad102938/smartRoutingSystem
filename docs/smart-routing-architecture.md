# Smart Ticket-Routing and Dispatch System — Architecture and System Design

This document is the complete architectural reference for the Smart Ticket-Routing and Dispatch System: the AI core that classifies an incoming maintenance ticket, scores candidate service providers across multiple signals, picks one (with controlled randomness for learning), records every decision for offline training, and learns from outcome feedback over time.

It covers the orchestrator, every agent, the data model, the end-to-end workflow, the architectural decisions and their alternatives, the continuous-learning loop, and the phased rollout that gates learned-model components on data accumulation.

---

## 1. System Purpose and Users

The platform is a Next.js web application that handles store maintenance tickets across four roles:

| Role | Responsibility |
|---|---|
| **Store Register** | Creates tickets when equipment fails (often via QR scan of the affected asset). |
| **Service Provider (company)** | Receives proposed assignments, accepts or rejects them, sends technicians. |
| **Technician** | The individual person doing the work. May belong to a service provider company or operate independently. |
| **Moderator** | Verifies completed work. Provides the ground-truth label that trains the ranker. |
| **Admin** | Full visibility, drift dashboards, model lifecycle. |

The central operational bottleneck the system exists to solve: **given a free-text problem description plus an optional QR-scanned asset, automatically pick the right service provider or technician, fast, and improve at it over time.**

---

## 2. High-Level Architecture

```
                                       ┌──────────────────────────┐
   Store Register fills form  ───►     │  /api/tickets  (POST)    │
                                       └────────────┬─────────────┘
                                                    │
                                            ┌───────▼────────┐
                                            │  AIOrchestrator│       ←─── single entry point
                                            └───┬────────┬───┘
                                                │        │
       ┌────────────────────┬───────────────────┼────────┼─────────────────────┐
       │                    │                   │        │                     │
       ▼                    ▼                   ▼        ▼                     ▼
 ┌───────────┐      ┌──────────────┐      ┌───────────┐ ┌──────────────┐  ┌───────────────┐
 │Classification│   │Availability  │      │Similarity │ │Routing Agent │  │Explainer Agent│
 │  Agent (LLM) │   │  Agent       │      │  Agent    │ │ (deterministic)│  │  (async LLM)  │
 │  Gemini 1.5  │   │  Postgres    │      │  pgvector │ │ + ε-greedy   │  │  Gemini 1.5  │
 └───────────┘      └──────────────┘      └───────────┘ └──────┬───────┘  └───────┬───────┘
                                                               │                  │
                                                       ┌───────▼─────────┐  ┌─────▼────────┐
                                                       │ TicketAssignment│  │ explanation  │
                                                       │ (source of truth)│ │ (audit trail)│
                                                       └─────────────────┘  └──────────────┘
                                                               │
                                                       ┌───────▼─────────┐
                                                       │ Moderator       │
                                                       │ verifies via    │
                                                       │ /api/.../verify │
                                                       └───────┬─────────┘
                                                               │
                                            (TicketRating + TicketOutcome accumulate
                                             → exporter → Python sidecar → XGBoost → next model)
```

**Stack:**

- **Frontend:** Next.js 14 App Router, React, shadcn/ui, NextAuth (RBAC).
- **Backend:** Next.js API routes, Prisma ORM.
- **Database:** PostgreSQL on Neon (serverless), with `pgvector` extension for 384-dim cosine search.
- **AI / ML:** Gemini 1.5 Flash (classification + async explanation), `@xenova/transformers` running `bge-small-en-v1.5` locally for embeddings, XGBoost LambdaRank served from a Python FastAPI sidecar (Phase 4 scaffold).
- **Background work:** LangGraph state machines for SLA escalation; cron-triggered API endpoints for explainer sweep and weekly retrain.

---

## 3. Data Model

### 3.1 Pre-existing core entities

| Model | Purpose |
|---|---|
| `User` | Auth identity + role. Roles: `STORE_REGISTER`, `SERVICE_PROVIDER`, `TECHNICIAN` (new), `ADMIN`, `MODERATOR`. |
| `Store` | Geographic location, moderator assignment. |
| `ServiceProvider` | Company-level entity with skill array, capacity, location. |
| `Ticket` | The maintenance request itself. |
| `TicketAssignment` | The proposed/accepted/rejected match between ticket and provider. **Source of truth for ownership.** |
| `Remark`, `Escalation` | Audit trail and SLA-breach tracking. |

### 3.2 New entities introduced for the routing system

| Model | Purpose | Phase |
|---|---|---|
| **`Asset`** | Equipment identity captured from QR scan. Lets us track repair history per piece of equipment. | Phase 0 |
| **`TechnicianSkill`** | Per-technician (User-level) skill list with `NOVICE`/`COMPETENT`/`EXPERT` proficiency and years of experience. Replaces the company-level `ServiceProvider.skills` string array as the routing signal. | Phase 1 |
| **`TicketOutcome`** | Resolution form filled by the technician: `resolution_time_minutes`, `first_time_fix`, `root_cause`, `parts_used`, `technician_notes`, `was_reassigned`, `reassignment_count`. Required to mark a ticket COMPLETED. | Phase 1 |
| **`TicketRating`** | Moderator's verdict (`GOOD`/`BAD`) + tags + comment. The ground-truth label that trains the ranker. GOOD verdict closes the ticket; BAD reopens it. | Phase 1 |
| **`RoutingDecisionLog`** | Counterfactual log: for every routing call, stores the top-5 candidates, their scores, the picked candidate, and whether it was an exploration choice. Enables offline training without selection-bias poisoning. | Phase 0 |

### 3.3 Schema extensions to existing entities

- **`Ticket.asset_id`** — FK to `Asset` (replaces the orphaned string `qr_asset_id`).
- **`Ticket.embedding vector(384)`** — bge-small embedding of `description + category + subcategory`.
- **`User.skill_embedding vector(384)`** — rolling synthesis of the technician's last 20 GOOD-verified resolutions.
- **`Asset.embedding vector(384)`** — embedding of `make + model + category + description`.
- **`TicketAssignment.assigned_user_id`** — nullable FK to `User`. Set when the assignment targets a specific technician (independent contractor or named tech within a company). The denormalized `Ticket.assigned_service_provider_id` is **kept as a cache** for legacy reads but is no longer the source of truth.
- **`TicketAssignment.was_exploration`** — flags assignments produced by the ε-greedy band so the trainer can weight them appropriately.
- **`TicketAssignment.explanation`, `.explanation_status`, `.ai_disagreement`, `.explained_at`** — written by the async explainer.
- **`HNSW indexes`** on all three vector columns using `vector_cosine_ops`.

### 3.4 Key invariants

1. **Source of truth for "who owns this ticket"** is the most recent active `TicketAssignment` row (status `PROPOSED` or `ACCEPTED`), not the denormalized field on `Ticket`.
2. **Live load** for capacity filtering is derived via `COUNT(TicketAssignment WHERE status IN ('PROPOSED','ACCEPTED'))`, not the manually-mutated `ServiceProvider.current_load` integer.
3. **Every assignment writes a `RoutingDecisionLog` row** before the assignment row is created — counterfactual logging is unconditional.
4. **Moderator verification (`TicketRating`) is the only signal that feeds learning.** A self-reported COMPLETED status from a technician is not enough; closure requires GOOD verdict.

---

## 4. End-to-End Workflow

### 4.1 Ticket creation → assignment

```
1. Store register submits the form
   POST /api/tickets   { description, location_in_store, qr_asset_id? }

2. /api/tickets handler
   - validates session + permission (ticket:create)
   - validates payload (Zod)
   - resolves the user's store
   - delegates everything else to AIOrchestrator.processNewTicket()

3. AIOrchestrator.processNewTicket
   3a. Classification Agent → category, subcategory, priority, confidence
   3b. Escalation Agent → SLA deadline based on priority
   3c. Asset upsert: if qr_asset_id present, find-or-create Asset row
   3d. Persist Ticket row (status=OPEN)
   3e. Embed ticket text → fire-and-forget UPDATE tickets SET embedding
   3f. Availability Agent → APPROVED providers with live capacity
   3g. enrichWithSimilarityFeatures → adds semantic_similarity + asset_history
   3h. Routing Agent
       - Six-feature score per candidate
       - ε-greedy choice (10% pick from top-3 randomly)
       - Write RoutingDecisionLog (top-5 candidates + chosen)
       - Write TicketAssignment (PROPOSED, with was_exploration flag)
       - Update Ticket.status=ASSIGNED + denormalized cache field
   3i. setImmediate(explainer.processPending(1)) — async LLM rationale

4. API returns the assignment to the store register
   (latency budget: <2s p95; LLM never on this path)
```

### 4.2 Acceptance → resolution → verification

```
5. Service provider receives the proposal
   POST /api/tickets/[id]/accept  → assignment.status=ACCEPTED, ticket.status=IN_PROGRESS
   OR
   POST /api/tickets/[id]/reject  → assignment.status=REJECTED + reroute (see 4.3)

6. Technician resolves the issue
   POST /api/tickets/[id]/resolve  { resolution_time, first_time_fix, root_cause, ... }
   - upsert TicketOutcome
   - ticket.status=COMPLETED, completed_at=now

7. Moderator verifies
   POST /api/tickets/[id]/verify  { verdict: 'GOOD'|'BAD', tags, comment? }
   - upsert TicketRating
   - if GOOD:
       ticket.status=CLOSED
       fire-and-forget: SimilarityAgent.refreshTechnicianSkillEmbedding(resolver_user_id)
   - if BAD:
       ticket.status=IN_PROGRESS (reopened)
       (negative training signal for future ranker)
```

### 4.3 Rejection and reassignment

`AIOrchestrator.handleTicketRejection` runs the same routing flow with the rejecting provider filtered out:

1. Mark current assignment `REJECTED` with reason.
2. Live load auto-decrements (derived from `TicketAssignment` count, no manual mutation).
3. Append a system Remark to the ticket so the store sees what happened.
4. Re-run availability + similarity + routing on the remaining pool.
5. If a next-best provider exists → new `TicketAssignment` with `assignment_sequence += 1`, ticket back to `ASSIGNED`.
6. If pool is empty → ticket → `ESCALATED`, remark logged for management.

Rejection itself is a learning signal: the `RoutingDecisionLog` already captured this provider as the top pick, and now we have evidence the heuristic was wrong.

---

## 5. The AI Orchestrator

`lib/ai/orchestrator.ts` is the single entry point for ticket-lifecycle work. Centralising this is deliberate: it gives one place to enforce ordering, manage cross-agent context, and own the transactional shape of state changes.

**Public methods:**

| Method | Triggered by | What it does |
|---|---|---|
| `processNewTicket(data)` | `POST /api/tickets` | The full create → classify → assign pipeline (Section 4.1). |
| `handleTicketAcceptance(ticketId, providerId, empId, phone)` | `POST /api/tickets/[id]/accept` | Marks assignment `ACCEPTED`, ticket `IN_PROGRESS`, captures the accepting employee details. |
| `handleTicketRejection(ticketId, providerId, reason)` | `POST /api/tickets/[id]/reject` | Marks rejection, reroutes (Section 4.3). |
| `handleTicketCompletion(ticketId, providerId)` | (legacy completion path; superseded by `/resolve`) | Marks ticket `COMPLETED`. |

**Private helpers:**

- `getRequiredSkills(category, subcategory)` — the skill-mapping table that translates classifier output into a list of routing-relevant skills (e.g., `Facilities/Cold Storage → ['Refrigeration', 'HVAC']`).
- `enrichWithSimilarityFeatures(providers, ticketText, assetId)` — calls the similarity agent and decorates each candidate with `semantic_similarity` and `asset_history_good_ratio` features.

---

## 6. Agents

Each agent is a single-responsibility module. The orchestrator composes them; agents do not call each other directly.

### 6.1 Classification Agent (`lib/ai/agents/classification-agent.ts`)

**Input:** free-text ticket description.
**Output:** `{ category, subcategory, priority: HIGH|MEDIUM|LOW, confidence: 0–1, reasoning }`.

**Engine:** Gemini 1.5 Flash with `responseMimeType: 'application/json'` and a strict response schema. Output is validated against a Zod schema.

**Fallback:** keyword-based mock classifier — if no `GEMINI_API_KEY` is set or the LLM call fails, simple substring matching maps "freezer/cooling" → `Facilities/Cold Storage/HIGH`, "POS/checkout" → `IT/POS Systems/HIGH`, etc. The system never fails to classify; degrade-don't-die is a design rule.

**Why the priority output matters:** the escalation agent reads it to compute SLA deadlines (HIGH = 4h, MEDIUM = 12h, LOW = 48h). The routing agent shifts its weights based on it (HIGH urgency favors proximity + availability over learned signals).

### 6.2 Availability Agent (`lib/ai/agents/availability-agent.ts`)

**Input:** required skills (from category/subcategory map), store latitude/longitude.
**Output:** ranked list of candidate providers, each annotated with `distance`, `availabilityScore`, `skillMatchScore`, `overallScore`, and a derived `current_load` count.

**Pipeline:**

1. Validate inputs.
2. Fetch all `ServiceProvider` rows with `status=APPROVED` that have at least one active user.
3. **Derive live load** via a single `groupBy` over `TicketAssignment` filtered by `status IN ('PROPOSED','ACCEPTED')`. This replaces a previous design that mutated `ServiceProvider.current_load` from three different code paths and silently drifted under failures.
4. Hard filter: drop anyone whose live load equals or exceeds `capacity_per_day`.
5. **Skill score** (0–1): fuzzy bidirectional substring match — a required skill matches a provider skill if either string is contained in the other (case-insensitive). Score = matched / required. Providers with zero matches stay in the pool but score 0; the routing agent decides whether to use them.
6. **Distance** via Haversine formula, in kilometres.
7. **Composite "overall" score** = `0.4 × availability + 0.3 × distanceScore + 0.3 × skillMatch` (where `distanceScore = max(0, 1 - distance/100)`).
8. Sort descending and return.

**Important:** this is a coarse filter, not the final ranking. The routing agent re-scores survivors with a finer formula and additional features.

### 6.3 Routing Agent (`lib/ai/agents/routing-agent.ts`)

**Input:** ticket context + enriched candidates (with similarity and asset-history features attached).
**Output:** chosen `providerId`, score, reasoning string, exploration flag.

**Six-feature score:**

| Feature | Weight (default) | What it measures |
|---|---|---|
| `skillMatch` | 0.30 | Weighted skill-overlap score. Mapping table at `routing-agent.calculateSkillMatch` assigns per-skill weights (e.g., for `Facilities/Cold Storage`: Refrigeration 0.8, HVAC 0.6, Electrical 0.4). |
| `availability` | 0.15 | `1 - current_load / capacity_per_day` |
| `proximity` | 0.20 | `1 - distance / 50km` (clamped) |
| `performance` | 0.10 | Historical `completed/total` ratio. New providers default to 0.5. |
| `semanticSimilarity` | 0.15 | Cosine similarity between the ticket's text embedding and the candidate's `skill_embedding`. **0 until embeddings populate** — graceful degradation. |
| `assetHistory` | 0.10 | Fraction of past tickets on this asset (or model) resolved with `verdict=GOOD` by this candidate. **0 until rated history accumulates.** |

**Priority-driven weight adjustment** for HIGH-priority tickets:
- proximity +0.10, availability +0.10
- skillMatch −0.05, semanticSimilarity −0.10, assetHistory −0.05
- (Total still sums to 1.0; HIGH tickets are biased toward "fast arrival" features over learned signals.)

**ε-greedy exploration:** with probability `ROUTING_EXPLORATION_RATE` (env, default 0.10), the agent picks uniformly from the top 3 candidates instead of strictly the top 1. **This is critical:** without exploration, the eventual learned ranker only ever sees data from its own policy, and it memorizes the heuristic instead of learning fit. Selection-bias poisoning is the silent killer of recommender systems; exploration is the antidote.

**Counterfactual logging:** before writing the assignment, `RoutingDecisionLog.create` stores the top 5 candidates with full breakdowns plus the picked candidate and `was_exploration` flag. This row is the unit of training data for Phase 4 — for each historical decision, we know what the policy would have done with each candidate, even though only one of them got the actual outcome.

**Writes performed (in order):**

1. `RoutingDecisionLog` row.
2. `TicketAssignment` row with `status=PROPOSED` and `was_exploration` flag.
3. `Ticket.status=ASSIGNED` + denormalized cache field update.

**Removed in this redesign:**
- A dead `GoogleGenerativeAI` block in the constructor that was never called by `routeTicket`. Misleading dead code in the file most central to redesign was a debugging tax.
- Manual `ServiceProvider.current_load` increment. Load is now derived (Section 6.2 step 3).

### 6.4 Similarity Agent (`lib/ai/agents/similarity-agent.ts`)

Three responsibilities, all backed by pgvector cosine search.

**(a) Rank technicians by skill fit.** Given a ticket text, embed it locally with bge-small-en-v1.5, then run:

```sql
SELECT id, associated_provider_id,
       1 - (skill_embedding <=> $1::vector) AS similarity
FROM users
WHERE skill_embedding IS NOT NULL
  AND role IN ('SERVICE_PROVIDER', 'TECHNICIAN')
  AND is_active = true
ORDER BY skill_embedding <=> $1::vector
LIMIT 100;
```

The HNSW index makes this trivial at 100K+ rows. Results are mapped back to candidate provider IDs by taking the maximum similarity across users belonging to each provider.

**(b) Compute asset-history score per candidate.** Given an `asset_id`, find all past tickets on the same asset (or same `make+model` for fleet matching), look up their `TicketAssignment` and `TicketRating`, and compute a `good_ratio = good_outcomes / total_outcomes` per candidate. Returned as a `Map<candidate_id, AssetHistoryFit>`.

**(c) Refresh a technician's skill_embedding.** Triggered by the verify endpoint after a GOOD verdict. Pulls the technician's last 20 GOOD-verified outcomes, concatenates `root_cause + technician_notes`, embeds the corpus, writes back to `User.skill_embedding`. Cheap (local model), so we run it inline as fire-and-forget.

**Why local embeddings (`bge-small-en-v1.5`) instead of Gemini's `text-embedding-004`:**
- **PII safety.** Ticket descriptions can contain customer names, employee names, and store-specific operational details. Sending those to a third-party embedding API is a data-residency story we don't have.
- **No network hop.** ~30ms warm inference vs. ~200ms+ for a remote API.
- **No vendor lock-in.** bge-small is open and replaceable.

**Cold-start behavior:** until the first ~50 GOOD-verified outcomes accumulate, no user has a `skill_embedding`, so semantic_similarity defaults to 0 across the board, and the deterministic features carry the routing decision. Same for `asset_history_good_ratio`. The system degrades gracefully — it works on day 1 and gets smarter as data fills in.

### 6.5 Explainer Agent (`lib/ai/agents/explainer-agent.ts`)

**Purpose:** produce a human-readable rationale for every routing decision, OR flag when the heuristic looks wrong, **without putting an LLM call on the user's request path.**

**Engine:** Gemini 1.5 Flash with structured JSON output:

```json
{
  "appropriate": boolean,        // is the pick reasonable?
  "confidence": 0..1,            // how sure are you
  "rationale": "string",         // 2-4 sentences
  "concerns": ["string"]         // optional, when appropriate=false
}
```

**Two trigger paths:**

1. **`setImmediate` after every successful routing call** in `orchestrator.processNewTicket`. The user gets their assignment confirmation immediately while Gemini drafts the audit text in the background. Failures are logged on the assignment row (`explanation_status=FAILED`), not surfaced to the user.

2. **Cron sweep at `/api/cron/explain-assignments`** (POST, secret-protected via `X-Cron-Secret` header). Picks up any `TicketAssignment` rows still `PENDING` (e.g. because the orchestrator's fire-and-forget failed or piled up during a Gemini outage). Designed to run every 30–60 seconds.

**`ai_disagreement` flag:** when Gemini returns `appropriate=false` AND `confidence > 0.6`, the explainer sets `ai_disagreement=true` on the assignment row. The admin dashboard surfaces this as an audit signal — but the system **does not auto-reroute** based on AI disagreement. Humans decide.

**Why Gemini is allowed here but not in routing:**
- Routing must complete in under 2 seconds and survive Gemini outages.
- Explanation can take 5–15 seconds and just sits in PENDING during outages.
- The escalation agent already follows the same async pattern (LangGraph batch over open tickets).

### 6.6 Escalation Agent (`lib/ai/agents/escalation-agent.ts`)

Pre-existing; relevant context only. Built on LangGraph (the only LangGraph user in the codebase pre-redesign) as a periodic batch over `findMany`'d active tickets. Computes SLA deadline at ticket creation time based on priority and detects breaches at three thresholds: assignment timeout, acceptance timeout, resolution timeout. Sets `Ticket.status=ESCALATED` and writes an `Escalation` row when a threshold is hit.

The explainer agent's async pattern was modeled on this — same shape (batch processing of pending rows), same off-the-request-path discipline.

---

## 7. Architectural Decisions

These choices were made deliberately over the obvious alternative; each was stress-tested.

### 7.1 Technician identity = `User` with `role=TECHNICIAN`, not a separate model

**Decision:** an individual technician is a `User` row with `role=TECHNICIAN` and an optional `associated_provider_id` (null = independent contractor, set = belongs to a company).

**Alternative considered:** a separate `Technician` model alongside `User` and `ServiceProvider`.

**Why we picked this:** three identity models would have forced auth, notifications, permissions, and audit logs to fan out across all three. One identity model with a role enum keeps the system coherent; the role discriminator is enough to specialize behavior where needed.

### 7.2 Polymorphic assignment via dual-FK, not xor or STI

**Decision:** `TicketAssignment` has two nullable FKs: `service_provider_id` (the company) and `assigned_user_id` (the named technician). Both can be set when Tech-X-at-Company-Y does the work. No xor constraint, no discriminator column, no single-table inheritance.

**Alternatives considered:** xor constraint (only one FK set), discriminator column, two separate join tables.

**Why we picked this:** the data is genuinely both — when a company is assigned and they nominate Tech X to do the work, both facts are true at once. Forcing xor would require the application to choose which FK to set and lose the other relationship. Two FKs with sensible defaults is cleanest in Prisma and gives obvious indexes (`@@index([assigned_user_id, status])`, `@@index([service_provider_id, status])`).

### 7.3 Routing is deterministic on the request path; LLM reasoning is async

**Decision:** the routing agent uses no LLMs at request time. The explainer runs after the assignment is already committed, in a fire-and-forget background path.

**Alternative considered:** LLM-aided ranking inside the routing call (e.g., LangGraph workflow with tool calls).

**Why we picked this:** ticket creation today completes in under 2 seconds. An LLM-aided ranker with tool calls would push that to 5–15s p50, 30s+ p99, and would tie the system's availability to Gemini's. The escalation agent's batch pattern was the only existing LangGraph use — and it runs as a cron, not inline. Same discipline applied here.

### 7.4 Local embeddings (`bge-small-en-v1.5`), not Gemini `text-embedding-004`

**Decision:** all embeddings run in-process via `@xenova/transformers`.

**Alternative considered:** Gemini's embedding API.

**Why we picked this:**
- **PII.** Ticket descriptions contain identifying information; sending them to a third-party embedding API is a compliance story we don't have.
- **Latency.** ~30 ms warm vs. ~200+ ms over the network.
- **Replaceability.** Open-weight model; we can swap to a different bge variant or to E5 without API contract changes.
- **Quality.** bge-small-en-v1.5 is competitive with text-embedding-004 on the MTEB retrieval benchmark for short technical text.

### 7.5 Counterfactual logging from day 1

**Decision:** every routing call writes a `RoutingDecisionLog` row containing the top-5 candidates, their score breakdowns, the picked candidate, and the exploration flag — **before** the assignment is written.

**Why:** the eventual learned ranker (Phase 4) needs to train on something other than "the heuristic was right." If we only logged the chosen candidate, the model would memorize the existing policy. Counterfactual rows let the model see what the policy would have done with each alternative, and ε-greedy ensures we sometimes pick alternatives so we can compare outcomes. Selection-bias poisoning is the #1 silent failure mode of learned rankers; this design prevents it from the first ticket onward.

### 7.6 Moderator verification is the training label, not requester rating

**Decision:** the ground-truth label for "was this routing decision good?" comes from the moderator's `TicketRating.verdict` (GOOD/BAD), not from the store register's rating.

**Why:** store register ratings have low signal. People who hit "close" on a modal often pick angry one-stars or polite five-stars without thought. The moderator (one per store) has workflow incentive to verify accurately and produces higher-quality labels. We trade volume for signal-to-noise.

### 7.7 `TicketAssignment` is the source of truth; the denormalized field is a cache

**Decision:** the question "who is currently assigned?" is answered by the most recent active `TicketAssignment` row. The denormalized `Ticket.assigned_service_provider_id` is kept as a read cache for legacy code paths.

**Why:** with polymorphic targets (company XOR technician), a single column on `Ticket` cannot capture the truth. The `TicketAssignment` row carries the full information. The denormalized field stayed in place to avoid a 9-file big-bang sweep; the auth path (`getTicketContext`) and the SERVICE_PROVIDER ticket-list filter were migrated to read from `TicketAssignment` first, with the denormalized field as a fallback for legacy tickets that pre-date the migration.

### 7.8 Live load is query-derived, not a counter

**Decision:** `current_load` for capacity filtering is computed via `COUNT(*)` over active `TicketAssignment` rows in the availability agent. The `ServiceProvider.current_load` integer column is no longer mutated by the application.

**Why:** the previous design mutated the counter from three places (`routing-agent.routeTicket`, `orchestrator.handleTicketRejection`, `orchestrator.handleTicketCompletion`) with no transactional guarantees. Any failure between the assignment write and the counter increment would leave the counter wrong forever. Adding a second target type (technician) would have doubled every mutation site. A single derived `groupBy` query is correct by construction.

### 7.9 ε-greedy exploration band

**Decision:** 10% of routing calls (configurable via `ROUTING_EXPLORATION_RATE`) pick uniformly from the top 3 candidates instead of strictly the top 1.

**Why:** see 7.5. Without exploration, the policy never sees outcomes for non-top-scored candidates, and the learned ranker has no signal to update on. A small exploration band trades a small short-term cost (occasionally picking a slightly worse candidate) for the long-term ability to learn.

---

## 8. Continuous Learning Loop

The system is designed so every ticket outcome flows back into the next routing decision.

### 8.1 Feedback sources

| Source | What it captures | When it's written |
|---|---|---|
| `TicketOutcome` | Resolution time, first-time-fix, root cause, parts used, technician notes | When technician submits the resolve form |
| `TicketRating` | Moderator's GOOD/BAD verdict + tags | When moderator verifies |
| `RoutingDecisionLog` | Top-5 candidates + scores + chosen + exploration flag | At every routing call |
| `TicketAssignment.status` transitions | Acceptance, rejection, expiry | Throughout assignment lifecycle |

### 8.2 Embedding refresh on GOOD outcome

Triggered by the verify endpoint when a moderator submits `verdict=GOOD`. The similarity agent pulls the resolving technician's last 20 GOOD-verified outcomes (`root_cause + technician_notes` text), embeds the concatenated corpus locally, and writes the result back to `User.skill_embedding`. Future routing calls now find this technician via semantic similarity to similar incoming tickets.

### 8.3 Training pipeline (Phase 4 scaffold)

```
RoutingDecisionLog × TicketOutcome × TicketRating
        │
        ▼
lib/ai/training/exporter.ts        ← joins, emits JSONL
        │   (one line per (decision, candidate))
        ▼
training_data.jsonl
        │
        ▼
lib/ai/training/sidecar/train.py   ← XGBoost LambdaRank
        │   (refuses < 200 labeled rows; 1000 recommended)
        ▼
sidecar/model.json + model_version.txt
        │
        ▼
FastAPI sidecar (sidecar/main.py)  ← /rank endpoint, holds model in memory
        │   POST /reload after retrain
        ▼
lib/ai/training/ranker-client.ts   ← Node client, 100ms timeout
        │   gated by ENABLE_LEARNED_RANKER=1
        ▼
Routing agent uses learned scores instead of fixed weights
```

**Single source of truth for features** is `lib/ai/training/feature-builder.ts` — the same function produces feature vectors at request time and at training time. This eliminates train/serve skew, the single most common silent failure of production ML.

**Why a Python sidecar instead of ONNX-in-Node:** XGBoost-to-ONNX has rough edges around categorical features and missing-value handling. A FastAPI sidecar lets data folks iterate without touching the Node app, and the loopback HTTP overhead is <5ms.

### 8.4 Drift dashboards (Phase 5)

`lib/ai/metrics.ts` exposes three queries via `/api/admin/routing-metrics`:

| Metric set | Use |
|---|---|
| `RoutingMetrics` (overall) | acceptance rate, rejection rate, good rate, first-time-fix rate, SLA compliance, exploration rate, AI disagreement rate, explanation failure rate |
| `CategoryAccuracy` (per category) | flags categories where the heuristic is misrouting (e.g., `Facilities/Cold Storage` at 30% good rate → bad skill map) |
| `ProviderPerformance` (per provider) | rolling stats: total tickets, good ratio, rejection rate, avg resolution time |

### 8.5 Weekly retrain

`/api/cron/retrain-ranker` (POST, secret-protected) runs the exporter, optionally pushes the JSONL to a configured webhook (`RANKER_TRAINING_EXPORT_URL`), and triggers `POST /reload` on the FastAPI sidecar. Until ≥1000 labeled outcomes exist, the endpoint returns `ready_to_train: false` and explicitly does not promote a model.

---

## 9. Operational Concerns

### 9.1 Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `GEMINI_API_KEY` | recommended | Classification + explainer; falls back to keyword classifier if absent |
| `ROUTING_EXPLORATION_RATE` | no (default 0.1) | ε-greedy band |
| `CRON_SECRET` | yes for cron endpoints | Shared secret for `/api/cron/*` |
| `RANKER_SIDECAR_URL` | only with Phase 4 | FastAPI sidecar base URL |
| `ENABLE_LEARNED_RANKER` | only with Phase 4 | `1` to use learned scores |
| `RANKER_TIMEOUT_MS` | no (default 100) | Sidecar call timeout |
| `RANKER_TRAINING_EXPORT_URL` | optional | Webhook for weekly training data export |

### 9.2 Migrations applied

| Migration | What it adds |
|---|---|
| `20260504000000_add_smart_dispatch_foundation` | `Asset`, `TechnicianSkill`, `TicketOutcome`, `TicketRating`, `RoutingDecisionLog`, `TicketAssignment.assigned_user_id`, `Ticket.asset_id`, `UserRole.TECHNICIAN`, asset backfill |
| `20260504000001_enable_pgvector_and_embeddings` | `CREATE EXTENSION vector`, three `vector(384)` columns, three HNSW indexes |
| `20260504000002_add_assignment_explanation` | `TicketAssignment.explanation`, `.explanation_status`, `.ai_disagreement`, `.explained_at` |

### 9.3 New dependencies

- `@xenova/transformers` — local embedding inference (~30 MB model file cached after first run).

### 9.4 Failure modes and graceful degradation

| Component | If it fails | What happens |
|---|---|---|
| Gemini API (classification) | API down or no key | Keyword classifier takes over; ticket still gets a category/priority |
| Gemini API (explainer) | API down | `explanation_status=FAILED`; assignment still committed; cron retries later |
| `@xenova/transformers` (embeddings) | Model load fails | `embed()` throws; orchestrator catches, sets similarity = 0 for all candidates; routing falls back to deterministic features |
| Python sidecar (Phase 4) | Down or slow | `ranker-client` 100ms timeout; routing falls back to fixed-weight scoring |
| pgvector (similarity queries) | Extension missing | Similarity agent returns empty result; routing degrades to deterministic features |

### 9.5 Latency budget

- **Ticket creation (request path):** ≤2 seconds p95. The classifier (Gemini, ~1s) is the dominant cost. Embedding + similarity + routing combined are ~100ms.
- **Async explainer:** 5–15 seconds typical, no SLA.
- **Cron sweeps:** every 30–60s for explainer pending queue.
- **Weekly retrain:** off-hours, no user-facing impact.

---

## 10. Phased Rollout

The system is engineered as five phases, with each gating on the data the next requires.

| Phase | Scope | Status | Gate to next |
|---|---|---|---|
| **0** | Cheap wins: delete dead routing-agent Gemini code; capture `Asset` rows on QR scan; add `RoutingDecisionLog` skeleton | Shipped | None — ship immediately |
| **1** | Data foundation: schema models, API endpoints (resolve/verify/skills/assets), frontend forms, load-tracking refactor, ε-greedy band, RBAC sweep | Shipped | Need 4–6 weeks of `TicketOutcome` text data before Phase 2 produces meaningful embeddings |
| **2** | pgvector + local embeddings + similarity agent + routing-agent feature integration | Shipped (inert until Phase 1 outcomes accumulate) | Same as Phase 1 — embeddings are circular without real text |
| **3** | Async LLM explainer + cron sweep | Shipped | None |
| **4** | Learned ranker (XGBoost LambdaRank, FastAPI sidecar, Node client, exporter, training script) | **Scaffolded but inert** | ≥1000 labeled outcomes (`TicketRating` populated). Realistic timeline at 50 tickets/week × 60% verification = ~30 weeks |
| **5** | Continuous improvement: drift dashboards, weekly retrain cron, blue/green model promotion | Drift dashboards shipped; retrain cron is a stub | Phase 4 model in production |

This is the realistic timeline; the cold-start gating on labeled data is a hard constraint, not pessimism.

---

## 11. File Map

### New files
```
prisma/migrations/20260504000000_add_smart_dispatch_foundation/migration.sql
prisma/migrations/20260504000001_enable_pgvector_and_embeddings/migration.sql
prisma/migrations/20260504000002_add_assignment_explanation/migration.sql

lib/ai/embeddings.ts                       # local bge-small wrapper
lib/ai/agents/similarity-agent.ts          # semantic + asset history
lib/ai/agents/explainer-agent.ts           # async Gemini explainer
lib/ai/metrics.ts                          # drift dashboard queries
lib/ai/training/feature-builder.ts         # single source of truth for features
lib/ai/training/ranker-client.ts           # Node client for Python sidecar
lib/ai/training/exporter.ts                # decisions × outcomes × ratings → JSONL
lib/ai/training/sidecar/main.py            # FastAPI ranker service
lib/ai/training/sidecar/train.py           # XGBoost LambdaRank training
lib/ai/training/sidecar/requirements.txt
lib/ai/training/README.md

app/api/tickets/[id]/resolve/route.ts      # technician resolution form
app/api/tickets/[id]/verify/route.ts       # moderator verification
app/api/technicians/[id]/skills/route.ts   # per-tech skill CRUD
app/api/assets/route.ts                    # asset CRUD + lookup
app/api/admin/routing-metrics/route.ts     # drift dashboard data
app/api/cron/explain-assignments/route.ts  # async explainer worker
app/api/cron/retrain-ranker/route.ts       # weekly retrain stub

components/tickets/ResolutionForm.tsx
components/tickets/VerificationForm.tsx
components/technicians/SkillEditor.tsx
```

### Modified files
```
prisma/schema.prisma                       # five new models, enum extensions
lib/ai/orchestrator.ts                     # asset upsert, similarity enrichment, explainer trigger, load-mutation removal
lib/ai/agents/routing-agent.ts             # six-feature scorer, ε-greedy, RoutingDecisionLog write, dead-code removal
lib/ai/agents/availability-agent.ts        # query-derived load
lib/auth/rbac.ts                           # TECHNICIAN role + sweep of getTicketContext
app/api/tickets/route.ts                   # SERVICE_PROVIDER filter via assignments
```

---

## 12. Verification

End-to-end test sequence after applying all migrations:

1. **Asset capture** — Create a ticket via `POST /api/tickets` with a `qr_asset_id`. Confirm an `Asset` row exists with that QR code, and `Ticket.asset_id` is set.
2. **Decision log** — After the same call, confirm a `RoutingDecisionLog` row exists with 5 candidates and a non-null `picked_provider_id`.
3. **Embedding write** — Wait ~5 seconds, confirm `Ticket.embedding` is non-null.
4. **Resolution + verification** — `POST /api/tickets/[id]/resolve` then `POST /api/tickets/[id]/verify` with `verdict=GOOD`. Confirm `TicketOutcome` and `TicketRating` rows populate; `Ticket.status=CLOSED`.
5. **Skill embedding refresh** — After enough GOOD verdicts on one technician, confirm `User.skill_embedding` is non-null.
6. **Async explainer** — With `GEMINI_API_KEY` set, watch `TicketAssignment.explanation` populate within ~30 seconds of an assignment.
7. **Exploration** — Set `ROUTING_EXPLORATION_RATE=0.5`, create several tickets, confirm `was_exploration=true` shows up on roughly half.
8. **Rejection reroute** — Reject an assignment via `POST /api/tickets/[id]/reject`. Confirm a new `TicketAssignment` row with `assignment_sequence=2` appears, status returns to `ASSIGNED`.
9. **Drift dashboard** — `GET /api/admin/routing-metrics?days=30` returns the three metric blocks.
10. **Cron worker** — `POST /api/cron/explain-assignments` with `X-Cron-Secret` header processes any pending explanations.

---

## Summary

The Smart Ticket-Routing and Dispatch System is a closed-loop, multi-agent dispatch engine: a deterministic six-feature scorer with priority-driven weight adjustments and ε-greedy exploration on the request path; semantic similarity over local pgvector embeddings as a learned-feature input; counterfactual decision logging from day one; an asynchronous Gemini-backed explainer for audit trails; a moderator-driven verification loop that produces ground-truth labels; and a Phase 4 scaffold around an XGBoost LambdaRank model served from a Python sidecar that will replace the fixed weights once ~1000 labeled outcomes accumulate.

Every architectural choice was made to satisfy three non-negotiables: **graceful degradation** (the system works on day one even when every learned signal is empty), **PII safety** (no ticket text leaves our infrastructure for embedding), and **train/serve consistency** (one feature builder, one source of truth for ownership, one source of truth for live load). The result is a system that is correct now, gets smarter over time, and never hides its own decisions from a human reviewer.
