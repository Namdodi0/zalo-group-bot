# Package zalo-group-bot for deployment (leaves out node_modules, data/)
#
#   npm run pack                                # WITHOUT .env (safe to share)
#   npm run pack -- -IncludeEnv                 # WITH .env (the zip holds secrets - personal use only)
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

# Only what is needed on the server. NO: .env, data/, node_modules/, dist/
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
      Write-Warning "skipped (does not exist): $item"
    }
  }

  # Include .env only when explicitly requested
  if ($IncludeEnv) {
    $envPath = Join-Path $root '.env'
    if (Test-Path $envPath) {
      # Write the .env as ASCII ONLY, NO BOM: a panel/host that reads the file as latin-1 or
      # does not understand a BOM will mangle non-ASCII comments into mojibake.
      # Keep only KEY=VALUE lines, rewrite comments as plain ASCII.
      $stagedEnv = Join-Path $staging '.env'
      $lines = @(
        '# zalo-group-bot - env for hosting panels (ASCII, no BOM)',
        '# Holds real tokens/keys. Do not share this file.',
        '# If /home/container is not writable (EACCES mkdir data), change:',
        '#   DATA_DIR=/tmp/zalo-data',
        ''
      )
      foreach ($line in (Get-Content $envPath -Encoding UTF8)) {
        if ($line -match '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=') {
          $lines += [regex]::Replace($line.TrimEnd(), '^LOG_FORMAT=.*$', 'LOG_FORMAT=json')
        }
      }
      [System.IO.File]::WriteAllLines($stagedEnv, $lines, (New-Object System.Text.UTF8Encoding($false)))
      Write-Host "INCLUDED .env (holds real tokens/keys) - personal use only, never send this zip to anyone" -ForegroundColor Yellow
    } else {
      Write-Warning "no .env found to include"
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
  # IMPORTANT: Windows' Compress-Archive writes '\' as the entry separator, which makes unzip
  # on Linux create flat files named "src\index.js" (no src/ directory).
  # Write the zip ourselves so entry names always use '/' as the standard requires.
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

  # Self-check the separator: warn if any entry still contains '\'
  $zip = [System.IO.Compression.ZipFile]::OpenRead($outPath)
  try {
    $bad = @($zip.Entries | Where-Object { $_.FullName -like '*\*' })
    $slashes = $bad.Count
  } finally {
    $zip.Dispose()
  }
  if ($slashes -gt 0) {
    Write-Warning "found $slashes entries using backslash - unzip on Linux will be wrong"
  }

  Write-Host ""
  Write-Host "Packaged: $outPath" -ForegroundColor Green
  Write-Host ("  {0} files, {1} KB (compressed), separator: {2}" -f $files.Count, $sizeKb, $(if ($slashes -eq 0) { "OK ('/')" } else { "ERROR ('\')" }))
  Write-Host ""
  Write-Host "Checks:" -ForegroundColor Cyan
  if ($IncludeEnv) {
    Write-Host "  - .env IS in the package (holds secrets!) -> the panel must run: node --env-file-if-exists=.env src/index.js"
    Write-Host "  - do not send this zip to anyone; delete it from your machine after uploading"
  } else {
    Write-Host "  - .env is NOT in the package -> send it separately or enter the variables in the panel"
  }
  Write-Host "  - data/ is NOT included -> the chat history stays on the dev machine"
  Write-Host "  - node_modules is NOT included -> the server only needs Node >= 22.9"
} finally {
  if (Test-Path $staging) { Remove-Item -Path $staging -Recurse -Force -ErrorAction SilentlyContinue }
}
