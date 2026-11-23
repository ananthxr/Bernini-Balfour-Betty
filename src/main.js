import './style.css'
import { source } from './data.js'
import { ContainerView } from './container3d.js'
import { MapView } from './map.js'
import { TimeChart } from './charts.js'
import { buildFromViews, buildFromReadings, positionAt } from './track.js'
import {
  STALE_MS, EXPECTED_LABEL, EXPECTED_SHORT, LIVE_SEED_MS, LIVE_MAX_POINTS, HISTORY_ROW_CAP, ROUTE_ROW_CAP, CUSTOM_RANGE_MAX_DAYS,
  EVENTS_PAGE_SIZE, TILT_ALARM_DEG,
} from './config.js'
import {
  DASH, isNum, fmtNum, fmtSigned, fmtAge, fmtDwell, fmtTime, fmtDateTime, fmtLat, fmtLng, fmtHeading, hasFix,
  motionOf, hdopQuality, tiltLevel, isTiltEvent, rssiQuality, containerCode, escapeHtml,
} from './format.js'

const $ = (id) => document.getElementById(id)
const store = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}

const state = {
  mode: 'live',
  device: null,
  devices: [],
  latest: null,
  liveRows: [],
  liveTrack: null,
  currentStop: null,  // newest row of the stops view (for parked-since beyond the live buffer)
  lastArrival: 0,     // when a row last ARRIVED (rows are uploaded in bursts with older GPS times)
  events24: null,
  stale: false,
  rt: { state: 'connecting' },
  liveToken: 0,
}
const h = {
  range: '24h', customFrom: null, customTo: null,
  from: 0, to: 0, rows: [], times: [], total: 0, stride: 1, cursor: -1, track: null, bands: [],
  playing: false, raf: 0, token: 0, key: null, loadedAt: 0,
  evOffset: 0, evTotal: 0, evRows: [], evToken: 0, selEv: null,
}

// ---------------------------------------------------------------- views
const app = $('app')
const view3d = new ContainerView($('threeHost'))
const map = new MapView($('map'), {
  onFollowChange: (on) => $('followBtn').classList.toggle('on', on),
  onEventClick: (ev) => selectEvent(ev),
  onTimeClick: (t) => {
    if (state.mode !== 'history') return
    stopPlay()
    setCursor(nearestIndex(h.times, t))
  },
  onMatchProgress: (p) => renderSnap(p),
})

// ---------------------------------------------------------------- road snapping toggle
const snapBtn = $('snapBtn')
function renderSnap(p) {
  const on = map.snapEnabled
  snapBtn.classList.toggle('on', on && p.state !== 'running')
  snapBtn.classList.toggle('busy', on && p.state === 'running')
  snapBtn.setAttribute('aria-pressed', String(on))
  if (!on || p.state === 'off') { snapBtn.textContent = 'SNAP TO ROADS'; return }
  if (p.state === 'running') { snapBtn.textContent = `MATCHING ${p.done}/${p.total}`; return }
  if (!p.total) { snapBtn.textContent = 'SNAP TO ROADS'; return }
  if (p.limited) snapBtn.textContent = 'MATCH UNAVAILABLE'
  else if (p.failed === p.total) snapBtn.textContent = 'NO ROAD MATCH'
  else if (p.failed) snapBtn.textContent = `ROAD-MATCHED ${p.total - p.failed}/${p.total}`
  else snapBtn.textContent = 'ROAD-MATCHED'
}
map.setSnap(store.get('snap') !== 'off')
renderSnap({ state: 'off' })
snapBtn.addEventListener('click', () => {
  const on = !map.snapEnabled
  store.set('snap', on ? 'on' : 'off')
  map.setSnap(on)
  if (!on) renderSnap({ state: 'off' })
})

// ---------------------------------------------------------------- charts
const charts = {}
let hoverRaf = 0
let hoverMs = null
for (const sec of document.querySelectorAll('.panel-chart')) {
  const kind = sec.dataset.chart
  const c = new TimeChart(sec.querySelector('canvas'), kind, {
    onHover: (ms) => {
      if (state.mode !== 'history' || h.playing) return
      hoverMs = ms
      if (!hoverRaf) hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; setCursor(nearestIndex(h.times, hoverMs)) })
    },
  })
  c.empty = sec.querySelector('.chart-empty')
  charts[kind] = c
  sec.querySelectorAll('.legend button').forEach((b) => b.addEventListener('click', () => {
    const p = c.pin(Number(b.dataset.i))
    sec.querySelectorAll('.legend button').forEach((x) => x.classList.toggle('on', Number(x.dataset.i) === p))
  }))
}
const allCharts = () => Object.values(charts)

function renderCharts(rows, animate, { stride = 1, bands = [] } = {}) {
  for (const c of allCharts()) {
    c.render(rows, { animate, stride, bands })
    c.empty.hidden = c.hasData(rows)
  }
}

/** Parked periods as chart bands (not for legacy estimates — those aren't measured motion). */
function bandsOf(track, from = -Infinity, to = Infinity) {
  if (!track || track.legacy) return []
  const now = Date.now()
  return track.stops
    .map((s) => [Math.max(s.start, from), Math.min(s.end ?? (s.open ? now : s.start), to)])
    .filter(([a, b]) => b > a)
}

