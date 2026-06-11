(function () {
  'use strict'

  let _api = null
  let _ready = false
  const _queue = []

  function getApi() {
    if (_api) return Promise.resolve(_api)
    if (_ready) {
      _api = window.pywebview && window.pywebview.api ? window.pywebview.api : null
      if (_api) return Promise.resolve(_api)
    }
    return new Promise(function (resolve) {
      _queue.push(resolve)
    })
  }

  function onPywebviewReady() {
    _ready = true
    _api = window.pywebview && window.pywebview.api ? window.pywebview.api : null
    if (_api) {
      _queue.forEach(function (fn) { fn(_api) })
      _queue.length = 0
    }
  }

  if (window.pywebview && window.pywebview.api) {
    onPywebviewReady()
  } else {
    window.addEventListener('pywebviewready', onPywebviewReady)
  }

  /* ── state ── */
  const S = {
    timeline: null,
    uid: null,
    samples: [],
    previews: {},    // uid -> samples[] for timeline mini-previews
    back: [],
    forward: [],
    dragging: null,
    ptHover: null,
    live: false,
    smooth: 30,
    pointCount: 12,
    dirty: false,
  }

  /* ── DOM refs ── */
  const $ = (s) => document.querySelector(s)
  const $$ = (s) => document.querySelectorAll(s)
  const cnv = $('#curveCanvas')
  const ctx = cnv.getContext('2d')
  const area = $('#curveArea')
  const readout = $('#cursorReadout')

  /* ── element refs ── */
  const el = {
    timelineBody: $('#timelineBody'),
    clipName: $('#clipName'),
    clipDur: $('#clipDur'),
    clipIndicator: $('#clipIndicator'),
    statusBar: $('#statusBar'),
    statusDot: $('#statusDot'),
    statusInfo: $('#statusBar .status-info'),
    liveBadge: $('#liveBadge'),
    statAvg: $('#statAvg'),
    statMin: $('#statMin'),
    statMax: $('#statMax'),
    statPoints: $('#statPoints'),
    statFrames: $('#statFrames'),
    smoothSlider: $('#smoothSlider'),
    smoothLabel: $('#smoothLabel'),
    clipCount: $('#clipCount'),
    undoBtn: $('#undoBtn'),
    redoBtn: $('#redoBtn'),
    applyBtn: $('#applyBtn'),
    refreshBtn: $('#refreshBtn'),
    toastContainer: $('#toastContainer'),
    previewPanel: $('#previewPanel'),
    previewVideo: $('#previewVideo'),
    previewEmpty: $('#previewEmpty'),
    genPreviewBtn: $('#genPreviewBtn'),
    closePreviewBtn: $('#closePreviewBtn'),
  }

  /* ── helpers ── */
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  const lerp = (a, b, t) => a + (b - a) * t
  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m])

  /* ── toast ── */
  function toast(msg, type) {
    const c = el.toastContainer
    const t = document.createElement('div')
    t.className = 'toast' + (type ? ' ' + type : '')
    t.innerHTML = '<span class="toast-icon">' + (type === 'success' ? '✓' : type === 'error' ? '✗' : '○') + '</span>' + esc(msg)
    c.appendChild(t)
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t) }, 2200)
  }

  /* ── status ── */
  function setStatus(msg, type) {
    const info = el.statusInfo
    info.textContent = msg
    el.statusBar.className = 'status' + (type ? ' ' + type : '')
    const colors = { success: '#5bbf7a', error: '#e86a5a', '': '#6b6b78' }
    el.statusDot.style.background = colors[type || ''] || '#6b6b78'
  }

  /* ── live badge ── */
  function setLive(on) {
    S.live = on
    const b = el.liveBadge
    b.className = 'live-badge' + (on ? ' active' : ' inactive')
    b.querySelector('span:last-child').textContent = on ? 'Live' : 'Standby'
  }

  /* ── undo / redo ── */
  function pushUndo() {
    if (S.samples.length) S.back.push(S.samples.slice())
    S.forward = []
    updateUndoButtons()
  }

  function undo() {
    if (!S.back.length) return
    S.forward.push(S.samples.slice())
    S.samples = S.back.pop()
    draw()
    updateUndoButtons()
    if (S.live && S.uid) debouncedApply()
  }

  function redo() {
    if (!S.forward.length) return
    S.back.push(S.samples.slice())
    S.samples = S.forward.pop()
    draw()
    updateUndoButtons()
    if (S.live && S.uid) debouncedApply()
  }

  function updateUndoButtons() {
    el.undoBtn.style.opacity = S.back.length ? '1' : '0.3'
    el.undoBtn.disabled = !S.back.length
    el.redoBtn.style.opacity = S.forward.length ? '1' : '0.3'
    el.redoBtn.disabled = !S.forward.length
  }

  /* ── clip mini-previews in timeline ── */
  function drawClipPreview(canvas, samples) {
    if (!canvas || !canvas.getContext) return
    const ctx = canvas.getContext('2d')
    const w = canvas.width, h = canvas.height
    ctx.clearRect(0, 0, w, h)

    const n = samples && samples.length
    if (!n || n < 2) {
      ctx.fillStyle = '#2a2a33'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#555'
      ctx.font = '7px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('―', w / 2, h / 2 + 2)
      return
    }

    const pad = 1
    const pw = w - pad * 2, ph = h - pad * 2

    // bg
    ctx.fillStyle = '#1a1a20'
    ctx.fillRect(0, 0, w, h)

    // midline (100%)
    const midY = pad + ph * 0.5
    ctx.strokeStyle = '#2a2a33'
    ctx.lineWidth = 0.5
    ctx.beginPath()
    ctx.moveTo(pad, midY)
    ctx.lineTo(w - pad, midY)
    ctx.stroke()

    // sample max for scaling
    const max = Math.max(1, Math.max(...samples))
    const pts = []
    for (let i = 0; i < n; i++) {
      const x = pad + (pw * i / (n - 1))
      const y = pad + ph * (1 - Math.min(samples[i], max) / max)
      pts.push({ x, y })
    }

    // fill
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pad + ph)
    for (const p of pts) ctx.lineTo(p.x, p.y)
    ctx.lineTo(pts[n - 1].x, pad + ph)
    ctx.closePath()
    ctx.fillStyle = 'rgba(200,164,92,0.15)'
    ctx.fill()

    // line
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 0; i < n - 1; i++) {
      const a = pts[i], b = pts[i + 1]
      ctx.bezierCurveTo(
        a.x + (b.x - a.x) * 0.35, a.y,
        b.x - (b.x - a.x) * 0.35, b.y,
        b.x, b.y
      )
    }
    ctx.strokeStyle = '#c8a45c'
    ctx.lineWidth = 1.2
    ctx.stroke()
  }

  function drawAllPreviews() {
    S.timeline.tracks.forEach(function (track) {
      track.items.forEach(function (item) {
        var canvas = el.timelineBody.querySelector('.clip-preview[data-uid="' + item.id + '"]')
        var samples = S.previews[item.id]
        drawClipPreview(canvas, samples)
      })
    })
  }

  function updatePreview(uid) {
    S.previews[uid] = S.samples.slice()
    var canvas = el.timelineBody.querySelector('.clip-preview[data-uid="' + uid + '"]')
    drawClipPreview(canvas, S.samples)
  }

  async function loadAllPreviews() {
    var allItems = []
    S.timeline.tracks.forEach(function (track) {
      track.items.forEach(function (item) { allItems.push(item) })
    })
    // load in batches of 5 to avoid hammering the bridge
    for (var i = 0; i < allItems.length; i += 5) {
      var batch = allItems.slice(i, i + 5)
      await Promise.all(batch.map(loadOnePreview))
    }
  }

  async function loadOnePreview(item) {
    try {
      var a = await getApi()
      var loaded = await a.get_curve(item.id)
      if (loaded.ok && loaded.points) {
        var p = JSON.parse(loaded.points)
        if (p && p.samples && p.samples.length >= 2) {
          S.previews[item.id] = p.samples
          var canvas = el.timelineBody.querySelector('.clip-preview[data-uid="' + item.id + '"]')
          drawClipPreview(canvas, p.samples)
        }
      }
    } catch (_) {}
  }

  function clearUndo() {
    S.back = []
    S.forward = []
    updateUndoButtons()
  }

  /* ── refresh timeline ── */
  async function refresh() {
    setStatus('Syncing…')
    try {
      const a = await getApi()
      const r = await a.list_timeline()
      if (!r.ok) { setStatus(r.msg, 'error'); toast(r.msg, 'error'); return }
      S.timeline = r
      S.uid = null
      S.samples = []
      S.previews = {}
      for (const track of r.tracks) {
        for (const item of track.items) {
          S.previews[item.id] = [100, 100, 100, 100, 100]
        }
      }
      renderTimeline()
      selectClip(null)
      loadAllPreviews()
      setStatus('Synced — ' + r.name, 'success')
      toast('Loaded ' + r.name, 'success')
      setLive(true)
    } catch (e) {
      setStatus('Sync failed: ' + e.message, 'error')
      toast('Sync failed', 'error')
      setLive(false)
    }
  }

  /* ── render timeline ── */
  function renderTimeline() {
    const tl = S.timeline
    if (!tl || !tl.tracks || !tl.tracks.length) {
      el.timelineBody.innerHTML =
        '<div class="empty-state"><div class="empty-state-icon">⊞</div><div class="empty-state-text">No clips found</div><div class="empty-state-hint">Open a Resolve project with video clips</div></div>'
      el.clipCount.textContent = '0'
      return
    }
    let totalClips = 0
    let html = ''
    for (const track of tl.tracks) {
      html += '<div class="track">'
      html += '<div class="track-label" data-track="' + track.index + '">' +
        '<span class="track-num">V' + track.index + '</span>' + track.items.length + ' clips</div>'
      html += '<div class="track-items">'
      for (const item of track.items) {
        totalClips++
        const sel = item.id === S.uid ? ' selected' : ''
        html += '<div class="clip' + sel + '" data-uid="' + item.id + '">' +
          '<canvas class="clip-preview" data-uid="' + item.id + '" width="44" height="14"></canvas>' +
          '<span class="clip-name">' + esc(item.name) + '</span>' +
          '<span class="clip-frames">' + item.start + '–' + item.end + '</span>' +
          '<span class="clip-apply-tick" data-uid="' + item.id + '">●</span>' +
          '</div>'
      }
      html += '</div></div>'
    }
    el.timelineBody.innerHTML = html
    el.clipCount.textContent = totalClips

    el.timelineBody.querySelectorAll('.clip').forEach((el_) => {
      el_.addEventListener('click', () => selectClip(el_.dataset.uid))
    })
    drawAllPreviews()
  }

  function markClipApplied(uid) {
    updatePreview(uid)
    const tick = el.timelineBody.querySelector('.clip-apply-tick[data-uid="' + uid + '"]')
    if (tick) {
      tick.classList.add('show')
      setTimeout(() => tick.classList.remove('show'), 1200)
    }
  }

  /* ── select clip ── */
  async function selectClip(uid) {
    if (uid === S.uid) return  // already selected
    S.uid = uid
    S.samples = []
    clearUndo()

    el.timelineBody.querySelectorAll('.clip').forEach((e) => e.classList.toggle('selected', e.dataset.uid === uid))

    if (!uid) {
      el.clipName.textContent = 'No clip selected'
      el.clipDur.textContent = ''
      el.clipIndicator.style.background = 'var(--border)'
      closePreview()
      draw()
      return
    }

    const track = S.timeline.tracks.find((t) => t.items.some((i) => i.id === uid))
    const item = track ? track.items.find((i) => i.id === uid) : null
    if (item) {
      el.clipName.textContent = item.name
      const dur = item.end - item.start
      el.clipDur.textContent = dur + 'f'
      el.clipIndicator.style.background = 'var(--gold)'
      S.pointCount = Math.min(20, Math.max(6, Math.round(dur / 6)))
    }

    setStatus('Loading curve…')
    try {
      const a = await getApi()
      const loaded = await a.get_curve(uid)
      if (loaded.ok && loaded.points) {
        try {
          const p = JSON.parse(loaded.points)
          if (p && p.samples && p.samples.length >= 2) {
            S.samples = p.samples
            S.pointCount = S.samples.length
            setStatus('Loaded saved curve', 'success')
          } else { initDefaultSamples() }
        } catch (_) { initDefaultSamples() }
      } else { initDefaultSamples() }
    } catch (_) { initDefaultSamples() }

    draw()
  }

  function initDefaultSamples() {
    S.samples = []
    for (let i = 0; i < S.pointCount; i++) S.samples.push(100)
    setStatus('New curve — ' + S.pointCount + ' points')
  }

  /* ── presets ── */
  function applyPreset(name) {
    if (!S.samples.length) initDefaultSamples()
    pushUndo()
    const n = S.pointCount
    S.samples = []
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1)
      let v = 100
      switch (name) {
        case 'ramp-up':
          v = lerp(30, 250, u * u)
          break
        case 'ramp-down':
          v = lerp(250, 30, u * u)
          break
        case 'bump':
          v = 100 + 120 * Math.sin(u * Math.PI)
          break
        case 'echo':
          v = 100 + 80 * Math.sin(u * Math.PI * 3) * (1 - u)
          break
        case 'flat':
          v = 100
          break
      }
      S.samples.push(clamp(Math.round(v), 0, 400))
    }
    draw()
    if (S.live && S.uid) debouncedApply()
    toast('Preset: ' + name, 'success')
  }

  /* ── curve drawing ── */
  let _pts = []

  function draw() {
    const rect = area.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    cnv.width = rect.width * dpr
    cnv.height = rect.height * dpr
    cnv.style.width = rect.width + 'px'
    cnv.style.height = rect.height + 'px'
    ctx.scale(dpr, dpr)

    const W = rect.width, H = rect.height
    const pad = { t: 24, b: 28, l: 50, r: 20 }
    const cw = W - pad.l - pad.r
    const ch = H - pad.t - pad.b

    ctx.clearRect(0, 0, W, H)

    if (cw < 20 || ch < 20 || !S.samples.length) {
      _pts = []
      return
    }

    const samples = S.samples
    const n = samples.length
    const spdMax = Math.max(400, Math.max(...samples) * 1.1)
    const spdMin = 0

    // ── background ──
    const grad = ctx.createRadialGradient(W / 2, pad.t, 0, W / 2, pad.t, ch * 1.2)
    grad.addColorStop(0, '#141417')
    grad.addColorStop(1, '#0e0e10')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, W, H)

    // ── grid ──
    for (let row = 0; row <= 4; row++) {
      const y = pad.t + (ch * row / 4)
      ctx.beginPath()
      ctx.moveTo(pad.l, y)
      ctx.lineTo(W - pad.r, y)
      ctx.strokeStyle = row === 2 ? 'rgba(200,164,92,0.06)' : 'rgba(255,255,255,0.03)'
      ctx.lineWidth = 1
      ctx.stroke()

      // label
      const pct = Math.round(spdMax - (row / 4) * spdMax)
      ctx.fillStyle = '#555'
      ctx.font = '10px ' + getComputedStyle(document.documentElement).getPropertyValue('--font-mono')
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(pct + '%', pad.l - 8, y)
    }

    // vertical grid lines
    for (let i = 0; i < n; i++) {
      const x = pad.l + (cw * i / (n - 1))
      ctx.beginPath()
      ctx.moveTo(x, pad.t)
      ctx.lineTo(x, H - pad.b)
      ctx.strokeStyle = 'rgba(255,255,255,0.02)'
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // ── 100% ref line ──
    const refY = pad.t + ch * (1 - 100 / spdMax)
    ctx.beginPath()
    ctx.setLineDash([4, 4])
    ctx.moveTo(pad.l, refY)
    ctx.lineTo(W - pad.r, refY)
    ctx.strokeStyle = 'rgba(200,164,92,0.08)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.setLineDash([])

    // ── map points ──
    const pts = []
    for (let i = 0; i < n; i++) {
      const x = pad.l + (cw * i / (n - 1))
      const y = pad.t + ch * (1 - clamp(samples[i], 0, spdMax) / spdMax)
      pts.push({ x, y, i, v: samples[i] })
    }
    _pts = pts

    // ── gradient fill ──
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pad.t + ch)
    for (const p of pts) ctx.lineTo(p.x, p.y)
    ctx.lineTo(pts[n - 1].x, pad.t + ch)
    ctx.closePath()

    const fillGrad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ch)
    fillGrad.addColorStop(0, 'rgba(200,164,92,0.15)')
    fillGrad.addColorStop(0.5, 'rgba(91,191,122,0.08)')
    fillGrad.addColorStop(1, 'rgba(91,191,122,0.02)')
    ctx.fillStyle = fillGrad
    ctx.fill()

    // ── curve line ──
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    if (n > 2) {
      for (let i = 0; i < n - 1; i++) {
        const a = pts[i], b = pts[i + 1]
        const cp1x = a.x + (b.x - a.x) * 0.35
        const cp2x = b.x - (b.x - a.x) * 0.35
        ctx.bezierCurveTo(cp1x, a.y, cp2x, b.y, b.x, b.y)
      }
    } else {
      ctx.lineTo(pts[1].x, pts[1].y)
    }

    ctx.strokeStyle = '#c8a45c'
    ctx.lineWidth = 2.5
    ctx.shadowColor = 'rgba(200,164,92,0.2)'
    ctx.shadowBlur = 6
    ctx.stroke()
    ctx.shadowBlur = 0

    // glow overlay
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    if (n > 2) {
      for (let i = 0; i < n - 1; i++) {
        const a = pts[i], b = pts[i + 1]
        ctx.bezierCurveTo(
          a.x + (b.x - a.x) * 0.35, a.y,
          b.x - (b.x - a.x) * 0.35, b.y,
          b.x, b.y
        )
      }
    } else {
      ctx.lineTo(pts[1].x, pts[1].y)
    }
    ctx.strokeStyle = 'rgba(200,164,92,0.08)'
    ctx.lineWidth = 8
    ctx.stroke()

    // ── points ──
    for (const p of pts) {
      const isHover = S.ptHover === p.i
      const r = isHover ? 7 : 5

      // glow for hovered
      if (isHover) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, 14, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(200,164,92,0.08)'
        ctx.fill()
      }

      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)

      if (isHover) {
        ctx.fillStyle = '#f0f0f5'
        ctx.shadowColor = 'rgba(200,164,92,0.5)'
        ctx.shadowBlur = 12
      } else {
        ctx.fillStyle = '#e0e0e8'
        ctx.shadowColor = 'transparent'
        ctx.shadowBlur = 0
      }
      ctx.fill()
      ctx.strokeStyle = '#c8a45c'
      ctx.lineWidth = 2
      ctx.shadowBlur = 0
      ctx.stroke()

      // value label on hover
      if (isHover) {
        ctx.fillStyle = '#c8a45c'
        ctx.font = '10px ' + getComputedStyle(document.documentElement).getPropertyValue('--font-mono')
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        ctx.fillText(p.v + '%', p.x, p.y - 12)
      }
    }

    // ── stats ──
    updateStats(samples)

    // ── timeline preview ──
    if (S.uid) updatePreview(S.uid)

    // ── auto video preview ──
    if (S.uid) debouncedAutoPreview()
  }

  /* ── stats ── */
  function updateStats(samples) {
    if (!samples || !samples.length) {
      el.statAvg.textContent = '—'
      el.statMin.textContent = '—'
      el.statMax.textContent = '—'
      el.statPoints.textContent = '—'
      el.statFrames.textContent = '—'
      return
    }
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length
    el.statAvg.textContent = Math.round(avg) + '%'
    el.statMin.textContent = Math.round(Math.min(...samples)) + '%'
    el.statMax.textContent = Math.round(Math.max(...samples)) + '%'
    el.statPoints.textContent = samples.length

    // frames from timeline
    if (S.uid && S.timeline) {
      for (const t of S.timeline.tracks) {
        for (const i of t.items) {
          if (i.id === S.uid) {
            el.statFrames.textContent = (i.end - i.start) + 'f'
            return
          }
        }
      }
    }
    el.statFrames.textContent = '—'
  }

  /* ── mouse helpers ── */
  function getRect() { return area.getBoundingClientRect() }

  function getPad() {
    const r = getRect()
    return { t: 24, b: 28, l: 50, r: 20, cw: r.width - 50 - 20, ch: r.height - 24 - 28 }
  }

  function hitTest(mx, my) {
    for (const p of _pts) {
      if (Math.abs(mx - p.x) < 10 && Math.abs(my - p.y) < 14) return p
    }
    return null
  }

  function mouseToSpeed(mx, my) {
    const p = getPad()
    const r = getRect()
    const relX = mx - p.l
    const relY = my - p.t
    const u = clamp(relX / p.cw, 0, 1)
    const spdMax = Math.max(400, ...S.samples)
    const speed = clamp(Math.round((1 - relY / p.ch) * spdMax), 0, 400)
    return { u, speed, idx: Math.round(u * (S.samples.length - 1)) }
  }

  /* ── mouse events ── */
  let dragIdx = null
  let dragOrig = null

  function onDown(e) {
    if (e.button !== 0 || !S.samples.length) return
    const ab = area.getBoundingClientRect()
    const mx = e.clientX - ab.left
    const my = e.clientY - ab.top
    const hit = hitTest(mx, my)
    if (hit) {
      dragIdx = hit.i
      dragOrig = S.samples[hit.i]
      pushUndo()
      return
    }
    pushUndo()
    const m = mouseToSpeed(mx, my)
    S.samples[m.idx] = m.speed
    dragIdx = m.idx
    draw()
  }

  function onMove(e) {
    const r = cnv.getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top

    if (dragIdx !== null) {
      const ab = area.getBoundingClientRect()
      const m = mouseToSpeed(e.clientX - ab.left, e.clientY - ab.top)
      S.samples[dragIdx] = m.speed
      draw()
      // live push
      if (S.live && S.uid) debouncedApply()
      return
    }

    // hover
    const hit = hitTest(mx, my)
    if (hit) {
      S.ptHover = hit.i
      cnv.style.cursor = 'grab'
      readout.textContent = hit.v + '% @ ' + (hit.i + 1) + '/' + S.samples.length
      readout.style.left = Math.min(mx + 16, r.width - 80) + 'px'
      readout.style.top = (my - 30) + 'px'
      readout.classList.add('visible')
    } else {
      S.ptHover = null
      cnv.style.cursor = 'crosshair'
      const ab = area.getBoundingClientRect()
      const m = mouseToSpeed(e.clientX - ab.left, e.clientY - ab.top)
      if (m.idx >= 0 && m.idx < S.samples.length) {
        readout.textContent = m.speed + '% @ ' + (m.idx + 1)
        readout.style.left = Math.min(mx + 16, r.width - 80) + 'px'
        readout.style.top = (my - 30) + 'px'
        readout.classList.add('visible')
      } else {
        readout.classList.remove('visible')
      }
    }
    draw()
  }

  function onUp() {
    if (dragIdx !== null) {
      dragIdx = null
      cnv.style.cursor = 'crosshair'
      draw()
      if (S.live && S.uid) debouncedApply()
    }
  }

  function onLeave() {
    dragIdx = null
    S.ptHover = null
    readout.classList.remove('visible')
    draw()
  }

  function onWheel(e) {
    e.preventDefault()
    if (!S.samples.length) return
    const r = cnv.getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    const hit = hitTest(mx, my)
    if (hit) {
      const delta = e.deltaY > 0 ? -5 : 5
      pushUndo()
      S.samples[hit.i] = clamp(S.samples[hit.i] + delta, 0, 400)
      draw()
      if (S.live && S.uid) debouncedApply()
    }
  }

  /* ── keyboard ── */
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) { e.preventDefault(); redo() }
    if ((e.metaKey || e.ctrlKey) && e.key === 'r') { e.preventDefault(); refresh() }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); applyRamp() }
    if (e.key === 'r' && !(e.metaKey || e.ctrlKey)) { resetCurve() }
    if (e.key === 's' && !(e.metaKey || e.ctrlKey)) { smooth() }
    if (e.key === 'Delete' || e.key === 'Backspace') { deletePoint() }
  })

  /* ── smooth ── */
  function smooth() {
    if (!S.samples || S.samples.length < 3) return
    pushUndo()
    const n = S.samples.length
    const pct = S.smooth / 100
    const orig = S.samples.slice()
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 1; i < n - 1; i++) {
        S.samples[i] = Math.round(orig[i] * (1 - pct) + (orig[i - 1] + orig[i + 1]) / 2 * pct)
      }
    }
    draw()
    if (S.live && S.uid) debouncedApply()
    toast('Smoothed', 'success')
  }

  function resetCurve() {
    if (!S.samples.length) return
    pushUndo()
    for (let i = 0; i < S.samples.length; i++) S.samples[i] = 100
    draw()
    if (S.live && S.uid) debouncedApply()
    toast('Reset to flat', 'success')
  }

  function deletePoint() {
    if (S.ptHover === null || !S.samples || S.samples.length <= 2) return
    pushUndo()
    S.samples.splice(S.ptHover, 1)
    S.pointCount = S.samples.length
    S.ptHover = null
    draw()
    if (S.live && S.uid) debouncedApply()
    toast('Point removed', 'success')
  }

  /* ── apply to Resolve ── */
  let applyTimer = null

  function debouncedApply() {
    clearTimeout(applyTimer)
    applyTimer = setTimeout(doApply, 50)
  }

  async function doApply() {
    if (!S.uid || !S.samples || S.samples.length < 2) return
    const a = await getApi()
    const samples = S.samples.slice()
    const pointsJson = JSON.stringify({ samples, version: 2, pointCount: S.samples.length })
    try {
      const r = await a.apply(S.uid, samples, pointsJson)
      if (r.ok) {
        markClipApplied(S.uid)
      }
    } catch (_) {}
  }

  async function applyRamp() {
    if (!S.uid) { setStatus('Select a clip first', 'error'); toast('No clip selected', 'error'); return }
    if (!S.samples || S.samples.length < 2) { setStatus('Not enough points', 'error'); return }
    const a = await getApi()
    const samples = S.samples.slice()
    const pointsJson = JSON.stringify({ samples, version: 2, pointCount: S.samples.length })
    setStatus('Applying…')
    try {
      const r = await a.apply(S.uid, samples, pointsJson)
      if (r.ok) {
        setStatus(r.msg, 'success')
        toast('Applied ✓', 'success')
        markClipApplied(S.uid)
      } else {
        setStatus(r.msg, 'error')
        toast(r.msg, 'error')
      }
    } catch (e) {
      setStatus('Apply failed: ' + e.message, 'error')
      toast('Apply failed', 'error')
    }
  }

  /* ── video preview ── */
  let previewTimer = null

  async function generatePreview() {
    if (!S.uid || !S.samples || S.samples.length < 2) {
      setStatus('No clip or curve to preview', 'error')
      return
    }
    el.previewPanel.classList.add('open')
    el.previewPanel.querySelector('.preview-body').classList.add('loading')
    el.previewVideo.classList.remove('ready')
    setStatus('Generating preview…')
    try {
      const a = await getApi()
      const r = await a.preview(S.uid, S.samples.slice())
      if (r.ok) {
        el.previewVideo.src = r.path
        el.previewVideo.load()
        el.previewVideo.oncanplay = function () {
          el.previewVideo.classList.add('ready')
          el.previewPanel.querySelector('.preview-body').classList.remove('loading')
          el.previewVideo.play().catch(function () {})
          setStatus('Preview ready', 'success')
        }
        el.previewVideo.onerror = function () {
          el.previewPanel.querySelector('.preview-body').classList.remove('loading')
          setStatus('Preview failed to load', 'error')
        }
      } else {
        el.previewPanel.querySelector('.preview-body').classList.remove('loading')
        setStatus(r.msg, 'error')
        toast(r.msg, 'error')
      }
    } catch (e) {
      el.previewPanel.querySelector('.preview-body').classList.remove('loading')
      setStatus('Preview error: ' + e.message, 'error')
    }
  }

  function closePreview() {
    el.previewPanel.classList.remove('open')
    el.previewVideo.classList.remove('ready')
    el.previewVideo.pause()
    el.previewVideo.src = ''
  }

  function debouncedAutoPreview() {
    clearTimeout(previewTimer)
    previewTimer = setTimeout(generatePreview, 400)
  }

  /* ── resize ── */
  let resizeTimer
  function onResize() {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(draw, 60)
  }

  /* ── init ── */
  function init() {
    // buttons
    el.refreshBtn.addEventListener('click', refresh)
    el.applyBtn.addEventListener('click', applyRamp)
    el.undoBtn.addEventListener('click', undo)
    el.redoBtn.addEventListener('click', redo)

    // presets
    document.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => applyPreset(btn.dataset.preset))
    })

    // smooth slider
    el.smoothSlider.addEventListener('input', function () {
      S.smooth = parseInt(this.value)
      el.smoothLabel.textContent = S.smooth
    })

    // preview
    el.genPreviewBtn.addEventListener('click', function () {
      clearTimeout(previewTimer)
      generatePreview()
    })
    el.closePreviewBtn.addEventListener('click', closePreview)

    // canvas events
    cnv.addEventListener('mousedown', onDown)
    cnv.addEventListener('mousemove', onMove)
    cnv.addEventListener('mouseup', onUp)
    cnv.addEventListener('mouseleave', onLeave)
    cnv.addEventListener('wheel', onWheel, { passive: false })

    // resize
    window.addEventListener('resize', onResize)
    new ResizeObserver(onResize).observe(area)

    // go
    refresh()
  }

  // hotkey hint reset button
  document.addEventListener('DOMContentLoaded', init)
  if (document.readyState !== 'loading') init()
})()
