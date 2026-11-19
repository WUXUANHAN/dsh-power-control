/**
 * dsh-power-control — Host half.
 *
 * 这个插件只做一件事：给 Web GUI 加两个按钮（重启 / 关闭 DeepSeek Harness），
 * 按钮本身属于 Client 半边；真正“重启 / 关闭”的动作必须由宿主进程执行，
 * 所以这里注册两条本地 HTTP 路由：
 *
 *   GET  /dsh-power-control/api/status    只读自检，用来验证路由是否挂上
 *   POST /dsh-power-control/api/restart   关闭当前程序并在几秒后重新启动
 *   POST /dsh-power-control/api/shutdown  关闭当前程序，不再启动
 *
 * 关键点：杀掉宿主进程的那一刻，本进程自己也会死。所以动作不能在本进程里做，
 * 必须交给一个能“活过父进程”的分离脚本（detached PowerShell）。脚本先等
 * 1.2 秒让 HTTP 响应写回浏览器，再正常关窗、兜底强杀、按需重新拉起。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** 插件名（与包名、patch 行 id 保持一致）。 */
export const name = 'dsh-power-control'

/** 需要宿主提供 Web 服务器，用来挂载下面两条路由。 */
export const inject = ['webServer']

const PREFIX = '/dsh-power-control/api'

/** Windows 安装形态下的进程镜像名；桌面版主进程与渲染进程都用它。 */
const APP_IMAGE = 'DeepSeek Harness'

/** 请求必须带的标记头：同源请求不会触发预检，跨站表单也伪造不了它。 */
const GUARD_HEADER = 'x-dsh-power-control'

/** 写日志与临时脚本的目录（不污染用户目录）。 */
const WORK_DIR = path.join(tmpdir(), 'dsh-power-control')

function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  })
  res.end(data)
}

/** 安全取进程名，取不到就当作不匹配。 */
function imageName(execPath) {
  try {
    return path.basename(execPath).toLowerCase()
  } catch {
    return ''
  }
}