// ---------------------------------------------------------------- toast
const toastEl = Object.assign(document.createElement('div'), { className: 'toast mono', hidden: true })
document.body.appendChild(toastEl)
let toastT = 0
function toast(msg, { sticky = false } = {}) {
  toastEl.textContent = msg
  toastEl.hidden = false
  toastEl.classList.toggle('sticky', sticky)
  clearTimeout(toastT)
  if (!sticky) toastT = setTimeout(() => { toastEl.hidden = true }, 4200)
}
toastEl.addEventListener('click', () => { toastEl.hidden = true })

function explain(e) {
  const m = String(e?.message || e)
  if (/invalid api key|jwt|401|unauthorized|no api key/i.test(m)) {
    return 'SUPABASE REJECTED THE KEY (401) · set VITE_SUPABASE_KEY in .env to the publishable key (sb_publishable_…) or legacy anon key (eyJ…), then restart npm run dev'
  }
  if (/failed to fetch|network/i.test(m)) return `CANNOT REACH SUPABASE · ${m}`
  return m
}

// ---------------------------------------------------------------- devices
const deviceSel = $('deviceSel')
function fillDevices() {
  deviceSel.replaceChildren()
  if (!state.devices.length) {
    deviceSel.append(new Option('NO DEVICES', '', true, true))
    deviceSel.disabled = true
    return
  }
  deviceSel.disabled = false
  for (const d of state.devices) deviceSel.append(new Option(d, d, false, d === state.device))
}
deviceSel.addEventListener('change', () => selectDevice(deviceSel.value))

async function selectDevice(id) {
  if (!id) return
  state.device = id
  store.set('device', id)
  deviceSel.value = id
  const code = containerCode(id)
  $('unitCode').textContent = `${code.text} ${code.check} · ${id.toUpperCase()}`
  view3d.setDevice(id)
  Object.assign(state, { latest: null, liveRows: [], liveTrack: null, currentStop: null, lastArrival: 0, events24: null })
  h.key = null
  map.resetView()
  renderLatest()
  await loadLive()
  if (state.mode === 'history') loadHistory()
}

// ---------------------------------------------------------------- live
function mergeLiveRow(row) {
  const rows = state.liveRows
  const t = Date.parse(row.recorded_at)
  if (rows.some((r) => r.id === row.id)) return false
  if (!rows.length || t >= Date.parse(rows[rows.length - 1].recorded_at)) rows.push(row)
  else {
    const i = rows.findIndex((r) => Date.parse(r.recorded_at) > t)
    rows.splice(i < 0 ? rows.length : i, 0, row)
  }
  while (rows.length > LIVE_MAX_POINTS) rows.shift()
  return true
}

const parseStop = (s) => s && ({
  start: Date.parse(s.arrived_at), end: s.departed_at ? Date.parse(s.departed_at) : null, open: !s.departed_at,
})

async function loadLive() {
  const token = ++state.liveToken
  const id = state.device
  const now = Date.now()
  try {
    const [latest, series, ev24, stop] = await Promise.all([
      source.getLatest(id),
      source.getSeries(id, now - LIVE_SEED_MS, now, LIVE_MAX_POINTS),
      source.countEvents(id, now - 864e5, now).catch(() => null),
      source.getLatestStop(id).catch(() => null),
    ])
    if (token !== state.liveToken) return
    state.latest = latest
    state.liveRows = series.rows
    state.events24 = ev24
    state.currentStop = parseStop(stop)
    state.lastArrival = latest ? Date.parse(latest.recorded_at) : 0
    if (latest) mergeLiveRow(latest)
  } catch (e) {
    if (token !== state.liveToken) return
    toast(`LOAD FAILED · ${explain(e)}`, { sticky: true })
  }
  rebuildLiveTrack()
  tick()
  renderLatest()
  if (state.mode === 'live') {
    renderCharts(state.liveRows, true, { bands: bandsOf(state.liveTrack) })
    renderLiveMap()
    poseLive()
  }
}

function onRow(row) {
  if (!row?.device_id) return
  if (!state.devices.includes(row.device_id)) {
    state.devices = [...state.devices, row.device_id].sort()
    fillDevices()
    if (!state.device) { selectDevice(row.device_id); return }
  }
  if (row.device_id !== state.device) return
  state.lastArrival = Date.now()
  const added = mergeLiveRow(row)
  if (!added) return
  const newest = !state.latest || Date.parse(row.recorded_at) >= Date.parse(state.latest.recorded_at)
  if (newest) state.latest = row
  if (isTiltEvent(row) && state.events24 != null) state.events24++
  view3d.pulse()
  rebuildLiveTrack()
  tick()
  renderLatest()
  if (state.mode === 'live') {
    const bands = bandsOf(state.liveTrack)
    for (const c of allCharts()) { c.append(row, LIVE_MAX_POINTS); c.setBands(bands); c.empty.hidden = c.hasData(state.liveRows) }
    renderLiveMap()
    poseLive()
  }
}

