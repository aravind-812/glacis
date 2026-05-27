# Galcis — Logistics Webhook Normalizer

A backend service that ingests arbitrary vendor webhook payloads, classifies them via LLM, normalizes to a canonical schema, and persists to PostgreSQL — with sub-second acknowledgment, duplicate discard, and out-of-order event handling.

---

## Request Flow

```
Vendor
  │
  │  POST /webhook (any JSON)
  ▼
┌─────────────────────────────────────────┐
│               Express Server            │
│                                         │
│  1. Validate body is JSON               │
│  2. SHA-256 hash of key-sorted payload  │
│  3. Lookup hash in payload_hashes       │
│     ├── found  →  202 { duplicate:true }│  ← fast discard, no queue
│     └── new    →  boss.send()           │
│                    202 { ok:true }      │  ← sub-second ack to vendor
└─────────────────────────────────────────┘
                    │
                    ▼  pg-boss queue (webhooks)
                    │  retryLimit: 5, exponential backoff
                    │
┌───────────────────▼─────────────────────┐
│                Worker                   │
│                                         │
│  1. Hash check  (fast-path dedup)       │
│     └── seen? → discard, continue      │
│                                         │
│  2. normalize(payload)                  │
│     ├── Tier 1: LLM_TIER1_MODEL         │
│     │   └── clear result? → use it     │
│     └── Tier 2: LLM_TIER2_MODEL         │
│         └── fallback if UNCLASSIFIED    │
│             or missing vendor_event_id  │
│                                         │
│  3. upsert(normalized, hash)            │
│     └── rank-guarded write              │
│                                         │
│  4. INSERT INTO payload_hashes          │
│     ON CONFLICT DO NOTHING              │  ← atomic dedup gate
│     RETURNING hash                      │
│     └── empty result = race duplicate  │
│         → discard silently             │
└─────────────────────────────────────────┘
         │              │             │
         ▼              ▼             ▼
    shipments       invoices    unclassified
```

---

## Duplicate Detection — Two Layers

```
Vendor sends payload P (first time)
  │
  ├─[Server]──── hash(P) not in payload_hashes ──→ enqueue ──→ Worker processes ──→ INSERT hash
  │
Vendor resends payload P (duplicate)
  │
  ├─[Server]──── hash(P) found in payload_hashes ──→ 202 {duplicate:true}  ← never queued
  │
Two workers race on same job
  │
  ├─[Worker A]── hash not seen ──→ normalize ──→ upsert ──→ INSERT hash → gets RETURNING row ✓
  └─[Worker B]── hash not seen ──→ normalize ──→ upsert ──→ INSERT hash → ON CONFLICT, empty result → discard ✓
```

**Layer 1 (Server):** non-atomic read — performance filter, not the source of truth.  
**Layer 2 (Worker):** `INSERT ... ON CONFLICT DO NOTHING RETURNING hash` — atomic gate. Only one worker wins.

---

## Out-of-Order Events — Status Rank Guard

Every record stores a `status_rank` integer. Updates are only applied if the incoming rank is strictly higher.

```
Shipment ranks:   PICKED_UP(1) → IN_TRANSIT(2) → OUT_FOR_DELIVERY(3) → DELIVERED(4)
Invoice ranks:    ISSUED(1) → VOIDED(2) | PAID(3) → REFUNDED(4)

Example: DELIVERED arrives before IN_TRANSIT
  ┌─────────────────────────────────────────────────────────┐
  │  Event 1: DELIVERED (rank 4) → no row exists → INSERT   │
  │           row: { status: DELIVERED, status_rank: 4 }    │
  │                                                         │
  │  Event 2: IN_TRANSIT (rank 2) → row exists              │
  │           incoming rank 2 > stored rank 4? NO → skip    │
  │           result: DELIVERED preserved ✓                  │
  └─────────────────────────────────────────────────────────┘
```

---

## LLM Normalization — Two-Tier

```
payload
   │
   ▼
Tier 1 ── LLM_TIER1_MODEL (fast / cheap)
   │
   ├── type != UNCLASSIFIED AND vendor_event_id present?
   │     YES → return result                    ← ~80% of traffic exits here
   │     NO  ↓
   ▼
Tier 2 ── LLM_TIER2_MODEL (capable / fallback)
   │
   └── return result (or hardcoded UNCLASSIFIED if both fail)
```

Provider inferred from model name — no code change to switch vendors:

| Model prefix | Provider | API key |
|---|---|---|
| `claude-*` | Anthropic | `ANTHROPIC_API_KEY` |
| `gpt-*` `o1-*` `o3-*` `o4-*` | OpenAI | `OPENAI_API_KEY` |
| `gemini-*` | Google | `GOOGLE_API_KEY` |

Output shape enforced via LangChain `.withStructuredOutput(zod)` — provider's native tool/function-calling API, no regex parsing.

**System prompt** (both tiers, stateless — no conversation history):
```
Classify into: SHIPMENT, INVOICE, or UNCLASSIFIED.

SHIPMENT statuses (map vendor language to canonical):
  PICKED_UP        — gate-in, container received, empty returned and full received
  IN_TRANSIT       — loaded onboard, vessel sailed, departed, en route
  OUT_FOR_DELIVERY — out for delivery, last mile, with courier
  DELIVERED        — delivered, released to consignee, cargo released

INVOICE statuses:
  ISSUED   — invoice raised, created, sent, generated
  PAID     — settled, paid, cleared, settled in full
  VOIDED   — cancelled, voided
  REFUNDED — refunded, reversed, credit note issued

Rules: prefer explicit event IDs for vendor_event_id; convert event_time to ISO8601;
copy amount_raw verbatim; use null for absent fields.
```

---

## Data Model

