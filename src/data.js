// Data access. Two interchangeable sources with the same interface:
//   - Supabase (real): column-limited, time-bounded, capped queries on readings + the v2 views,
//     and the Realtime INSERT stream.
//   - Demo: deterministic simulated tracker following the v2 model, used only without a key.
import { createClient } from '@supabase/supabase-js'
import {
  SUPABASE_URL, SUPABASE_KEY, DEMO, SERIES_COLUMNS, ROUTE_COLUMNS, STOP_COLUMNS, EVENT_COLUMNS, TILT_ALARM_DEG,
} from './config.js'
import { MOUNT_ACTIVE, correctRow, eventPitchBound } from './mount.js'
import { isTiltEvent } from './format.js'

const PAGE = 1000        // Supabase default max rows per request
const ID_CHUNK = 400     // ids per `in.(...)` filter — keeps URLs ~3 KB
const MAX_PROBE_IDS = 6000
const iso = (ms) => new Date(ms).toISOString()

async function pool(tasks, limit = 4) {
  const out = new Array(tasks.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i]() }
  }))
  return out
}

function must({ data, error, count }) {
  if (error) throw new Error(error.message || String(error))
  return { data, count }
}

/** Always order by GPS time — rows can arrive late, in bursts, out of id order (brief §4). */
function dedupeSort(rows) {
  const seen = new Map()
  for (const r of rows) seen.set(r.id ?? `${r.recorded_at}`, r)
  return [...seen.values()].sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at) || (a.id ?? 0) - (b.id ?? 0))
}

