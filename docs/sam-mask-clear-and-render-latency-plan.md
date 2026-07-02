# SAM 蒙版清理与切图渲染延迟优化方案

## 状态

- 当前阶段：方案待确认。
- 本文件只记录计划，不代表已经执行代码改动。
- 执行前需要确认：运行图片处理模型成功后，是否清除该图片的全部蒙版源层，包括手绘蒙版和 SAM 智能选区候选源层。

## 背景问题

当前图片处理模型运行成功后，父级 `file.mask` 会被清空，但 `ImageMasker` 内部仍保留按图片 context 保存的 SAM 候选源层。

因此会出现以下链路：

1. `IndexPage.clearMasksForProcessedFileIds()` 调用 `fileManagerStore.updateFileMask(fileId, null)`。
2. `ImageMasker` 的 `props.mask` watcher 收到空蒙版。
3. watcher 发现当前 context 仍有 SAM candidates，于是走 `scheduleStableMaskComposite()`。
4. `renderSamCandidates()` 重新从 SAM session 合成蒙版并 `emitMask()`。
5. 父级 `file.mask` 又被写回，表现为“运行模型后蒙版没有清除”。

切换图片时的延迟主要来自：

- 切图恢复时需要从 SAM session 重新合成候选蒙版。
- 当前 `cloneSamCandidates()` 会删除 `renderedMask/renderedMaskMeta`，切回来时需要重新做扩边、透明度归一化和 dataURL 图片解码。
- `props.mask` watcher 中的 `getMaskData()` 会触发 `canvas.toDataURL()`，在大图或频繁切换时成本较高。
- 稳定合成使用双 `requestAnimationFrame + nextTick`，这是为保证布局和 canvas 尺寸稳定，不能直接粗暴删除。

## 阶段 A：模型成功后清理 SAM 源层

### 目标

模型成功处理某张图片后，该图片的可见蒙版和 SAM 智能选区源层都被清理，避免 SAM session 在后续 watcher 中把蒙版重新合成回来。

### 代码改动计划

1. 扩展 `src/services/SamImageSessionStore.js`
   - 新增 `deleteSamImageSession(contextId)`。
   - 新增 `deleteSamImageSessions(contextIds = [])`。
   - 保留现有 `clearSamImageSessionStore()` 用于全量清理。

2. 扩展 `src/components/image/ImageMasker.vue`
   - 新增内部方法 `clearSamContextSession(contextId = getSamContextId())`。
   - 当 `contextId` 等于当前 active context：
     - 清空 `samCandidates`。
     - 清空 `samBaseSnapshot` / `samBaseSnapshotDataUrl`。
     - 清空候选 hover、候选弹窗、性能状态等与当前 SAM 结果相关的 UI 状态。
     - bump base/candidate revision，并 reset render state。
     - 清空当前 canvas 并 `emitMask()` 发送 clear。
   - 当 `contextId` 不是当前 active context：
     - 只删除 `SamImageSessionStore` 中对应 session。
   - 通过 `defineExpose()` 暴露给 `IndexPage`。

3. 调整 `src/pages/IndexPage.vue`
   - 在 `clearMasksForProcessedFileIds(processedFileIds)` 中：
     - 继续执行 `fileManagerStore.updateFileMask(fileId, null)`。
     - 同步删除这些 fileId 对应的 SAM image session。
     - 如果当前打开图片在 processedFileIds 中，调用 `editorRef.value?.clearSamContextSession?.(currentFile.id)`。
   - 只在模型成功处理的 fileId 上清理。
   - 失败、取消、无成功结果时不清理。

4. 保持不变
   - SAM 文本智能选区生成候选时仍写入 session。
   - 用户手动删除候选仍走现有候选删除逻辑。
   - 视频 SAM 轨道不受本阶段影响。

### 验收标准

- LaMa 单图成功运行后，当前图片蒙版消失，切换图片再切回也不会恢复。
- LaMa 批量成功运行后，仅成功处理的图片蒙版和 SAM session 被清理。
- 失败图片保留原蒙版和 SAM session。
- SLBR 等不依赖蒙版的模型不受影响。
- SAM 文本/点选/框选生成候选后，在未运行处理模型前仍能正常切图恢复。