```
┌──────────────────────────────────────────────────────────────────┐
│ shipments                      │ invoices                        │
│──────────────────────────────  │─────────────────────────────────│
│ id              uuid PK        │ id              uuid PK         │
│ vendor_event_id unique         │ vendor_event_id unique          │
│ payload_hash    unique         │ payload_hash    unique          │
│ tracking_id                    │ invoice_ref                     │
│ status          enum           │ tracking_ref    nullable ─────────→ soft join to shipments
│ status_rank     int            │ status          enum            │
│ carrier                        │ status_rank     int             │
│ location                       │ amount_raw                      │
│ event_time                     │ carrier                         │
│ raw_payload     jsonb          │ event_time                      │
│ created_at                     │ raw_payload     jsonb           │
│ updated_at                     │ created_at / updated_at         │
└────────────────────────────────┴─────────────────────────────────┘

┌──────────────────────┐   ┌───────────────────────────────┐
│ unclassified         │   │ payload_hashes                │
│──────────────────────│   │───────────────────────────────│
│ id       uuid PK     │   │ hash    PK  ← global dedup    │
│ payload_hash unique  │   │ seen_at     registry           │
│ raw_payload jsonb    │   └───────────────────────────────┘
│ received_at          │
└──────────────────────┘
```

No FK between invoices and shipments — `tracking_ref` is a soft cross-reference via B/L number, joinable at query time.  
`raw_payload` stored on every row — normalization bugs are replayable without data loss.

---

## Design Decisions & Trade-offs

| # | Decision | Trade-off |
|---|---|---|
| **1** | **Async queue** — 202 immediately, process in background | Vendor gets ack before event is persisted. If worker crashes mid-job, pg-boss retries (safe — dedup handles it). |
| **2** | **Content-addressed dedup** — SHA-256 of key-sorted JSON | Key sorting stabilises hash across vendors with non-deterministic key order. Server check is non-atomic (perf filter only); worker INSERT is the true gate. |
| **3** | **Two-tier LLM** — cheap model first, capable fallback | Reduces cost for well-structured payloads. LangChain abstraction loses Anthropic-native prompt caching (`cache_control`) — can be re-added per-provider if needed. |
| **4** | **Status rank guard** — only higher-rank events update the row | Prevents regression. Lower-ranked events that arrive late are permanently discarded — useful fields (location, carrier) in those events are lost. |
| **5** | **vendorEventId as upsert key** — one row per vendor event | Multiple vendors reporting the same shipment create separate rows. `trackingId` / `tracking_ref` enable soft grouping but there is no cross-vendor merge. |
| **6** | **Raw payload stored as JSONB** | Full audit trail, replayable. Storage cost grows linearly with volume — partition or archive old rows in production. |
| **7** | **Rank over state machine** — integer rank, not transition graph | Simpler to implement. Does not enforce valid transitions (e.g., DELIVERED → PICKED_UP from a different vendor is allowed). Good enough for the assignment's domain rules. |

---

## Sample Payload Results

| # | Payload | Classification | Status | Notes |
|---|---|---|---|---|
| 1 | Maersk sailed | SHIPMENT | IN_TRANSIT | `milestone: "Loaded onboard and sailed"` |
| 2 | Maersk gate-in | SHIPMENT | PICKED_UP | Same container, earlier event |
| 3 | GFP settled | INVOICE | PAID | `transaction.kind: "settled in full"` |
| 4 | GFP raised | INVOICE | — | Same `doc_ref` → rank-blocked (PAID already stored) |
| 5 | ONE delivered | SHIPMENT | DELIVERED | `milestone_text: "Cargo released to consignee"` |
| 6 | Marine advisory | UNCLASSIFIED | — | No shipment or invoice semantics |

Sample 4 is intentional: both GFP payloads share `doc_ref: GFP-INV-2026-Q2-08821` as their `vendor_event_id`. PAID (rank 3) arrived first; ISSUED (rank 1) was correctly blocked.

---

## Running Locally

**Requirements:** Node 22, Docker

```bash
docker compose up -d
npm install
cp .env.example .env        # add your LLM provider API key
npx prisma migrate deploy
npx prisma generate
npm run dev                 # http://localhost:3000
```

```bash
# Test with sample payloads
for f in samples/*.json; do
  echo -n "$f → "
  curl -s -X POST http://localhost:3000/webhook \
    -H "Content-Type: application/json" -d @$f | jq .
done
```

**Endpoints**

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhook` | Ingest any JSON payload |
| `GET` | `/health` | Liveness check |

---

## Production Roadmap

### P0 — Before any real traffic
| Item | Why |
|---|---|
| Webhook HMAC / bearer token auth | Any caller can currently flood the queue |
| Graceful shutdown (`boss.stop()` + drain) | SIGTERM kills in-flight jobs |
| Structured logging (pino) + trace IDs | `console.log` is unfilterable in prod |
| Dead-letter queue | Exhausted retries disappear silently |

### P1 — Scaling
| Item | Why |
|---|---|
| Separate HTTP + worker containers | Worker crash takes down ingestion surface |
| PgBouncer / shared connection pool | Two separate pools (pg-boss + Prisma) under load |
| LLM prompt caching | System prompt is ~400 tokens; expand past provider threshold to activate caching |
| Rules-based pre-filter for known vendors | Avoid LLM cost for deterministic high-volume payloads |

### P2 — Correctness
| Item | Why |
|---|---|
| Cross-vendor shipment merging | One row per vendor event; no canonical timeline across carriers |
| Atomic rank update (SQL WHERE clause) | App-level read-then-write has a race window under concurrency |
| Currency normalization | `amount_raw` is a verbatim string, not queryable by amount |
| Secrets manager (Vault / AWS SSM) | API keys in env vars are not rotatable at runtime |
