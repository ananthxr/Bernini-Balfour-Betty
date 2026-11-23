# Container Tracker — Full System Brief & Frontend Build Request

Paste this whole document into the AI building your frontend.
Replace `<YOUR_PUBLISHABLE_KEY>` with your key before sending.

---

## 1. What this system is

A shipping-container telemetry tracker. A device bolted inside a container reports
where it is, which way up it is, how warm it is, and whether it is currently in
transit or sitting still. The goal is to detect mishandling (sharp tilts, drops),
reconstruct the route a container travelled, and show its live state.

The hardware and backend are **built and working**. You are building **only the
web frontend**. Do not change the database schema, do not write firmware, do not
propose backend changes unless something is genuinely impossible without one.

## 2. Hardware (context — you don't need to touch this)

- **NodeMCU (ESP8266)** microcontroller, WiFi.
- **MPU-6500 IMU** (accelerometer + gyro) over I2C. Gives roll and pitch, and an
  internal temperature reading.
- **NEO-6M GPS** over UART. Gives position, speed, heading, satellite count, HDOP.
- Humidity sensor is **not yet fitted**. The `humidity` column exists but is always null.
- Temperature currently comes from the **IMU's internal sensor**, which reads a few
  degrees high because the chip warms itself. Treat it as indicative, not calibrated.
  A proper BME280 is coming later; the column will not change.

## 3. The critical thing to understand: motion state

Consumer GPS modules wander. A stationary NEO-6M near a building reports positions
drifting 10–30 m in a slow random walk. If you plot every fix and connect them with
lines, a parked container appears to drive laps of the block. **This is the single
biggest thing that makes these dashboards look broken.**

The device solves this in firmware, not with GPS maths. It watches the
**accelerometer variance** over a 2-second window:

- Stationary: variance ≈ 0.0015 g²
- In motion: variance ≈ 0.04 g²

A threshold of 0.005 g² separates them cleanly, with hysteresis (3 s to confirm
motion, 30 s of stillness to confirm a stop). The resulting state is stored on
**every row** in the `is_moving` column.

**What this means for you:**

- `is_moving = true` rows are genuine travel. Draw these as a route.
- `is_moving = false` rows are a container sitting still. **Never draw these as a
  path.** Collapse them into a single stop marker with a dwell time.

This distinction drives almost every design decision below.

## 4. Logging cadence (why point spacing is uneven)

The device does **not** log on a fixed timer. While moving it logs when:

- it has travelled ≥ 25 m, **or**
- its heading changed by ≥ 20°, **or**
- 60 s have passed regardless.

So corners are dense with points and straight runs are sparse. **That is correct and
intentional** — it preserves route shape while keeping row counts low. Do not
"correct" for uneven spacing or assume missing data.

While parked it logs one averaged position every **5 minutes**. The parked position
is a running mean of many fixes, so it is more accurate than any single reading.

Rows are buffered on-device (up to 12) and uploaded as a **JSON array** every 30 s.
If WiFi drops, rows queue and arrive late in a burst. **Order by `recorded_at`, never
by `id` or arrival order.** Each row carries its own GPS-derived UTC timestamp.

## 5. Backend

- **Supabase project URL:** `https://hvgeqqnvgvylhsykoggo.supabase.co`
- **Publishable key (client-safe, low privilege):** `<YOUR_PUBLISHABLE_KEY>`
- **Client library:** `@supabase/supabase-js` v2
- RLS is on. This key may `INSERT` and `SELECT` on `readings` only — no `UPDATE`,
  no `DELETE`. Build read-only.
- **Realtime is enabled** on `public.readings`.

### Table: `public.readings`

| Column        | Type             | Notes |
|---------------|------------------|-------|
| `id`          | bigint           | identity PK |
| `device_id`   | text             | e.g. `tracker-01`; multiple devices possible |
| `recorded_at` | timestamptz      | **GPS UTC time of the reading**, not upload time |
| `lat`         | double precision | null when no valid fix |
| `lng`         | double precision | null when no valid fix |
| `sats`        | smallint         | satellite count |
| `hdop`        | real             | dilution of precision — **lower is better**, ≤2.0 is good |
| `heading`     | real             | course over ground 0–360°, null when stationary |
| `speed_kmph`  | real             | **Doppler-derived**, more reliable than position differencing |
| `gps_valid`   | boolean          | false = device had no usable fix |
| `is_moving`   | boolean          | **accelerometer-derived motion state — see §3** |
| `roll`        | real             | degrees, −180..180 |
| `pitch`       | real             | degrees, −90..90 |
| `accel_x/y/z` | real             | g |
| `temp_c`      | real             | Celsius (IMU internal — reads high) |
| `humidity`    | real             | **always null for now** |
| `battery_v`   | real             | null, unused |
| `rssi`        | smallint         | WiFi dBm, negative |

### Views already built for you — prefer these over raw queries

- **`latest_readings`** — newest row per device. Use for the live panel.
- **`route_points`** — moving rows only, already filtered to `gps_valid = true`,
  `hdop ≤ 2.5`, `sats ≥ 5`, ordered by time. **Use this to draw routes.**
