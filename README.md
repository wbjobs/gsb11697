# 实例化渲染性能对比实验（10 万物体）

纯静态页面，无需构建。三种渲染方案同屏对比：逐物体绘制 / CPU 批处理 / GPU 实例化。

## 运行

```bash
cd A
python3 -m http.server 8000
# 打开 http://localhost:8000
```

Worker 通过 Blob 内联创建，直接双击 `index.html`（file://）也能运行；推荐 http 方式。

## 技术栈

- **WebGL2**：`gl.drawArraysInstanced` + 实例属性除数（`vertexAttribDivisor`）
- **Web Worker**：物体运动/旋转模拟在 Worker 线程，TypedArray（transferable）零拷贝回传
- **PerformanceObserver**：`measure` 统计 JS 提交耗时，`longtask` 统计主线程卡顿
- **TypedArray**：实例数据交错存储（SoA 模拟 → AoS 交错缓冲），`bufferSubData` 部分更新
- **Canvas**：WebGL 画布 + 2D FPS 走势图

## 实例属性布局（交错，stride = 28 字节）

| 偏移 | 属性 | 类型 | 除数 | 说明 |
|------|------|------|------|------|
| 0  | `aOffset`   | vec2  | 1 | 实例位置 |
| 8  | `aScale`    | float | 1 | 实例缩放 |
| 12 | `aRotation` | float | 1 | 实例旋转 |
| 16 | `aColor`    | vec3  | 1 | 实例颜色 |
| -  | `aCorner`   | vec2  | 0 | 四边形角点（每顶点） |

批处理 VAO 复用同一 shader，CPU 将每实例展开为 6 顶点 × 9 float（全除数 0）。

## 三种方案对比

| 方案 | Draw Call | CPU 开销 | 显存占用 |
|------|-----------|----------|----------|
| 逐物体 | N 次（默认上限 2 万防卡死） | 每物体 4 次 uniform | 极小 |
| 批处理 | 1 次 | 每帧展开 N×6 顶点并上传 | 大（10 万 ≈ 21.6 MB/帧） |
| 实例化 | 1 次 | 仅上传 28B×N 实例数据 | 小（10 万 ≈ 2.8 MB） |

切换方案后，对照表自动记录该方案的 FPS / 帧耗时 / 提交耗时 / draw call 数。

## 动态增删

- 滑杆 / ±5000 按钮 / 重置按钮实时调整数量（0 ~ 20 万）
- Worker 内对象池按需倍增扩容，新增实例随机初始化位置、速度、颜色
- 实例缓冲容量不足时按 2 倍重建，否则 `bufferSubData` 增量更新

## 显存不足与降级

- 面板滑杆模拟显存预算（1–512 MB）
- 实例缓冲需求超预算，或 `bufferData` 返回 `gl.OUT_OF_MEMORY` → 自动降级：**实例化 → 批处理 → 逐物体**，顶部红色横幅提示原因
- 监听 `webglcontextlost / restored`，上下文丢失后自动重建全部 GL 资源

## 验收对照

- ✅ 实例化渲染正确：10 万旋转彩色方块，1 次 draw call
- ✅ 三方案性能可量化：实时指标 + 对照表 + FPS 曲线
- ✅ 动态增删正确：增删后实例数、渲染、统计同步更新
- ✅ 属性布局正确：上文布局表与 `js/renderer.js` 中 VAO 代码一一对应
- ✅ 显存不足有降级：预算模拟 + OUT_OF_MEMORY 检测 + 上下文丢失恢复
