/**
 * dsh-power-control — Client half.
 *
 * 两个按钮挂在 `conversation.header.leading`：这是会话标题栏最左边、
 * 紧挨侧边栏开关（打开/收起侧边栏）那一格，所以按钮正好落在它的右边。
 * 动作本身不在这里做，只 POST 给宿主（/dsh-power-control/api/*），
 * 由宿主派生一个能活过父进程的脚本去关窗、强杀、重新拉起。
 */
window.__ModuleLoader__.load({
  id: 'dsh-power-control',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    /** 本地化命名空间，与 ctx.locale.register 的 NS 一致。 */
    const NS = 'powerControl'
    const API = '/dsh-power-control/api'
    /** 同源请求也带自定义头：跨站页面伪造不出这个头，属于廉价的 CSRF 防线。 */
    const GUARD = { 'x-dsh-power-control': '1' }

    const zh = {
      'button.restart': '重启 DeepSeek Harness',
      'button.shutdown': '关闭 DeepSeek Harness',
      'confirm.restart.title': '重启 DeepSeek Harness？',
      'confirm.restart.body': '程序会退出并在几秒后自动重新启动。当前正在运行的任务会被中断，重启完成后本页自动刷新。',
      'confirm.shutdown.title': '关闭 DeepSeek Harness？',
      'confirm.shutdown.body': '程序会完全退出，当前会话和正在运行的任务都会中断。之后再从开始菜单打开即可。',
      'confirm.cancel': '取消',
      'confirm.okRestart': '立即重启',
      'confirm.okShutdown': '立即关闭',
      'state.restarting': '正在重启…',
      'state.shutdown': '正在关闭…',
      'state.restartHint': '重启指令已发送：程序退出后会自动重新启动，连上后本页自动刷新。',
      'state.shutdownHint': '关闭指令已发送：程序完全退出后，这个页面就可以关掉了。',
      'state.waiting': '等待进程退出…',
      'state.reconnect': '已重新连上，正在刷新页面…',
      'state.done': 'DeepSeek Harness 已退出。',
      'state.failed': '操作失败：{error}',
      'state.dismiss': '知道了',
    }

    const en = {
      'button.restart': 'Restart DeepSeek Harness',
      'button.shutdown': 'Shut down DeepSeek Harness',
      'confirm.restart.title': 'Restart DeepSeek Harness?',
      'confirm.restart.body': 'The app quits and starts again after a few seconds. Running tasks are interrupted and this page refreshes once it is back.',
      'confirm.shutdown.title': 'Shut down DeepSeek Harness?',
      'confirm.shutdown.body': 'The app quits completely, interrupting this session and every running task. Open it again from the Start menu when needed.',
      'confirm.cancel': 'Cancel',
      'confirm.okRestart': 'Restart now',
      'confirm.okShutdown': 'Shut down now',
      'state.restarting': 'Restarting…',
      'state.shutdown': 'Shutting down…',
      'state.restartHint': 'Restart requested. The app quits and starts again; this page refreshes once it is back.',
      'state.shutdownHint': 'Shutdown requested. This page can be closed once the process has exited.',
      'state.waiting': 'Waiting for the process to exit…',
      'state.reconnect': 'Back online, reloading the page…',
      'state.done': 'DeepSeek Harness has exited.',
      'state.failed': 'Action failed: {error}',
      'state.dismiss': 'Dismiss',
    }

    const CSS = `
.dshpc-row{display:inline-flex;align-items:center;gap:2px;flex:none}
.dshpc-btn{box-sizing:border-box;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);cursor:pointer;transition:background .12s ease,color .12s ease}
.dshpc-btn:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#e6e6e6)}
.dshpc-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#e6e6e6)}
.dshpc-btn:active{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.2))}
.dshpc-btn[data-danger]{color:var(--dsw-alias-state-error-primary,#e5484d)}
.dshpc-btn[data-danger]:hover{color:var(--dsw-alias-state-error-primary,#e5484d);background:rgba(229,72,77,.14)}
.dshpc-btn:disabled{opacity:.45;cursor:default}
.dshpc-mask{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.38);backdrop-filter:blur(2px)}
.dshpc-card{box-sizing:border-box;width:min(420px,100%);border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#1e1e1e));color:var(--dsw-alias-label-primary,#e6e6e6);box-shadow:0 24px 60px rgba(0,0,0,.42);padding:20px}
.dshpc-title{margin:0 0 8px;font-size:15px;font-weight:600;line-height:22px}
.dshpc-body{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#a8adb7);white-space:pre-wrap}
.dshpc-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.dshpc-action{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:18px;padding:6px 14px;cursor:pointer}
.dshpc-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dshpc-action[data-primary]{border-color:transparent;background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff;font-weight:500}
.dshpc-action[data-primary]:hover{filter:brightness(1.08)}
.dshpc-spin{width:22px;height:22px;border-radius:50%;border:2px solid currentColor;border-top-color:transparent;animation:dshpc-rotate .9s linear infinite;margin-bottom:12px;color:var(--dsw-alias-brand-primary,#4d8dff)}
@keyframes dshpc-rotate{to{transform:rotate(360deg)}}
.dshpc-state{display:flex;flex-direction:column;align-items:center;text-align:center}
.dshpc-stateTitle{margin:0 0 6px;font-size:14px;font-weight:600}
.dshpc-stateBody{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#a8adb7)}
`

    /** 圆形箭头：重启。 */
    function IconRestart() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
      },
      h('path', {
        d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.74',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
      }),
      h('path', {
        d: 'M13.4 2.2v3.1h-3.1',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    /** 电源符号：关闭。 */
    function IconPower() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
      },
      h('path', {
        d: 'M3.4 4.6a5.6 5.6 0 1 0 9.2 0',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
      }),
      h('path', {
        d: 'M8 1.8v5',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
      }))
    }

    /** 把 {name} 占位符替换成实参。 */
    function format(text, values) {
      if (values === undefined) return text
      return text.replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole))
    }

    /**
     * 两个按钮 + 确认框 + 进行中遮罩。
     * @param {{ t: (key: string, values?: Record<string, unknown>) => string }} props 本地化座位
     */
    function PowerControl({ t }) {
      const tr = useCallback((key, values) => format(t(key), values), [t])
      /** 待确认的动作。 */
      const [pending, setPending] = useState(null)
      /** 正在执行的动作。 */
      const [running, setRunning] = useState(null)
      /** 执行结果：'waiting' | 'reconnect' | 'done' | 'failed'。 */
      const [phase, setPhase] = useState(null)
      const [error, setError] = useState('')
      const okRef = useRef(null)

      // 确认框打开时把焦点放到主按钮，Esc 取消。
      useEffect(() => {
        if (pending === null) return undefined
        okRef.current?.focus()
        const onKey = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); setPending(null) }
        }
        document.addEventListener('keydown', onKey, true)
        return () => { document.removeEventListener('keydown', onKey, true) }
      }, [pending])

      /** 重启后轮询 /status，连上就刷新页面。 */
      useEffect(() => {
        if (running !== 'restart' || phase !== 'waiting') return undefined
        let stopped = false
        let attempts = 0
        const timer = setInterval(async () => {
          attempts += 1
          try {
            const res = await fetch(`${API}/status`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            await res.json()
            if (stopped) return
            setPhase('reconnect')
            clearInterval(timer)
            setTimeout(() => { if (!stopped) window.location.reload() }, 900)
          } catch {
            if (attempts > 120) { clearInterval(timer) }
          }
        }, 1500)
        return () => { stopped = true; clearInterval(timer) }
      }, [running, phase])

      /** 关闭后轮询 /status，确认进程真的没了。 */
      useEffect(() => {
        if (running !== 'shutdown' || phase !== 'waiting') return undefined
        let stopped = false
        let attempts = 0
        const timer = setInterval(async () => {
          attempts += 1
          try {
            await fetch(`${API}/status`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) })
          } catch {
            if (stopped) return
            setPhase('done')
            clearInterval(timer)
            return
          }
          if (attempts > 20) { clearInterval(timer) }
        }, 800)
        return () => { stopped = true; clearInterval(timer) }
      }, [running, phase])

      const run = useCallback(async (action) => {
        setPending(null)
        setRunning(action)
        setPhase('waiting')
        setError('')
        try {
          const res = await fetch(`${API}/${action}`, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json', ...GUARD },
            body: '{}',
            signal: AbortSignal.timeout(15000),
          })
          if (!res.ok) {
            const payload = await res.json().catch(() => ({}))
            throw new Error(payload.error ?? `HTTP ${res.status}`)
          }
          await res.json()
        } catch (cause) {
          setPhase('failed')
          setError(String(cause?.message ?? cause))
        }
      }, [])

      const reset = useCallback(() => {
        setRunning(null)
        setPhase(null)
        setError('')
      }, [])

      const busy = running !== null && phase !== 'failed' && phase !== 'done'

      const buttons = h('span', { className: 'dshpc-row', 'data-dsh-power-control': '' },
        h('button', {
          type: 'button',
          className: 'dshpc-btn',
          title: tr('button.restart'),
          'aria-label': tr('button.restart'),
          disabled: busy,
          onClick: () => { setPending('restart') },
        }, h(IconRestart)),
        h('button', {
          type: 'button',
          className: 'dshpc-btn',
          'data-danger': '',
          title: tr('button.shutdown'),
          'aria-label': tr('button.shutdown'),
          disabled: busy,
          onClick: () => { setPending('shutdown') },
        }, h(IconPower)))

      // 确认框：不打断键盘流，Esc / 点遮罩都能退出。
      const confirm = pending === null ? null : h('div', {
        className: 'dshpc-mask',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': tr(`confirm.${pending}.title`),
        onMouseDown: (event) => { if (event.target === event.currentTarget) setPending(null) },
      }, h('div', { className: 'dshpc-card' },
        h('h2', { className: 'dshpc-title' }, tr(`confirm.${pending}.title`)),
        h('p', { className: 'dshpc-body' }, tr(`confirm.${pending}.body`)),
        h('div', { className: 'dshpc-actions' },
          h('button', {
            type: 'button',
            className: 'dshpc-action',
            onClick: () => { setPending(null) },
          }, tr('confirm.cancel')),
          h('button', {
            ref: okRef,
            type: 'button',
            className: 'dshpc-action',
            'data-primary': '',
            onClick: () => { void run(pending) },
          }, tr(pending === 'restart' ? 'confirm.okRestart' : 'confirm.okShutdown')))))

      // 进行中 / 结束提示：盖住整页，让用户知道程序正在断开，不是页面卡死。
      const overlay = running === null ? null : h('div', {
        className: 'dshpc-mask',
        role: 'status',
        'aria-live': 'polite',
      }, h('div', { className: 'dshpc-card dshpc-state' },
        phase === 'waiting' ? h('div', { className: 'dshpc-spin' }) : null,
        h('h2', { className: 'dshpc-stateTitle' },
          phase === 'failed'
            ? tr('state.failed', { error })
            : phase === 'done'
              ? tr('state.done')
              : phase === 'reconnect'
                ? tr('state.reconnect')
                : tr(running === 'restart' ? 'state.restarting' : 'state.shutdown')),
        h('p', { className: 'dshpc-stateBody' },
          phase === 'waiting'
            ? tr(running === 'restart' ? 'state.restartHint' : 'state.shutdownHint')
            : phase === 'done'
              ? tr('state.shutdownHint')
              : phase === 'reconnect'
                ? ''
                : tr('state.waiting')),
        phase === 'waiting' ? null : h('div', { className: 'dshpc-actions' },
          h('button', {
            type: 'button',
            className: 'dshpc-action',
            'data-primary': '',
            onClick: reset,
          }, tr('state.dismiss')))))

      return h(React.Fragment, null, h('style', null, CSS), buttons, confirm, overlay)
    }

    /**
     * 客户端插件主体：注册词典和那个头顶座位。
     * @param {import('@deepseek-ai/cordis').Context} ctx 客户端根上下文
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-power-control: dictionaries')
      ctx.effect(() => ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
        name: 'conversation.header.leading',
        locale: NS,
      }, PowerControl)), 'dsh-power-control: header buttons')
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
