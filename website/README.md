# Moonshine-Image 官网

这是一个面向使用者的纯静态 GitHub Pages 官网，不包含开发流程、源码说明或内部验收信息。

## 本地预览

在仓库根目录运行任意静态服务器，例如：

```text
python -m http.server 4173 --directory website
```

然后打开 `http://localhost:4173`。

## 发布

`.github/workflows/deploy-pages.yml` 会将 `website/` 原样发布到 GitHub Pages。当前主下载按钮指向已经公开验证的 1.3.4 Windows x64 安装包，其他分发形式由 GitHub Releases 入口承接。发布新版本时需要同步更新首页的版本号和主下载链接。
