#!/usr/bin/env node
/**
 * Post-publish settings for the Fritia pet repository.
 *
 * The publisher only applies visibility at creation time, so an existing private
 * repository needs this switch. Also sets the topics a plugin storefront looks for.
 *
 *   node tools/repo-settings.mjs                 # make public + add topics
 *   node tools/repo-settings.mjs --private       # flip back
 *   node tools/repo-settings.mjs --topics a,b    # replace topics
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const TOKEN_FILE = join(PKG_ROOT, '..', 'mcp', 'token.txt')
const manifest = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))

const token = process.env.GITHUB_TOKEN
  ?? (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : undefined)
if (token === undefined || token === '') {
  console.error(`no token: put one in ${TOKEN_FILE} or export GITHUB_TOKEN`)
  process.exit(2)
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const repo = value('--repo', manifest.name.replace(/^@[^/]+\//, ''))
const topics = value('--topics', 'dsh-plugin,deepseek-harness,dsh,desktop-pet,cordis,plugin')
  .split(',').map((topic) => topic.trim()).filter(Boolean)

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-fritia-pet-publisher',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  const parsed = text === '' ? null : JSON.parse(text)
  if (!response.ok) {
    const error = new Error(`${method} ${path} -> ${response.status} ${parsed?.message ?? response.statusText}`)
    error.status = response.status
    throw error
  }
  return parsed
}

const me = await api('/user')
const full = `${me.login}/${repo}`

const before = await api(`/repos/${full}`)
console.log(`before: private=${before.private} topics=[${(before.topics ?? []).join(', ')}]`)

const wantPrivate = flag('--private')
if (before.private !== wantPrivate) {
  const updated = await api(`/repos/${full}`, { method: 'PATCH', body: { private: wantPrivate } })
  console.log(`visibility -> ${updated.private ? 'private' : 'public'}`)
} else {
  console.log(`visibility already ${wantPrivate ? 'private' : 'public'}`)
}

await api(`/repos/${full}/topics`, {
  method: 'PUT',
  body: { names: topics },
})
const after = await api(`/repos/${full}`)
console.log(`after : private=${after.private} topics=[${(after.topics ?? []).join(', ')}]`)
console.log(`url   : ${after.html_url}`)
