# Galcis — Video Script (~2:30)

---

## Setup (before recording)

```bash
# Terminal 1 — server logs visible
npm run dev

# Terminal 2 — commands
docker exec galcis-postgres-1 psql -U galcis -d galcis \
  -c "TRUNCATE payload_hashes, shipments, invoices, unclassified, dead_letters RESTART IDENTITY CASCADE;"
```

---

## [0:00–0:20] The Problem

> "Galcis ingests webhooks from logistics vendors. Every vendor sends completely different JSON — no standard schema. This service classifies each payload via LLM, normalizes it, and stores it — handling duplicates and out-of-order events without losing data."

**Show:** README architecture diagram

---

## [0:20–2:00] Demo

### 1. Classification — unknown vendor format

```bash
curl -s -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "kn-api",
    "job_ref": "KN-2026-HAM-8841",
    "shipment_stage": "cargo_released_consignee",
    "container_id": "KNLU4412890",
    "delivery_location": "Hamburg Fashion GmbH warehouse",
    "event_timestamp": "2026-05-28T11:00:00+01:00"
  }'
```

**Response:** `{"ok":true}`  
**Log:** `type=SHIPMENT status=DELIVERED`

> "Non-standard vendor, no carrier code. LLM reads `cargo_released_consignee` and maps it to DELIVERED. Sub-second 202 back to the vendor."

---

### 2. Out-of-order — rank guard

```bash
curl -s -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "kn-api",
    "job_ref": "KN-2026-HAM-8841",
    "shipment_stage": "origin_gate_in",
    "container_id": "KNLU4412890",
    "origin_port": "CNSHA",
    "event_timestamp": "2026-05-10T08:15:00+08:00"
  }'
```

**Response:** `{"ok":true}`  
**Log:** `type=SHIPMENT status=PICKED_UP`

```bash
docker exec galcis-postgres-1 psql -U galcis -d galcis \
  -c "SELECT vendor_event_id, status, status_rank FROM shipments;"
```

> "Same job_ref, so same vendor_event_id. PICKED_UP has rank 1, DELIVERED has rank 4 — rank guard blocked the update. DELIVERED preserved."

---

### 3. Duplicate detection

```bash
curl -s -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "kn-api",
    "job_ref": "KN-2026-HAM-8841",
    "shipment_stage": "cargo_released_consignee",
    "container_id": "KNLU4412890",
    "delivery_location": "Hamburg Fashion GmbH warehouse",
    "event_timestamp": "2026-05-28T11:00:00+01:00"
  }'
```

**Response:** `{"ok":true,"duplicate":true}`

> "Exact same payload resent. SHA-256 hash match — discarded at the server before hitting the queue. Zero LLM cost."

---

### 4. Invoice — out-of-order

```bash
# Send PAID first
curl -s -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "billing_system": "freightfinance-pro",
    "document_number": "FFP-2026-Q2-3341",
    "status": "fully_settled",
    "amount_received": "USD 18750.00",
    "payment_date": "2026-06-10T14:22:00Z"
  }'
```

**Log:** `type=INVOICE status=PAID`

```bash
# Then send ISSUED (earlier in lifecycle, arrives late)
curl -s -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "billing_system": "freightfinance-pro",
    "document_number": "FFP-2026-Q2-3341",
    "status": "invoice_raised",
    "raised_at": "2026-05-20T09:00:00Z",
    "amount": "USD 18750.00"
  }'
```

**Log:** `type=INVOICE status=ISSUED`

```bash
docker exec galcis-postgres-1 psql -U galcis -d galcis \
  -c "SELECT vendor_event_id, status, status_rank FROM invoices;"
```

> "PAID arrived first, rank 3. ISSUED arrived late, rank 1 — blocked. Final state is PAID. Works for invoices too."

---

### 5. Unclassified

```bash
curl -s -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "source": "maritime-weather-api",
    "alert_type": "SEVERE_WEATHER",
    "advisory_id": "WEA-2026-NAT-0041",
    "forecast": "Force 8-9 gale, North Atlantic",
    "affected_routes": ["Asia-Europe", "Transatlantic"]
  }'
```

**Log:** `type=UNCLASSIFIED status=n/a`

> "Not a shipment, not an invoice — stored as unclassified. Nothing is dropped."

---

## [2:00–2:30] Key Decisions

**Show:** README Design Decisions table

> "Three things worth calling out. Async queue — 202 back before the LLM finishes, so vendor SLAs are always met. Atomic rank guard — single SQL INSERT ON CONFLICT with a WHERE clause, no race condition under concurrent workers. Two-tier LLM — Haiku handles ~80% of payloads, Sonnet only fires for ambiguous ones. Full trade-offs and production roadmap in the README."

---

## Reset between takes

```bash
docker exec galcis-postgres-1 psql -U galcis -d galcis \
  -c "TRUNCATE payload_hashes, shipments, invoices, unclassified, dead_letters RESTART IDENTITY CASCADE;"
```
