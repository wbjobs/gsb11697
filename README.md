# 实例化渲染性能对比 Demo

WebGL + Web Worker + PerformanceObserver + TypedArray + Canvas，
对 10 万个动态物体对比三种渲染方案：**逐物体绘制 / 批处理合并 / 实例化**。

## 运行

```bash
cd B
python3 -m http.server 8000
# 打开 http://localhost:8000
```

> 必须通过 HTTP 访问（Web Worker 不支持 file:// 协议）。

## 架构

```
index.html          UI：方案切换 / 动态增删 / 显存预算 / 指标面板
style.css
src/main.js         主线程：渲染循环、Worker 通信、PerformanceObserver 统计、显存降级
src/renderer.js     三种渲染器（WebGL2 优先，WebGL1 + ANGLE_instanced_arrays 兜底）
src/worker.js       模拟线程：SoA TypedArray 状态、物理推进、实例数据打包（Transferable）
```

- **模拟与渲染分离**：物体状态（位置/速度/旋转/缩放/颜色）以 SoA 形式存于 Worker 的
  `Float32Array`；每帧打包成交错实例缓冲，以 Transferable 零拷贝移交主线程，
  主线程归还上一帧的 ArrayBuffer 形成缓冲池，避免 GC 压力。
- **性能采集**：`PerformanceObserver` 订阅 `measure`（帧/模拟/上传/绘制各阶段）
  与 `longtask`（主线程卡顿），面板每 500ms 刷新均值。

## 三种方案对比（量化指标见页面面板）

| 方案 | Draw Calls | 每帧 CPU 工作 | 每帧上传 |
|---|---|---|---|
| 逐物体绘制 | N（10 万） | N×4 次 uniform 设置 | 0 |
| 批处理 | 1 | CPU 展开 60 万顶点（含三角函数） | ~12 MB 顶点数据 |
| 实例化 | 1 | 仅打包 7 float/实例（Worker 内） | 2.8 MB 实例数据 |

面板实时显示 FPS、帧耗时、模拟耗时、CPU 展开耗时、上传耗时、绘制提交耗时、
Draw Calls、物体数量、显存占用估算、长任务数，可直接量化对照。

## 实例属性布局（实例缓冲区）

交错存储，stride = 28 字节，`divisor = 1`（每实例步进）：

| 属性 | 类型 | 字节偏移 |
|---|---|---|
| aOffset | vec2 | 0 |
| aRot | float | 8 |
| aScale | float | 12 |
| aColor | vec3 | 16 |

Worker 打包布局与 VAO 属性指针严格一致（`src/worker.js` 与 `src/renderer.js`
中的 `INSTANCE_FLOATS = 7`）。GPU 缓冲按倍增策略扩容（最少 65536 实例），
增删物体只触发 `bufferSubData` 局部更新，不重建缓冲。

## 动态增删

- 按钮 ±1,000 / ±10,000、任意数量设置、点击画布定点生成 100 个；
- “自动增删”每 400ms 增 500 删 500，持续压力测试；
- Worker 内 swap-remove O(1) 删除、容量倍增扩容，数量变化即时反映到渲染。

## 显存不足与降级

- 面板“显存预算”滑块（1–64 MB）：实例化所需显存（含扩容策略）超过预算时，
  自动降级到批处理并显示黄色横幅提示原因；
- 环境不支持实例化（无 WebGL2 且无 `ANGLE_instanced_arrays`）时同样降级到批处理；
- 面板实时显示当前方案的显存占用估算。

## 验收标准对照

| 标准 | 实现 |
|---|---|
| 实例化渲染正确 | `src/renderer.js` 实例化渲染器：静态四边形 + 实例属性，1 次 instanced draw |
| 三种方案性能对照可量化 | 面板 FPS/帧耗时/各阶段耗时/Draw Calls 实时对比 |
| 动态增删正确 | Worker swap-remove + 倍增扩容；按钮/点击/自动增删三条路径 |
| 属性布局正确 | 28B stride 交错布局，Worker 打包与 VAO 指针一致 |
| 显存不足有降级 | 预算滑块触发 + 环境不支持触发，均降级批处理并提示 |
