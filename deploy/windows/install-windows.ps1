# Installation de Corvus sur un PC Windows 10/11 — sans droits administrateur.
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1 -NoAutostart
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1 -Uninstall
#
# Ce script :
#   1. vérifie Node.js 22.13+ (et propose de l'installer avec winget s'il manque) ;
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
  $v = (& $cmd.Source -p 'process.versions.node')
  $major = [int]($v.Split('.')[0])
  $minor = [int]($v.Split('.')[1])
  if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 13)) { return $null }
  return $cmd.Source
}

# Le port du serveur : Corvus écoute sur 127.0.0.1. Sous Windows 10/11 le port par défaut 7680 est souvent déjà pris par
# Windows lui-même (optimisation de distribution de Windows Update, processus svchost) : on le détecte et on le dit.
function Test-PortFree([int]$p) {
  $l = $null
  try { $l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $p); $l.Start(); return $true }
  catch { return $false }
  finally { if ($l) { $l.Stop() } }
}
function Resolve-CorvusPort([int]$Wanted, [bool]$Explicit) {
  if ($Wanted -lt 1024 -or $Wanted -gt 65535) { throw "Port invalide : $Wanted (entre 1024 et 65535)." }
  if (Test-PortFree $Wanted) { return $Wanted }
  # Déjà Corvus sur ce port (relance du script) : ce n'est pas un conflit.
  try { if ((Invoke-RestMethod "http://127.0.0.1:$Wanted/api/health" -TimeoutSec 2).ok) { return $Wanted } } catch { }
  $conn = Get-NetTCPConnection -LocalPort $Wanted -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  $who = if ($conn) { (Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue).ProcessName } else { $null }
  $qui = if ($who) { " par le processus « $who »" } else { '' }
  if ($Explicit) { throw "Le port $Wanted est déjà utilisé$qui. Choisissez-en un autre avec -Port (ex. -Port $($Wanted + 1))." }
  for ($p = $Wanted + 1; $p -le $Wanted + 20; $p++) {
    if (Test-PortFree $p) {
      Write-Warning "Le port $Wanted est déjà utilisé$qui (sous Windows, 7680 est souvent pris par Windows lui-même) : Corvus utilisera le port $p."
      return $p
    }
  }
  throw "Le port $Wanted est déjà utilisé$qui et aucun port libre trouvé entre $($Wanted + 1) et $($Wanted + 20) : indiquez-en un avec -Port."
}

if ($env:CORVUS_INSTALL_LIB -eq '1') { return } # chargement des fonctions seules (tests)

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
    Say 'Node.js 22.13+ introuvable : installation via winget (OpenJS.NodeJS.LTS)…'
    winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    # Recharge le PATH de la session courante pour voir le Node qui vient d'être installé.
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $node = Find-Node
  }
  if (-not $node) { throw 'Node.js 22.13+ est requis : installez-le depuis https://nodejs.org (version LTS), rouvrez PowerShell, puis relancez ce script.' }
}
Say "Node.js $(& $node -v) : $node"

# --- 2. Dépendances ---------------------------------------------------------------------------
Say 'Installation des dépendances (production, sans compilation native)'
& npm ci --omit=dev --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { throw "npm ci a échoué (code $LASTEXITCODE)" }
New-Item -ItemType Directory -Force -Path "$root\data" | Out-Null

# --- 2b. Port : libre, sinon explication (ou port suivant si -Port n'a pas été demandé) -----------------------------
$Port = Resolve-CorvusPort $Port $PSBoundParameters.ContainsKey('Port')

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
if (-not $ok) {
  $fin = if (Test-Path $log) { (Get-Content $log -Encoding Unicode -Tail 8 -ErrorAction SilentlyContinue) -join "`n" } else { '(journal vide)' }
  throw "Corvus ne répond pas sur le port $Port. Fin du journal ($log) :`n$fin"
}

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
