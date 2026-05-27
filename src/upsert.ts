import { prisma } from './db'
import { NormalizedEvent, SHIPMENT_RANK, INVOICE_RANK, ShipmentStatus, InvoiceStatus } from './types'

export async function upsert(event: NormalizedEvent, rawPayload: unknown, hash: string): Promise<boolean> {
  if (event.type === 'SHIPMENT') {
    return upsertShipment(event, rawPayload, hash)
  } else if (event.type === 'INVOICE') {
    return upsertInvoice(event, rawPayload, hash)
  } else {
    await prisma.unclassified.create({
      data: { payloadHash: hash, rawPayload: rawPayload as object },
    })
    return true
  }
}

async function upsertShipment(event: NormalizedEvent, rawPayload: unknown, hash: string): Promise<boolean> {
  if (!event.vendor_event_id || !event.status || !event.tracking_id) return false

  const statusRank = SHIPMENT_RANK[event.status as ShipmentStatus] ?? 0
  const eventTime = event.event_time ? new Date(event.event_time) : new Date()
  const rawJson = JSON.stringify(rawPayload)

  const affected = await prisma.$executeRaw`
    INSERT INTO shipments
      (id, vendor_event_id, payload_hash, tracking_id, status, status_rank,
       carrier, location, event_time, raw_payload, created_at, updated_at)
    VALUES (
      gen_random_uuid(),
      ${event.vendor_event_id},
      ${hash},
      ${event.tracking_id},
      ${event.status},
      ${statusRank},
      ${event.carrier ?? null},
      ${event.location ?? null},
      ${eventTime},
      ${rawJson}::jsonb,
      now(),
      now()
    )
    ON CONFLICT (vendor_event_id) DO UPDATE SET
      status      = EXCLUDED.status,
      status_rank = EXCLUDED.status_rank,
      location    = EXCLUDED.location,
      event_time  = EXCLUDED.event_time,
      updated_at  = now()
    WHERE shipments.status_rank < EXCLUDED.status_rank
  `
  return affected > 0
}

async function upsertInvoice(event: NormalizedEvent, rawPayload: unknown, hash: string): Promise<boolean> {
  if (!event.vendor_event_id || !event.status || !event.invoice_ref) return false

  const statusRank = INVOICE_RANK[event.status as InvoiceStatus] ?? 0
  const eventTime = event.event_time ? new Date(event.event_time) : new Date()
  const rawJson = JSON.stringify(rawPayload)

  const affected = await prisma.$executeRaw`
    INSERT INTO invoices
      (id, vendor_event_id, payload_hash, invoice_ref, tracking_ref, status, status_rank,
       carrier, amount_raw, event_time, raw_payload, created_at, updated_at)
    VALUES (
      gen_random_uuid(),
      ${event.vendor_event_id},
      ${hash},
      ${event.invoice_ref},
      ${event.tracking_id ?? null},
      ${event.status},
      ${statusRank},
      ${event.carrier ?? null},
      ${event.amount_raw ?? null},
      ${eventTime},
      ${rawJson}::jsonb,
      now(),
      now()
    )
    ON CONFLICT (vendor_event_id) DO UPDATE SET
      status      = EXCLUDED.status,
      status_rank = EXCLUDED.status_rank,
      event_time  = EXCLUDED.event_time,
      updated_at  = now()
    WHERE invoices.status_rank < EXCLUDED.status_rank
  `
  return affected > 0
}
