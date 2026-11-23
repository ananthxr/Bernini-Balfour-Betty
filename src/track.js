// Route model: moving segments (split at gaps > 5 min) + stops (dwell periods).
//
//  v2 data (is_moving present):  route = moving rows (route_points view or same filter client-side),
//                                stops = stops view, or consecutive parked rows collapsed.
//  legacy (is_moving null):      motion is ESTIMATED from GPS (stay-point detection) — flagged legacy.
//
// Pure functions; no Leaflet here.
import { TRACK, STALE_MS } from './config.js'
import { hasFix, isNum, validLatLng } from './format.js'

const RAD = Math.PI / 180

export function distM(a, b) {
  const dLat = (b.lat - a.lat) * RAD
  const dLng = (b.lng - a.lng) * RAD
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** Confidence class for a track point: HDOP when present, satellite count otherwise. */
export function quality(p) {
  if (isNum(p?.hdop)) return p.hdop <= 1.2 ? 'good' : p.hdop <= 2 ? 'fair' : 'poor'
  if (isNum(p?.sats)) return p.sats >= 8 ? 'good' : p.sats >= 6 ? 'fair' : 'poor'
  return 'fair'
}

const toPoint = (r) => ({
  lat: r.lat, lng: r.lng, t: Date.parse(r.recorded_at), sats: r.sats, hdop: r.hdop, heading: r.heading, row: r,
})

/** Split time-ordered points wherever consecutive points are more than maxGapMs apart. */
export function splitSegments(points, maxGapMs = TRACK.gapSplitMs) {
  const segs = []
  let cur = []
  for (let i = 0; i < points.length; i++) {
    if (i && points[i].t - points[i - 1].t > maxGapMs) { if (cur.length > 1) segs.push(cur); cur = [] }
    cur.push(points[i])
  }
  if (cur.length > 1) segs.push(cur)
  return segs
}

const STOP_MAX_OFFSET_M = 1000      // a stop this far from where the route arrived/left is implausible
const STOP_REF_WINDOW_MS = 30 * 60e3

/**
 * Parked positions come from an on-device running average, which can be wrong (seen: lat/lng scaled
 * ×2–5). Moving fixes are trustworthy. If a stop is missing a position, or sits > 1 km from both the
 * route point just before arrival and just after departure, place it at that route point instead.
 */
function sanitizeStops(stops, moving) {
  const out = []
  for (const s of stops) {
    const before = findLast(moving, (p) => p.t <= s.start && s.start - p.t <= STOP_REF_WINDOW_MS)
    const end = s.end ?? s.start
    const after = moving.find((p) => p.t >= end && p.t - end <= STOP_REF_WINDOW_MS)
    const refs = [before, after].filter(Boolean)
    const valid = validLatLng(s.lat, s.lng)
    if (refs.length && (!valid || Math.min(...refs.map((p) => distM(s, p))) > STOP_MAX_OFFSET_M)) {
      const p = before || after
      out.push({ ...s, lat: p.lat, lng: p.lng, fromRoute: true })
    } else if (valid) out.push(s)
  }
  return out
}

function findLast(arr, fn) {
  for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return arr[i]
  return undefined
}

/**
 * Where the container was at time t, from the CLEAN track (never from raw parked fixes):
 * inside a stop → the stop; inside a moving segment → interpolated between route points;
 * within 2 min of a segment end → that end. null if unknown.
 */
export function positionAt(track, t) {
  if (!track || !isNum(t)) return null
  for (const s of track.stops) {
    if (t >= s.start - 60e3 && t <= (s.end ?? (s.open ? Infinity : s.start)) + 60e3) return { lat: s.lat, lng: s.lng, kind: 'parked' }
  }
  for (const seg of track.segments) {
    const a = seg[0]
    const b = seg[seg.length - 1]
    if (t < a.t - 120e3 || t > b.t + 120e3) continue
    if (t <= a.t) return { lat: a.lat, lng: a.lng, kind: 'moving' }
    if (t >= b.t) return { lat: b.lat, lng: b.lng, kind: 'moving' }
    let lo = 0
    let hi = seg.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (seg[mid].t <= t) lo = mid
      else hi = mid
    }
    const p = seg[lo]
    const q = seg[hi]
    const u = q.t > p.t ? (t - p.t) / (q.t - p.t) : 0
    return { lat: p.lat + (q.lat - p.lat) * u, lng: p.lng + (q.lng - p.lng) * u, kind: 'moving' }
  }
  return null
}

function finish(moving, rawStops, extra = {}) {
  const stops = sanitizeStops(rawStops, moving)
  const ends = [
    ...moving.map((p) => ({ lat: p.lat, lng: p.lng, t: p.t })),
    ...stops.map((s) => ({ lat: s.lat, lng: s.lng, t: s.start })),
    ...stops.map((s) => ({ lat: s.lat, lng: s.lng, t: s.end ?? s.start })),
  ].sort((a, b) => a.t - b.t)
  return {
    segments: splitSegments(moving),
    stops,
    moving,
    kept: moving.length + stops.length,
    firstPoint: ends[0],
    lastPoint: ends[ends.length - 1],
    legacy: false,
    ...extra,
  }
}

/** v2 History: route_points rows + stops view rows. */
export function buildFromViews(routeRows, stopRows) {
  const moving = routeRows.filter(hasFix).map(toPoint).sort((a, b) => a.t - b.t)
  const stops = stopRows
    .filter((s) => s.arrived_at)
    .map((s) => ({
      lat: s.lat, lng: s.lng,
      start: Date.parse(s.arrived_at),
      end: s.departed_at ? Date.parse(s.departed_at) : null,
      open: !s.departed_at,
      count: s.sample_count,
    }))
    .sort((a, b) => a.start - b.start)
  return finish(moving, stops)
}

