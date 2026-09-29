'use strict';
/*
 * 三种渲染方案：
 *  - naive     逐物体绘制：每个物体 4 次 uniform 上传 + 1 次 draw call
 *  - batched   批处理：CPU 展开全部顶点到大缓冲，1 次 draw call
 *  - instanced 实例化：静态四边形 + 实例属性缓冲，1 次 instanced draw call
 *
 * 实例属性布局（interleaved，stride = 28 字节）：
 *   location 1  aOffset : vec2  offset 0
 *   location 2  aRot    : float offset 8
 *   location 3  aScale  : float offset 12
 *   location 4  aColor  : vec3  offset 16
 */

export const INSTANCE_FLOATS = 7;
export const INSTANCE_STRIDE = INSTANCE_FLOATS * 4;

// 非索引化四边形（两个三角形，6 个角点）
const CORNERS = new Float32Array([
  -0.5, -0.5, 0.5, -0.5, 0.5, 0.5,
  -0.5, -0.5, 0.5, 0.5, -0.5, 0.5,
]);
const QUAD_FLOATS = CORNERS.length;

// 固定 attribute 位置，三种着色器共享同一套索引
const LOC = { corner: 0, offset: 1, rot: 2, scale: 3, color: 4 };
const MAX_ATTRIBS = 5;

const VS_INSTANCED = `
attribute vec2 aCorner;
attribute vec2 aOffset;
attribute float aRot;
attribute float aScale;
attribute vec3 aColor;
uniform vec2 uView;
varying vec3 vColor;
void main() {
  float c = cos(aRot);
  float s = sin(aRot);
  vec2 p = aCorner * aScale;
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  gl_Position = vec4((p + aOffset) * uView - 1.0, 0.0, 1.0);
  vColor = aColor;
}`;

const VS_NAIVE = `
attribute vec2 aCorner;
uniform vec2 uOffset;
uniform float uRot;
uniform float uScale;
uniform vec2 uView;
void main() {
  float c = cos(uRot);
  float s = sin(uRot);
  vec2 p = aCorner * uScale;
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  gl_Position = vec4((p + uOffset) * uView - 1.0, 0.0, 1.0);
}`;

const VS_BATCHED = `
attribute vec2 aPos;
attribute vec3 aColor;
uniform vec2 uView;
varying vec3 vColor;
void main() {
  gl_Position = vec4(aPos * uView - 1.0, 0.0, 1.0);
  vColor = aColor;
}`;