## 阶段 B：切图渲染延迟优化

### 目标

在不破坏“切图后只进行一次可见 canvas 合成提交”的前提下，减少切换图片时重新生成 SAM 蒙版的时间。

### 默认配置设计

缓存策略需要可控，避免大批量图片时无上限占用内存。配置建议放在 `masking` 下，因为它属于智能选区行为，而不是通用图片处理参数。

计划新增默认配置：

```js
masking: {
  samRenderCacheEnabled: true,
  samRenderCacheMaxContexts: 12,
  samRenderCacheMaxMemoryMb: 192,
  samRenderCacheLargeImageLongSide: 4096,
  samLazyRenderDisabledCandidates: true,
  samRenderCachePreloadVisibleList: true,
  samRenderCacheNeighborPreloadCount: 4,
}
```

字段含义：

- `samRenderCacheEnabled`
  - 是否启用 SAM 图片候选渲染缓存。
  - 默认 `true`。

- `samRenderCacheMaxContexts`
  - 最多保留最近多少张图片的渲染缓存。
  - 默认 `12`。
  - 建议范围 `1-50`。

- `samRenderCacheMaxMemoryMb`
  - 渲染缓存估算内存上限。
  - 默认 `192` MB。
  - 建议范围 `32-1024`。

- `samRenderCacheLargeImageLongSide`
  - 图片长边超过该阈值时，不长期保留该图的 rendered cache，只做本次渲染。
  - 默认 `4096`。
  - 建议范围 `1024-12000`。

- `samLazyRenderDisabledCandidates`
  - 未启用候选是否懒渲染。
  - 默认 `true`。
  - 启用后切图只优先渲染当前可见候选，未启用候选在 hover、启用或打开候选预览时再生成。

- `samRenderCachePreloadVisibleList`
  - 是否使用图片左侧虚拟列表当前可见范围作为预热提示。
  - 默认 `true`。
  - 仅在左侧列表打开且虚拟列表报告可见范围时生效。

- `samRenderCacheNeighborPreloadCount`
  - 当前图片前后各预热多少张相邻图片。
  - 默认 `2`。
  - 建议范围 `0-10`。

### 全局设置入口

位置：`全局设置 > 高级配置 > 图片处理`。

建议放在现有“智能选区默认模型”配置块下方，新增一个 mini-block。

标题：`智能选区渲染缓存`

控件：

- `q-toggle`
  - 文案：`启用渲染缓存`
  - 绑定 `localConfig.masking.samRenderCacheEnabled`

- `q-input type="number"`
  - 文案：`最近图片缓存数量`
  - 绑定 `localConfig.masking.samRenderCacheMaxContexts`
  - 范围 `1-50`

- `q-input type="number"`
  - 文案：`缓存内存上限（MB）`
  - 绑定 `localConfig.masking.samRenderCacheMaxMemoryMb`
  - 范围 `32-1024`

- `q-input type="number"`
  - 文案：`大图长边阈值`
  - 绑定 `localConfig.masking.samRenderCacheLargeImageLongSide`
  - 范围 `1024-12000`

- `q-toggle`
  - 文案：`未启用候选懒渲染`
  - 绑定 `localConfig.masking.samLazyRenderDisabledCandidates`

- `q-toggle`
  - 文案：`预热左栏可见图片`
  - 绑定 `localConfig.masking.samRenderCachePreloadVisibleList`

- `q-input type="number"`
  - 文案：`相邻图片预热数量`
  - 绑定 `localConfig.masking.samRenderCacheNeighborPreloadCount`
  - 范围 `0-10`

提示文案：

> 用于减少多图切换时 SAM 蒙版重新渲染的等待时间。缓存只保存在当前程序会话中，超过数量、内存或大图阈值后会自动淘汰，不影响原始候选数据。

### 配置落地计划

