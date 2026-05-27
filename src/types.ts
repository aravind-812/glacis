export type ShipmentStatus = 'PICKED_UP' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED'
export type InvoiceStatus = 'ISSUED' | 'PAID' | 'VOIDED' | 'REFUNDED'
export type EventType = 'SHIPMENT' | 'INVOICE' | 'UNCLASSIFIED'

export const SHIPMENT_RANK: Record<ShipmentStatus, number> = {
  PICKED_UP: 1,
  IN_TRANSIT: 2,
  OUT_FOR_DELIVERY: 3,
  DELIVERED: 4,
}

export const INVOICE_RANK: Record<InvoiceStatus, number> = {
  ISSUED: 1,
  PAID: 2,
  VOIDED: 2,
  REFUNDED: 3,
}

export interface NormalizedEvent {
  type: EventType
  vendor_event_id: string | null
  tracking_id: string | null
  invoice_ref: string | null
  status: string | null
  carrier: string | null
  location: string | null
  event_time: string | null
  amount_raw: string | null
}
