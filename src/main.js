'use strict';
import { createGL, createRenderers, INSTANCE_FLOATS } from './renderer.js';

const INITIAL_COUNT = 100000;
const WORLD_H = 100;

const $ = (id) => document.getElementById(id);
const canvas = $('gl');
const ui = {
  modes: document.querySelectorAll('input[name="mode"]'),
  countInput: $('countInput'),
  setCount: $('setCount'),
  add1k: $('add1k'), add10k: $('add10k'),
  rm1k: $('rm1k'), rm10k: $('rm10k'),
  churn: $('churn'),
  vram: $('vram'), vramVal: $('vramVal'),
  banner: $('banner'),
  stats: {
    fps: $('sFps'), frame: $('sFrame'), sim: $('sSim'), expand: $('sExpand'),
    upload: $('sUpload'), draw: $('sDraw'), calls: $('sCalls'),
    objects: $('sObjects'), vramUse: $('sVram'), mode: $('sMode'),
    longtask: $('sLongtask'), gl: $('sGl'),
  },
};

/* ---------- WebGL 上下文与渲染器 ---------- */
const ctx = createGL(canvas);
const renderers = createRenderers(ctx);
ui.stats.gl.textContent = ctx.isWebGL2
  ? 'WebGL2（原生实例化）'
  : ctx.instancingSupported
    ? 'WebGL1 + ANGLE_instanced_arrays'
    : 'WebGL1（不支持实例化）';

/* ---------- 世界尺寸 / 画布尺寸 ---------- */
let worldW = WORLD_H;
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== (w * dpr | 0) || canvas.height !== (h * dpr | 0)) {
    canvas.width = w * dpr | 0;
    canvas.height = h * dpr | 0;
  }
  worldW = WORLD_H * (w / Math.max(h, 1));
  ctx.gl.viewport(0, 0, canvas.width, canvas.height);
  worker.postMessage({ type: 'world', worldW, worldH: WORLD_H });
}
window.addEventListener('resize', resize);

/* ---------- PerformanceObserver 统计 ---------- */
const perfAgg = new Map();
function record(name, dur) {
  const s = perfAgg.get(name) || { sum: 0, n: 0 };
  s.sum += dur; s.n++;
  perfAgg.set(name, s);
}
let measureObserver = null;
try {
  measureObserver = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) record(e.name, e.duration);
  });
  measureObserver.observe({ entryTypes: ['measure'] });
} catch (_) { /* 环境不支持时走手动统计 */ }

let longTasks = 0;
try {
  new PerformanceObserver((list) => {
    longTasks += list.getEntries().length;
  }).observe({ entryTypes: ['longtask'] });
} catch (_) { /* longtask 非标准，忽略 */ }

function timed(name, fn) {
  const t0 = performance.now();
  const r = fn();
  const d = performance.now() - t0;
  let ok = false;
  try { performance.measure(name, { start: t0, end: t0 + d }); ok = true; } catch (_) {}
  if (!ok || !measureObserver) record(name, d);
  return r;
}
function samplePerf() {
  const out = {};
  for (const [k, s] of perfAgg) out[k] = s.n ? s.sum / s.n : 0;
  perfAgg.clear();
  return out;
}

/* ---------- Worker：模拟在独立线程 ---------- */
const worker = new Worker('src/worker.js');
let simPending = false;
let simSentAt = 0;
let frameData = null;   // { view: Float32Array, count, buffer }
let spareBuffer = null; // 归还给 worker 复用的 ArrayBuffer
let objectCount = 0;

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type !== 'frame') return;
  simPending = false;
  const simDur = performance.now() - simSentAt;
  try { performance.measure('sim', { start: simSentAt, end: simSentAt + simDur }); }
  catch (_) { record('sim', simDur); }
  if (frameData) spareBuffer = frameData.buffer; // 旧帧 buffer 回收
  frameData = { view: new Float32Array(m.buffer, 0, m.count * INSTANCE_FLOATS), count: m.count, buffer: m.buffer };
  objectCount = m.count;
  needsUpload = true;
};

function requestTick(dt) {
  if (simPending) return;
  simPending = true;
  simSentAt = performance.now();
  const msg = { type: 'tick', dt };
  if (spareBuffer) { msg.buffer = spareBuffer; spareBuffer = null; }
  worker.postMessage(msg, msg.buffer ? [msg.buffer] : []);
}

/* ---------- 模式选择与显存降级 ---------- */
let requestedMode = 'instanced';
let effectiveMode = 'instanced';
let fallbackReason = '';

function vramBudgetBytes() {
  return Number(ui.vram.value) * 1024 * 1024;
}

