# Moonshine-Image

Moonshine-Image 是一个面向本地图片与视频去除任务的桌面客户端，基于 Vue 3、Quasar、Electron 与本地 Python 后端构建。项目最初基于 [IOPaint](https://github.com/Sanster/IOPaint) 二次开发，目前已经迁移为仓库内置的 `moonshine_server` 后端服务，并扩展了图片、视频、模型管理、配置迁移、运行时打包与回归验证能力。

## 当前版本相对 2026-04-06 基线的主要更新

对比基线版本：`78e0863e58ff5aa14ed522fc2042562dbbd61a73`，提交时间为 2026-04-06 04:06。

### 后端与运行时

- 后端源码从旧 `iopaint-change` 目录迁移到 `server/moonshine_server`，不再依赖单独覆盖旧 IOPaint 项目。
- 新增本地后端 CLI、运行时检测、依赖安装、模型目录配置与 Electron 后端管理联动。
- Windows 打包流程新增后端资源准备与运行时资源准备脚本，安装包内后端路径为 `resources/backend/server`。
- 后端管理增加路径合法性校验，重点阻断容易导致 Python/模型加载异常的中文路径风险。
- 新增后端错误分类与启动阶段提示，提升首次启动、依赖缺失、服务不可达等问题的可诊断性。

### 模型系统

- 新增模型注册表与模型管理面板，支持模型状态检查、能力展示、下载源与手动安装说明。
- 新增 Hugging Face 主源与副源信息，模型目录统一由后端与前端读取。
- 图片处理模型从单一 Lama 扩展为动态模型框架，已接入 Lama 与 SLBR。
- 新增模型能力雷达图、模型参数 schema、运行能力声明与前端动态表单。

### 图片处理

- 右侧运行设置面板重构，模型、作用范围、参数、批量操作与输出路径按模型能力动态展示。
- 新增图片输出格式与质量控制：
  - `auto`
  - `original`
  - `png`
  - `jpg`
  - `webp`
- JPG/WebP 输出质量默认 `95`，前端和后端均限制在 `1-100`。
- 强制 JPG 输出透明图时，后端使用白色背景合成。
- 后端响应返回真实 `format`、`mime_type`、`extension`，历史记录与下载文件名使用实际输出扩展名。
- 批量导入改为批量读取文件元数据，不再在导入阶段读取完整图片内容。
- 路径模式按规范化完整路径 O(1) 查重，同一路径重复导入跳过，不同文件夹同名图片允许共存。
- 左侧图片列表与底部已加载文件浮层改为虚拟滚动，改善 1 万/5 万级路径导入场景。
- 切换不需要蒙版的模型时，仅临时隐藏绘制工具，不覆盖用户原本的绘制开关偏好。

### 视频处理

- 视频页已形成上传、预览、蒙版、时间轴、关键帧、批量处理、结果替换与撤销的完整工作流。
- 支持 SLBR 按时间范围筛选处理帧，Lama 仍按蒙版处理。
- 新增视频处理临时任务目录、恢复索引、失败现场保留与清理策略。
- 后端终端进度显示优化：
  - 识别 tqdm 进度行。
  - 进度行按 500ms-1000ms 范围节流刷新。
  - 即使后端没有新文本，同一进度行也会通过本地 heartbeat 更新已用时间。
  - 视频批处理开始/完成日志转换为用户可读中文文案。
  - 完成时进度补齐到 100%，避免停留在上一帧进度。

### 全局配置与文件管理

- 新增共享配置 schema：`src/shared/appConfigSchema.js`。
- Electron 与前端统一使用同一份默认配置，不再维护两份手写默认配置。
- 新增 `schemaVersion`，旧配置会在启动读取时自动迁移：
  - 新旧配置共有字段保留用户值。
  - 新字段补默认值。
  - 已移除字段从旧配置中删除。
- 移除未被真实业务使用的旧字段：
  - `advanced.maxConcurrentTasks`
  - `advanced.enableDebugMode`
  - `advanced.logLevel`
- 文件管理新增临时文件清理策略：
  - 允许自动清理。
  - 应用启动时执行。
  - 保留天数。
  - 清理图片临时文件。
  - 清理视频临时文件。
  - 保留最近失败现场。
- 视频失败现场保留数量移动到“全局设置 > 文件管理”中配置。

### UI 与交互

- 新增启动动画与启动引导体验。
- 全局设置页扩展为通用配置、后端配置、模型管理、文件管理、外观主题、高级配置。
- 后端管理终端日志中文化，并优化完成态颜色。
- 图片页与全局设置中的暗色模式样式持续优化，包括模型管理卡片、运行设置侧栏、雷达图标注等。
- 快捷键配置支持录制、冲突校验、恢复单项默认与恢复全部默认。

### 测试与回归

- 新增 P0 静态回归断言：`npm run test:regression:p0:assertions`。
- 新增 P0 gate：`npm run test:regression:p0`。
- 新增 P1 图片专项断言：`npm run test:regression:p1:image`。
- 新增图片设置 smoke E2E：`npm run test:regression:e2e:smoke`。
- 新增综合 E2E：`npm run test:regression:e2e:workflow`，覆盖图片、视频、蒙版、撤销、后端终端与文件管理配置。
- 依赖管理从 Yarn 转为 npm lockfile，删除 `yarn.lock`。

## 技术栈

- [Vue.js 3](https://vuejs.org/)：前端框架
- [Quasar Framework](https://quasar.dev/)：UI组件库
- [Electron](https://www.electronjs.org/)：桌面应用开发框架
- [Canvas API](https://developer.mozilla.org/zh-CN/docs/Web/API/Canvas_API)：图像处理和绘制
- [WebAV](https://github.com/WebAV-Tech/WebAV "WebAV")：基于 WebCodecs 构建的网页视频编辑 SDK
- [vue-timeline-editor](https://github.com/CuiMuxuan/vue-timeline-editor "vue-timeline-editor")：基于 Vue 3 的时间轴编辑器组件
- Python 后端服务 `moonshine_server`

## 功能实现状态

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 图片导入与虚拟列表 | ✅ | 支持大批量路径导入、查重、取消与虚拟滚动 |
| 图片蒙版绘制 | ✅ | 支持画笔、矩形、橡皮、撤销与默认画笔配置 |
| 图片模型处理 | ✅ | 支持 Lama、SLBR、单图、批量、文件夹模式 |
| 图片输出策略 | ✅ | 支持格式、质量、真实扩展名与 MIME 元数据 |
| 视频上传与预览 | ✅ | 支持视频源加载、代理预览与输出管理 |
| 视频蒙版与关键帧 | ✅ | 支持时间轴、蒙版范围、关键帧与绘制撤销 |
| 视频模型处理 | ✅ | 支持 Lama 与 SLBR 范围处理 |
| 后端管理 | ✅ | 支持环境检测、依赖安装、服务启停、终端日志 |
| 模型管理 | ✅ | 支持模型状态、能力展示、下载源与手动安装说明 |
| 全局配置迁移 | ✅ | 支持 schemaVersion 自动迁移 |
| 临时文件清理 | ✅ | 支持启动清理、手动清理与失败现场保留 |
| 回归测试 | ✅ | 覆盖 P0、P1、E2E 场景 |
| 视频任务队列 | 🔄 | 尚未实现多任务排队、后台恢复与断点续跑 |
| OCR 自动生成蒙版 | 📝 | 尚未实现 |
| 图片裁剪/旋转/调色 | 📝 | 尚未实现 |

## 快速使用

推荐使用 v1.0.0 及以上 Windows 发布包：

1. 下载发布包并解压。
2. 打开 `Moonshine-Image.exe`。
3. 右上角进入“后端管理”，按提示检查环境并启动服务（当前在启动软件时会自动启动服务）。
4. 如模型缺失，进入“全局设置 > 模型管理”查看模型状态、下载源或手动安装说明。

发布包内关键路径：

- 后端项目：`resources/backend/server`
- Python 运行时：`resources/runtime/win-x64/env`
- 模型目录：`resources/models`

## 本地开发

### 安装依赖

```bash
npm install
```

### 启动前端开发模式

```bash
npm run dev
```

如需完整 Electron 能力，使用 Electron 模式：

```bash
npm run dev -- -m electron
```

### 构建

```bash
# 打包 Web 版本
npm run build
```
```bash
# 打包 Windows 桌面应用
npm run build -- -m electron
```

Windows 运行时与资源准备：

```bash
npm run build:runtime:win
npm run prepare:backend
npm run prepare:electron-resources
```

## 手动启动后端服务

后端源码位于 `server/`，Python 包名为 `moonshine_server`。

1. 推荐 Python 3.11.x。

2. 安装依赖：

```bash
pip install -r server/requirements.txt
```

如需 CUDA，请按显卡与 CUDA 版本安装匹配的 PyTorch。

3. 准备模型文件。默认模型目录为项目根目录下的 `models/`：

- Lama：`models/big-lama.pt`
- SLBR：`models/slbr.pth.tar`

4. 启动服务：

```bash
python server/main.py start --model=lama --device=cuda --port=8080 --model-dir=models
```

## 使用指南

### 图片处理

![图片处理](assets/image-processing.png)

- 点击底部“选择文件”导入图片。
- 在右侧“运行设置”选择模型、作用范围和模型参数。
- Lama 需要蒙版；SLBR 不需要手工蒙版。
- 可选择仅处理选中文件，也可使用文件夹模式。
- 在“全局设置 > 高级配置 > 图片处理”配置输出格式、质量和命名方式。
- 点击“运行”开始处理，点击“下载”保存结果。

### 视频处理

![视频处理](assets/video-processing.png)

- 点击左侧资源栏上传视频。
- 在“蒙版与导出（已更名为运行设置）”中创建蒙版，并在预览区绘制。
- 通过时间轴或右侧配置调整蒙版范围和关键帧。
- 全屏模式下具有和图片处理中相似的绘制蒙版体验。
- 选择模型与处理参数后执行处理。
- 处理完成后可打开输出目录，或将结果替换为当前视频源继续编辑。

### 后端管理

![后端管理](assets/backend-management.png)

- 检查后端项目路径、Python 环境与依赖状态。
- 配置端口、设备、默认模型和模型目录。
- 启动、停止或重启后端服务。
- 查看终端日志和处理进度。

### 全局配置

![全局配置](assets/global-settings.png)

- 通用配置：快捷键录制、冲突校验和默认值恢复。
- 后端配置：端口、启动方式、后端项目路径、模型目录。
- 模型管理：模型状态、下载源、手动安装说明和能力展示。
- 文件管理：下载路径、临时路径、临时文件清理、失败现场保留。
- 外观主题：主题色、绘制工具按钮大小、默认画笔。
- 高级配置：图片输出策略、视频处理参数、历史记录限制。

## 回归验证

常用质量闸门：

```bash
npm run lint
npm run build
npm run test:regression:p0
npm run test:regression:p0:assertions
npm run test:regression:p1:image
npm run test:regression:e2e:smoke
npm run test:regression:e2e:workflow
```

如果已经完成构建，可复用构建产物运行 E2E：

```powershell
$env:MOONSHINE_E2E_SKIP_BUILD='1'; npm run test:regression:e2e:workflow
```

## 许可证

本项目采用 [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html) 许可证开源。
