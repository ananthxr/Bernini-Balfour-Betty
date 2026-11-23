// Road snapping via OSRM /match. Chunks of ≤OSRM_MAX_POINTS (1-point overlap), serialised at ≤1 req/s,
// results cached in memory. Low-confidence or unmatched stretches are reported so the caller can
// keep drawing them as honest straight dashes.
import { OSRM_URL, OSRM_MIN_CONFIDENCE, OSRM_MAX_POINTS } from './config.js'
import { isNum } from './format.js'

const MAX_POINTS = OSRM_MAX_POINTS
export const CHUNK_STEP = MAX_POINTS - 1
const MIN_GAP_MS = 1100
const cache = new Map()
let chain = Promise.resolve()
let lastAt = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const radius = (sats) => (!isNum(sats) ? 25 : sats >= 8 ? 15 : sats >= 6 ? 25 : 40)

function throttled(fn) {
  const run = chain.then(async () => {
    const wait = lastAt + MIN_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastAt = Date.now()
    return fn()
  })
  chain = run.catch(() => {})
  return run
}

/** Split into ≤MAX_POINTS chunks sharing their boundary point, so every consecutive pair lives in one chunk. */
export function chunk(points) {
  const out = []
  for (let i = 0; i < points.length - 1; i += CHUNK_STEP) out.push(points.slice(i, i + MAX_POINTS))
  return out
}

/**
 * @returns {Promise<{ok:boolean, lines:Array<{latlngs:number[][], confidence:number}>, pairCovered:boolean[], error?:string}>}
 * pairCovered[k] is true when points k and k+1 were both matched into the same kept matching.
 */
export async function matchChunk(pts, { signal } = {}) {
  const coords = pts.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';')
  if (cache.has(coords)) return cache.get(coords)

  const ts = []
  for (const p of pts) {
    const s = Math.round(p.t / 1000)
    ts.push(ts.length && s <= ts[ts.length - 1] ? ts[ts.length - 1] + 1 : s)
  }
  const url = `${OSRM_URL}/match/v1/driving/${coords}?overview=full&geometries=geojson&gaps=split&tidy=false`
    + `&timestamps=${ts.join(';')}&radiuses=${pts.map((p) => radius(p.sats)).join(';')}`

  const none = (error) => ({ ok: false, lines: [], pairCovered: pts.slice(1).map(() => false), error })
  let res
  try {
    res = await throttled(() => (signal?.aborted ? Promise.reject(new DOMException('aborted', 'AbortError')) : fetch(url, { signal })))
  } catch (e) {
    if (e.name === 'AbortError') throw e
    return none('network')
  }
  if (res.status === 429) return none('rate-limited')
  let body
  try { body = await res.json() } catch { return none(`http ${res.status}`) }

  if (body.code !== 'Ok' || !Array.isArray(body.matchings)) {
    const r = none(body.code || `http ${res.status}`)
    if (body.code === 'NoMatch' || body.code === 'NoSegment') cache.set(coords, r) // deterministic: don't retry
    return r
  }

  const keep = new Set()
  const lines = []
  body.matchings.forEach((m, i) => {
    if ((m.confidence ?? 0) >= OSRM_MIN_CONFIDENCE) {
      keep.add(i)
      lines.push({ latlngs: m.geometry.coordinates.map(([x, y]) => [y, x]), confidence: m.confidence })
    }
  })
  const tp = body.tracepoints || []
  const pairCovered = pts.slice(1).map((_, k) => {
    const a = tp[k]
    const b = tp[k + 1]
    return !!a && !!b && a.matchings_index === b.matchings_index && keep.has(a.matchings_index)
  })
  const r = { ok: lines.length > 0, lines, pairCovered }
  cache.set(coords, r)
  return r
}
