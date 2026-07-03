# MAT 模型集成执行方案

更新时间：2026-07-03

## 背景与目标

本方案用于把 MAT（Mask-Aware Transformer）作为与 LaMa 同类型、同作用的图片/视频去除模型接入 Moonshine-Image。

已确认用户本地 MAT 权重位置：

```text
C:\Users\cjh02\Downloads\Places_512_FullData_G.pth
```

目标模型路径统一为：

```text
models/mat/Places_512_FullData_G.pth
```

Hugging Face 主源目标路径统一为：

```text
https://huggingface.co/CuiMuxuan/moonshine-models/resolve/main/mat/Places_512_FullData_G.pth
```

夸克副源继续沿用项目模型统一副源：

```text
https://pan.quark.cn/s/2e51ec70c7b9
```

本方案已从纯方案进入分步落地阶段。当前目标是完成本地 MAT 集成、文档和回归保护；Hugging Face 上传需要网络和可写 token，未完成前不得把一次性上传脚本写入仓库。

## 当前执行状态

更新时间：2026-07-03

- 模型文件已归位到 `models/mat/Places_512_FullData_G.pth`，该目录被 `/models` 忽略，权重不加入 git。
- 已记录模型元数据：`size = 250619359`，`sha256 = 0512e37ebba3986b0355130b2e2c1f95736d0778ac82e91b1212b4b21c231312`。
- 模型清单已新增 `mat`，作为 `requiresMask: true` 的图片/视频处理模型，路径为 `mat/Places_512_FullData_G.pth`，主源为 Hugging Face，副源沿用夸克统一链接。
- MAT license 已按 `CC BY-NC 4.0` 记录，并在模型管理/README 文档侧明确“仅限非商业用途”。
- 后端 MAT 运行时已改为从项目模型目录加载本地文件；`is_downloaded()` 只检查项目目标路径。
- MAT 初版按 CUDA-only 处理；默认模型或运行时切换遇到非 CUDA 时自动回退 LaMa，并提示 `MAT 需要 CUDA，当前已自动切换为 LaMa。`
- 图片处理和视频处理均按 LaMa 同级 mask inpaint 模型复用；视频仍为逐帧处理，不做跨帧时序一致性增强。
- 已补充 P0/P1 回归断言覆盖 MAT manifest、默认模型 CUDA 回退、视频模型白名单、`VideoBatchInpaintRequest`、视频 mask artifact staging 和 SAM 视频预览/最终渲染的 LaMa/MAT 共用扩边语义。
- Hugging Face 上传尚未执行；需要用户提供可写 HF token 并允许网络上传。上传脚本只能作为一次性本地命令或临时文件使用，不进入仓库。

## 已确认需求边界

- MAT 作为图片处理模型接入，与 `lama` 同级。
- MAT 作为视频处理模型接入，与 `lama` 同级。
- 前端不新增 MAT 专用页面、专用按钮或专用设置面板。
- 图片处理复用当前图片页模型选择、蒙版、批量处理、全局 loading 和结果写回流程。
- 视频处理复用当前视频逐帧处理、mask、分段、合成、断点恢复和进度流程。
- MAT 视频集成本轮不做跨帧时序一致性增强，不引入光流、跨帧传播、纹理缓存或视频专用修复模型。
- MAT 可以作为默认启动模型配置项之一。
- MAT 必须在 CUDA 可用时才允许作为默认模型生效。
- 如果配置里默认模型是 MAT，但当前 CUDA 不可用，应自动回退到 LaMa，并提示用户原因。
- 全局 loading 文案偏用户可读进度，例如 `正在使用 MAT 处理图片 3/20`。
- Hugging Face 上传代码不得写入仓库，只允许作为一次性本地脚本或命令参考。

## 许可证与分发约束

MAT 官方 GitHub 仓库包含 LICENSE，用户已核对该许可证为 Creative Commons Attribution-NonCommercial 4.0 International Public License（CC BY-NC 4.0）。

接入时必须按非商业限制处理：

