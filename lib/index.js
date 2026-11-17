/**
 * dsh-tool-ecnu-image — 把华东师大 ChatECNU 的 ecnu-image（qwen-image-2.1）注册成 DSH 工具。
 *
 * 背景：DSH 的 LLM 适配器（dsh-llm-pi-ai）只派发对话请求，模型目录也只描述
 * 「输入模态」，没有图像生成/编辑的 seam。因此 ecnu-image 不能作为
 * provider 组里的聊天模型使用，只能以工具形式接入。
 *
 * 接口（OpenAI 兼容）：
 *   POST {baseURL}/images/generations   JSON   { model, prompt, size, response_format }
 *   POST {baseURL}/images/edits         multipart { model, prompt, image, response_format }
 * 文档：https://developer.ecnu.edu.cn/vitepress/llm/api/imagegenerate.html
 *       https://developer.ecnu.edu.cn/vitepress/llm/api/imageedit.html
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-ecnu-image'
export const inject = ['tools']

export const Config = z.object({
  apiKeyEnv: z.string().default('ECNU_API_KEY'),
  baseURL: z.string().default('https://chat.ecnu.edu.cn/open/api/v1'),
  model: z.string().default('ecnu-image'),
  generateToolName: z.string().default('image_generate'),
  editToolName: z.string().default('image_edit'),
  defaultSize: z.string().default('1024x1024'),
  sizes: z.array(z.string()).default(['512x512', '768x768', '720x1280', '1280x720', '1024x1024']),
  outputDir: z.string().default('ecnu-image'),
  timeoutMs: z.natural().default(300000)
})

const MIME_BY_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp']
])

/** 去掉末尾斜杠的 API 根地址。 */
function apiRoot(config) {
  return String(config.baseURL).replace(/\/+$/u, '')
}

/**
 * 解析凭据：优先走 harness 的 credentials seam（与 llm-pi-ai 的 apiKeyEnv 同一份
 * ~/.dsh/.credentials.yaml），其次才看环境变量。
 */
async function resolveApiKey(ctx, ref) {
  try {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
    }
  } catch {
    // 凭据服务不可用时静默回退到环境变量
  }
  const fromEnv = process.env[ref]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  throw new Error(
    '缺少凭据 ' + ref + '：请写入 ~/.dsh/.credentials.yaml 的 refs（或在设置里配置该密钥），' +
      '本工具不会从配置文件读明文密钥'
  )
}

/** 当前 Session 的工作目录；拿不到时退回进程目录。 */
async function resolveCwd(ctx, exec) {
  try {
    const workingDirectory = ctx.get('workingDirectory')
    if (
      workingDirectory !== undefined &&
      typeof workingDirectory.ensure === 'function' &&
      exec !== undefined &&
      exec.agent !== undefined
    ) {
      const directory = await workingDirectory.ensure(exec.agent, exec.signal)
      if (typeof directory === 'string' && directory.length > 0) return directory
    }
  } catch {
    // 退回进程目录
  }
  return process.cwd()
}

/** 组合「调用方取消」与「本工具超时」两个信号。 */
function composeSignal(timeoutMs, outer) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!outer) return timeout
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([outer, timeout]) : timeout
}

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return (
    String(now.getFullYear()) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  )
}

function generatedName(ext) {
  return 'ecnu-image-' + stamp() + '-' + randomBytes(3).toString('hex') + ext
}

