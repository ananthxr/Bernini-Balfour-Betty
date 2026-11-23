// Procedural 40ft high-cube shipping container with live tilt, orbit controls and opening doors.
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { AXES, TILT_WARN_DEG, TILT_ALARM_DEG } from './config.js'
import { containerCode, isNum } from './format.js'

// ISO 668 40' HC external dimensions, metres.
const L = 12.192
const W = 2.438
const H = 2.896
const POST = 0.16
const RAIL_TOP = 0.12
const RAIL_BOT = 0.16
const WALL_H = H - RAIL_TOP - RAIL_BOT
const WALL_Y = (RAIL_BOT - RAIL_TOP) / 2
const DEG = Math.PI / 180

const BG = 0x0b0b0c
const RUST = new THREE.Color(0xa4461d)
const RUST_DARK = new THREE.Color(0x7c3416)
const GREY = new THREE.Color(0x5d5d5d)
const ORANGE = new THREE.Color(0xff7a1a)
const RED = new THREE.Color(0xff3030)

const DEFAULT_CAM = new THREE.Vector3(13.5, 6.2, 14.5)
const DEFAULT_TARGET = new THREE.Vector3(0, 1.2, 0)

// ---------------------------------------------------------------- geometry helpers
/** Trapezoidal corrugated sheet; length along X, ribs vertical, bumps toward -Z. */
function corrugated(length, height, { pitch = 0.278, depth = 0.045, thick = 0.008 } = {}) {
  const n = Math.max(1, Math.round(length / pitch))
  const p = length / n
  const a = p * 0.34
  const r = p * 0.16
  const pts = []
  for (let i = 0; i < n; i++) {
    const x0 = -length / 2 + i * p
    pts.push([x0, 0], [x0 + a, 0], [x0 + a + r, depth], [x0 + 2 * a + r, depth])
  }
  pts.push([length / 2, 0])
  const s = new THREE.Shape()
  s.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1])
  for (let i = pts.length - 1; i >= 0; i--) s.lineTo(pts[i][0], pts[i][1] - thick)
  s.closePath()
  const g = new THREE.ExtrudeGeometry(s, { depth: height, bevelEnabled: false, curveSegments: 1 })
  g.rotateX(-Math.PI / 2) // extrude upward; shape +y becomes world -z
  g.translate(0, -height / 2, 0)
  g.computeVertexNormals()
  return g
}

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
  m.position.set(x, y, z)
  return m
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  draw(ctx, w, h)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  t.userData.redraw = () => { ctx.clearRect(0, 0, w, h); draw(ctx, w, h); t.needsUpdate = true }
  return t
}

const STENCIL = '"Inter", "Helvetica Neue", Arial, sans-serif'

function grimeTexture() {
  const t = canvasTexture(512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < 260; i++) {
      const x = rnd() * w
      const y = rnd() * h * 0.7
      const len = 30 + rnd() * 200
      const g = ctx.createLinearGradient(x, y, x, y + len)
      const a = 0.04 + rnd() * 0.1
      g.addColorStop(0, `rgba(60,30,15,${a})`)
      g.addColorStop(1, 'rgba(60,30,15,0)')
      ctx.fillStyle = g
      ctx.fillRect(x, y, 1 + rnd() * 4, len)
    }
    for (let i = 0; i < 1400; i++) {
      ctx.fillStyle = `rgba(40,20,10,${rnd() * 0.08})`
      ctx.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 3, 2 + rnd() * 3)
    }
  })
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(0.18, 0.32)
  return t
}

