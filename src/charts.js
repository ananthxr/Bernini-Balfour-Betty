import {
  Chart, LineController, LineElement, PointElement, LinearScale, TimeScale, Tooltip, Filler,
} from 'chart.js'
import 'chartjs-adapter-date-fns'
import { TILT_ALARM_DEG } from './config.js'
import { isNum, fmtSigned, fmtNum } from './format.js'

Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Tooltip, Filler)

const MONO = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace'
const C = {
  grid: '#1b1b1b',
  axis: '#2a2a2a',
  tick: '#6f6f6f',
  white: '#ededed',
  grey: '#8c8c8c',
  accent: '#ff7a1a',
  alarm: '#ff3b30',
}
Chart.defaults.font.family = MONO
Chart.defaults.font.size = 10
Chart.defaults.color = C.tick

// ---------------------------------------------------------------- plugins
const cursorLine = {
  id: 'cursorLine',
  afterDatasetsDraw(chart) {
    const x = chart.$cursor
    if (!isNum(x)) return
    const { ctx, chartArea: a, scales } = chart
    const px = scales.x.getPixelForValue(x)
    if (px < a.left || px > a.right) return
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(Math.round(px) + 0.5, a.top)
    ctx.lineTo(Math.round(px) + 0.5, a.bottom)
    ctx.stroke()
    ctx.restore()
  },
}

const limitLines = {
  id: 'limitLines',
  beforeDatasetsDraw(chart, _args, opts) {
    if (!opts?.value) return
    const { ctx, chartArea: a, scales } = chart
    ctx.save()
    ctx.font = `500 9px ${MONO}`
    for (const v of [opts.value, -opts.value]) {
      const y = scales.y.getPixelForValue(v)
      if (y < a.top || y > a.bottom) continue
      ctx.strokeStyle = 'rgba(255,59,48,0.38)'
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(a.left, Math.round(y) + 0.5)
      ctx.lineTo(a.right, Math.round(y) + 0.5)
      ctx.stroke()
      ctx.fillStyle = 'rgba(255,59,48,0.7)'
      ctx.fillText(`${v > 0 ? '+' : ''}${v}°`, a.right - 26, y + (v > 0 ? -4 : 11))
    }
    ctx.restore()
  },
}

/** Grey bands behind the data for parked periods (chart.$bands = [[startMs, endMs], ...]). */
const parkedBands = {
  id: 'parkedBands',
  beforeDatasetsDraw(chart) {
    const bands = chart.$bands
    if (!bands?.length) return
    const { ctx, chartArea: a, scales } = chart
    ctx.save()
    ctx.beginPath()
    ctx.rect(a.left, a.top, a.width, a.height)
    ctx.clip()
    ctx.font = `600 8.5px ${MONO}`
    for (const [s, e] of bands) {
      const x0 = Math.max(a.left, scales.x.getPixelForValue(s))
      const x1 = Math.min(a.right, scales.x.getPixelForValue(e))
      if (x1 - x0 < 0.5) continue
      ctx.fillStyle = 'rgba(255,255,255,0.045)'
      ctx.fillRect(x0, a.top, x1 - x0, a.height)
      ctx.fillStyle = 'rgba(255,255,255,0.12)'
      ctx.fillRect(x0, a.top, x1 - x0, 2)
      if (x1 - x0 > 46) {
        ctx.fillStyle = 'rgba(255,255,255,0.3)'
        ctx.fillText('PARKED', x0 + 4, a.top + 11)
      }
    }
    ctx.restore()
  },
}

const glow = {
  id: 'activeGlow',
  beforeDatasetDraw(chart, args) {
    if (chart.$hl !== args.index) return
    chart.ctx.save()
    chart.ctx.shadowColor = 'rgba(255,122,26,0.75)'
    chart.ctx.shadowBlur = 10
  },
  afterDatasetDraw(chart, args) {
    if (chart.$hl === args.index) chart.ctx.restore()
  },
}

// ---------------------------------------------------------------- helpers
/**
 * Max interval before a line is broken, based on the earlier row's motion state.
 * Logging is event-driven (brief §4): moving ≤60 s apart, parked every 5 min — sparse ≠ missing.
 * `scale` widens it for evenly sampled (thinned) series.
 */
function gapLimit(prev, scale = 1) {
  const base = prev?.is_moving === true ? 150e3 : prev?.is_moving === false ? 12 * 60e3 : 90e3
  return base * scale
}

/** Insert null points across real outages so lines don't bridge them. */
function points(rows, key, scale = 1) {
  const out = []
  let prevT = null
  for (let i = 0; i < rows.length; i++) {
    const t = Date.parse(rows[i].recorded_at)
    if (i && t - prevT > gapLimit(rows[i - 1], scale)) out.push({ x: prevT + 1, y: null })
    const v = rows[i][key]
    out.push({ x: t, y: isNum(v) ? v : null })
    prevT = t
  }
  return out
}

