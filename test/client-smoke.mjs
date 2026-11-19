/**
 * Client 冒烟测试：不碰浏览器，只验客户端半边“接线”对不对。
 *
 *   node test/client-smoke.mjs
 *
 * 检查：工厂 id、apply/inject 形状、词典覆盖组件用到的每个 key、
 * 以及注册到 `conversation.header.leading` 的那一次 register 参数。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'client.js'), 'utf8')

// 用一个假的 window.__ModuleLoader__ 接住工厂，不真的执行浏览器侧逻辑。
let captured
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => { captured = spec },
  },
}

/** 最小 React 替身：工厂只会在 materialize 时用到它。 */
const reactStub = {
  createElement: () => null,
  Fragment: Symbol('fragment'),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
}
const requireStub = (id) => {
  if (id === 'react') return reactStub
  throw new Error(`unexpected require: ${id}`)
}

// 直接跑脚本源码（它只有 window.__ModuleLoader__.load 一次调用）。
new Function('window', source)(globalThis.window)

assert.ok(captured, '客户端模块应向 __ModuleLoader__ 注册')
assert.equal(captured.id, 'dsh-power-control', '工厂 id 必须等于包名')

const moduleExports = captured.factory(requireStub)
assert.equal(typeof moduleExports.apply, 'function')
assert.deepEqual(moduleExports.inject, ['slots', 'locale'])

// 假的 cordis：记录 locale 与 slots 调用。
const locales = new Map()
const slotCalls = []
const disposers = []
const ctx = {
  effect: (fn) => { disposers.push(fn()) },
  locale: { register: (ns, dictionaries) => { locales.set(ns, dictionaries); return () => {} } },
  slots: {
    inject: (name, fn) => { const dispose = fn(); slotCalls.push({ name, dispose }); return () => {} },
    register: (options, Component) => {
      slotCalls.push({ register: { options, component: Component } })
      return () => {}
    },
  },
}

moduleExports.apply(ctx)

assert.ok(locales.has('powerControl'), '应注册 powerControl 词典')
const dictionaries = locales.get('powerControl')
assert.ok(dictionaries.zh && dictionaries.en, '中英词典都要有')

const required = [
  'button.restart', 'button.shutdown',
  'confirm.restart.title', 'confirm.restart.body',
  'confirm.shutdown.title', 'confirm.shutdown.body',
  'confirm.cancel', 'confirm.okRestart', 'confirm.okShutdown',
  'state.restarting', 'state.shutdown', 'state.restartHint', 'state.shutdownHint',
  'state.waiting', 'state.reconnect', 'state.done', 'state.failed', 'state.dismiss',
]
for (const key of required) {
  assert.equal(typeof dictionaries.zh[key], 'string', `zh 缺少 ${key}`)
  assert.equal(typeof dictionaries.en[key], 'string', `en 缺少 ${key}`)
}
assert.ok(dictionaries.zh['state.failed'].includes('{error}'), '失败文案要留占位符')

const registration = slotCalls.find(call => call.register)
assert.ok(registration, '应注册一个 slot')
assert.equal(registration.register.options.name, 'conversation.header.leading', '挂在侧边栏开关右边那一格')
assert.equal(registration.register.options.locale, 'powerControl')
assert.equal(typeof registration.register.component, 'function', '注册的必须是一个组件')

assert.deepEqual(disposers.length, 2, 'locale 与 slot 都应通过 ctx.effect 便于清理')

// 宿主与客户端必须指向同一组路由前缀，拼错就静默 404。
assert.ok(source.includes("'/dsh-power-control/api'"), '客户端 API 前缀要与宿主一致')

console.log('client-smoke: 全部通过')
console.log(`slot=${registration.register.options.name} locale=${registration.register.options.locale}`)