function resolveMode() {
  effectiveMode = requestedMode;
  fallbackReason = '';
  if (requestedMode === 'instanced') {
    if (!ctx.instancingSupported) {
      effectiveMode = 'batched';
      fallbackReason = '当前环境不支持实例化（无 WebGL2 / ANGLE 扩展），已降级到批处理。';
    } else {
      const need = renderers.instanced.requiredBytes(Math.max(objectCount, 1));
      const budget = vramBudgetBytes();
      if (need > budget) {
        effectiveMode = 'batched';
        fallbackReason = `显存不足：实例化需 ${(need / 1048576).toFixed(1)} MB，超出预算 ${(budget / 1048576).toFixed(0)} MB，已自动降级到批处理。`;
      }
    }
  }
  ui.banner.textContent = fallbackReason;
  ui.banner.hidden = !fallbackReason;
  ui.stats.mode.textContent =
    ({ naive: '逐物体绘制', batched: '批处理', instanced: '实例化' })[effectiveMode] +
    (fallbackReason ? '（降级）' : '');
}

/* ---------- 主循环 ---------- */
let needsUpload = false;
let lastT = performance.now();
let frames = 0;

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;
  const frameStart = performance.now();

  requestTick(dt);
  resolveMode();

  const renderer = renderers[effectiveMode];
  const view = { x: 2 / worldW, y: 2 / WORLD_H };

  if (frameData && needsUpload && effectiveMode !== 'naive') {
    timed('upload', () => renderer.update(frameData.view, frameData.count));
    needsUpload = false;
  }
  if (frameData) {
    timed('draw', () => renderer.draw(frameData.view, frameData.count, view));
  }
  frames++;

  const frameDur = performance.now() - frameStart;
  try { performance.measure('frame', { start: frameStart, end: frameStart + frameDur }); }
  catch (_) { record('frame', frameDur); }
}

/* ---------- 统计面板（500ms 刷新） ---------- */
const fmt = (v) => (v === undefined ? '—' : v.toFixed(2));
setInterval(() => {
  const avg = samplePerf();
  const renderer = renderers[effectiveMode];
  ui.stats.fps.textContent = String(frames * 2);
  ui.stats.frame.textContent = fmt(avg.frame);
  ui.stats.sim.textContent = fmt(avg.sim);
  ui.stats.expand.textContent =
    effectiveMode === 'batched' ? fmt(renderers.batched.expandMs) : '—';
  ui.stats.upload.textContent = fmt(avg.upload);
  ui.stats.draw.textContent = fmt(avg.draw);
  ui.stats.calls.textContent = String(renderer.drawCalls);
  ui.stats.objects.textContent = objectCount.toLocaleString();
  ui.stats.vramUse.textContent = (renderer.gpuBytes() / 1048576).toFixed(2) + ' MB';
  ui.stats.longtask.textContent = String(longTasks);
  frames = 0;
}, 500);

/* ---------- 交互 ---------- */
for (const radio of ui.modes) {
  radio.addEventListener('change', () => {
    requestedMode = radio.value;
    needsUpload = true; // 切模式后强制重传
  });
}
ui.vram.addEventListener('input', () => {
  ui.vramVal.textContent = ui.vram.value + ' MB';
});
ui.add1k.addEventListener('click', () => worker.postMessage({ type: 'add', n: 1000 }));
ui.add10k.addEventListener('click', () => worker.postMessage({ type: 'add', n: 10000 }));
ui.rm1k.addEventListener('click', () => worker.postMessage({ type: 'remove', n: 1000 }));
ui.rm10k.addEventListener('click', () => worker.postMessage({ type: 'remove', n: 10000 }));
ui.setCount.addEventListener('click', () => {
  const target = Math.max(0, Number(ui.countInput.value) | 0);
  const delta = target - objectCount;
  worker.postMessage(delta >= 0 ? { type: 'add', n: delta } : { type: 'remove', n: -delta });
});

// 自动增删：每 400ms 增 500 / 删 500，验证动态增删路径
setInterval(() => {
  if (!ui.churn.checked) return;
  worker.postMessage({ type: 'add', n: 500 });
  worker.postMessage({ type: 'remove', n: 500 });
}, 400);

// 点击画布：在点击处生成 100 个物体
canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * worldW;
  const y = (1 - (e.clientY - rect.top) / rect.height) * WORLD_H;
  worker.postMessage({ type: 'add', n: 100, x, y });
});

/* ---------- 启动 ---------- */
resize();
worker.postMessage({ type: 'init', count: INITIAL_COUNT, worldW, worldH: WORLD_H });
ui.countInput.value = INITIAL_COUNT;
requestAnimationFrame(loop);