/** 从 PNG 头读宽高（接口返回的尺寸字段不可靠，实测可能缺）。 */
function pngSize(buffer) {
  if (buffer.length >= 24 && buffer.subarray(1, 4).toString('latin1') === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  return undefined
}

/** 计算落盘路径：显式 output 优先，其次 config.outputDir 下的自动命名。 */
async function resolveTarget(output, cwd, config, ext) {
  if (typeof output === 'string' && output.length > 0) {
    const target = isAbsolute(output) ? output : resolve(cwd, output)
    const endsWithSeparator = /[\\/]$/u.test(output)
    if (endsWithSeparator) return join(target, generatedName(ext))
    try {
      const info = await stat(target)
      if (info.isDirectory()) return join(target, generatedName(ext))
    } catch {
      // 目标不存在：当作文件路径使用
    }
    return target
  }
  const directory = isAbsolute(config.outputDir) ? config.outputDir : resolve(cwd, config.outputDir)
  return join(directory, generatedName(ext))
}

/** 发一次图像接口请求，返回解析后的 JSON（错误一律抛成可读的 Error）。 */
async function callImageApi(ctx, config, key, path, init, exec) {
  const url = apiRoot(config) + path
  const signal = composeSignal(config.timeoutMs, exec === undefined ? undefined : exec.signal)
  let response
  try {
    response = await fetch(url, {
      ...init,
      headers: { Authorization: 'Bearer ' + key, ...(init.headers === undefined ? {} : init.headers) },
      signal
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error('ECNU 图像接口请求失败（' + url + '）：' + message)
  }
  const raw = await response.text()
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = undefined
  }
  if (!response.ok) throw new Error('ECNU 图像接口 HTTP ' + response.status + '：' + raw.slice(0, 500))
  if (payload === undefined || payload === null || typeof payload !== 'object') {
    throw new Error('ECNU 图像接口返回非 JSON：' + raw.slice(0, 300))
  }
  // 注意：审核拦截在 200 响应里以 err_message 返回，data[0] 只有占位符
  if (typeof payload.err_message === 'string' && payload.err_message.length > 0) {
    throw new Error('ECNU 图像接口拒绝：' + payload.err_message.trim())
  }
  return payload
}

/** 把接口返回（b64 或 url）落盘，返回工具结果。 */
async function materialize(payload, config, cwd, output, requestedSize, timeoutMs) {
  const item = Array.isArray(payload.data) ? payload.data[0] : undefined
  if (item === undefined || item === null || typeof item !== 'object') {
    throw new Error('ECNU 图像接口未返回 data[0]')
  }
  let bytes
  if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
    bytes = Buffer.from(item.b64_json, 'base64')
  } else if (typeof item.url === 'string' && item.url.length > 0) {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error('下载生成结果失败 HTTP ' + response.status + '：' + item.url)
    bytes = Buffer.from(await response.arrayBuffer())
  } else {
    throw new Error('ECNU 图像接口既没有返回 b64_json 也没有返回 url')
  }
  const target = await resolveTarget(output, cwd, config, '.png')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  const size = pngSize(bytes)
  return {
    file: target,
    bytes: bytes.length,
    ...(size === undefined ? {} : { width: size.width, height: size.height }),
    ...(typeof item.revised_prompt === 'string' && item.revised_prompt.length > 0
      ? { revisedPrompt: item.revised_prompt }
      : {}),
    ...(typeof item.url === 'string' && item.url.length > 0 ? { url: item.url } : {}),
    ...(typeof requestedSize === 'string' && requestedSize.length > 0 ? { requestedSize } : {})
  }
}

function renderResult(value) {
  const dimensions =
    value.width !== undefined && value.height !== undefined ? value.width + 'x' + value.height : '尺寸未知'
  const lines = ['已写入 ' + value.file, dimensions + '，' + value.bytes + ' 字节']
  if (value.revisedPrompt !== undefined && value.revisedPrompt !== '') lines.push('实际提示词：' + value.revisedPrompt)
  if (value.url !== undefined) lines.push('原图 URL（24 小时有效）：' + value.url)
  return [{ type: 'text', text: lines.join('\n') }]
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    file: { type: 'string', required: true },
    bytes: { type: 'number', required: true },
    width: { type: 'number' },
    height: { type: 'number' },
    revisedPrompt: { type: 'string' },
    url: { type: 'string' },
    requestedSize: { type: 'string' }
  }
}

function checkSize(size, config) {
  if (size === undefined) return config.defaultSize
  if (!config.sizes.includes(size)) {
    throw new Error('不支持的 size「' + size + '」；ecnu-image 只接受：' + config.sizes.join('、'))
  }
  return size
}

