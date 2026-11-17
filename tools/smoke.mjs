/**
 * Offline contract tests for both tools. No network, no DSH, no dependencies:
 * the plugin's two @deepseek-ai/* imports are stubbed and everything else runs
 * verbatim, while a local HTTP server stands in for the ChatECNU gateway.
 *
 *   node tools/smoke.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

/* ---- load the plugin with the two host imports stubbed ---- */

const Z_STUB =
  'const z = { string: () => ({ default: (v) => v }), natural: () => ({ default: (v) => v }), ' +
  'array: () => ({ default: (v) => v }), object: (shape) => shape }'

const source = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8')
for (const needle of ["import z from '@deepseek-ai/schemastery'", "import { defineTool } from '@deepseek-ai/dsh-tools'"]) {
  assert.ok(source.includes(needle), 'lib/index.js no longer contains ' + needle)
}
const stubbed = source
  .replace("import z from '@deepseek-ai/schemastery'", Z_STUB)
  .replace("import { defineTool } from '@deepseek-ai/dsh-tools'", 'const defineTool = (options) => options')

// 用临时文件而不是 data: URL 载入：data: 模块在 Windows 上退出时会触发
// libuv 的 async-close 断言，让测试进程带着崩溃码结束。
const stubDir = await mkdtemp(join(tmpdir(), 'ecnu-image-plugin-'))
const stubFile = join(stubDir, 'plugin.mjs')
await writeFile(stubFile, stubbed)
const plugin = await import(pathToFileURL(stubFile).href)

/* ---- a stand-in gateway ---- */

const requests = []
let mode = 'ok'
const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  requests.push({
    url: request.url,
    auth: request.headers.authorization,
    contentType: request.headers['content-type'] || '',
    body: Buffer.concat(chunks)
  })
  if (mode === 'blocked') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ created: 1, data: [{ revised_prompt: '****' }], err_message: '内容不合规' }))
    return
  }
  if (mode === 'http500') {
    response.writeHead(500, { 'Content-Type': 'text/plain' })
    response.end('boom')
    return
  }
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(
    JSON.stringify({
      created: 1,
      data: [{ b64_json: PNG_1PX.toString('base64'), revised_prompt: 'p', url: 'https://example.invalid/x.png' }]
    })
  )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const BASE_URL = 'http://127.0.0.1:' + server.address().port + '/v1'

/* ---- harness ---- */

const workdir = await mkdtemp(join(tmpdir(), 'ecnu-image-smoke-'))
const config = {
  apiKeyEnv: 'ECNU_API_KEY',
  baseURL: BASE_URL,
  model: 'ecnu-image',
  generateToolName: 'image_generate',
  editToolName: 'image_edit',
  defaultSize: '512x512',
  sizes: ['512x512', '768x768'],
  outputDir: 'ecnu-image',
  timeoutMs: 20000
}

function mount(key) {
  const tools = {}
  const ctx = {
    get: (name) => (name === 'credentials' && key !== undefined ? { resolve: async () => ({ value: key }) } : undefined),
    tools: { register: (definition) => { tools[definition.name] = definition } }
  }
  return { tools, ctx }
}

const exec = { signal: undefined, agent: undefined }
const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push(['ok', name])
  } catch (error) {
    results.push(['fail', name, error])
  }
}

/* ---- cases ---- */

await test('plugin declares name and injects the tools service', () => {
  assert.equal(plugin.name, 'tool-ecnu-image')
  assert.deepEqual([...plugin.inject], ['tools'])
})

await test('apply registers both tools with required parameters', () => {
  const { tools, ctx } = mount('k')
  plugin.apply(ctx, config)
  assert.deepEqual(Object.keys(tools).sort(), ['image_edit', 'image_generate'])
  // defineTool 在真实宿主里把 DSL 编译成 JSON Schema；这里桩函数返回原样，故按 DSL 断言
  assert.equal(tools.image_generate.parameters.prompt.required, true)
  assert.equal(tools.image_edit.parameters.image.required, true)
  assert.equal(tools.image_generate.execute !== undefined, true)
})