// --------------------------------------------------------------------------------------------
function supabaseSource() {
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const ranged = (q, deviceId, from, to) =>
    q.eq('device_id', deviceId).gte('recorded_at', iso(from)).lte('recorded_at', iso(to))

  /**
   * Rows of `table` in [from, to]. If more than `cap` exist, sample evenly: probe ids at a fixed
   * stride between the first and last id in range. Only ~cap rows ever cross the wire.
   */
  async function sampled(table, columns, deviceId, from, to, cap) {
    const { count } = must(await ranged(sb.from(table).select('id', { count: 'exact', head: true }), deviceId, from, to))
    const total = count || 0
    if (!total) return { rows: [], total: 0, stride: 1 }

    if (total <= cap) {
      const pages = Math.ceil(total / PAGE)
      const res = await pool(Array.from({ length: pages }, (_, p) => async () =>
        must(await ranged(sb.from(table).select(columns), deviceId, from, to)
          .order('id', { ascending: true }).range(p * PAGE, p * PAGE + PAGE - 1)).data))
      return { rows: dedupeSort(res.flat()), total, stride: 1 }
    }

    const edge = async (asc) =>
      must(await ranged(sb.from(table).select('id'), deviceId, from, to)
        .order('id', { ascending: asc }).limit(1).maybeSingle()).data
    const [first, last] = await Promise.all([edge(true), edge(false)])
    if (!first || !last) return { rows: [], total, stride: 1 }

    const span = last.id - first.id + 1
    const density = total / span // < 1 when other devices / filtered rows interleave ids
    const probes = Math.min(MAX_PROBE_IDS, Math.ceil(cap / Math.max(density, 1e-6)))
    const step = span / probes
    const ids = new Set()
    for (let i = 0; i < probes; i++) ids.add(first.id + Math.round(i * step))
    ids.add(last.id)
    const list = [...ids]
    const chunks = []
    for (let i = 0; i < list.length; i += ID_CHUNK) chunks.push(list.slice(i, i + ID_CHUNK))

    const res = await pool(chunks.map((c) => async () =>
      must(await sb.from(table).select(columns).eq('device_id', deviceId).in('id', c)).data))
    const rows = dedupeSort(res.flat())
    return { rows, total, stride: rows.length ? total / rows.length : 1 }
  }

  return {
    demo: false,

    async listDevices() {
      const { data } = must(await sb.from('latest_readings').select('device_id').order('device_id'))
      return [...new Set((data || []).map((r) => r.device_id))]
    },

    async getLatest(deviceId) {
      const { data } = must(await sb.from('latest_readings').select('*').eq('device_id', deviceId).maybeSingle())
      return data
    },

    getSeries: (deviceId, from, to, cap) => sampled('readings', SERIES_COLUMNS, deviceId, from, to, cap),
    getRoute: (deviceId, from, to, cap) => sampled('route_points', ROUTE_COLUMNS, deviceId, from, to, cap),

    /** Stops overlapping [from, to] (an ongoing stop may have departed_at null). */
    async getStops(deviceId, from, to) {
      const { data } = must(await sb.from('stops').select(STOP_COLUMNS).eq('device_id', deviceId)
        .lte('arrived_at', iso(to)).or(`departed_at.gte.${iso(from)},departed_at.is.null`)
        .order('arrived_at', { ascending: true }).limit(1000))
      return data || []
    },

    async getLatestStop(deviceId) {
      const { data } = must(await sb.from('stops').select(STOP_COLUMNS).eq('device_id', deviceId)
        .order('arrived_at', { ascending: false }).limit(1).maybeSingle())
      return data
    },

    async getEvents(deviceId, from, to, offset, limit) {
      const { data, count } = must(await ranged(sb.from('tilt_events').select(EVENT_COLUMNS, { count: 'exact' }), deviceId, from, to)
        .order('recorded_at', { ascending: false }).range(offset, offset + limit - 1))
      return { rows: data || [], total: count || 0 }
    },

    async countEvents(deviceId, from, to) {
      const { count } = must(await ranged(sb.from('tilt_events').select('id', { count: 'exact', head: true }), deviceId, from, to))
      return count || 0
    },

    /** Raw readings whose pitch passes a mount-derived bound — candidates for tilt events (newest first). */
    async getTiltCandidates(deviceId, from, to, bound, cap = 5000) {
      const cols = 'id,recorded_at,roll,pitch,lat,lng,gps_valid,is_moving'
      const out = []
      for (let off = 0; off < cap; off += PAGE) {
        const { data } = must(await ranged(sb.from('readings').select(cols), deviceId, from, to)
          .filter('pitch', bound.op, bound.value)
          .order('recorded_at', { ascending: false }).range(off, Math.min(cap, off + PAGE) - 1))
        out.push(...(data || []))
        if (!data || data.length < PAGE) break
      }
      return out
    },

    /** Backfill after a Realtime gap. */
    async getSince(deviceId, sinceMs) {
      const { data } = must(await sb.from('readings').select(SERIES_COLUMNS).eq('device_id', deviceId)
        .gt('recorded_at', iso(sinceMs)).order('recorded_at', { ascending: true }).limit(1000))
      return data || []
    },

    /** Realtime INSERT stream with exponential-backoff reconnect. */
    subscribe({ onRow, onStatus }) {
      let channel = null
      let gen = 0
      let retry = 0
      let timer = null
      let closed = false
      let everLive = false

      const connect = () => {
        onStatus({ state: 'connecting' })
        const ch = sb.channel(`readings-live-${++gen}`)
        channel = ch
        ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'readings' }, (p) => onRow(p.new))
          .subscribe((status, err) => {
            if (closed || ch !== channel) return
            if (status === 'SUBSCRIBED') {
              onStatus({ state: 'live', reconnected: everLive })
              everLive = true
              retry = 0
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              scheduleRetry(err)
            }
          })
      }
      const scheduleRetry = (err) => {
        if (timer || closed) return
        const delay = Math.min(30000, 1000 * 2 ** retry++)
        onStatus({ state: 'down', retryAt: Date.now() + delay, error: err?.message })
        timer = setTimeout(reconnectNow, delay)
      }
      const reconnectNow = () => {
        clearTimeout(timer)
        timer = null
        const old = channel
        channel = null
        if (old) sb.removeChannel(old)
        if (!closed) connect()
      }
      const onOnline = () => { if (timer) reconnectNow() }
      window.addEventListener('online', onOnline)
      connect()
      return () => {
        closed = true
        clearTimeout(timer)
        window.removeEventListener('online', onOnline)
        if (channel) sb.removeChannel(channel)
      }
    },
  }
}

