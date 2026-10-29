# «Гайд в директ» — установщик для Windows (запускается из «Установить.bat»).
# Ничего не ставит в систему: Node.js (если его нет) скачивается с nodejs.org
# в папку .runtime рядом с программой, зависимости — в node_modules.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Runtime = Join-Path $Root '.runtime'
$NodeMajor = 24

function Fail($msg) {
  Write-Host "`n✗ $msg" -ForegroundColor Red
  Read-Host "`nНажмите Enter, чтобы закрыть окно"
  exit 1
}

function NodeOk($exe) {
  try { & $exe -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; return $LASTEXITCODE -eq 0 } catch { return $false }
}

$NodeDir = Join-Path $Runtime 'node'
if (Test-Path (Join-Path $NodeDir 'node.exe')) {
  $NodeBin = $NodeDir
} elseif ((Get-Command node -ErrorAction SilentlyContinue) -and (NodeOk 'node')) {
  $NodeBin = Split-Path -Parent (Get-Command node).Source
} else {
  Write-Host "`n▶ Скачиваю Node.js с nodejs.org (только в папку программы)…"
  $Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $Base = "https://nodejs.org/dist/latest-v$NodeMajor.x"
  $Dl = Join-Path $Runtime 'dl'
  if (Test-Path $Dl) { Remove-Item -Recurse -Force $Dl }
  New-Item -ItemType Directory -Force $Dl | Out-Null
  try { $Sums = (Invoke-WebRequest -UseBasicParsing "$Base/SHASUMS256.txt").Content } catch { Fail 'Не получилось связаться с nodejs.org. Проверьте интернет и запустите ещё раз.' }
  $Line = ($Sums -split "`n") | Where-Object { $_ -match "node-v[0-9.]+-win-$Arch\.zip$" } | Select-Object -First 1
  if (-not $Line) { Fail 'На nodejs.org не нашлась сборка для этого компьютера.' }
  $Sum, $File = ($Line.Trim() -split '\s+')
  $Zip = Join-Path $Dl $File
  try { Invoke-WebRequest -UseBasicParsing "$Base/$File" -OutFile $Zip } catch { Fail 'Не получилось скачать Node.js. Запустите ещё раз.' }
  if ((Get-FileHash -Algorithm SHA256 $Zip).Hash.ToLower() -ne $Sum.ToLower()) { Fail 'Скачанный Node.js не прошёл проверку контрольной суммы. Запустите ещё раз.' }
  Expand-Archive -Force $Zip $Dl
  if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
  Move-Item (Join-Path $Dl ($File -replace '\.zip$', '')) $NodeDir
  Remove-Item -Recurse -Force $Dl
  $NodeBin = $NodeDir
}
$env:PATH = "$NodeBin;$env:PATH"
$env:WRANGLER_SEND_METRICS = 'false'

# Зависимости без чужих install-скриптов; повторно — только если поменялся lock-файл.
$Stamp = Join-Path $Runtime 'deps.stamp'
$Want = (Get-FileHash -Algorithm SHA256 -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes((Get-Content -Raw 'package-lock.json') + (Get-Content -Raw 'admin\package-lock.json'))))).Hash
$Have = if (Test-Path $Stamp) { (Get-Content -Raw $Stamp).Trim() } else { '' }
if (-not (Test-Path 'node_modules') -or -not (Test-Path 'admin\node_modules') -or $Have -ne $Want) {
  Write-Host "`n▶ Устанавливаю компоненты (первый раз — пара минут)…"
  & npm.cmd ci --ignore-scripts --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Fail 'Не получилось установить компоненты.' }
  & npm.cmd ci --ignore-scripts --no-audit --no-fund --loglevel=error --prefix admin
  if ($LASTEXITCODE -ne 0) { Fail 'Не получилось установить компоненты админки.' }
  New-Item -ItemType Directory -Force $Runtime | Out-Null
  Set-Content -NoNewline $Stamp $Want
}

$Port = 4546
while (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { $Port++ }
$Session = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
$Url = "http://127.0.0.1:$Port/?t=$Session"

Write-Host "`n▶ Запускаю мастер установки…"
$env:WIZARD_PORT = "$Port"
$env:WIZARD_SESSION_TOKEN = $Session
$Server = Start-Process -PassThru -NoNewWindow -FilePath (Join-Path $NodeBin 'node.exe') -ArgumentList 'installer\server.mjs'
Start-Sleep -Seconds 2
Start-Process $Url
Write-Host "`nМастер открыт в браузере: $Url"
Write-Host 'Не закрывайте это окно, пока не закончите установку.'
Wait-Process -Id $Server.Id
