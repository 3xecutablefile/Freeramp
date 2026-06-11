(function() {
  'use strict';

  const domain = window.pywebview ? window.pywebview.api : window;

  let state = {
    timeline: null,
    selectedUid: null,
    samples: [100, 100, 100, 100, 100],
    dragging: null,
    points: null,
    smoothPct: 50,
  };

  const curveCanvas = document.getElementById('curveCanvas');
  const ctx = curveCanvas.getContext('2d');
  const curveArea = document.getElementById('curveArea');

  const $ = id => document.getElementById(id);
  const clipName = $('clipName');
  const clipInfo = $('clipInfo');
  const timelineBody = $('timelineBody');
  const statusBar = $('statusBar');
  const speedDisplay = $('speedDisplay');
  const smoothSlider = $('smoothSlider');
  const smoothVal = $('smoothVal');

  function setStatus(msg, type) {
    statusBar.textContent = msg;
    statusBar.className = 'status' + (type ? ' ' + type : '');
  }

  function setStatusSuccess(msg) { setStatus(msg, 'success'); }
  function setStatusError(msg) { setStatus(msg, 'error'); }

  async function refresh() {
    setStatus('Loading timeline...');
    try {
      const result = await domain.list_timeline();
      if (!result.ok) { setStatusError(result.msg); return; }
      state.timeline = result;
      state.selectedUid = null;
      renderTimeline();
      selectClip(null);
      setStatusSuccess('Loaded: ' + result.name);
    } catch (e) {
      setStatusError('Failed to load: ' + e.message);
    }
  }

  function renderTimeline() {
    const tl = state.timeline;
    if (!tl) { timelineBody.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim)">No timeline loaded</div>'; return; }
    let html = '';
    for (const track of tl.tracks) {
      const trackId = 't' + track.index;
      html += '<div class="track"><div class="track-label" data-track="' + track.index + '">Track ' + track.index + '</div>';
      html += '<div id="' + trackId + '">';
      for (const item of track.items) {
        const sel = item.id === state.selectedUid ? ' selected' : '';
        html += '<div class="clip' + sel + '" data-uid="' + item.id + '">' + esc(item.name) + ' <span class="frames">' + item.start + '–' + item.end + '</span></div>';
      }
      html += '</div></div>';
    }
    timelineBody.innerHTML = html;

    timelineBody.querySelectorAll('.clip').forEach(el => {
      el.addEventListener('click', () => selectClip(el.dataset.uid));
    });
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function(m) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]; }); }

  async function selectClip(uid) {
    state.selectedUid = uid;
    timelineBody.querySelectorAll('.clip').forEach(el => el.classList.toggle('selected', el.dataset.uid === uid));

    if (!uid) {
      clipName.textContent = 'No clip selected';
      clipInfo.textContent = '';
      state.samples = [100, 100, 100, 100, 100];
      drawCurve();
      return;
    }

    const track = state.timeline.tracks.find(t => t.items.some(i => i.id === uid));
    const item = track ? track.items.find(i => i.id === uid) : null;
    clipName.textContent = item ? item.name : 'Clip';
    clipInfo.textContent = item ? (item.start + '–' + item.end) : '';

    setStatus('Loading curve for ' + clipName.textContent + '...');
    try {
      const result = await domain.get_curve(uid);
      if (result.ok && result.points) {
        state.points = result.points;
        try {
          const parsed = JSON.parse(result.points);
          if (parsed && parsed.samples && parsed.samples.length >= 2) {
            state.samples = parsed.samples;
            setStatusSuccess('Loaded saved curve');
          }
        } catch(e) {}
      }
      if (!state.points) {
        const dur = item ? (item.end - item.start) : 100;
        const segs = Math.min(16, Math.max(4, Math.floor(dur / 8)));
        state.samples = [];
        for (let i = 0; i < segs; i++) state.samples.push(100);
      }
      drawCurve();
    } catch (e) {
      setStatusError('Error loading curve');
    }
  }

  function applySmooth() {
    const n = state.samples.length;
    if (n < 3) return;
    const pct = state.smoothPct / 100;
    const orig = state.samples.slice();
    for (let iter = 0; iter < 3; iter++) {
      for (let i = 1; i < n - 1; i++) {
        state.samples[i] = orig[i] * (1 - pct) + (orig[i-1] + orig[i+1]) / 2 * pct;
      }
    }
  }

  async function applyRamp() {
    if (!state.selectedUid) { setStatusError('Select a clip first'); return; }
    const samples = state.samples.slice();
    const pointsJson = JSON.stringify({ samples, version: 1 });
    setStatus('Applying ramp...');
    try {
      const result = await domain.apply(state.selectedUid, samples, pointsJson);
      if (result.ok) {
        setStatusSuccess(result.msg);
        state.points = pointsJson;
      } else {
        setStatusError(result.msg);
      }
    } catch (e) {
      setStatusError('Apply failed: ' + e.message);
    }
  }

  function drawCurve() {
    const rect = curveArea.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    curveCanvas.width = rect.width * dpr;
    curveCanvas.height = rect.height * dpr;
    curveCanvas.style.width = rect.width + 'px';
    curveCanvas.style.height = rect.height + 'px';
    ctx.scale(dpr, dpr);

    const W = rect.width, H = rect.height;
    const pad = { t: 20, b: 24, l: 44, r: 16 };
    const cw = W - pad.l - pad.r;
    const ch = H - pad.t - pad.b;

    ctx.clearRect(0, 0, W, H);

    if (cw < 20 || ch < 20) return;

    const samples = state.samples;
    const n = samples.length;

    // bg
    ctx.fillStyle = '#1a1a1f';
    ctx.fillRect(0, 0, W, H);

    // grid
    ctx.strokeStyle = '#2a2a30';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (ch * i / 4);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      const val = Math.round(200 - (i / 4) * 200);
      ctx.fillStyle = '#555';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(val + '%', pad.l - 6, y + 3);
    }
    for (let i = 0; i < n; i++) {
      const x = pad.l + (cw * i / (n - 1));
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke();
    }

    // 100% reference line
    ctx.strokeStyle = '#333';
    ctx.setLineDash([3, 3]);
    const refY = pad.t + ch * 0.5;
    ctx.beginPath(); ctx.moveTo(pad.l, refY); ctx.lineTo(W - pad.r, refY); ctx.stroke();
    ctx.setLineDash([]);

    // speed samples
    const points = [];
    for (let i = 0; i < n; i++) {
      const x = pad.l + (cw * i / (n - 1));
      const y = pad.t + ch * (1 - clamp(samples[i], 0, 200) / 200);
      points.push({ x, y, i, val: samples[i] });
    }

    // filled area
    ctx.beginPath();
    ctx.moveTo(points[0].x, pad.t + ch);
    for (const p of points) ctx.lineTo(p.x, p.y);
    ctx.lineTo(points[n-1].x, pad.t + ch);
    ctx.closePath();
    ctx.fillStyle = 'rgba(91,141,239,0.12)';
    ctx.fill();

    // curve line
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    if (n > 2) {
      for (let i = 0; i < n - 1; i++) {
        const p0 = points[i], p1 = points[i + 1];
        const cp1x = p0.x + (p1.x - p0.x) * 0.4;
        const cp1y = p0.y;
        const cp2x = p1.x - (p1.x - p0.x) * 0.4;
        const cp2y = p1.y;
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p1.x, p1.y);
      }
    } else {
      ctx.lineTo(points[1].x, points[1].y);
    }
    ctx.strokeStyle = '#5b8def';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // handles
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#5b8def';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // label
    const avg = samples.reduce((a,b)=>a+b,0) / n;
    speedDisplay.textContent = Math.round(avg) + '%';

    state._points = points;
  }

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  function curveHit(e) {
    const rect = curveCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const pts = state._points;
    if (!pts) return null;
    for (const p of pts) {
      if (Math.abs(mx - p.x) < 8 && Math.abs(my - p.y) < 12) return p;
    }
    return null;
  }

  function curveCoords(e) {
    const rect = curveCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const rect2 = curveArea.getBoundingClientRect();
    const pad_l = 44, pad_r = 16, pad_t = 20, pad_b = 24;
    const cw = rect2.width - pad_l - pad_r;
    const ch = rect2.height - pad_t - pad_b;
    const u = clamp((mx - pad_l) / cw, 0, 1);
    const speed = clamp(Math.round((1 - (my - pad_t) / ch) * 200), 0, 200);
    return { u, speed, mx, my };
  }

  function addPoint(e) {
    const pts = state._points;
    if (!pts) return;
    const coords = curveCoords(e);
    const n = state.samples.length;
    const idx = Math.round(coords.u * (n - 1));
    if (idx >= 0 && idx < n) {
      state.samples[idx] = coords.speed;
      drawCurve();
    }
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    const hit = curveHit(e);
    if (hit) {
      state.dragging = hit.i;
      return;
    }
    addPoint(e);
  }

  function onMouseMove(e) {
    if (state.dragging !== null) {
      const coords = curveCoords(e);
      state.samples[state.dragging] = coords.speed;
      drawCurve();
    }
  }

  function onMouseUp() {
    state.dragging = null;
  }

  function onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -5 : 5;
    const hit = curveHit(e);
    if (hit) {
      state.samples[hit.i] = clamp(state.samples[hit.i] + delta, 0, 200);
      drawCurve();
    }
  }

  function resetCurve() {
    const n = state.samples.length;
    state.samples = [];
    for (let i = 0; i < n; i++) state.samples.push(100);
    drawCurve();
  }

  function resizeCanvas() {
    drawCurve();
  }

  document.getElementById('refreshBtn').addEventListener('click', refresh);
  document.getElementById('applyBtn').addEventListener('click', applyRamp);
  document.getElementById('resetCurveBtn').addEventListener('click', resetCurve);

  curveCanvas.addEventListener('mousedown', onMouseDown);
  curveCanvas.addEventListener('mousemove', onMouseMove);
  curveCanvas.addEventListener('mouseup', onMouseUp);
  curveCanvas.addEventListener('mouseleave', onMouseUp);
  curveCanvas.addEventListener('wheel', onWheel, { passive: false });

  smoothSlider.addEventListener('input', function() {
    smoothVal.textContent = this.value;
    state.smoothPct = parseInt(this.value);
    applySmooth();
    drawCurve();
  });

  let resizeTimer;
  window.addEventListener('resize', function() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeCanvas, 60);
  });

  new ResizeObserver(resizeCanvas).observe(curveArea);

  refresh();
})();