- 模型管理页和 README/文档中明确标注：MAT 仅限非商业用途。
- 分发或镜像下载时保留 MAT 上游来源、许可证名称、许可证链接和署名说明。
- Hugging Face 模型卡或仓库 README 中补充 MAT 的非商业使用限制。
- 如果后续项目存在商业发布或商业服务形态，必须禁用 MAT 自动下载或要求用户自行确认许可。

建议记录来源：

```text
MAT GitHub: https://github.com/fenglinglwb/MAT
MAT LICENSE: https://github.com/fenglinglwb/MAT/blob/main/LICENSE
CC BY-NC 4.0: https://creativecommons.org/licenses/by-nc/4.0/
```

## 当前代码现状

当前仓库已经存在 MAT 相关后端实现基础：

```text
server/moonshine_server/model/mat.py
server/moonshine_server/model/__init__.py
```

其中 `MAT` 类已经继承现有 `InpaintModel` 协议，具备 `init_model`、`download`、`is_downloaded`、`forward` 等方法。

`mat.py` 已改为使用本项目模型目录中的本地权重，正式安装状态不再依赖旧 Sanster URL/cache。`MAT.download()` 仍作为兼容类方法保留，但下载源已指向本项目 Hugging Face 主源，并以 sha256 校验后原子替换到项目模型目录。

当前需要注意的硬编码边界：

- `src/stores/appState.js` 共享模型白名单已包含 `["lama", "mat", "slbr"]`。
- `src/pages/VideoPage.vue` 已显式区分 `VIDEO_PROCESSING_MODEL_IDS = ["lama", "mat", "slbr"]` 与 `MASK_INPAINT_MODEL_IDS = ["lama", "mat"]`。
- `server/moonshine_server/schema.py` 的 `VideoBatchInpaintRequest` 已允许 `lama | mat | slbr`，并要求 `lama/mat` 提供 `mask_path`。
- `server/moonshine_server/api.py` 的视频批处理保留 `slbr` 无 mask 分支，`lama/mat` 走共享 `ModelManager(image, mask, inpaint_req)` 分支。
- `server/moonshine_server/api.py` 的文件夹批处理已在当前模型为 `lama/mat` 时使用对应模型，否则回退 `lama`。

## 阶段 0：执行前保护

目标：避免影响正在进行的 SAM 相关改动。

执行前必须先检查：

```powershell
git status --short --untracked-files=all
git diff --stat
```

约束：

- 不回退用户或其他 agent 的未提交改动。
- MAT 集成只改 MAT 相关文件和必要的共享模型选择逻辑。
- 如发现 SAM 文件同时被其他 agent 修改，先暂停对应文件改动并重新确认最新 diff。

### 持久化与提交注意

当前仓库 `.gitignore` 显式忽略了 `docs/` 目录，历史已跟踪的 docs 文件仍会显示修改，但新建 docs 文件默认不会出现在普通 `git status` 中。

如果本方案需要随代码提交，必须显式强制加入：

```powershell
git add -f docs/mat-model-integration-plan.md
```

如项目后续决定让 `docs/` 下方案文件默认可提交，应单独调整 `.gitignore`，不要在 MAT 集成提交中混入无关 ignore 策略重构。

## 阶段 1：模型文件归位

目标：把用户已下载的 MAT 权重放入项目统一模型目录。

目标路径：

```text
C:\code\Moonshine-Image\models\mat\Places_512_FullData_G.pth
```

后续执行参考：

```powershell
$src = "C:\Users\cjh02\Downloads\Places_512_FullData_G.pth"
$dstDir = "C:\code\Moonshine-Image\models\mat"
$dst = Join-Path $dstDir "Places_512_FullData_G.pth"

if (-not (Test-Path -LiteralPath $src)) {
  throw "MAT source file not found: $src"
}

New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
Move-Item -LiteralPath $src -Destination $dst
Get-FileHash -LiteralPath $dst -Algorithm SHA256
(Get-Item -LiteralPath $dst).Length
```

已完成记录：

- `size`
- `sha256`
- 本地安装路径
- 是否可被后端 manifest 识别

当前记录值：

