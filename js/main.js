'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const canvas = $('glcanvas');
  const banner = $('fallback-banner');

  let renderer;
  try {
    renderer = new Renderer(canvas);
  } catch (err) {
    banner.textContent = '初始化失败：' + err.message;
    banner.classList.remove('hidden');
    return;
  }

  // ---------- 状态 ----------
  const state = {
    mode: 'instanced',
    effectiveMode: 'instanced',
    count: 100000,
    capNaive: true,
    degraded: false,
    degradeReason: '',
    latestFrame: null,   // {buffer:ArrayBuffer, count}
    pendingBuffers: [],  // 可回收的 ArrayBuffer 池
    inflight: 0,
  };

  // ---------- Worker（Blob 方式，兼容 file://） ----------
  const workerSrc = $('sim-worker-src').textContent;
  const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));

  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'frame') {
      state.inflight--;
      if (state.latestFrame) state.pendingBuffers.push(state.latestFrame.buffer);
      state.latestFrame = msg;
    } else if (msg.type === 'count' || msg.type === 'ready') {
      state.count = msg.count;
      $('countLabel').textContent = msg.count;
      // 数量变化后丢弃旧帧（缓冲尺寸可能不匹配）
      if (state.latestFrame && state.latestFrame.count !== msg.count) {
        state.latestFrame = null;
      }
    }
  };
  worker.postMessage({ type: 'init', count: state.count });

  function requestTick(dt) {
    if (state.inflight >= 2) return; // 背压：最多两帧在途
    let buf = state.pendingBuffers.pop();
    const need = state.count * 7 * 4;
    if (!buf || buf.byteLength < need) buf = new ArrayBuffer(need);
    state.inflight++;
    worker.postMessage({ type: 'tick', dt, buffer: buf }, [buf]);
  }

  // ---------- PerformanceObserver ----------
  const perf = { submitMs: 0, longtasks: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name === 'render-submit') perf.submitMs = e.duration;
      }
    }).observe({ entryTypes: ['measure'] });
    new PerformanceObserver((list) => {
      perf.longtasks += list.getEntries().length;
    }).observe({ entryTypes: ['longtask'] });
  } catch (err) {
    console.warn('PerformanceObserver 不可用', err);
  }

  // ---------- 降级逻辑 ----------
  function resolveEffectiveMode() {
    state.degraded = false;
    state.degradeReason = '';
    let mode = state.mode;
    if (mode === 'instanced') {
      const needBytes = state.count * 28;
      if (needBytes > renderer.vramBudgetBytes) {
        mode = 'batched';
        state.degraded = true;
        state.degradeReason = `实例缓冲需 ${(needBytes / 1048576).toFixed(1)} MB，超出显存预算，已降级到批处理`;
      } else if (renderer.oom) {
        mode = 'batched';
        state.degraded = true;
        state.degradeReason = 'gl.OUT_OF_MEMORY：实例缓冲分配失败，已降级到批处理';
      }
    }
    if (mode === 'batched') {
      const needBytes = state.count * 6 * 9 * 4;
      if (needBytes > renderer.vramBudgetBytes) {
        mode = 'naive';
        state.degraded = true;
        state.degradeReason = `批处理顶点缓冲需 ${(needBytes / 1048576).toFixed(1)} MB，超出显存预算，已降级到逐物体绘制`;
      }
    }
    state.effectiveMode = mode;
    if (state.degraded) {
      banner.textContent = '⚠ ' + state.degradeReason;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  // ---------- 统计 ----------
  const stats = {
    fps: 0, frameMs: 0,
    best: { naive: null, batched: null, instanced: null },
  };
  const fpsSamples = [];
  const chart = $('fpschart').getContext('2d');

  function recordCompare(mode) {
    if (fpsSamples.length < 30) return; // 预热后再记录
    stats.best[mode] = {
      fps: stats.fps, frameMs: stats.frameMs,
      submitMs: perf.submitMs, draws: renderer.drawCalls,
    };
    const row = $('row-' + mode);
    const c = row.children;
    c[1].textContent = stats.fps.toFixed(1);
    c[2].textContent = stats.frameMs.toFixed(2);
    c[3].textContent = perf.submitMs.toFixed(2);
    c[4].textContent = renderer.drawCalls;
  }

  function drawChart() {
    const w = chart.canvas.width, h = chart.canvas.height;
    chart.fillStyle = '#11141c';
    chart.fillRect(0, 0, w, h);
    chart.strokeStyle = '#3ddc84';
    chart.beginPath();
    const n = fpsSamples.length;
    for (let i = 0; i < n; i++) {
      const x = (i / 120) * w;
      const y = h - Math.min(1, fpsSamples[i] / 120) * h;
      i === 0 ? chart.moveTo(x, y) : chart.lineTo(x, y);
    }
    chart.stroke();
    chart.fillStyle = '#9aa4b2';
    chart.font = '10px monospace';
    chart.fillText('FPS ' + stats.fps.toFixed(0), 4, 10);
  }

  // ---------- 主循环 ----------
  let lastT = performance.now();
  let statTimer = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = (now - lastT) / 1000;
    lastT = now;
    renderer.resize();
    resolveEffectiveMode();

    renderer.drawCalls = 0;
    renderer.clear();

    const f = state.latestFrame;
    if (f && f.count > 0) {
      const data = new Float32Array(f.buffer);
      performance.mark('submit-start');
      const mode = state.effectiveMode;
      if (mode === 'instanced') {
        if (renderer.ensureInstanceBuffer(f.count)) {
          renderer.uploadInstances(data, f.count);
          renderer.drawInstanced(f.count);
        }
      } else if (mode === 'batched') {
        renderer.drawBatched(data, f.count);
      } else {
        const maxDraws = state.capNaive ? 20000 : f.count;
        renderer.drawNaive(data, f.count, maxDraws);
      }
      performance.mark('submit-end');
      performance.measure('render-submit', 'submit-start', 'submit-end');
    }

    requestTick(dt);

    // 统计聚合（每 250ms 刷新一次 UI）
    const frameMs = dt * 1000;
    fpsSamples.push(1 / Math.max(dt, 1e-4));
    if (fpsSamples.length > 120) fpsSamples.shift();
    statTimer += dt;
    if (statTimer >= 0.25) {
      statTimer = 0;
      stats.fps = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
      stats.frameMs = 1000 / stats.fps;
      recordCompare(state.effectiveMode);
      $('stMode').textContent = state.effectiveMode + (state.degraded ? '（已降级）' : '');
      $('stFps').textContent = stats.fps.toFixed(1);
      $('stFrame').textContent = stats.frameMs.toFixed(2) + ' ms';
      $('stSubmit').textContent = perf.submitMs.toFixed(2) + ' ms';
      $('stDraws').textContent = renderer.drawCalls;
      $('stCount').textContent = state.count;
      $('stVram').textContent = (renderer.gpuBytes / 1048576).toFixed(1) + ' MB';
      $('stLongtask').textContent = perf.longtasks;
      drawChart();
    }
  }
  requestAnimationFrame(frame);

  // ---------- UI ----------
  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.addEventListener('change', () => {
      state.mode = r.value;
      fpsSamples.length = 0; // 切换后重新预热
    });
  });
  $('capNaive').addEventListener('change', (e) => { state.capNaive = e.target.checked; });

  function setCount(n) {
    n = Math.max(0, Math.min(200000, n));
    $('countSlider').value = n;
    $('countLabel').textContent = n;
    worker.postMessage({ type: 'setCount', count: n });
  }
  $('countSlider').addEventListener('input', (e) => setCount(+e.target.value));
  $('addBtn').addEventListener('click', () => setCount(state.count + 5000));
  $('removeBtn').addEventListener('click', () => setCount(state.count - 5000));
  $('resetBtn').addEventListener('click', () => setCount(100000));

  $('vramSlider').addEventListener('input', (e) => {
    const mb = +e.target.value;
    $('vramLabel').textContent = mb;
    renderer.vramBudgetBytes = mb * 1048576;
    if (state.degraded === false) renderer.oom = false; // 预算放宽后允许重试实例化
  });
  renderer.vramBudgetBytes = 256 * 1048576;

  // ---------- 上下文丢失 ----------
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    banner.textContent = '⚠ WebGL 上下文丢失（显存不足/驱动重置），等待恢复…';
    banner.classList.remove('hidden');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    renderer._initGL();
    renderer.instanceCapacity = 0;
    renderer.batchCapacity = 0;
    banner.classList.add('hidden');
  });
})();