async function backfill() {
  const id = state.device
  if (!id) return
  const since = state.latest ? Date.parse(state.latest.recorded_at) : Date.now() - LIVE_SEED_MS
  try {
    const [rows, latest, stop] = await Promise.all([
      source.getSince(id, since), source.getLatest(id), source.getLatestStop(id).catch(() => null),
    ])
    if (id !== state.device) return
    for (const r of rows) {
      if (mergeLiveRow(r) && state.mode === 'live') allCharts().forEach((c) => c.append(r, LIVE_MAX_POINTS))
      if (isTiltEvent(r) && state.events24 != null) state.events24++
    }
    if (latest && (!state.latest || Date.parse(latest.recorded_at) >= Date.parse(state.latest.recorded_at))) state.latest = latest
    state.currentStop = parseStop(stop)
    if (rows.length) state.lastArrival = Date.now()
    rebuildLiveTrack()
    tick()
    renderLatest()
    if (state.mode === 'live') { renderLiveMap(); poseLive() }
  } catch (e) {
    toast(`BACKFILL FAILED · ${e.message}`)
  }
}

function onStatus(s) {
  state.rt = s
  app.dataset.rt = s.state
  $('rtState').dataset.state = s.state
  renderRt()
  if (s.state === 'live' && s.reconnected) backfill()
}

function renderRt() {
  const s = state.rt
  let label = 'CONNECTING'
  if (s.state === 'live') label = source.demo ? 'SIMULATED' : 'REALTIME'
  if (s.state === 'down') {
    const secs = s.retryAt ? Math.max(0, Math.ceil((s.retryAt - Date.now()) / 1000)) : 0
    label = secs ? `OFFLINE · RETRY ${secs}s` : 'RECONNECTING'
  }
  $('rtState').querySelector('.rt-label').textContent = label
  $('rtState').title = s.error ? `Realtime: ${s.error}` : 'Realtime connection'
}

/** Live track from the buffer; an open stop that began before the buffer gets the server's arrival time. */
function rebuildLiveTrack() {
  const track = buildFromReadings(state.liveRows)
  const cs = state.currentStop
  const open = track.stops.find((s) => s.open)
  if (open && cs && !track.legacy && cs.start < open.start && (cs.open || (cs.end ?? 0) >= open.start - 6 * 60e3)) open.start = cs.start
  state.liveTrack = track
  $('lgLegacy').hidden = !track.legacy
}

// ---------------------------------------------------------------- motion
/** { st, since } — since = when the current state began (null = before the live buffer). */
function motionInfo() {
  const r = state.latest
  if (!r) return { st: 'none' }
  const st = motionOf(r)
  if (st === 'unknown') return { st }
  const rows = state.liveRows
  let i = rows.length - 1
  while (i >= 0 && motionOf(rows[i]) === st) i--
  let since = i >= 0 && rows[i + 1] ? Date.parse(rows[i + 1].recorded_at) : null
  if (st === 'parked') {
    const open = state.liveTrack?.stops.find((s) => s.open)
    if (open && (since === null || open.start < since)) since = open.start
  }
  return { st, since, bufferStart: rows.length ? Date.parse(rows[0].recorded_at) : null }
}

function renderMotion() {
  const card = document.querySelector('[data-card="motion"]')
  const m = motionInfo()
  const r = state.latest
  const now = Date.now()
  card.dataset.state = m.st === 'none' ? 'unknown' : m.st
  $('cMotionSrc').hidden = m.st === 'unknown' || m.st === 'none'
  if (m.st === 'none') { $('cMotion').textContent = state.device ? 'NO DATA' : DASH; $('cMotionSub').textContent = DASH; return }
  if (m.st === 'unknown') {
    $('cMotion').textContent = 'NO MOTION DATA'
    $('cMotionSub').textContent = 'is_moving NOT REPORTED · PRE-v2 FIRMWARE?'
    return
  }
  const dur = m.since ? fmtDwell(now - m.since) : m.bufferStart ? `> ${fmtDwell(now - m.bufferStart)}` : DASH
  if (m.st === 'moving') {
    $('cMotion').textContent = 'MOVING'
    $('cMotionSub').textContent = `FOR ${dur}${isNum(r.speed_kmph) ? ` · ${fmtNum(r.speed_kmph, 0)} KM/H` : ''}${isNum(r.heading) ? ` · ${fmtHeading(r.heading)}` : ''}`
  } else {
    $('cMotion').textContent = 'PARKED'
    $('cMotionSub').textContent = `FOR ${dur}${m.since ? ` · SINCE ${fmtTime(m.since)}` : ''}`
  }
}

// ---------------------------------------------------------------- cards
function setVal(id, text, nodata = false) {
  const el = $(id)
  el.textContent = text
  el.closest('.card-v')?.classList.toggle('nodata', nodata)
}

