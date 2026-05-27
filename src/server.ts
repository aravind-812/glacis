import 'dotenv/config'
import express from 'express'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client'
import { getBoss } from './boss'
import { startWorker } from './worker'
import { hashPayload } from './hash'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

const app = express()
app.use(express.json())

app.post('/webhook', async (req, res) => {
  const payload = req.body

  if (!payload || typeof payload !== 'object') {
    res.status(400).json({ error: 'Invalid JSON body' })
    return
  }

  try {
    const hash = hashPayload(payload)

    // Best-effort read: filters obvious duplicates before queuing.
    // Not the source of truth — worker's atomic INSERT after success is.
    const seen = await prisma.payloadHash.findUnique({ where: { hash } })
    if (seen) {
      res.status(202).json({ ok: true, duplicate: true })
      return
    }

    const boss = await getBoss()
    await boss.send('webhooks', payload)
    res.status(202).json({ ok: true })
  } catch (err) {
    console.error('[server] enqueue failed:', err)
    res.status(503).json({ error: 'Queue unavailable' })
  }
})

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

async function main() {
  await startWorker()

  const port = process.env.PORT ?? 3000
  app.listen(port, () => {
    console.log(`[server] listening on port ${port}`)
  })
}

main().catch((err) => {
  console.error('[server] fatal:', err)
  process.exit(1)
})
