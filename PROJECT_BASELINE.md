# Moonshine-Image 项目软件基线

> 本文件是当前项目事实、实现边界和发布口径的唯一基线。它从 2026-08-30 的根规划记录提炼而来；阶段过程、实验细节和原始证据仍保存在被忽略的 `docs/` 目录中。

## 1. 项目定位与版本

Moonshine-Image 是面向本地图片与视频处理的 Electron 桌面应用，提供文字/图标/半透明水印去除、蒙版编辑、OCR 智能选区、SAM 分割、视频时间轴处理，以及受策略控制的本地 MCP 自动化接口。

- 当前产品版本：`1.3.4`。
- 首发平台：Windows x64。
- 默认输出：输入文件旁的 `Moonshine-Output`，只创建新文件，不覆盖原文件。
- 官网必须把“已实现”“条件可用”“待外部验收”分开，不以内部计划或本机证据宣传未验收能力。

## 2. 发布策略

### 渠道与对象

- 发布域名：`https://download.moonshine.email`。
- R2 前缀：`app/win-x64`。
- 渠道：`test`、`beta`、`stable`，每个渠道维护独立指针。
- 不可变对象包括 NSIS `.exe`、`.blockmap`、版本化 `latest.yml` 和 Ed25519 签名的 app manifest。
- `latest.yml` 供 `electron-updater` 使用；portable ZIP 是本地分发物，不属于 updater feed。
- runtime、模型权重和组件不上传到应用发布 R2；模型按各自来源与许可策略获取。

### 发布门

标准顺序是：构建并审计受保护资源 → 签名 manifest → 发布 immutable 对象 → 更新渠道指针 → 对公网对象执行 HEAD/Range/完整哈希与签名校验。

当前 1.3.4 已有本地双分发构建、签名、R2 stable 对象/指针和公开下载校验记录。仍未完成的外部门包括：

- 独立 Windows 机器上的安装、更新、回滚、卸载；
- beta/canary（至少 48 小时）与稳定发布人工批准；
- 真实 runtime/model/CUDA 变化下的验证；
- licensed OCR golden set 和完整 image/video/OCR/MCP E2E。

本机测试、packager 输出或公开对象可达性不能单独证明 clean-machine、canary 或最终 stable acceptance。

## 3. 构建策略

### 标准命令

```text
npm.cmd run build:electron:packager
npm.cmd run build:electron:installer
npm.cmd run package:win:matrix
```

本机 NSIS 缓存缺少 `StdUtils::TestParameter` 时，使用仓库提供的可复现 fallback：

```text
npm.cmd run build:electron:installer:local
```

### 构建步骤

1. 运行当前源码回归测试和 lint。
2. 生成受保护的 backend、FFmpeg、模型适配和 runtime 资源。
3. 构建 portable 包；需要安装体验时再构建 NSIS。
4. 审计资源清单、runtime manifest、签名和包内容，确认 app-only 边界。
5. 对 CUDA flavor 的本地 SAM3 wheel 做 SHA-256 校验并以 `--no-deps` 安装；CPU flavor 跳过 CUDA wheel。
6. 按发布策略发布 immutable 对象和渠道指针，并做公网校验。

app-only NSIS 只包含应用与 FFmpeg；首次启动创建受管 Python 环境。完整 CPU/cu130 离线包是 NSIS 与 sibling offline payload 的组合，不把 runtime/model 直接嵌入 NSIS。

## 4. 技术栈与边界

