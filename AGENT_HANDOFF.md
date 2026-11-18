# AGENT_HANDOFF — dsh-tool-ecnu-image

> 读者：接手部署、维护、排障或继续开发的智能体/维护者。
> 先读 [README.md](./README.md) 了解用户视角；本文补充“接手后遇到各种情况该看哪里、先做什么”。

## 0. 当前状态

| 项 | 值 |
|---|---|
| 版本 | `0.1.0` |
| Git 标签 | `v0.1.0` |
| 当前 HEAD | `bc2cf36`（`main` = `origin/main`） |
| 插件类型 | **DSH Host 工具插件**，不是 LLM provider，不是客户端 UI 插件 |
| 暴露工具 | `image_generate`、`image_edit` |
| 上游服务 | 华东师大 ChatECNU `ecnu-image`（底层 qwen-image-2.1） |
| 已验证 | 离线契约测试 + 真实网关端到端（生成、编辑）均已通过 |
| CI | `.github/workflows/verify.yml`：离线 smoke + manifest/secret 检查 |

**重要边界：** CI 不访问真实 ChatECNU，也不调用真实 API Key；它只能证明请求格式和错误处理契约。
真实端点的行为变化必须做一次 live smoke（见 §7）。

## 1. 东西跑在哪里

- 这是 **Host 插件**：装在哪台 DSH Host 的 profile 里，哪台 Host 的会话就能看到这两个工具。
- 没有客户端 bundle，不参与浏览器 `web boot`；插件本身不会导致 Web 启动失败。
  （但 profile 的 `cordis.patch.yml` 如果被改坏，仍可能让 DSH 启动失败。）
- **通过 `ds-harness-remote` 连接远程工作区时**：工具由**远程 Host**执行。
  必须把插件装到远程 Host 的 profile；只装本地不会让远程工作区出现这两个工具。
- 假设运行在 DSH 0.2.x + Node 20+ 的 Host 中；插件使用 `@deepseek-ai/dsh-tools` 的
  `defineTool` 和 `@deepseek-ai/schemastery` 的 Config，不保证旧版 DSH 可用。

## 2. 文件地图

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 全部运行时逻辑：Config、工具注册、HTTP、落盘、错误处理 |
| `cordis.patch.yml` | bundle 默认安装行；只写 `ECNU_API_KEY` 引用名 |
| `package.json` | `dsh.bundle.patch` 指向 `cordis.patch.yml` |
| `tools/smoke.mjs` | 离线契约测试（桩替换 Host import + 本地假网关） |
| `tools/check-manifest.mjs` | manifest/入口/密钥泄漏检查 |
| `tools/install-hooks.mjs` | 安装 post-commit 自动 push 钩子 |
| `.github/workflows/verify.yml` | CI：Node 20，跑两个 `tools/*.mjs` |
| `README.md` | 用户安装/配置/限制 |
| `AGENT_HANDOFF.md` | 本文件 |

## 3. 安装、升级、卸载

### 本机 link 安装

```powershell
$target = "$env:USERPROFILE\.dsh\local-plugins\dsh-tool-ecnu-image"
$link   = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-tool-ecnu-image"
New-Item -ItemType Junction -Path $link -Target $target
```

profile `package.json` 的 `dependencies` 加：

```json
"dsh-tool-ecnu-image": "link:../../local-plugins/dsh-tool-ecnu-image"
```

profile 的 `cordis.patch.yml` 加一条 loader 行：

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

以**插件包**方式安装时，包自带 `cordis.patch.yml`，通常不需要再手写此行。

### 其它机器

- 插件页：`github:Ternity/dsh-tool-ecnu-image`
- 压缩包（管理器不做 GitHub 预检）：
  `https://codeload.github.com/Ternity/dsh-tool-ecnu-image/tar.gz/refs/tags/v0.1.0`
- 有 SSH key：`git+ssh://git@github.com/Ternity/dsh-tool-ecnu-image.git`

本网络的 GitHub HTTPS 需要 IPv4；`ssh github.com` 正常。

### 升级

改代码 → 跑 §7 的两组测试 → 需要时更新 `package.json` 版本并打 tag → 提交
（post-commit 钩子会 push；见 §10）。无编译产物；`lib/index.js` 直接运行。

### 卸载

删除 profile`cordis.patch.yml` 的 `tool-ecnu-image` insert → 删除 profile
`package.json` 的依赖行 → 删除 junction → 按需重启/刷新 DSH。

## 4. 配置项

