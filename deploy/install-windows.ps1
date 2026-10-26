# Cài bot Zalo tự chạy khi đăng nhập Windows + tự restart khi crash + backup data/ hằng ngày.
#
#   powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1 -Root C:\zalo
#   powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1 -Root C:\zalo -DryRun
#   powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1 -Remove
[CmdletBinding()]
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string]$NodeExe = '',
  [string]$TaskName = 'ZaloBot',
  [string]$BackupTaskName = 'ZaloBotBackup',
  [string]$BackupTime = '03:00',
  [int]$BackupKeep = 14,
  [switch]$DryRun,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

if ($Remove) {
  foreach ($name in @($TaskName, $BackupTaskName)) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $name -Confirm:$false
      Write-Host "da xoa task $name" -ForegroundColor Yellow
    }
  }
  return
}

# --- 1. Kiểm tra thư mục bot ---
$rootPath = (Resolve-Path $Root).Path
$entry = Join-Path $rootPath 'src\index.js'
if (-not (Test-Path $entry)) { throw "khong thay $entry - -Root co dung thu muc bot khong?" }
$envFile = Join-Path $rootPath '.env'
$hasEnv = Test-Path $envFile
if (-not $hasEnv) { Write-Warning "khong co .env - bot se khong co token/key" }

# --- 2. Tìm node ---
if (-not $NodeExe) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'khong thay node trong PATH - cai Node >= 22.9 truoc' }
  $NodeExe = $cmd.Source
}
& $NodeExe -v | Out-Null
$nodeVersion = (& $NodeExe -v).Trim()

$backupScript = Join-Path $rootPath 'deploy\backup-data.ps1'
$hasBackupScript = Test-Path $backupScript

# --- 3. Kế hoạch ---
$action = New-ScheduledTaskAction -Execute $NodeExe `
  -Argument '--env-file-if-exists=.env src/index.js' -WorkingDirectory $rootPath
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Write-Host ""
Write-Host "=== Zalo bot -> Windows Scheduled Task ===" -ForegroundColor Cyan
Write-Host "  Root        : $rootPath"
Write-Host "  Node        : $NodeExe ($nodeVersion)"
Write-Host "  Task        : $TaskName (AtLogOn, restart on crash, no time limit)"
if ($hasBackupScript) {
  Write-Host "  Backup task : $BackupTaskName (daily $BackupTime, keep $BackupKeep)"
}

if ($DryRun) {
  Write-Host ""
  Write-Host "[DryRun] khong dang ky task. Bo -DryRun de cai that." -ForegroundColor Yellow
  return
}

# --- 4. Đăng ký task chạy bot ---
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description 'Zalo group bot (auto restart)' -Force | Out-Null
Write-Host "da tao task $TaskName" -ForegroundColor Green

# --- 5. Task backup hằng ngày ---
if ($hasBackupScript) {
  $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $backupAction = New-ScheduledTaskAction -Execute $psExe `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$backupScript`" -Root `"$rootPath`" -Keep $BackupKeep"
  $backupTrigger = New-ScheduledTaskTrigger -Daily -At $BackupTime
  $backupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  Register-ScheduledTask -TaskName $BackupTaskName -Action $backupAction -Trigger $backupTrigger `
    -Settings $backupSettings -Principal $principal -Description 'Backup data/ cua Zalo bot' -Force | Out-Null
  Write-Host "da tao task $BackupTaskName (moi ngay $BackupTime)" -ForegroundColor Green
}

# --- 6. Khởi động ngay ---
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
$info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo

Write-Host ""
Write-Host "=== Trang thai ===" -ForegroundColor Cyan
Write-Host "  LastRunTime : $($info.LastRunTime)"
Write-Host "  LastResult  : $($info.LastTaskResult)  (0 = ok)"
Write-Host ""
Write-Host "Lenh huu ich:" -ForegroundColor Cyan
Write-Host "  Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
Write-Host "  Stop-ScheduledTask  -TaskName $TaskName"
Write-Host "  powershell -File deploy\install-windows.ps1 -Remove     # go cai dat"
Write-Host ""
Write-Host "Luu y: task chay khi user dang nhap. Muon chay ca khi chua dang nhap:" -ForegroundColor Yellow
Write-Host "  Task Scheduler -> $TaskName -> Properties -> 'Run whether user is logged on or not'"
