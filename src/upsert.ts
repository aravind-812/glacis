import { PrismaClient } from './generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { NormalizedEvent, SHIPMENT_RANK, INVOICE_RANK, ShipmentStatus, InvoiceStatus } from './types'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

export async function upsert(event: NormalizedEvent, rawPayload: unknown, hash: string): Promise<void> {
  if (event.type === 'SHIPMENT') {
    await upsertShipment(event, rawPayload, hash)
  } else if (event.type === 'INVOICE') {
    await upsertInvoice(event, rawPayload, hash)
  } else {
    await prisma.unclassified.create({
      data: { payloadHash: hash, rawPayload: rawPayload as object },
    })
  }
}

async function upsertShipment(event: NormalizedEvent, rawPayload: unknown, hash: string): Promise<void> {
  if (!event.vendor_event_id || !event.status || !event.tracking_id) return

  const incomingRank = SHIPMENT_RANK[event.status as ShipmentStatus] ?? 0
  const eventTime = event.event_time ? new Date(event.event_time) : new Date()

  const existing = await prisma.shipment.findUnique({
    where: { vendorEventId: event.vendor_event_id },
  })

  if (!existing) {
    await prisma.shipment.create({
      data: {
        vendorEventId: event.vendor_event_id,
        payloadHash: hash,
        trackingId: event.tracking_id,
        status: event.status,
        statusRank: incomingRank,
        carrier: event.carrier,
        location: event.location,
        eventTime,
        rawPayload: rawPayload as object,
      },
    })
    return
  }

  // Rank guard: only update if incoming event is newer in lifecycle
  if (incomingRank > existing.statusRank) {
    await prisma.shipment.update({
      where: { vendorEventId: event.vendor_event_id },
      data: {
        status: event.status,
        statusRank: incomingRank,
        location: event.location,
        eventTime,
      },
    })
  }
}

async function upsertInvoice(event: NormalizedEvent, rawPayload: unknown, hash: string): Promise<void> {
  if (!event.vendor_event_id || !event.status || !event.invoice_ref) return

  const incomingRank = INVOICE_RANK[event.status as InvoiceStatus] ?? 0
  const eventTime = event.event_time ? new Date(event.event_time) : new Date()

  const existing = await prisma.invoice.findUnique({
    where: { vendorEventId: event.vendor_event_id },
  })

  if (!existing) {
    await prisma.invoice.create({
      data: {
        vendorEventId: event.vendor_event_id,
        payloadHash: hash,
        invoiceRef: event.invoice_ref,
        trackingRef: event.tracking_id ?? null,
        status: event.status,
        statusRank: incomingRank,
        carrier: event.carrier,
        amountRaw: event.amount_raw,
        eventTime,
        rawPayload: rawPayload as object,
      },
    })
    return
  }

  if (incomingRank > existing.statusRank) {
    await prisma.invoice.update({
      where: { vendorEventId: event.vendor_event_id },
      data: {
        status: event.status,
        statusRank: incomingRank,
        eventTime,
      },
    })
  }
}
