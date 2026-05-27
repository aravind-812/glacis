# Galcis — Logistics Webhook Normalizer

Accepts raw webhook payloads from logistics vendors, classifies them via LLM, and persists normalized records to PostgreSQL. Handles duplicates, out-of-order events, and transient failures without losing data.

## Architecture

```
POST /webhook
     │
     ▼
┌──────────────┐   duplicate?   ┌───────────────────┐
│    Server    │──────yes──────▶│  202 (discarded)  │
│  (Express)   │                └───────────────────┘
│              │   new
│  hash check  │──────────────▶ pg-boss queue (webhooks)
└──────────────┘                         │
                                         ▼
                                ┌────────────────────┐
                                │      Worker        │
                                │                    │
                                │  1. hash check     │
                                │  2. normalize()    │
                                │     └─ Haiku first │
                                │     └─ Sonnet fb   │
                                │  3. upsert()       │
                                │  4. record hash    │
                                └────────────────────┘
                                         │
                              ┌──────────┼──────────┐
                              ▼          ▼          ▼
                         shipments   invoices  unclassified
```

### Components

| File | Role |
|---|---|
| `src/server.ts` | Express HTTP server; validates, hashes, enqueues |
| `src/boss.ts` | pg-boss singleton; queue config with retry policy |
| `src/worker.ts` | Job processor; dedup, normalize, upsert, record hash |
| `src/normalize.ts` | Two-tier LLM classification (Haiku → Sonnet fallback) |
| `src/upsert.ts` | Prisma writes; rank-guarded updates |
| `src/hash.ts` | SHA-256 of key-sorted JSON for stable payload identity |
| `src/types.ts` | Canonical status enums and rank tables |
| `prisma/schema.prisma` | DB models: Shipment, Invoice, Unclassified, PayloadHash |

## Key Design Decisions

### 1. Async queue over synchronous processing

Webhooks are accepted immediately (202) and processed in the background. This decouples vendor latency from DB/LLM latency, prevents lost events on downstream failure, and allows horizontal scaling of workers independently from the HTTP surface.

**Trade-off:** Vendors receive 202 before the event is fully processed. If the queue or worker crashes between enqueue and commit, pg-boss retries the job — handled by the dedup layer.

### 2. Content-addressed deduplication

Payload identity is SHA-256 of key-sorted JSON. Key sorting makes the hash stable across vendors that send semantically identical payloads with non-deterministic key order.

Two layers prevent duplicates reaching the DB:

1. **Server fast-path** — `payloadHash.findUnique` before enqueue. Filters obvious repeats; avoids queuing known work.
2. **Worker atomic write** — `INSERT INTO payload_hashes ... ON CONFLICT DO NOTHING RETURNING hash`. Only the first worker to commit gets `RETURNING hash`. All others see an empty result set and discard.

The two layers together handle both sequential duplicates (same vendor resending) and concurrent duplicates (two workers racing on the same job).

**Trade-off:** The server fast-path is a non-atomic read — a payload received twice in quick succession can both pass the read check and reach the queue. The worker's atomic INSERT is the true dedup gate; the server check is a performance optimization only.

### 3. Two-tier LLM normalization (model-agnostic)

Normalization runs through LangChain, making the provider swappable via environment variables. The provider is inferred from the model name prefix — no code change needed to switch from Anthropic to OpenAI or Google.

| Prefix | Provider | Env key required |
|---|---|---|
| `claude-*` | Anthropic | `ANTHROPIC_API_KEY` |
| `gpt-*`, `o1-*`, `o3-*`, `o4-*` | OpenAI | `OPENAI_API_KEY` |
| `gemini-*` | Google | `GOOGLE_API_KEY` |

Tier 1 (`LLM_TIER1_MODEL`) runs first — fast, cheap. If it returns `UNCLASSIFIED` or omits `vendor_event_id`, Tier 2 (`LLM_TIER2_MODEL`) retries with a more capable model. Both tiers can use models from different providers.

