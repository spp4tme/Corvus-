# Installation de l'agent Corvus @@VERSION@@ pour Windows (genere par votre serveur Corvus). LISEZ-LE avant de l'executer.
#
#   .\install.ps1 -Server https://corvus.exemple.ts.net -Token JETON [-DryRun]
#   .\install.ps1 -Uninstall [-RemoveData]
#
# Ce que fait le script (dans cet ordre) :
#   1. verifie les droits (administrateur), l'architecture (x64) et les parametres ;
#   2. telecharge le binaire de la MEME version que votre Corvus, dans le dossier d'installation (inscriptible par les
#      administrateurs seulement : personne d'autre ne peut remplacer le fichier entre la verification et l'installation) ;
#   3. verifie son SHA-256 (fichier SHA256SUMS de la release) AVANT de l'executer : refus en cas de difference ;
#   4. enrole l'agent (le jeton est a usage unique, valable 15 minutes), cree le service Windows « CorvusAgent »
#      (compte de service virtuel dedie, sinon LocalService), demarrage automatique, redemarrage en cas d'echec.
#
# Garanties : aucun Invoke-Expression, aucune execution de contenu distant non verifie, TLS verifie (aucune validation de
# certificat desactivee), parametres valides par expression reguliere et jamais assembles dans une commande en texte.
# Limite : l'empreinte vient de la meme release GitHub que le binaire ; elle protege d'un fichier corrompu ou remplace
# en cours de route, pas d'une release compromise a la source.
# -DryRun : affiche ce qui serait fait, ne telecharge rien et ne modifie rien.
[CmdletBinding()]
param(
  [ValidatePattern('^https?://[A-Za-z0-9.\-]{1,253}(:[0-9]{1,5})?\z')]   # \z = fin STRICTE : en .NET, « $ » accepterait un retour à la ligne final
  [string]$Server,
  [ValidatePattern('^[A-Za-z0-9_\-]{20,200}\z')]
  [string]$Token,
  [switch]$DryRun,
  [switch]$Uninstall,
  [switch]$RemoveData
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Version = '@@VERSION@@'
$ServiceName = 'CorvusAgent'
$InstallDir = Join-Path $env:ProgramFiles 'Corvus Agent'
$DataDir = Join-Path $env:ProgramData 'CorvusAgent'
$ExeName = 'corvus-agent.exe'
$AssetName = "corvus-agent-$Version-windows-x86_64.exe"
$BaseUrl = "https://github.com/spp4tme/Corvus-/releases/download/v$Version"
$MaxBytes = 64MB

# SID bien connus : independants de la langue de Windows (« Administrateurs », « Administrators »...).
$SidSystem = '*S-1-5-18'
$SidAdmins = '*S-1-5-32-544'
$SidUsers = '*S-1-5-32-545'
$SidLocalService = '*S-1-5-19'

function Say([string]$Message) { Write-Host "==> $Message" }
function Plan([string]$Message) { Write-Host "    (simulation) $Message" }

# --- Fonctions de verification (testables isolement : voir CORVUS_INSTALL_LIB) ----------------------------------

function Get-ExpectedHash {
  # Cherche « <sha256>  <nom> » dans le contenu de SHA256SUMS ; le nom doit correspondre EXACTEMENT.
  param([Parameter(Mandatory)][AllowEmptyString()][string]$SumsText, [Parameter(Mandatory)][string]$Name)
  foreach ($line in ($SumsText -split "`r?`n")) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$' -and $Matches[2] -ceq $Name) { return $Matches[1].ToLowerInvariant() }
  }
  return $null
}

function Test-FileSha256 {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Expected)
  if ($Expected -notmatch '^[0-9a-f]{64}$') { return $false }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  return ($actual -ceq $Expected)
}

