import Anthropic from '@anthropic-ai/sdk'
import { NormalizedEvent } from './types'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are a webhook normalizer for a logistics platform.
Given a raw vendor JSON payload, return ONLY a valid JSON object. No prose, no markdown, just JSON.

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

Return this exact shape:
{
  "type": "SHIPMENT" | "INVOICE" | "UNCLASSIFIED",
  "vendor_event_id": string,
  "tracking_id": string | null,
  "invoice_ref": string | null,
  "status": string | null,
  "carrier": string | null,
  "location": string | null,
  "event_time": "ISO8601" | null,
  "amount_raw": string | null
}

Rules:
- If a field is not present or cannot be determined, use null.
- For vendor_event_id: prefer explicit event/message IDs; fallback to doc_ref or invoice ref.
- For event_time: use the most specific timestamp available, convert to ISO8601.
- For amount_raw: copy the exact string from the payload, do not reformat.`

async function callClaude(model: string, payload: unknown): Promise<NormalizedEvent | null> {
  try {
    const message = await client.messages.create({
      model,
      max_tokens: 500,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    })

    const text = message.content[0].type === 'text' ? message.content[0].text : null
    if (!text) return null

    const cleaned = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const parsed = JSON.parse(cleaned) as NormalizedEvent
    return parsed
  } catch {
    return null
  }
}

export async function normalize(payload: unknown): Promise<NormalizedEvent> {
  // Tier 1: Haiku (fast, cheap)
  const haiku = await callClaude('claude-haiku-4-5-20251001', payload)

  if (haiku && haiku.type !== 'UNCLASSIFIED' && haiku.vendor_event_id) {
    return haiku
  }

  // Tier 2: Sonnet (ambiguous or missing key field)
  const sonnet = await callClaude('claude-sonnet-4-6', payload)

  if (sonnet) return sonnet

  // Both failed — store raw as unclassified
  return {
    type: 'UNCLASSIFIED',
    vendor_event_id: null,
    tracking_id: null,
    invoice_ref: null,
    status: null,
    carrier: null,
    location: null,
    event_time: null,
    amount_raw: null,
  }
}