```text
size: 250619359
sha256: 0512e37ebba3986b0355130b2e2c1f95736d0778ac82e91b1212b4b21c231312
path: models/mat/Places_512_FullData_G.pth
```

## 阶段 2：模型清单接入

目标：让模型管理页和下载任务识别 MAT。

修改文件：

```text
server/moonshine_server/moonshine/model_registry.py
```

新增 `mat` manifest 项，建议字段：

```json
{
  "id": "mat",
  "label": "MAT",
  "description": "Mask-Aware Transformer 图片修复模型，适合较大区域的蒙版修复，仅限非商业用途。",
  "type": "image",
  "category": "image",
  "family": "mat",
  "modelVersion": "MAT",
  "path": "mat/Places_512_FullData_G.pth",
  "requiresMask": true,
  "recommendedDevice": "cuda",
  "cpuSupported": false,
  "minimumVram": 6144,
  "recommendedVram": 8192,
  "runCapabilities": {
    "scopes": ["selected", "batch", "folder", "video"],
    "requiresMask": true
  },
  "license": {
    "name": "CC BY-NC 4.0",
    "url": "https://creativecommons.org/licenses/by-nc/4.0/",
    "requiresUserConfirmation": true,
    "redistribution": "仅限非商业用途；分发时必须署名并保留许可证说明。"
  },
  "sourceLinks": [
    {
      "type": "huggingface",
      "label": "Hugging Face",
      "url": "https://huggingface.co/CuiMuxuan/moonshine-models/resolve/main/mat/Places_512_FullData_G.pth"
    }
  ],
  "manualSources": [
    {
      "type": "quark",
      "label": "夸克网盘",
      "url": "https://pan.quark.cn/s/2e51ec70c7b9"
    }
  ]
}
```

已用真实 `size` 和 `sha256` 落地，并保持与现有 manifest 字段风格一致。

验收：

- 模型清单中出现 `mat`。
- `mat` 被归类为图片处理模型。
- `mat.requiresMask === true`。
- CUDA 不可用时模型管理页显示不可作为默认模型或不可运行原因。
- license 字段明确非商业限制。

## 阶段 3：后端 MAT 模型路径与加载改造

目标：让 `MAT` 使用项目模型目录，而不是旧 cache URL。

修改文件：

```text
server/moonshine_server/model/mat.py
server/moonshine_server/model/utils.py
server/moonshine_server/model_manager.py
```

建议改造：

1. 在 `mat.py` 中定义项目相对路径：

   ```python
   MAT_MODEL_FILE = "mat/Places_512_FullData_G.pth"
   ```

2. 增加 `_resolve_mat_model_path()`：

   - 优先读取当前模型目录下的 `models/mat/Places_512_FullData_G.pth`。
   - 如项目已有发布版用户数据模型目录解析函数，应复用该函数。
   - 不再依赖旧 cache URL 判断已下载。

3. `MAT.is_downloaded()`：

   - 检查项目模型目录目标文件是否存在。
   - 不再把旧 Sanster cache 作为正式安装状态。

4. `MAT.download()`：

   - 优先交由 `model_registry.py` 下载任务处理。
   - 如果仍保留类方法，必须下载到 `.part`，sha256 校验成功后原子 rename。
   - 不把 Hugging Face 上传逻辑放入仓库。

5. `MAT.init_model()`：

   - 启动前判断 CUDA。
   - CUDA 不可用时抛出明确异常，禁止加载 MAT。
   - 使用 `_resolve_mat_model_path()` 返回的本地路径加载。
   - 模型实例只加载一次，批量/视频过程中复用。

6. `ModelManager.switch("mat")`：

   - CUDA 不可用时失败信息应可被前端分类为用户可读提示。
   - 切换失败应保持原模型不变。

建议错误文案：

```text
MAT 需要 CUDA 才能运行，当前已保留/切换为 LaMa。
```

### 旧 helper/MD5 迁移细节

当前 `MAT` 使用 `moonshine_server.helper.load_model(G, MAT_MODEL_URL, device, MAT_MODEL_MD5)`。该 helper 的行为是：