export function apply(ctx, config) {
  ctx.tools.register(
    defineTool({
      name: config.generateToolName,
      description:
        '用华东师大 ChatECNU 平台的 ecnu-image 模型（底层 qwen-image-2.1）根据文本生成一张图片，' +
        '下载到工作目录并返回文件绝对路径。适合画插图、示意图、封面、壁纸等。' +
        '单次生成通常需要 20~60 秒；prompt 不超过 1024 字符，用中文把主体、风格、构图、配色写具体效果更好。' +
        '接口会做安全审核，被拦截时返回可读错误（不会返回图片）。',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: '图片描述，最长 1024 字符（中文即可）。写清主体、风格、构图、色调。'
        },
        size: {
          type: 'string',
          description:
            '生成尺寸，可选 ' + config.sizes.join(' / ') + '，默认 ' + config.defaultSize + '。'
        },
        output: {
          type: 'string',
          description:
            '可选。落盘路径：绝对路径或相对当前工作目录的路径；以目录结尾（或已存在的目录）时自动命名。' +
            '省略时写到当前工作目录的 ' + config.outputDir + '/ 下并按时间戳命名。'
        }
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderResult(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const size = checkSize(args.size, config)
        const prompt = String(args.prompt)
        if (prompt.length > 1024) throw new Error('prompt 不能超过 1024 字符（当前 ' + prompt.length + '）')
        const key = await resolveApiKey(ctx, config.apiKeyEnv)
        const cwd = await resolveCwd(ctx, exec)
        const payload = await callImageApi(
          ctx,
          config,
          key,
          '/images/generations',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: config.model,
              prompt,
              size,
              response_format: 'b64_json'
            })
          },
          exec
        )
        return materialize(payload, config, cwd, args.output, size, config.timeoutMs)
      }
    })
  )

  ctx.tools.register(
    defineTool({
      name: config.editToolName,
      description:
        '用华东师大 ChatECNU 平台的 ecnu-image 模型编辑一张已有图片（改颜色、换风格、增删元素、重绘），' +
        '保存新文件并返回绝对路径；原图不会被修改。image 传本地图片的绝对路径（PNG/JPG/WebP）。' +
        '编辑指令只做安全审核，不会像文生图那样扩写，所以指令要写具体。',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: '编辑指令，最长 1024 字符，例如「把出租车的颜色改成黑色」。'
        },
        image: {
          type: 'string',
          required: true,
          description: '待编辑图片的绝对路径（或相对当前工作目录的路径），支持 PNG/JPG/WebP/GIF/BMP。'
        },
        output: {
          type: 'string',
          description:
            '可选。落盘路径：绝对路径或相对当前工作目录的路径；以目录结尾（或已存在的目录）时自动命名。' +
            '省略时写到当前工作目录的 ' + config.outputDir + '/ 下并按时间戳命名。'
        }
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderResult(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const prompt = String(args.prompt)
        if (prompt.length > 1024) throw new Error('prompt 不能超过 1024 字符（当前 ' + prompt.length + '）')
        const key = await resolveApiKey(ctx, config.apiKeyEnv)
        const cwd = await resolveCwd(ctx, exec)
        const source = isAbsolute(args.image) ? args.image : resolve(cwd, args.image)
        const buffer = await readFile(source).catch((error) => {
          throw new Error('读取待编辑图片失败（' + source + '）：' + (error instanceof Error ? error.message : String(error)))
        })
        const form = new FormData()
        form.append('model', config.model)
        form.append('prompt', prompt)
        form.append('response_format', 'b64_json')
        const mime = MIME_BY_EXT.get(extname(source).toLowerCase()) ?? 'application/octet-stream'
        form.append('image', new Blob([buffer], { type: mime }), basename(source))
        const payload = await callImageApi(
          ctx,
          config,
          key,
          '/images/edits',
          { method: 'POST', body: form },
          exec
        )
        return materialize(payload, config, cwd, args.output, undefined, config.timeoutMs)
      }
    })
  )

  try {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
      systemPrompt.section({
        name: 'tool:ecnu-image',
        text:
          '生成或编辑图片时用 ' +
          config.generateToolName +
          ' / ' +
          config.editToolName +
          '（华东师大 ecnu-image）。生成结果落在工作目录下的 ' +
          config.outputDir +
          '/，把返回的文件路径交给用户；需要看图时用 read_image 打开该路径。'
      })
    }
  } catch {
    // systemPrompt 服务缺失时不影响工具注册
  }
}
