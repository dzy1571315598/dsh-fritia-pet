/**
 * Fritia desk pet — Host half.
 *
 * Responsibilities (deliberately small):
 *   1. Serve the pet artwork and its metadata to the browser half over
 *      same-origin HTTP (`/fritia-pet/...`), so the client needs no asset
 *      bundling and no knowledge of Host paths.
 *   2. Track whether any Agent is working, from the Cordis `agent/status`
 *      event, and expose it as JSON so the pet walks while the Harness works.
 *
 * The browser half owns all pet behaviour and reads the DeepSeek account
 * balance through the generated Remote namespace.
 */
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const name = 'dsh-fritia-pet'

/** Optional services: the pet degrades instead of failing when one is absent. */
export const inject = ['webServer', 'deepseekAccount', 'agents']

/**
 * Config is optional: schemastery is borrowed from the Host's own module graph
 * when it resolves, and the plain default object is used otherwise. Either way
 * `apply` coerces and defaults every field, so a missing dependency cannot
 * prevent activation.
 */
export const Config = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Schema = globalThis.require?.('@deepseek-ai/schemastery')
    if (Schema?.object === undefined) return undefined
    return Schema.object({
      routePrefix: Schema.string().default('/fritia-pet'),
      assetDir: Schema.string().default('sprites'),
      walkingWindowMs: Schema.number().default(3000),
      reconcileMs: Schema.number().default(5000),
    })
  } catch {
    return undefined
  }
})()

const DEFAULTS = {
  routePrefix: '/fritia-pet',
  assetDir: 'sprites',
  // How long the pet keeps walking after the last `running` agent stops. Deliberately
  // short: it only smooths the gap between two turns, and a longer tail reads as
  // "the pet never stops when the conversation ends".
  walkingWindowMs: 3000,
  // How often live agents are compared against the tracked statuses, so a lost
  // `idle` notification (or a disposed agent) cannot keep the pet walking.
  reconcileMs: 5000,
}

