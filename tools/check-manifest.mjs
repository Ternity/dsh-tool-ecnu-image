/**
 * Repository-level checks that need no DSH and no network:
 * the manifest points at real files, the entry registers both tools, and no
 * credential value has leaked into anything the repository publishes.
 *
 *   node tools/check-manifest.mjs
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

function check(condition, message) {
  if (!condition) failures.push(message)
}

const read = (relative) => readFile(join(ROOT, relative), 'utf8')
const pkgText = await read('package.json')
const pkg = JSON.parse(pkgText)

check(pkg.name === 'dsh-tool-ecnu-image', 'package name changed')
check(pkg.type === 'module', 'package must stay ESM')
check(pkg.main === 'lib/index.js', 'main must stay lib/index.js')
check(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', 'dsh.bundle.patch must point at ./cordis.patch.yml')

const referenced = [pkg.main, pkg.exports && pkg.exports['.'], pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, 'LICENSE', 'README.md', 'AGENT_HANDOFF.md']
for (const relative of referenced) {
  if (!relative) {
    failures.push('package.json references an empty path')
    continue
  }
  try {
    await readFile(join(ROOT, relative))
  } catch {
    failures.push('missing file referenced by package.json: ' + relative)
  }
}

const entry = await read('lib/index.js')
for (const name of ['image_generate', 'image_edit']) {
  check(entry.includes("'" + name + "'"), 'lib/index.js does not register ' + name)
}

// A published plugin must never carry a credential value; only reference names.
const SECRET = /\bsk-[A-Za-z0-9]{16,}/u
for (const relative of ['lib/index.js', 'cordis.patch.yml', 'README.md', 'AGENT_HANDOFF.md', 'package.json']) {
  const text = await read(relative)
  check(!SECRET.test(text), 'a credential-looking value leaked into ' + relative)
}

if (failures.length > 0) {
  for (const failure of failures) console.error('FAIL ' + failure)
  process.exitCode = 1
} else {
  console.log('manifest ok: ' + referenced.filter(Boolean).join(', ') + ' all present; both tools registered; no secrets')
}
