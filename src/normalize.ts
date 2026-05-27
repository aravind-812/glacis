import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { NormalizedEvent } from './types'
import { config } from './config'

const TIER1_MODEL = config.LLM_TIER1_MODEL
const TIER2_MODEL = config.LLM_TIER2_MODEL

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

Rules:
- If a field is not present or cannot be determined, use null.
- For vendor_event_id: prefer explicit event/message IDs; fallback to doc_ref or invoice ref.
- For tracking_id on SHIPMENT: use the container number, tracking number, or primary shipment identifier.
- For tracking_id on INVOICE: use the linked bill of lading, tracking number, or any shipment cross-reference present in the payload.
- For event_time: use the most specific timestamp available, convert to ISO8601.
- For amount_raw: copy the exact string from the payload, do not reformat.`

const NormalizedEventSchema = z.object({
  type: z.enum(['SHIPMENT', 'INVOICE', 'UNCLASSIFIED']),
  vendor_event_id: z.string().nullable(),
  tracking_id: z.string().nullable(),
  invoice_ref: z.string().nullable(),
  status: z.string().nullable(),
  carrier: z.string().nullable(),
  location: z.string().nullable(),
  event_time: z.string().nullable(),
  amount_raw: z.string().nullable(),
})

async function callModel(modelName: string, payload: unknown): Promise<NormalizedEvent | null> {
  try {
    const messages = [
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(JSON.stringify(payload)),
    ]

    let result: z.infer<typeof NormalizedEventSchema>

    if (modelName.startsWith('claude')) {
      const llm = new ChatAnthropic({ model: modelName })
      result = await llm.withStructuredOutput(NormalizedEventSchema).invoke(messages)
    } else if (modelName.startsWith('gpt') || modelName.startsWith('o1') || modelName.startsWith('o3') || modelName.startsWith('o4')) {
      const llm = new ChatOpenAI({ model: modelName })
      result = await llm.withStructuredOutput(NormalizedEventSchema).invoke(messages)
    } else if (modelName.startsWith('gemini')) {
      const llm = new ChatGoogleGenerativeAI({ model: modelName })
      result = await llm.withStructuredOutput(NormalizedEventSchema).invoke(messages)
    } else {
      throw new Error(`Cannot infer provider for model: ${modelName}`)
    }

    return result as NormalizedEvent
  } catch {
    return null
  }
}

export async function normalize(payload: unknown): Promise<NormalizedEvent> {
  // Tier 1: fast/cheap model
  const tier1 = await callModel(TIER1_MODEL, payload)
  if (tier1 && tier1.type !== 'UNCLASSIFIED' && tier1.vendor_event_id) {
    return tier1
  }

  // Tier 2: capable fallback for ambiguous or unclassified payloads
  const tier2 = await callModel(TIER2_MODEL, payload)
  if (tier2) return tier2

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