- 如果 `url_or_path` 是本地存在路径，则直接 `torch.load`。
- 如果不是本地路径，则调用旧 `download_model()` 下载到 torch hub cache。
- 校验方式是 MD5，失败时可能删除 cache 文件并 `exit(-1)`。

MAT 集成到本项目模型清单后，不应继续依赖旧 URL cache 下载路径。推荐做法：

- 下载和 sha256 校验交给 `model_registry.py` 的模型下载任务。
- `MAT.init_model()` 只接收 `_resolve_mat_model_path()` 得到的本地文件路径。
- 调用旧 `load_model()` 时传入本地路径，并避免触发旧 URL 下载分支。
- 如果需要保留 MD5，仅作为额外兼容校验，不作为模型管理主校验；主校验以 manifest 中的 `sha256` 为准。
- 不允许 `download_model()` 的 `exit(-1)` 影响后端服务进程，后续如改动 helper，应改为抛出可被 API 捕获的异常。

### 文件编码注意

当前 `server/moonshine_server/model/mat.py` 包含至少 1 个非 UTF-8 字节。后续编辑该文件前需要确认编码和换行策略：

- 优先使用现有编辑工具进行局部 patch，避免整文件按 UTF-8 重写。
- 若必须格式化或重写，应先确认非 UTF-8 字节来源，并在变更说明中记录。
- 修改后必须使用正确 Python 3.12 环境执行 `py_compile`。

当前验收状态：

- `ModelManager(name="mat")` 在 CUDA 可用且模型存在时按本地路径加载；真实推理仍需在 CUDA 环境补跑。
- 模型不存在时 `_resolve_mat_model_path()` 提示安装 MAT。
- CUDA 不可用时 `ModelManager` 和 `MAT.init_model()` 均禁止加载 MAT。
- 批量图片处理和视频逐帧处理复用当前 `ModelManager` 实例，不为每张图/每帧重复构造 MAT。

## 阶段 4：默认模型与 CUDA 回退

目标：MAT 可以被配置为默认模型，但只有 CUDA 可用时才生效。

涉及文件：

```text
src/stores/appState.js
src/stores/modelRegistry.js
src/services/ModelRegistryService.js
src/components/global/GlobalSettings.vue
src/components/global/ModelManagementPanel.vue
src/pages/IndexPage.vue
src/pages/VideoPage.vue
server/moonshine_server/const.py
server/moonshine_server/api.py
server/moonshine_server/model_manager.py
```

规则：

- 默认配置允许保存 `mat`。
- 如果 CUDA 可用且 MAT 已安装，启动时使用 `mat`。
- 如果 CUDA 不可用但默认配置是 `mat`，启动时自动回退 `lama`。
- 回退时给出一次用户可读提示。
- 如果 `lama` 也不可用，后端按现有无模型启动兜底逻辑处理，但提示应明确。

前端提示建议：

```text
MAT 需要 CUDA，当前已自动切换为 LaMa。
```

实现建议：

- 不再维护散落的 `["lama", "slbr"]` 白名单。
- 从 model registry 派生可用于图片/视频处理的模型列表。
- 如果短期不能完全派生，至少统一常量：

  ```javascript
  const IMAGE_PROCESSING_MODEL_IDS = ["lama", "mat", "slbr"];
  const MASK_INPAINT_MODEL_IDS = ["lama", "mat"];
  ```

验收：

- CUDA 可用：MAT 可以成为默认模型。
- CUDA 不可用：默认 MAT 自动回退 LaMa。
- 回退不导致应用启动失败。
- 图片页和视频页当前模型状态一致。

## 阶段 5：图片处理复用

目标：MAT 复用当前图片处理入口。

不新增：

- MAT 专用页面。
- MAT 专用工具栏按钮。
- MAT 专用处理面板。

需要确认/修改：

- 图片模型下拉包含 `mat`。
- `mat.requiresMask === true`，因此继续使用现有蒙版工具。
- 当前 `/api/v1/model` 切换模型后，`/api/v1/batch_inpaint` 通过 `self.model_manager` 使用当前模型。
- 如批量请求未来支持显式 `model_id`，应兼容当前模型切换方式，避免前端状态和后端当前模型不一致。
- 文件夹批处理当前存在 `model="lama"` 硬编码，应改为当前选中模型或请求显式模型。