完整默认值见 `lib/index.js` 的 `Config`：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `apiKeyEnv` | `ECNU_API_KEY` | 凭据引用名；不写密钥值 |
| `baseURL` | `https://chat.ecnu.edu.cn/open/api/v1` | 不要重复写 `/images/...` |
| `model` | `ecnu-image` | 目前学校只提供这个图像模型 |
| `generateToolName`/`editToolName` | `image_generate`/`image_edit` | 改名会改变模型看到的工具名 |
| `defaultSize` | `1024x1024` | 仅生成使用 |
| `sizes` | 512/768/720x1280/1280x720/1024 | 生成接口白名单 |
| `outputDir` | `ecnu-image` | 相对**当前 Session 工作目录** |
| `timeoutMs` | `300000` | 上游请求/下载的超时 |

凭据解析顺序：`ctx.get('credentials').resolve(apiKeyEnv)` → 环境变量 `apiKeyEnv` → 报错。
**不要**把密钥写进 `cordis.patch.yml`、README 或 git。

## 5. 运行时行为（需要知道的细节）

- 生成：`POST {baseURL}/images/generations`，JSON：
  `{model, prompt, size, response_format: 'b64_json'}`。
- 编辑：`POST {baseURL}/images/edits`，multipart：
  `model`、`prompt`、`response_format`、`image`（带文件名/MIME）。
- 插件优先使用返回的 `b64_json` 落盘；只有没 b64 时才下载 `url`。
- 落盘文件固定用 `.png` 后缀；`file` 是绝对路径；宽高从 PNG 头读取（不信任接口尺寸字段）。
- `output` 省略时写到 `Session cwd/outputDir/ecnu-image-<时间戳>-<6hex>.png`。
- `output` 以目录结尾或已存在目录时自动生成文件名；否则视为文件路径。
- **已存在的文件会被 `writeFile` 覆盖**；没有覆盖保护，也不做路径沙箱。
- `outputDir` 为相对路径时相对 Session 工作目录；绝对路径按绝对路径使用。
- prompt 上限 1024 字符（本地检查，超长不发请求）。
- 生成 size 必须在 `sizes` 白名单；编辑接口**不接受/忽略 size**，输出尺寸由模型决定。
- 两个工具都标记 `isConcurrencySafe`；没有内置重试、退避或批量接口。
- 图片不会自动进入对话上下文；需要时用 `read_image` 打开返回路径。

## 6. 错误/异常对照

| 现象 | 含义/处理 |
|---|---|
| `缺少凭据 ECNU_API_KEY` | credentials 未配置且环境无变量；配置 `~/.dsh/.credentials.yaml` 的 refs 或环境变量 |
| `HTTP 401 {"detail":"获取第三方元数据失败"}` | 常见于模型名错误/未授权；核对 `model` 与凭据 |
| `HTTP 4xx/5xx` | 上游拒绝或故障；错误文本含状态码和响应前缀；不要把 smoke 结果当真实可用性 |
| `ECNU 图像接口拒绝：...` | **HTTP 200 但 `err_message` 非空**，通常是内容审核；没有图片落盘 |
| `返回非 JSON` | 网关/代理返回 HTML/纯文本；检查 baseURL、网络/代理 |
| `未返回 data[0]` | 上游响应结构变化；先确认不是审核/错误响应 |
| `既没有 b64_json 也没有 url` | 响应结构变化或空结果 |
| `下载生成结果失败 HTTP ...` | b64 缺失且返回的 URL 下载失败；检查 URL 有效期/网络 |
| `读取待编辑图片失败` | `image` 路径错/文件不可读；相对路径以 Session cwd 解析 |
| `不支持的 size` | 生成参数不在白名单；使用 `sizes` 列出的值 |
| `prompt 不能超过 1024 字符` | 本地拒绝；缩短提示词，不要靠重试解决 |
| 输出文件被覆盖 | 传了已存在的 `output` 文件；先确认路径或改用目录 |
| 编辑输出尺寸与输入不同 | 编辑接口忽略 `size`，输出由模型决定；不要断言等于输入尺寸 |

## 7. 测试与验收

### 离线测试（每次改动必须跑）

```bash
node tools/smoke.mjs
node tools/check-manifest.mjs
```

- 不需要 DSH、网络或真实 Key。
- `smoke.mjs` 覆盖：工具注册、生成、默认路径、审核 200、HTTP 500、非法 size、
  prompt 超长、缺凭据、multipart 编辑等。
- 它通过桩替换 `@deepseek-ai/*` import，并用本地 HTTP 服务器冒充网关；**不能验证真实
  网关行为**。

