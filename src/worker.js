'use strict';
/*
 * 模拟 Worker：持有全部物体状态（SoA 布局的 TypedArray），
 * 每帧推进物理（漂移 + 边界反弹 + 自转），把实例数据打包成
 * 交错(interleaved) Float32Array，通过 Transferable 零拷贝回主线程。
 *
 * 实例属性布局（与主线程 VAO 严格一致，stride = 28 字节）：
 *   offset : 2 floats  (byte 0)
 *   rot    : 1 float   (byte 8)
 *   scale  : 1 float   (byte 12)
 *   color  : 3 floats  (byte 16)
 */
const INSTANCE_FLOATS = 7;
const INSTANCE_STRIDE = INSTANCE_FLOATS * 4; // 28 bytes

let capacity = 0;
let count = 0;
// SoA 状态数组
let posX, posY, velX, velY, rot, rotVel, scl, colR, colG, colB;

let worldW = 100;
let worldH = 100;

// 主线程回传的 ArrayBuffer 池，避免每帧分配新显存/内存
const bufferPool = [];

function ensureCapacity(min) {
  if (min <= capacity) return;
  let cap = Math.max(1024, capacity);
  while (cap < min) cap *= 2;
  const grow = (old) => {
    const next = new Float32Array(cap);
    if (old) next.set(old);
    return next;
  };
  posX = grow(posX); posY = grow(posY);
  velX = grow(velX); velY = grow(velY);
  rot = grow(rot); rotVel = grow(rotVel);
  scl = grow(scl);
  colR = grow(colR); colG = grow(colG); colB = grow(colB);
  capacity = cap;
}

function spawnOne(i, atX, atY) {
  const hasAt = atX !== undefined;
  posX[i] = hasAt ? atX + (Math.random() - 0.5) * 4 : Math.random() * worldW;
  posY[i] = hasAt ? atY + (Math.random() - 0.5) * 4 : Math.random() * worldH;
  const ang = Math.random() * Math.PI * 2;
  const spd = 4 + Math.random() * 18;
  velX[i] = Math.cos(ang) * spd;
  velY[i] = Math.sin(ang) * spd;
  rot[i] = Math.random() * Math.PI * 2;
  rotVel[i] = (Math.random() - 0.5) * 6;
  scl[i] = 0.25 + Math.random() * 0.95;
  // 高饱和随机色
  const hue = Math.random();
  colR[i] = 0.35 + 0.65 * Math.abs(Math.sin(hue * Math.PI * 2));
  colG[i] = 0.35 + 0.65 * Math.abs(Math.sin(hue * Math.PI * 2 + 2.1));
  colB[i] = 0.35 + 0.65 * Math.abs(Math.sin(hue * Math.PI * 2 + 4.2));
}

function add(n, atX, atY) {
  ensureCapacity(count + n);
  for (let k = 0; k < n; k++) spawnOne(count++, atX, atY);
}

function removeRandom(n) {
  n = Math.min(n, count);
  for (let k = 0; k < n; k++) {
    const victim = (Math.random() * count) | 0;
    const last = count - 1;
    // swap-remove：与最后一个元素交换后缩小 count，O(1) 删除
    if (victim !== last) {
      posX[victim] = posX[last]; posY[victim] = posY[last];
      velX[victim] = velX[last]; velY[victim] = velY[last];
      rot[victim] = rot[last]; rotVel[victim] = rotVel[last];
      scl[victim] = scl[last];
      colR[victim] = colR[last]; colG[victim] = colG[last]; colB[victim] = colB[last];
    }
    count--;
  }
}

function step(dt) {
  for (let i = 0; i < count; i++) {
    let x = posX[i] + velX[i] * dt;
    let y = posY[i] + velY[i] * dt;
    const r = scl[i] * 0.5;
    if (x < r) { x = r; velX[i] = -velX[i]; }
    else if (x > worldW - r) { x = worldW - r; velX[i] = -velX[i]; }
    if (y < r) { y = r; velY[i] = -velY[i]; }
    else if (y > worldH - r) { y = worldH - r; velY[i] = -velY[i]; }
    posX[i] = x; posY[i] = y;
    rot[i] += rotVel[i] * dt;
  }
}

function pack() {
  const floats = count * INSTANCE_FLOATS;
  let buf = bufferPool.pop();
  if (!buf || buf.byteLength < floats * 4) {
    buf = new ArrayBuffer(Math.max(floats, 1024) * 4);
  }
  const out = new Float32Array(buf, 0, floats);
  for (let i = 0, o = 0; i < count; i++, o += INSTANCE_FLOATS) {
    out[o] = posX[i];
    out[o + 1] = posY[i];
    out[o + 2] = rot[i];
    out[o + 3] = scl[i];
    out[o + 4] = colR[i];
    out[o + 5] = colG[i];
    out[o + 6] = colB[i];
  }
  return buf;
}

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      worldW = m.worldW; worldH = m.worldH;
      count = 0;
      ensureCapacity(m.capacity || m.count);
      add(m.count);
      break;
    case 'world':
      worldW = m.worldW; worldH = m.worldH;
      break;
    case 'add':
      add(m.n, m.x, m.y);
      break;
    case 'remove':
      removeRandom(m.n);
      break;
    case 'tick': {
      if (m.buffer) bufferPool.push(m.buffer); // 回收上一帧的 buffer
      step(Math.min(m.dt, 0.05));
      const buf = pack();
      self.postMessage(
        { type: 'frame', count, capacity, buffer: buf },
        [buf] // Transferable：零拷贝移交所有权
      );
      break;
    }
  }
};