- 前端：Vue 3、Quasar、Vite；路由当前为 `/image`、`/video`、`/activity/mcp`，根路径重定向到 `/image`。
- 桌面壳：Electron。main 进程拥有窗口、Tray、退出、后端生命周期、MCP secret 和持久任务真相；renderer 只能通过命名 preload IPC 获取安全投影。
- 后端：仓库内 `server/moonshine_server` 的 Python/FastAPI 服务。
- 视频：WebAV、`vue-timeline-editor`、Canvas 播放/时间轴；导出失败时使用 FFmpeg fallback。
- OCR：RapidOCR 3.9.2，det/rec/cls 三个 ONNX 文件与 ONNX Runtime。
- 分割：SAM1、SAM2.1、标准 SAM3；`sam3_1_multiplex.pt` 当前仅承诺图像文本能力。
- 修复/去水印：LaMa、MAT、SLBR。MAT 需 CUDA，并受 CC BY-NC 4.0 非商业许可约束；SLBR 面向可见半透明水印。
- 运行环境：支持 managed/external Python；runtime manifest 位于 `build-resources/runtime/win-x64/runtime-manifest.json`，不复制到 `env`。

## 5. 统一心智模型与开始使用

图片和视频不是固定的线性向导。它们共享以下目标链，但每一步可按任务选择、重复或跳过：

```text
上传处理源 → 制作/组合蒙版 → 调用模型处理 → 预览/编辑 → 导出新结果
```

“智能选区”和“手动绘制蒙版”既可以二选一，也可以叠加；OCR、SAM、手绘和擦除都产生或修改同一最终蒙版。官网流程图应使用分支/汇合图，而不是编号步骤列表。

首次使用分为两条入口：

- 免安装包：解压后启动，应用检测 Python、FFmpeg、Torch、后端和模型；按提示选择 auto/CPU/CUDA 环境，缺失资源进入下载或手动导入，失败保留旧 active 环境并允许回滚。
- 安装包：完成 NSIS 安装后首次启动执行同样的环境 onboarding；安装包本身保持 app-only，runtime/model 按 flavor 和网络条件准备。

开始处理前应确认后端状态、模型状态和输出目录；条件能力不可用时，界面应显示原因并保持基础功能可用。

## 6. 图片标准流程

1. 导入当前图片、选中图片或文件夹。
2. 选择任意蒙版来源：手绘笔刷、OCR 候选、SAM 点/框、SAM3 文本；来源可以重复使用或组合。
3. 在统一 smart-selection mask 生命周期中预览、写回、编辑、擦除、撤销/重做和确认。
4. 选择 LaMa、MAT、SLBR 或其他可用模型执行图片处理；支持单文件和批处理，逐项报告成功/失败，可取消。
5. 在主预览检查结果并导出到新文件。

OCR 细节：RapidOCR 返回文字区域 polygon 与 confidence。默认 `>90%` 自动选中，`80%-90%` 显示为候选，`<80%` 隐藏但可调整；阈值可调且会安全校正顺序。普通 OCR polygon 不自动扩张，只有 SAM 或 OCR+SAM 增强会扩张区域。OCR 20 样本结果只是探索证据，不是 licensed golden set。

SAM 批量接口为 `POST /api/v1/moonshine/sam/predict-batch`：单图可提交有序 point、box 或 mixed prompts，按图 bounded micro-batch 处理，OOM/不支持时顺序 fallback；旧单提示 API 保持兼容。SAM1 支持图像 point/box，SAM2.1 增加视频传播，标准 SAM3 支持图像 point/box/text，`sam3_1_multiplex` 图像仅文本提示。

## 7. 视频标准流程

视频流程独立于图片流程，典型状态图为：

```text
导入视频 → 拆帧/建立时间轴
                  ├─ 手动绘制或导入蒙版轨道
                  ├─ SAM2.1/SAM3 视频传播与关键帧编辑
                  └─ SLBR track plan（可按活动帧范围执行）
             → 预览/试跑 → 分段逐帧处理 → WebAV 导出
                                      └─ 失败时 FFmpeg fallback
             → 合并并确认结果
```

时间轴状态包含 `currentTime`、`processingRanges` 和快照恢复；后端请求必须传递 `model_id`。共享 SLBR track plan 按帧作用域执行，非活动帧跳过处理。视频当前不是多任务队列，官网不应把它描述成图片批处理的简单延伸。

## 8. 核心模型逻辑与限制