- **`stops`** — consecutive parked rows collapsed into dwell periods, with
  `arrived_at`, `departed_at`, `dwell`, averaged `lat`/`lng`, `sample_count`.
  **Use this for stop markers.**
- **`tilt_events`** — rows where `abs(roll) > 20` or `abs(pitch) > 20`, with
  `max_angle`. Use for the alert list.

## 6. What to build

A single-page dashboard, two modes: **Live** and **History**.

### Live view

- **Motion state badge** — MOVING or PARKED, prominent. If parked, show how long.
- **Tilt indicator** — artificial-horizon style, or a container silhouette that
  rotates with roll and pitch. Make this the visual focal point; it is what makes
  the demo land.
- Status cards: temperature, GPS fix quality (sats + HDOP), speed, WiFi RSSI,
  time since last reading.
- **Map** — Leaflet + OpenStreetMap tiles. Free, no API key. Do not use Google Maps.
- Subscribe to Realtime (`postgres_changes`, event `INSERT`, table `readings`).
  Update the moment a row arrives; no polling.
- **Stale state:** rows arrive every 30 s while moving, every 5 min while parked.
  If nothing has arrived in **2× the expected interval for the current state**,
  grey everything out and say so. Never present old data as live.

### History view

- Time range selector: last hour, 24 h, 7 days, custom.
- **Route rendering** (this is where care pays off):
  1. Query `route_points` for the range.
  2. **Split the track into segments wherever there is a gap > 5 minutes** between
     consecutive points. Draw each segment as its own polyline. Do **not** connect
     across gaps — that draws straight lines through places the container never went.
  3. Overlay `stops` as markers sized or labelled by dwell time.
  4. Optionally **map-match** each moving segment with the public OSRM match
     endpoint (`router.project-osrm.org/match/v1/driving/...`) to snap the trail
     onto real roads. Max 100 coordinates per request, so chunk long segments.
     **Only ever match moving segments** — matching parked noise produces confident
     nonsense.
- Charts over time (Chart.js or Recharts): roll/pitch, temperature, speed.
  Shade or mark the parked periods so gaps in motion are visually obvious.
- **Tilt event table** from `tilt_events`: timestamp, angle, location, map link.
- Never `select *` over a wide range. Select only needed columns, and cap rows.

### Quality requirements

- Handle nulls properly: `humidity` is always null; `lat`/`lng`/`heading` are null
  whenever `gps_valid` is false. Show "—" or "no data", never blank or `NaN`.
- Device selector dropdown, populated from distinct `device_id` values.
- Responsive; usable on a phone.
- Show Realtime connection status and reconnect on drop.
- Consider colouring the route by HDOP or speed — honest uncertainty reads better
  than false precision.

## 7. Constraints

- **Single self-contained HTML file** preferred, with Supabase, Leaflet and the chart
  library from CDNs. If a build step is truly needed, Vite + vanilla JS or React.
- No backend, no server code, no keys beyond the publishable one.
- **Free tier: 5 GB egress/month.** Query narrowly. At realistic duty cycles the
  table grows ~10–20 MB/month, but a careless `select *` over 7 days still hurts.

## 8. Style

Industrial/logistics monitoring tool. Dark theme. Dense but legible. Numbers and
state should be readable at a glance from across a room. Prioritise immediate
comprehension over decoration — this is an operations screen, not a landing page.

## 9. Query examples

```js
// Live: newest row for a device
const { data } = await supabase
  .from('latest_readings')
  .select('*')
  .eq('device_id', 'tracker-01')
  .single()

// History: clean route points, last 24h
const { data } = await supabase
  .from('route_points')
  .select('recorded_at, lat, lng, speed_kmph, heading, hdop')
  .eq('device_id', 'tracker-01')
  .gte('recorded_at', new Date(Date.now() - 864e5).toISOString())
  .order('recorded_at', { ascending: true })
  .limit(5000)

// History: stops in the same window
const { data } = await supabase
  .from('stops')
  .select('*')
  .eq('device_id', 'tracker-01')
  .gte('arrived_at', new Date(Date.now() - 864e5).toISOString())

// Realtime
supabase.channel('readings-live')
  .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'readings' },
      payload => handleNewReading(payload.new))
  .subscribe()
```

```js
// Splitting a track into segments across time gaps
function splitSegments(points, maxGapMs = 5 * 60 * 1000) {
  const segments = []
  let current = []
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const gap = new Date(points[i].recorded_at) - new Date(points[i - 1].recorded_at)
      if (gap > maxGapMs) { segments.push(current); current = [] }
    }
    current.push(points[i])
  }
  if (current.length) segments.push(current)
  return segments.filter(s => s.length > 1)
}
```

## 10. Please ask before assuming

If anything about the data model or intent is unclear, ask rather than inventing a
column or changing the schema. In particular, do not add tables, do not alter RLS,
and do not assume a field exists because it would be convenient.