function progressive(n) {
  const total = 1300
  const step = total / Math.max(n, 1)
  const prevY = (ctx) => {
    if (ctx.index === 0) return ctx.chart.scales.y.getPixelForValue(ctx.chart.scales.y.min)
    const prev = ctx.chart.getDatasetMeta(ctx.datasetIndex).data[ctx.index - 1]
    return prev ? prev.getProps(['y'], true).y : NaN
  }
  return {
    x: { type: 'number', easing: 'linear', duration: step, from: NaN, delay(ctx) { if (ctx.type !== 'data' || ctx.xStarted) return 0; ctx.xStarted = true; return ctx.index * step } },
    y: { type: 'number', easing: 'linear', duration: step, from: prevY, delay(ctx) { if (ctx.type !== 'data' || ctx.yStarted) return 0; ctx.yStarted = true; return ctx.index * step } },
  }
}

const beyond = (ctx) => {
  const a = ctx.p0.parsed.y
  const b = ctx.p1.parsed.y
  return (isNum(a) && Math.abs(a) > TILT_ALARM_DEG) || (isNum(b) && Math.abs(b) > TILT_ALARM_DEG)
}

const SPECS = {
  rp: {
    series: [
      { key: 'roll', label: 'ROLL', color: C.white, unit: '°', signed: true },
      { key: 'pitch', label: 'PITCH', color: C.grey, unit: '°', signed: true },
    ],
    y: { suggestedMin: -30, suggestedMax: 30, ticks: { callback: (v) => `${v}°`, stepSize: 10 } },
    limit: TILT_ALARM_DEG,
    alarmSegments: true,
  },
  temp: {
    series: [{ key: 'temp_c', label: 'TEMP', color: C.white, unit: '°C' }],
    y: { grace: '15%', ticks: { callback: (v) => `${v}°` } },
  },
  speed: {
    series: [{ key: 'speed_kmph', label: 'SPEED', color: C.white, unit: ' km/h', fill: true }],
    y: { min: 0, suggestedMax: 20, grace: '10%' },
  },
}

// ---------------------------------------------------------------- chart wrapper
export class TimeChart {
  constructor(canvas, kind, { onHover, onLeave } = {}) {
    this.canvas = canvas
    this.kind = kind
    this.spec = SPECS[kind]
    this.onHover = onHover
    this.onLeave = onLeave
    this.pinned = null
    this.chart = null
    canvas.addEventListener('mouseleave', () => {
      if (!this.chart) return
      if (this.chart.$hl !== this.pinned) { this.chart.$hl = this.pinned; this.applyActive() }
      this.onLeave?.()
    })
  }

  hasData(rows) {
    return this.spec.series.some((s) => rows.some((r) => isNum(r[s.key])))
  }

