# 电源控制（dsh-power-control）

两个按钮，放在会话标题栏最左侧一格——也就是侧边栏开关（打开/收起侧边栏）的右边：
第一个重启 DeepSeek Harness，第二个关闭 DeepSeek Harness。

## 用法

1. 打开任意会话，看向标题栏左上角、侧边栏开关右侧，会看到两个 28px 的小图标。
   - 环形箭头 = 重启
   - 电源符号 = 关闭
2. 点一下会弹出确认框（Esc 或点遮罩取消）。
3. 确认后页面盖上一层状态提示：
   - **重启**：程序退出 → 自动重新启动 → 页面连上后自动刷新。通常 10～20 秒。
   - **关闭**：程序完全退出，状态提示显示「已退出」，此时可以关掉这个页面。

## 它到底做了什么

浏览器页面没有权限关掉自己所在的桌面程序，所以动作分两步：

1. 页面 POST 到宿主路由 `/dsh-power-control/api/restart` 或 `/shutdown`；
2. 宿主把一个 PowerShell 脚本以**分离进程**方式启动（`cmd /c start` + `powershell -File`），
   然后立刻把响应写回去。脚本等 1.2 秒后：

   - 先对每个 `DeepSeek Harness` 进程调 `CloseMainWindow()`（正常退出）；
   - 等 4 秒，仍存活的进程再用 `Stop-Process -Force` 兜底；
   - 如果是重启，再用 `Start-Process` 把程序拉起来。

分离进程的意义：杀宿主的那一刻宿主自己也会死，动作必须由这个脚本继续完成。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-power-control/api/status` | 只读自检：返回 pid、execPath、argv、解析出的启动命令、是否 dry-run |
| POST | `/dsh-power-control/api/restart` | 退出并重新启动 |
| POST | `/dsh-power-control/api/shutdown` | 退出，不再启动 |

POST 必须带 `x-dsh-power-control: 1` 请求头；缺失返回 403。路由本身也走 DSH 的连接鉴权。

## 排错

- 日志与生成的脚本：`%TEMP%\dsh-power-control\`（`restart.log`、`shutdown.log`，以及每次生成的 `*.ps1`）。
- 想只验证链路、不真的关程序：设置环境变量 `DSH_POWER_CONTROL_DRY=1` 后重启 DSH，
  脚本只会写一行 `dry-run` 日志然后退出。
- 重启拉不起来，多半是启动命令没解析对：打开 `status` 看 `launch.exe` / `launch.source`，
  必要时在 `index.js` 的 `resolveLaunch()` 里补一条分支。

## 已知限制

- 只在 Windows 上验证过：脚本用 PowerShell 的 `Get-Process` / `CloseMainWindow` / `Start-Process`。
- 桌面版按镜像名 `DeepSeek Harness` 结束进程，会一并结束托盘与所有窗口，属于“完全退出”。
- 正在跑的对话/任务会被中断，这是重启与关闭的应有含义，插件不做任务续跑。
- 与真实进程的交互（真的把程序关掉再拉起）只能在用户点击时验证，插件本身不做自动重试。
