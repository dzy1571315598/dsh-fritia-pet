#!/usr/bin/env node
/**
 * Build the npm tarball for this plugin and publish it as a GitHub Release asset.
 *
 * Why a release tarball matters: `plugin_manager` (pnpm) resolves a GitHub
 * repository spec with `git ls-remote`, so a machine without `git` cannot install
 * from the repository URL at all. A release `.tgz` is fetched over plain HTTPS and
 * therefore installs anywhere:
 *
 *   https://github.com/<owner>/<repo>/releases/latest/download/dsh-fritia-pet.tgz
 *
 * The asset name is deliberately version-free: `latest/download/` resolves
 * "latest" at request time but takes the filename literally, so a versioned name
 * would 404 after the next release.
 *
 *   node tools/release.mjs              # build + attach to a release
 *   node tools/release.mjs --dry-run    # build only, print the URL
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

/**
 * Names inside a .tar.gz, read without depending on an external `tar`.
 *
 * npm writes long and non-ASCII paths through PAX extended headers (`typeflag`
 * x) and/or GNU LongLink (L/K): the real path lives in the data block of the
 * preceding entry. A parser that only reads the 100-byte name field silently
 * loses every Chinese-named sprite.
 */
async function listTarball(file) {
  const tar = gunzipSync(await readFile(file))
  const names = []
  let longName
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/, '')
    const size = parseInt(field(124, 136).trim(), 8) || 0
    const typeflag = String.fromCharCode(header[156])
    const body = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512

    if (typeflag === 'x' || typeflag === 'g') {
      // PAX: records are "<len> <key>=<value>\n"; a trailing NUL may pad the block.
      for (const record of body.toString('utf8').split('\n')) {
        const match = /^\d+ ([A-Za-z]+)=(.*)$/s.exec(record)
        if (match !== null && match[1] === 'path') longName = match[2]
      }
      continue
    }
    if (typeflag === 'L' || typeflag === 'K') {
      longName = body.toString('utf8').replace(/\0.*$/, '')
      continue
    }

    const prefix = field(345, 500)
    const raw = longName ?? (prefix === '' ? field(0, 100) : `${prefix}/${field(0, 100)}`)
    longName = undefined
    const name = raw.replace(/^package\//, '')
    if (name !== '' && typeflag !== '5') names.push(name)
  }
  return names
}

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const DIST = join(PKG_ROOT, '..', 'dist')
const TOKEN_FILE = join(PKG_ROOT, '..', 'mcp', 'token.txt')
const ASSET_NAME = 'dsh-fritia-pet.tgz'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const manifest = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
const tag = args.includes('--tag')
  ? args[args.indexOf('--tag') + 1]
  : `v${manifest.version}`

const token = process.env.GITHUB_TOKEN
  ?? (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : undefined)

/** The bundled pnpm CLI, so packing does not depend on PATH. */
function resolvePnpmCli() {
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const candidates = [
    process.env.DSH_PNPM_CLI,
    join(dirname(process.execPath), '..', 'pnpm', 'bin', 'pnpm.mjs'),
    localAppData === ''
      ? undefined
      : join(localAppData, '..', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime',
        'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) {
    console.error('cannot find pnpm.mjs; set DSH_PNPM_CLI to its path')
    process.exit(2)
  }
  return found
}
const owner = args.includes('--owner')
  ? args[args.indexOf('--owner') + 1]
  : (manifest.repository?.url ?? '').match(/github\.com[/:]([^/]+)\//)?.[1]

if (owner === undefined || owner === '') {
  console.error('cannot determine the GitHub owner: set repository.url in package.json or pass --owner')
  process.exit(2)
}
const repo = manifest.name.replace(/^@[^/]+\//, '')

// ------------------------------------------------------------------- build it
await rm(DIST, { recursive: true, force: true })
await mkdir(DIST, { recursive: true })
console.log(`packing ${PKG_ROOT} …`)
execFileSync(process.execPath, [resolvePnpmCli(), 'pack', '--dir', PKG_ROOT, '--pack-destination', DIST], {
  stdio: 'inherit',
})

const produced = (await readdir(DIST)).find((name) => name.endsWith('.tgz'))
if (produced === undefined) {
  console.error('pnpm pack produced no tarball')
  process.exit(1)
}
const tarball = join(DIST, produced)
const size = statSync(tarball).size

// An art-less tarball still installs and then renders a blank pet, so the pack is
// verified before it is published. Parsed in Node rather than with `tar`, because
// the child's PATH cannot be relied on.
const entries = await listTarball(tarball)
const sprites = entries.filter((entry) => entry.toLowerCase().endsWith('.png'))
if (sprites.length < 20) {
  console.error(`refusing to publish: tarball has only ${sprites.length} images `
    + `(expected at least 20). Check package.json "files" case and .npmignore.`)
  process.exit(1)
}
console.log(`tarball: ${(size / 1024 / 1024).toFixed(2)} MB, ${entries.length} entries, ${sprites.length} images`)

const url = `https://github.com/${owner}/${repo}/releases/latest/download/${ASSET_NAME}`
console.log(`install URL: ${url}`)
if (dryRun) process.exit(0)

if (token === undefined || token === '') {
  console.error(`no token: put one in ${TOKEN_FILE} or export GITHUB_TOKEN`)
  process.exit(2)
}

async function api(path, { method = 'GET', body, raw } = {}) {
  // Uploads go to a different host, so absolute URLs pass through untouched.
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`
  const response = await fetch(url, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-fritia-pet-release',
      ...(raw === undefined ? {} : { 'content-type': raw.type }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(raw !== undefined ? { body: raw.data } : {}),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  const parsed = text === '' ? null : (() => { try { return JSON.parse(text) } catch { return { raw: text } } })()
  if (!response.ok) {
    const error = new Error(`${method} ${path} -> ${response.status} ${parsed?.message ?? response.statusText}`)
    error.status = response.status
    throw error
  }
  return parsed
}

// ----------------------------------------------------------------- publish it
const notes = [
  'Fritia 桌宠 — DeepSeek Harness (DSH) 插件。',
  '',
  '安装（不需要 git）:',
  '',
  `    plugin_manager install_bundle  target = ${url}`,
  '',
  '包含 Host 半（素材 HTTP + 工作状态）、浏览器半（状态机与渲染）、20 张立绘、自检脚本。',
].join('\n')

let release
try {
  release = await api(`/repos/${owner}/${repo}/releases/tags/${tag}`)
  console.log(`release ${tag} exists (id ${release.id})`)
} catch (error) {
  if (error.status !== 404) throw error
  release = await api(`/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    body: { tag_name: tag, name: tag, body: notes, draft: false, prerelease: false },
  })
  console.log(`created release ${tag} (id ${release.id})`)
}

// Replace an existing asset of the same name so re-running is idempotent.
for (const asset of release.assets ?? []) {
  if (asset.name === ASSET_NAME) {
    await api(`/repos/${owner}/${repo}/releases/assets/${asset.id}`, { method: 'DELETE' })
    console.log(`replaced existing asset ${ASSET_NAME}`)
  }
}

const data = await readFile(tarball)
await api(`https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${ASSET_NAME}`, {
  method: 'POST',
  raw: { type: 'application/gzip', data },
})

const after = await api(`/repos/${owner}/${repo}/releases/tags/${tag}`)
const attached = (after.assets ?? []).find((asset) => asset.name === ASSET_NAME)
console.log(`attached: ${attached?.name} (${Math.round((attached?.size ?? 0) / 1024)} KB)`)
console.log(`release page: ${after.html_url}`)
console.log(`install with: plugin_manager install_bundle  target = ${url}`)