function compassTexture() {
  return canvasTexture(2048, 2048, (ctx, w) => {
    const c = w / 2
    const pxPerM = w / 22
    const R = 9.6 * pxPerM
    ctx.translate(c, c)
    ctx.strokeStyle = 'rgba(200,200,200,0.28)'
    ctx.lineWidth = 3
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke()
    ctx.strokeStyle = 'rgba(200,200,200,0.12)'
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.arc(0, 0, R - 0.9 * pxPerM, 0, Math.PI * 2); ctx.stroke()
    for (let d = 0; d < 360; d += 5) {
      const a = (d - 90) * DEG
      const major = d % 30 === 0
      const mid = d % 10 === 0
      const len = (major ? 0.55 : mid ? 0.32 : 0.18) * pxPerM
      ctx.strokeStyle = major ? 'rgba(230,230,230,0.55)' : 'rgba(200,200,200,0.25)'
      ctx.lineWidth = major ? 4 : 2
      ctx.beginPath()
      ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R)
      ctx.lineTo(Math.cos(a) * (R - len), Math.sin(a) * (R - len))
      ctx.stroke()
      if (major && d % 90 !== 0) {
        // Text top faces the centre so labels read upright from outside the ring.
        ctx.save()
        ctx.rotate(d * DEG)
        ctx.translate(0, -(R - 1.1 * pxPerM))
        ctx.rotate(Math.PI)
        ctx.fillStyle = 'rgba(200,200,200,0.45)'
        ctx.font = `500 ${0.3 * pxPerM}px "JetBrains Mono", monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(d).padStart(3, '0'), 0, 0)
        ctx.restore()
      }
    }
    const card = [['N', 0], ['E', 90], ['S', 180], ['W', 270]]
    for (const [l, d] of card) {
      ctx.save()
      ctx.rotate(d * DEG)
      ctx.translate(0, -(R + 0.55 * pxPerM))
      ctx.rotate(Math.PI)
      ctx.fillStyle = l === 'N' ? 'rgba(255,122,26,0.95)' : 'rgba(235,235,235,0.75)'
      ctx.font = `700 ${0.62 * pxPerM}px ${STENCIL}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(l, 0, 0)
      ctx.restore()
    }
  })
}

function blobShadowTexture() {
  return canvasTexture(512, 256, (ctx, w, h) => {
    ctx.shadowColor = 'rgba(0,0,0,0.85)'
    ctx.shadowBlur = 40
    ctx.shadowOffsetX = 4000
    ctx.fillStyle = '#000'
    ctx.fillRect(60 - 4000, 70, w - 120, h - 140)
  })
}