function Assert-AdminOnlyWritable {
  # Le dossier d'installation ne doit etre inscriptible par aucun utilisateur standard (detournement de binaire).
  param([Parameter(Mandatory)][string]$Path)
  $bad = @()
  foreach ($ace in (Get-Acl -LiteralPath $Path).Access) {
    if ($ace.AccessControlType -ne 'Allow') { continue }
    $rights = [string]$ace.FileSystemRights
    if ($rights -notmatch 'Write|Modify|FullControl|CreateFiles|AppendData|Delete|ChangePermissions|TakeOwnership') { continue }
    try { $sid = $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $sid = [string]$ace.IdentityReference }
    # SYSTEM, Administrateurs, CREATOR OWNER (sans effet seul) et TrustedInstaller : tous de niveau administrateur.
    if ($sid -notin @('S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) { $bad += "$($ace.IdentityReference) ($rights)" }
  }
  if ($bad.Count) { throw "Dossier d'installation modifiable par des non-administrateurs : $($bad -join ', '). Installation refusee." }
}

if ($env:CORVUS_INSTALL_LIB -eq '1') { return } # chargement des fonctions seules (tests)

# --- Programme principal -----------------------------------------------------------------------------------------

function Invoke-Native {
  # Lance un programme avec des arguments en TABLEAU (jamais un texte assemble) et echoue sur un code de sortie non nul.
  param([Parameter(Mandatory)][string]$File, [string[]]$Arguments = @())
  & $File @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "$File a echoue (code $LASTEXITCODE)." }
}

function Test-IsAdmin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version invalide dans le script.' }
if ($Uninstall) {
  if (-not $DryRun -and -not (Test-IsAdmin)) { throw 'Lancez ce script dans une fenetre PowerShell ouverte « en tant qu''administrateur ».' }
  Say "Desinstallation de l'agent Corvus ($ServiceName)"
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($DryRun) {
    Plan "arreter et supprimer le service $ServiceName (present : $([bool]$svc))"
    Plan "supprimer $InstallDir"
    if ($RemoveData) { Plan "supprimer $DataDir (identite de l'agent comprise)" } else { Plan "conserver $DataDir (utilisez -RemoveData pour l'effacer)" }
    return
  }
  if ($svc) {
    if ($svc.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force; $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }
    Invoke-Native 'sc.exe' @('delete', $ServiceName)
  }
  if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
  if ($RemoveData -and (Test-Path -LiteralPath $DataDir)) { Remove-Item -LiteralPath $DataDir -Recurse -Force }
  Say 'Termine. Revoquez aussi l''agent dans l''ecran Agents de Corvus.'
  return
}

if (-not $Server -or -not $Token) { throw 'Usage : .\install.ps1 -Server https://corvus -Token JETON [-DryRun]   (ou -Uninstall)' }
if ($Server -match '^http://' -and $Server -notmatch '^http://(localhost|127\.0\.0\.1)(:|$)') {
  throw 'Adresse http:// refusee (sauf localhost) : utilisez https:// (ex. tailscale serve).'
}
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne 'AMD64') { throw "Architecture non prise en charge : $arch (Windows x64 seulement)." }
if (-not $DryRun -and -not (Test-IsAdmin)) { throw 'Lancez ce script dans une fenetre PowerShell ouverte « en tant qu''administrateur ».' }

$exe = Join-Path $InstallDir $ExeName
$staged = Join-Path $InstallDir "$ExeName.new"
Say "Agent Corvus $Version pour Windows x64"

if ($DryRun) {
  Plan "creer $InstallDir (SYSTEM et Administrateurs : controle total ; Utilisateurs : lecture seule)"
  Plan "telecharger $BaseUrl/$AssetName"
  Plan "verifier le SHA-256 avec $BaseUrl/SHA256SUMS avant toute execution"
  Plan "creer $DataDir (identite Ed25519 : SYSTEM, Administrateurs et le compte du service seulement)"
  Plan "$exe enroll --server $Server --token ********"
  Plan "creer le service $ServiceName (compte « NT SERVICE\$ServiceName », demarrage automatique, redemarrage sur echec)"
  Plan "demarrer le service"
  return
}

# TLS 1.2 minimum, certificats verifies (on ne touche JAMAIS a la validation des certificats).
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

function Get-Remote([string]$Url, [string]$OutFile) {
  if ($Url -notmatch '^https://') { throw "Telechargement refuse (HTTPS obligatoire) : $Url" }
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile -MaximumRedirection 5 -TimeoutSec 120
}