- LaMa：通用图像擦除基础模型。
- MAT：蒙版修复，CUDA-only；受 CC BY-NC 4.0 非商业许可限制，CPU 不可用时回退 LaMa 并提示。
- SLBR：适合可见半透明水印，支持全图或显式局部 mask/tile 规划和视频逐帧轨道处理；不承诺恢复被完全遮挡的真实细节。
- SAM：根据模型 metadata 暴露能力，不以文件名推断点/框/文本能力；`sam3_1_multiplex.pt` 不宣传图像点选或框选。
- OCR/SAM 共享 candidate → preview → writeback → edit → erase → undo/redo → confirm 生命周期，但保留各自 provenance、polygon 和 confidence 元数据。

## 9. MCP 核心逻辑与安全边界

首发 MCP 通道为 Windows 当前用户私有 named pipe + stdio proxy/native broker，不使用 HTTP。首发工具覆盖 capability/model/service 查询、OCR、OCR/SAM/OCR+SAM mask、单文件/批量文字水印和图标去除、进度、结果、获取和取消。

任务状态为 `awaiting_confirmation`、`queued`、`running`、`succeeded`、`failed`、`cancelled`、`interrupted`。确认策略为 `read_only`、`auto_approve`、`full_access`。任务与当前编辑器分离，只有用户显式执行 `Open in editor` 才导入结果。

必须保持以下 fail-closed 规则：

- token 只存在 main/child IPC 边界，不进入 renderer、日志、配置或第三方客户端；
- 工具白名单、trusted path containment、schema、job ownership、输出路径和取消语义分别校验；
- app/service 关闭、越权目录、未授权工具、无可用 provider、拒绝或取消时，不产生残留文件；
- 原始文件永不覆盖，artifact 只通过受控 descriptor 暴露给 renderer。

## 10. 核心实现清单

- Electron 与运行环境：`src-electron/electron-main.js`、`src-electron/runtime/*`、preload IPC、`src/stores/updateManager.js`、`src/components/global/BackendManager.vue`。
- 图片与蒙版：`src/pages/IndexPage.vue`、`src/services/ImageProcessingService.js`、smart-selection toolbar/mask editor；后端 `server/moonshine_server/api.py`、OCR adapter/API、model manager。
- 视频：`src/pages/VideoPage.vue`、`src/services/VideoProcessingService.js`、CanvasPlayer/timeline、后端 video batch/temporal enhancement。
- 模型：`server/moonshine_server/model_manager.py`、LaMa/MAT 模块、`moonshine/slbr_runner.py`、SAM prediction service 与 metadata 能力矩阵。
- 构建发布：`scripts/prepare-electron-resources.mjs`、`quasar.config.js`、`scripts/build-electron-installer-local.mjs`、`scripts/package-win-matrix.mjs`、`scripts/release/*`。
- MCP：`src-electron/mcp/*`、`mcp-stdio-server.mjs`、native broker、内部 bridge/JobStore/activity/cancel provider。

## 11. 验证状态与官网口径

本地记录中的 startup、settings、MCP/OCR contracts、release、Electron runtime、SLBR、lint、P0/P1 和 SAM3 compatibility 套件均有通过结果；这些结果只代表本机验证。M5/M7 仍有 deferred evidence，且外部 Windows、模型/许可和完整跨流程验收未关闭。

官网应优先引用源码已实现且有 accepted evidence 的能力；对条件可用能力显示前置条件；对 deferred/target contract、实验报告和历史版本仅作为限制或变更背景，不列入“已完成功能”。

## 12. 来源与更新规则

- 原始提炼来源：`docs/archive/planning/progress-2026-08-30.md`、`task_plan-2026-08-30.md`、`findings-2026-08-30.md`。
- docs 文件状态和官网引用建议：`docs/DOCUMENTATION_CATALOG.md`。
- 任何实现、发布或验收状态变化，先更新本文件，再在 `docs/evidence/`、`docs/reviews/` 或对应执行计划中补充证据。
- 根目录 `progress.md`、`task_plan.md`、`findings.md` 仅保留指针和未关闭验收门，不再复制本基线内容。
