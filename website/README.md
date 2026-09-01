# Moonshine-Image 官网

这是一个面向使用者的纯静态 GitHub Pages 官网，不包含开发流程、源码说明或内部验收信息。

## 本地预览

在仓库根目录运行任意静态服务器，例如：

```text
python -m http.server 4173 --directory website
```

然后打开 `http://localhost:4173`。

## 发布

`.github/workflows/deploy-pages.yml` 会将 `website/` 发布到 GitHub Pages。部署前，`website/scripts/sync-release-metadata.mjs` 会校验签名的 stable 发布清单并生成同源的 `release/latest.json`；首页据此自动显示最新 stable 版本和安装器链接。稳定版发布流程成功完成后也会自动触发一次 Pages 刷新。

如果远端清单暂时不可用，部署会继续使用仓库中已验证的回退元数据，主下载按钮不会因此失效。其他分发形式由 GitHub Releases 入口承接。
