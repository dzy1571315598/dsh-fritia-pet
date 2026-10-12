/**
 * Local verification harness (not shipped with the plugin runtime).
 *
 * The pet's pose decision is a pure function, so this harness extracts it from
 * `client.js` with a small source transform and drives it with a fake clock and
 * a seeded RNG. That covers the behaviour rules no other harness can reach:
 *
 *   - 待机1 / 待机2 alternate
 *   - 10 s without interaction rolls 50/50 into 困 or 钓鱼, once per idle period
 *   - any interaction resets that timer
 *   - a running action outranks walking, walking outranks idle
 *   - a missing asset falls back to idle instead of blanking the sprite
 */
import { readFile } from 'node:fs/promises'

const source = await readFile('D:/DeepseekHarness/FritiaPlugin/FritiaPet/client.js', 'utf8')
// Surface the pure decision function on globalThis (no production-side export).
const instrumented = source.replace(
  '    // ------------------------------------------------------------- component',
  '    globalThis.__DECIDE__ = decidePose\n'
  + '    globalThis.__DECIDE_CLICK__ = decideClick\n'
  + '    globalThis.__CORNER__ = cornerPos\n'
  + '    globalThis.__DRAG__ = dragPos\n'
  + '    globalThis.__WALKSTOP__ = walkStopPos\n'
  + '    globalThis.__SPRITE__ = SPRITE\n'
  + '    globalThis.__FRAME_MS__ = FRAME_MS\n'
  + '    // ------------------------------------------------------------- component',
)
if (!instrumented.includes('__DECIDE_CLICK__')) {
  console.error('FAIL: could not instrument client.js (anchor comment moved?)')
  process.exit(1)
}

const React = {
  createElement: () => null,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
}
const fakeWindow = { __ModuleLoader__: { load: (definition) => { fakeWindow.__definition = definition } } }
new Function('window', 'document', 'navigator', 'Image', 'fetch', 'console', instrumented)(
  fakeWindow,
  { body: { classList: { add() {}, remove() {} } } },
  { userAgent: 'node', language: 'zh-CN' },
  class {},
  async () => ({ ok: true, json: async () => ({}) }),
  console,
)
// The decision function lives inside the factory closure, which only runs when
// the plugin is materialised; run it so the instrumentation line executes.
fakeWindow.__definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})

const decidePose = globalThis.__DECIDE__
const SPRITE = globalThis.__SPRITE__
const FRAME_MS = globalThis.__FRAME_MS__
if (typeof decidePose !== 'function') {
  console.error('FAIL: decidePose not captured')
  process.exit(1)
}

const ACT_MS = { happy: 1800, confused: 1800, angry: 2200, egg1: 2800, egg2: 2800, sleep: 6000, fishing: 6000 }
const IDLE_ROLL_MS = 10000
const hasSprite = () => true
const table = { idleRollMs: IDLE_ROLL_MS, actMs: ACT_MS }

const makeModel = (overrides = {}) => ({
  pose: 'idle1',
  act: null,
  substate: null,
  lastIdleAt: 0,
  rolled: false,
  walking: false,
  direction: 'right',
  lastFrameAt: 0,
  ...overrides,
})

