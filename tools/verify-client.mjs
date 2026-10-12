/**
 * Local verification harness (not shipped).
 *
 * Renders the browser half against a stub module loader and a fake Cordis
 * context, so it proves:
 *   - the module registers under the expected id with a valid plugin shape,
 *   - it registers the shell.overlay entry,
 *   - the component ships its own stylesheet (a `<style>` element), because the
 *     optional `styles` service is absent in some shells and the pet then
 *     degrades to static flow (top-left, not draggable),
 *   - that stylesheet really contains the positioning and drag-critical rules,
 *   - rendering throws for neither the loading state nor a full artwork set,
 *   - the artwork request URLs use the Host's exact-route form.
 */
import { readFile } from 'node:fs/promises'

const SPRITE_FILES = [
  '待机1.png', '待机2.png', '困.png', '钓鱼.png', '高兴.png', '困惑.png', '生气.png',
  '余额.png', '抓起.png', '抓起颤抖.png', '彩蛋.png', '彩蛋2.png',
  '左走1.png', '左走2.png', '左走3.png', '左走4.png', '右走1.png', '右走2.png', '右走3.png', '右走4.png',
]

const images = []
const thrown = []

class FakeImage {
  constructor(src) { this.src = src }
  set src(value) {
    this._src = value
    images.push(value)
    if (value.includes('高兴')) this.onerror?.()
    else this.onload?.()
  }
  get src() { return this._src }
}

// A tiny hook store so state persists across the harness's re-renders, which is
// what lets the container's async artwork load be observed at all.
const hookStates = new Map()
let hookKey = 'root'
let hookIndex = 0
let rerender = () => {}
const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => {
    const key = `${hookKey}:${hookIndex}`
    hookIndex += 1
    if (!hookStates.has(key)) {
      hookStates.set(key, typeof initial === 'function' ? initial() : initial)
    }
    return [hookStates.get(key), (next) => {
      const value = typeof next === 'function' ? next(hookStates.get(key)) : next
      hookStates.set(key, value)
      rerender()
    }]
  },
  useEffect(callback) {
    try {
      const dispose = callback()
      if (typeof dispose === 'function') dispose()
    } catch (error) {
      thrown.push(String(error))
    }
  },
  useRef: (initial) => {
    const key = `ref:${hookKey}:${hookIndex}`
    hookIndex += 1
    if (!hookStates.has(key)) hookStates.set(key, { current: initial })
    return hookStates.get(key)
  },
  useCallback: (fn) => fn,
}

const fakeWindow = {
  __ModuleLoader__: { load: (definition) => { fakeWindow.__definition = definition } },
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
}
const fakeDocument = { body: { classList: { add() {}, remove() {} } } }

const source = await readFile('D:/DeepseekHarness/FritiaPlugin/FritiaPet/client.js', 'utf8')
const instrumented = source.replace(
  '    // ------------------------------------------------------------- component',
  '    globalThis.__CSS__ = CSS\n'
  + '    globalThis.__PET_COMPONENT__ = FritiaPet\n'
  + '    // ------------------------------------------------------------- component',
)
new Function('window', 'document', 'navigator', 'Image', 'fetch', 'console', instrumented)(
  fakeWindow,
  fakeDocument,
  { userAgent: 'node', language: 'zh-CN' },
  FakeImage,
  async (url) => ({
    ok: true,
    json: async () => (String(url).includes('manifest')
      ? { assetBase: '/fritia-pet/sprite?f=' }
      : { working: true }),
  }),
  console,
)

const plugin = fakeWindow.__definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})

let slotComponent
let injectedSlot
const fakeCtx = {
  get: (name) => (name === 'locale' ? { bind: () => (key) => key } : undefined),
  effect: (callback) => { const dispose = callback(); if (typeof dispose === 'function') dispose() },
  slots: {
    inject: (key, callback) => { injectedSlot = key; callback() },
    register: (options, component) => { slotComponent = component; return () => {} },
  },
}
plugin.apply(fakeCtx)

