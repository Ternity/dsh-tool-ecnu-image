/**
 * Install this repository's git hooks. Hooks live in .git/hooks, which git does
 * not version, so a fresh clone needs this once:
 *
 *   node tools/install-hooks.mjs
 *
 * Currently installs one hook: post-commit, which pushes to origin right after
 * every commit (non-fatal on failure).
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HOOK = [
  '#!/bin/sh',
  '# Installed by tools/install-hooks.mjs. Pushes every new commit to origin so the',
  '# published plugin never drifts from this working copy.',
  '#',
  '# Deliberately non-fatal and quiet: a failed push (offline, remote not created',
  '# yet, network blocked) must never block a commit.',
  'if ! git remote get-url origin >/dev/null 2>&1; then',
  '  exit 0',
  'fi',
  "if ! git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then",
  '  git push --quiet --set-upstream origin HEAD >/dev/null 2>&1 ||',
  "    printf '[auto-push] first push failed; run: git push -u origin HEAD\\n'",
  '  exit 0',
  'fi',
  'git push --quiet origin HEAD >/dev/null 2>&1 ||',
  "  printf '[auto-push] push failed (offline?); run: git push\\n'",
  'exit 0',
  ''
].join('\n')

const hooksDirectory = join(ROOT, '.git', 'hooks')
await mkdir(hooksDirectory, { recursive: true })
const target = join(hooksDirectory, 'post-commit')
await writeFile(target, HOOK, 'utf8')
await chmod(target, 0o755).catch(() => { /* Windows has no POSIX mode bits */ })
console.log('installed ' + target)
console.log('every commit now pushes to origin (non-fatal if the remote is unreachable)')