function gauge(el, v) {
  if (!isNum(v)) { el.style.width = '0'; el.style.left = '50%'; el.className = 'g-bar'; return }
  const pct = (Math.max(-45, Math.min(45, v)) / 45) * 50
  el.style.left = `${pct >= 0 ? 50 : 50 + pct}%`
  el.style.width = `${Math.abs(pct)}%`
  el.className = `g-bar ${tiltLevel(v, 0) === 'alarm' ? 'alarm' : tiltLevel(v, 0) === 'warn' ? 'warn' : ''}`
}

function renderLatest() {
  const r = state.latest
  const none = !r
  renderMotion()

  // Tilt
  const level = none ? 'none' : tiltLevel(r.roll, r.pitch)
  document.querySelector('[data-card="tilt"]').dataset.level = level
  $('cRoll').textContent = none ? DASH : isNum(r.roll) ? `${fmtSigned(r.roll, 1)}°` : 'NO DATA'
  $('cPitch').textContent = none ? DASH : isNum(r.pitch) ? `${fmtSigned(r.pitch, 1)}°` : 'NO DATA'
  gauge($('gRoll'), r?.roll)
  gauge($('gPitch'), r?.pitch)
  $('cTiltState').textContent = { none: 'NO DATA', ok: 'OK', warn: 'WARN', alarm: 'ALARM' }[level]
  $('cTiltSub').textContent = `EVENTS 24H ${state.events24 ?? DASH}${source.mountCorrected ? ' · MOUNT-CORR.' : ''}`
  $('cTiltSub').title = source.mountCorrected ? 'Angles are container-frame: corrected for the vertically mounted board (see MOUNT in src/config.js)' : ''

  // Temperature (IMU internal sensor — indicative) + humidity
  if (none) setVal('cTemp', DASH)
  else if (isNum(r.temp_c)) setVal('cTemp', fmtNum(r.temp_c, 1))
  else setVal('cTemp', 'NO DATA', true)
  $('cHum').textContent = none ? DASH : isNum(r.humidity) ? `RH ${fmtNum(r.humidity, 0)}%` : 'RH NO SENSOR'

  // GPS fix quality: fix + satellites + HDOP
  const fix = hasFix(r)
  const gpsEl = $('cGps')
  gpsEl.textContent = none ? DASH : fix ? 'FIX' : 'NO FIX'
  gpsEl.classList.toggle('nodata', !none && !fix)
  const hq = hdopQuality(r?.hdop)
  const chip = $('cGpsQ')
  chip.textContent = none || !fix ? DASH : hq.label
  chip.dataset.q = hq.cls || ''
  const n = isNum(r?.sats) ? Math.min(12, r.sats) : 0
  $('satBars').replaceChildren(...Array.from({ length: 12 }, (_, i) => Object.assign(document.createElement('i'), { className: i < n ? 'on' : '' })))
  let gpsSub = DASH
  if (!none) {
    const sats = isNum(r.sats) ? `${r.sats} SATS` : 'SATS —'
    const hdop = isNum(r.hdop) ? `HDOP ${fmtNum(r.hdop, 1)}` : 'HDOP —'
    if (fix) gpsSub = `${sats} · ${hdop}`
    else {
      const last = [...state.liveRows].reverse().find(hasFix)
      gpsSub = `${sats} · ${last ? `LAST FIX ${fmtTime(last.recorded_at)}` : 'NO POSITION'}`
    }
  }
  $('cGpsSub').textContent = gpsSub

  // Speed (Doppler) + heading
  if (none) setVal('cSpeed', DASH)
  else if (isNum(r.speed_kmph)) setVal('cSpeed', fmtNum(r.speed_kmph, 1))
  else setVal('cSpeed', 'NO DATA', true)
  const arrow = $('hdgArrow')
  if (isNum(r?.heading)) {
    arrow.classList.remove('none')
    arrow.style.transform = `rotate(${r.heading}deg)`
    $('cHeading').textContent = `HDG ${fmtHeading(r.heading)}`
  } else {
    arrow.classList.add('none')
    $('cHeading').textContent = none ? 'HDG —' : r.is_moving === false ? 'HDG — · PARKED' : 'HDG —'
  }

  // RSSI
  const q = rssiQuality(r?.rssi)
  if (none) setVal('cRssi', DASH)
  else if (isNum(r.rssi)) setVal('cRssi', String(r.rssi))
  else setVal('cRssi', 'NO DATA', true)
  $('rssiBars').dataset.n = q.bars
  $('cRssiQ').textContent = none ? DASH : q.label
}

// ---------------------------------------------------------------- attitude overlay
function setAtt(r, { label, stale = false } = {}) {
  const att = $('att')
  const level = r ? tiltLevel(r.roll, r.pitch) : 'none'
  att.dataset.level = stale ? 'none' : level
  att.classList.toggle('is-stale', stale)
  $('attRoll').textContent = r && isNum(r.roll) ? `${fmtSigned(r.roll, 1)}°` : DASH
  $('attPitch').textContent = r && isNum(r.pitch) ? `${fmtSigned(r.pitch, 1)}°` : DASH
  $('attHdg').textContent = r && isNum(r.heading) ? fmtHeading(r.heading) : r?.is_moving === false ? '— PARKED' : DASH
  $('attState').textContent = stale
    ? 'STALE · LAST KNOWN POSE'
    : { none: 'NO DATA', ok: 'LEVEL · WITHIN LIMITS', warn: `WARNING · NEAR ${TILT_ALARM_DEG}°`, alarm: `TILT ALARM · >${TILT_ALARM_DEG}°` }[level]
  const sync = $('syncTilt').checked
  $('poseMeta').textContent = `${label}${sync ? '' : ' · SYNC OFF'}`
}

