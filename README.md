## What it deliveres
* eCommerce UI template written in Vue.js/Quasar


## 技术栈
- [Vue.js 3](https://vuejs.org/)：前端框架
- [Quasar Framework](https://quasar.dev/)：UI组件库
- [Electron](https://www.electronjs.org/)：桌面应用开发框架
- [Canvas API](https://developer.mozilla.org/zh-CN/docs/Web/API/Canvas_API)：图像处理和绘制


## 主要功能

- **图像蒙版编辑**：通过直观的绘图工具创建和编辑图像蒙版
- **图像处理模型**：
  - 去除模型：移除图像中的特定元素
  - OCR文字识别：识别图像中的文字内容
  - 修复模型：修复图像中的瑕疵
- **批量处理**：支持对多个文件或整个文件夹进行批量处理


## Installation

* **Clone the repository**

```
git clone https://github.com/mayur091193/quasar-shopping.git
```
# moonshine (moonshine-client)

Moonshine 图像处理客户端

## Install the dependencies
```bash
yarn
# or
npm install
```

### Start the app in development mode (hot-code reloading, error reporting, etc.)
```bash
quasar dev
# 或启动 Electron 版本
quasar dev -m electron
```


### Lint the files
```bash
yarn lint
# or
npm run lint
```


### Build the app for production
```bash
# 打包 Web 版本
quasar build
```
```bash
# 打包 Windows 桌面应用
quasar build -m electron -T win32
```
### Customize the configuration
See [Configuring quasar.config.js](https://v2.quasar.dev/quasar-cli-vite/quasar-config-js).

## 使用指南
1. 添加图像 ：点击底部工具栏中的"选择文件"按钮添加图像
2. 编辑蒙版 ：使用绘制工具创建或编辑图像蒙版
3. 选择处理模型 ：在顶部选择需要的处理模型（去除、OCR或修复）
4. 运行处理 ：点击"运行"按钮开始处理图像
5. 保存结果 ：处理完成后，点击"下载"按钮保存处理结果

**Login option 1**

<p float="left">
        <kbd>
<img src="https://cdn.quasar.dev/img/mountains.jpg" border="1" alt="Alt"
        title="Title"  />
                </kbd>
</p>

**Login option 1**

<p float="left">
        <kbd>
<img src="https://cdn.quasar.dev/img/mountains.jpg" border="1" alt="Alt"
        title="Title"  />
                </kbd>
</p>


## Future release:
* Mobile friendly
* Seller related pages
* Backend(planning to use [Python](https://www.python.org/))


## License
[GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html)