批量 loading 建议：

- 当前一次性批处理接口无法实时返回每张图片进度。
- 低侵入方案：前端把待处理图片切成小批次提交。
- 每批请求前更新全局 loading 文案。
- 每批返回后累加已完成数量。

推荐文案：

```text
正在使用 MAT 处理图片 1/20
正在使用 MAT 处理图片 4/20
正在使用 MAT 保存结果 20/20
```

二期优化：

- 新增后端任务式批处理 API。
- 前端轮询任务状态。
- 后端直接报告当前 item、成功数、失败数、剩余数。

## 阶段 6：视频处理复用

目标：MAT 复用当前 LaMa 视频逐帧处理链路。

后端修改：

```text
server/moonshine_server/schema.py
server/moonshine_server/api.py
```

`VideoBatchInpaintRequest` 允许：

```text
lama
mat
slbr
```

处理分支：

- `slbr`：继续使用现有无 mask SLBR runner 分支。
- `lama` / `mat`：走同一个 mask inpaint 分支，使用 `ModelManager` 或等价共享模型实例。

前端修改：

```text
src/pages/VideoPage.vue
src/components/video/ResourceManage.vue
src/components/video/VideoMaskEditor.vue
src/components/video/VideoPreviewOverlay.vue
```

建议：

- 把 `isLamaModel` 改为 `isMaskInpaintModel` 或 `currentModelRequiresMask`。
- 把 `requestedModelId === "slbr"` 分支保留，其余 requiresMask 模型统一处理。
- 视频模型选项从 registry 派生，不写死 `lama/slbr`。

推荐 loading 文案：

```text
正在使用 MAT 生成帧与蒙版
正在使用 MAT 处理第 3/15 批
正在使用 MAT 处理视频帧 120/1800
正在合成处理后视频
```

验收：

- MAT 视频处理必须要求 mask。
- SLBR 视频处理仍不要求 mask。
- MAT 不影响已有 LaMa/SLBR 视频流程。
- MAT 视频处理中断后仍复用现有断点/分段恢复机制。

## 阶段 7：Hugging Face 上传

目标：把 MAT 权重上传到 `CuiMuxuan/moonshine-models`，作为模型不存在时的下载主源。

约束：

- 上传脚本不写入仓库。
- 上传前必须确认本地文件路径、文件大小、sha256、许可证说明。
- 上传后更新 model registry 的 `sourceLinks`、`size`、`sha256`。

一次性本地脚本参考：

```powershell
$env:HF_TOKEN = "hf_xxx"
$env:HF_XET_HIGH_PERFORMANCE = "1"

@'
from pathlib import Path
from huggingface_hub import HfApi

path = Path(r"C:\code\Moonshine-Image\models\mat\Places_512_FullData_G.pth")
if not path.is_file():
    raise FileNotFoundError(path)

api = HfApi()
api.upload_file(
    path_or_fileobj=str(path),
    path_in_repo="mat/Places_512_FullData_G.pth",
    repo_id="CuiMuxuan/moonshine-models",
    repo_type="model",
    commit_message="Add MAT Places 512 inpainting model",
)
'@ | C:\Users\cjh02\anaconda3\envs\moonshine-runtime-312\python.exe -
```

执行前确认：

- `huggingface_hub` 已安装在执行环境。
- `HF_TOKEN` 有目标仓库写权限。
- 本地网络允许上传大文件。
- Hugging Face 仓库 README 或模型卡已标注 MAT 非商业许可证约束。

上传后验证：

```powershell
Invoke-WebRequest `
  -Uri "https://huggingface.co/CuiMuxuan/moonshine-models/resolve/main/mat/Places_512_FullData_G.pth" `
  -Method Head
```

## 阶段 8：README 与用户文档

目标：让用户理解 MAT 的能力和限制。

建议更新：

```text
README.md
docs/moonshine-distribution-update-plan.md
```