# 1. Dossier d'installation : ACL posee AVANT le telechargement (heritage coupe).
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Invoke-Native 'icacls.exe' @($InstallDir, '/inheritance:r', '/grant:r', "${SidSystem}:(OI)(CI)F", "${SidAdmins}:(OI)(CI)F", "${SidUsers}:(OI)(CI)RX")
Assert-AdminOnlyWritable -Path $InstallDir

# Mise a jour : on arrete l'ancien service pour pouvoir remplacer le binaire.
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -ne 'Stopped') { Say 'Arret du service existant'; Stop-Service -Name $ServiceName -Force; $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }

# 2-3. Telechargement puis verification AVANT execution.
try {
  Say "Telechargement : $BaseUrl/$AssetName"
  Get-Remote "$BaseUrl/$AssetName" $staged
  if ((Get-Item -LiteralPath $staged).Length -gt $MaxBytes) { throw "Fichier trop gros (> $($MaxBytes / 1MB) Mo) : refuse." }
  $sumsFile = Join-Path $InstallDir 'SHA256SUMS.tmp'
  Get-Remote "$BaseUrl/SHA256SUMS" $sumsFile
  $want = Get-ExpectedHash -SumsText (Get-Content -LiteralPath $sumsFile -Raw) -Name $AssetName
  Remove-Item -LiteralPath $sumsFile -Force
  if (-not $want) { throw "Empreinte de $AssetName introuvable dans SHA256SUMS : installation refusee." }
  if (-not (Test-FileSha256 -Path $staged -Expected $want)) { throw 'Empreinte SHA-256 incorrecte : installation refusee, fichier supprime.' }
  Say 'Empreinte SHA-256 verifiee'
  Move-Item -LiteralPath $staged -Destination $exe -Force
} finally {
  if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue }
}
Invoke-Native $exe @('version')

# 4. Donnees de l'agent (identite) : controle total SYSTEM et Administrateurs ; le compte du service est ajoute plus bas.
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Invoke-Native 'icacls.exe' @($DataDir, '/inheritance:r', '/grant:r', "${SidSystem}:(OI)(CI)F", "${SidAdmins}:(OI)(CI)F")

Say "Enrolement aupres de $Server"
Invoke-Native $exe @('enroll', '--server', $Server, '--token', $Token, '--dir', $DataDir)

# 5. Service Windows : compte virtuel dedie « NT SERVICE\CorvusAgent » (sans mot de passe), sinon LocalService.
if (-not $existing) {
  $bin = '"{0}" run --service --dir "{1}"' -f $exe, $DataDir
  New-Service -Name $ServiceName -BinaryPathName $bin -DisplayName 'Agent Corvus' -StartupType Automatic `
    -Description 'Agent Corvus : metriques et surveillance, connexion sortante vers votre serveur Corvus (aucun port ouvert).' | Out-Null
}
$account = "NT SERVICE\$ServiceName"
try {
  Invoke-Native 'sc.exe' @('config', $ServiceName, 'obj=', $account)
  Invoke-Native 'icacls.exe' @($DataDir, '/grant:r', "${account}:(OI)(CI)M")
  # L'identité a une ACL restrictive SANS héritage (posée par l'agent) : le compte du service doit y être nommé, en lecture seule.
  Invoke-Native 'icacls.exe' @((Join-Path $DataDir 'identity.json'), '/grant:r', "${account}:(R)")
} catch {
  Write-Warning "Compte de service dedie indisponible ($($_.Exception.Message)) : repli sur LocalService."
  $account = 'NT AUTHORITY\LocalService'
  Invoke-Native 'sc.exe' @('config', $ServiceName, 'obj=', $account)
  Invoke-Native 'icacls.exe' @($DataDir, '/grant:r', "${SidLocalService}:(OI)(CI)M")
  Invoke-Native 'icacls.exe' @((Join-Path $DataDir 'identity.json'), '/grant:r', "${SidLocalService}:(R)")
}
Invoke-Native 'sc.exe' @('failure', $ServiceName, 'reset=', '86400', 'actions=', 'restart/5000/restart/5000/restart/30000')
Say "Service $ServiceName configure (compte : $account)"

Start-Service -Name $ServiceName
Say 'Termine : l''agent apparait « en ligne » dans l''ecran Agents de Corvus.'
