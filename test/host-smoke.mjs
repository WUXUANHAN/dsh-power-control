/**
 * Host 冒烟测试：假装自己是 cordis，检查路由挂载、鉴权头、状态接口，
 * 并以 dry-run 方式真的派发一次分离脚本（脚本只写日志、不动进程）。
 *
 *   node test/host-smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import {
  mkdtempSync, readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'

process.env.DSH_POWER_CONTROL_DRY = '1'

const routes = []
const ctx = {
  effect: (fn) => { fn() },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
}

const plugin = await import('../index.js')
plugin.apply(ctx)

assert.equal(routes.length, 1, '应只注册一条 prefix 路由')
assert.equal(routes[0].kind, 'prefix')
assert.equal(routes[0].path, '/dsh-power-control/api')
assert.deepEqual(plugin.inject, ['webServer'])
assert.equal(plugin.name, 'dsh-power-control')

/** 造一个最小的 req/res 对，跑一次 handler。 */
async function call(method, urlPath, headers = {}) {
  const req = { method, url: urlPath, headers }
  const chunks = []
  const res = {
    status: 0,
    headers: {},
    writeHead(status, extra) { this.status = status; this.headers = extra ?? {} },
    end(body) { if (body !== undefined) chunks.push(String(body)) },
  }
  await routes[0].handler(req, res)
  const text = chunks.join('')
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = undefined }
  return { status: res.status, headers: res.headers, text, json: parsed }
}

// 1) status 只读接口
const status = await call('GET', '/dsh-power-control/api/status')
assert.equal(status.status, 200)
assert.equal(status.json.ok, true)
assert.equal(status.json.name, 'dsh-power-control')
assert.equal(typeof status.json.pid, 'number')
assert.equal(typeof status.json.launch.exe, 'string')
assert.equal(status.json.dryRun, true)
// 无论形态如何，重启目标都必须是一个 exe
assert.match(status.json.launch.exe, /\.exe$/i)

// 2) 缺标记头 → 403
const denied = await call('POST', '/dsh-power-control/api/restart', {})
assert.equal(denied.status, 403)

// 3) 方法不对 → 405
const wrongMethod = await call('GET', '/dsh-power-control/api/restart', { 'x-dsh-power-control': '1' })
assert.equal(wrongMethod.status, 405)

// 4) 未知路径 → 404
const missing = await call('GET', '/dsh-power-control/api/nope')
assert.equal(missing.status, 404)

// 5) 带标记头的重启：只验证派发与日志路径（dry-run 不会真的动进程）
const restarted = await call('POST', '/dsh-power-control/api/restart', { 'x-dsh-power-control': '1' })
assert.equal(restarted.status, 200)
assert.equal(restarted.json.ok, true)
assert.equal(restarted.json.action, 'restart')
assert.ok(restarted.json.logFile.includes('dsh-power-control'))

// 6) 生成的脚本内容检查：先正常关窗，再兜底强杀，重启时重新拉起
const generated = readdirSync(path.dirname(restarted.json.logFile))
assert.ok(generated.some(name => name.endsWith('.ps1')), '应写出 ps1 脚本')
const newest = generated.filter(name => name.startsWith('restart-') && name.endsWith('.ps1')).sort().at(-1)
const script = readFileSync(path.join(path.dirname(restarted.json.logFile), newest), 'utf8')
assert.ok(script.includes('CloseMainWindow'), '脚本应先尝试正常退出')
assert.ok(script.includes('Stop-Process -Force'), '脚本应兜底强杀')
assert.ok(script.includes('Start-Process'), '重启脚本应重新拉起程序')
assert.ok(script.includes('DeepSeek Harness'), '应按镜像名结束进程')

// 7) shutdown 脚本不应包含 Start-Process
const shutdown = await call('POST', '/dsh-power-control/api/shutdown', { 'x-dsh-power-control': '1' })
assert.equal(shutdown.status, 200)
assert.equal(shutdown.json.action, 'shutdown')
const shutdownScripts = readdirSync(path.dirname(shutdown.json.logFile))
  .filter(name => name.startsWith('shutdown-') && name.endsWith('.ps1')).sort()
const shutdownScript = readFileSync(path.join(path.dirname(shutdown.json.logFile), shutdownScripts.at(-1)), 'utf8')
assert.ok(!shutdownScript.includes('Start-Process'), '关闭脚本不应重新拉起程序')

console.log('host-smoke: 全部通过')
console.log(`generated scripts in ${path.dirname(restarted.json.logFile)}`)
console.log(`execPath=${status.json.execPath}`)
console.log(`launch=${JSON.stringify(status.json.launch)}`)
