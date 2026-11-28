# Lancement de Corvus sur un PC Windows (sans droits administrateur).
# Usage : powershell -ExecutionPolicy Bypass -File deploy\windows\start-corvus.ps1
# Démarrage automatique : voir README, section « Sur le PC » (tâche planifiée à l'ouverture de session).
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root

# Node : celui du PATH, sinon une copie portable dans .tools\node
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node -and (Test-Path "$root\.tools\node\node.exe")) {
  $env:Path = "$root\.tools\node;$env:Path"
  $node = "$root\.tools\node\node.exe"
}
if (-not $node) { throw 'Node.js 20+ introuvable. Installez-le (https://nodejs.org) ou placez une version portable dans .tools\node.' }

if (-not (Test-Path "$root\node_modules")) { & npm ci --omit=dev }

if (-not $env:BIND) { $env:BIND = '127.0.0.1' }
if (-not $env:PORT) { $env:PORT = '7680' }
# Node écrit ses avertissements (ex. « ExperimentalWarning: SQLite ») sur stderr. Windows PowerShell 5.1 les transforme en erreur
# quand la sortie est redirigée (tâche planifiée : `*>> corvus.log`) ; avec « Stop » ci-dessus, la première tuait Corvus une seconde
# après son démarrage. On ne garde « Stop » que pour la préparation, pas pour l'exécution du serveur.
$ErrorActionPreference = 'Continue'
# Chemin ABSOLU : « install-windows.ps1 -Uninstall » retrouve et arrête le serveur par ce chemin dans sa ligne de commande.
& $node (Join-Path $root 'server\index.js')
exit $LASTEXITCODE