1. `src/shared/appConfigSchema.js`
   - 在 `DEFAULT_MASKING_CONFIG` 中新增上述字段。
   - 提升 `CONFIG_SCHEMA_VERSION`。
   - 在迁移/对齐逻辑中补齐旧配置缺失字段。

2. `src/config/ConfigManager.js`
   - 在 `mergeConfig()` 中归一化新字段。
   - 校验数值范围：
     - `samRenderCacheMaxContexts`: `1-50`
     - `samRenderCacheMaxMemoryMb`: `32-1024`
     - `samRenderCacheLargeImageLongSide`: `1024-12000`
     - `samRenderCacheNeighborPreloadCount`: `0-10`
   - 校验布尔字段。

3. `src/components/global/GlobalSettings.vue`
   - 在“高级配置 > 图片处理”中新增渲染缓存配置 UI。
   - 保持 Quasar 组件风格，与当前智能选区默认模型配置相邻。

4. 回归断言
   - `scripts/p0-regression-assertions.mjs` 覆盖配置 schema 和归一化。
   - `scripts/p1-image-regression-assertions.mjs` 覆盖图片页缓存策略与 UI 配置入口。

### 优化 B1：动态 LRU 渲染缓存

核心原则：所有图片长期保留 SAM 源层，但渲染结果只进入有上限的临时缓存。

长期保留：

- `candidate.mask`
- `candidate.eraseMask`
- `candidate.expandPx`
- `candidate.enabled`
- prompt/model metadata

可淘汰：

- `candidate.renderedMask`
- `candidate.renderedMaskMeta`
- context 级合成预览缓存

1. 调整 `cloneSamCandidates(items, options)`
   - 默认仍可清理大型渲染缓存。
   - 对于 `samSessionByContext` 这种仅内存会话存储，可在缓存策略允许时保留 `renderedMask/renderedMaskMeta`。
   - 对持久化或外部返回的数据仍不保留渲染缓存。

2. 新增渲染缓存管理器
   - 可放在 `src/services/SamImageRenderCache.js`。
   - 按 `contextId` 管理最近访问顺序。
   - 每个 context 记录：
     - `lastAccessedAt`
     - `estimatedBytes`
     - 候选 rendered cache 引用
     - 可选 composite preview cache
   - 提供方法：
     - `touchSamRenderCacheContext(contextId)`
     - `setSamRenderCacheEntry(contextId, cacheInfo)`
     - `evictSamRenderCache(config)`
     - `clearSamRenderCacheContext(contextId)`
     - `clearSamRenderCache()`

3. 内存估算
   - `renderedMask` dataURL 估算：`renderedMask.length * 2`。
   - 单次渲染临时峰值不进入长期缓存，但用于判断大图：
     - `width * height * 4 * 2` 作为保守估计。
   - context 总估算超过配置上限时，优先淘汰最久未访问 context。

4. 大图策略
   - 如果 `Math.max(width, height) > samRenderCacheLargeImageLongSide`：
     - 当前切图仍可渲染。
     - 不把 `renderedMask` 写入长期 render cache。
     - 保留原始 `candidate.mask`，下次访问重新生成。

5. 调整 session 保存/恢复
   - `saveSamContextSession()` 保存候选时不再无条件删除 rendered cache。
   - 是否保留由缓存管理器决定。
   - `restoreSamContextSession()` 恢复候选时优先恢复缓存命中的 rendered cache。
   - `resolveSamCandidateMaskForRendering()` 继续依赖 `renderedMaskMeta` 校验：
     - 原始 mask。
     - canvas width/height。
     - expandPx。
     - eraseMask。
     - autoExpand。
     - displayAlpha。
   - 只要 meta 不匹配，仍重新生成，保证正确性。

6. 淘汰行为
   - 淘汰只删除 rendered cache，不删除原始 SAM candidate。
   - 被淘汰图片下次切回时可重新生成 rendered cache。
   - 阶段 A 删除某张图片 SAM session 时，也同步删除该 context 的 render cache。