// ---------------------------------------------------------------- the view
export class ContainerView {
  constructor(host) {
    this.host = host
    this.target = { roll: 0, pitch: 0 }
    this.yaw = 0
    this.current = { roll: 0, pitch: 0 }
    this.sync = true
    this.stale = 0
    this.staleTarget = 0
    this.glow = 0
    this.glowColor = new THREE.Color().copy(ORANGE)
    this.doors = 0
    this.doorsTarget = 0
    this.led = 0
    this.visible = true
    this.deviceId = ''

    const small = Math.min(window.innerWidth, window.innerHeight) < 700 || matchMedia('(pointer: coarse)').matches
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }))
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.25 : 2))
    r.toneMapping = THREE.ACESFilmicToneMapping
    r.toneMappingExposure = 1.05
    host.appendChild(r.domElement)
    r.domElement.classList.add('three-canvas')

    const scene = (this.scene = new THREE.Scene())
    scene.background = new THREE.Color(BG)
    scene.fog = new THREE.Fog(BG, 26, 62)
    const pmrem = new THREE.PMREMGenerator(r)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.32

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200)
    this.camera.position.copy(DEFAULT_CAM)
    const ctl = (this.controls = new OrbitControls(this.camera, r.domElement))
    ctl.target.copy(DEFAULT_TARGET)
    ctl.enableDamping = true
    ctl.dampingFactor = 0.08
    ctl.enablePan = false
    ctl.minDistance = 7
    ctl.maxDistance = 42
    ctl.maxPolarAngle = Math.PI * 0.49
    ctl.rotateSpeed = 0.7

    scene.add(new THREE.HemisphereLight(0xdfe6ee, 0x1a1512, 0.75))
    const key = new THREE.DirectionalLight(0xfff4e8, 2.1)
    key.position.set(9, 15, 7)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0x9fb3c8, 0.7)
    rim.position.set(-12, 6, -9)
    scene.add(rim)

    this.buildGround()
    this.buildContainer()
    this.bindPointer()

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(host)
    this.io = new IntersectionObserver(([e]) => { this.visible = e.isIntersecting })
    this.io.observe(host)
    this.resize()

    this.timer = new THREE.Timer()
    r.setAnimationLoop((ts) => { this.timer.update(ts); this.frame() })
    document.fonts?.ready.then(() => this.decals.forEach((t) => t.userData.redraw()))
  }

  buildGround() {
    const grid = new THREE.GridHelper(90, 90, 0x2c2c2c, 0x1a1a1a)
    grid.material.transparent = true
    grid.material.opacity = 0.7
    this.scene.add(grid)

    const compass = new THREE.Mesh(
      new THREE.PlaneGeometry(22, 22),
      new THREE.MeshBasicMaterial({ map: compassTexture(), transparent: true, depthWrite: false }),
    )
    compass.rotation.x = -Math.PI / 2
    compass.position.y = 0.003
    this.scene.add(compass)

    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(L + 3.2, W + 3.2),
      new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false, opacity: 0.9 }),
    )
    this.shadow.rotation.x = -Math.PI / 2
    this.shadow.position.y = 0.006
    this.scene.add(this.shadow)
  }

  buildContainer() {
    const grime = grimeTexture()
    const paint = (this.paint = new THREE.MeshStandardMaterial({ color: RUST.clone(), roughness: 0.62, metalness: 0.35, map: grime }))
    const frame = (this.frameMat = new THREE.MeshStandardMaterial({ color: RUST_DARK.clone(), roughness: 0.55, metalness: 0.4, map: grime }))
    const steel = new THREE.MeshStandardMaterial({ color: 0xa8a8a8, roughness: 0.32, metalness: 0.85 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9, metalness: 0.1 })
    const liner = new THREE.MeshStandardMaterial({ color: 0x2b211c, roughness: 0.95, metalness: 0.05, side: THREE.BackSide })
    const wood = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 0.92 })
    this.paintMats = [paint, frame]

    const tilt = (this.tiltRoot = new THREE.Group())
    tilt.rotation.order = 'YZX'
    this.scene.add(tilt)
    const body = (this.body = new THREE.Group())
    tilt.add(body)

    // Side walls (ribs outward)
    const sideLen = L - 2 * POST
    const sideGeo = corrugated(sideLen, WALL_H)
    const sideN = new THREE.Mesh(sideGeo, paint) // -Z side
    sideN.position.set(0, WALL_Y, -W / 2 + 0.055)
    const sideS = new THREE.Mesh(sideGeo, paint) // +Z side
    sideS.rotation.y = Math.PI
    sideS.position.set(0, WALL_Y, W / 2 - 0.055)
    body.add(sideN, sideS)

    // Front (blind) end wall at -X
    const endGeo = corrugated(W - 2 * POST, WALL_H, { pitch: 0.24, depth: 0.04 })
    const front = new THREE.Mesh(endGeo, paint)
    front.rotation.y = Math.PI / 2
    front.position.set(-L / 2 + 0.05, WALL_Y, 0)
    body.add(front)

    // Roof + shallow ribs
    body.add(box(L - 2 * POST, 0.035, W - 0.06, paint, 0, H / 2 - 0.045, 0))
    for (let x = -L / 2 + 0.6; x < L / 2 - 0.5; x += 0.56) body.add(box(0.07, 0.012, W - 0.2, frame, x, H / 2 - 0.022, 0))

    // Interior liner (only visible from inside) + timber floor
    body.add(box(L - 0.36, H - 0.3, W - 0.2, liner, 0, WALL_Y, 0))
    body.add(box(L - 0.4, 0.03, W - 0.22, wood, 0, -H / 2 + RAIL_BOT + 0.015, 0))

    // Rails
    for (const z of [-1, 1]) {
      body.add(box(L - 2 * POST, RAIL_TOP, 0.11, frame, 0, H / 2 - RAIL_TOP / 2, z * (W / 2 - 0.055)))
      body.add(box(L - 2 * POST, RAIL_BOT, 0.12, frame, 0, -H / 2 + RAIL_BOT / 2, z * (W / 2 - 0.06)))
    }
    for (const x of [-1, 1]) {
      body.add(box(0.14, RAIL_TOP + 0.08, W - 2 * POST, frame, x * (L / 2 - 0.07), H / 2 - (RAIL_TOP + 0.08) / 2, 0))
      body.add(box(0.16, RAIL_BOT, W - 2 * POST, frame, x * (L / 2 - 0.08), -H / 2 + RAIL_BOT / 2, 0))
    }
    // Cross members underneath
    for (let x = -L / 2 + 0.5; x < L / 2 - 0.3; x += 0.62) body.add(box(0.06, 0.12, W - 0.16, dark, x, -H / 2 + 0.06, 0))
    // Fork pockets hint + gooseneck shadow
    body.add(box(2.2, 0.12, W - 0.24, dark, -L / 2 + 1.5, -H / 2 + 0.07, 0))

    // Corner posts and castings
    const CW = 0.178
    const CH = 0.118
    const CD = 0.162
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      body.add(box(POST, H - 2 * CH, POST, frame, sx * (L / 2 - POST / 2), 0, sz * (W / 2 - POST / 2)))
      for (const sy of [-1, 1]) {
        const cx = sx * (L / 2 - CW / 2)
        const cy = sy * (H / 2 - CH / 2)
        const cz = sz * (W / 2 - CD / 2)
        body.add(box(CW, CH, CD, frame, cx, cy, cz))
        body.add(box(0.004, 0.045, 0.075, dark, sx * (L / 2 + 0.001), cy, cz)) // end aperture
        body.add(box(0.1, 0.045, 0.004, dark, cx, cy, sz * (W / 2 + 0.001)))   // side aperture
        body.add(box(0.1, 0.004, 0.06, dark, cx, sy * (H / 2 + 0.001), cz))    // top/bottom aperture
      }
    }

    this.buildDoors(paint, frame, steel, dark)
    this.buildDevice()
    this.buildDecals()
    this.buildGlow()
  }

  buildDoors(paint, frame, steel, dark) {
    const leafW = (W - 2 * POST) / 2 - 0.004
    // Fits between the door sill (RAIL_BOT) and the deeper door header (RAIL_TOP + 0.08).
    const leafH = H - RAIL_BOT - (RAIL_TOP + 0.08) - 0.01
    const leafY = (RAIL_BOT - (RAIL_TOP + 0.08)) / 2
    const panelGeo = corrugated(leafW - 0.1, leafH - 0.14, { pitch: 0.2, depth: 0.026, thick: 0.006 })
    this.leaves = []
    for (const side of [1, -1]) { // +1 = hinge on +Z (viewer's left), -1 = hinge on -Z (viewer's right)
      const pivot = new THREE.Group()
      pivot.position.set(L / 2 - 0.05, leafY, side * (W / 2 - POST))
      const leaf = new THREE.Group()
      leaf.position.z = -side * (leafW / 2)
      pivot.add(leaf)

      const panel = new THREE.Mesh(panelGeo, paint)
      panel.rotation.y = -Math.PI / 2
      leaf.add(panel)
      // door frame
      leaf.add(box(0.06, leafH, 0.06, frame, 0.01, 0, side * (leafW / 2 - 0.03)))
      leaf.add(box(0.06, leafH, 0.06, frame, 0.01, 0, -side * (leafW / 2 - 0.03)))
      leaf.add(box(0.06, 0.07, leafW, frame, 0.01, leafH / 2 - 0.035, 0))
      leaf.add(box(0.06, 0.07, leafW, frame, 0.01, -leafH / 2 + 0.035, 0))
      // locking bars
      for (const f of [-0.22, 0.22]) {
        const z = f * leafW
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, leafH + 0.1, 10), steel)
        rod.position.set(0.075, 0, z)
        leaf.add(rod)
        for (const y of [-0.38, 0, 0.38]) leaf.add(box(0.07, 0.05, 0.07, steel, 0.055, y * leafH, z))
        leaf.add(box(0.06, 0.09, 0.08, dark, 0.075, leafH / 2 + 0.03, z))
        leaf.add(box(0.06, 0.09, 0.08, dark, 0.075, -leafH / 2 - 0.03, z))
        const handle = box(0.03, 0.035, 0.3, steel, 0.105, -0.12 * leafH, z + side * 0.15)
        leaf.add(handle)
      }
      // hinges
      for (const y of [-0.42, -0.14, 0.14, 0.42]) leaf.add(box(0.05, 0.1, 0.08, steel, 0.03, y * leafH, side * (leafW / 2 + 0.02)))
      this.body.add(pivot)
      this.leaves.push({ pivot, leaf, side, leafW, leafH })
    }
  }

  buildDevice() {
    const dev = new THREE.Group()
    dev.position.set(-L / 2 + 0.24, H / 2 - 0.45, 0)
    dev.add(box(0.06, 0.16, 0.24, new THREE.MeshStandardMaterial({ color: 0x1d1d1d, roughness: 0.6 })))
    this.ledMat = new THREE.MeshBasicMaterial({ color: 0x331a08 })
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 8), this.ledMat)
    led.position.set(0.035, 0.05, 0.07)
    dev.add(led)
    this.body.add(dev)
  }

  buildDecals() {
    const sideTex = (doorOnRight) => canvasTexture(2048, 440, (ctx, w, h) => {
      const code = containerCode(this.deviceId)
      ctx.fillStyle = 'rgba(240,236,228,0.92)'
      ctx.textBaseline = 'top'
      // Big name, centre
      ctx.font = `800 170px ${STENCIL}`
      ctx.textAlign = 'center'
      ctx.globalAlpha = 0.85
      ctx.fillText((this.deviceId || 'TRACKER').toUpperCase(), w / 2, 160)
      ctx.globalAlpha = 1
      // Code block near the door end
      const x = doorOnRight ? w - 60 : 60
      ctx.textAlign = doorOnRight ? 'right' : 'left'
      ctx.font = `700 70px ${STENCIL}`
      const main = `${code.owner} ${code.serial}`
      ctx.fillText(main, doorOnRight ? x - 80 : x, 26)
      const mw = ctx.measureText(main).width
      const bx = doorOnRight ? x - 62 : x + mw + 18
      ctx.strokeStyle = 'rgba(240,236,228,0.92)'
      ctx.lineWidth = 5
      ctx.strokeRect(bx, 22, 62, 76)
      ctx.textAlign = 'center'
      ctx.fillText(String(code.check), bx + 31, 26)
      ctx.textAlign = doorOnRight ? 'right' : 'left'
      ctx.font = `700 52px ${STENCIL}`
      ctx.fillText('45G1', doorOnRight ? x - 80 : x, 106)
    })
    const doorCodeTex = canvasTexture(512, 512, (ctx, w) => {
      const code = containerCode(this.deviceId)
      ctx.fillStyle = 'rgba(240,236,228,0.92)'
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      ctx.font = `700 72px ${STENCIL}`
      ctx.fillText(code.owner, 40, 30)
      ctx.fillText(code.serial, 40, 110)
      const sw = ctx.measureText(code.serial).width
      ctx.strokeStyle = 'rgba(240,236,228,0.92)'
      ctx.lineWidth = 5
      ctx.strokeRect(40 + sw + 14, 104, 56, 80)
      ctx.textAlign = 'center'
      ctx.fillText(String(code.check), 40 + sw + 42, 110)
      ctx.textAlign = 'left'
      ctx.font = `700 54px ${STENCIL}`
      ctx.fillText('45G1', 40, 205)
      ctx.globalAlpha = 0.55
      ctx.font = `600 26px ${STENCIL}`
      ctx.fillText((this.deviceId || '').toUpperCase(), 40, 290)
      ctx.globalAlpha = 1
      void w
    })
    const plateTex = canvasTexture(512, 512, (ctx) => {
      ctx.fillStyle = 'rgba(240,236,228,0.9)'
      ctx.textBaseline = 'top'
      ctx.font = `700 30px ${STENCIL}`
      const lines = [['MAX GROSS', '30,480 KG'], ['', '67,200 LB'], ['TARE', '3,940 KG'], ['', '8,690 LB'],
        ['NET', '26,540 KG'], ['', '58,510 LB'], ['CU. CAP.', '76.3 CU.M'], ['', '2,694 CU.FT']]
      lines.forEach(([a, b], i) => {
        ctx.textAlign = 'left'
        ctx.fillText(a, 30, 40 + i * 44)
        ctx.textAlign = 'right'
        ctx.fillText(b, 480, 40 + i * 44)
      })
    })
    this.decals = [sideTex(true), sideTex(false), doorCodeTex, plateTex]

    const decalMat = (map) => new THREE.MeshStandardMaterial({
      map, transparent: true, roughness: 0.75, metalness: 0.1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
    })
    const sideW = L - 2 * POST - 0.4
    const sideH = sideW * (440 / 2048)
    const s1 = new THREE.Mesh(new THREE.PlaneGeometry(sideW, sideH), decalMat(this.decals[0]))
    s1.position.set(0, H / 2 - RAIL_TOP - sideH / 2 - 0.05, W / 2 - 0.006)
    const s2 = new THREE.Mesh(new THREE.PlaneGeometry(sideW, sideH), decalMat(this.decals[1]))
    s2.rotation.y = Math.PI
    s2.position.set(0, s1.position.y, -W / 2 + 0.006)
    this.body.add(s1, s2)

    for (const lv of this.leaves) {
      const isRight = lv.side === -1
      const sz = lv.leafW * 0.82
      const m = new THREE.Mesh(new THREE.PlaneGeometry(sz, sz), decalMat(isRight ? this.decals[2] : this.decals[3]))
      m.rotation.y = Math.PI / 2
      m.position.set(0.034, lv.leafH * 0.24, 0)
      lv.leaf.add(m)
    }
  }

  buildGlow() {
    const e = new THREE.EdgesGeometry(new THREE.BoxGeometry(L + 0.03, H + 0.03, W + 0.03))
    const geo = new LineSegmentsGeometry().fromEdgesGeometry(e)
    this.glowMats = [
      new LineMaterial({ color: 0xff7a1a, linewidth: 2.2, transparent: true, opacity: 0, depthWrite: false }),
      new LineMaterial({ color: 0xff7a1a, linewidth: 9, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
    ]
    for (const m of this.glowMats) this.tiltRoot.add(new LineSegments2(geo, m))
  }

  // ---------------------------------------------------------------- interaction
  bindPointer() {
    const el = this.renderer.domElement
    const ray = new THREE.Raycaster()
    let down = null
    let pending = null
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() } })
    el.addEventListener('pointerup', (e) => {
      if (!down) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      const quick = performance.now() - down.t < 350
      down = null
      if (moved > 6 || !quick) return
      const rect = el.getBoundingClientRect()
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
      clearTimeout(pending)
      pending = setTimeout(() => {
        ray.setFromCamera(ndc, this.camera)
        if (ray.intersectObject(this.body, true).length) this.toggleDoors()
      }, 240)
    })
    el.addEventListener('dblclick', () => { clearTimeout(pending); this.resetView() })
  }

  toggleDoors() { this.doorsTarget = this.doorsTarget ? 0 : 1 }

  resetView() {
    this.camAnim = { t: 0, fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone() }
  }

  // ---------------------------------------------------------------- public API
  setDevice(deviceId) {
    this.deviceId = deviceId || ''
    this.decals?.forEach((t) => t.userData.redraw())
  }

  /** Pose target in degrees. null/undefined → level (unknown). */
  setTilt(roll, pitch) {
    this.target.roll = isNum(roll) ? roll : 0
    this.target.pitch = isNum(pitch) ? pitch : 0
  }

  /**
   * Course over ground (0 = north, clockwise). The blind front end faces the direction of travel;
   * the compass ring's N is at -Z. null (parked / no fix) keeps the last known heading.
   */
  setHeading(deg) {
    if (!isNum(deg)) return
    this.yawTarget = -((deg + 90) * DEG)
  }

  setSync(on) { this.sync = !!on }
  setStale(on) { this.staleTarget = on ? 1 : 0 }
  pulse() { this.led = 1 }

  resize() {
    const w = this.host.clientWidth || 1
    const h = this.host.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.fov = w / h < 1 ? 46 : 34
    this.camera.updateProjectionMatrix()
    for (const m of this.glowMats || []) m.resolution.set(w, h)
  }

  // ---------------------------------------------------------------- frame
  frame() {
    const dt = Math.min(this.timer.getDelta(), 0.1)
    const k = 1 - Math.exp(-dt * 4.5)
    const tr = this.sync ? this.target.roll : 0
    const tp = this.sync ? this.target.pitch : 0
    this.current.roll += (tr - this.current.roll) * k
    this.current.pitch += (tp - this.current.pitch) * k

    // Yaw eases along the shortest arc.
    if (this.yawTarget !== undefined) {
      let d = this.yawTarget - this.yaw
      d = Math.atan2(Math.sin(d), Math.cos(d))
      this.yaw += d * (1 - Math.exp(-dt * 2.5))
    }
    this.shadow.rotation.z = this.yaw

    const t = this.tiltRoot
    t.rotation.set(AXES.rollSign * this.current.roll * DEG, this.yaw, AXES.pitchSign * this.current.pitch * DEG)
    t.updateMatrixWorld()
    // Rest on the lowest corner rather than sinking into the floor.
    const q = t.quaternion
    let minY = Infinity
    const v = new THREE.Vector3()
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      v.set((sx * L) / 2, (sy * H) / 2, (sz * W) / 2).applyQuaternion(q)
      minY = Math.min(minY, v.y)
    }
    t.position.y = -minY
    const lift = Math.max(Math.abs(this.current.roll), Math.abs(this.current.pitch))
    this.shadow.material.opacity = 0.9 - Math.min(0.4, lift / 60)

    // Doors
    this.doors += (this.doorsTarget - this.doors) * (1 - Math.exp(-dt * 3.2))
    for (const lv of this.leaves) lv.pivot.rotation.y = lv.side * -this.doors * 1.95

    // Tilt glow: orange from WARN, red past ALARM
    const level = this.sync ? Math.max(Math.abs(tr), Math.abs(tp)) : 0
    const glowTarget = level > TILT_ALARM_DEG ? 1 : level >= TILT_WARN_DEG ? 0.7 : 0
    this.glow += (glowTarget - this.glow) * (1 - Math.exp(-dt * 5))
    const col = level > TILT_ALARM_DEG ? RED : ORANGE
    this.glowColor.lerp(col, 1 - Math.exp(-dt * 6))
    const beat = level > TILT_ALARM_DEG ? 0.65 + 0.35 * Math.sin(performance.now() / 160) : 1
    const g = this.glow * beat * (1 - this.stale * 0.8)
    this.glowMats[0].color.copy(this.glowColor)
    this.glowMats[1].color.copy(this.glowColor)
    this.glowMats[0].opacity = g
    this.glowMats[1].opacity = g * 0.28

    // Stale: desaturate paint
    this.stale += (this.staleTarget - this.stale) * (1 - Math.exp(-dt * 3))
    this.paintMats[0].color.copy(RUST).lerp(GREY, this.stale * 0.85)
    this.paintMats[1].color.copy(RUST_DARK).lerp(GREY, this.stale * 0.85).multiplyScalar(1 - this.stale * 0.15)
    for (const m of this.paintMats) {
      m.emissive.copy(this.glowColor)
      m.emissiveIntensity = g * 0.12
    }

    // LED blink on each reading
    this.led = Math.max(0, this.led - dt * 1.6)
    this.ledMat.color.setRGB(0.2 + this.led * 0.8, 0.1 + this.led * 0.38, 0.03 + this.led * 0.07)

    if (this.camAnim) {
      const a = this.camAnim
      a.t = Math.min(1, a.t + dt / 0.9)
      const e = 1 - (1 - a.t) ** 3
      this.camera.position.lerpVectors(a.fromPos, DEFAULT_CAM, e)
      this.controls.target.lerpVectors(a.fromTarget, DEFAULT_TARGET, e)
      if (a.t >= 1) this.camAnim = null
    }
    this.controls.update()
    if (this.visible) this.renderer.render(this.scene, this.camera)
  }
}