let passed = 0
let failed = 0
const check = (label, actual, expected) => {
  const ok = actual === expected
  if (ok) passed += 1
  else failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`)
}

// ---------------------------------------------------------------- idle cycle
console.log('\nidle cycle')
{
  const model = makeModel()
  check('t=0.5s -> idle1', decidePose(model, 500, { ...table, hasSprite }).pose, 'idle1')
  check('t=4.5s -> idle2', decidePose(model, 4500, { ...table, hasSprite }).pose, 'idle2')
  check('t=8.5s -> idle1 again', decidePose(model, 8500, { ...table, hasSprite }).pose, 'idle1')
}

// ------------------------------------------------------- the 10s sleep/fishing roll
// ------------------------------------------------------------- tick driver
/**
 * Mirrors the component's tick: expire a finished action (granting a fresh idle
 * period), then decide. The expiry step is the caller's job by design.
 */
const tick = (model, now) => {
  if (model.act !== null && now >= model.act.until) {
    model.act = null
    model.substate = null
    model.lastIdleAt = now
    model.rolled = false
  }
  return decidePose(model, now, { ...table, hasSprite })
}

console.log('\n10 s idle roll')
{
  const model = makeModel()
  tick(model, 9900)
  check('t=9.9s still idle1', tick(model, 9900).pose, 'idle1')

  const realRandom = Math.random
  Math.random = () => 0.2
  const rolled = tick(model, 10000)
  check('t=10s rolls into sleep (p<0.5)', rolled.pose, 'sleep')
  check('roll marks substate=sleep', model.substate, 'sleep')
  check('roll is sticky (rolled=true)', model.rolled, true)
  check('stays in sleep while the act lasts', tick(model, 10100).pose, 'sleep')

  // Past the act deadline the pet returns to the ambient idle cycle and gets a
  // fresh idle period: the roll must NOT restart on the same frame (regression:
  // the expiry used to be checked after the decision, restarting sleep forever,
  // and an act longer than the idle threshold re-armed the roll immediately).
  const until = model.act.until
  const after = tick(model, until)
  check('act expires -> idle cycle', after.pose === 'idle1' || after.pose === 'idle2', true)
  check('expired act cleared', model.act === null, true)
  check('no immediate re-roll on the expiry frame', model.substate, null)
  check('idle period restarts (9.9s later still idle)',
    tick(model, until + 9900).pose === 'idle1' || tick(model, until + 9900).pose === 'idle2', true)
  check('no re-roll before a full idle period', model.substate, null)

  // A full idle period later it rolls again.
  Math.random = () => 0.8
  check('second roll picks fishing (p>=0.5)', tick(model, until + 10000).pose, 'fishing')
  Math.random = realRandom
}

console.log('\nlong idle simulation (the regression above)')
{
  const model = makeModel({ lastIdleAt: 0 })
  const realRandom = Math.random
  Math.random = () => 0.2 // always sleep, if it ever rolls
  const counts = {}
  let previous = null
  const rolls = []
  for (let now = 0; now <= 120000; now += 100) {
    const decision = tick(model, now)
    if (decision.pose !== previous) {
      counts[decision.pose] = (counts[decision.pose] ?? 0) + 1
      if (decision.pose === 'sleep') rolls.push(now)
      previous = decision.pose
    }
  }
  Math.random = realRandom
  // Each cycle is 10s idle + 6s sleep = 16s, so 120s holds 7 complete cycles.
  check('sleep rolls are separated by the full idle period', rolls.every((at, index) => index === 0
    || at - rolls[index - 1] >= 16000), true)
  check('no infinite re-roll (120s -> 7 sleeps)', rolls.length, 7)
}

console.log('\nroll is 50/50')
{
  const picks = []
  const realRandom = Math.random
  for (const value of [0.0, 0.25, 0.49, 0.5, 0.75, 0.99]) {
    Math.random = () => value
    const model = makeModel({ lastIdleAt: 0 })
    picks.push(decidePose(model, 10000, { ...table, hasSprite }).pose)
  }
  Math.random = realRandom
  check('values <0.5 -> sleep', picks.slice(0, 3).every((p) => p === 'sleep'), true)
  check('values >=0.5 -> fishing', picks.slice(3).every((p) => p === 'fishing'), true)
}

console.log('\ninteraction resets the timer')
{
  const model = makeModel({ lastIdleAt: 9500, rolled: false })
  check('at 10s with a fresh touch -> still idle', decidePose(model, 10000, { ...table, hasSprite }).pose, 'idle1')
  model.lastIdleAt = 20000
  const rolled = decidePose(model, 30000, { ...table, hasSprite }).pose
  check('10s after the touch -> rolls', ['sleep', 'fishing'].includes(rolled), true)
  // After the roll the flag is set, so a later tick must not pick a new pose.
  const pose2 = decidePose(model, 30500, { ...table, hasSprite }).pose
  check('no second roll while the first runs', pose2, rolled)
}

// ---------------------------------------------------------------- precedence
console.log('\nprecedence')
{
  const walking = makeModel({ walking: true, direction: 'right' })
  check('walking beats idle (right)', decidePose(walking, 8500, { ...table, hasSprite }).pose, 'walkR')
  walking.direction = 'left'
  check('walking left uses 左走', decidePose(walking, 8500, { ...table, hasSprite }).pose, 'walkL')

  const acting = makeModel({ walking: true, direction: 'right', act: { pose: 'happy', until: 9000 } })
  check('action beats walking', decidePose(acting, 8500, { ...table, hasSprite }).pose, 'happy')

  const grabbing = makeModel({ act: { pose: 'pickedShake', until: 999999 } })
  check('grab pose holds', decidePose(grabbing, 8500, { ...table, hasSprite }).pose, 'pickedShake')
}

console.log('\nframes')
{
  // The pose must already match the wanted walk direction, otherwise the tick
  // legitimately reports a pose change instead of a frame advance.
  const model = makeModel({ pose: 'walkR', walking: true, direction: 'right' })
  check('static frame gap: no advance yet', decidePose(model, 0, { ...table, hasSprite }).advanceFrame, false)
  const frames = decidePose(model, 5000, { ...table, hasSprite })
  check('walk pose advances frames', frames.advanceFrame, true)
  check('walk frame count is 4', frames.frameCount, 4)
  const left = makeModel({ pose: 'walkL', walking: true, direction: 'left' })
  check('left walk also advances frames', decidePose(left, 5000, { ...table, hasSprite }).advanceFrame, true)
}

console.log('\nmissing asset fallback')
{
  const onlyIdle = (name) => name === 'idle1'
  const model = makeModel({ act: { pose: 'egg2', until: 999999 } })
  check('missing 彩蛋2 -> idle1', decidePose(model, 1000, { ...table, hasSprite: onlyIdle }).pose, 'idle1')
  const nothing = () => false
  const bare = makeModel()
  check('nothing available -> keeps the wanted pose', decidePose(bare, 1000, { ...table, hasSprite: nothing }).pose, 'idle1')
}

// ------------------------------------------------------------- click behaviour
const decideClick = globalThis.__DECIDE_CLICK__
if (typeof decideClick !== 'function') {
  console.error('FAIL: decideClick not captured')
  process.exit(1)
}
const CLICK_GAP_MS = 700
const ANGRY_AT_CLICKS = 3
const EGG_CHANCE = 0.1
const clickTable = (random) => ({ clickGapMs: CLICK_GAP_MS, angryAtClicks: ANGRY_AT_CLICKS, eggChance: EGG_CHANCE, random })
const clickModel = () => ({ clicks: 0, lastClickAt: 0, angryBurst: false })

console.log('\nleft click: 高兴 / 困惑')
{
  const model = clickModel()
  const first = decideClick(model, 1000, clickTable(() => 0.3))
  check('one click -> 高兴', first, 'happy')
  const second = decideClick(model, 5000, clickTable(() => 0.8))
  check('click after the burst window -> 困惑', second, 'confused')
  check('burst counter resets after the window', model.clicks, 1)
  const third = decideClick(model, 5100, clickTable(() => 0.3))
  check('clicks inside the window accumulate', model.clicks, 2)
  check('second rapid click still an emotion', third, 'happy')
}

console.log('\nthree rapid clicks -> 生气, once per burst')
{
  const model = clickModel()
  const values = [0.3, 0.3, 0.3, 0.3]
  let index = 0
  const random = () => values[Math.min(index, values.length - 1)]
  check('click 1 -> emotion', decideClick(model, 1000, clickTable(random)), 'happy')
  check('click 2 -> emotion', decideClick(model, 1200, clickTable(random)), 'happy')
  check('click 3 -> 生气', decideClick(model, 1400, clickTable(random)), 'angry')
  check('click 4 stays 生气 without a new trigger', decideClick(model, 1600, clickTable(random)), null)
  check('angryBurst latched', model.angryBurst, true)
  // After the window the counter resets and the burst flag clears.
  check('after the window -> emotion again', decideClick(model, 9000, clickTable(random)), 'happy')
  check('burst flag cleared', model.angryBurst, false)
}

console.log('\neaster egg: 10% per click')
{
  const model = clickModel()
  // First roll decides the egg (0.05 < 0.10), the second picks which one.
  check('below the threshold -> 彩蛋', decideClick(model, 1000, clickTable(() => 0.05)), 'egg1')
  // Each click consumes two rolls: the egg roll then the emotion/egg-kind roll.
  const noEggValues = [0.5, 0.3]
  let noEggIndex = 0
  const noEgg = () => noEggValues[Math.min(noEggIndex++, noEggValues.length - 1)]
  check('above the threshold -> no egg', decideClick(clickModel(), 1000, clickTable(noEgg)), 'happy')

  const rollValues = [0.09, 0.9]
  let index = 0
  const twoStage = () => rollValues[Math.min(index++, rollValues.length - 1)]
  check('the second roll picks 彩蛋2', decideClick(clickModel(), 1000, clickTable(twoStage)), 'egg2')

  // Statistical shape: with a uniform RNG, eggs land near 10%.
  const realRandom = Math.random
  let eggs = 0
  const trials = 20000
  for (let i = 0; i < trials; i += 1) {
    const result = decideClick({ clicks: 0, lastClickAt: 0, angryBurst: false }, i * 10000,
      clickTable(realRandom))
    if (result === 'egg1' || result === 'egg2') eggs += 1
  }
  const rate = eggs / trials
  check(`egg rate ~10% (measured ${(rate * 100).toFixed(2)}%)`, Math.abs(rate - 0.1) < 0.01, true)
}

// ------------------------------------------------------------- position maths
const cornerPos = globalThis.__CORNER__
const dragPos = globalThis.__DRAG__
const walkStopPos = globalThis.__WALKSTOP__

console.log('\nposition maths')
{
  const PAD = 12
  const SIZE = 168
  const corner = cornerPos(SIZE, PAD, 1280, 800)
  check('rest spot is the bottom-right corner', `${corner.left},${corner.top}`, `${1280 - SIZE - PAD},${800 - SIZE - PAD}`)
  check('rest spot uses left/top only', corner.right === null && corner.bottom === null, true)

  const tiny = cornerPos(SIZE, PAD, 100, 100)
  check('tiny viewport clamps to 0', `${tiny.left},${tiny.top}`, '0,0')

  const right = walkStopPos(SIZE, PAD, 'right', 1280)
  const left = walkStopPos(SIZE, PAD, 'left', 1280)
  check('walk right stop hugs the right edge', right.left, 1280 - SIZE - PAD)
  check('walk left stop hugs the left edge', left.left, PAD)

  const dragged = dragPos(SIZE, 600, 400, 20, 30, 1280, 800)
  check('drag follows the pointer offset', `${dragged.left},${dragged.top}`, '580,370')
  const draggedOut = dragPos(SIZE, -50, -50, 20, 30, 1280, 800)
  check('drag clamps above/left of the viewport', `${draggedOut.left},${draggedOut.top}`, '0,0')
  const draggedFar = dragPos(SIZE, 9999, 9999, 0, 0, 1280, 800)
  check('drag clamps past the bottom-right', `${draggedFar.left},${draggedFar.top}`, `${1280 - SIZE},${800 - SIZE}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
console.log('sprite table keys:', Object.keys(SPRITE).length, 'frame tables:', Object.keys(FRAME_MS).length)
process.exitCode = failed === 0 ? 0 : 1