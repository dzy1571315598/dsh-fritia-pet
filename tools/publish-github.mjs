#!/usr/bin/env node
/**
 * Publish the Fritia pet plugin to GitHub or Gitee — no git required.
 *
 * Both hosts are driven over their REST APIs. GitHub uses the Git Data API for one
 * atomic multi-file commit; Gitee has no tree API, so files are written one by one
 * through its contents endpoint (each file is its own commit).
 *
 * Token resolution: --token, else GITHUB_TOKEN / GITEE_TOKEN, else ../mcp/token.txt
 *
 *   node tools/publish-github.mjs --check
 *   node tools/publish-github.mjs --dry-run
 *   node tools/publish-github.mjs --host gitee --public
 *   node tools/publish-github.mjs --host github --repo my-name --public
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const TOKEN_FILE = join(PKG_ROOT, '..', 'mcp', 'token.txt')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const host = value('--host', 'github')
const HOSTS = {
  github: {
    label: 'GitHub',
    api: 'https://api.github.com',
    tokenEnv: ['GITHUB_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN'],
    repoUrl: (owner, repo) => `https://github.com/${owner}/${repo}`,
    createRepo: '/user/repos',
    createRepoAuth: 'bearer',
    contentsAuth: 'bearer',
    webCreate: 'https://github.com/new',
  },
  gitee: {
    label: 'Gitee',
    api: 'https://gitee.com/api/v5',
    tokenEnv: ['GITEE_TOKEN'],
    repoUrl: (owner, repo) => `https://gitee.com/${owner}/${repo}`,
    createRepo: '/user/repos',
    createRepoAuth: 'body',      // access_token travels in the JSON body
    contentsAuth: 'body',
    webCreate: 'https://gitee.com/projects/new',
  },
}
const target = HOSTS[host]
if (target === undefined) {
  console.error(`unknown --host ${host} (expected github or gitee)`)
  process.exit(2)
}

const token = value('--token', undefined)
  ?? target.tokenEnv.map((name) => process.env[name]).find((v) => v !== undefined && v !== '')
  ?? (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : undefined)

// --dry-run and --zip only touch the local tree, so they work before a token exists.
if (!flag('--dry-run') && !flag('--zip') && (token === undefined || token === '')) {
  console.error([
    `No ${target.label} token found.`,
    `  put one in ${TOKEN_FILE}, or export ${target.tokenEnv[0]}, or pass --token`,
    target.label === 'Gitee'
      ? '  create it at https://gitee.com/profile/personal_access_tokens (scopes: projects, pull_requests)'
      : '  create it at https://github.com/settings/personal-access-tokens (Contents R/W, Administration R/W, Metadata R)',
  ].join('\n'))
  process.exit(2)
}

async function api(path, { method = 'GET', body, auth = 'bearer' } = {}) {
  const payload = body === undefined ? undefined : { ...body }
  if (payload !== undefined && auth === 'body') payload.access_token = token
  const response = await fetch(`${target.api}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'user-agent': 'dsh-fritia-pet-publisher',
      ...(payload === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      ...(auth === 'bearer' ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = { raw: text.slice(0, 300) }
  }
  if (!response.ok) {
    const message = parsed?.message
      ?? (Array.isArray(parsed?.errors) ? parsed.errors.map((e) => e.message ?? e).join('; ') : undefined)
      ?? parsed?.error
      ?? response.statusText
    const error = new Error(`${method} ${path} -> ${response.status} ${message}`)
    error.status = response.status
    error.body = parsed
    throw error
  }
  return parsed
}

/** Files to publish: the plugin directory, minus local-only folders. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '__pycache__'])
async function collect(root, base = root, out = []) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) await collect(full, base, out)
    else out.push({ path: relative(base, full).split('\\').join('/'), full })
  }
  return out
}

const files = (await collect(PKG_ROOT)).sort((a, b) => a.path.localeCompare(b.path))
const manifest = JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8'))
const repoName = value('--repo', manifest.name.replace(/^@[^/]+\//, ''))
const visibility = flag('--public') ? 'public' : 'private'
const branch = value('--branch', host === 'gitee' ? 'master' : 'main')

if (flag('--zip')) {
  // Platform-free sharing: one archive, no host, no login, no git. Written with a
  // minimal store/deflate ZIP writer so no external tool or dependency is needed.
  const { deflateRawSync } = await import('node:zlib')
  const { mkdir, writeFile } = await import('node:fs/promises')
  const outDir = join(PKG_ROOT, '..', 'dist')
  await mkdir(outDir, { recursive: true })
  const outFile = join(outDir, `FritiaPet-${manifest.version}.zip`)

  const crcTable = (() => {
    const table = new Int32Array(256)
    for (let i = 0; i < 256; i += 1) {
      let c = i
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      table[i] = c
    }
    return table
  })()
  const crc32 = (buffer) => {
    let c = 0xFFFFFFFF
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xFF] ^ (c >>> 8)
    return (c ^ 0xFFFFFFFF) >>> 0
  }

  const chunks = []
  const central = []
  let offset = 0
  for (const file of files) {
    const raw = await readFile(file.full)
    const deflated = deflateRawSync(raw, { level: 9 })
    const stored = deflated.length >= raw.length
    const payload = stored ? raw : deflated
    const name = Buffer.from(file.path, 'utf8')
    const crc = crc32(raw)
    const method = stored ? 0 : 8

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)       // UTF-8 file names
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    chunks.push(local, name, payload)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(method, 10)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(payload.length, 20)
    dir.writeUInt32LE(raw.length, 24)
    dir.writeUInt16LE(name.length, 28)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, name)

    offset += local.length + name.length + payload.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)

  await writeFile(outFile, Buffer.concat([...chunks, centralBuffer, end]))
  const { size } = await stat(outFile)
  console.log(`wrote ${outFile}`)
  console.log(`  ${(size / 1024 / 1024).toFixed(2)} MB, ${files.length} files, UTF-8 names`)
  console.log('  this archive needs no account on any host: send the file itself.')
  process.exit(0)
}

if (flag('--dry-run')) {
  let total = 0
  console.log(`would publish ${files.length} files to ${target.label} as "${repoName}" (${visibility})\n`)
  for (const file of files) {
    const info = await stat(file.full)
    total += info.size
    console.log(`  ${String(Math.round(info.size / 1024)).padStart(5)} KB  ${file.path}`)
  }
  console.log(`\ntotal ${(total / 1024 / 1024).toFixed(2)} MB`)
  console.log(`create the repo by hand instead: ${target.webCreate}`)
  process.exit(0)
}

const me = await api('/user', { auth: target.contentsAuth })
const owner = me.login ?? me.name
console.log(`authenticated on ${target.label} as ${owner}`)

// ------------------------------------------------------------------ the repo
const createBody = {
  name: repoName,
  description: 'Fritia 桌宠 — DeepSeek Harness (DSH) 桌宠插件：右下角待机/走路/抓取/情绪/余额面板',
  has_issues: true,
  has_wiki: false,
  auto_init: false,
  private: visibility !== 'public',
}

let repoExists = true
try {
  await api(`/repos/${owner}/${repoName}`, { auth: target.contentsAuth })
  console.log(`repository ${owner}/${repoName} already exists`)
} catch (error) {
  if (error.status !== 404) throw error
  repoExists = false
}
if (!repoExists) {
  try {
    await api(target.createRepo, { method: 'POST', body: createBody, auth: target.createRepoAuth })
    console.log(`created ${visibility} repository ${owner}/${repoName}`)
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      console.error([
        `creating the repository failed: ${error.message}`,
        `create it by hand at ${target.webCreate} (name: ${repoName}), then re-run this command.`,
      ].join('\n'))
    }
    throw error
  }
}

// ---------------------------------------------------------------- the content
console.log(`\nuploading ${files.length} files…`)

if (host === 'github') {
  let baseTree
  let parentSha
  try {
    const ref = await api(`/repos/${owner}/${repoName}/git/ref/heads/${branch}`)
    parentSha = ref.object.sha
    const head = await api(`/repos/${owner}/${repoName}/git/commits/${parentSha}`)
    baseTree = head.tree.sha
    console.log(`branch ${branch} exists; committing on top of ${parentSha.slice(0, 8)}`)
  } catch (error) {
    if (error.status !== 404 && error.status !== 409) throw error
    console.log(`building the initial commit on ${branch}`)
    // GitHub refuses Git Data API writes while a repository has no commits at all
    // ("Git Repository is empty"), so the first commit is seeded through the
    // contents API, which is allowed to initialize an empty repository.
    const readme = files.find((file) => file.path.toLowerCase() === 'readme.md')
    const seed = readme ?? files[0]
    await api(`/repos/${owner}/${repoName}/contents/${encodeURIComponent(seed.path)}`, {
      method: 'PUT',
      body: {
        content: (await readFile(seed.full)).toString('base64'),
        message: 'chore: initialize repository',
        branch,
      },
    })
    const ref = await api(`/repos/${owner}/${repoName}/git/ref/heads/${branch}`)
    parentSha = ref.object.sha
    const head = await api(`/repos/${owner}/${repoName}/git/commits/${parentSha}`)
    baseTree = head.tree.sha
    console.log(`seeded ${seed.path}, continuing on ${parentSha.slice(0, 8)}`)
  }

  const blobs = []
  for (const file of files) {
    const content = (await readFile(file.full)).toString('base64')
    const blob = await api(`/repos/${owner}/${repoName}/git/blobs`, {
      method: 'POST',
      body: { content, encoding: 'base64' },
    })
    blobs.push({ path: file.path, sha: blob.sha, bytes: Buffer.from(content, 'base64').length })
    console.log(`  ${String(Math.round(blobs.at(-1).bytes / 1024)).padStart(5)} KB  ${file.path}`)
  }

  // `base_tree` MERGES: paths omitted from the new tree survive from the base. A
  // renamed folder would therefore live on forever, so every path that exists
  // remotely but not locally is explicitly deleted (sha: null).
  const deletions = []
  if (baseTree !== undefined) {
    try {
      const current = await api(`/repos/${owner}/${repoName}/git/trees/${baseTree}?recursive=1`)
      const wanted = new Set(files.map((file) => file.path))
      const keptDirs = new Set()
      for (const file of files) {
        const parts = file.path.split('/')
        for (let i = 1; i < parts.length; i += 1) keptDirs.add(parts.slice(0, i).join('/'))
      }
      for (const entry of current.tree ?? []) {
        if (entry.type !== 'blob') continue
        if (wanted.has(entry.path) || keptDirs.has(entry.path)) continue
        deletions.push({ path: entry.path, mode: '100644', type: 'blob', sha: null })
      }
    } catch (error) {
      console.warn(`  (could not list the current tree to prune: ${error.message})`)
    }
  }
  if (deletions.length > 0) {
    console.log(`pruning ${deletions.length} path(s) that no longer exist locally:`)
    for (const entry of deletions) console.log(`  delete  ${entry.path}`)
  }

  const tree = await api(`/repos/${owner}/${repoName}/git/trees`, {
    method: 'POST',
    body: {
      ...(baseTree === undefined ? {} : { base_tree: baseTree }),
      tree: [
        ...blobs.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
        ...deletions,
      ],
    },
  })
  const commit = await api(`/repos/${owner}/${repoName}/git/commits`, {
    method: 'POST',
    body: {
      message: 'feat: Fritia 桌宠 DSH 插件\n\n'
        + '右下角桌宠：待机1/2 随机、10 秒后困/钓鱼(各 50%)、左键高兴/困惑、连点生气、'
        + '10% 彩蛋、右键余额面板、长按抓取与拖动颤抖；Agent 工作时左右走，停止后 3 秒回待机。\n\n'
        + '包含 Host 半(素材 HTTP 与工作状态)、浏览器半(状态机与渲染)、20 张立绘、自检脚本。',
      tree: tree.sha,
      ...(parentSha === undefined ? {} : { parents: [parentSha] }),
    },
  })
  if (parentSha === undefined) {
    await api(`/repos/${owner}/${repoName}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha: commit.sha },
    })
  } else {
    await api(`/repos/${owner}/${repoName}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      body: { sha: commit.sha, force: false },
    })
  }
  console.log(`\ncommit ${commit.sha.slice(0, 8)} pushed to ${branch}`)
} else {
  // Gitee: contents API, one write per file. `sha` is required when the path
  // already exists, so existing files are updated instead of rejected.
  let uploaded = 0
  for (const file of files) {
    const bytes = await readFile(file.full)
    const encoded = encodeURIComponent(file.path)
    let sha
    try {
      const existing = await api(`/repos/${owner}/${repoName}/contents/${encoded}?ref=${branch}`, {
        auth: target.contentsAuth,
      })
      sha = existing?.sha
    } catch (error) {
      if (error.status !== 404) throw error
    }
    await api(`/repos/${owner}/${repoName}/contents/${encoded}`, {
      method: sha === undefined ? 'POST' : 'PUT',
      auth: target.contentsAuth,
      body: {
        content: bytes.toString('base64'),
        message: sha === undefined ? `feat: add ${file.path}` : `chore: update ${file.path}`,
        branch,
        ...(sha === undefined ? {} : { sha }),
      },
    })
    uploaded += 1
    console.log(`  ${String(Math.round(bytes.length / 1024)).padStart(5)} KB  ${file.path}`)
  }
  console.log(`\n${uploaded} files written to ${branch}`)
}

console.log(`repository: ${target.repoUrl(owner, repoName)}`)
if (visibility !== 'public') {
  console.log('NOTE: the repository is private — set it public in the host UI for anyone to download.')
}
