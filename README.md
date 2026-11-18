# dsh-tool-ecnu-image

把华东师大 **ChatECNU** 平台的文生图模型 `ecnu-image`（底层 qwen-image-2.1）接成 DeepSeek Harness 的两个工具：

| 工具 | 作用 | 端点 |
|---|---|---|
| `image_generate` | 文生图 | `POST {baseURL}/images/generations`（JSON） |
| `image_edit` | 基于已有图片编辑/重绘 | `POST {baseURL}/images/edits`（multipart） |

官方文档：<https://developer.ecnu.edu.cn/vitepress/llm/api/imagegenerate.html> ·
<https://developer.ecnu.edu.cn/vitepress/llm/api/imageedit.html>

> 接手部署、维护、排障或继续开发的智能体，先读
> [AGENT_HANDOFF.md](./AGENT_HANDOFF.md)：里面按“工具跑在哪里、安装/升级/卸载、配置、
> 错误对照、测试、Remote 场景、安全、发布、已知限制”整理。

## 为什么不放进 provider（模型）组

DSH 的 `@deepseek-ai/dsh-llm-pi-ai` **只派发对话请求**，`dsh-llm` 的模型元数据也只有
`inputModalities`（text/image）——整套 seam 里没有「图像输出」的位置。把 `ecnu-image`
写进 `chatecnu.models` 只会让模型选择器里多出一个选中就报错的条目，所以这里改用工具形态接入。

## 安装

### 本机（开发中，link 方式）

源码目录直接 junction 进 profile，改完保存即热加载：

```powershell
$target = "$env:USERPROFILE\.dsh\local-plugins\dsh-tool-ecnu-image"
$link   = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-tool-ecnu-image"
New-Item -ItemType Junction -Path $link -Target $target
```

profile `package.json` 的 `dependencies` 加一行 `"dsh-tool-ecnu-image": "link:../../local-plugins/dsh-tool-ecnu-image"`，
再在 profile `cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: tool-ecnu-image
      name: dsh-tool-ecnu-image
      config:
        apiKeyEnv: ECNU_API_KEY
        baseURL: https://chat.ecnu.edu.cn/open/api/v1
        model: ecnu-image
        outputDir: ecnu-image
        timeoutMs: 300000
```

> 本包也自带 `cordis.patch.yml`（`dsh.bundle.patch`），所以以**插件包**形式安装时，
> 这一行 loader 会自动加上，无需手写。

### 其它机器

本网络实测：`api.github.com` / `github.com` 的 HTTPS 需走 IPv4，`ssh github.com` 正常。

- 插件页填 `github:Ternity/dsh-tool-ecnu-image`；
- 或压缩包规格（管理器对压缩包不做 GitHub 预检）：
  `https://codeload.github.com/Ternity/dsh-tool-ecnu-image/tar.gz/refs/tags/v0.1.0`；
- 有 SSH key 则 `git+ssh://git@github.com/Ternity/dsh-tool-ecnu-image.git`。

凭据只需一条：`~/.dsh/.credentials.yaml` 的 `refs.ECNU_API_KEY`（与 `chatecnu` 供应商共用）。

## 配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `apiKeyEnv` | `ECNU_API_KEY` | 凭据引用名（与 `llm-pi-ai` 的 `apiKeyEnv` 同一套） |
| `baseURL` | `https://chat.ecnu.edu.cn/open/api/v1` | OpenAI 兼容根地址 |
| `model` | `ecnu-image` | 目前学校只提供这一个图像模型 |
| `generateToolName` / `editToolName` | `image_generate` / `image_edit` | 暴露给模型的工具名 |
| `defaultSize` | `1024x1024` | 生成尺寸默认值 |
| `sizes` | `512x512`、`768x768`、`720x1280`、`1280x720`、`1024x1024` | 生成接口只接受这几个 |
| `outputDir` | `ecnu-image` | 相对**当前 Session 工作目录**的落盘子目录 |
| `timeoutMs` | `300000` | 单次请求超时（生成通常 20~60 s） |

## 行为与限制

- 请求 `response_format: b64_json` 并直接把图片写到磁盘，返回文件绝对路径（不依赖 24 小时有效的 OSS URL；
  返回里也附 `url` 备用）。
- 默认命名 `ecnu-image-<yyyyMMdd-HHmmss>-<6hex>.png`；`output` 参数可指定文件路径或目录。
- prompt 上限 1024 字符；超了本地直接报错（不发请求）。
- **审核拦截是 HTTP 200 + `err_message`**（不是错误码），插件会转成可读错误抛出；
  正常出图带「图片由AI生成」水印。
- 错误模型名返回 **401** `{"detail":"获取第三方元数据失败"}`，不是 404。
- 编辑接口忽略 `size`，输出尺寸由模型决定（实测 512 输入 → 1056x1056 输出）。
- 生成的图不会自动进对话上下文；需要看时用 `read_image` 打开返回的路径。

## 开发

```bash
node tools/smoke.mjs        # 离线契约测试：10 条，不需要 DSH / 网络 / API Key
node tools/install-hooks.mjs  # 装 git 钩子：每次 commit 后自动 push 到 origin
```

`tools/smoke.mjs` 的做法：把 `lib/index.js` 里两个 `@deepseek-ai/*` import 换成桩，
用临时文件动态 import 真实逻辑，再用本地 HTTP 服务器冒充 ChatECNU 网关，覆盖生成 / 默认路径 /
审核拦截 / HTTP 500 / 非法 size / 超长 prompt / 缺凭据 / multipart 编辑八类路径。
（插件 import 的 `@deepseek-ai/schemastery`、`dsh-tools` 在裸 `node` 进程里解析不到——
那是宿主加载期的解析钩子做的，所以测试必须用桩。）

## 发布

仓库：<https://github.com/Ternity/dsh-tool-ecnu-image>（MIT）。`.git/hooks/post-commit`
会在每次提交后自动 `git push`（失败不阻断提交）；钩子不随仓库分发，新克隆跑一次
`node tools/install-hooks.mjs`。CI `.github/workflows/verify.yml` 跑离线测试 + 清单校验 +
密钥泄漏扫描。

## 卸载

删 `cordis.patch.yml` 里那条 `insert`（热卸载）→ 删 profile `package.json` 的依赖行 → 删 junction。
