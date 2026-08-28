# agent-auto-signin

零依赖、单文件的 Node.js 自动签到脚本：自动领取 **Trae Work CN** 与 **WorkBuddy** 的每日签到积分，并自动完成 WorkBuddy 成长中心的全部日常任务。

整合自 daily-auto-checkin、trae-auto-signin、workbuddy-auto-signin 三份脚本（已移除 DuMate）。凭据全部从本机客户端登录态实时读取，脚本不落盘任何令牌。

## 特性

| 产品 | 能力 |
|---|---|
| **WorkBuddy** | 每日签到积分 + 成长中心全套（领 Buddy 旅行礼物 → 派 Buddy 出发 → 开盲盒 → 领任务奖 → 能量/连签汇报） |
| **Trae Work CN** | 每日签到积分 + 访问令牌自动续期（临近过期时用设备密钥对调用官方接口，加密写回 `storage.json`） |

通用能力：

- **幂等安全** — 先查状态、未签才领，重复运行不会多领
- **令牌自动续期** — Trae 令牌剩余不足 24 小时（或已过期）且客户端未运行时，自动换新令牌并写回（备份 → 写回 → 复核）
- **风控重试** — Trae 命中 9074 频控时按递增间隔做有界重试，仍失败留给次日
- **守护循环** — 常驻后台，按配置的每日时间点自动签到（默认 09:30）
- **防重入锁** — 多实例并发时每产品只处理一次
- **日志落盘** — 每次执行结果全部留痕，关键问题单独记录便于排查

## 前置条件

- **Node.js >= 18**（零第三方依赖）
- 已在本机**登录过**对应客户端（登录后自动写出凭据文件，脚本只读取）：
  - WorkBuddy 桌面端
  - Trae（TRAE SOLO CN / Trae CN 等版本）
- 主要面向 Windows（计划任务脚本为 PowerShell）；WorkBuddy 凭据探测亦含 macOS/Linux 路径

## 快速开始

```bash
node auto-signin.js --once
```

看到 `今日已签到` 或 `成功领取 N 积分` 即打通。

## 用法

```bash
node auto-signin.js                          # 守护循环（默认）：每天定时自动签到
node auto-signin.js --once                   # 只执行一轮立即退出
node auto-signin.js --once --only=trae       # 只处理 Trae（或 workbuddy）
node auto-signin.js --dry-run                # 只读预演：查状态、不领取不续期
node auto-signin.js --status                 # 查各产品签到状态；WorkBuddy 逐项汇报成长中心做没做
node auto-signin.js --growth                 # 仅跑 WorkBuddy 成长中心（不签到）
node auto-signin.js --claim                  # 仅调用 Trae 领取接口（调试，输出原始响应）
node auto-signin.js --refresh                # 强制执行一次 Trae 令牌续期（调试）
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CHECKIN_TIME` | `09:30` | 守护模式每日签到时间（HH:MM） |
| `CHECKIN_TIMES` | 同 `CHECKIN_TIME` | 多个时间点，逗号分隔，如 `00:05,09:30,18:00` |
| `CHECKIN_BASE_DIR` | `~/.daily-checkin` | 日志/状态/备份目录 |
| `TRAE_AUTH_FILE` | 自动探测 | Trae `storage.json` 路径（按已安装版本自动探测：TRAE SOLO CN / Trae CN / TRAE SOLO / Trae） |
| `WORKBUDDY_AUTH_FILE` | 自动探测 | WorkBuddy `workbuddy-desktop.info` 路径 |

## 每日定时（推荐）

用安装脚本注册 Windows 计划任务（登录时 + 每日定时双触发，错过时间点开机自动补签）：

```powershell
.\install-task.ps1 -Time "09:30" -RunNow
```

- 部署脚本到 `~\.daily-checkin\`（与仓库位置解耦的稳定路径），并清理旧版 `daily-checkin.js`
- 注册计划任务 `DailyCheckin`：每次登录后 30 秒 + 每天 `-Time` 触发；失败 5 分钟后自动重试 ×3
- `-RunNow` 装完立即执行一轮

卸载：

```powershell
.\uninstall-task.ps1             # 仅删计划任务，保留日志/状态数据
.\uninstall-task.ps1 -RemoveData # 彻底清理 ~/.daily-checkin
```

## 执行结果留存

| 路径（`~\.daily-checkin\`） | 内容 |
|---|---|
| `logs\checkin-YYYY-MM.log` | 每次执行的全部输出（按月滚动，长期累积） |
| `state.json` | 最近一轮签到快照（模式/成败/明细），供外部感知 |
| `critical.log` | 需人工关注的问题：凭证失效 / 频控 / 漏签（如领取接口 5xx） |
| `backups\` | Trae 令牌续期写回前的 `storage.json` 备份 |
| `locks\` | 防重入锁（运行中存在，结束自动清理） |

## 排错

| 现象 | 处理 |
|---|---|
| `未找到 WorkBuddy 登录凭据` | 先登录一次 WorkBuddy 桌面端，或设 `WORKBUDDY_AUTH_FILE` |
| `未找到 Trae 登录凭据` | 先登录一次 Trae 客户端，或设 `TRAE_AUTH_FILE` |
| `登录态已失效（HTTP 401/403）` | 登录态过期，重新登录对应客户端后自动恢复 |
| `命中风控 9074` | 设备指纹校验未通过，重启一次 Trae 客户端后重试 |
| `签到活动未开启 / 未开放` | 非签到季，属正常 |
| 调试原始返回 | `--status` / `--claim` / `--dry-run` |

## 工作原理

- **WorkBuddy**：读取 `%LOCALAPPDATA%\CodeBuddyExtension\...\workbuddy-desktop.info`（含 `accessToken`），调用与桌面端相同的 `copilot.tencent.com` 签到与成长中心接口
- **Trae**：读取 `%APPDATA%\<版本目录>\User\globalStorage\storage.json`，解密 `iCubeAuthInfo://icube.cloudide`（tc 加密，AES-128-CBC + SHA-512 校验），调用 `api.trae.cn` 签到接口；续期时用 `icube-dc:<设备ID>` 下的设备密钥对（ECDSA-P256 签名）换新令牌

任何模式下脚本都不会打印令牌。

## 免责声明

> 本项目为**非官方**个人自动化工具。签到接口系从对应客户端逆向得到，与各厂商无隶属关系；接口可能随时变动且不另行通知。请遵守相关服务条款，使用风险自负。

## 许可

[MIT](LICENSE)