function poseLive() {
  const r = state.latest
  view3d.setTilt(r?.roll, r?.pitch)
  view3d.setHeading(r?.heading)
  view3d.setStale(state.stale)
  setAtt(r, { label: r ? `LIVE · ${fmtTime(r.recorded_at)}` : 'LIVE', stale: state.stale })
}

// ---------------------------------------------------------------- live map
function renderLiveMap() {
  const r = state.latest
  const res = map.updateLive(state.liveRows, r, state.stale, state.liveTrack || buildFromReadings([]))
  const flag = $('mapFlag')
  const readout = $('mapReadout')
  const st = motionOf(r)
  if (res.kind === 'fix') {
    flag.hidden = true
    readout.innerHTML = `${fmtLat(r.lat)}&nbsp;&nbsp;${fmtLng(r.lng)}`
    const hdop = isNum(r.hdop) ? ` · HDOP ${fmtNum(r.hdop, 1)}` : ''
    $('mapMeta').textContent = st === 'parked'
      ? `PARKED · AVERAGED POSITION${hdop}`
      : `${isNum(r.sats) ? r.sats : DASH} SATS${hdop} · ${isNum(r.speed_kmph) ? fmtNum(r.speed_kmph, 1) : DASH} KM/H`
  } else if (res.kind === 'lastfix') {
    flag.hidden = false
    flag.innerHTML = `NO GPS FIX<small>showing last known position · ${fmtTime(res.lastFixRow.recorded_at)}</small>`
    readout.innerHTML = `<span class="muted">LAST</span> ${fmtLat(res.lastFixRow.lat)}&nbsp;&nbsp;${fmtLng(res.lastFixRow.lng)}`
    $('mapMeta').textContent = 'NO FIX'
  } else {
    flag.hidden = false
    flag.innerHTML = r ? 'NO GPS FIX<small>no position in the last 2 h</small>' : 'NO DATA'
    readout.textContent = 'NO FIX'
    $('mapMeta').textContent = r ? 'NO FIX' : DASH
  }
}

// ---------------------------------------------------------------- stale + clock
function tick() {
  const now = Date.now()
  $('clock').textContent = fmtTime(now)
  const r = state.latest
  const st = motionOf(r)
  const recAge = r ? now - Date.parse(r.recorded_at) : null
  if (r) {
    setVal('cAge', fmtAge(recAge))
    $('cAgeSub').textContent = `${fmtTime(r.recorded_at)} · ${EXPECTED_SHORT[st]}`
  } else {
    setVal('cAge', state.device ? 'NO DATA' : DASH, !!state.device)
    $('cAgeSub').textContent = DASH
  }
  // Stale: nothing has ARRIVED for 2× the expected interval of the current motion state.
  const lastSeen = r ? Math.max(state.lastArrival, Date.parse(r.recorded_at)) : 0
  const silence = now - lastSeen
  const limit = STALE_MS[st]
  const stale = !!r && silence > limit
  if (stale !== state.stale) {
    state.stale = stale
    $('cards').classList.toggle('is-stale', stale)
    $('staleBadge').hidden = !stale
    $('staleBanner').hidden = !stale
    if (state.mode === 'live') { poseLive(); renderLiveMap() }
  }
  if (stale) {
    $('staleBadge').textContent = `STALE · last seen ${fmtAge(silence)} ago`
    $('staleBanner').innerHTML = `<b>STALE</b>NOTHING RECEIVED FOR ${escapeHtml(fmtAge(silence))} · LAST READING ${escapeHtml(fmtDateTime(r.recorded_at))} · EXPECTED ${escapeHtml(EXPECTED_LABEL[st])} — VALUES BELOW ARE NOT CURRENT`
  }
  if (r) renderMotion()
  if (state.rt.state === 'down') renderRt()
}
setInterval(tick, 1000)

// ---------------------------------------------------------------- history
function rangeBounds() {
  const now = Date.now()
  switch (h.range) {
    case '1h': return [now - 3600e3, now]
    case '7d': return [now - 7 * 864e5, now]
    case 'custom': return [h.customFrom, h.customTo]
    default: return [now - 864e5, now]
  }
}

function drawHistory(animate) {
  renderCharts(h.rows, animate, { stride: h.stride, bands: h.bands })
  const any = map.setHistory(h.track)
  map.setEvents(h.evRows)
  $('lgLegacy').hidden = !h.track.legacy
  const flag = $('mapFlag')
  flag.hidden = any
  flag.innerHTML = h.rows.length ? 'NO ROUTE<small>no moving GPS points or stops in this range</small>' : 'NO DATA<small>no readings in this range</small>'
  $('mapMeta').textContent = any
    ? `${h.track.segments.length} SEGMENT${h.track.segments.length === 1 ? '' : 'S'} · ${h.track.stops.length} STOP${h.track.stops.length === 1 ? '' : 'S'}${h.track.legacy ? ' · ESTIMATED' : ''}`
    : DASH
}