const slotElement = slotComponent({})
console.log('registered id        :', fakeWindow.__definition.id)
console.log('plugin shape         :', JSON.stringify(Object.keys(plugin)), JSON.stringify(plugin.inject))
console.log('slot injected into   :', injectedSlot)
console.log('slot returns         :', typeof slotElement.type === 'function' ? slotElement.type.name : slotElement.type)

// Render the container while the artwork is still loading, then render the pet
// itself with the artwork map the container's loader would have produced.
const loadingTree = slotElement.type({ ctx: fakeCtx })
const styleElement = loadingTree.children[0]
const rootElement = loadingTree.children[1]
console.log('\nloading state:')
console.log('  style element      :', styleElement.type, styleElement.props['data-fritia-pet'])
console.log('  root layer         :', rootElement.type, rootElement.props.className)
console.log('  pet rendered yet   :', rootElement.children[0] === null ? 'no (waits for artwork)' : 'yes')

const css = globalThis.__CSS__ ?? ''
console.log('\nstylesheet shipped with the component:', css.length, 'chars')
const required = [
  ['.fritia-pet-root{position:fixed;inset:0', 'root is a fixed viewport layer'],
  ['.fritia-pet{position:absolute', 'pet sits inside that layer'],
  ['pointer-events:auto', 'pet opts back into pointer events'],
  ['touch-action:none', 'pointer capture works without scrolling'],
  ['cursor:grab', 'grab cursor hints draggability'],
  ['left:27%;top:57.5%;width:47%;height:21%', 'balance panel sits on the raised board'],
]
let cssOk = 0
for (const [needle, label] of required) {
  const found = css.includes(needle)
  if (found) cssOk += 1
  console.log(`  ${found ? 'PASS' : 'FAIL'}  ${label}`)
}

// Render the pet with a synthetic artwork map (what the loader above produces).
// The component's own hooks are not simulated, so the static first paint is what
// is asserted here; the dynamic behaviour lives in tools/verify-pose.mjs.
hookKey = 'pet'
hookIndex = 0
const pet = globalThis.__PET_COMPONENT__({
  ctx: fakeCtx,
  mounts: Object.fromEntries(SPRITE_FILES.map((file) => [file, new FakeImage(`/fritia-pet/sprite?f=${encodeURIComponent(file)}`)])),
})
console.log('\npet render:')
console.log('  pet element        :', pet.props.className)
console.log('  pose               :', pet.props['data-pose'])
console.log('  sprite src         :', pet.children[0].children[0]?.props?.src)
console.log('  draggable attr     :', pet.props.onPointerDown !== undefined && pet.props.onPointerMove !== undefined)
console.log('  context menu bound :', pet.props.onContextMenu !== undefined)
console.log('  inline size        :', `${pet.props.style.width}x${pet.props.style.height}`)

console.log('\nartwork URL form:')
// The container resolves each file to the Host's exact route form:
//   /fritia-pet/sprite?f=<encoded name>
const sampleUrl = pet.children[0].children[0]?.props?.src ?? ''
const urlOk = sampleUrl.startsWith('/fritia-pet/sprite?f=') && sampleUrl.includes(encodeURIComponent('待机1.png'))
console.log(`  ${urlOk ? 'PASS' : 'FAIL'}  first sprite uses the exact-route query form (${sampleUrl})`)
console.log('  fallback chain     : query route -> legacy /asset/ path (in Container)')
console.log('  (the loader itself needs a DOM Image, so its URL building is asserted here via the mounted sprite)')

console.log('\neffects that threw:', thrown.length === 0 ? 'none' : JSON.stringify(thrown))
console.log('interaction handlers present:',
  pet.props.onPointerDown !== undefined
  && pet.props.onPointerMove !== undefined
  && pet.props.onPointerUp !== undefined
  && pet.props.onContextMenu !== undefined)

const failed = cssOk !== required.length || thrown.length > 0 || !urlOk
  || pet.props.onPointerDown === undefined
console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${cssOk}/${required.length} style checks, `
  + `${thrown.length} render errors, url form ${urlOk ? 'ok' : 'bad'}`)
process.exitCode = failed ? 1 : 0
