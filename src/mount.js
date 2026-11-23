// Sensor-mounting correction.
//
// The board is mounted vertically inside the container, so "container level" does not read as
// roll 0 / pitch 0 — it reads as MOUNT.levelRoll / MOUNT.levelPitch (pitch ≈ −88°). Near ±90° pitch,
// roll is numerically unstable (gimbal lock), so subtracting angles would be wrong.
//
// Instead, per reading:
//   1. rebuild the sensor-frame gravity vector from the firmware's roll/pitch
//      (firmware: roll = atan2(ay, az), pitch = atan2(−ax, √(ay²+az²)) — verified against accel_x/y/z)
//   2. rotate it by the fixed mounting rotation M (M · g_level = straight down in the container frame)
//   3. recompute roll/pitch in the container frame → level container = 0° / 0°.
import { MOUNT } from './config.js'
import { isNum } from './format.js'

const D = Math.PI / 180

export const gravityOf = (roll, pitch) => {
  const r = roll * D
  const p = pitch * D
  return [-Math.sin(p), Math.sin(r) * Math.cos(p), Math.cos(r) * Math.cos(p)]
}

const mul = (M, v) => [0, 1, 2].map((i) => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2])
const matmul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]))

/** Minimal rotation taking unit vector a onto unit vector b (Rodrigues). */
function rotFromTo(a, b) {
  const v = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const s2 = v[0] ** 2 + v[1] ** 2 + v[2] ** 2
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  if (s2 < 1e-12) return c > 0 ? I : [[1, 0, 0], [0, -1, 0], [0, 0, -1]]
  const K = [[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]]
  const K2 = matmul(K, K)
  const f = (1 - c) / s2
  return I.map((row, i) => row.map((x, j) => x + K[i][j] + K2[i][j] * f))
}

function buildMount() {
  if (!MOUNT?.enabled) return null
  const g0 = gravityOf(MOUNT.levelRoll, MOUNT.levelPitch)
  const R = rotFromTo(g0, [0, 0, 1])
  // Twist about the vertical: which horizontal board axis runs along the container's length.
  const t = (MOUNT.twistDeg || 0) * D
  const Rz = [[Math.cos(t), -Math.sin(t), 0], [Math.sin(t), Math.cos(t), 0], [0, 0, 1]]
  return { M: matmul(Rz, R), g0 }
}

const mount = buildMount()
export const MOUNT_ACTIVE = !!mount

/** Container-frame roll/pitch for a raw sensor reading. */
export function correct(roll, pitch) {
  if (!mount || !isNum(roll) || !isNum(pitch)) return { roll, pitch }
  const c = mul(mount.M, gravityOf(roll, pitch))
  return {
    roll: +(Math.atan2(c[1], c[2]) / D).toFixed(2),
    pitch: +(Math.atan2(-c[0], Math.hypot(c[1], c[2])) / D).toFixed(2),
  }
}

/** Same row with container-frame roll/pitch; raw sensor angles kept as raw_roll / raw_pitch. */
export function correctRow(r) {
  if (!mount || !r || !('roll' in r)) return r
  const { roll, pitch } = correct(r.roll, r.pitch)
  return { ...r, roll, pitch, raw_roll: r.roll, raw_pitch: r.pitch }
}

/**
 * Server-side pre-filter for tilt-event candidates, as a raw-pitch bound. Any container tilt > T°
 * moves gravity > T° from g_level; since the raw pitch measures gravity's angle to the board X axis,
 * a mount with g_level near ±X gives a necessary condition on raw pitch alone.
 * Returns { op: 'gt'|'lt', value } or null when the mount isn't near ±X (fall back to the view).
 */
export function eventPitchBound(thresholdDeg) {
  if (!mount) return null
  const gx = mount.g0[0]
  if (Math.abs(gx) < 0.9) return null
  const delta = Math.acos(Math.min(1, Math.abs(gx))) / D // mount's angle from the X axis
  const limit = 90 - thresholdDeg + delta + 0.5
  return gx > 0 ? { op: 'gt', value: +(-limit).toFixed(2) } : { op: 'lt', value: +limit.toFixed(2) }
}