async function loadHistory({ force = false } = {}) {
  if (!state.device) return
  const key = `${state.device}|${h.range}|${h.customFrom}|${h.customTo}`
  if (!force && key === h.key && Date.now() - h.loadedAt < 120e3 && h.track) {
    drawHistory(true)
    setCursor(h.cursor)
    return
  }
  const [from, to] = rangeBounds()
  if (!isNum(from) || !isNum(to)) return
  const token = ++h.token
  stopPlay()
  const meta = $('histMeta')
  meta.classList.remove('err')
  meta.textContent = 'LOADING…'
  let series
  let route
  let stops
  try {
    [series, route, stops] = await Promise.all([
      source.getSeries(state.device, from, to, HISTORY_ROW_CAP),
      source.getRoute(state.device, from, to, ROUTE_ROW_CAP),
      source.getStops(state.device, from, to),
    ])
  } catch (e) {
    if (token !== h.token) return
    meta.classList.add('err')
    meta.textContent = `QUERY FAILED · ${explain(e)}`
    return
  }
  if (token !== h.token || state.mode !== 'history') return

  // v2 views first. If they're empty but readings have fixes (rows without is_moving), estimate.
  let track = buildFromViews(route.rows, stops)
  if (!track.kept && series.rows.some(hasFix)) track = buildFromReadings(series.rows)

  Object.assign(h, {
    key, loadedAt: Date.now(), from, to, rows: series.rows, total: series.total, stride: series.stride, track,
    bands: bandsOf(track, from, to),
  })
  h.times = h.rows.map((r) => Date.parse(r.recorded_at))
  h.evRows = []
  drawHistory(true)

  const parts = [`${h.total.toLocaleString()} READINGS`]
  if (h.stride > 1.05) parts.push(`CHARTS SAMPLED 1:${Math.round(h.stride)}`)
  if (track.legacy) parts.push('ROUTE ESTIMATED · NO is_moving')
  else {
    parts.push(`${route.total.toLocaleString()} ROUTE PTS${route.stride > 1.05 ? ` (1:${Math.round(route.stride)})` : ''}`)
    parts.push(`${track.stops.length} STOPS`)
  }
  meta.innerHTML = parts.map(escapeHtml).join('<span class="sep">/</span>')

  const scrub = $('scrub')
  scrub.max = String(Math.max(0, h.rows.length - 1))
  scrub.disabled = h.rows.length < 2
  $('playBtn').disabled = h.rows.length < 2
  h.selEv = null
  if (h.rows.length) setCursor(h.rows.length - 1)
  else { $('scrubTime').textContent = DASH; map.clearCursor(); view3d.setTilt(null, null); setAtt(null, { label: 'REPLAY' }); allCharts().forEach((c) => c.setCursor(null)) }
  loadEvents(0)
}

function nearestIndex(times, t) {
  if (!times.length || !isNum(t)) return -1
  let lo = 0
  let hi = times.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (times[mid] < t) lo = mid
    else hi = mid
  }
  return Math.abs(times[lo] - t) <= Math.abs(times[hi] - t) ? lo : hi
}

function setCursor(i, { follow = false } = {}) {
  if (!h.rows.length || i < 0) return
  i = Math.max(0, Math.min(h.rows.length - 1, i))
  h.cursor = i
  const r = h.rows[i]
  $('scrub').value = String(i)
  $('scrubTime').textContent = fmtDateTime(r.recorded_at)
  allCharts().forEach((c) => c.setCursor(h.times[i]))
  // Position from the clean track (interpolated route / stop), never the raw row: parked rows can
  // carry bad on-device averages that would throw the map across the world on every step.
  const pos = positionAt(h.track, h.times[i])
  map.setCursorPos(pos, { follow })
  $('mapReadout').innerHTML = pos
    ? `${fmtLat(pos.lat)}&nbsp;&nbsp;${fmtLng(pos.lng)} <span class="muted">${pos.kind.toUpperCase()}</span>`
    : `<span class="muted">NO POSITION</span> ${fmtTime(r.recorded_at)}`
  view3d.setTilt(r.roll, r.pitch)
  view3d.setHeading(r.heading)
  setAtt(r, { label: `REPLAY · ${fmtDateTime(r.recorded_at)}` })
}

function startPlay() {
  if (h.rows.length < 2) return
  if (h.cursor >= h.rows.length - 1) setCursor(0)
  h.playing = true
  $('playBtn').classList.add('playing')
  const rate = Math.max(2, h.rows.length / 30) // full range in ~30 s
  let acc = h.cursor
  let last = performance.now()
  const step = (now) => {
    if (!h.playing) return
    acc += ((now - last) / 1000) * rate
    last = now
    const i = Math.min(h.rows.length - 1, Math.floor(acc))
    if (i !== h.cursor) setCursor(i, { follow: true })
    if (i >= h.rows.length - 1) { stopPlay(); return }
    h.raf = requestAnimationFrame(step)
  }
  h.raf = requestAnimationFrame(step)
}
function stopPlay() {
  h.playing = false
  cancelAnimationFrame(h.raf)
  $('playBtn').classList.remove('playing')
}

