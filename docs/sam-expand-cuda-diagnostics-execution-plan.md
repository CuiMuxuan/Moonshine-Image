# SAM 扩边手动控制与 CUDA 诊断阶段性执行方案

## Summary

本阶段同时处理两个能力：

- SAM 图片/视频候选蒙版在 LaMa 模型下允许手动调整扩边大小。
- 后端启动后细化 CUDA 诊断，区分 PyTorch CUDA、NVIDIA 驱动、GPU 和 CUDA Toolkit/nvcc 状态，并在需要时前端只通知一次。

## 已确认边界

- 图片处理页 SAM 浮动面板中的每个候选蒙版单独保存 `autoExpandPx` 和 `expandPx`。
- 视频处理页 SAM 候选对象按 `objectId` 单独保存 `autoExpandPx` 和 `expandPx`。
- 默认值在候选生成或传播结果写回时固化，之后不随规则变化自动重算。
- 扩边值只保存在当前会话状态中，不写入长期配置。
- `expandPx = 0` 表示关闭该候选/objectId 的扩边。
- 扩边输入仅在当前处理模型为 `lama` 时显示；切到其它模型隐藏但保留值。
- 图片预览、图片 LaMa 实际处理、视频预览、视频最终 LaMa 合成都使用同一份 `expandPx`。
- 后端启动后检查 CUDA 诊断；每次后端启动最多通知一次。
- CPU 版运行包不弹通知，但诊断 UI 显示 CPU 包状态。
- 无 NVIDIA GPU 时提示“未检测到可用 GPU”。
- PyTorch CUDA 可用是 CUDA 推理可用的主判断；`nvcc` 缺失只作为 CUDA Toolkit 未安装的附加诊断。

## 阶段 1：SAM 扩边数据与工具函数

- `resolveSamAutoExpandRadius()` 保持导出，用当前“按 SAM 蒙版包围盒长边映射”规则计算默认半径。
- `expandSamMaskImageDataForLama(imageData, options)` 增加 `radiusOverride`：
  - `undefined/null`：自动计算半径。
  - `0`：不扩边。
  - `1-99`：使用指定半径。
- 图片候选新增 `autoExpandPx`、`expandPx`，克隆/会话缓存时保留字段。
- 视频 `samObjects` 新增 `autoExpandPx`、`expandPx`，轨道克隆、归一化、传播写回时保留字段。

## 阶段 2：图片与视频 UI

- 图片 SAM 浮动面板候选列表在删除按钮左侧增加紧凑扩边输入。
- 视频右侧候选对象列表和全屏候选弹窗在删除按钮左侧增加同款扩边输入。
- 输入使用 Quasar `QInput type="number"`，prepend/append 使用小号加减 `QBtn`，后缀显示 `px`。
- 输入范围固定 `0-99`，非法值在更新时归一化。
- 非 LaMa 模型下隐藏输入。

## 阶段 3：渲染与处理链路

- 图片 SAM 候选预览和合成到实际蒙版时使用 `candidate.expandPx`。
- 视频预览按 `objectId` 获取 `samObject.expandPx` 后传给扩边函数。
- 视频最终处理合成蒙版时同样按 `objectId` 使用 `samObject.expandPx`。
- 删除对象点不影响传播对象和扩边值；删除对象蒙版继续同步删除对象点。

## 阶段 4：CUDA 诊断与通知

- 扩展 `/api/v1/check_cuda`，保留旧字段并新增：
  - `torch_package`
  - `torch_cuda_version`
  - `torch_cuda_available`
  - `nvidia_driver_available`
  - `nvidia_driver_version`
  - `nvidia_smi_available`
  - `nvcc_available`
  - `nvcc_version`
  - `diagnostic_code`
  - `notification_level`
  - `notification_title`
  - `notification_message`
  - `notification_links`
- 后端优先使用 PyTorch 判断 CUDA 推理可用性；再用 `nvidia-smi` 细化 GPU/驱动；必要时检查 `nvcc`。
- 前端后端启动成功后读取 `/check_cuda`，根据诊断字段用 Quasar Notify 弹一次。
- 通知按钮通过 Electron 外部链接能力打开 PyTorch 安装说明和 NVIDIA 驱动页面。

## 验收命令

- `npm run lint`
- `npm run test:regression:p0:assertions`
- `npm run test:regression:p1:image`
- `npm run test:regression:p1:video`
- `python -m compileall server`
- `git diff --check`
