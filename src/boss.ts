import { PgBoss } from 'pg-boss'
import { config } from './config'

let boss: PgBoss | null = null

export async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    boss = new PgBoss(config.DATABASE_URL)
    await boss.start()

    // dead-letter queue must exist before webhooks references it
    await boss.createQueue('webhooks-dead')

    await boss.createQueue('webhooks', {
      retryLimit: 5,
      retryDelay: 30,    // seconds before first retry
      retryBackoff: true, // exponential: 30s → 60s → 120s → 240s → 480s
      deadLetter: 'webhooks-dead',
    })
  }
  return boss
}
