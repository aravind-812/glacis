import { PgBoss } from 'pg-boss'

let boss: PgBoss | null = null

export async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    boss = new PgBoss(process.env.DATABASE_URL!)
    await boss.start()
    await boss.createQueue('webhooks', {
      retryLimit: 5,
      retryDelay: 30,    // seconds before first retry
      retryBackoff: true // exponential: 30s → 60s → 120s → 240s → 480s
    })
  }
  return boss
}
