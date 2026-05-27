import { createHash } from 'crypto'

function sortKeys(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortKeys)
  if (val !== null && typeof val === 'object') {
    return Object.keys(val as object)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((val as Record<string, unknown>)[k])
        return acc
      }, {})
  }
  return val
}

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortKeys(payload))).digest('hex')
}
