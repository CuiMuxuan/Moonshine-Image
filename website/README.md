# Moonshine-Image 官网

这是一个面向使用者的纯静态 GitHub Pages 官网，不包含开发流程、源码说明或内部验收信息。

## 页面维护

首页沿用 Moonshine 的紫色主色与青蓝辅助色，提供深浅主题、响应式导航、图片/视频工作台切换、截图放大和常见问题。文档中心继续使用独立的 `docs/` 页面。

图标使用本地 `assets/lucide.min.js`（Lucide 0.468.0，许可见 `assets/lucide-LICENSE`），不依赖第三方 CDN。产品截图均来自现有项目素材。页面布局与交互参考 LightC 的信息层次，未使用其代码或视觉素材。

首页中的版本号由现有发布元数据流程维护，不随视觉改版手工更新。没有 JavaScript 时，功能说明、FAQ、文档和回退下载链接仍可访问。

首页与使用指南共用 `download.css` 下载卡片样式和 `release.js` 版本读取逻辑。两处保留相同的静态卡片内容以支持无 JavaScript 阅读，回归测试会检查一致性；元数据路径相对脚本定位，兼容文档子目录及 GitHub Pages 项目路径。

## 本地预览

在仓库根目录运行任意静态服务器，例如：

```text
python -m http.server 4173 --directory website
```

然后打开 `http://localhost:4173`。

首页静态契约回归：`node --test website/scripts/homepage.test.mjs`。视觉变更还需检查桌面和移动端、深浅主题、Tab 键盘切换、截图对话框及下载回退。

文档和动画回归：`node --test website/scripts/docs-motion.test.mjs`。首页使用 IntersectionObserver 与 Web Animations API 实现一次性滚动入场；原始内容不依赖动画可见。减少动态效果、键盘与锚点导航跳过入场动画。文档正文保持静止，目录支持本地筛选、移动端焦点管理和代码复制。

## 发布

`.github/workflows/deploy-pages.yml` 会将 `website/` 发布到 GitHub Pages。部署前，`website/scripts/sync-release-metadata.mjs` 会校验签名的 stable 发布清单并生成同源的 `release/latest.json`；首页据此自动显示最新 stable 版本和安装器链接。稳定版发布流程成功完成后也会自动触发一次 Pages 刷新。

如果远端清单暂时不可用，部署会继续使用仓库中已验证的回退元数据，主下载按钮不会因此失效。其他分发形式由 GitHub Releases 入口承接。