```
# Example: OpenAI tiering
LLM_TIER1_MODEL=gpt-4o-mini
LLM_TIER2_MODEL=gpt-4o

# Example: mixed-provider tiering
LLM_TIER1_MODEL=claude-haiku-4-5-20251001
LLM_TIER2_MODEL=gpt-4o
```

LangChain's `.withStructuredOutput(zod)` enforces the output shape via each provider's native tool/function-calling API — no manual JSON parsing or regex stripping.

**Trade-off:** LangChain abstracts away provider-specific features. Anthropic's `cache_control` prompt caching is not expressible through the LangChain interface and was removed in this version. If caching is needed, it can be re-added per-provider by passing extra options to the respective LangChain class constructor.

**Why not regex/rules-based classification?** Logistics vendors have no standard payload schema. The same semantic event ("vessel departed") is expressed as `status: "SAILED"`, `event_type: "VD"`, `milestone: "ATD"`, or free-text across carriers. An LLM handles the long tail without per-vendor parsers.

#### System Prompt

Sent on every LLM call (both tiers). Output shape is enforced by `.withStructuredOutput()`, so the "Return this exact shape" block is omitted from the prompt:

```
You are a webhook normalizer for a logistics platform.
Given a raw vendor JSON payload, classify and extract key fields.

Classify into: SHIPMENT, INVOICE, or UNCLASSIFIED.

SHIPMENT statuses (map vendor language to canonical):
  PICKED_UP         — gate-in, container received, released to shipper, empty returned and full received
  IN_TRANSIT        — loaded onboard, vessel sailed, departed, in movement, en route
  OUT_FOR_DELIVERY  — out for delivery, last mile, with courier
  DELIVERED         — delivered, released to consignee, handed to recipient, cargo released

INVOICE statuses:
  ISSUED   — invoice raised, created, sent, generated
  PAID     — settled, paid, cleared, settled in full
  VOIDED   — cancelled, voided
  REFUNDED — refunded, reversed, credit note issued

Rules:
- If a field is not present or cannot be determined, use null.
- For vendor_event_id: prefer explicit event/message IDs; fallback to doc_ref or invoice ref.
- For tracking_id on SHIPMENT: use the container number, tracking number, or primary shipment identifier.
- For tracking_id on INVOICE: use the linked bill of lading, tracking number, or any shipment cross-reference present in the payload.
- For event_time: use the most specific timestamp available, convert to ISO8601.
- For amount_raw: copy the exact string from the payload, do not reformat.
```

The user message is the raw vendor JSON payload stringified. No conversation history is sent — each call is stateless. Output shape is enforced by the provider's tool/function-calling API via LangChain's `.withStructuredOutput()`.

### 4. Status rank guards

Events arrive out of order. A `DELIVERED` event that arrives before `IN_TRANSIT` would otherwise overwrite a later-arriving `IN_TRANSIT` and corrupt the record.

`statusRank` (integer, stored on the row) gates updates: a new event only updates the record if its rank exceeds the stored rank. Both Shipment and Invoice have independent rank tables.

**Trade-off:** A higher-ranked event that arrives first blocks all lower-ranked events permanently, even if the lower-ranked event contains useful fields (carrier, location). Current implementation updates only status/location/eventTime — fields that are meaningfully ordered. Immutable fields (trackingId, invoiceRef, carrier) are set on creation and never overwritten.

### 5. `vendorEventId` as the upsert key