/** 桌面版默认安装位置：宿主跑在 node 里时用它把整窗拉回来。 */
function desktopExePath() {
  const local = process.env.LOCALAPPDATA
    ?? path.join(process.env.USERPROFILE ?? 'C:\\Users\\Public', 'AppData', 'Local')
  return path.join(local, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
}

/**
 * 解析“重新启动这条程序”应该执行什么。
 *
 * 三种宿主形态都要能自愈：
 *   1. 桌面版（Electron 主进程）：execPath 就是 DeepSeek Harness.exe，直接再启一次；
 *   2. 桌面版但宿主跑在 node 子进程里：入口在 app.asar 内，此时回到桌面 exe；
 *   3. CLI（node 跑 dsh）：execPath 是 node.exe，argv 里带着入口脚本，原样重放。
 * 还可以用 DSH_POWER_CONTROL_EXE 显式指定要拉起的程序。
 * @returns {{ desktop: boolean, exe: string, args: string[], source: string }}
 */
function resolveLaunch() {
  const execPath = process.execPath
  const exe = imageName(execPath)
  const override = process.env.DSH_POWER_CONTROL_EXE
  if (override !== undefined && override !== '') {
    return { desktop: true, exe: override, args: [], source: 'env' }
  }
  if (exe.includes('deepseek harness')) {
    // Electron 自己会重新解析 argv，重复传 asar 参数反而会多开，
    // 所以桌面版只给 exe，不带参数。
    return { desktop: true, exe: execPath, args: [], source: 'execPath' }
  }
  const argv = process.argv.slice(1)
  const entry = argv.find(arg => /\.(c|m)?js$/i.test(arg))
  const inAsar = entry !== undefined && /[\\/]app\.asar[\\/]/i.test(entry)
  if (process.versions.electron !== undefined || inAsar) {
    const fallback = desktopExePath()
    return {
      desktop: true,
      exe: existsSync(fallback) ? fallback : execPath,
      args: [],
      source: inAsar ? 'asar' : 'electron',
    }
  }
  if (entry !== undefined) {
    return { desktop: false, exe: execPath, args: argv, source: 'argv' }
  }
  return { desktop: true, exe: desktopExePath(), args: [], source: 'fallback' }
}

/** 只读自检信息：给用户和排错用，不触发任何动作。 */
function status() {
  const launch = resolveLaunch()
  return {
    ok: true,
    name,
    platform: process.platform,
    pid: process.pid,
    execPath: process.execPath,
    argv: process.argv.slice(1),
    launch,
    dryRun: process.env.DSH_POWER_CONTROL_DRY === '1',
  }
}

/**
 * 生成“活过父进程”的动作脚本。
 * @param {'restart' | 'shutdown'} action 要执行的动作
 * @param {{ exe: string, args: string[] }} launch 重新启动用的命令行
 * @returns {{ file: string, logFile: string }}
 */
function writeScript(action, launch) {
  mkdirSync(WORK_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(WORK_DIR, `${action}-${stamp}.ps1`)
  const logFile = path.join(WORK_DIR, `${action}.log`)
  const argList = launch.args.length === 0
    ? ''
    : ` -ArgumentList @(${launch.args.map(a => `'${a.replace(/'/g, "''")}'`).join(', ')})`
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$log = '${logFile.replace(/'/g, "''")}'`,
    "function Log($m) { try { \"$(Get-Date -Format o) $m\" | Add-Content -LiteralPath $log -Encoding UTF8 } catch {} }",
    `Log 'begin ${action}'`,
    "if ($env:DSH_POWER_CONTROL_DRY -eq '1') { Log 'dry-run: 不做任何动作'; exit 0 }",
    // 先让 HTTP 响应有机会写出去，再动进程。
    'Start-Sleep -Milliseconds 1200',
    `$procs = @(Get-Process -Name '${APP_IMAGE}' -ErrorAction SilentlyContinue)`,
    "Log ('running: ' + (($procs | ForEach-Object { $_.Id }) -join ','))",
    'foreach ($p in $procs) { try { $null = $p.CloseMainWindow() } catch {} }',
    'Start-Sleep -Seconds 4',
    `foreach ($p in @(Get-Process -Name '${APP_IMAGE}' -ErrorAction SilentlyContinue)) { try { $p | Stop-Process -Force } catch {} }`,
    'Start-Sleep -Milliseconds 800',
    `Log ('remaining: ' + ((@(Get-Process -Name '${APP_IMAGE}' -ErrorAction SilentlyContinue) | ForEach-Object { $_.Id }) -join ','))`,
    ...(action === 'restart'
      ? [
          `if (Test-Path -LiteralPath '${launch.exe.replace(/'/g, "''")}') {`,
          `  Start-Process -FilePath '${launch.exe.replace(/'/g, "''")}'${argList}`,
          "  Log 'relaunched'",
          '} else {',
          "  Log 'exe 不存在，没有重启'",
          '}',
        ]
      : ["Log 'shutdown only'"]),
    "Log 'done'",
  ].join('\r\n')
  writeFileSync(file, '\ufeff' + script, 'utf8')
  return { file, logFile }
}

/**
 * 以分离进程方式跑脚本：父进程（也就是本进程）被杀掉后它仍然继续。
 * @param {string} file 脚本路径
 */
function runDetached(file) {
  const env = { ...process.env }
  const child = spawn(
    'cmd.exe',
    ['/c', 'start', '""', '/min', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-File', file],
    { detached: true, stdio: 'ignore', windowsHide: true, env },
  )
  child.unref()
}

/**
 * 插件主体：只注册路由，不碰任何全局状态。
 * @param {import('node:module').Context} ctx cordis 上下文
 */
export function apply(ctx) {
  const handler = async (req, res) => {
    let route
    try {
      route = new URL(req.url, 'http://127.0.0.1').pathname.slice(PREFIX.length)
    } catch {
      json(res, 400, { ok: false, error: 'bad url' })
      return
    }

    if (route === '/status' && req.method === 'GET') {
      json(res, 200, status())
      return
    }

    if (route === '/restart' || route === '/shutdown') {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (req.headers[GUARD_HEADER] !== '1') {
        json(res, 403, { ok: false, error: 'missing guard header' })
        return
      }
      const action = route === '/restart' ? 'restart' : 'shutdown'
      const launch = resolveLaunch()
      try {
        const { file, logFile } = writeScript(action, launch)
        runDetached(file)
        json(res, 200, { ok: true, action, logFile, exe: launch.exe, dryRun: process.env.DSH_POWER_CONTROL_DRY === '1' })
      } catch (error) {
        json(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
      return
    }

    json(res, 404, { ok: false, error: 'not found' })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }), 'dsh-power-control: routes')
}
