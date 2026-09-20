# auto-signin-qoder 安装脚本：注册 Windows 计划任务，每日自动领取 Qoder / Qoder CN 的 100 Credits
# 与 install-task.ps1（DailyCheckin: WorkBuddy / Trae）完全独立，任务名不同，互不影响。
# 用法: .\install-task-qoder.ps1 [-Time "10:05,13:05,17:05"] [-RunNow] [-Uninstall]
param(
    [string]$Time = "10:05,13:05,17:05",
    [switch]$RunNow,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$taskName = 'DailyCheckinQoder'
$dest = Join-Path $env:USERPROFILE '.daily-checkin'

# 0) 卸载
if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "[OK] 已删除计划任务 $taskName（日志/状态数据保留在 $dest）" -ForegroundColor Green
    } else {
        Write-Host "[跳过] 计划任务 $taskName 不存在"
    }
    exit 0
}

# 1) 检查 Node.js
try {
    $node = (Get-Command node -ErrorAction Stop).Source
    $version = & node -v
    if ($version -match 'v(\d+)\.' -and [int]$Matches[1] -lt 18) {
        Write-Host "[错误] Node.js 版本过低 ($version)，需要 >= 18: https://nodejs.org/" -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Node.js $version ($node)"
} catch {
    Write-Host "[错误] 未找到 node，请先安装 Node.js 18 或更高版本: https://nodejs.org/" -ForegroundColor Red
    exit 1
}

# 2) 部署脚本到用户目录（与 install-task.ps1 使用同一稳定路径）
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'auto-signin-qoder.js') (Join-Path $dest 'auto-signin-qoder.js') -Force
Write-Host "[OK] 脚本已部署到 $dest\auto-signin-qoder.js"

# 3) 校验领取时间（可多个，逗号分隔）
# 活动每天 10:00（UTC+8）开新一轮，但服务端对单个账号"放量"可能晚于 10:00，
# 所以默认一天跑 3 次（10:05 / 13:05 / 17:05），每次都幂等，领过不会重复发。
$times = @($Time.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($times.Count -eq 0) {
    Write-Host "[错误] -Time 不能为空，示例: -Time `"10:05,13:05,17:05`"" -ForegroundColor Red
    exit 1
}
foreach ($t in $times) {
    if ($t -notmatch '^\d{1,2}:\d{2}$') {
        Write-Host "[错误] 时间格式应为 HH:MM，当前为: $t" -ForegroundColor Red
        exit 1
    }
    $p = $t.Split(':')
    if ([int]$p[0] -gt 23 -or [int]$p[1] -gt 59) {
        Write-Host "[错误] 时间越界: $t" -ForegroundColor Red
        exit 1
    }
    if ([int]$p[0] -lt 10) {
        Write-Host "[警告] $t 早于 10:00，此时活动尚未刷新新一轮，建议设在 10:00 之后" -ForegroundColor Yellow
    }
}
$timeList = $times -join ', '

# 4) 注册计划任务：登录时 + 每日多时间点 触发
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$dest\auto-signin-qoder.js`" --once" -WorkingDirectory $dest

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$logonTrigger.Delay = 'PT30S'

$dailyTriggers = @()
foreach ($t in $times) { $dailyTriggers += New-ScheduledTaskTrigger -Daily -At $t }

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName $taskName `
    -Description "每日自动领取 Qoder / Qoder CN 的 100 Credits (登录时与每天 $timeList 触发, 幂等可重复执行)" `
    -Action $action -Trigger (@($logonTrigger) + $dailyTriggers) -Settings $settings -Force | Out-Null

Write-Host "[OK] 计划任务 $taskName 已注册" -ForegroundColor Green
Write-Host "     - 每次登录后 30 秒自动领取"
Write-Host "     - 每天 $timeList 自动领取（多个时间点是为了兜住服务端晚放量）"
Write-Host "     - 错过时间点(电脑关机)会在下次开机自动补领"

# 5) 立即执行一轮（可选）
if ($RunNow) {
    Write-Host ""
    Write-Host "立即执行一轮领取..." -ForegroundColor Cyan
    & $node "$dest\auto-signin-qoder.js" --once
}

Write-Host ""
Write-Host "完成。日志: $dest\logs\  (问题记录: $dest\critical.log)"
Write-Host "卸载: .\install-task-qoder.ps1 -Uninstall"