// --------------------------------------------------------------------------------------------
// Demo: a tracker shuttling between two terminals in the Port of Rotterdam, following the v2
// logging model — event-driven while moving (here every 5 s), one averaged fix every 5 min parked.
function demoSource() {
  const DEVICES = ['tracker-01', 'tracker-02']
  const MOVE_STEP = 5000
  const PARK_STEP = 300000
  const CYCLE = 6 * 3600e3
  const PHASES = [[0, 1 / 6, false], [1 / 6, 3 / 6, true], [3 / 6, 4 / 6, false], [4 / 6, 1, true]]
  const WAYPOINTS = [
    [51.9520, 4.0450], [51.9480, 4.0900], [51.9330, 4.1400], [51.9100, 4.2000],
    [51.8960, 4.2700], [51.8890, 4.3300], [51.9000, 4.3900], [51.9050, 4.4300],
  ]

  const hash = (n) => {
    let x = (n | 0) ^ 0x9e3779b9
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b)
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296
  }
  const smooth = (t, period, salt) => {
    const k = t / period
    const i = Math.floor(k)
    const f = k - i
    const u = f * f * (3 - 2 * f)
    return hash(i * 7 + salt) * (1 - u) + hash((i + 1) * 7 + salt) * u
  }
  const segLen = (a, b) => Math.hypot(b[0] - a[0], (b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180))
  const lens = WAYPOINTS.slice(1).map((p, i) => segLen(WAYPOINTS[i], p))
  const totalLen = lens.reduce((a, b) => a + b, 0)
  const bearing = (a, b) => {
    const y = (b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180)
    return ((Math.atan2(y, b[0] - a[0]) * 180) / Math.PI + 360) % 360
  }
  const along = (f) => {
    let d = f * totalLen
    for (let i = 0; i < lens.length; i++) {
      if (d <= lens[i]) {
        const u = d / lens[i]
        const a = WAYPOINTS[i]
        const b = WAYPOINTS[i + 1]
        return { pos: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], brg: bearing(a, b) }
      }
      d -= lens[i]
    }
    const n = WAYPOINTS.length
    return { pos: WAYPOINTS[n - 1], brg: bearing(WAYPOINTS[n - 2], WAYPOINTS[n - 1]) }
  }

  const devIdx = (id) => DEVICES.indexOf(id) + 1 || 1
  const offset = (dev) => dev * 1.7 * 3600e3

  /** Phase containing t: { moving, start, end, f(t), dir }. */
  function phaseAt(dev, t) {
    const off = offset(dev)
    const c0 = Math.floor((t + off) / CYCLE) * CYCLE - off
    const ph = (t - c0) / CYCLE
    for (const [a, b, mv] of PHASES) {
      if (ph >= a && ph < b) {
        const start = c0 + a * CYCLE
        const end = c0 + b * CYCLE
        const u = (t - start) / (end - start)
        const forward = a < 0.5
        let f = forward ? 0 : 1
        if (mv) f = forward ? u : 1 - u
        else f = a === 0 ? 0 : 1
        return { moving: mv, start, end, f, dir: forward ? 0 : 180 }
      }
    }
    return null
  }

  /** Logging timestamps in [from, to] per the v2 cadence. */
  function timeline(dev, from, to) {
    const off = offset(dev)
    const out = []
    for (let c = Math.floor((from + off) / CYCLE) * CYCLE - off; c <= to; c += CYCLE) {
      for (const [a, b, mv] of PHASES) {
        const ps = c + a * CYCLE
        const pe = c + b * CYCLE
        const step = mv ? MOVE_STEP : PARK_STEP
        let t = ps + Math.max(0, Math.ceil((from - ps) / step)) * step
        for (; t < pe && t <= to; t += step) out.push(t)
      }
    }
    return out
  }

  function gen(deviceId, t) {
    const dev = devIdx(deviceId)
    const P = phaseAt(dev, t)
    const { pos: [lat0, lng0], brg } = along(P.f)
    const slot = Math.floor(t / 1000)
    const n = (salt, amp) => (hash(slot * 13 + salt + dev * 101) - 0.5) * 2 * amp
    const moving = P.moving
    const u = (t - P.start) / (P.end - P.start)
    const tunnel = moving && ((u > 0.42 && u < 0.45) || (u > 0.8 && u < 0.81))
    const gps_valid = !tunnel && hash(slot * 3 + dev) > 0.02
    const poorSky = gps_valid && hash(slot * 5 + dev) > 0.95
    const hdop = gps_valid ? +(poorSky ? 2.6 + hash(slot + 9) * 2 : 0.7 + hash(slot + 11) * 0.9).toFixed(2) : null
    const sats = gps_valid ? (poorSky ? 4 + Math.round(hash(slot + 17)) : Math.round(7 + hash(slot + 17) * 5)) : Math.round(hash(slot + 19) * 3)
    const jitter = moving ? 0.00003 : 0.000008 // parked rows are running means → very stable

    let roll = (smooth(t, 600e3, 11 + dev) - 0.5) * 6 + n(1, moving ? 1.2 : 0.2)
    let pitch = (smooth(t, 900e3, 23 + dev) - 0.5) * 5 + n(2, moving ? 1.0 : 0.2)
    const burst = Math.floor(t / 240000)
    if (hash(burst * 5 + dev) > 0.985) {
      const sign = hash(burst + 99) > 0.5 ? 1 : -1
      if (hash(burst + 7) > 0.5) roll = sign * (22 + hash(slot + 3) * 16)
      else pitch = sign * (21 + hash(slot + 5) * 12)
    }
    const g = Math.PI / 180
    return {
      id: Math.floor(t / 1000) * 10 + dev,
      device_id: deviceId,
      recorded_at: new Date(t).toISOString(),
      lat: gps_valid ? lat0 + n(3, jitter) : null,
      lng: gps_valid ? lng0 + n(4, jitter) : null,
      sats,
      hdop,
      heading: gps_valid && moving ? +((brg + P.dir + n(8, 4) + 360) % 360).toFixed(1) : null,
      speed_kmph: gps_valid ? (moving ? Math.max(0, +(32 + n(5, 8)).toFixed(1)) : 0) : null,
      gps_valid,
      is_moving: moving,
      roll: +roll.toFixed(2),
      pitch: +pitch.toFixed(2),
      accel_x: +(-Math.sin(pitch * g)).toFixed(3),
      accel_y: +(Math.sin(roll * g) * Math.cos(pitch * g)).toFixed(3),
      accel_z: +(Math.cos(roll * g) * Math.cos(pitch * g)).toFixed(3),
      temp_c: +(21 + 6 * Math.sin(((t / 86400e3) % 1) * 2 * Math.PI - 2) + n(7, 0.3) + dev).toFixed(2),
      humidity: null,
      battery_v: null,
      rssi: Math.round(-58 - smooth(t, 1200e3, 31 + dev) * 26),
    }
  }

  const pick = (r, cols) => Object.fromEntries(cols.split(',').map((c) => [c, r[c]]))
  const delay = (v) => new Promise((r) => setTimeout(() => r(v), 120 + Math.random() * 200))
  const rowsIn = (id, from, to) => timeline(devIdx(id), from, Math.min(to, Date.now())).map((t) => gen(id, t))
  const thin = (rows, cap) => {
    const stride = Math.max(1, Math.ceil(rows.length / cap))
    return { rows: rows.filter((_, i) => i % stride === 0), total: rows.length, stride }
  }
  const isRoute = (r) => r.is_moving && r.gps_valid && r.hdop <= 2.5 && r.sats >= 5
  const isEvent = (r) => Math.abs(r.roll) > TILT_ALARM_DEG || Math.abs(r.pitch) > TILT_ALARM_DEG
  const toEvent = (r) => ({ ...pick(r, EVENT_COLUMNS), max_angle: Math.max(Math.abs(r.roll), Math.abs(r.pitch)) })

  function stopsIn(id, from, to) {
    const dev = devIdx(id)
    const now = Date.now()
    const off = offset(dev)
    const out = []
    for (let c = Math.floor((from + off) / CYCLE) * CYCLE - off - CYCLE; c <= to; c += CYCLE) {
      for (const [a, b, mv] of PHASES) {
        if (mv) continue
        const ps = c + a * CYCLE
        const pe = c + b * CYCLE
        if (ps > Math.min(to, now) || pe < from) continue
        const samples = timeline(dev, ps, Math.min(pe - 1, now))
        if (!samples.length) continue
        const open = pe > now
        const p = along(a === 0 ? 0 : 1).pos
        out.push({
          device_id: id,
          arrived_at: new Date(samples[0]).toISOString(),
          departed_at: open ? null : new Date(samples[samples.length - 1]).toISOString(),
          lat: p[0], lng: p[1], sample_count: samples.length,
        })
      }
    }
    return out
  }

  return {
    demo: true,
    listDevices: () => delay([...DEVICES]),
    getLatest(id) {
      const ts = timeline(devIdx(id), Date.now() - 400e3, Date.now())
      return delay(gen(id, ts[ts.length - 1]))
    },
    getSeries: (id, from, to, cap) => delay(thin(rowsIn(id, from, to).map((r) => pick(r, SERIES_COLUMNS)), cap)),
    getRoute: (id, from, to, cap) => delay(thin(rowsIn(id, from, to).filter(isRoute).map((r) => pick(r, ROUTE_COLUMNS)), cap)),
    getStops: (id, from, to) => delay(stopsIn(id, from, to)),
    getLatestStop(id) {
      const s = stopsIn(id, Date.now() - CYCLE, Date.now())
      return delay(s[s.length - 1] || null)
    },
    getEvents(id, from, to, offset, limit) {
      const all = rowsIn(id, from, to).filter(isEvent).reverse().map(toEvent)
      return delay({ rows: all.slice(offset, offset + limit), total: all.length })
    },
    countEvents: (id, from, to) => delay(rowsIn(id, from, to).filter(isEvent).length),
    getSince: () => delay([]),
    subscribe({ onRow, onStatus }) {
      onStatus({ state: 'connecting' })
      const t0 = setTimeout(() => onStatus({ state: 'live', reconnected: false }), 400)
      // Faster than reality so the demo feels alive: moving every 5 s, parked every 60 s.
      let tick = 0
      const iv = setInterval(() => {
        tick++
        for (const d of DEVICES) {
          const r = gen(d, Date.now())
          if (r.is_moving || tick % 12 === 0) onRow(r)
        }
      }, 5000)
      return () => { clearTimeout(t0); clearInterval(iv) }
    },
  }
}

