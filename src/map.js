import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { CARTO_KEY, OSRM_SIMPLIFY_M, OSRM_MAX_REQUESTS } from './config.js'
import { hasFix, fmtTime, fmtDateTime, fmtDwell, fmtHeading, escapeHtml, isNum } from './format.js'
import { quality, simplifyIdx } from './track.js'
import { chunk, matchChunk, CHUNK_STEP } from './matcher.js'

// CARTO raster basemaps need a key since Sep 2026 (free: carto.com/basemaps/apikey).
// Without one we use standard OSM tiles, tinted to greyscale / dark via CSS filter.
const OSM_ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
const CARTO_ATTRIB = `${OSM_ATTRIB} &copy; <a href="https://carto.com/attributions">CARTO</a>`
const cartoUrl = (style) =>
  `https://{s}.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(CARTO_KEY)}`
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const ROUTING_ATTRIB = 'Road matching &copy; <a href="https://project-osrm.org/">OSRM</a>'

function makeTiles(provider) {
  if (provider === 'carto') {
    return {
      dark: L.tileLayer(cartoUrl('dark_all'), { attribution: CARTO_ATTRIB, subdomains: 'abcd', maxZoom: 20 }),
      light: L.tileLayer(cartoUrl('light_all'), { attribution: CARTO_ATTRIB, subdomains: 'abcd', maxZoom: 20 }),
    }
  }
  return {
    dark: L.tileLayer(OSM_URL, { attribution: OSM_ATTRIB, maxZoom: 19, className: 'osm-dark' }),
    light: L.tileLayer(OSM_URL, { attribution: OSM_ATTRIB, maxZoom: 19, className: 'osm-light' }),
  }
}

const icon = (cls, html = '', size = [18, 18]) =>
  L.divIcon({ className: `mk ${cls}`, html, iconSize: size, iconAnchor: [size[0] / 2, size[1] / 2] })

const DOTS_MIN_ZOOM = 15
const dotRadius = (z) => (z >= 17 ? 3.2 : z >= 16 ? 2.6 : 2)
const RAW_STYLE = { // straight-line interpolation; thinner/fainter with worse HDOP / fewer satellites
  good: { weight: 2, opacity: 0.8 },
  fair: { weight: 1.5, opacity: 0.55 },
  poor: { weight: 1, opacity: 0.32 },
}
const RANK = { poor: 0, fair: 1, good: 2 }
const worst = (a, b) => (RANK[a] <= RANK[b] ? a : b)
const DOT_OPACITY = { good: 1, fair: 0.7, poor: 0.4 }
const stopSize = (ms) => (ms < 30 * 60e3 ? 14 : ms < 3 * 3600e3 ? 17 : 21)

