import './config' // validate env at startup — throws if required vars missing
import express from 'express'
import { prisma } from './db'
import { getBoss } from './boss'
import { startWorker } from './worker'
import { hashPayload } from './hash'
import { config } from './config'

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

async function shutdown() {
  console.log('[server] shutting down...')
  const boss = await getBoss()
  await boss.stop()         // drains in-flight jobs before exiting
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

async function main() {
  await startWorker()

  app.listen(config.PORT, () => {
    console.log(`[server] listening on port ${config.PORT}`)
  })
}

main().catch((err) => {
  console.error('[server] fatal:', err)
  process.exit(1)
})