### CI

`.github/workflows/verify.yml` 在 Ubuntu + Node 20 跑上述两个脚本。不要在多行
YAML `run: |` 里内联大段脚本；逻辑放 `tools/*.mjs`。

### 真实环境 live smoke（发布或改动 API 后）

1. 确认当前 DSH Host 的 `tool-ecnu-image` loader 行激活；
2. 在会话里调用 `image_generate`（小尺寸、短 prompt），确认返回绝对路径、文件可读；
3. 调用 `image_edit`，确认原图未改、新文件存在；
4. 故意传错模型/缺凭据，确认错误可读（不要把真实 Key 打印出来）；
5. 记录日期、Host、DSH 版本和返回尺寸；不要凭离线测试宣称真实端点可用。

## 8. 运行中的 DSH 排障

- 工具不可见：检查 profile `package.json` 依赖、junction、`cordis.patch.yml` 的
  `tool-ecnu-image` 行；改 patch 保存后 HMR 应重载，仍不行再重启 DSH。
- 工具存在但调用失败：按 §6 的错误文本判断；先查凭据和 baseURL，再看是否审核/模型名。
- 需要看 Host 当前工具：`ctx.tools.schemas()`（Host Inspector）；不要只看 README。
- **Remote 工作区**：工具在远程 Host 上执行；在远程 Host 的 profile 安装，不要只装本地。
- 这个插件没有客户端 bundle，通常不参与 `web boot`；若 DSH 启动失败，先查
  `cordis.patch.yml` 语法/其他客户端插件，不要先归因于本插件。
- 可用 `~/.dsh/tools/asar-tool.mjs` 查 DSH 内置实现，但不要依赖未公开 API。

## 9. 安全与隐私

- prompt 和待编辑图片会发送到 `chat.ecnu.edu.cn`，可能包含私有内容；不要在敏感图上随意编辑。
- API Key 只通过 credentials seam/环境变量；不提交、不打印、不写进文档。
- `output` 可写任意 Host 可写路径，且会覆盖已存在文件；接手的 agent 不应把用户提供的
  不可信路径直接当输出路径。
- 生成图带“图片由AI生成”水印（服务端行为）。
- 不自动清理生成文件；不要把大图/批量图提交到仓库。
- CI 的 secret 扫描只覆盖 `lib/index.js`、`cordis.patch.yml`、`README.md`、`package.json`；
  新增发布文件时应扩展检查。

## 10. 发布/维护

- 当前仓库：`git@github.com:Ternity/dsh-tool-ecnu-image.git`；tag `v0.1.0`。
- 包源目录是 git 仓库；`dist` 不存在，无构建产物。
- `.git/hooks/post-commit` 会自动 push；新克隆运行
  `node tools/install-hooks.mjs` 安装。Git Credential Manager 在无控制台后台进程里会挂死，
  推送优先用 SSH。
- GitHub HTTPS 需 IPv4；`codeload.github.com` 可用。
- 版本升级：改 `package.json` `version` → 跑测试 → commit → 打新 tag → push；
  CI 成功后再宣布发布。
- 不要把大图、密钥、POTCAR 等敏感/二进制文件提交到仓库。

## 11. 已知限制 / 待办

- CI 没有真实网关测试，也没有真实 Key。
- 没有请求重试/退避；网关 429/5xx 只会直接报错。
- 没有输出路径沙箱/覆盖保护；`output` 是 Host 可写路径。
- 编辑接口忽略 `size`；输出尺寸不可精确控制。
- 不自动把生成图塞进对话历史；需要 `read_image`。
- 单次只处理 `data[0]`；没有批量生成/多图编辑。
- 输入图片扩展名未知时按 `application/octet-stream` 上传，服务端可能拒绝。
- 真实 API 的结构/审核策略可能变化；以 live smoke 为准，不要仅依赖 mock。

## 12. 接手检查清单

- [ ] `git status` 干净，HEAD 与 `origin/main` 一致，tag/版本确认。
- [ ] `node tools/smoke.mjs` 通过。
- [ ] `node tools/check-manifest.mjs` 通过。
- [ ] 当前 Host（本地或远程）实际安装位置确认。
- [ ] 凭据存在但未打印；`baseURL`/`model` 与当前网关一致。
- [ ] 真实 `image_generate` + `image_edit` 各跑一次，记录返回路径/尺寸。
- [ ] 若改了错误处理/API，同步更新 README 与本文档的 §5/§6。
- [ ] 不在文档/提交里写入任何密钥或用户图片。
