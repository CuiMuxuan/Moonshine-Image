# Moonshine-Image

Moonshine 图像处理客户端

## 项目简介

这个项目是以 [IOPaint](https://github.com/Sanster/IOPaint) 为基础的二次开发项目，目前能够实现更灵活地批量为图片去除物体（或者水印、文字等）。

## 技术栈
- [Vue.js 3](https://vuejs.org/)：前端框架
- [Quasar Framework](https://quasar.dev/)：UI组件库
- [Electron](https://www.electronjs.org/)：桌面应用开发框架
- [Canvas API](https://developer.mozilla.org/zh-CN/docs/Web/API/Canvas_API)：图像处理和绘制

## 功能实现状态

- ✅ 批量图像蒙版编辑
- ✅ 批量图像处理
- ✅ 启动配置的灵活处理
- ✅ 通过前端UI启动后端程序
- 🔄 视频处理
- 📝 OCR文字识别并将蒙版提交给去除页面
- 📝 整合图片修复模型（如微软的Bringing-Old-Photos-Back-to-Life项目）
- 📝 图片文件的查看与编辑功能（裁剪、旋转、大小重置、颜色调节等）
- 📝 截图后保存或者处理功能

> 注：✅ 已实现 | 🔄 正在实现 | 📝 计划实现

目前项目没有独立的后端，后续开发过程中若有必要会建立独立的后端程序（目前可以在前端UI页面中半自动地配置后端）。
## 快速使用
方法一：下载压缩包并解压缩，双击 bat 一键启动脚本。
方法二：git本项目与IOPaint 项目，更换iopaint子目录下的三个py文件，打开软件后，于右上角，先调整全局配置，再点击后端管理，逐步配置环境并启动后端。（尚未于空环境PC端测试，已配置好的环境成功通过测试）

## 使用前准备

1、将 IOPaint 项目拉取或下载到本地：

```bash
git clone https://github.com/Sanster/IOPaint.git
```

2、配置后端环境：
首先要有 Python 环境，推荐 3.10 版本的环境(开发环境为3.11.5)。
安装依赖：

```bash
pip install -r requirements.txt
```

注意，如果需要使用 CUDA，请下载 CUDA 版本的 torch。

3、下载 [big-lama 模型](https://huggingface.co/CuiMuxuan/big-lama/tree/main)并将其放置于 '%当前用户%\.cache\torch\hub\checkpoints' 路径下，或者，使用如下命令将自动进行 iopaint 的模型下载：

```bash
pip3 install iopaint
iopaint start --model=lama --device=cpu --port=8080
```

4、将本项目 iopaint-change 目录下的文件替换掉 IOPaint 项目 iopaint 目录下的同名文件。

5、在 IOPaint 目录下使用以下命令开启后端程序：
```bash

python main.py start --model=lama --device=cuda --port=8080
```

## 开发环境
克隆本仓库：
```bash
git clone https://github.com/CuiMuxuan/Moonshine-Image.git
```
安装依赖：
```bash
yarn
# or
npm install
```
启动开发模式（建议使用electron模式，本地文件的修改和终端的调用需要以electron模式进行）：
```bash
quasar dev
# 或启动 Electron 版本
quasar dev -m electron
```
构建
```bash
# 打包 Web 版本
quasar build
```
```bash
# 打包 Windows 桌面应用
quasar build -m electron -T win32
```
## 使用指南
- 添加图像：点击底部工具栏中的"选择文件"按钮添加图像
- 编辑蒙版：使用绘制工具创建或编辑图像蒙版
- 选择处理模型：在顶部选择需要的处理模型（去除、OCR或修复）
- 选择作用范围：作用范围会控制运行和下载功能生效的文件
- 运行处理：点击"运行"按钮开始处理图像
- 保存结果：处理完成后，点击"下载"按钮保存处理结果
- 全局配置：全局配置会在前后端生效，通过全局配置可以设定后端程序的启动参数、文件的路径、前端的部分参数等，首次使用需要点击一次保存。
- 后端管理：需要选择一个后端项目路径（确保已将本项目iopaint-change目录下的文件替换掉iopaint项目的同名文件），然后可以通过UI进行配置环境的流程。（首次配置不保证成功，若不成功则根据提升手动配置）成功配置完项目后，后续仅需要在后端管理页面启动后端程序即可。
## 视频演示
[点击查看视频演示](https://space.bilibili.com/589465087)
## 许可证

本项目采用 [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html) 许可证开源。