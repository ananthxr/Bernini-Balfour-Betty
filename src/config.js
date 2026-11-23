// Central tunables. Everything here is safe to change without touching other files.

const env = import.meta.env

export const SUPABASE_URL = (env.VITE_SUPABASE_URL || '').trim()
export const SUPABASE_KEY = (env.VITE_SUPABASE_KEY || '').trim()
export const CARTO_KEY = (env.VITE_CARTO_KEY || '').trim()

// Demo mode kicks in only when no usable key is configured, and is badged loudly in the UI.
export const DEMO = !SUPABASE_URL || !SUPABASE_KEY || SUPABASE_KEY.startsWith('<')

export const TILT_WARN_DEG = 15   // container edges glow orange
export const TILT_ALARM_DEG = 20  // tilt event threshold (matches the tilt_events view) — red

// Stale = nothing arrived for 2× the expected interval of the current motion state (brief §6).
// Moving: device logs at least every 60 s (more often on distance/heading change) → 2 min.
// Parked: one averaged position every 5 min → 10 min.
// Unknown: rows without is_moving (pre-v2 firmware, fixed 30 s cadence) → 2 min.
export const STALE_MS = { moving: 2 * 60e3, parked: 10 * 60e3, unknown: 2 * 60e3 }
export const EXPECTED_LABEL = { moving: '≤60 s WHILE MOVING', parked: 'EVERY 5 MIN WHILE PARKED', unknown: 'EVERY 30 s' }
export const EXPECTED_SHORT = { moving: 'EXP ≤60s', parked: 'EXP 5 MIN', unknown: 'EXP 30s' }

export const LIVE_SEED_MS = 2 * 3600e3   // live charts/trail start with the last 2 h
export const LIVE_MAX_POINTS = 1500      // moving logs can reach ~1 row / 2.5 s
export const HISTORY_ROW_CAP = 3000      // chart series (readings) per history load
export const ROUTE_ROW_CAP = 5000        // route_points per history load (evenly sampled above this)
export const CUSTOM_RANGE_MAX_DAYS = 31
export const EVENTS_PAGE_SIZE = 50

// How the tracker is mounted relative to the container.
// roll  = rotation about the container's long axis (positive = right side down when looking at the doors from inside)
// pitch = rotation about the lateral axis (positive = door end up)
// Flip a sign here if the 3D model tilts the wrong way when you physically tilt the device.
export const AXES = { rollSign: 1, pitchSign: 1 }

// Sensor mounting. The IMU board is installed VERTICALLY, so a level container reads roughly
// roll −170° / pitch −88° (gravity along the board's X axis). These are the raw angles the board reports
// when the container is level — measured from 60 readings on a flat surface (23 Nov 2026, spread ≤0.7°).
// All roll/pitch shown, charted, alarmed and posed on the 3D model are container-frame angles
// derived from this (see src/mount.js). Re-measure if the board is re-mounted.
// twistDeg: rotate 90 if tilting the container along its LENGTH shows up as roll instead of pitch.
export const MOUNT = { enabled: !DEMO, levelRoll: -169.8, levelPitch: -87.96, twistDeg: 0 }

// Owner code painted on the 3D container. Serial digits are derived from device_id.
export const OWNER_CODE = 'BFBU'

// Route rendering.
export const TRACK = {
  gapSplitMs: 5 * 60e3,   // brief §6: never connect points across a gap > 5 min
  // Live trail mirrors the route_points view filter.
  maxHdop: 2.5,
  minSats: 5,
  // Fallback ONLY for rows where is_moving is null (pre-v2 firmware): estimate stops from GPS.
  legacy: { minSats: 4, minStepM: 20, stopRadiusM: 35, stopMinMs: 3 * 60e3, outlierTolerance: 2 },
}

// Road snapping (History mode, moving segments only). Public OSRM demo server: free, no key, ~1 req/s,
// and (measured Nov 2026) at most 10 coordinates per /match request — not the 100 often quoted.
// Sends route coordinates to that server. Set VITE_OSRM_URL (+ VITE_OSRM_MAX_POINTS, e.g. 100) to a
// self-hosted OSRM to keep them in-house and go faster.
export const OSRM_URL = (env.VITE_OSRM_URL || 'https://router.project-osrm.org').trim().replace(/\/$/, '')
export const OSRM_MAX_POINTS = Math.max(3, Number(env.VITE_OSRM_MAX_POINTS) || 10)
export const OSRM_MIN_CONFIDENCE = 0.3
export const OSRM_SIMPLIFY_M = 15     // Douglas–Peucker tolerance before matching: straights collapse, corners stay
export const OSRM_MAX_REQUESTS = 90   // per history load (~1.5 min on the public server); the rest stays raw

// Columns — never select * on readings.
export const SERIES_COLUMNS = 'id,recorded_at,roll,pitch,temp_c,speed_kmph,lat,lng,gps_valid,sats,hdop,heading,is_moving'
export const ROUTE_COLUMNS = 'id,recorded_at,lat,lng,speed_kmph,heading,hdop,sats'
export const STOP_COLUMNS = 'device_id,arrived_at,departed_at,lat,lng,sample_count'
export const EVENT_COLUMNS = 'id,recorded_at,roll,pitch,lat,lng,max_angle,is_moving'
