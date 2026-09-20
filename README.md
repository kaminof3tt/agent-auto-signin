# agent-auto-signin

零依赖的 Node.js 自动签到脚本：自动领取 **WorkBuddy**、**Trae Work CN**、**Qoder / Qoder CN** 的每日签到积分（Credits），并自动完成 WorkBuddy 成长中心的全部日常任务。

整合自 daily-auto-checkin、trae-auto-signin、workbuddy-auto-signin 三份脚本（已移除 DuMate）。凭据全部从本机客户端登录态实时读取，脚本不落盘任何令牌。

| 脚本 | 负责产品 |
|---|---|
| `auto-signin.js` | WorkBuddy + Trae Work CN（单文件，见下文） |
| `auto-signin-qoder.js` | Qoder（国际版）+ Qoder CN —— 独立进程，与主脚本**完全解耦**（独立的锁与状态文件，可并行运行互不影响），见 [Qoder / Qoder CN（独立脚本）](#qoder--qoder-cn独立脚本) |

## 特性

| 产品 | 能力 |
|---|---|
| **WorkBuddy** | 每日签到积分 + 成长中心全套（领 Buddy 旅行礼物 → 派 Buddy 出发 → 开盲盒 → 领任务奖 → 能量/连签汇报） |
| **Trae Work CN** | 每日签到积分 + 访问令牌自动续期（临近过期时用设备密钥对调用官方接口，加密写回 `storage.json`） |
| **Qoder / Qoder CN** | 每日领取 100 Credits（`openapi.qoder.sh` / `openapi.qoder.com.cn`） |

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
  - Qoder / Qoder CN 桌面端（领取时**不需要**客户端保持运行，详见 [Qoder 章节](#领取时客户端需要开着吗)）
- 主要面向 Windows（计划任务脚本为 PowerShell）；WorkBuddy 凭据探测亦含 macOS/Linux 路径
  （Qoder 的凭据解密依赖 Windows DPAPI，目前仅支持 Windows）

## 快速开始

```bash
node auto-signin.js --once          # WorkBuddy + Trae Work CN
node auto-signin-qoder.js --once    # Qoder + Qoder CN
```

看到 `今日已签到` / `成功领取 N 积分` / `成功领取 100 Credits` 即打通。

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

> Qoder / Qoder CN 用的是**独立的计划任务** `DailyCheckinQoder`（与上面的 `DailyCheckin` 互不影响），安装方式见下文 [Qoder / Qoder CN（独立脚本）](#qoder--qoder-cn独立脚本)。

## 执行结果留存

| 路径（`~\.daily-checkin\`） | 内容 |
|---|---|
| `logs\checkin-YYYY-MM.log` | 每次执行的全部输出（按月滚动，长期累积；主脚本与 Qoder 脚本共用） |
| `state.json` | 最近一轮签到快照（模式/成败/明细），供外部感知 |
| `state-qoder.json` | Qoder 脚本最近一轮快照（含 `warned` 计数） |
| `critical.log` | 需人工关注的问题：凭证失效 / 频控 / 漏签 / Qoder 到点仍未放量 |
| `backups\` | Trae 令牌续期写回前的 `storage.json` 备份 |
| `locks\` | 防重入锁（运行中存在，结束自动清理；锁名 `workbuddy` / `trae` / `qoder` / `qoder-cn`） |

## 排错

| 现象 | 处理 |
|---|---|
| `未找到 WorkBuddy 登录凭据` | 先登录一次 WorkBuddy 桌面端，或设 `WORKBUDDY_AUTH_FILE` |
| `未找到 Trae 登录凭据` | 先登录一次 Trae 客户端，或设 `TRAE_AUTH_FILE` |
| `登录态已失效（HTTP 401/403）` | 登录态过期，重新登录对应客户端后自动恢复 |
| `命中风控 9074` | 设备指纹校验未通过，重启一次 Trae 客户端后重试 |
| `签到活动未开启 / 未开放` | 非签到季，属正常 |
| 调试原始返回 | `--status` / `--claim` / `--dry-run` |

Qoder / Qoder CN（`auto-signin-qoder.js`）：

| 现象 | 处理 |
|---|---|
| `未找到 Qoder 登录凭据` | 先登录一次对应客户端，或设 `QODER_AUTH_FILE` / `QODER_CN_AUTH_FILE` |
| `登录态已失效（HTTP 401/403）` | 打开对应 Qoder 桌面端一次，让它刷新登录态 |
| `DPAPI 解密 os_crypt 密钥失败` | 计划任务必须运行在**登录 Qoder 的那个 Windows 用户**下；换用户或换机器需重新登录客户端 |
| `auth.v1.dat 格式非预期 / 解密失败` | 客户端版本升级导致格式变化，请更新脚本 |
| `登录令牌将在 … 过期` | 提醒性告警，打开一次 Qoder 桌面端即可刷新 |
| `暂无可领取的权益活动` | 活动列表里没有可领项。先在 `--status` 看 `机器身份` 是否为「已带上」，再看 `campaigns` 条数；两者都正常且处于领取窗口内（10:00~次日 09:59）时，多半是服务端还没对该账号放量，脚本会自动重试，最终仍失败会写 `critical.log` |
| 桌面端显示可领、脚本查不到 | 请求头不完整（见 [请求头](#请求头为什么桌面端能领脚本领不到)）。确认 `--status` 里 `机器身份=已带上`；若缺失，检查客户端是否装在本机、`auth.machine-id` 是否存在 |
| `机器身份=缺失` | 取不到 `auth.machine-id` 或 `runtime-info.exe` 调用失败。确认 Qoder 桌面端装在本机（脚本按启动器 `state.ini` 定位安装目录）且已登录 |
| 领取窗口 | 每天 10:00（UTC+8）开新一轮，脚本默认 10:05 / 13:05 / 17:05 各跑一次 |

## 工作原理

- **WorkBuddy**：读取 `%LOCALAPPDATA%\CodeBuddyExtension\...\workbuddy-desktop.info`（含 `accessToken`），调用与桌面端相同的 `copilot.tencent.com` 签到与成长中心接口
- **Trae**：读取 `%APPDATA%\<版本目录>\User\globalStorage\storage.json`，解密 `iCubeAuthInfo://icube.cloudide`（tc 加密，AES-128-CBC + SHA-512 校验），调用 `api.trae.cn` 签到接口；续期时用 `icube-dc:<设备ID>` 下的设备密钥对（ECDSA-P256 签名）换新令牌

任何模式下脚本都不会打印令牌。

## Qoder / Qoder CN（独立脚本）

`auto-signin-qoder.js` 负责 **Qoder**（国际版）与 **Qoder CN** 的每日 100 Credits 领取。它与主脚本 `auto-signin.js` 是**两个独立进程**：锁名（`qoder` / `qoder-cn`）与状态文件（`state-qoder.json`）各自独立，日志写入同一个 `~\.daily-checkin\logs\`，因此两者可以同时运行、互不干扰。

| 产品 | 能力 |
|---|---|
| **Qoder** | 每日领取 100 Credits（`openapi.qoder.sh`） |
| **Qoder CN** | 每日领取 100 Credits（`openapi.qoder.com.cn`） |

活动规则：每天 **10:00（UTC+8）** 开新一轮，领取窗口至次日 09:59，奖励自领取起 **30 天**有效。因此本脚本默认领取时间取 **10:05**。

```bash
node auto-signin-qoder.js                    # 守护循环（默认）：每天 10:05 自动领取
node auto-signin-qoder.js --once             # 只执行一轮立即退出
node auto-signin-qoder.js --once --only=qoder    # 只处理 Qoder（--only=qoder-cn 只处理 Qoder CN）
node auto-signin-qoder.js --dry-run          # 只读预演：查状态、不领取（只跑一轮）
node auto-signin-qoder.js --status           # 查两个客户端的活动状态与令牌剩余有效期
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `QODER_CHECKIN_TIME` | `10:05` | 守护模式每日领取时间（HH:MM，需晚于 10:00） |
| `QODER_CHECKIN_TIMES` | 同 `QODER_CHECKIN_TIME` | 多个时间点，逗号分隔 |
| `QODER_RETRY_MAX` | `2` | 拿不到可领取活动时的额外重试次数（0 = 不重试） |
| `QODER_RETRY_INTERVAL_MIN` | `10` | 重试间隔（分钟） |
| `CHECKIN_BASE_DIR` | `~\.daily-checkin` | 与主脚本共用日志/状态目录 |
| `QODER_AUTH_FILE` | 自动探测 | Qoder 的 `auth.v1.dat` 路径 |
| `QODER_CN_AUTH_FILE` | 自动探测 | Qoder CN 的 `auth.v1.dat` 路径 |
| `QODER_OPENAPI_BASE` / `QODER_CN_OPENAPI_BASE` | 读客户端缓存 | 覆盖接口基址 |

定时（与主脚本的计划任务相互独立，任务名 `DailyCheckinQoder`）：

```powershell
.\install-task-qoder.ps1 -RunNow                        # 默认每天 10:05 / 13:05 / 17:05 三次
.\install-task-qoder.ps1 -Time "10:05,14:05" -RunNow    # 自定义多个时间点
.\install-task-qoder.ps1 -Uninstall                     # 仅删任务，保留日志/状态数据
```

> **为什么要跑多次 + 重试**：`10:00` 只是名义开窗时间，服务端对单个账号的「放量」可能晚于此
> （2026-09-19 曾出现同一时刻 **Qoder CN 已可领、Qoder 国际版活动列表里还没有该活动**）。
> 因此：
> - 单次运行内拿不到可领取活动时，按 `QODER_RETRY_INTERVAL_MIN` 间隔重试 `QODER_RETRY_MAX` 次；
> - 计划任务一天跑 3 次，兜住更晚才出现的活动；
> - 重试后仍未拿到时，**记为 `[注意]` 并写入 `critical.log`**（不再像早期版本那样当成「成功」糊弄过去），
>   同时把接口返回的关键信息（`showCampaign` / `claimable` / 活动列表）打进日志，便于定位。

### 请求头：为什么「桌面端能领、脚本领不到」

服务端会校验请求头来判断「这是不是官方桌面端」，**缺头不会报错，而是静默少返回活动**——表现为活动列表里
根本没有当天那条 `CLAIM_BENEFIT` 活动，脚本只能报「暂无可领取的权益活动」。2026-09-20 已把两类缺失的头补齐：

| 头 | 取值来源 | 缺了会怎样 |
|---|---|---|
| `Cosy-ClientType` | 固定 `10`（桌面端） | —— |
| `Cosy-Version` | 客户端启动器 `state.ini` 的 `targetVersion`（退路：扫描 `.qoder-versions` 取最高版本） | 少返回活动（实测：`campaigns` 少 1 条） |
| `Cosy-MachineOS` | `<arch>_<platform>`，如 `x86_64_win32` | —— |
| `Cosy-MachineHostname` | 本机主机名（可打印 ASCII 才发送） | —— |
| `Cosy-MachineId` | `%APPDATA%\<dataDir>\auth.machine-id`（客户端持久化 UUID） | —— |
| `Cosy-MachineToken`<br>`Cosy-MachineCode`<br>`Cosy-MachineType` | 客户端自带 `resources\umid\runtime-info.exe <environment> --account-stdin` 的输出 | **日常活动整条消失**，`claimable` 变成 `false` |

> 实测对照（2026-09-20 10:2x，同一账号、相隔十几秒）：
> 客户端日志里 `claimable=true`、列表含 `act-20260920-731(CLAIM_BENEFIT/CLAIMABLE)`；
> 而只带 `Cosy-ClientType`+`Cosy-Version`+`Cosy-MachineOS`+`Hostname` 的请求拿到 `claimable=false`、列表里没有这条。
> 补上 `MachineId`+`Token`+`Code`+`Type` 后立即变为 `claimable=true` 且该活动出现。
>
> `--status` 会打印 `机器身份=已带上/缺失`，可直接确认这组头是否生效。缺失时脚本会在日志里明确提示。

### 工作原理（凭据解密）

Qoder 桌面端把登录态写在 `%APPDATA%\<dataDir>\auth.v1.dat`，由 Electron `safeStorage`（Windows 走 Chromium 的 `os_crypt`）加密：

- `auth.v1.dat` = `v10`(3B) + nonce(12B) + **AES-256-GCM** 密文 + tag(16B)
- AES 密钥 = `Local State` 里 `os_crypt.encrypted_key`（base64，去掉 `DPAPI` 前缀）经 **DPAPI** 解出的 32 字节
- 脚本借 Windows 自带的 PowerShell 调用 `ProtectedData.Unprotect` 解出密钥（无第三方依赖），随后在 Node 内完成 AES-256-GCM 解密

解密得到 token 后，调用与桌面端活动页相同的接口：

- `GET  {base}/sash/api/v1/me/campaigns` —— 查活动（`claimStatus`：`CLAIMABLE` / `CLAIMED`）
- `POST {base}/sash/api/v1/me/campaigns/{campaignId}/claim` —— 领取（幂等，重复调用返回 `replayed: true`）

机器身份（`Cosy-MachineId` / `Token` / `Code` / `Type`）全部取自本机客户端自身，**不伪造**：
`auth.machine-id` 是客户端登录后持久化的 UUID；`runtime-info.exe` 是客户端自带于
`<安装目录>\.qoder-versions\<版本>\resources\umid\` 的原生程序，脚本按客户端同样的方式调用它
（`runtime-info.exe <environment> --account-stdin`，stdin 传 `{"account":"<用户id>}.`），
只在内存中传递结果，不落盘。安装目录由启动器 `state.ini` 的 `installDir` 定位。

### 令牌续期

脚本**不自行续期**——`refreshToken` 其实就在凭据文件里，但自行刷新可能与客户端抢着刷而互相踢掉登录，得不偿失。令牌由 Qoder 桌面端自动刷新（默认有效 1~2 周），因此**大约每周打开一次客户端**即可。

令牌剩余不足 24 小时或已过期时，脚本会在日志与 `critical.log` 中明确告警，打开一次 Qoder 桌面端即恢复。

### 领取时客户端需要开着吗

**不需要。** 脚本只读磁盘上的凭据文件（`auth.v1.dat` / `Local State` / `auth.machine-id`），并用客户端自带的独立原生程序 `runtime-info.exe` 取机器身份，全程自己发 HTTP，与客户端进程无关。

2026-09-20 已实测：**国际版客户端完全关闭**（`tasklist` 里只有 Qoder CN、没有 `Qoder.exe`）时运行
`--once --only=qoder`，结果 `机器身份=已带上`、活动列表完整（3 条）、领取正常。

所以平时不必开着，只要按上面的节奏每周开一次续期令牌即可。

## 免责声明

> 本项目为**非官方**个人自动化工具。签到接口系从对应客户端逆向得到，与各厂商无隶属关系；接口可能随时变动且不另行通知。请遵守相关服务条款，使用风险自负。

## 许可

[MIT](LICENSE)
