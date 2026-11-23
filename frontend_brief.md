# Build Prompt — Container Tracker Dashboard

Paste everything below into the AI you want to build the frontend.
Replace `<YOUR_PUBLISHABLE_KEY>` with your own key before sending.

---

## Context

I have an IoT shipping-container tracker already running. An ESP8266 device posts
telemetry to a Supabase (Postgres) backend every 30 seconds. The backend is
finished and live. I need you to build **only the frontend dashboard**.

Do not change the database schema. Do not write any device firmware.

## Backend details

- **Supabase project URL:** `https://hvgeqqnvgvylhsykoggo.supabase.co`
- **Publishable key (client-safe, low privilege):** `<YOUR_PUBLISHABLE_KEY>`
- **Client library:** `@supabase/supabase-js` v2
- Row Level Security is on. The publishable key can `INSERT` and `SELECT` on
  `readings`, but **not** `UPDATE` or `DELETE`. Design around read-only access.
- Supabase **Realtime is already enabled** on the `readings` table.

## Table: `public.readings`

| Column        | Type          | Notes                                        |
|---------------|---------------|----------------------------------------------|
| `id`          | bigint        | identity primary key                          |
| `device_id`   | text          | e.g. `tracker-01`; several devices possible   |
| `recorded_at` | timestamptz   | server time the row landed, defaults to now() |
| `lat`         | double precision | nullable — null when no GPS fix            |
| `lng`         | double precision | nullable                                   |
| `sats`        | smallint      | satellite count, nullable                     |
| `speed_kmph`  | real          | nullable                                      |
| `gps_valid`   | boolean       | false when the device had no fix              |
| `roll`        | real          | degrees, -180 to 180                          |
| `pitch`       | real          | degrees, -90 to 90                            |
| `accel_x/y/z` | real          | in g                                          |
| `temp_c`      | real          | Celsius                                       |
| `humidity`    | real          | percent — **currently always null**, sensor not yet fitted |
| `battery_v`   | real          | nullable, currently unused                    |
| `rssi`        | smallint      | WiFi signal strength, negative dBm            |

There is also a view **`public.latest_readings`** returning the single newest row
per `device_id`. Use it for the "right now" panel instead of sorting the whole table.

## What to build

A single-page dashboard with two modes: **Live** and **History**.

### Live view
- Current status cards: tilt (roll and pitch), temperature, GPS fix status,
  satellite count, WiFi RSSI, and time since last reading.
- A **visual tilt indicator** — an artificial-horizon style widget or a simple
  container silhouette that rotates with roll and pitch. This is the headline
  feature; make it the focal point.
- A map showing the current position. Use **Leaflet with OpenStreetMap tiles**
  (free, no API key). Do not use Google Maps.
- Subscribe to Supabase Realtime (`postgres_changes`, event `INSERT`, table
  `readings`) so the view updates the moment a row arrives — no polling.
- A clear "stale" state: if no row has arrived in over 2 minutes, grey the
  cards and say so. Do not display old data as if it were current.

### History view
- A time-range selector: last hour, last 24 hours, last 7 days, custom.
- Line charts over time for roll/pitch, temperature, and speed. Use
  **Chart.js** or **Recharts**.
- The route drawn as a polyline on the map, with markers at start and end.
- A **tilt event list**: any reading where `abs(roll) > 20` or `abs(pitch) > 20`,
  shown as a table with timestamp, angle and location. These are the events that
  matter commercially — a container being mishandled.
- Pagination or a sensible row cap. There can be ~86,000 rows per month, so never
  fetch the whole table.

### Behaviour and quality
- Handle the null cases properly: `humidity` is always null right now, and
  `lat`/`lng` are null whenever `gps_valid` is false. Show "no data" rather
  than blank or `NaN`.
- Support multiple devices via a `device_id` dropdown, populated from the
  distinct values present.
- Responsive — it should be usable on a phone.
- Show connection state for the Realtime socket, and reconnect if it drops.

## Technical constraints

- **Single self-contained HTML file** if possible, loading Supabase, Leaflet and
  the chart library from a CDN. If a build step is genuinely necessary, use Vite
  with vanilla JS or React — but prefer the single file.
- No backend, no server code, no API keys beyond the publishable one.
- Must stay inside the Supabase free tier: 5 GB egress per month. So query only
  the columns and time ranges needed, and never `select *` across the full table.

## Style

Clean industrial/logistics feel. Dark theme. Dense but readable — this is a
monitoring tool, not a marketing page. Prioritise legibility of numbers and
immediate comprehension of the tilt state over decoration.

## Sample query shapes

```js
// latest row for one device
const { data } = await supabase
  .from('latest_readings')
  .select('*')
  .eq('device_id', 'tracker-01')
  .single()

// last 24 hours, only the columns a chart needs
const { data } = await supabase
  .from('readings')
  .select('recorded_at, roll, pitch, temp_c, lat, lng')
  .eq('device_id', 'tracker-01')
  .gte('recorded_at', new Date(Date.now() - 864e5).toISOString())
  .order('recorded_at', { ascending: true })
  .limit(3000)

// realtime
supabase.channel('readings-live')
  .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'readings' },
      payload => handleNewReading(payload.new))
  .subscribe()
```

## Please ask me before assuming

If anything about the data or the intended use is unclear, ask me rather than
inventing a schema change or a column that does not exist.