README 模型说明中补充：

- MAT 是与 LaMa 同类的蒙版图片/视频修复模型。
- MAT 需要 CUDA。
- MAT 仅限非商业用途。
- 无 CUDA 时不会作为默认模型生效，会回退 LaMa。

模型管理文案中补充：

```text
MAT 仅限非商业用途，且需要 CUDA 才能运行。
```

## 阶段 8.5：回归断言补充

目标：让 MAT 接入后不会被后续 SAM 或模型管理改动误删。

建议同步更新：

```text
scripts/p0-regression-assertions.mjs
scripts/p1-image-regression-assertions.mjs
scripts/p1-video-regression-assertions.mjs
```

断言建议：

- `model_registry.py` 中存在 `id: "mat"`。
- `mat` 的目标路径为 `mat/Places_512_FullData_G.pth`。
- `mat` 的 `requiresMask` 为 true。
- `mat` 的下载主源包含 `CuiMuxuan/moonshine-models`。
- `mat` 的副源包含统一夸克链接。
- `mat` 的 license 包含 `CC BY-NC 4.0` 和非商业限制。
- 图片模型选项允许 `mat` 与 `lama` 同级出现。
- 视频模型选项允许 `mat` 与 `lama` 同级出现。
- `VideoBatchInpaintRequest` 允许 `mat`。
- CUDA 不可用时默认 MAT 回退 LaMa 的逻辑存在。

## 阶段 9：回归测试与真实验证

基础验证：

```powershell
C:\Users\cjh02\anaconda3\envs\moonshine-runtime-312\python.exe -m py_compile `
  server\moonshine_server\schema.py `
  server\moonshine_server\api.py `
  server\moonshine_server\model\mat.py `
  server\moonshine_server\moonshine\model_registry.py

npm run test:regression:p0:assertions
npm run test:regression:p1:image
npm run test:regression:p1:video
git diff --check
```

真实模型验证：

- CUDA 可用且 MAT 模型存在时，MAT 单图处理成功。
- CUDA 可用且 MAT 模型存在时，MAT 图片批量处理成功。
- CUDA 可用且 MAT 模型存在时，MAT 小视频片段处理成功。
- CUDA 不可用时，默认 MAT 自动回退 LaMa。
- MAT 模型缺失时，模型管理页可下载或提示手动安装。
- 许可证非商业限制在模型管理页、README 或相关文档可见。

## 风险与处理

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| MAT 仅限非商业用途 | 影响项目分发与用户使用边界 | 模型管理和文档明确标注，必要时要求用户确认 |
| MAT CUDA 依赖强 | 无 CUDA 用户无法运行 | 默认模型自动回退 LaMa，模型选择禁用或提示原因 |
| MAT pad 到 512 且显存占用较高 | 批量/视频处理可能 OOM | 初版限制批大小，失败时给用户可读显存提示 |
| 前端存在 `lama/slbr` 硬编码 | MAT 无法进入视频或共享模型流程 | 抽出模型能力常量或从 registry 派生 |
| 当前图片批量是一次请求 | loading 不能实时逐张更新 | 初版前端小批次提交，二期任务式 API |
| 旧 MAT cache URL 逻辑残留 | 下载源和模型管理不一致 | 改为项目模型目录和 manifest 下载体系 |

## 推荐执行顺序

1. 移动模型到 `models/mat/Places_512_FullData_G.pth`，记录 size/sha256。
2. 上传 MAT 到 Hugging Face，更新模型卡许可证说明。
3. 在 `model_registry.py` 增加 MAT manifest。
4. 改造 `mat.py` 为项目模型目录加载。
5. 增加 CUDA 不可用时的 MAT 默认模型回退。
6. 打通图片单张与批量处理。
7. 打通视频逐帧处理。
8. 补 README 和分发文档。
9. 执行回归与真实模型验证。

## 暂缓事项

- 不接入 ZITS。
- 不做跨帧时序一致性增强。
- 不新增 MAT 专用 UI。
- 不把 Hugging Face 上传脚本提交到仓库。
- 不把 MAT 权重提交到 git。