function pointLabel(p) {
  const parts = [`${fmtDateTime(p.t)}`]
  if (isNum(p.row?.speed_kmph)) parts.push(`${p.row.speed_kmph.toFixed(1)} km/h`)
  if (isNum(p.heading)) parts.push(`HDG ${fmtHeading(p.heading)}`)
  if (isNum(p.hdop)) parts.push(`HDOP ${p.hdop.toFixed(1)}`)
  if (isNum(p.sats)) parts.push(`${p.sats} sats`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------------------------
/** One track: stops as dwell markers, moving segments as raw dashes or road-matched lines. */
class TrackLayer {
  constructor(view, { clickable = false } = {}) {
    this.view = view
    this.clickable = clickable
    this.group = L.layerGroup()
    this.lines = L.layerGroup().addTo(this.group)
    this.stopLayer = L.layerGroup().addTo(this.group)
    this.dots = L.layerGroup()
    this.segs = []
    this.track = null
    this.live = false
    this.snapToken = 0
  }

  set(track, { live = false } = {}) {
    this.live = live
    this.track = track
    this.segs = track.segments.map((pts) => ({ pts, runs: null, layer: null }))
    this.snapToken++
    this.abort?.abort()
    this.render()
    return track
  }

  render() {
    this.lines.clearLayers()
    this.stopLayer.clearLayers()
    this.dots.clearLayers()
    if (!this.track) return
    for (const seg of this.segs) {
      seg.layer = L.layerGroup().addTo(this.lines)
      this.drawSeg(seg)
    }
    this.drawStops()
    this.drawDots()
    this.updateZoom()
  }

  drawSeg(seg) {
    seg.layer.clearLayers()
    const { line, under } = this.view.colors()
    const pts = seg.pts
    const covered = new Array(pts.length - 1).fill(false)
    const matched = []
    for (const run of seg.runs || []) {
      run.results.forEach((m, ci) => {
        if (!m) return
        m.pairCovered.forEach((c, k) => {
          if (!c) return
          const s = ci * CHUNK_STEP + k // simplified pair (s, s+1) → original index span
          for (let o = run.idx[s]; o < run.idx[s + 1]; o++) covered[o] = true
        })
        matched.push(...m.lines)
      })
    }
    for (const ml of matched) {
      L.polyline(ml.latlngs, { color: under, weight: 5, opacity: 0.35, interactive: false }).addTo(seg.layer)
      L.polyline(ml.latlngs, { color: line, weight: 2.2, opacity: 0.45 + 0.5 * ml.confidence, interactive: false }).addTo(seg.layer)
    }
    const groups = { good: [], fair: [], poor: [] }
    for (let k = 1; k < pts.length; k++) {
      if (covered[k - 1]) continue
      const a = pts[k - 1]
      const b = pts[k]
      groups[worst(quality(a), quality(b))].push([[a.lat, a.lng], [b.lat, b.lng]])
    }
    for (const cls of ['good', 'fair', 'poor']) {
      if (groups[cls].length) L.polyline(groups[cls], { color: line, dashArray: '5 5', interactive: false, ...RAW_STYLE[cls] }).addTo(seg.layer)
    }
  }

  drawStops() {
    const now = Date.now()
    for (const st of this.track.stops) {
      const end = st.end ?? now
      const ongoing = st.open
      const dwell = fmtDwell((ongoing && this.live ? now : end) - st.start)
      const label = ongoing ? `${dwell} · ${this.live ? 'NOW' : 'ONGOING'}` : dwell
      const size = stopSize(end - st.start)
      const m = L.marker([st.lat, st.lng], {
        icon: icon(`mk-stop${ongoing ? ' is-now' : ''}${this.track.legacy || st.fromRoute ? ' is-est' : ''}`, `<i></i><b>${escapeHtml(label)}</b>`, [size, size]),
        zIndexOffset: -200,
      })
      const tail = ongoing ? 'NOW' : fmtTime(end)
      const n = isNum(st.count) ? ` · ${st.count} SAMPLES` : ''
      const where = st.fromRoute ? ' · POSITION FROM ROUTE (DEVICE PARKED AVERAGE IMPLAUSIBLE)' : ''
      m.bindTooltip(
        `${this.track.legacy ? 'EST. STOP' : 'PARKED'} ${dwell} · ${fmtDateTime(st.start)} → ${tail}${n}${where}`,
        { direction: 'top', offset: [0, -size / 2 - 2], className: 'mk-tip' },
      )
      if (this.clickable) m.on('click', () => this.view.onTimeClick(st.start))
      m.addTo(this.stopLayer)
    }
  }

  drawDots() {
    const { line, under } = this.view.colors()
    const r = dotRadius(this.view.map.getZoom())
    for (const p of this.track.moving) {
      const q = quality(p)
      const m = L.circleMarker([p.lat, p.lng], {
        radius: r, color: under, weight: 1, fillColor: line, fillOpacity: DOT_OPACITY[q], opacity: DOT_OPACITY[q], bubblingMouseEvents: false,
      })
      m.bindTooltip(() => pointLabel(p), { direction: 'top', offset: [0, -4], className: 'mk-tip' })
      if (this.clickable) m.on('click', () => this.view.onTimeClick(p.t))
      m.addTo(this.dots)
    }
  }

  updateZoom() {
    const z = this.view.map.getZoom()
    const show = z >= DOTS_MIN_ZOOM
    if (show && !this.group.hasLayer(this.dots)) this.group.addLayer(this.dots)
    if (!show && this.group.hasLayer(this.dots)) this.group.removeLayer(this.dots)
    const r = dotRadius(z)
    this.dots.eachLayer((l) => l.setRadius(r))
  }

  /** Road-match every MOVING segment (never stops), redrawing each as its chunks come back. */
  async snap(onProgress = () => {}) {
    const token = ++this.snapToken
    this.abort?.abort()
    const ctl = (this.abort = new AbortController())
    const jobs = []
    for (const seg of this.segs) {
      const idx = simplifyIdx(seg.pts, OSRM_SIMPLIFY_M)
      const chunks = chunk(idx.map((i) => seg.pts[i]))
      const run = { idx, results: chunks.map(() => null) }
      seg.runs = [run]
      chunks.forEach((c, ci) => jobs.push({ seg, run, ci, c }))
    }
    const total = jobs.length
    const budget = Math.min(total, OSRM_MAX_REQUESTS)
    let done = 0
    let failed = 0
    let limited = false
    const report = (state) => onProgress({ state, done, total, failed, limited, partial: total > budget })
    report(total ? 'running' : 'done')
    for (let n = 0; n < total; n++) {
      const j = jobs[n]
      if (limited || n >= budget) { failed++; done++; continue }
      let r
      try { r = await matchChunk(j.c, { signal: ctl.signal }) } catch (e) { if (e.name === 'AbortError') return; r = null }
      if (token !== this.snapToken) return
      done++
      if (!r?.ok) failed++
      if (r?.error === 'rate-limited' || r?.error === 'network') limited = true
      j.run.results[j.ci] = r
      this.drawSeg(j.seg)
      report(done === total ? 'done' : 'running')
    }
    if (total) report('done')
  }

  unsnap() {
    this.snapToken++
    this.abort?.abort()
    for (const seg of this.segs) { seg.runs = null; if (seg.layer) this.drawSeg(seg) }
  }
}

// ---------------------------------------------------------------------------------------------
export class MapView {
  constructor(el, { onFollowChange, onEventClick, onTimeClick, onMatchProgress } = {}) {
    this.onFollowChange = onFollowChange || (() => {})
    this.onEventClick = onEventClick || (() => {})
    this.onTimeClick = onTimeClick || (() => {})
    this.onMatchProgress = onMatchProgress || (() => {})
    this.follow = true
    this.style = 'dark'
    this.hasCentered = false
    this.snapEnabled = false

    const map = (this.map = L.map(el, {
      zoomControl: false, worldCopyJump: true, preferCanvas: true, attributionControl: true, zoomSnap: 0.5,
    }).setView([25, 10], 2))
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    map.attributionControl.setPrefix(false)

    this.provider = CARTO_KEY ? 'carto' : 'osm'
    this.tiles = makeTiles(this.provider)
    this.tiles.dark.addTo(map)
    if (this.provider === 'carto') this.watchTileErrors()

    this.liveLayer = L.layerGroup().addTo(map)
    this.histLayer = L.layerGroup()
    this.liveTrack = new TrackLayer(this)
    this.histTrack = new TrackLayer(this, { clickable: true })
    this.liveLayer.addLayer(this.liveTrack.group)
    this.liveMarker = L.marker([0, 0], { icon: icon('mk-live', '<i class="ring"></i><i class="dot"></i>', [26, 26]), interactive: false })
    this.cursor = L.marker([0, 0], { icon: icon('mk-cursor', '<i></i>', [30, 30]), interactive: false, zIndexOffset: 1000 })

    map.on('dragstart', () => this.setFollow(false))
    map.on('movestart', () => { this.panning = true })
    map.on('moveend', () => { this.panning = false })
    map.on('zoomend', () => { this.liveTrack.updateZoom(); this.histTrack.updateZoom() })
    new ResizeObserver(() => map.invalidateSize({ pan: false })).observe(el)
    this.applyPalette()
  }

  /** If CARTO tiles keep failing (bad key, referrer restriction, path change), fall back to OSM. */
  watchTileErrors() {
    let errors = 0
    const onErr = () => {
      if (++errors < 6 || this.provider !== 'carto') return
      console.warn('CARTO tiles failing — falling back to OpenStreetMap tiles. Check VITE_CARTO_KEY.')
      this.map.removeLayer(this.tiles[this.style])
      this.provider = 'osm'
      this.tiles = makeTiles('osm')
      this.tiles[this.style].addTo(this.map)
    }
    for (const t of Object.values(this.tiles)) t.on('tileerror', onErr)
  }

  setStyle(style) {
    if (style === this.style || !this.tiles[style]) return
    this.map.removeLayer(this.tiles[this.style])
    this.tiles[style].addTo(this.map)
    this.style = style
    this.applyPalette()
  }

  colors() {
    const dark = this.style === 'dark'
    return { line: dark ? '#f2f2f2' : '#111111', under: dark ? '#000000' : '#ffffff' }
  }

  applyPalette() {
    this.liveTrack.render()
    this.histTrack.render()
    this.map.getContainer().dataset.tiles = this.style
  }

  setFollow(on) {
    if (this.follow === on) return
    this.follow = on
    this.onFollowChange(on)
    if (on && this.followTarget) this.map.flyTo(this.followTarget, Math.max(this.map.getZoom(), 14), { duration: 0.8 })
  }

  // ------------------------------------------------------------------ live
  showLive() {
    this.map.removeLayer(this.histLayer)
    this.map.removeLayer(this.cursor)
    this.liveLayer.addTo(this.map)
  }

  /**
   * @param track  prebuilt live track (moving trail + parked stops)
   * @returns {{kind:'fix'|'lastfix'|'nofix', lastFixRow?:object}}
   */
  updateLive(trailRows, latest, stale, track) {
    this.liveTrack.set(track, { live: true })

    let pos = null
    let kind = 'nofix'
    let lastFixRow = null
    if (hasFix(latest)) { pos = [latest.lat, latest.lng]; kind = 'fix'; lastFixRow = latest } else {
      for (let i = trailRows.length - 1; i >= 0; i--) if (hasFix(trailRows[i])) { lastFixRow = trailRows[i]; break }
      if (lastFixRow) { pos = [lastFixRow.lat, lastFixRow.lng]; kind = 'lastfix' }
    }
    // Parked: the (sanity-checked) stop position, not the latest raw fix.
    const openStop = track.stops.find((s) => s.open)
    if (openStop && latest?.is_moving === false) pos = [openStop.lat, openStop.lng]
    // No current fix: the clean track's last position beats the last raw fix (which may be a bad average).
    else if (kind === 'lastfix' && track.lastPoint && track.lastPoint.t >= Date.parse(lastFixRow.recorded_at) - 60e3) {
      pos = [track.lastPoint.lat, track.lastPoint.lng]
    }

    if (!pos) { this.liveLayer.removeLayer(this.liveMarker); this.followTarget = null; return { kind } }
    this.liveMarker.setLatLng(pos)
    this.liveLayer.addLayer(this.liveMarker)
    const mEl = this.liveMarker.getElement()
    if (mEl) {
      mEl.classList.toggle('is-old', kind !== 'fix' || stale)
      mEl.title = kind === 'fix' ? `FIX ${fmtTime(latest.recorded_at)}` : `LAST FIX ${fmtDateTime(lastFixRow.recorded_at)}`
    }
    this.followTarget = pos
    if (!this.hasCentered) {
      this.map.setView(pos, 16, { animate: false })
      this.hasCentered = true
    } else if (this.follow) {
      this.map.panTo(pos, { animate: true, duration: 0.6 })
    }
    return { kind, lastFixRow }
  }

  resetView() { this.hasCentered = false }

  // ------------------------------------------------------------------ history
  showHistory() {
    this.map.removeLayer(this.liveLayer)
    this.histLayer.addTo(this.map)
  }

  /** @returns {boolean} whether the range has anything to draw */
  setHistory(track) {
    this.histLayer.clearLayers()
    this.histLayer.addLayer(this.histTrack.group)
    this.histTrack.set(track)
    this.eventLayer = L.layerGroup().addTo(this.histLayer)
    if (!track.kept) { this.onMatchProgress({ state: this.snapEnabled ? 'done' : 'off', done: 0, total: 0, failed: 0 }); return false }

    const a = track.firstPoint
    const b = track.lastPoint
    L.marker([a.lat, a.lng], { icon: icon('mk-start', '<i></i><b>START</b>', [14, 14]), title: `START ${fmtDateTime(a.t)}` }).addTo(this.histLayer)
    L.marker([b.lat, b.lng], { icon: icon('mk-end', '<i></i><b>END</b>', [14, 14]), title: `END ${fmtDateTime(b.t)}` }).addTo(this.histLayer)
    const bounds = L.latLngBounds([...track.moving, ...track.stops].map((p) => [p.lat, p.lng]))
    this.map.fitBounds(bounds.pad(0.15), { animate: true, maxZoom: 17 })
    if (this.snapEnabled) this.histTrack.snap(this.onMatchProgress)
    else this.onMatchProgress({ state: 'off' })
    return true
  }

  setSnap(on) {
    this.snapEnabled = on
    const attrib = this.map.attributionControl
    if (on) attrib.addAttribution(ROUTING_ATTRIB)
    else attrib.removeAttribution(ROUTING_ATTRIB)
    if (!this.histTrack.track) return
    if (on) this.histTrack.snap(this.onMatchProgress)
    else { this.histTrack.unsnap(); this.onMatchProgress({ state: 'off' }) }
  }

  setEvents(events) {
    if (!this.eventLayer) return
    this.eventLayer.clearLayers()
    for (const ev of events) {
      if (!hasFix(ev)) continue
      L.circleMarker([ev.lat, ev.lng], { radius: 4.5, color: '#ff3b30', weight: 1.5, fillColor: '#ff3b30', fillOpacity: 0.55 })
        .on('click', () => this.onEventClick(ev))
        .bindTooltip(`TILT ${fmtDateTime(ev.recorded_at)}`, { direction: 'top', offset: [0, -6], className: 'mk-tip' })
        .addTo(this.eventLayer)
    }
  }

  setCursor(row, { pan = false } = {}) {
    if (!hasFix(row)) { this.map.removeLayer(this.cursor); return false }
    this.cursor.setLatLng([row.lat, row.lng])
    if (!this.map.hasLayer(this.cursor)) this.cursor.addTo(this.map)
    this.cursor.getElement()?.classList.remove('is-lost')
    if (pan) this.map.flyTo([row.lat, row.lng], Math.max(this.map.getZoom(), 16), { duration: 0.7 })
    return true
  }

  /**
   * Playback cursor from the clean track. pos=null keeps the marker where it was, dimmed, instead of
   * removing/re-adding it (which flickers). follow=true pans only when the cursor nears the edge, and
   * never stacks a new pan on top of a running one.
   */
  setCursorPos(pos, { follow = false } = {}) {
    if (!pos) {
      this.cursor.getElement()?.classList.add('is-lost')
      return false
    }
    this.cursor.setLatLng([pos.lat, pos.lng])
    if (!this.map.hasLayer(this.cursor)) this.cursor.addTo(this.map)
    this.cursor.getElement()?.classList.remove('is-lost')
    if (follow && !this.panning && !this.map.getBounds().pad(-0.2).contains([pos.lat, pos.lng])) {
      this.map.panTo([pos.lat, pos.lng], { animate: true, duration: 0.6, easeLinearity: 0.5 })
    }
    return true
  }

  clearCursor() { this.map.removeLayer(this.cursor) }
}
