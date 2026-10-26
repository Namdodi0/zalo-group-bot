# Sao lưu data/ của bot (context, sticker). Dùng bởi Scheduled Task ZaloBotBackup.
#
#   powershell -ExecutionPolicy Bypass -File deploy\backup-data.ps1 -Root C:\zalo
[CmdletBinding()]
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string]$BackupDir = '',
  [int]$Keep = 14
)

$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path $Root).Path
$dataDir = Join-Path $rootPath 'data'
if (-not (Test-Path $dataDir)) {
  Write-Host "khong co $dataDir, bo qua"
  exit 0
}
if (-not $BackupDir) { $BackupDir = Join-Path $rootPath 'backups' }
$backupPath = if ([System.IO.Path]::IsPathRooted($BackupDir)) { $BackupDir } else { Join-Path $rootPath $BackupDir }
if (-not (Test-Path $backupPath)) { New-Item -ItemType Directory -Path $backupPath -Force | Out-Null }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$zip = Join-Path $backupPath "zalo-data-$stamp.zip"
Compress-Archive -Path (Join-Path $dataDir '*') -DestinationPath $zip -CompressionLevel Optimal -Force

# Giữ N bản mới nhất
$old = Get-ChildItem $backupPath -Filter 'zalo-data-*.zip' | Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep
foreach ($f in $old) { Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue }

$sizeKb = [math]::Round(((Get-Item $zip).Length / 1KB), 1)
Write-Host "backup: $zip ($sizeKb KB) | da xoa $($old.Count) ban cu | giu $Keep ban"