  /** Rebuild with draw-in animation. `stride` > 1 for evenly sampled series. */
  render(rows, { animate = true, stride = 1, bands = [] } = {}) {
    const cursor = this.chart?.$cursor
    this.chart?.destroy()
    this.lastRow = rows[rows.length - 1] || null
    const sets = this.spec.series.map((s, i) => this.dataset(s, points(rows, s.key, Math.max(1, stride)), i))
    const n = sets[0]?.data.length || 0
    const self = this
    this.chart = new Chart(this.canvas, {
      type: 'line',
      data: { datasets: sets },
      plugins: [parkedBands, cursorLine, limitLines, glow],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        normalized: true,
        spanGaps: false,
        animation: animate && n ? progressive(n) : false,
        interaction: { mode: 'index', intersect: false, axis: 'x' },
        layout: { padding: { top: 6, right: 6 } },
        elements: { point: { radius: 0, hoverRadius: 3, hoverBorderWidth: 0 }, line: { borderWidth: 1.4, tension: 0, borderJoinStyle: 'round' } },
        scales: {
          x: {
            type: 'time',
            time: { tooltipFormat: 'yyyy-MM-dd HH:mm:ss', displayFormats: { second: 'HH:mm:ss', minute: 'HH:mm', hour: 'HH:mm', day: 'dd MMM' } },
            grid: { color: C.grid, tickLength: 4 },
            border: { color: C.axis },
            ticks: { maxRotation: 0, autoSkipPadding: 24, color: C.tick },
          },
          y: { ...this.spec.y, grid: { color: C.grid }, border: { color: C.axis, display: false }, ticks: { color: C.tick, maxTicksLimit: 6, ...this.spec.y.ticks } },
        },
        plugins: {
          limitLines: { value: this.spec.limit || 0 },
          tooltip: {
            backgroundColor: 'rgba(12,12,12,0.94)',
            borderColor: '#333',
            borderWidth: 1,
            cornerRadius: 0,
            padding: 8,
            titleColor: '#a3a3a3',
            bodyColor: '#ededed',
            titleFont: { family: MONO, size: 10, weight: '500' },
            bodyFont: { family: MONO, size: 11 },
            boxWidth: 8,
            boxHeight: 8,
            boxPadding: 4,
            callbacks: {
              label(ctx) {
                const s = self.spec.series[ctx.datasetIndex]
                const y = ctx.parsed.y
                if (!isNum(y)) return ` ${s.label}  no data`
                return ` ${s.label}  ${s.signed ? fmtSigned(y, 1) : fmtNum(y, 1)}${s.unit}`
              },
              labelColor(ctx) {
                const c = self.spec.series[ctx.datasetIndex].color
                return { borderColor: c, backgroundColor: c }
              },
            },
          },
        },
        onHover(e, _els, chart) {
          if (!chart.chartArea || e.x < chart.chartArea.left || e.x > chart.chartArea.right) return
          // Active series = nearest line to the pointer.
          const x = chart.scales.x.getValueForPixel(e.x)
          let next = 0
          if (chart.data.datasets.length > 1) {
            let bd = Infinity
            next = null
            chart.data.datasets.forEach((_d, i) => {
              const el = nearestEl(chart.getDatasetMeta(i).data, e.x)
              if (el && isNum(el.y)) { const d = Math.abs(el.y - e.y); if (d < bd) { bd = d; next = i } }
            })
          }
          if (next !== chart.$hl) { chart.$hl = next; self.applyActive() }
          self.onHover?.(x)
        },
      },
    })
    this.chart.$cursor = cursor
    this.chart.$hl = this.pinned
    this.chart.$bands = bands
  }

  setBands(bands) {
    if (!this.chart) return
    this.chart.$bands = bands
    this.chart.draw()
  }

  dataset(s, data, i) {
    const active = this.pinned === i
    const ds = {
      label: s.label,
      data,
      borderColor: active ? C.accent : s.color,
      borderWidth: active ? 1.8 : 1.4,
      backgroundColor: s.color,
      pointHoverBackgroundColor: active ? C.accent : s.color,
    }
    if (this.spec.alarmSegments) ds.segment = { borderColor: (ctx) => (beyond(ctx) ? C.alarm : undefined) }
    if (s.fill) {
      ds.fill = 'origin'
      ds.backgroundColor = (ctx) => {
        const { chart } = ctx
        const a = chart.chartArea
        if (!a) return 'rgba(255,255,255,0.05)'
        const g = chart.ctx.createLinearGradient(0, a.top, 0, a.bottom)
        g.addColorStop(0, 'rgba(255,255,255,0.14)')
        g.addColorStop(1, 'rgba(255,255,255,0)')
        return g
      }
    }
    return ds
  }

  applyActive() {
    const ch = this.chart
    if (!ch) return
    ch.data.datasets.forEach((d, i) => {
      const s = this.spec.series[i]
      const active = ch.$hl === i
      d.borderColor = active ? C.accent : s.color
      d.borderWidth = active ? 1.8 : 1.4
      d.pointHoverBackgroundColor = active ? C.accent : s.color
    })
    ch.update('none')
  }

  pin(index) {
    this.pinned = this.pinned === index ? null : index
    if (this.chart) { this.chart.$hl = this.pinned; this.applyActive() }
    return this.pinned
  }

  /** Live append without re-animating. Late rows (buffered uploads) are inserted in GPS-time order. */
  append(row, maxPoints) {
    const ch = this.chart
    if (!ch) return
    const t = Date.parse(row.recorded_at)
    const prev = this.lastRow
    const inOrder = !prev || t > Date.parse(prev.recorded_at)
    ch.data.datasets.forEach((d, i) => {
      const key = this.spec.series[i].key
      const pt = { x: t, y: isNum(row[key]) ? row[key] : null }
      if (inOrder) {
        const last = d.data[d.data.length - 1]
        if (last && t - last.x > gapLimit(prev)) d.data.push({ x: last.x + 1, y: null })
        d.data.push(pt)
      } else {
        if (d.data.some((p) => p.x === t)) return
        let k = d.data.length
        while (k > 0 && d.data[k - 1].x > t) k--
        d.data.splice(k, 0, pt)
      }
      while (d.data.length > maxPoints) d.data.shift()
    })
    if (inOrder) this.lastRow = row
    ch.update('none')
  }

  setCursor(ms) {
    if (!this.chart) return
    this.chart.$cursor = ms
    this.chart.draw()
  }
}

function nearestEl(els, px) {
  let lo = 0
  let hi = els.length - 1
  if (hi < 0) return null
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (els[mid].x < px) lo = mid
    else hi = mid
  }
  return Math.abs(els[lo].x - px) < Math.abs(els[hi].x - px) ? els[lo] : els[hi]
}
