# Đóng gói zalo-group-bot để deploy (bỏ node_modules, data/)
#
#   npm run pack                                # KHÔNG kèm .env (an toàn để chia sẻ)
#   npm run pack -- -IncludeEnv                 # KÈM .env (zip chứa secret - chỉ dùng cá nhân)
#   npm run pack -- -Out dist/custom.zip
[CmdletBinding()]
param(
  [string]$Out = '',
  [switch]$IncludeEnv
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Out) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmm'
  $suffix = if ($IncludeEnv) { '-with-env' } else { '' }
  $Out = Join-Path 'dist' "zalo-group-bot-$stamp$suffix.zip"
}
$outPath = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }

# Chỉ những thứ cần trên server. KHÔNG có: .env, data/, node_modules/, dist/
$include = @(
  'src',
  'scripts',
  'test',
  'test-utils',
  'deploy',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '.gitignore',
  '.env.example',
  '.npmrc',
  'index.js',
  'README.md',
  'ecosystem.config.cjs'
)

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("zalobot-pack-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging -Force | Out-Null

try {
  foreach ($item in $include) {
    $src = Join-Path $root $item
    if (Test-Path $src) {
      Copy-Item -Path $src -Destination $staging -Recurse -Force
    } else {
      Write-Warning "bo qua (khong ton tai): $item"
    }
  }

  # Kèm .env nếu được yêu cầu rõ ràng
  if ($IncludeEnv) {
    $envPath = Join-Path $root '.env'
    if (Test-Path $envPath) {
      # Ghi bản .env CHỈ ASCII, KHÔNG BOM: panel/host đọc file bằng latin-1 hoặc
      # không hiểu BOM sẽ làm hỏng comment tiếng Việt (thành "khÃ´ng commit").
      # Chỉ giữ dòng KEY=VALUE, comment viết lại bằng ASCII không dấu.
      $stagedEnv = Join-Path $staging '.env'
      $lines = @(
        '# zalo-group-bot - env cho hosting panel (ASCII, khong BOM)',
        '# Chua token/key that. Khong chia se file nay.',
        '# Neu /home/container khong ghi duoc (EACCES mkdir data), doi:',
        '#   DATA_DIR=/tmp/zalo-data',
        ''
      )
      foreach ($line in (Get-Content $envPath -Encoding UTF8)) {
        if ($line -match '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=') {
          $lines += [regex]::Replace($line.TrimEnd(), '^LOG_FORMAT=.*$', 'LOG_FORMAT=json')
        }
      }
      [System.IO.File]::WriteAllLines($stagedEnv, $lines, (New-Object System.Text.UTF8Encoding($false)))
      Write-Host "DA KEM .env (chua token/key that) - chi dung ca nhan, dung gui zip nay cho ai" -ForegroundColor Yellow
    } else {
      Write-Warning "khong thay .env de kem"
    }
  }

  Get-ChildItem -Path $staging -Recurse -File -Include *.log, *.tmp, .DS_Store |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Get-ChildItem -Path $staging -Recurse -Directory -Include node_modules, .cache |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  $outDir = Split-Path -Parent $outPath
  if ($outDir -and -not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
  }
  if (Test-Path $outPath) { Remove-Item $outPath -Force }

  $files = Get-ChildItem -Path $staging -Recurse -File
  # QUAN TRỌNG: Compress-Archive của Windows ghi entry separator là '\', làm unzip
  # trên Linux tạo file phẳng tên "src\index.js" (không có thư mục src/).
  # Tự ghi zip để entry name luôn dùng '/' đúng chuẩn.
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $fs = [System.IO.File]::Open($outPath, [System.IO.FileMode]::Create)
  try {
    $archive = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
      foreach ($file in $files) {
        $rel = $file.FullName.Substring($staging.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
          $archive, $file.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
      }
    } finally {
      $archive.Dispose()
    }
  } finally {
    $fs.Dispose()
  }

  $files = Get-ChildItem -Path $staging -Recurse -File
  $sizeKb = [math]::Round(((Get-Item $outPath).Length / 1KB), 1)

  # Tự kiểm tra separator: nếu còn entry chứa '\' thì báo động
  $zip = [System.IO.Compression.ZipFile]::OpenRead($outPath)
  try {
    $bad = @($zip.Entries | Where-Object { $_.FullName -like '*\*' })
    $slashes = $bad.Count
  } finally {
    $zip.Dispose()
  }
  if ($slashes -gt 0) {
    Write-Warning "co $slashes entry dung backslash - unzip tren Linux se sai"
  }

  Write-Host ""
  Write-Host "Da dong goi: $outPath" -ForegroundColor Green
  Write-Host ("  {0} file, {1} KB (nen), separator: {2}" -f $files.Count, $sizeKb, $(if ($slashes -eq 0) { "OK ('/')" } else { "LOI ('\')" }))
  Write-Host ""
  Write-Host "Kiem tra:" -ForegroundColor Cyan
  if ($IncludeEnv) {
    Write-Host "  - .env CO trong goi (chua secret!) -> panel phai chay: node --env-file-if-exists=.env src/index.js"
    Write-Host "  - dung gui zip nay cho ai; upload xong thi xoa khoi may"
  } else {
    Write-Host "  - .env KHONG co trong goi -> gui rieng hoac nhap bien moi truong trong panel"
  }
  Write-Host "  - data/ KHONG co -> lich su chat o lai may dev"
  Write-Host "  - node_modules KHONG co -> server chi can Node >= 22.9"
} finally {
  if (Test-Path $staging) { Remove-Item -Path $staging -Recurse -Force -ErrorAction SilentlyContinue }
}