export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  const prefix = options.routePrefix.startsWith('/') ? options.routePrefix : `/${options.routePrefix}`
  const assetRoot = path.resolve(HERE, options.assetDir)

  // ---------------------------------------------------------------- work state
  // Per-agent status map instead of a counter: a duplicated or dropped notification
  // can no longer leave the pet walking forever.
  const agentStatus = new Map()
  const state = { working: false, since: Date.now(), lastRunningAt: Date.now() }
  let graceTimer

  const anyRunning = () => {
    for (const status of agentStatus.values()) if (status === 'running') return true
    return false
  }

  const clearGrace = () => {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer)
      graceTimer = undefined
    }
  }
  const armGrace = () => {
    clearGrace()
    graceTimer = setTimeout(() => {
      state.working = false
      graceTimer = undefined
    }, options.walkingWindowMs)
    if (typeof graceTimer.unref === 'function') graceTimer.unref()
  }

  const applyStatus = () => {
    if (anyRunning()) {
      state.working = true
      state.since = Date.now()
      clearGrace()
      return
    }
    if (state.working) armGrace()
  }

  ctx.effect(() => {
    const offStatus = ctx.on('agent/status', (payload) => {
      const id = payload?.agent?.id
      if (id === undefined || id === null) return
      const key = String(id)
      // Only running agents need tracking: an idle agent is not evidence of work,
      // and dropping it here keeps the tracked set from growing forever.
      if (payload.status === 'running') agentStatus.set(key, 'running')
      else agentStatus.delete(key)
      applyStatus()
    })
    const offDisposed = ctx.on('agent/disposed', (payload) => {
      const id = payload?.agent?.id
      if (id === undefined || id === null) return
      agentStatus.delete(String(id))
      applyStatus()
    })
    return () => {
      offStatus?.()
      offDisposed?.()
      clearGrace()
      agentStatus.clear()
    }
  }, 'fritia-pet: agent status')

  // Reconcile with the live agent registry: drop entries for agents that no longer
  // exist, which is what recovers from a status notification that never arrived.
  ctx.effect(() => {
    const reconcile = () => {
      const service = ctx.get('agents')
      if (service === undefined || agentStatus.size === 0) return
      const live = new Set()
      try {
        for (const agent of service.list()) live.add(String(agent.id))
      } catch {
        return
      }
      let changed = false
      for (const id of [...agentStatus.keys()]) {
        if (!live.has(id)) {
          agentStatus.delete(id)
          changed = true
        }
      }
      if (changed) applyStatus()
    }
    const id = setInterval(reconcile, options.reconcileMs)
    if (typeof id.unref === 'function') id.unref()
    return () => {
      clearInterval(id)
      clearGrace()
    }
  }, 'fritia-pet: agent reconcile')

  // ---------------------------------------------------------------- HTTP surface
  const send = (res, status, body, type) => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': type.startsWith('image/') ? 'public, max-age=86400' : 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  }

  let assetNamesPromise
  const assetNames = () => {
    if (assetNamesPromise === undefined) {
      assetNamesPromise = readdir(assetRoot)
        .then((names) => names.filter((n) => n.toLowerCase().endsWith('.png')))
        .catch(() => [])
    }
    return assetNamesPromise
  }

  ctx.effect(() => {
    const disposers = []

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${prefix}/manifest.json`,
      handler: async (req, res) => {
        send(res, 200, JSON.stringify({
          prefix,
          // Exact route + query parameter: see the artwork route comment below.
          assetBase: `${prefix}/sprite?f=`,
          sprites: await assetNames(),
        }), 'application/json; charset=utf-8')
      },
    }))

    // Self-check for the running Host: open this URL to see whether the artwork
    // route actually answers, without digging through logs.
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${prefix}/health`,
      handler: async (req, res) => {
        const names = await assetNames()
        const probe = names.includes('待机1.png') ? '待机1.png' : names[0]
        let artwork = { file: probe, status: 'no-assets' }
        if (probe !== undefined) {
          try {
            artwork = { file: probe, status: 'ok', bytes: (await readFile(path.join(assetRoot, probe))).length }
          } catch (error) {
            artwork = { file: probe, status: 'unreadable', error: String(error) }
          }
        }
        send(res, 200, JSON.stringify({
          plugin: 'dsh-fritia-pet',
          version: '1.0.0',
          assetRoot,
          assetCount: names.length,
          artworkRoute: `${prefix}/sprite`,
          artworkBase: `${prefix}/sprite?f=`,
          artwork,
          state: {
            working: state.working,
            running: [...agentStatus.values()].filter((s) => s === 'running').length,
            trackedAgents: agentStatus.size,
          },
          accountService: ctx.deepseekAccount === undefined ? 'unavailable' : 'available',
        }), 'application/json; charset=utf-8')
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${prefix}/state`,
      handler: (req, res) => {
        send(res, 200, JSON.stringify({
          working: state.working,
          running: [...agentStatus.values()].filter((s) => s === 'running').length,
          trackedAgents: agentStatus.size,
          since: state.since,
          serverTime: Date.now(),
        }), 'application/json; charset=utf-8')
      },
    }))

    // Balance fallback for the browser half, which cannot reach the Host-only
    // account service directly. Same-origin page traffic only.
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${prefix}/balance`,
      handler: async (req, res) => {
        const headers = req.headers ?? {}
        const site = String(headers['sec-fetch-site'] ?? '')
        if (site !== '' && site !== 'same-origin' && site !== 'none') {
          send(res, 403, JSON.stringify({ message: '仅允许同源请求' }), 'application/json; charset=utf-8')
          return
        }
        let query = new URLSearchParams()
        try {
          query = new URL(req.url ?? '/', 'http://localhost').searchParams
        } catch {
          /* keep the empty query */
        }
        const locale = query.get('locale') ?? 'zh-CN'
        const timezoneOffsetSeconds = Number(query.get('tz'))
        const client = {
          version: query.get('v') ?? '1.0.0',
          locale,
          timezoneOffsetSeconds: Number.isFinite(timezoneOffsetSeconds)
            ? timezoneOffsetSeconds
            : -new Date().getTimezoneOffset() * 60,
        }
        const account = ctx.deepseekAccount
        if (account === undefined) {
          send(res, 503, JSON.stringify({ message: '账号服务不可用' }), 'application/json; charset=utf-8')
          return
        }
        try {
          const wallets = await account.getBalance(client)
          if (wallets === null) {
            send(res, 200, JSON.stringify({ wallets: [], message: '未登录 DeepSeek 账号' }),
              'application/json; charset=utf-8')
            return
          }
          const ready = wallets.status === 'ready' ? wallets : undefined
          send(res, 200, JSON.stringify({
            wallets: ready?.value ?? [],
            bonusWallets: ready?.bonusWallets ?? [],
          }), 'application/json; charset=utf-8')
        } catch (error) {
          send(res, 502, JSON.stringify({
            message: error instanceof Error ? error.message : '余额读取失败',
          }), 'application/json; charset=utf-8')
        }
      },
    }))

    // NOTE: the Host Web server does not route `kind: 'prefix'` registrations for
    // this plugin (every prefix request fell through to the SPA fallback), so the
    // artwork route is exact and carries the file name in a query parameter.
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${prefix}/sprite`,
      handler: async (req, res) => {
        const requestUrl = req.url ?? '/'
        let name = ''
        // Accept both route shapes used across plugin generations: the current
        // query form (`?f=`) and the earlier path form (`/asset/<name>`), and fall
        // back to the request path when the query is absent.
        try {
          name = new URL(requestUrl, 'http://localhost').searchParams.get('f') ?? ''
        } catch {
          const query = requestUrl.slice(requestUrl.indexOf('?') + 1)
          name = new URLSearchParams(query).get('f') ?? ''
        }
        if (name === '') {
          const pathOnly = requestUrl.split('?')[0]
          name = pathOnly.slice(pathOnly.lastIndexOf('/') + 1)
        }
        try {
          name = decodeURIComponent(name)
        } catch {
          /* keep the raw value; the containment check decides */
        }
        // Reduce to a bare file name so a full request target cannot fail the
        // containment test, then verify it really is one.
        name = name.split('/').pop() ?? name
        // Containment: the requested name must stay inside the asset directory.
        if (
          name === ''
          || name.includes('/')
          || name.includes('\\')
          || name.includes('\0')
          || path.basename(name) !== name
          || !name.toLowerCase().endsWith('.png')
        ) {
          send(res, 400, 'bad asset name', 'text/plain; charset=utf-8')
          return
        }
        try {
          send(res, 200, await readFile(path.join(assetRoot, name)), 'image/png')
        } catch (error) {
          ctx.logger?.warn?.('fritia-pet: asset miss %s (%s) under %s', name, String(error), assetRoot)
          send(res, 404, 'asset not found', 'text/plain; charset=utf-8')
        }
      },
    }))

    return () => {
      for (const dispose of disposers) dispose?.()
    }
  }, 'fritia-pet: routes')
}
