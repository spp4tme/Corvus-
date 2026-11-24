# Installation de Corvus sur un PC Windows 10/11 — sans droits administrateur.
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1 -NoAutostart
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1 -Uninstall
#
# Ce script :
#   1. vérifie Node.js 20+ (et propose de l'installer avec winget s'il manque) ;
#   2. installe les dépendances (100 % JavaScript, aucune compilation) ;
#   3. crée une tâche planifiée « Corvus » qui démarre Corvus à l'ouverture de session (fenêtre masquée,
#      journal dans data\corvus.log, redémarrage automatique en cas d'arrêt) ;
#   4. démarre Corvus sur 127.0.0.1 (jamais exposé) et affiche le token d'accès.
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$NoAutostart,
  [int]$Port = 7680
)
$ErrorActionPreference = 'Stop'
$TaskName = 'Corvus'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd -and (Test-Path "$root\.tools\node\node.exe")) { $env:Path = "$root\.tools\node;$env:Path"; $cmd = Get-Command node -ErrorAction SilentlyContinue }
  if (-not $cmd) { return $null }
  $major = [int](& $cmd.Source -p 'process.versions.node.split(".")[0]')
  if ($major -lt 20) { return $null }
  return $cmd.Source
}

# --- Désinstallation ------------------------------------------------------------------------
if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Say 'Tâche planifiée supprimée.'
  }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*$root*server*index.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Say "Corvus arrêté. Vos données restent dans $root\data (supprimez ce dossier pour tout effacer : token, secrets chiffrés, hôtes)."
  return
}

# --- 1. Node.js ---------------------------------------------------------------------------
$node = Find-Node
if (-not $node) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Say 'Node.js 20+ introuvable : installation via winget (OpenJS.NodeJS.LTS)…'
    winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    # Recharge le PATH de la session courante pour voir le Node qui vient d'être installé.
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $node = Find-Node
  }
  if (-not $node) { throw 'Node.js 20+ est requis : installez-le depuis https://nodejs.org (version LTS), rouvrez PowerShell, puis relancez ce script.' }
}
Say "Node.js $(& $node -v) : $node"

# --- 2. Dépendances ---------------------------------------------------------------------------
Say 'Installation des dépendances (production, sans compilation native)'
& npm ci --omit=dev --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { throw "npm ci a échoué (code $LASTEXITCODE)" }
New-Item -ItemType Directory -Force -Path "$root\data" | Out-Null

# --- 3. Démarrage automatique -------------------------------------------------------------------
$start = "$root\deploy\windows\start-corvus.ps1"
$log = "$root\data\corvus.log"
if (-not $NoAutostart) {
  $cmd = "`$env:PORT='$Port'; & '$start' *>> '$log'"
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$cmd`"" -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force `
    -Description 'Corvus — passerelle SSH/SFTP/DevOps (127.0.0.1 uniquement)' | Out-Null
  Say "Tâche planifiée « $TaskName » créée (démarrage à l'ouverture de session)."
  Start-ScheduledTask -TaskName $TaskName
} else {
  $env:PORT = "$Port"
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "& '$start' *>> '$log'" | Out-Null
}

# --- 4. Vérification ----------------------------------------------------------------------------
$ok = $false
for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
  Start-Sleep -Milliseconds 500
  try { $ok = (Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 2).ok } catch { }
}
if (-not $ok) { throw "Corvus ne répond pas sur le port $Port : consultez $log" }

$env:CORVUS_DATA = "$root\data"
$token = (& $node "$root\server\cli.js" token).Trim()
Say "Corvus est démarré sur http://127.0.0.1:$Port"
Write-Host ''
Write-Host "  Token d'accès : $token" -ForegroundColor Green
Write-Host "  (réaffichable avec : node server\cli.js token)"
Write-Host ''
Write-Host '  Corvus n''écoute QUE sur 127.0.0.1. Pour l''atteindre depuis votre téléphone ou un autre appareil :'
Write-Host "    tailscale serve --bg --https=443 http://127.0.0.1:$Port      (HTTPS, tailnet uniquement)"
Write-Host '  Ne JAMAIS utiliser « tailscale funnel » ni ouvrir le port sur Internet.'
Write-Host ''
Write-Host "  Journal : $log"
Write-Host '  Désinstaller : powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1 -Uninstall'