await test('generation writes the image, reads its size and sends the bearer token', async () => {
  mode = 'ok'
  requests.length = 0
  const { tools, ctx } = mount('test-key')
  plugin.apply(ctx, config)
  const out = join(workdir, 'gen', 'a.png')
  const value = await tools.image_generate.execute({ prompt: '一只猫', size: '512x512', output: out }, exec)

  assert.equal(value.file, out)
  assert.equal(value.width, 1)
  assert.equal(value.height, 1)
  assert.equal(value.bytes, PNG_1PX.length)
  assert.equal(value.revisedPrompt, 'p')
  assert.equal((await readFile(out)).equals(PNG_1PX), true)

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/v1/images/generations')
  assert.equal(requests[0].auth, 'Bearer test-key')
  const body = JSON.parse(requests[0].body.toString('utf8'))
  assert.equal(body.model, 'ecnu-image')
  assert.equal(body.prompt, '一只猫')
  assert.equal(body.size, '512x512')
  assert.equal(body.response_format, 'b64_json')
})

await test('default output lands in <cwd>/<outputDir>', async () => {
  mode = 'ok'
  const { tools, ctx } = mount('test-key')
  plugin.apply(ctx, { ...config, outputDir: join(workdir, 'default') })
  const value = await tools.image_generate.execute({ prompt: '默认路径' }, exec)
  assert.equal(value.file.startsWith(join(workdir, 'default')), true)
  assert.match(value.file, /ecnu-image-\d{8}-\d{6}-[0-9a-f]{6}\.png$/)
})

await test('moderation is HTTP 200 plus err_message, surfaced as a readable error', async () => {
  mode = 'blocked'
  const { tools, ctx } = mount('test-key')
  plugin.apply(ctx, config)
  await assert.rejects(
    () => tools.image_generate.execute({ prompt: '不合适', output: join(workdir, 'blocked.png') }, exec),
    /内容不合规/
  )
})

await test('HTTP 500 becomes a readable error', async () => {
  mode = 'http500'
  const { tools, ctx } = mount('test-key')
  plugin.apply(ctx, config)
  await assert.rejects(() => tools.image_generate.execute({ prompt: 'x', output: join(workdir, 'x.png') }, exec), /HTTP 500/)
})

await test('unsupported size is rejected locally, before any request', async () => {
  mode = 'ok'
  requests.length = 0
  const { tools, ctx } = mount('test-key')
  plugin.apply(ctx, config)
  await assert.rejects(() => tools.image_generate.execute({ prompt: 'x', size: '100x100' }, exec), /100x100/)
  assert.equal(requests.length, 0)
})

await test('prompt longer than 1024 characters is rejected locally', async () => {
  const { tools, ctx } = mount('test-key')
  plugin.apply(ctx, config)
  await assert.rejects(() => tools.image_generate.execute({ prompt: 'a'.repeat(1025) }, exec), /1024/)
})

await test('a missing credential names the reference and never falls back to a file', async () => {
  const { tools, ctx } = mount(undefined)
  plugin.apply(ctx, config)
  await assert.rejects(() => tools.image_generate.execute({ prompt: 'x' }, exec), /ECNU_API_KEY/)
})

await test('editing posts a multipart body with the image attached', async () => {
  mode = 'ok'
  requests.length = 0
  const { tools, ctx } = mount('test-key')
  plugin.apply(ctx, config)
  const source = join(workdir, 'source.png')
  await writeFile(source, PNG_1PX)
  const out = join(workdir, 'edited.png')
  const value = await tools.image_edit.execute({ prompt: '改成夜景', image: source, output: out }, exec)

  assert.equal(value.file, out)
  assert.equal((await readFile(out)).equals(PNG_1PX), true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/v1/images/edits')
  assert.equal(requests[0].auth, 'Bearer test-key')
  assert.match(requests[0].contentType, /^multipart\/form-data; boundary=/)
  const body = requests[0].body.toString('latin1')
  for (const field of ['name="model"', 'name="prompt"', 'name="response_format"', 'name="image"; filename="source.png"']) {
    assert.equal(body.includes(field), true, 'multipart body is missing ' + field)
  }
  assert.equal(body.includes('ecnu-image'), true)
})

/* ---- report ---- */

await new Promise((resolve) => server.close(resolve))
await rm(workdir, { recursive: true, force: true })
await rm(stubDir, { recursive: true, force: true })

let failed = 0
for (const [status, name, error] of results) {
  if (status === 'ok') {
    console.log('ok   ' + name)
  } else {
    failed += 1
    console.log('FAIL ' + name + '\n     ' + (error && error.message ? error.message : String(error)))
  }
}
console.log('')
console.log((results.length - failed) + '/' + results.length + ' passed')
process.exitCode = failed > 0 ? 1 : 0
