# Moonshine-Image

Moonshine 图像/视频处理客户端

## 项目简介

这个项目是以 [IOPaint](https://github.com/Sanster/IOPaint) 为基础的二次开发项目，目前能够实现更灵活地批量为图片/视频去除物体（或者水印、文字等）。

## 技术栈
- [Vue.js 3](https://vuejs.org/)：前端框架
- [Quasar Framework](https://quasar.dev/)：UI组件库
- [Electron](https://www.electronjs.org/)：桌面应用开发框架
- [Canvas API](https://developer.mozilla.org/zh-CN/docs/Web/API/Canvas_API)：图像处理和绘制
- [WebAV](https://github.com/WebAV-Tech/WebAV "WebAV")：基于 WebCodecs 构建的网页视频编辑 SDK
- [vue-timeline-editor](https://github.com/CuiMuxuan/vue-timeline-editor "vue-timeline-editor")：基于 Vue 3 的时间轴编辑器组件

## 功能实现状态

- ✅ 批量图像蒙版编辑
- ✅ 批量图像处理
- ✅ 启动配置的灵活处理
- ✅ 通过前端UI启动后端程序
- ✅ 视频处理
- 🔄 OCR文字识别并将蒙版提交给去除页面
- 📝 整合图片修复模型（如微软的Bringing-Old-Photos-Back-to-Life项目）
- 📝 图片文件的查看与编辑功能（裁剪、旋转、大小重置、颜色调节等）
- 📝 截图后保存或者处理功能

> 注：✅ 已实现 | 🔄 正在实现 | 📝 计划实现

项目现在包含独立后端服务，源码位于 `server/`，桌面端可通过“后端管理”或启动流程自动拉起本地服务。**v1.0.0以上版本发布的 Windows 软件包可以一键启动，不再需要考虑配置环境和模型**。
## 快速使用
方法一：获取本项目v0.0.2发行版本的zip文件并解压缩，双击 bat 一键启动脚本。

方法二：获取本项目v0.1.0发行版本的zip文件并解压缩。打开exe软件后，于右上角，先调整全局配置，再点击后端管理，逐步配置环境并启动后端。

方法三（推荐）：获取本项目v1.0.0及以上发行版本的zip文件并解压缩。打开exe软件后，于右上角点击后端管理，按照提示等待软件自动配置环境，点击启动。

![软件包清单](assets/软件包清单.png)
> 全局配置的后端设置仅于使用后端管理功能时有效

## 开发本项目的准备

本仓库现在直接包含后端服务源码，后端项目位于 `server/`，内部 Python 包名为 `moonshine_server`。开发时不再需要单独拉取 IOPaint，也不再需要使用旧覆盖目录。

### 手动启动后端服务

1. 准备 Python 环境，推荐 Python 3.11.x。

2. 安装后端依赖：

    ```bash
    pip install -r server/requirements.txt
    ```

    如需使用 CUDA，请按显卡与 CUDA 版本安装匹配的 PyTorch。

3. 准备模型文件。默认模型目录为项目根目录下的 `models/`，模型文件不会提交到仓库。当前模型文件直接放在模型目录根部：

    - Lama：`models/big-lama.pt`
    - SLBR：`models/slbr.pth.tar`

    软件内模型管理会优先从 Hugging Face 主源 `CuiMuxuan/moonshine-models` 下载；如果主源不可用，可从夸克网盘副源 `https://pan.quark.cn/s/2e51ec70c7b9` 手动下载对应文件并放入上述目录。也可以私信作者或者加入交流群获取模型文件或百度网盘链接。

4. 启动后端服务：

    ```bash
    python server/main.py start --model=lama --device=cuda --port=8080 --model-dir=models
    ```

### 使用后端管理功能

Electron 开发模式会默认检测仓库内的 `server/` 后端项目。点击右上角“后端管理”后，可以配置端口、设备、模型目录并启动服务。

> 软件压缩包中的后端项目路径为 **resources\backend\server**

> 软件压缩包中的 Python 运行时位于 **resources\runtime\win-x64\env**

> 软件压缩包中的模型文件位于 **resources\models**

环境检测完成后，程序会检查后端项目目录是否包含 `requirements.txt`、`main.py` 和 `moonshine_server/`。若检测失败，请确认全局配置中的后端项目路径指向仓库内的 `server/` 或安装包内的 `resources\backend\server`。

环境配置步骤：
1. 检查 Python 环境与依赖包是否存在。
2. 若缺少依赖，则通过 pip 安装 `server/requirements.txt` 中的依赖。

服务管理步骤：
1. 确认后端服务启动参数（端口、设备、模型、模型目录）。
2. 点击“启动服务”按钮，启动后端服务。

## 开发环境
使用完整功能请完成开发本项目的准备，若仅需要改动前端交互页面则不需要。
1. 克隆本仓库：
```bash
git clone https://github.com/CuiMuxuan/Moonshine-Image.git
```
2. 安装依赖：
```bash
yarn
# or
npm install
```
3. 启动开发模式（建议使用electron模式，本地文件的修改和终端的调用需要以electron模式进行）：
```bash
quasar dev
# or
npm run dev
# 或启动 Electron 版本
quasar dev -m electron
# or
npm run dev -- -m electron
```
4. 构建
```bash
# 打包 Web 版本
quasar build
# or
npm run build
```
```bash
# 打包 Windows 桌面应用
quasar build -m electron -T win32
# or
npm run build -- -m electron
```
## 使用指南

以下内容为软件的使用说明
### 图片处理
![图片处理](assets/图片处理.png)
- 快速使用
    - 添加图像：点击底部工具栏中的"选择文件"按钮添加图像
    - 编辑蒙版：使用绘制工具创建或编辑图像蒙版
    - 选择处理模型：在运行设置顶部选择处理模型
    - 选择作用范围：作用范围会控制运行和下载功能生效的文件
- 批量处理
    - 方式1：选中多个文件=>作用范围选择仅选中文件
    - 方式2：作用范围选择文件夹=>设置图片文件夹、蒙版文件夹
- 进行处理
    - 点击"运行"按钮=>根据运行设置开始处理图像
    - 运行过程中可以通过后端管理页面的终端查看处理进度
- 保存结果
    - 点击"下载"按钮=>根据运行设置保存处理结果
    - 默认保存路径自动初始化全局配置中的图片路径
    - 运行设置右侧栏可以指定保存路径，其值优先级高于默认路径
- 后端管理
    - 检查并配置后端服务环境，支持管理后端服务(开启、停止、设置启动参数、重启)。

### 视频处理
![视频处理](assets\视频处理.png)
- 快速使用
    - 添加视频：点击左侧资源栏顶部的上传按钮导入视频
    - 创建蒙版：在“蒙版与导出”页签中点击“新建蒙版”，选择需要编辑的蒙版
    - 绘制蒙版：在主预览区开启绘制后，使用画笔、矩形或橡皮工具编辑蒙版
    - 调整时间范围：通过时间轴或右侧“蒙版范围编辑”设置蒙版的开始时间与结束时间
- 关键帧编辑
    - 在当前时间点添加关键帧，用于控制蒙版的位置、缩放与时间变化
    - 可在右侧“关键帧编辑”中精确修改关键帧时间、坐标和缩放
    - 支持为蒙版设置关键帧插值方式，并在时间轴中直观查看蒙版区间与关键帧
- 进行处理
    - 选择导出帧率后，点击“运行处理”开始按批次处理视频
    - 处理过程中会显示全局进度、阶段说明与预计剩余时间
    - 若后端服务已启动，可通过后端管理页面查看更详细的处理输出
- 结果管理
    - 处理完成后可直接打开输出目录
    - 支持将最新处理结果替换为当前视频源文件，继续下一轮编辑
    - 支持在当前会话内回退到历史记录中的原始视频或替换后视频

### 全局配置
![全局配置](assets/全局配置.png)
- 通用配置
    - 可为图片处理页、视频处理页中的常用动作配置快捷键
    - 支持录制快捷键、恢复单项默认值，以及一键恢复全部默认配置
- 后端配置
    - 配置后端端口、启动方式、后端项目路径、模型目录与默认模型
    - 相关设置主要在使用后端管理功能时生效
- 文件管理
    - 配置下载 / 导出路径、临时文件路径
    - 配置图片输出文件夹名与视频输出文件夹名
- 外观主题
    - 调整主题品牌色
    - 调整绘制工具按钮大小
    - 分别设置图片处理与视频处理的默认画笔颜色、大小和透明度
- 高级配置
    - 图片处理：配置历史记录上限、图片警告大小、状态保存上限、图片处理方式，以及输出文件命名方式
    - 视频处理：配置固定批次帧数、拆帧存储格式、最大导出帧数、历史记录上限、批次重试次数、失败现场保留数量与代理预览最大边长

## 视频演示
[点击查看图片处理视频演示](https://space.bilibili.com/589465087)
## 许可证

本项目采用 [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html) 许可证开源。
