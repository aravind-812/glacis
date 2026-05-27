import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client'
import { getBoss } from './boss'
import { normalize } from './normalize'
import { upsert } from './upsert'
import { hashPayload } from './hash'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

// Atomically claim hash after successful processing.
// Returns true if this worker recorded it (new), false if already existed (another worker beat us).
async function recordHash(hash: string): Promise<boolean> {
  const result = await prisma.$queryRaw<{ hash: string }[]>`
    INSERT INTO payload_hashes (hash, seen_at)
    VALUES (${hash}, now())
    ON CONFLICT (hash) DO NOTHING
    RETURNING hash
  `
  return result.length > 0
}

export async function startWorker(): Promise<void> {
  const boss = await getBoss()

  await boss.work<Record<string, unknown>>(
    'webhooks',
    { localConcurrency: 5 },
    async (jobs) => {
      for (const job of jobs) {
        const payload = job.data
        const hash = hashPayload(payload)

        // Fast read check — skips LLM for known duplicates
        // Not atomic, but safe: DB constraints catch any race survivors
        const seen = await prisma.payloadHash.findUnique({ where: { hash } })
        if (seen) {
          console.log(`[worker] job=${job.id} duplicate — discarded`)
          continue
        }

        try {
          const normalized = await normalize(payload)
          await upsert(normalized, payload, hash)
          await recordHash(hash)
          console.log(`[worker] job=${job.id} type=${normalized.type} status=${normalized.status ?? 'n/a'}`)
        } catch (err) {
          // Race: another worker processed same payload between our seen-check and now.
          // If hash is recorded, this is a duplicate — discard instead of retrying.
          const raceCheck = await prisma.payloadHash.findUnique({ where: { hash } })
          if (raceCheck) {
            console.log(`[worker] job=${job.id} duplicate race — discarded`)
            continue
          }
          throw err
        }
      }
    }
  )

  console.log('[worker] listening on queue: webhooks')
}
