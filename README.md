# Bernini — container tracker dashboard

Built by Ananth · ananthxr@gmail.com

Vite + vanilla JS · Three.js · Chart.js · Leaflet · Supabase. Built against `systembrief_v2.md`.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

## Config (`.env`)

| Var | |
|---|---|
| `VITE_SUPABASE_URL` | already set |
| `VITE_SUPABASE_KEY` | publishable key (`sb_publishable_…`). **Blank = DEMO mode** (simulated v2 tracker, badged "DEMO DATA") |
| `VITE_CARTO_KEY` | optional. CARTO raster tiles need a key since Sep 2026. Blank = OpenStreetMap tiles tinted to the theme; falls back to OSM automatically if CARTO fails. |
| `VITE_OSRM_URL` / `VITE_OSRM_MAX_POINTS` | optional self-hosted OSRM for road snapping. Default is the public demo server (max **10** points/request, ~1 req/s). |

Tunables (stale thresholds, caps, tilt limits, roll/pitch signs on the 3D model) live in `src/config.js`.

## What comes from where
| UI | Source |
|---|---|
| Live cards, 3D pose, heading | `latest_readings` + Realtime INSERTs on `readings` |
| MOVING / PARKED + duration | `is_moving` on readings; parked-since from the `stops` view when it predates the live buffer |
| Stale | nothing **arrived** for 2× the expected interval: 2 min moving, 10 min parked |
| History route | `route_points` (moving, filtered), split at gaps > 5 min, optional OSRM road snapping (moving segments only) |
| Stop markers / parked chart bands | `stops` |
| Tilt table | `tilt_events` (`max_angle`), 50 per page, OSM link per event |
| Charts | `readings` (narrow columns), evenly sampled above 3,000 rows |

**Rows without `is_moving`** (pre-v2 firmware): motion is *estimated* from GPS (stay-point detection) and the map says so ("MOTION ESTIMATED FROM GPS"). As soon as the device reports `is_moving`, the v2 views take over automatically.

## Files
- `src/main.js` — state, wiring, live/history logic
- `src/data.js` — Supabase queries, views, Realtime, and the demo source
- `src/track.js` — route model (views / readings / legacy estimate), Douglas–Peucker
- `src/matcher.js` — OSRM road matching (chunked, throttled, cached)
- `src/map.js`, `src/charts.js`, `src/container3d.js`, `src/format.js`, `src/style.css`
