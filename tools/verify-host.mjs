/**
 * Local verification harness (not shipped inside the plugin).
 *
 * 1. Mounts the pet Host half on a fake Cordis context whose `webServer` records
 *    routes, then drives those handlers with real IncomingMessage/ServerResponse
 *    objects to check status codes, bodies and path containment.
 * 2. Builds the pet sprite URL exactly as the browser half does, proving the
 *    artwork route and the client agree.
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const petUrl = pathToFileURL(path.resolve('D:/DeepseekHarness/FritiaPlugin/FritiaPet/index.js')).href

// A fake Cordis context that only records what the Host half asks for.
const routes = []
const effects = []
// Every registered listener, not just the last one per event: the harness applies
// the plugin more than once (config-defaults check), and each apply registers its
// own pair.
const listenerPairs = []
const liveAgents = [{ id: 'session-a' }, { id: 'session-b' }]
const fakeCtx = {
  effect(callback, label) {
    effects.push(label ?? 'effect')
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  on(event, listener) {
    const pair = { event, listener }
    listenerPairs.push(pair)
    return () => {
      const index = listenerPairs.indexOf(pair)
      if (index >= 0) listenerPairs.splice(index, 1)
    }
  },
  get(name) {
    if (name === 'agents') return { list: () => liveAgents }
    return undefined
  },
  logger: { info() {}, warn() {} },
  deepseekAccount: {
    async getBalance(client) {
      return {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '10.0000000000000000' }],
        bonusWallets: [{ currency: 'CNY', balance: '4.2223016000000000' }],
      }
    },
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
}

const pet = await import(petUrl)
// walkingWindowMs and reconcileMs are shortened so the lifecycle above runs fast.
pet.apply(fakeCtx, { routePrefix: '/fritia-pet', walkingWindowMs: 400, reconcileMs: 120 })

console.log('module name/inject:', pet.name, JSON.stringify(pet.inject))
console.log('effects:', effects.join(' | '))
console.log('events listened:', [...new Set(listenerPairs.map((pair) => pair.event))].join(', ') || '(none)')
console.log('routes registered:')
for (const route of routes) console.log(`  ${route.kind.padEnd(6)} ${route.path}`)

for (const label of ['apply-missing-config', 'apply-empty-config']) {
  const ctx2 = { ...fakeCtx, webServer: { register: () => () => {} } }
  try {
    pet.apply(ctx2, label === 'apply-empty-config' ? {} : undefined)
    console.log(`${label}: ok`)
  } catch (error) {
    console.log(`${label}: THREW ${error}`)
  }
}

// Drive the registered handlers through a real HTTP server.
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const route = routes.find((candidate) => candidate.kind === 'exact'
    ? candidate.path === url.pathname
    : url.pathname.startsWith(candidate.path))
  if (route === undefined) {
    res.writeHead(404)
    res.end('no route')
    return
  }
  try {
    route.handler(req, res)
  } catch (error) {
    res.writeHead(500)
    res.end(String(error))
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

// Mirror the browser half's URL construction.
const declared = (await (await fetch(`${base}/fritia-pet/manifest.json`)).json()).assetBase
console.log('\nmanifest assetBase:', declared)
const browserUrl = (assetBase, file) => (assetBase === undefined
  ? `/fritia-pet/sprite?f=${encodeURIComponent(file)}`
  : `${assetBase}${encodeURIComponent(file)}`)

const checks = [
  ['health', '/fritia-pet/health'],
  ['manifest', '/fritia-pet/manifest.json'],
  ['state', '/fritia-pet/state'],
  ['balance', '/fritia-pet/balance'],
  ['sprite (browser URL)', browserUrl(declared, '待机1.png')],
  ['sprite (path form)', '/fritia-pet/sprite/' + encodeURIComponent('待机1.png')],
  ['sprite (missing)', '/fritia-pet/sprite?f=nope.png'],
  ['sprite (traversal)', '/fritia-pet/sprite?f=..%2F..%2Fpackage.json'],
  ['sprite (no name)', '/fritia-pet/sprite'],
]
for (const [label, route] of checks) {
  const response = await fetch(base + route)
  const body = await response.text()
  const shown = response.headers.get('content-type')?.startsWith('image/')
    ? `<${body.length} bytes>`
    : body.slice(0, 200)
  console.log(`${label.padEnd(22)} ${response.status} ${response.headers.get('content-type')} ${shown}`)
}

// Every artwork file the client asks for must resolve.
const { readFile } = await import('node:fs/promises')
const assetDir = 'D:/DeepseekHarness/FritiaPlugin/FritiaPet/sprites'
const files = (await (await import('node:fs/promises')).readdir(assetDir)).filter((f) => f.endsWith('.png'))
let missing = 0
for (const file of files) {
  const response = await fetch(`${base}${browserUrl(declared, file)}`)
  if (response.status !== 200) {
    missing += 1
    console.log('  MISSING THROUGH ROUTE:', file, response.status)
  }
}
console.log(`artwork reachable through the route: ${files.length - missing}/${files.length}`)

// ---------------------------------------------------------- walk/idle lifecycle
// The pet must switch to "walking" while an agent runs and fall back to idle
// shortly after the last one stops, even if a single notification goes missing.
const readState = async () => (await fetch(`${base}/fritia-pet/state`)).json()
const emit = (event, payload) => {
  for (const pair of [...listenerPairs]) {
    if (pair.event === event) pair.listener(payload)
  }
}
const emitStatus = (id, status) => emit('agent/status', { agent: { id }, status })
const emitDisposed = (id) => emit('agent/disposed', { agent: { id } })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
const check = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(48)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`)
}

console.log('\nwalk lifecycle (walkingWindowMs = 400 in this harness)')
check('idle at rest', (await readState()).working, false)
emitStatus('session-a', 'running')
check('walking after a running agent', (await readState()).working, true)
check('running count reflects the agent', (await readState()).running, 1)
emitStatus('session-a', 'idle')
check('stays walking inside the grace window', (await readState()).working, true)
await wait(600)
check('returns to idle after the grace window', (await readState()).working, false)

console.log('\nresilience to a lost idle notification')
emitStatus('session-a', 'running')
emitStatus('session-c', 'running')
liveAgents.length = 0
liveAgents.push({ id: 'session-a' }) // session-c vanished from the registry
await wait(400)
const afterDispose = await readState()
check('disposed agent is dropped from tracking', afterDispose.trackedAgents, 1)
check('still walking while the live agent works', afterDispose.working, true)
emitStatus('session-a', 'idle')
await wait(700)
check('returns to idle once that agent stops', (await readState()).working, false)
check('tracked set is empty at rest', (await readState()).trackedAgents, 0)

console.log('\nagent/disposed event also clears tracking')
emitStatus('session-a', 'running')
check('walking again', (await readState()).working, true)
emitDisposed('session-a')
await wait(700)
check('idle after disposal without an idle event', (await readState()).working, false)

console.log(failures === 0 ? '\nwalk lifecycle: all checks passed' : `\nwalk lifecycle: ${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1

server.close()
