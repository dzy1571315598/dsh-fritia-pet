/**
 * Fritia desk pet — browser half.
 *
 * Behaviour model
 *   idle    : alternates 待机1 / 待机2; 10s without interaction rolls 50/50 into
 *             困 (sleep) or 钓鱼 (fishing)
 *   working : while any Agent works, the pet paces the bottom-right corner with
 *             左走 / 右走 frames and flips direction at the edges
 *   actions : left click -> 高兴 / 困惑, repeated clicks -> 生气,
 *             right click -> 余额 panel with the live DeepSeek account balance,
 *             hold -> 抓起, hold + move -> 抓起颤抖,
 *             every left click has a 10% chance of 彩蛋 / 彩蛋2
 *
 * Assets arrive from the Host half over same-origin HTTP; the balance comes from
 * the generated Remote namespace, with the Host route as a fallback.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-fritia-pet',
  factory(require) {
    const React = require('react')

    // ------------------------------------------------------------- constants
    const ROUTE = '/fritia-pet'
    const SPRITE = {
      idle1: '待机1.png',
      idle2: '待机2.png',
      sleep: '困.png',
      fishing: '钓鱼.png',
      happy: '高兴.png',
      confused: '困惑.png',
      angry: '生气.png',
      balance: '余额.png',
      picked: '抓起.png',
      pickedShake: '抓起颤抖.png',
      egg1: '彩蛋.png',
      egg2: '彩蛋2.png',
      walkL: ['左走1.png', '左走2.png', '左走3.png', '左走4.png'],
      walkR: ['右走1.png', '右走2.png', '右走3.png', '右走4.png'],
    }
    const FRAME_MS = {
      idle1: 620, idle2: 620, sleep: 900, fishing: 900, balance: 900,
      happy: 420, confused: 420, angry: 300,
      picked: 700, pickedShake: 120, egg1: 420, egg2: 420, walkL: 160, walkR: 160,
    }
    const ACT_MS = {
      happy: 1800, confused: 1800, angry: 2200, egg1: 2800, egg2: 2800,
      sleep: 6000, fishing: 6000,
    }
    const LONG_PRESS_MS = 260
    const CLICK_GAP_MS = 700
    const ANGRY_AT_CLICKS = 3
    const EGG_CHANCE = 0.1
    const IDLE_ROLL_MS = 10000
    // One walk leg: glide from one stop to the other. This is the pace control —
    // the transition duration and the direction-flip interval are the same value.
    const WALK_LEG_MS = 4800
    const GAP = 12
    const PET_SIZE = 168
    // A working stamp older than this means the Host's snapshot is stale (a
    // dropped idle notification), so the pet stops walking instead of forever.
    const WORK_STALE_MS = 90000
    const WALK_TRANSITION = `left ${WALK_LEG_MS}ms linear, top .35s ease`

    // ------------------------------------------------------------- host calls
    const hostFetch = async (route) => {
      const response = await fetch(route, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    const clientMeta = () => ({
      version: '1.0.0',
      locale: (navigator.language || 'zh-CN').replace('_', '-'),
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })

    /** The account balance through the generated Remote namespace. */
    const remoteBalance = async (ctx) => {
      const remote = ctx.get('remote')
      if (remote === undefined || remote === null) throw new Error('Remote 通道未就绪')
      const namespaces = ['deepseekAccount', 'accountController', 'deepseekAccountController']
      let lastError
      for (const namespace of namespaces) {
        const api = remote[namespace]
        if (api?.getBalance === undefined) continue
        try {
          const wallets = await api.getBalance(clientMeta())
          if (wallets === null) throw new Error('未登录 DeepSeek 账号')
          return Array.isArray(wallets) ? wallets : []
        } catch (error) {
          lastError = error
        }
      }
      throw lastError ?? new Error('当前 Host 未暴露余额接口')
    }

    const isDesktopClient = () =>
      /Electron/i.test(navigator.userAgent) || typeof window.dshDesktop !== 'undefined'

    const fetchBalance = async (ctx) => {
      let remoteFailure
      try {
        return await remoteBalance(ctx)
      } catch (error) {
        remoteFailure = error
      }
      try {
        const meta = clientMeta()
        const query = new URLSearchParams({
          v: meta.version,
          locale: meta.locale,
          tz: String(meta.timezoneOffsetSeconds),
        })
        const data = await hostFetch(`${ROUTE}/balance?${query.toString()}`)
        if (Array.isArray(data.wallets)) return data.wallets
        // Tolerate the unwrapped AccountDetails shape as well.
        const wallets = data?.balance?.status === 'ready'
          ? [...data.balance.value, ...(data.balance.bonusWallets ?? [])]
          : null
        if (Array.isArray(wallets)) return wallets
        throw new Error(data.message ?? '余额接口未返回数据')
      } catch (hostError) {
        // Inside the desktop shell a page fetch may be blocked, so the Remote
        // error is the more useful one to surface there.
        throw isDesktopClient() ? remoteFailure : hostError
      }
    }

    /** Platform sends long decimals ("10.0000000000000000"); show a tidy amount. */
    const formatAmount = (value) => {
      const text = String(value)
      if (!/^-?\d+(\.\d+)?$/.test(text)) return text
      const rounded = Number(text)
      if (!Number.isFinite(rounded)) return text
      return rounded.toFixed(2).replace(/\.00$/, '')
    }

    /** Returns the primary wallet line and an optional bonus line. */
    const formatWallets = (wallets) => {
      if (!wallets || wallets.length === 0) return { text: '暂无余额', bonus: '' }
      const symbolOf = (wallet) => (wallet.currency === 'USD' ? '$' : '¥')
      const primary = wallets[0]
      const text = `${symbolOf(primary)}${formatAmount(primary.balance)}`
      const bonusWallets = wallets.slice(1)
      const bonus = bonusWallets.length === 0
        ? ''
        : `赠送 ${bonusWallets.map((wallet) => `${symbolOf(wallet)}${formatAmount(wallet.balance)}`).join(' ')}`
      return { text, bonus }
    }

    // ------------------------------------------------------------- styles
    // Rendered as a `<style>` element by the component, not inserted through the
    // optional `styles` service: that service is absent in some shells, and
    // without these rules the pet degrades to static flow (top-left, unscaled,
    // and not draggable).
    const CSS = `
.fritia-pet-root{position:fixed;inset:0;z-index:60;pointer-events:none}
.fritia-pet{position:absolute;pointer-events:auto;user-select:none;-webkit-user-select:none;
  touch-action:none;cursor:grab;display:flex;align-items:flex-end;justify-content:center;
  filter:drop-shadow(0 6px 12px rgba(0,0,0,.28))}
.fritia-pet[data-dragging="true"]{cursor:grabbing}
.fritia-pet__sprite{position:relative;display:block;width:100%;height:100%}
.fritia-pet__sprite img{display:block;width:100%;height:100%;pointer-events:none;
  animation:fritia-pet-bob 2.6s ease-in-out infinite}
.fritia-pet[data-pose="walkL"] .fritia-pet__sprite img,
.fritia-pet[data-pose="walkR"] .fritia-pet__sprite img{animation-duration:.8s}
@keyframes fritia-pet-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@media (prefers-reduced-motion:reduce){.fritia-pet__sprite img{animation:none}}
.fritia-pet__panel{position:absolute;left:27%;top:57.5%;width:47%;height:21%;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;
  text-align:center;pointer-events:none;color:#6b5560}
.fritia-pet__panel-label{font-size:8px;line-height:1.1;opacity:.75;letter-spacing:.04em}
.fritia-pet__panel-value{font-size:11px;line-height:1.15;font-weight:700;
  font-variant-numeric:tabular-nums;color:#4a3a42}
.fritia-pet__panel-value--error{font-size:9px;color:#a4444a;font-weight:600}
.fritia-pet__panel-bonus{font-size:8px;line-height:1.1;font-weight:600;color:#b08a5a;
  font-variant-numeric:tabular-nums}
.fritia-pet__hint{position:absolute;right:0;top:-20px;padding:2px 8px;border-radius:999px;
  white-space:nowrap;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;
  background:var(--dsw-alias-bg-overlay,#fff);
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));
  color:var(--dsw-alias-label-secondary,#64748b);box-shadow:0 2px 8px rgba(0,0,0,.12);
  pointer-events:none}
body.fritia-pet--dragging{cursor:grabbing!important}
`

    /**
     * Pure pose decision for one animation tick. The caller expires a finished
     * action first (`model.act = null`), so this function never has to reason
     * about an action that just ended.
     *
     * Order of precedence: a running action (click reaction, grab) beats walking,
     * walking beats the idle cycle. A missing asset falls back to idle so one bad
     * file can never blank the slot.
     */
    const decidePose = (model, now, options) => {
      const { hasSprite, idleRollMs, actMs } = options

      if (
        model.act === null && !model.walking && model.substate === null
        && !model.rolled && now - model.lastIdleAt >= idleRollMs
      ) {
        model.rolled = true
        const pick = Math.random() < 0.5 ? 'sleep' : 'fishing'
        model.substate = pick
        model.act = { pose: pick, until: now + actMs[pick] }
      }

      let wanted
      if (model.act !== null) wanted = model.act.pose
      else if (model.walking) wanted = model.direction === 'left' ? 'walkL' : 'walkR'
      else wanted = model.substate ?? (Math.floor(now / 4000) % 2 === 0 ? 'idle1' : 'idle2')

      if (!hasSprite(wanted)) wanted = hasSprite('idle1') ? 'idle1' : wanted

      const files = SPRITE[wanted]
      const frameCount = Array.isArray(files) ? files.length : 1
      if (wanted !== model.pose) {
        return { pose: wanted, changed: true, advanceFrame: false, frameCount }
      }
      return {
        pose: wanted,
        changed: false,
        advanceFrame: frameCount > 1 && now - model.lastFrameAt >= (FRAME_MS[wanted] ?? 400),
        frameCount,
      }
    }

    /**
     * Pure decision for one left click.
     *
     * Rapid clicks accumulate; the third click inside the burst window triggers
     * 生气 once, and every other click rolls an independent 10% chance of an
     * easter egg before falling back to 高兴 / 困惑.
     */
    const decideClick = (model, now, options) => {
      const { clickGapMs, angryAtClicks, eggChance, random } = options
      model.clicks = now - model.lastClickAt <= clickGapMs ? model.clicks + 1 : 1
      model.lastClickAt = now
      if (model.clicks < angryAtClicks) model.angryBurst = false

      if (model.clicks >= angryAtClicks) {
        if (model.angryBurst) return null
        model.angryBurst = true
        return 'angry'
      }
      if (random() < eggChance) return random() < 0.5 ? 'egg1' : 'egg2'
      return random() < 0.5 ? 'happy' : 'confused'
    }

    /**
     * Pure position maths for the pet layer.
     *
     * `size` is the sprite box; the resting spot and the two walk stops are
     * clamped into the viewport so a small window can never push the pet off
     * screen. Kept free of React and the DOM so `tools/verify-pose.mjs` can drive it.
     */
    const clampAxis = (value, max) => Math.min(Math.max(value, 0), Math.max(0, max))

    const cornerPos = (size, gap, viewportWidth, viewportHeight) => ({
      left: clampAxis(viewportWidth - size - gap, viewportWidth - size),
      top: clampAxis(viewportHeight - size - gap, viewportHeight - size),
      right: null,
      bottom: null,
    })

    const dragPos = (size, pointerX, pointerY, offsetX, offsetY, viewportWidth, viewportHeight) => ({
      left: clampAxis(pointerX - offsetX, viewportWidth - size),
      top: clampAxis(pointerY - offsetY, viewportHeight - size),
      right: null,
      bottom: null,
    })

    const walkStopPos = (size, gap, direction, viewportWidth) => ({
      left: direction === 'left' ? gap : clampAxis(viewportWidth - size - gap, viewportWidth - size),
      right: null,
    })

    // ------------------------------------------------------------- component
    function FritiaPet(props) {
      const { ctx, mounts } = props
      const translate = (key, fallback) => {
        try {
          const bind = ctx.get('locale')?.bind?.('dsh-fritia-pet')
          const value = bind?.(key)
          return typeof value === 'string' && value !== '' && value !== key ? value : fallback
        } catch {
          return fallback
        }
      }

      const [pose, setPose] = React.useState('idle1')
      const [frame, setFrame] = React.useState(0)
      // Rest at the bottom-right of the viewport. The resting spot is resolved to
      // explicit left/top on mount so that dragging, edge flipping and the walk
      // loop all speak the same coordinate system.
      const [pos, setPos] = React.useState(() => ({
        right: GAP,
        bottom: GAP,
        left: null,
        top: null,
      }))
      const [dragging, setDragging] = React.useState(false)
      const [working, setWorking] = React.useState(false)
      const [balanceOpen, setBalanceOpen] = React.useState(false)
      const [balance, setBalance] = React.useState({ status: 'idle' })

      // Behaviour state lives in a ref: timers and pointer handlers mutate it
      // without re-rendering on every keystroke of the state machine.
      const model = React.useRef({
        pose: 'idle1',
        act: null,          // { pose, until }
        substate: null,     // 'sleep' | 'fishing' | null
        lastIdleAt: Date.now(),
        rolled: false,
        walking: false,
        direction: 'right',
        lastFrameAt: 0,
        clicks: 0,
        lastClickAt: 0,
        angryBurst: false,
        dragMode: null,     // null | 'hold' | 'drag'
        startPoint: null,
        offset: null,
        moved: false,
        size: PET_SIZE,
      }).current

      const hasSprite = React.useCallback((name) => {
        const file = SPRITE[name]
        if (Array.isArray(file)) return file.every((f) => mounts?.[f] instanceof HTMLImageElement)
        return mounts?.[file] instanceof HTMLImageElement
      }, [mounts])

      const touchIdle = React.useCallback(() => {
        model.lastIdleAt = Date.now()
        model.rolled = false
      }, [model])

      const startAct = React.useCallback((name, ms) => {
        model.act = { pose: name, until: Date.now() + ms }
        model.substate = null
        touchIdle()
      }, [model, touchIdle])

      // ---- sprite selection and frame advance
      React.useEffect(() => {
        const id = setInterval(() => {
          const now = Date.now()
          // Expire a finished action first, clearing its sub-state and granting a
          // fresh idle period: an act may outlast the idle threshold, and without
          // this reset the pet would re-roll into sleep/fishing on the very frame
          // the previous one ended.
          if (model.act !== null && now >= model.act.until) {
            model.act = null
            model.substate = null
            model.lastIdleAt = now
            model.rolled = false
          }
          const decision = decidePose(model, now, { hasSprite, idleRollMs: IDLE_ROLL_MS, actMs: ACT_MS })

          if (decision.changed) {
            model.pose = decision.pose
            model.lastFrameAt = now
            setPose(decision.pose)
            setFrame(0)
            return
          }
          if (decision.advanceFrame) {
            model.lastFrameAt = now
            setFrame((value) => (value + 1) % decision.frameCount)
          }
        }, 60)
        return () => clearInterval(id)
      }, [hasSprite, model])

      // ---- walking driven by the Harness work state
      React.useEffect(() => {
        let cancelled = false
        const poll = async () => {
          try {
            const data = await hostFetch(`${ROUTE}/state`)
            if (cancelled) return
            // The Host reports a stamp for the last `running` transition: if it is
            // stale while still claiming work, treat it as idle. That bounds the
            // walk even when an `idle` notification is lost.
            const stamp = Number(data?.since)
            const stale = Number.isFinite(stamp) && Date.now() - stamp > WORK_STALE_MS
            setWorking(Boolean(data?.working) && !stale)
          } catch {
            /* Host route unavailable: stay idle. */
          }
        }
        poll()
        const id = setInterval(poll, 900)
        return () => {
          cancelled = true
          clearInterval(id)
        }
      }, [])

      React.useEffect(() => {
        model.walking = working
        if (working) touchIdle()
      }, [working, model, touchIdle])

      // Walk loop: glide between the two corner stops with the CSS transition.
      React.useEffect(() => {
        if (!working) return undefined
        const step = () => {
          if (model.dragMode !== null || model.act !== null) return
          model.direction = model.direction === 'left' ? 'right' : 'left'
          setPos((previous) => ({
            ...previous,
            ...walkStopPos(model.size, GAP, model.direction, window.innerWidth),
          }))
        }
        step()
        const id = setInterval(step, WALK_LEG_MS)
        return () => clearInterval(id)
      }, [working, model])
      // ---- resting position: bottom-right of the viewport, kept on screen
      React.useEffect(() => {
        const place = () => setPos((previous) => {
          const base = previous.left === null
            ? cornerPos(model.size, GAP, window.innerWidth, window.innerHeight)
            : previous
          return {
            left: clampAxis(base.left ?? 0, window.innerWidth - model.size),
            top: clampAxis(base.top ?? 0, window.innerHeight - model.size),
            right: null,
            bottom: null,
          }
        })
        place()
        window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
      }, [model])

      // ---- balance
      const openBalance = React.useCallback(async () => {
        setBalance({ status: 'loading' })
        try {
          const wallets = await fetchBalance(ctx)
          const formatted = formatWallets(wallets)
          setBalance({ status: 'ready', text: formatted.text, bonus: formatted.bonus })
        } catch (error) {
          setBalance({
            status: 'error',
            text: error instanceof Error ? error.message : '余额获取失败',
            bonus: '',
          })
        }
      }, [ctx])

      // ---- pointer interaction
      const onPointerDown = (event) => {
        if (event.button !== 0) return
        // Anchor the drag to left/top immediately, so every later move and the
        // walk loop speak the same coordinate system.
        const rect = event.currentTarget.getBoundingClientRect()
        setPos({ left: rect.left, top: rect.top, right: null, bottom: null })
        event.currentTarget.setPointerCapture?.(event.pointerId)
        model.startPoint = { x: event.clientX, y: event.clientY }
        model.offset = { x: event.clientX - rect.left, y: event.clientY - rect.top }
        model.moved = false
        model.dragMode = null
        clearTimeout(model.holdTimer)
        model.holdTimer = setTimeout(() => {
          if (model.moved) return
          model.dragMode = 'hold'
          setDragging(true)
          document.body.classList.add('fritia-pet--dragging')
          startAct('picked', 600000)
        }, LONG_PRESS_MS)
        touchIdle()
      }

      const onPointerMove = (event) => {
        if (model.startPoint === null) return
        const dx = event.clientX - model.startPoint.x
        const dy = event.clientY - model.startPoint.y
        if (!model.moved && Math.hypot(dx, dy) > 5) {
          model.moved = true
          clearTimeout(model.holdTimer)
          model.dragMode = 'drag'
          setDragging(true)
          document.body.classList.add('fritia-pet--dragging')
          startAct('pickedShake', 600000)
        }
        if (model.dragMode !== null) {
          setPos(dragPos(
            model.size,
            event.clientX,
            event.clientY,
            model.offset.x,
            model.offset.y,
            window.innerWidth,
            window.innerHeight,
          ))
        }
      }

      const handleClick = () => {
        const now = Date.now()
        const pose = decideClick(model, now, {
          clickGapMs: CLICK_GAP_MS,
          angryAtClicks: ANGRY_AT_CLICKS,
          eggChance: EGG_CHANCE,
          random: Math.random,
        })
        if (pose !== null) startAct(pose, ACT_MS[pose])
      }

      const endPointer = (event) => {
        clearTimeout(model.holdTimer)
        const mode = model.dragMode
        const engaged = mode !== null || model.moved
        model.startPoint = null
        if (mode !== null) {
          model.dragMode = null
          setDragging(false)
          document.body.classList.remove('fritia-pet--dragging')
          startAct('idle1', 400)
        }
        touchIdle()
        if (engaged) {
          event.currentTarget.releasePointerCapture?.(event.pointerId)
          return
        }
        handleClick()
      }

      const onContextMenu = (event) => {
        event.preventDefault()
        if (balanceOpen) {
          setBalanceOpen(false)
          startAct('idle1', 400)
        } else {
          setBalanceOpen(true)
          startAct('balance', 600000)
          openBalance()
        }
      }

      // Latest state, published for diagnostics and for a connected browser to
      // inspect (a support hook, not behaviour).
      React.useEffect(() => {
        try {
          window.__FRITIA_PET__ = {
            pose,
            frame,
            working,
            balanceOpen,
            balance: balance.status,
            position: pos,
            updatedAt: Date.now(),
          }
        } catch {
          /* diagnostics must never break the pet */
        }
      }, [pose, frame, working, balanceOpen, balance.status, pos])

      const files = SPRITE[pose]
      const file = Array.isArray(files) ? files[Math.min(frame, files.length - 1)] : files
      const src = mounts?.[file]?.src ?? mounts?.idle1?.src

      const style = {
        right: pos.right === null ? 'auto' : pos.right,
        bottom: pos.bottom === null ? 'auto' : pos.bottom,
        left: pos.left === null ? 'auto' : pos.left,
        top: pos.top === null ? 'auto' : pos.top,
        width: PET_SIZE,
        height: PET_SIZE,
        transition: dragging ? 'none' : WALK_TRANSITION,
      }

      const value = balance.status === 'ready' ? balance.text
        : balance.status === 'loading' ? '...'
          : balance.status === 'error' ? '读取失败'
            : '--'

      return React.createElement(
        'div',
        {
          className: 'fritia-pet',
          style,
          'data-pose': pose,
          'data-dragging': dragging ? 'true' : 'false',
          role: 'img',
          'aria-label': translate('pet.label', 'Fritia 桌宠'),
          title: translate('pet.hint', '左键互动 · 右键查看余额 · 长按/拖动可以抓起'),
          onPointerDown,
          onPointerMove,
          onPointerUp: endPointer,
          onPointerCancel: endPointer,
          onContextMenu,
        },
        React.createElement(
          'div',
          { className: 'fritia-pet__sprite' },
          src === undefined ? null : React.createElement('img', { src, alt: '', draggable: false }),
          pose === 'balance'
            ? React.createElement(
              'div',
              { className: 'fritia-pet__panel' },
              React.createElement('div', { className: 'fritia-pet__panel-label' },
                translate('pet.balanceLabel', '余额')),
              React.createElement('div', {
                className: balance.status === 'error'
                  ? 'fritia-pet__panel-value fritia-pet__panel-value--error'
                  : 'fritia-pet__panel-value',
              }, value),
              balance.status === 'ready' && balance.bonus
                ? React.createElement('div', { className: 'fritia-pet__panel-bonus' }, balance.bonus)
                : null,
            )
            : null,
        ),
        balanceOpen
          ? null
          : React.createElement('div', { className: 'fritia-pet__hint' },
            translate('pet.hintShort', '右键看余额')),
      )
    }

    // ------------------------------------------------------------- container
    function Container(props) {
      const { ctx } = props
      const [mounts, setMounts] = React.useState(null)

      React.useEffect(() => {
        let cancelled = false
        const load = async () => {
          try {
            const manifest = await hostFetch(`${ROUTE}/manifest.json`)
            const declared = typeof manifest.assetBase === 'string' ? manifest.assetBase : undefined
            const spriteUrl = (assetBase, file) => (assetBase === undefined
              ? `${ROUTE}/sprite?f=${encodeURIComponent(file)}`
              : `${assetBase}${encodeURIComponent(file)}`)
            const legacyUrl = (file) => `${ROUTE}/asset/${encodeURIComponent(file)}`
            const wanted = new Set()
            for (const value of Object.values(SPRITE)) {
              if (Array.isArray(value)) for (const file of value) wanted.add(file)
              else wanted.add(value)
            }
            const loaded = await Promise.all([...wanted].map((file) => new Promise((resolve) => {
              const image = new Image()
              const sources = [spriteUrl(declared, file), legacyUrl(file)]
              let index = 0
              image.onload = () => resolve([file, image])
              image.onerror = () => {
                index += 1
                if (sources[index] === undefined) {
                  resolve([file, null])
                  return
                }
                image.src = sources[index]
              }
              image.src = sources[0]
            })))
            if (cancelled) return
            const next = {}
            for (const [file, image] of loaded) if (image !== null) next[file] = image
            setMounts(next)
          } catch {
            if (!cancelled) setMounts({})
          }
        }
        load()
        return () => {
          cancelled = true
        }
      }, [])

      // The stylesheet travels with the component: the optional `styles` service
      // is not present in every shell, and without these rules the pet falls back
      // to static flow (top-left, unscaled, not draggable). The root layer is
      // always mounted so the styles exist even while the artwork loads.
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('style', { 'data-fritia-pet': 'styles', dangerouslySetInnerHTML: { __html: CSS } }),
        React.createElement(
          'div',
          { className: 'fritia-pet-root' },
          mounts === null ? null : React.createElement(FritiaPet, { ctx, mounts }),
        ),
      )
    }

    // ------------------------------------------------------------- plugin
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'fritia-pet', order: 60, label: () => 'Fritia 桌宠' },
          (slotProps) => React.createElement(Container, { ctx, ...slotProps }),
        ))
      },
    }
  },
})
