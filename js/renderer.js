'use strict';
/*
 * 渲染器：三种方案共用同一套实例数据（每实例 7 个 float32）。
 *
 * 实例属性布局（交错存储，stride = 28 字节）：
 *   offset 0  : vec2  aOffset   (实例位置, 除数=1)
 *   offset 8  : float aScale    (实例缩放, 除数=1)
 *   offset 12 : float aRotation (实例旋转, 除数=1)
 *   offset 16 : vec3  aColor    (实例颜色, 除数=1)
 * 顶点属性（除数=0）：
 *   location 0: vec2 aCorner    (单位四边形角点, 6 顶点)
 */
const FLOATS_PER_INSTANCE = 7;
const INSTANCE_STRIDE = FLOATS_PER_INSTANCE * 4;

const QUAD_CORNERS = new Float32Array([
  -0.5, -0.5,  0.5, -0.5,  0.5, 0.5,
  -0.5, -0.5,  0.5,  0.5, -0.5, 0.5,
]);

const VS_INSTANCED = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec2 aOffset;
layout(location=2) in float aScale;
layout(location=3) in float aRotation;
layout(location=4) in vec3 aColor;
uniform vec2 uView;
out vec3 vColor;
out vec2 vLocal;
void main() {
  float c = cos(aRotation), s = sin(aRotation);
  vec2 p = vec2(aCorner.x * c - aCorner.y * s, aCorner.x * s + aCorner.y * c);
  vec2 world = p * aScale + aOffset;
  gl_Position = vec4(world * uView, 0.0, 1.0);
  vColor = aColor;
  vLocal = aCorner;
}`;

const VS_UNIFORM = `#version 300 es
layout(location=0) in vec2 aCorner;
uniform vec2 uOffset;
uniform float uScale;
uniform float uRotation;
uniform vec3 uColor;
uniform vec2 uView;
out vec3 vColor;
out vec2 vLocal;
void main() {
  float c = cos(uRotation), s = sin(uRotation);
  vec2 p = vec2(aCorner.x * c - aCorner.y * s, aCorner.x * s + aCorner.y * c);
  vec2 world = p * uScale + uOffset;
  gl_Position = vec4(world * uView, 0.0, 1.0);
  vColor = uColor;
  vLocal = aCorner;
}`;

const FS = `#version 300 es
precision mediump float;
in vec3 vColor;
in vec2 vLocal;
out vec4 outColor;
void main() {
  float shade = 1.0 - 0.5 * length(vLocal);
  outColor = vec4(vColor * shade, 1.0);
}`;

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!this.gl) throw new Error('WebGL2 不可用');
    this.drawCalls = 0;
    this.gpuBytes = 0;
    this.instanceCapacity = 0;
    this.batchCapacity = 0;
    this.vramBudgetBytes = Infinity;
    this.oom = false;
    this._initGL();
  }

  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('Shader 编译失败: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  _link(vsSrc) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this._compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, this._compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Program 链接失败: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  _initGL() {
    const gl = this.gl;
    this.progInstanced = this._link(VS_INSTANCED);
    this.progUniform = this._link(VS_UNIFORM);
    this.uViewInstanced = gl.getUniformLocation(this.progInstanced, 'uView');
    const pu = this.progUniform;
    this.uUniforms = {
      view: gl.getUniformLocation(pu, 'uView'),
      offset: gl.getUniformLocation(pu, 'uOffset'),
      scale: gl.getUniformLocation(pu, 'uScale'),
      rotation: gl.getUniformLocation(pu, 'uRotation'),
      color: gl.getUniformLocation(pu, 'uColor'),
    };

    this.cornerVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerVBO);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_CORNERS, gl.STATIC_DRAW);

    this.instanceVBO = gl.createBuffer();
    this.batchVBO = gl.createBuffer();

    // 实例化 VAO：顶点角点 + 交错实例属性（divisor=1）
    this.vaoInstanced = gl.createVertexArray();
    gl.bindVertexArray(this.vaoInstanced);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVBO);
    const attrs = [[1, 2, 0], [2, 1, 8], [3, 1, 12], [4, 3, 16]];
    for (const [loc, size, off] of attrs) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, INSTANCE_STRIDE, off);
      gl.vertexAttribDivisor(loc, 1);
    }

    // 批处理 VAO：CPU 展开后的纯顶点流（全部 divisor=0，每顶点 9 float）
    this.vaoBatched = gl.createVertexArray();
    gl.bindVertexArray(this.vaoBatched);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.batchVBO);
    const bStride = 9 * 4;
    const bAttrs = [[0, 2, 0], [1, 2, 8], [2, 1, 16], [3, 1, 20], [4, 3, 24]];
    for (const [loc, size, off] of bAttrs) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, bStride, off);
    }

    // 朴素模式 VAO：仅角点
    this.vaoNaive = gl.createVertexArray();
    gl.bindVertexArray(this.vaoNaive);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    this.gpuBytes = QUAD_CORNERS.byteLength;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  get viewVec() {
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    return [1 / 1.7, (1 / 1.7) * aspect];
  }

  /* 确保实例缓冲容量；返回 false 表示显存不足（调用方应降级） */
  ensureInstanceBuffer(count) {
    const gl = this.gl;
    const bytes = count * INSTANCE_STRIDE;
    if (bytes > this.vramBudgetBytes) return false;
    if (count <= this.instanceCapacity && !this.oom) return true;
    const newCap = Math.max(count, this.instanceCapacity * 2, 1024);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVBO);
    gl.bufferData(gl.ARRAY_BUFFER, newCap * INSTANCE_STRIDE, gl.DYNAMIC_DRAW);
    if (gl.getError() === gl.OUT_OF_MEMORY) {
      this.oom = true;
      return false;
    }
    this.gpuBytes += newCap * INSTANCE_STRIDE - this.instanceCapacity * INSTANCE_STRIDE;
    this.instanceCapacity = newCap;
    return true;
  }

  uploadInstances(data, count) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * FLOATS_PER_INSTANCE);
  }

  /* 方案一：逐物体绘制，每物体 1 次 draw call */
  drawNaive(data, count, maxDraws) {
    const gl = this.gl;
    const u = this.uUniforms;
    const view = this.viewVec;
    gl.useProgram(this.progUniform);
    gl.bindVertexArray(this.vaoNaive);
    gl.uniform2f(u.view, view[0], view[1]);
    const n = Math.min(count, maxDraws);
    for (let i = 0; i < n; i++) {
      const o = i * FLOATS_PER_INSTANCE;
      gl.uniform2f(u.offset, data[o], data[o + 1]);
      gl.uniform1f(u.scale, data[o + 2]);
      gl.uniform1f(u.rotation, data[o + 3]);
      gl.uniform3f(u.color, data[o + 4], data[o + 5], data[o + 6]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.drawCalls++;
    }
    return n;
  }

  /* 方案二：批处理，CPU 展开顶点后 1 次 draw call */
  drawBatched(data, count) {
    const gl = this.gl;
    const verts = count * 6;
    const need = verts * 9;
    if (!this.batchCPU || this.batchCPU.length < need) {
      this.batchCPU = new Float32Array(Math.max(need, 9 * 6 * 1024));
    }
    const cpu = this.batchCPU;
    for (let i = 0; i < count; i++) {
      const io = i * FLOATS_PER_INSTANCE;
      const ox = data[io], oy = data[io + 1], sc = data[io + 2];
      const rt = data[io + 3];
      const r = data[io + 4], g = data[io + 5], b = data[io + 6];
      const vo = i * 54;
      for (let v = 0; v < 6; v++) {
        const b9 = vo + v * 9;
        cpu[b9] = QUAD_CORNERS[v * 2];
        cpu[b9 + 1] = QUAD_CORNERS[v * 2 + 1];
        cpu[b9 + 2] = ox; cpu[b9 + 3] = oy;
        cpu[b9 + 4] = sc; cpu[b9 + 5] = rt;
        cpu[b9 + 6] = r; cpu[b9 + 7] = g; cpu[b9 + 8] = b;
      }
    }
    const bytes = need * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.batchVBO);
    if (bytes > this.batchCapacity) {
      gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.STREAM_DRAW);
      this.gpuBytes += bytes - this.batchCapacity;
      this.batchCapacity = bytes;
    } else {
      gl.bufferData(gl.ARRAY_BUFFER, this.batchCapacity, gl.STREAM_DRAW); // orphaning
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, cpu, 0, need);
    const view = this.viewVec;
    gl.useProgram(this.progInstanced);
    gl.uniform2f(this.uViewInstanced, view[0], view[1]);
    gl.bindVertexArray(this.vaoBatched);
    gl.drawArrays(gl.TRIANGLES, 0, verts);
    this.drawCalls++;
  }

  /* 方案三：实例化，1 次 draw call */
  drawInstanced(count) {
    const gl = this.gl;
    const view = this.viewVec;
    gl.useProgram(this.progInstanced);
    gl.uniform2f(this.uViewInstanced, view[0], view[1]);
    gl.bindVertexArray(this.vaoInstanced);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    this.drawCalls++;
  }

  clear() {
    const gl = this.gl;
    gl.clearColor(0.06, 0.07, 0.1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteBuffer(this.cornerVBO);
    gl.deleteBuffer(this.instanceVBO);
    gl.deleteBuffer(this.batchVBO);
    gl.deleteVertexArray(this.vaoInstanced);
    gl.deleteVertexArray(this.vaoBatched);
    gl.deleteVertexArray(this.vaoNaive);
    gl.deleteProgram(this.progInstanced);
    gl.deleteProgram(this.progUniform);
  }
}