// --------------------------------------------------------------------------------------------
/**
 * Mount correction at the data boundary: every row leaves here with container-frame roll/pitch,
 * so the rest of the app never sees raw sensor angles. Tilt events can't come from the tilt_events
 * view (it thresholds RAW angles, so a vertical board flags nearly every row); instead fetch raw
 * candidates with a mount-derived pitch bound, correct them, and apply the >20° rule here.
 */
function withMount(src) {
  const bound = eventPitchBound(TILT_ALARM_DEG)
  const cache = new Map()
  const events = (id, from, to) => {
    const key = `${id}|${from}|${to}`
    if (!cache.has(key)) {
      if (cache.size > 20) cache.clear()
      const p = src.getTiltCandidates(id, from, to, bound).then((rows) => rows.map(correctRow).filter(isTiltEvent)
        .map((r) => ({ ...r, max_angle: Math.max(Math.abs(r.roll), Math.abs(r.pitch)) })))
      p.catch(() => cache.delete(key))
      cache.set(key, p)
    }
    return cache.get(key)
  }
  const fixSeries = (res) => ({ ...res, rows: res.rows.map(correctRow) })
  return {
    ...src,
    mountCorrected: true,
    getLatest: async (id) => correctRow(await src.getLatest(id)),
    getSeries: async (...a) => fixSeries(await src.getSeries(...a)),
    getSince: async (...a) => (await src.getSince(...a)).map(correctRow),
    subscribe: ({ onRow, onStatus }) => src.subscribe({ onRow: (r) => onRow(correctRow(r)), onStatus }),
    ...(bound && {
      async getEvents(id, from, to, offset, limit) {
        const all = await events(id, from, to)
        return { rows: all.slice(offset, offset + limit), total: all.length }
      },
      countEvents: async (id, from, to) => (await events(id, from, to)).length,
    }),
  }
}

const base = DEMO ? demoSource() : supabaseSource()
export const source = MOUNT_ACTIVE && !base.demo ? withMount(base) : base