const FS_INSTANCED = `
precision mediump float;
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

const FS_NAIVE = `
precision mediump float;
uniform vec3 uColor;
void main() { gl_FragColor = vec4(uColor, 1.0); }`;

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function linkProgram(gl, vsSrc, fsSrc, attribs) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
  for (const [name, loc] of Object.entries(attribs)) {
    gl.bindAttribLocation(prog, loc, name);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(prog));
  }
  return prog;
}

export function createGL(canvas) {
  const opts = { antialias: false, alpha: false, powerPreference: 'high-performance' };
  let gl = canvas.getContext('webgl2', opts);
  const isWebGL2 = !!gl;
  let instExt = null;
  if (!gl) {
    gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (gl) instExt = gl.getExtension('ANGLE_instanced_arrays');
  }
  if (!gl) throw new Error('WebGL 不可用');
  return { gl, isWebGL2, instExt, instancingSupported: isWebGL2 || !!instExt };
}

function makeInstancing(gl, isWebGL2, ext) {
  return {
    divisor(index, d) {
      if (isWebGL2) gl.vertexAttribDivisor(index, d);
      else ext.vertexAttribDivisorANGLE(index, d);
    },
    drawInstanced(mode, first, count, instances) {
      if (isWebGL2) gl.drawArraysInstanced(mode, first, count, instances);
      else ext.drawArraysInstancedANGLE(mode, first, count, instances);
    },
  };
}

export function createRenderers(ctx) {
  const { gl, isWebGL2, instExt } = ctx;
  const inst = makeInstancing(gl, isWebGL2, instExt);

  // 静态四边形角点缓冲（三种方案共用）
  const cornerBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
  gl.bufferData(gl.ARRAY_BUFFER, CORNERS, gl.STATIC_DRAW);
  const quadBytes = QUAD_FLOATS * 4;

  // 切换方案前重置 attribute 状态机，避免 divisor / 启用位互相污染
  function resetAttribs() {
    for (let i = 0; i < MAX_ATTRIBS; i++) {
      gl.disableVertexAttribArray(i);
      if (ctx.instancingSupported) inst.divisor(i, 0);
    }
  }

  /* ---------------- 方案一：逐物体绘制 ---------------- */
  const naiveProg = linkProgram(gl, VS_NAIVE, FS_NAIVE, { aCorner: LOC.corner });
  const naiveU = {
    view: gl.getUniformLocation(naiveProg, 'uView'),
    offset: gl.getUniformLocation(naiveProg, 'uOffset'),
    rot: gl.getUniformLocation(naiveProg, 'uRot'),
    scale: gl.getUniformLocation(naiveProg, 'uScale'),
    color: gl.getUniformLocation(naiveProg, 'uColor'),
  };
  const naive = {
    name: 'naive',
    drawCalls: 0,
    gpuBytes: () => quadBytes,
    update() {},
    draw(data, count, view) {
      resetAttribs();
      gl.useProgram(naiveProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
      gl.enableVertexAttribArray(LOC.corner);
      gl.vertexAttribPointer(LOC.corner, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(naiveU.view, view.x, view.y);
      let calls = 0;
      for (let i = 0, o = 0; i < count; i++, o += INSTANCE_FLOATS) {
        gl.uniform2f(naiveU.offset, data[o], data[o + 1]);
        gl.uniform1f(naiveU.rot, data[o + 2]);
        gl.uniform1f(naiveU.scale, data[o + 3]);
        gl.uniform3f(naiveU.color, data[o + 4], data[o + 5], data[o + 6]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        calls++;
      }
      this.drawCalls = calls;
    },
  };

  /* ---------------- 方案二：批处理 ---------------- */
  const batchedProg = linkProgram(gl, VS_BATCHED, FS_INSTANCED, {
    aPos: LOC.corner, aColor: LOC.color,
  });
  const batchedU = { view: gl.getUniformLocation(batchedProg, 'uView') };
  const batchBuf = gl.createBuffer();
  let batchGpuCap = 0;   // GPU 侧容量（顶点数）
  let batchCpu = null;   // CPU 侧展开数组
  const VERT_FLOATS = 5; // x, y, r, g, b
  const batched = {
    name: 'batched',
    drawCalls: 0,
    expandMs: 0,
    gpuBytes: () => quadBytes + batchGpuCap * VERT_FLOATS * 4,
    update(data, count) {
      const t0 = performance.now();
      const vertsNeeded = count * 6;
      if (!batchCpu || batchCpu.length < vertsNeeded * VERT_FLOATS) {
        batchCpu = new Float32Array(vertsNeeded * VERT_FLOATS * 2);
      }
      const out = batchCpu;
      for (let i = 0, o = 0, v = 0; i < count; i++, o += INSTANCE_FLOATS) {
        const x = data[o], y = data[o + 1];
        const rot = data[o + 2], s = data[o + 3];
        const r = data[o + 4], g = data[o + 5], b = data[o + 6];
        const cs = Math.cos(rot) * s, sn = Math.sin(rot) * s;
        // 6 个角点逐一做旋转缩放平移
        for (let k = 0; k < 6; k++) {
          const cx = CORNERS[k * 2], cy = CORNERS[k * 2 + 1];
          out[v++] = cx * cs - cy * sn + x;
          out[v++] = cx * sn + cy * cs + y;
          out[v++] = r; out[v++] = g; out[v++] = b;
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, batchBuf);
      if (vertsNeeded > batchGpuCap) {
        batchGpuCap = Math.max(vertsNeeded * 2, 65536);
        gl.bufferData(gl.ARRAY_BUFFER, batchGpuCap * VERT_FLOATS * 4, gl.DYNAMIC_DRAW);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, out.subarray(0, vertsNeeded * VERT_FLOATS));
      this.expandMs = performance.now() - t0;
    },
    draw(data, count, view) {
      resetAttribs();
      gl.useProgram(batchedProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, batchBuf);
      gl.enableVertexAttribArray(LOC.corner);
      gl.vertexAttribPointer(LOC.corner, 2, gl.FLOAT, false, VERT_FLOATS * 4, 0);
      gl.enableVertexAttribArray(LOC.color);
      gl.vertexAttribPointer(LOC.color, 3, gl.FLOAT, false, VERT_FLOATS * 4, 8);
      gl.uniform2f(batchedU.view, view.x, view.y);
      if (count > 0) gl.drawArrays(gl.TRIANGLES, 0, count * 6);
      this.drawCalls = count > 0 ? 1 : 0;
    },
  };

  /* ---------------- 方案三：实例化 ---------------- */
  const instProg = linkProgram(gl, VS_INSTANCED, FS_INSTANCED, {
    aCorner: LOC.corner, aOffset: LOC.offset, aRot: LOC.rot,
    aScale: LOC.scale, aColor: LOC.color,
  });
  const instU = { view: gl.getUniformLocation(instProg, 'uView') };
  const instBuf = gl.createBuffer();
  let instGpuCap = 0; // GPU 侧容量（实例数）
  const instanced = {
    name: 'instanced',
    drawCalls: 0,
    gpuBytes: () => quadBytes + instGpuCap * INSTANCE_STRIDE,
    requiredBytes: (count) => quadBytes + Math.max(count * 2, 65536) * INSTANCE_STRIDE,
    update(data, count) {
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      if (count > instGpuCap) {
        // 显存式增长策略：倍增扩容，避免每帧 realloc
        instGpuCap = Math.max(count * 2, 65536);
        gl.bufferData(gl.ARRAY_BUFFER, instGpuCap * INSTANCE_STRIDE, gl.DYNAMIC_DRAW);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    },
    draw(data, count, view) {
      resetAttribs();
      gl.useProgram(instProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
      gl.enableVertexAttribArray(LOC.corner);
      gl.vertexAttribPointer(LOC.corner, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      gl.enableVertexAttribArray(LOC.offset);
      gl.vertexAttribPointer(LOC.offset, 2, gl.FLOAT, false, INSTANCE_STRIDE, 0);
      gl.enableVertexAttribArray(LOC.rot);
      gl.vertexAttribPointer(LOC.rot, 1, gl.FLOAT, false, INSTANCE_STRIDE, 8);
      gl.enableVertexAttribArray(LOC.scale);
      gl.vertexAttribPointer(LOC.scale, 1, gl.FLOAT, false, INSTANCE_STRIDE, 12);
      gl.enableVertexAttribArray(LOC.color);
      gl.vertexAttribPointer(LOC.color, 3, gl.FLOAT, false, INSTANCE_STRIDE, 16);
      inst.divisor(LOC.offset, 1);
      inst.divisor(LOC.rot, 1);
      inst.divisor(LOC.scale, 1);
      inst.divisor(LOC.color, 1);
      gl.uniform2f(instU.view, view.x, view.y);
      if (count > 0) inst.drawInstanced(gl.TRIANGLES, 0, 6, count);
      this.drawCalls = count > 0 ? 1 : 0;
    },
  };

  return { naive, batched, instanced, resetAttribs };
}