Records are upserted by `vendorEventId` (the vendor's own event identifier), not by tracking number. This means the same shipment tracked by multiple vendors creates multiple rows — one per vendor event — rather than a single merged record.

**Trade-off:** No cross-vendor deduplication of shipment state. The `trackingId` and `invoiceRef.trackingRef` fields provide a soft join surface for query-time grouping, but there is no foreign key relationship between invoices and shipments.

### 6. Raw payload stored alongside normalized fields

Every row stores the original `rawPayload` (JSONB). This means:
- Bugs in normalization logic can be corrected by re-processing stored raws
- The full vendor payload is available for audit or downstream consumers
- No data is lost when a field isn't yet covered by the schema

## Data Model

```
shipments
  id              uuid PK
  vendor_event_id unique — vendor's own event ID
  payload_hash    unique — SHA-256 of raw body (dedup)
  tracking_id     — container number, B/L, or primary shipment ref
  status          — PICKED_UP | IN_TRANSIT | OUT_FOR_DELIVERY | DELIVERED
  status_rank     — rank guard for out-of-order updates
  carrier         — normalized carrier name
  location        — last known location
  event_time      — vendor event timestamp (ISO8601)
  raw_payload     — original JSON

invoices
  id              uuid PK
  vendor_event_id unique
  payload_hash    unique
  invoice_ref     — invoice/document number
  tracking_ref    — B/L or shipment cross-reference (nullable)
  status          — ISSUED | PAID | VOIDED | REFUNDED
  status_rank
  carrier
  amount_raw      — exact amount string from vendor payload
  currency
  event_time
  raw_payload

unclassified
  id              uuid PK
  payload_hash    unique
  raw_payload
  received_at

payload_hashes
  hash PK         — global dedup registry (all event types)
  seen_at
```

## Running Locally

**Requirements:** Node 22, Docker

```bash
# 1. Start database
docker compose up -d

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# edit .env — set the API key for your chosen provider:
#   Anthropic → ANTHROPIC_API_KEY
#   OpenAI    → OPENAI_API_KEY
#   Google    → GOOGLE_API_KEY
# Optionally set LLM_TIER1_MODEL and LLM_TIER2_MODEL (defaults to claude-haiku / claude-sonnet)

# 4. Apply migrations
npx prisma migrate deploy

# 5. Generate Prisma client
npx prisma generate

# 6. Start server
npm run dev
```

Server listens on `http://localhost:3000`.

```bash
# Send a test payload
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d @samples/1_maersk_sailed.json
```

**Endpoints:**
- `POST /webhook` — ingest a raw vendor payload
- `GET /health` — liveness check

## Production Roadmap

### Reliability
- **Dead-letter queue** — pg-boss jobs that exhaust retries silently disappear. A DLQ (separate queue + alerting) lets ops triage and replay failed jobs.
- **Idempotent replay** — re-processing `raw_payload` from the DB is safe today for SHIPMENT/INVOICE (rank guards prevent regression), but UNCLASSIFIED rows have no `vendorEventId` and would re-insert on replay. Add a replay flag or normalize UNCLASSIFIED rows at replay time.
- **Graceful shutdown** — currently `SIGTERM` kills the process mid-job. Add `boss.stop()` + drain logic so in-flight jobs complete before exit.

### Observability
- Structured JSON logging (replace `console.log` with pino/winston)
- Metrics: queue depth, job latency, LLM tier hit rates, dedup rate
- Traces: tie each job's DB and LLM calls to a trace ID for debugging classification errors

### Scale
- **Worker separation** — run HTTP server and worker as separate processes/containers so they scale independently and a worker crash doesn't take the ingestion surface down.
- **Connection pooling** — PgBoss and Prisma each hold their own pool. Under load, add PgBouncer or use a shared pool via a connection proxy.
- **LLM cost control** — cache the full system prompt (consider expanding it to exceed the 4096-token Haiku cache threshold), batch low-urgency payloads, or add a rules-based pre-filter for high-volume well-known vendors.

### Correctness
- **Schema validation** — add Zod validation on LLM output before writing to DB; surface extraction errors rather than silently writing null fields.
- **Cross-vendor shipment merging** — currently one row per vendor event. A matching layer (by B/L number) could merge events from multiple carriers into a single canonical shipment timeline.
- **Currency normalization** — `amount_raw` stores the vendor's exact string. A parse step (ISO 4217 code + decimal amount) would make invoices queryable by amount.

### Security
- **Webhook authentication** — validate HMAC signatures (or bearer tokens) per vendor before enqueuing. Currently any caller can POST to `/webhook`.
- **Rate limiting** — add per-source IP or per-vendor-key rate limits to prevent queue flooding.
- **Secret rotation** — `ANTHROPIC_API_KEY` and `DATABASE_URL` should be managed via a secrets manager (AWS Secrets Manager, Vault) in production, not environment variables baked into deployments.