/** Raw readings → track. Uses is_moving when present, the legacy GPS estimate otherwise. */
export function buildFromReadings(rows) {
  const sorted = [...rows].sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at))
  const withMotion = sorted.filter((r) => r.is_moving === true || r.is_moving === false)
  if (!withMotion.length) return buildLegacy(sorted)

  const moving = withMotion
    .filter((r) => r.is_moving && hasFix(r)
      && (!isNum(r.hdop) || r.hdop <= TRACK.maxHdop) && (!isNum(r.sats) || r.sats >= TRACK.minSats))
    .map(toPoint)

  // Consecutive parked rows (no moving row between, no gap > 2 parked intervals) → one stop.
  const stops = []
  let run = null
  const close = () => {
    if (run) {
      const n = run.pts.length // no fixes → position filled from the route by sanitizeStops (or dropped)
      stops.push({
        lat: n ? run.pts.reduce((s, p) => s + p.lat, 0) / n : null,
        lng: n ? run.pts.reduce((s, p) => s + p.lng, 0) / n : null,
        start: run.start, end: run.end, count: run.rows, open: false,
      })
    }
    run = null
  }
  for (const r of withMotion) {
    const t = Date.parse(r.recorded_at)
    if (r.is_moving) { close(); continue }
    if (run && t - run.end > 12 * 60e3) close()
    if (!run) run = { pts: [], start: t, end: t, rows: 0 }
    run.end = t
    run.rows++
    if (hasFix(r)) run.pts.push({ lat: r.lat, lng: r.lng })
  }
  const lastParked = withMotion[withMotion.length - 1]?.is_moving === false
  close()
  if (lastParked && stops.length) stops[stops.length - 1].open = true
  return finish(moving, stops)
}

// ---------------------------------------------------------------- legacy (is_moving null)
function buildLegacy(rows) {
  const L = TRACK.legacy
  const pts = rows.filter((r) => hasFix(r) && !(isNum(r.sats) && r.sats < L.minSats)).map(toPoint)
  const moving = []
  const stops = []
  for (const session of splitSessions(pts)) {
    for (const item of detectStops(session)) {
      if (item.stop) stops.push(item.stop)
      else moving.push(item.p)
    }
  }
  // Thin jitter on the estimated moving points (v2 data never needs this).
  const thinned = []
  for (const p of moving) {
    const last = thinned[thinned.length - 1]
    if (last && p.t - last.t <= TRACK.gapSplitMs && distM(last, p) < L.minStepM) continue
    thinned.push(p)
  }
  // Only call an estimated stop "ongoing" if the device is still reporting.
  const last = pts[pts.length - 1]
  const lastStop = stops[stops.length - 1]
  if (lastStop && last && lastStop.end === last.t && Date.now() - last.t < STALE_MS.unknown) lastStop.open = true
  return finish(thinned, stops, { legacy: true })
}

function splitSessions(pts) {
  const out = []
  for (let i = 0; i < pts.length; i++) {
    if (!i || pts[i].t - pts[i - 1].t > TRACK.gapSplitMs) out.push([])
    out[out.length - 1].push(pts[i])
  }
  return out
}

/** Stay-point detection with a running centroid and a small outlier tolerance. */
function detectStops(p) {
  const L = TRACK.legacy
  const out = []
  let i = 0
  while (i < p.length) {
    let cLat = p[i].lat
    let cLng = p[i].lng
    let k = 1
    let lastIn = i
    let outs = 0
    for (let j = i + 1; j < p.length; j++) {
      if (distM({ lat: cLat, lng: cLng }, p[j]) <= L.stopRadiusM) {
        k++
        cLat += (p[j].lat - cLat) / k
        cLng += (p[j].lng - cLng) / k
        lastIn = j
        outs = 0
      } else if (++outs > L.outlierTolerance) break
    }
    if (lastIn > i && p[lastIn].t - p[i].t >= L.stopMinMs) {
      const stop = { lat: cLat, lng: cLng, start: p[i].t, end: p[lastIn].t, count: lastIn - i + 1, open: false }
      const prev = out[out.length - 1]
      if (prev?.stop && distM(prev.stop, stop) <= L.stopRadiusM * 2) {
        const a = prev.stop
        const n = a.count + stop.count
        a.lat = (a.lat * a.count + stop.lat * stop.count) / n
        a.lng = (a.lng * a.count + stop.lng * stop.count) / n
        a.count = n
        a.end = stop.end
      } else out.push({ stop })
      i = lastIn + 1
    } else {
      out.push({ p: p[i] })
      i++
    }
  }
  return out
}

/** Douglas–Peucker on a local metric projection. Returns indices of the points to keep. */
export function simplifyIdx(pts, tolM) {
  const n = pts.length
  if (n <= 2) return pts.map((_, i) => i)
  const k = Math.cos(pts[0].lat * RAD) * 6371000 * RAD
  const xy = pts.map((p) => [p.lng * k, p.lat * 6371000 * RAD])
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const [ax, ay] = xy[a]
    const dx = xy[b][0] - ax
    const dy = xy[b][1] - ay
    const len2 = dx * dx + dy * dy
    let maxD = -1
    let idx = -1
    for (let i = a + 1; i < b; i++) {
      const px = xy[i][0] - ax
      const py = xy[i][1] - ay
      const tt = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0
      const d = Math.hypot(px - tt * dx, py - tt * dy)
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > tolM) { keep[idx] = 1; stack.push([a, idx], [idx, b]) }
  }
  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i)
  return out
}