// ---------------------------------------------------------------- tilt events (tilt_events view)
const EV_COLS = 8
async function loadEvents(offset) {
  const token = ++h.evToken
  const body = $('evBody')
  body.innerHTML = `<tr class="ev-empty"><td colspan="${EV_COLS}">LOADING…</td></tr>`
  let res
  try {
    res = await source.getEvents(state.device, h.from, h.to, offset, EVENTS_PAGE_SIZE)
  } catch (e) {
    if (token !== h.evToken) return
    body.innerHTML = `<tr class="ev-empty"><td colspan="${EV_COLS}">QUERY FAILED · ${escapeHtml(explain(e))}</td></tr>`
    return
  }
  if (token !== h.evToken) return
  h.evOffset = offset
  h.evRows = res.rows
  h.evTotal = res.total
  renderEvents()
  map.setEvents(res.rows)
}

function renderEvents() {
  const body = $('evBody')
  const { evRows: rows, evOffset: off, evTotal: total } = h
  $('evMeta').textContent = `${total.toLocaleString()} EVENT${total === 1 ? '' : 'S'} · |ROLL| OR |PITCH| > ${TILT_ALARM_DEG}°`
  $('evPage').textContent = total ? `${off + 1}–${off + rows.length} OF ${total.toLocaleString()}` : '0 OF 0'
  $('evPrev').disabled = off === 0
  $('evNext').disabled = off + rows.length >= total
  if (!rows.length) {
    body.innerHTML = `<tr class="ev-empty"><td colspan="${EV_COLS}">NO TILT EVENTS IN THIS RANGE</td></tr>`
    return
  }
  const hot = (v) => (isNum(v) && Math.abs(v) > TILT_ALARM_DEG ? ' hot' : '')
  body.innerHTML = rows.map((ev) => {
    const peak = isNum(ev.max_angle) ? ev.max_angle : Math.max(Math.abs(ev.roll || 0), Math.abs(ev.pitch || 0))
    // Parked events: use the sanity-checked stop position, not the raw (possibly bad) average.
    const p = ev.is_moving !== false && hasFix(ev) ? ev : positionAt(h.track, Date.parse(ev.recorded_at))
    const fix = !!p
    const loc = fix ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : '<span class="muted">NO FIX</span>'
    const link = fix
      ? `<a class="ext" href="https://www.openstreetmap.org/?mlat=${p.lat.toFixed(6)}&amp;mlon=${p.lng.toFixed(6)}#map=17/${p.lat.toFixed(6)}/${p.lng.toFixed(6)}" target="_blank" rel="noopener noreferrer">OSM ↗</a>`
      : '<span class="muted">—</span>'
    const st = motionOf(ev)
    return `<tr data-id="${ev.id}" class="${ev.id === h.selEv ? 'sel' : ''}">
      <td>${escapeHtml(fmtDateTime(ev.recorded_at))}</td>
      <td class="num${hot(ev.roll)}">${isNum(ev.roll) ? `${fmtSigned(ev.roll, 1)}°` : DASH}</td>
      <td class="num${hot(ev.pitch)}">${isNum(ev.pitch) ? `${fmtSigned(ev.pitch, 1)}°` : DASH}</td>
      <td class="num hot">${fmtNum(peak, 1)}°</td>
      <td class="st">${st === 'unknown' ? DASH : st.toUpperCase()}</td>
      <td>${loc}</td>
      <td>${link}</td>
      <td class="go">VIEW →</td>
    </tr>`
  }).join('')
}

$('evBody').addEventListener('click', (e) => {
  if (e.target.closest('a')) return // external map link
  const tr = e.target.closest('tr[data-id]')
  if (!tr) return
  const ev = h.evRows.find((r) => String(r.id) === tr.dataset.id)
  if (ev) selectEvent(ev)
})
$('evPrev').addEventListener('click', () => loadEvents(Math.max(0, h.evOffset - EVENTS_PAGE_SIZE)))
$('evNext').addEventListener('click', () => loadEvents(h.evOffset + EVENTS_PAGE_SIZE))