### 优化 B2：候选懒渲染

1. 切图时优先渲染可见结果
   - `enabled === true` 的候选优先参与最终合成。
   - 当前可见蒙版合成完成后，再考虑空闲时预热其他候选。

2. 未启用候选按需渲染
   - 当 `samLazyRenderDisabledCandidates === true`：
     - 未启用候选不在切图主路径生成 `renderedMask`。
     - 用户 hover 候选、启用候选、打开候选预览时再生成。
   - 当配置为 `false`：
     - 保持当前更积极的预渲染策略。

3. 可选预热
   - 在 `requestIdleCallback` 可用时，空闲时预热当前图片未启用候选。
   - 不支持 `requestIdleCallback` 时不做强制 polyfill，避免增加复杂度。

### 优化 B3：基于左侧虚拟列表的预热提示

当前图片左侧栏使用 `QVirtualScroll`，它本身就是懒加载列表，只渲染可视范围附近的 item。该范围可以用来辅助判断用户短期内可能点击哪些图片，但不能作为唯一缓存依据。

#### 原则

- 左栏可见范围只作为“预热提示”，不作为强制缓存保留条件。
- 预热必须服从：
  - `samRenderCacheEnabled`
  - `samRenderCachePreloadVisibleList`
  - `samRenderCacheMaxContexts`
  - `samRenderCacheMaxMemoryMb`
  - `samRenderCacheLargeImageLongSide`
- 预热只在空闲时间执行，不阻塞当前图片渲染。
- 左栏关闭时不做可见范围预热，仅保留当前图片和相邻图片预热。

#### 优先级

```text
P0：当前打开图片
- 立即渲染。
- 当前 rendered cache 不因 LRU 淘汰。

P1：当前图片相邻图片
- 由 samRenderCacheNeighborPreloadCount 控制。
- 默认前后各 4 张。
- 使用空闲预热。

P2：左侧虚拟列表可见范围
- 仅在左栏打开且 samRenderCachePreloadVisibleList 为 true 时启用。
- 使用 QVirtualScroll 上报的 from/to 范围。
- debounce 后进入空闲预热队列。

P3：最近访问图片 LRU
- 作为缓存保留和淘汰的基础顺序。
```

#### 代码改动计划

1. `src/components/common/FileList.vue`
   - 监听 `QVirtualScroll` 的虚拟滚动事件。
   - 记录 `from/to/index/direction`。
   - 向父级 emit `visible-range-change`，payload 示例：

```js
{
  from: 12,
  to: 28,
  direction: "increase",
  fileIds: ["..."]
}
```

2. `src/components/common/FileExplorer.vue`
   - 透传 `visible-range-change`。

3. `src/pages/IndexPage.vue`
   - 接收左栏可见范围。
   - 将可见 fileIds 传给 SAM render cache 预热队列。
   - 如果左栏关闭，则清空 visible range 预热提示。
   - 预热入口需要 debounce，避免滚动中频繁触发。

4. `src/services/SamImageRenderCache.js`
   - 新增预热队列：
     - `enqueueSamRenderPreload(contextIds, priority)`
     - `flushSamRenderPreloadIdle()`
     - `cancelSamRenderPreload(contextId)`
   - 预热前检查：
     - context 是否有 SAM session。
     - 是否已命中 render cache。
     - 是否超过大图阈值。
     - 是否超过内存预算。
   - 预热只生成可见候选或启用候选的 rendered cache，不直接写可见 canvas。

5. `ImageMasker.vue`
   - 当前打开图片仍由现有 `renderSamCandidates()` 负责。
   - 非当前图片预热不能访问当前可见 canvas。
   - 若需要生成非当前图片 rendered cache，应使用离屏 canvas 和 session 中的候选数据。

#### 注意事项

- 不要在左栏滚动事件里直接渲染蒙版。
- 不要因为某张图片出现在虚拟列表可见范围内，就永久保留它的 rendered cache。
- 不预热没有 SAM session 的图片。
- 不预热超过大图阈值的图片。
- 不预热未启用候选，除非用户配置关闭懒渲染。

