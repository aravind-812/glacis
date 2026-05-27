import 'dotenv/config'
import { z } from 'zod'

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().default(3000),
  LLM_TIER1_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  LLM_TIER2_MODEL: z.string().default('claude-sonnet-4-6'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
})

export const config = ConfigSchema.parse(process.env)