function selectEvent(ev) {
  stopPlay()
  h.selEv = ev.id
  document.querySelectorAll('#evBody tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.id === String(ev.id)))
  const t = Date.parse(ev.recorded_at)
  const i = nearestIndex(h.times, t)
  if (i >= 0) { h.cursor = i; $('scrub').value = String(i) }
  allCharts().forEach((c) => c.setCursor(t))
  $('scrubTime').textContent = fmtDateTime(ev.recorded_at)
  // Moving events keep their own fix; parked ones use the (sanity-checked) stop position.
  const pos = (ev.is_moving !== false && hasFix(ev) ? { lat: ev.lat, lng: ev.lng, kind: 'moving' } : null) || positionAt(h.track, t)
  const fix = !!pos && map.setCursor(pos, { pan: true })
  $('mapReadout').innerHTML = fix ? `${fmtLat(pos.lat)}&nbsp;&nbsp;${fmtLng(pos.lng)}` : `<span class="muted">NO POSITION</span> ${fmtTime(ev.recorded_at)}`
  if (!fix) toast('NO POSITION FOR THIS EVENT')
  view3d.setTilt(ev.roll, ev.pitch)
  const near = i >= 0 && Math.abs(h.times[i] - t) < 120e3 ? h.rows[i] : null
  if (near) view3d.setHeading(near.heading)
  setAtt({ ...ev, heading: near?.heading ?? null }, { label: `EVENT · ${fmtDateTime(ev.recorded_at)}` })
  if (window.innerWidth <= 1100) document.querySelector('.panel-3d').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ---------------------------------------------------------------- mode + controls
function setMode(m) {
  if (m === state.mode) return
  state.mode = m
  app.dataset.mode = m
  document.querySelectorAll('#modeSeg button').forEach((b) => {
    const on = b.dataset.mode === m
    b.classList.toggle('on', on)
    b.setAttribute('aria-selected', String(on))
  })
  $('histBar').hidden = m !== 'history'
  $('eventsPanel').hidden = m !== 'history'
  if (m === 'history') {
    map.showHistory()
    view3d.setStale(false)
    loadHistory()
  } else {
    stopPlay()
    h.token++
    map.showLive()
    map.clearCursor()
    allCharts().forEach((c) => c.setCursor(null))
    $('lgLegacy').hidden = !state.liveTrack?.legacy
    renderCharts(state.liveRows, true, { bands: bandsOf(state.liveTrack) })
    renderLiveMap()
    poseLive()
  }
}
document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)))

const toLocalInput = (ms) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}
document.querySelectorAll('#rangeSeg button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#rangeSeg button').forEach((x) => x.classList.toggle('on', x === b))
  h.range = b.dataset.range
  const custom = h.range === 'custom'
  $('customForm').hidden = !custom
  if (custom) {
    const now = Date.now()
    $('toInp').max = $('fromInp').max = toLocalInput(now)
    if (!$('fromInp').value) $('fromInp').value = toLocalInput(now - 864e5)
    if (!$('toInp').value) $('toInp').value = toLocalInput(now)
  } else loadHistory({ force: true })
}))
$('customForm').addEventListener('submit', (e) => {
  e.preventDefault()
  const from = new Date($('fromInp').value).getTime()
  const to = new Date($('toInp').value).getTime()
  const meta = $('histMeta')
  meta.classList.add('err')
  if (!isNum(from) || !isNum(to)) { meta.textContent = 'INVALID DATE'; return }
  if (to <= from) { meta.textContent = 'END MUST BE AFTER START'; return }
  if (to - from > CUSTOM_RANGE_MAX_DAYS * 864e5) { meta.textContent = `MAX RANGE IS ${CUSTOM_RANGE_MAX_DAYS} DAYS`; return }
  meta.classList.remove('err')
  h.customFrom = from
  h.customTo = Math.min(to, Date.now())
  loadHistory({ force: true })
})

$('scrub').addEventListener('input', (e) => { stopPlay(); setCursor(Number(e.target.value), { follow: true }) })
$('playBtn').addEventListener('click', () => (h.playing ? stopPlay() : startPlay()))

$('syncTilt').addEventListener('change', (e) => {
  view3d.setSync(e.target.checked)
  const pm = $('poseMeta')
  pm.textContent = e.target.checked ? pm.textContent.replace(' · SYNC OFF', '') : `${pm.textContent.replace(' · SYNC OFF', '')} · SYNC OFF`
})

$('followBtn').addEventListener('click', () => map.setFollow(!map.follow))

function setTiles(style) {
  map.setStyle(style)
  store.set('tiles', style)
  document.querySelectorAll('#tileSeg button').forEach((b) => b.classList.toggle('on', b.dataset.style === style))
}
document.querySelectorAll('#tileSeg button').forEach((b) => b.addEventListener('click', () => setTiles(b.dataset.style)))
if (store.get('tiles') === 'light') setTiles('light')

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.rt.state === 'live') backfill()
})

// ---------------------------------------------------------------- boot
async function boot() {
  $('demoBadge').hidden = !source.demo
  renderLatest()
  tick()
  source.subscribe({ onRow, onStatus })
  let listFailed = false
  try {
    state.devices = await source.listDevices()
  } catch (e) {
    listFailed = true
    toast(`DEVICE LIST FAILED · ${explain(e)}`, { sticky: true })
    console.error(e)
    state.devices = []
  }
  const saved = store.get('device')
  const pick = state.devices.includes(saved) ? saved : state.devices[0]
  state.device = pick || null
  fillDevices()
  if (pick) await selectDevice(pick)
  else {
    rebuildLiveTrack()
    renderCharts([], false)
    renderLiveMap()
    poseLive()
    if (!listFailed) toast('NO READINGS YET · WAITING FOR FIRST DEVICE')
  }
}
boot()
