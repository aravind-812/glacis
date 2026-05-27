import { JobWithMetadata } from 'pg-boss'
import { prisma } from './db'
import { getBoss } from './boss'
import { normalize } from './normalize'
import { upsert } from './upsert'
import { hashPayload } from './hash'

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

  // Write permanently-failed jobs to dead_letters for visibility and manual replay
  await boss.work<Record<string, unknown>>(
    'webhooks-dead',
    { includeMetadata: true },
    async (jobs) => {
      for (const job of jobs as JobWithMetadata<Record<string, unknown>>[]) {
        await prisma.deadLetter.create({
          data: {
            jobId: job.id,
            payload: job.data as object,
            error: job.output ? JSON.stringify(job.output) : null,
            retryCount: job.retryCount,
          },
        })
        console.error(`[worker] job=${job.id} dead-lettered after ${job.retryCount} retries`)
      }
    }
  )

  console.log('[worker] listening on queue: webhooks')
}
