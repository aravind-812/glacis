# Video Walkthrough Script — Galcis

**Total time: ~2:30**

---

## Before You Record

```bash
# 1. Start server (keep logs visible — split terminal)
npm run dev

# 2. Import Postman collection
#    File → Import → demo/galcis_postman_collection.json

# 3. Clean DB (run between takes too)
docker exec galcis-postgres-1 psql -U galcis -d galcis \
  -c "TRUNCATE payload_hashes, shipments, invoices, unclassified, dead_letters RESTART IDENTITY CASCADE;"
```

---

## Segment 1 — The Problem (0:00–0:20)

**Show:** README open in browser

> "Galcis is a webhook ingestion service for a logistics platform. The problem: dozens of vendors send real-time updates — shipments, invoices — but every vendor has a completely different JSON structure with no standard schema. This service accepts any payload, uses an LLM to classify and normalize it, and persists it reliably — handling duplicates and out-of-order events."

---

## Segment 2 — Architecture (0:20–0:50)

**Show:** README request flow diagram

> "The flow: vendor POSTs to /webhook, we hash the payload and return 202 immediately — sub-second acknowledgment. The job goes into a pg-boss queue, a background worker picks it up, runs it through a two-tier LLM — Haiku first for speed, Sonnet as fallback — normalizes to a canonical schema, and writes to Postgres. Two things that break in prod: duplicate payloads and out-of-order events. I'll show both."

---

## Segment 3 — Live Demo in Postman (0:50–2:10)

> Run all requests from the Postman collection. Server logs visible on screen.

---

### Request 1 — Health Check

**Postman:** `GET /health`  
**Expected:** `{"ok":true}`

> "Server is up."

---

### Request 2 — SHIPMENT — KN Delivered

**Postman:** `POST /webhook` — KN Delivered payload

```json
{
  "provider": "kn-api",
  "job_ref": "KN-2026-HAM-8841",
  "shipment_stage": "cargo_released_consignee",
  "container_id": "KNLU4412890",
  "delivery_location": "Hamburg Fashion GmbH warehouse, Gate 4",
  "event_timestamp": "2026-05-28T11:00:00+01:00",
  "signed_by": "M. Fischer"
}
```

**Expected response:** `{"ok":true}`  
**Worker log:** `type=SHIPMENT status=DELIVERED`

> "Completely non-standard vendor format — no standard field names, no carrier code. The LLM reads `cargo_released_consignee` and maps it to DELIVERED. 202 back in under a second."

---

### Request 3 — SHIPMENT — KN Picked Up (out-of-order)

**Postman:** `POST /webhook` — KN Picked Up payload

```json
{
  "provider": "kn-api",
  "job_ref": "KN-2026-HAM-8841",
  "shipment_stage": "origin_gate_in",
  "container_id": "KNLU4412890",
  "origin_port": "CNSHA",
  "event_timestamp": "2026-05-10T08:15:00+08:00",
  "shipper": "Shanghai Textiles Co.",
  "consignee": "Hamburg Fashion GmbH"
}
```

**Expected response:** `{"ok":true}`  
**Worker log:** `type=SHIPMENT status=PICKED_UP`

Then query DB:
```bash
docker exec galcis-postgres-1 psql -U galcis -d galcis \
  -c "SELECT vendor_event_id, status, status_rank FROM shipments;"
```

> "Same job_ref — same vendor_event_id — so both events map to the same row. PICKED_UP has rank 1, DELIVERED has rank 4. The rank guard blocked the update — DELIVERED is preserved even though PICKED_UP arrived after it. That's the atomic SQL doing its job."

---

### Request 4 — DUPLICATE detection

**Postman:** `POST /webhook` — resend KN Delivered (same body as request 2)

**Expected response:** `{"ok":true,"duplicate":true}`

> "Same payload, same SHA-256 hash — caught at the server before it hits the queue. No LLM call, no DB write, no retry."

---

### Request 5 — INVOICE — FreightFinance Paid

**Postman:** `POST /webhook` — FFP Paid payload

```json
{
  "billing_system": "freightfinance-pro",
  "document_number": "FFP-2026-Q2-3341",
  "status": "fully_settled",
  "amount_received": "USD 18750.00",
  "payment_method": "SWIFT",
  "payment_date": "2026-06-10T14:22:00Z"
}
```

**Worker log:** `type=INVOICE status=PAID`

> "Invoice vendor — different system entirely. `fully_settled` maps to PAID."

---

### Request 6 — INVOICE — FreightFinance Issued (out-of-order)

**Postman:** `POST /webhook` — FFP Issued payload

```json
{
  "billing_system": "freightfinance-pro",
  "document_number": "FFP-2026-Q2-3341",
  "status": "invoice_raised",
  "raised_at": "2026-05-20T09:00:00Z"
}
```

**Worker log:** `type=INVOICE status=ISSUED`

Then query:
```bash
docker exec galcis-postgres-1 psql -U galcis -d galcis \
  -c "SELECT vendor_event_id, status, status_rank FROM invoices;"
```

> "PAID (rank 3) already stored. ISSUED (rank 1) arrived late — blocked. Final state is PAID. Same document, correct lifecycle."

---

### Request 7 — UNCLASSIFIED

**Postman:** `POST /webhook` — Weather Alert payload

```json
{
  "source": "maritime-weather-api",
  "alert_type": "SEVERE_WEATHER",
  "forecast": "Force 8-9 gale conditions, North Atlantic",
  "affected_routes": ["Asia-Europe string", "Transatlantic"]
}
```

**Worker log:** `type=UNCLASSIFIED status=n/a`

> "Not a shipment, not an invoice — stored as unclassified for manual triage. Nothing is dropped."

---

## Segment 4 — Key Decisions (2:10–2:30)

**Show:** README Design Decisions table

> "Three things worth calling out. Async queue — 202 back before the LLM finishes, so vendor SLAs are met. Atomic rank guard — single SQL INSERT ON CONFLICT with a WHERE clause, no read-then-write race under concurrent workers. Two-tier LLM — Haiku handles about 80% of payloads, Sonnet only fires for ambiguous ones, keeping cost low. Full trade-offs and production roadmap are in the README."

---

## Recording Checklist

- [ ] Import `demo/galcis_postman_collection.json` into Postman before recording
- [ ] Split screen: Postman on left, terminal with server logs on right
- [ ] Font size ≥ 16 in terminal
- [ ] `clear` terminal before each major step
- [ ] Pause 2 seconds after each response — let the viewer read it
- [ ] DB query terminal ready to paste, don't type live

## Reset Between Takes

```bash
docker exec galcis-postgres-1 psql -U galcis -d galcis \
  -c "TRUNCATE payload_hashes, shipments, invoices, unclassified, dead_letters RESTART IDENTITY CASCADE;"
```
