import { TILT_WARN_DEG, TILT_ALARM_DEG, OWNER_CODE } from './config.js'

export const DASH = '—'

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

export function fmtNum(v, digits = 1, fallback = DASH) {
  return isNum(v) ? v.toFixed(digits) : fallback
}

export function fmtSigned(v, digits = 1, fallback = DASH) {
  if (!isNum(v)) return fallback
  const s = Math.abs(v).toFixed(digits)
  if (Number(s) === 0) return s // no "-0.0"
  return v > 0 ? `+${s}` : `-${s}`
}

/** Physically possible coordinate (rejects e.g. lng 400° from a bad on-device average, and 0,0). */
export const validLatLng = (lat, lng) =>
  isNum(lat) && isNum(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)

// Views (route_points, tilt_events) have no gps_valid column; their lat/lng are null without a fix.
export const hasFix = (r) => !!r && r.gps_valid !== false && validLatLng(r.lat, r.lng)

/** 'moving' | 'parked' | 'unknown' (is_moving null = pre-v2 firmware) */
export const motionOf = (r) => (r?.is_moving === true ? 'moving' : r?.is_moving === false ? 'parked' : 'unknown')

export function hdopQuality(hdop) {
  if (!isNum(hdop)) return { label: 'NO HDOP', cls: null }
  if (hdop <= 1) return { label: 'EXCELLENT', cls: 'good' }
  if (hdop <= 2) return { label: 'GOOD', cls: 'good' }
  if (hdop <= 5) return { label: 'MODERATE', cls: 'fair' }
  return { label: 'POOR', cls: 'poor' }
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
export const fmtHeading = (h) => (isNum(h) ? `${String(Math.round(h) % 360).padStart(3, '0')}° ${COMPASS[Math.round(h / 45) % 8]}` : DASH)

export function fmtAge(ms) {
  if (!isNum(ms)) return DASH
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Dwell durations: "45s", "12m", "4h 20m", "2d 3h". */
export function fmtDwell(ms) {
  if (!isNum(ms)) return DASH
  const m = Math.round(ms / 60000)
  if (m < 1) return `${Math.round(ms / 1000)}s`
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const pad = (n) => String(n).padStart(2, '0')

export function fmtTime(ts) {
  if (!ts) return DASH
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function fmtDate(ts) {
  if (!ts) return DASH
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const fmtDateTime = (ts) => (ts ? `${fmtDate(ts)} ${fmtTime(ts)}` : DASH)

export function fmtLat(lat) {
  return isNum(lat) ? `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}` : DASH
}
export function fmtLng(lng) {
  return isNum(lng) ? `${Math.abs(lng).toFixed(5)}° ${lng >= 0 ? 'E' : 'W'}` : DASH
}
export function fmtLatLng(r) {
  return hasFix(r) ? `${fmtLat(r.lat)}  ${fmtLng(r.lng)}` : 'NO FIX'
}

/** 'none' | 'ok' | 'warn' | 'alarm' */
export function tiltLevel(roll, pitch) {
  if (!isNum(roll) && !isNum(pitch)) return 'none'
  const m = Math.max(Math.abs(roll || 0), Math.abs(pitch || 0))
  if (m > TILT_ALARM_DEG) return 'alarm'
  if (m >= TILT_WARN_DEG) return 'warn'
  return 'ok'
}

export const isTiltEvent = (r) =>
  (isNum(r.roll) && Math.abs(r.roll) > TILT_ALARM_DEG) || (isNum(r.pitch) && Math.abs(r.pitch) > TILT_ALARM_DEG)

export function rssiQuality(rssi) {
  if (!isNum(rssi)) return { label: 'NO DATA', bars: 0 }
  if (rssi >= -55) return { label: 'EXCELLENT', bars: 4 }
  if (rssi >= -67) return { label: 'GOOD', bars: 3 }
  if (rssi >= -75) return { label: 'FAIR', bars: 2 }
  if (rssi >= -85) return { label: 'WEAK', bars: 1 }
  return { label: 'POOR', bars: 0 }
}

// ---- ISO 6346 container code, derived from device_id (no column exists for it) ----
const LETTER_VALUES = (() => {
  const out = {}
  let v = 10
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (v % 11 === 0) v++
    out[ch] = v++
  }
  return out
})()

export function containerCode(deviceId) {
  const digits = String(deviceId || '').replace(/\D/g, '')
  let serial
  if (digits) serial = digits.slice(-6).padStart(6, '0')
  else {
    let h = 0
    for (const c of String(deviceId || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0
    serial = String(h % 1e6).padStart(6, '0')
  }
  const chars = (OWNER_CODE + serial).split('')
  const sum = chars.reduce((acc, ch, i) => acc + (LETTER_VALUES[ch] ?? Number(ch)) * 2 ** i, 0)
  const check = (sum % 11) % 10
  return { owner: OWNER_CODE, serial, check, text: `${OWNER_CODE} ${serial}` }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