### 优化 B4：减少不必要的 `canvas.toDataURL()`

1. 在 `ImageMasker` 中记录轻量状态：
   - `lastEmittedMaskDataUrl` 或 `lastEmittedMaskSignature`。
   - emit mask 时更新。
   - clear mask 时清空。

2. 调整 `props.mask` watcher
   - 优先比较：
     - `pendingMaskSyncDataUrl`。
     - 上次 emit 的 dataUrl/signature。
     - contextId 是否一致。
   - 只有在无法判断时再调用 `getMaskData()`。

3. 预期效果
   - 切图和父级 mask 回写时减少同步 canvas 序列化。
   - 避免大图切换时因为 `toDataURL()` 阻塞 UI。
   - 在中小规模多图切换中，已访问图片能更快显示蒙版。
   - 在大批量或大图场景中，缓存自动收缩，不长期占用过多内存。

### 暂不执行的优化

- 暂不删除双 `requestAnimationFrame + nextTick`。
  - 它用于等待图片尺寸、canvas 尺寸、toolbar 和 Vue 状态稳定。
  - 直接删除可能重新引入切图时旧 canvas 或旧尺寸参与合成的问题。

- 暂不引入长期持久化的分层蒙版架构。
  - 更完整的架构应拆成手绘源层、SAM 源层、合成快照三层。
  - 本阶段只优化当前架构下的清理和性能瓶颈。

## 回归测试计划

### 静态断言

- 更新 `scripts/p0-regression-assertions.mjs`：
  - 断言 `DEFAULT_MASKING_CONFIG` 包含 SAM 渲染缓存默认配置。
  - 断言 `ConfigManager` 会归一化并校验缓存数量、缓存 MB、大图阈值和布尔开关。
  - 断言全局设置高级图片页暴露“智能选区渲染缓存”配置入口。

- 更新 `scripts/p1-image-regression-assertions.mjs`：
  - 断言模型成功后会同时清理 file.mask 和 SAM image session。
  - 断言失败结果不会清理 mask/session。
  - 断言 session clone 只在缓存策略允许时保留 `renderedMaskMeta`，并继续由 meta 校验失效。
  - 断言渲染缓存按 context LRU 和内存预算淘汰，只删除 rendered cache，不删除原始 SAM candidate。
  - 断言未启用候选在懒渲染开启时不会进入切图主渲染路径。
  - 断言左侧虚拟列表可见范围只进入空闲预热队列，不直接触发可见 canvas 渲染。
  - 断言左栏关闭时不会继续用旧 visible range 预热。
  - 断言 `props.mask` watcher 不再每次都无条件调用 `getMaskData()`。

### 自动验证

执行顺序必须先自动验证，再进入 debug 测试和手动验证。

- `npm run test:regression:p0:assertions`
- `npm run test:regression:p1:image`
- `npm run lint`
- `npm run build`

新增或扩展自动化用例：

1. 配置自动验证
   - 默认配置包含 SAM 渲染缓存字段。
   - 旧配置迁移后自动补齐字段。
   - 非法缓存数量、内存上限、大图阈值会被归一化或校验拒绝。

2. 清理自动验证
   - 成功模型结果清理 `file.mask`。
   - 成功模型结果清理对应 SAM image session。
   - 失败结果不清理 mask/session。
   - 当前 active context 被清理时，不会被 `props.mask` watcher 重新合成回来。

3. 缓存自动验证
   - LRU 超过 context 数量上限会淘汰最久未访问 rendered cache。
   - 超过内存上限会淘汰 rendered cache。
   - 大图超过阈值时不长期写入 rendered cache。
   - 淘汰后原始 `candidate.mask` 仍存在，可重新生成。

4. 懒加载自动验证
   - 切图主路径只渲染启用候选。
   - 未启用候选在 hover/启用/打开候选预览时才生成 rendered cache。
   - 左侧虚拟列表可见范围只进入空闲预热队列，不直接触发可见 canvas 渲染。

### Debug 测试

在正式手动验证前增加一次 debug 测试，用来确认真实运行时不是“看起来正确但内部重复渲染”。

计划新增仅测试环境可用的 debug 观测点：

- `window.__moonshineDebug.samRenderStats`
  - `visibleCanvasCommitCount`
  - `offscreenRenderCount`
  - `cacheHitCount`
  - `cacheMissCount`
  - `evictionCount`
  - `preloadQueueLength`
  - `lastRenderedContextId`
  - `lastRenderReason`

- `window.__moonshineDebug.getSamRenderCacheSnapshot()`
  - 返回当前缓存 context 列表、估算内存、LRU 顺序。

- `window.__moonshineDebug.resetSamRenderStats()`
  - 清空统计，便于单个测试用例断言。

Debug 测试流程：

1. 准备至少 8 张图片，其中 3 张通过 SAM 生成候选。
2. 设置 `samRenderCacheNeighborPreloadCount = 4`。
3. 设置较小 `samRenderCacheMaxContexts`，例如 `4`，便于触发淘汰。
4. 切换到图片 A，重置 debug 计数。
5. 切换到图片 B，再切回图片 A。
6. 断言：
   - 当前图片可见 canvas 仍只发生一次最终提交。
   - 命中缓存时 `cacheHitCount` 增加。
   - 淘汰发生时只删除 rendered cache，不删除原始 SAM session。
   - 左侧虚拟列表滚动后，只增加预热队列，不同步增加可见 canvas 提交。
7. 运行 LaMa 成功后断言：
   - 当前 processed file 的 SAM session 被清除。
   - 该 context 的 render cache 被清除。
   - 切换回来不会重新合成蒙版。

Debug 观测点要求：

- 仅在测试桥或开发模式暴露。
- 不在生产 UI 中显示。
- 不影响正常渲染路径。
- 完成测试后不保留临时代码；若保留，应作为明确的 E2E debug bridge 并受环境保护。

### 手动验证

1. 图片 A 执行 SAM 文本/点选生成蒙版。
2. 运行 LaMa。
3. 成功后确认蒙版消失。
4. 切到图片 B，再切回图片 A，确认蒙版不恢复。
5. 对图片 C 生成 SAM 蒙版但不运行模型，切换图片后确认候选仍能恢复。
6. 批量运行时确认只清理成功处理的图片。
7. 导入多张带 SAM 候选的图片，反复切换最近图片，确认已访问图片恢复更快。
8. 将缓存数量设置为较小值，切换超过上限的图片，确认旧图片 rendered cache 被淘汰但候选源数据仍可重建。
9. 使用大图超过长边阈值，确认该图不长期保留 rendered cache，且切图功能仍正确。
10. 打开左侧图片列表并滚动，确认可见范围内已有 SAM session 的图片只在空闲时预热。
11. 关闭左侧图片列表，确认可见范围预热停止，仅保留当前图片和相邻图片预热。

## 回滚策略

- 若阶段 A 造成用户仍想继续编辑处理后的蒙版，可只回滚 `clearMasksForProcessedFileIds()` 中的 SAM session 删除调用。
- 若阶段 B 导致缓存 stale 或内存压力，可关闭 `samRenderCacheEnabled`，或回滚缓存管理器接入，恢复每次 restore 后重新渲染候选。
- 若懒渲染导致候选预览延迟不可接受，可关闭 `samLazyRenderDisabledCandidates`，恢复更积极的预渲染策略。

## 建议执行顺序

1. 先执行阶段 A，修复模型成功后蒙版不清除的问题。
2. 增加默认配置和全局设置 UI，为缓存策略提供管理入口。
3. 验证无回归后执行阶段 B1，接入动态 LRU 渲染缓存。
4. 执行阶段 B2，开启未启用候选懒渲染。
5. 执行阶段 B3，接入左侧虚拟列表可见范围的空闲预热。
6. 如果切图仍明显卡顿，再执行阶段 B4，减少 `canvas.toDataURL()`。
