# Jalon 1.2 — passation (agent Windows et macOS)

Document de passation pour un autre Claude Code qui reprend le jalon **1.2** sur une autre machine. Lisez d'abord `CLAUDE.md` (il prime) puis ce fichier.
État au moment de l'écriture : **jalon 1.2 non terminé, non publié, rien n'est fusionné dans `main`**. Tout le travail est sur la branche **`jalon-1.2`**.

## 0. Contexte en 10 lignes

- Objectif (prompt du jalon) : étendre l'agent Rust (`agent/`) à **Windows** et **macOS** (Linux seulement jusqu'à 1.1.0), avec l'interface qui grise ce qui n'est pas
  supporté, un `install.ps1`, la gestion des hôtes Windows par SSH, et la chaîne de release. macOS reste **expérimental** tant qu'un Mac réel ne l'a pas validé.
- La release **1.1.0** est publiée (tag `v1.1.0`, CI verte) : prérequis satisfait.
- La machine de travail précédente (PC d'entreprise, Windows) **ne pouvait pas exécuter `cargo test`** : une politique AppLocker refuse l'exécution des scripts de build
  produits dans `agent/target`. Tout le Rust a donc été écrit **sans compilation locale** (seul `rustfmt` a vérifié la syntaxe) et **corrigé par la CI GitHub**.
  Sur un PC sans cette restriction vous pouvez compiler et tester localement : faites-le, c'est la première chose à faire (§4).
- Ce fichier est sur `main` ; le code est sur `jalon-1.2`. Ne fusionnez `jalon-1.2` dans `main` qu'**une fois la CI verte sur Linux, Windows et macOS** (§3).
- Consigne de l'utilisateur : **ne jamais ajouter de mention de l'assistant dans les commits** (ni `Co-Authored-By`, ni autre) ; l'historique de `jalon-1.2` a été réécrit une fois
  pour les retirer (voir §6). Les commits doivent être signés par l'utilisateur seul.

## 1. Ce qui est fait (branche `jalon-1.2`, SHA actuels)

| Étape du prompt | Commit(s) | État |
|---|---|---|
| **0a** `replaceAll` (`behavior.js`, `xray.js`) | `0dfbaf2` | fait, test rouge sur l'ancien code puis vert |
| **0b** image Docker épinglée par empreinte | `1bcfb38` | fait ; digest lu au registre (amd64+arm64) ; image non reconstruite localement (CI `docker` verte) |
| **0c** limiteur de débit par compte et par IP, plafond strict sauvegardes | `61b3fb4` | fait et testé (`test/ratelimit.test.js`) |
| (préalable) portabilité Windows des tests existants | `40b9597` | 6 tests échouaient sous Windows sur le code d'origine ; 3 sont maintenant *sautés avec raison* |
| **1** (serveur) `platform` facultatif + capacités | `3daf8b0` | fait ; migration DB 4 ; protocole v1 inchangé |
| **2** UI qui grise/masque avec explication | `47e6a1d`, `25ea649` | fait ; test navigateur réel (`test/ui-platform.test.js`) |
| **6** `install.ps1` servi par Corvus | `16b78fb` | fait ; testé avec le vrai PowerShell ; **jamais exécuté en vrai** (voir §5) |
| **8** hôtes Windows côté SSH (détection, `POSIX_ONLY`) | `809b479`, `25ea649` | fait ; testé **seulement** contre une simulation de cmd.exe |
| **1, 3, 4, 5, 7, 9** agent Rust Windows/macOS + CI/release | `358cd90`, `2785e75` | **écrit, compile sur les 3 OS (CI), voir §2** |
| docs | `6f2e9d7` + wiki | CHANGELOG « Non publié » ; wiki **modifié mais seulement commité en local** (voir §5) |

Résumé de l'architecture Rust (`agent/src/platform/`) :

- `platform/mod.rs` : sélection par `cfg`, `FsWatch` (évènements du système de fichiers), `restrict_to_owner` (0600).
- `platform/linux/` : `kernel.rs`, `metrics.rs`, `sys.rs` **déplacés par `git mv`**, comportement Linux inchangé.
- `platform/portable.rs` : remplacements communs Windows/macOS — `kernel` (vide), `sys` (vide), `preview`, `actions` (seulement `xray.live`), `metrics` (**`sysinfo`** : cpu, mem,
  swap, `df:<disque>`, `uptime`, `net:rx`/`net:tx`, `load1` macOS), `procs` (`sysinfo`), `fs_events` (**`notify`** : `ReadDirectoryChangesW` / FSEvents ; il *déclenche* le balayage, qui reste la source de vérité).
- `platform/windows/` : défauts (`%ProgramData%\CorvusAgent`), `harden_secret` par **`icacls`** (ACL restrictive, SID bien connus, échec = erreur), `service.rs` (**`windows-service`**, `run --service`, arrêt propre via `STOP`).
- `platform/macos/` : défauts (`/Library/Application Support/CorvusAgent`, surveille **`/private/etc`** car `/etc` est un lien symbolique que le balayage ignore), 0600.
- `platform/pathcheck.rs` : validateurs de chemins **pour chaque système** (`..`, UNC, `\\?\`, flux `:stream`, noms réservés CON/NUL/COM1…, points/espaces finals, caractères interdits, casse) — fonctions pures testées partout.
- `main.rs` : `capabilities()` honnête par système (ports/services/ransom/isolation/preview/fanotify **faux** hors Linux ; `fsnotify` vrai), champ `platform` dans `hello_agent` et à l'enrôlement, boucle arrêtable.
- `.github/workflows/ci.yml` : job **`agent-os`** (windows-2022, macos-15, macos-15-intel : `cargo test` + `cargo build --release`, **annotations d'erreurs lisibles sans connexion**).
- `.github/workflows/release.yml` : jobs `agent-windows` et `agent-macos` → `corvus-agent-<v>-windows-x86_64.exe`, `-macos-aarch64`, `-macos-x86_64`, tous dans `SHA256SUMS` (**jamais exécutés** : ils ne tournent que sur un tag).
- Dépendances ajoutées (hors Linux uniquement) : `sysinfo 0.40`, `notify 9`, `windows-service 0.8`. `libc` réservé à Unix. `Cargo.lock` mis à jour sans changer les versions existantes.

## 2. Résultat de la CI (à relire : voir §3)

Dernier état connu, run `https://github.com/spp4tme/Corvus-/actions/runs/46025224905` (commit `358cd90`) :

| Job | Résultat |
|---|---|
| `agent (x86_64-unknown-linux-musl)`, `agent (aarch64-unknown-linux-musl)` | **succès** (l'agent Linux n'a pas régressé) |
| `qualite` (clippy `-D warnings`, `npm audit`, `cargo audit`) | **succès** |
| `real-openssh`, `docker` | **succès** |
| `node (ubuntu-24.04)`, `node (ubuntu-24.04-arm)` | encore en cours quand on a regardé |
| `agent-os (windows-2022)`, `(macos-15)`, `(macos-15-intel)` | **échec — un seul test** : `ransom::tests::un_processus_sans_lien_avec_les_dossiers_touches_nest_pas_accuse` |

Point important : **le code compile sur Windows et sur les deux macOS**, et tous les autres tests Rust y passent (dont l'ACL de l'identité sous Windows). Le seul échec était un test qui lit
`/proc/PID/fd` (propre à Linux). **Correction déjà poussée : `2785e75`** (test isolé par `#[cfg(target_os = "linux")]`). Un nouveau run CI est donc lancé sur `2785e75` : **vérifiez qu'il est vert**.

## 3. Lire la CI sans accès aux journaux (API publique, sans jeton)

Les journaux GitHub exigent une connexion ; les annotations non. Exemple (PowerShell) :

```powershell
$h = @{ 'User-Agent' = 'dev' }; $api = 'https://api.github.com/repos/spp4tme/Corvus-'
$sha = git rev-parse HEAD
$run = (Invoke-RestMethod -Headers $h -Uri "$api/actions/runs?head_sha=$sha").workflow_runs | ? name -eq 'CI' | select -First 1
(Invoke-RestMethod -Headers $h -Uri "$api/actions/runs/$($run.id)/jobs").jobs | % { "$($_.name) $($_.status) $($_.conclusion)" }
# annotations d'un job en échec (erreurs de compilation fichier:ligne, tests en échec, panics) :
Invoke-RestMethod -Headers $h -Uri "$api/check-runs/<id_du_job>/annotations"
```

Si le run est **vert partout** : passez à §4. S'il reste des échecs : corrigez sur `jalon-1.2` (jamais sur `main`), poussez, relisez. Limite : 60 requêtes/h sans jeton.

## 4. Ce qui reste à faire (dans cet ordre)

1. **Confirmer la CI verte** sur `jalon-1.2` (Linux, Windows, macOS, jobs `node` compris).
2. **Compiler et tester localement** sur votre PC (`cd agent && cargo test`), puis `npm test` (voir §6 pour l'environnement Windows).
3. **Test réel de l'agent Windows** (le prompt l'exige : « testable pour de vrai ») : `cargo build --release`, puis `corvus-agent enroll --server … --token …`, `corvus-agent run`,
   vérifier côté Corvus : métriques (`cpu`, `mem`, `df:C:`, `net:rx`…), liste des processus (Radiographie), évènements de fichiers sur un dossier surveillé, plateforme « Windows » dans l'écran Agents.
   **Rien de ceci n'a été observé sur une vraie machine** : la CI prouve seulement que ça compile et que les tests unitaires passent.
4. **Test e2e « vrai binaire contre vrai serveur » sous Windows** : `test/agent.test.js` cherche le binaire sans `.exe` (donc *sauté* sous Windows) ; à adapter pour exécuter sous Windows et macOS.
5. **Tests manquants** : (a) `fs_events` — créer un fichier doit produire un signal sur Windows/macOS ; (b) service Windows : `run --service` n'est testé par rien (il faut un administrateur ; à valider à la main) ;
   (c) installation réelle avec `install.ps1` (voir §5).
6. **Reste de l'étape 7 (macOS)** : LaunchDaemon (`deploy/agent/com.corvus.agent.plist`) et **adaptation de `install.sh`** (aujourd'hui : « L'agent ne fonctionne que sous Linux », `server/lib/agent-install.js`) pour Darwin ;
   étiqueter **expérimental** partout (interface : déjà fait ; wiki, CHANGELOG à vérifier).
7. **Étape 8, suite** : vérifier avec un **vrai OpenSSH Server pour Windows** le terminal (ConPTY), SFTP et les chemins `/C:/Users/…` (aujourd'hui : simulation seulement). Si la détection se trompe, régler « Système de l'hôte ».
8. **Audit court propre au jalon** (`CLAUDE.md`, « Déroulé d'un jalon » : écrire d'abord un test qui exploite le problème, corriger, `fix(sécurité): …`). Points listés par le prompt :
   ACL de l'identité et du service (vérifier `icacls` réel sur l'identité ; le compte `NT SERVICE\CorvusAgent` lit bien `identity.json`), chemin d'installation non inscriptible par un utilisateur standard,
   `install.ps1` (injection, intégrité avant exécution, TLS), chemins hostiles par plateforme (`pathcheck.rs` couvre déjà la logique), et **le serveur ne se fie pas à `platform` pour la sécurité** (déjà testé côté serveur).
9. **Documentation** : le wiki a été écrit en disant « l'agent Windows/macOS n'existe pas encore » ; il **doit être corrigé** maintenant que le code existe (pages `Installation-Windows-et-macOS`, `Agent-installation`,
   `Agent-vue-d-ensemble`, `Agent-droits`, `Securite`, `Limites-connues`) — en restant honnête : *validé par la CI* ≠ *validé sur une machine réelle*. README : badges réels et **une puce par nouvelle fonction** (à faire à la release).
10. **Release 1.2.0** selon `CLAUDE.md` (versions `package.json`, `package-lock.json`, `agent/Cargo.toml`, `agent/Cargo.lock` — entrée `corvus-agent` seulement —, assertion dans `test/agent.test.js`, exemple d'installation,
    section `## [1.2.0] - AAAA-MM-JJ` du CHANGELOG à partir de « Non publié ») ; vérification locale du contrôle de `release.yml` ; push ; **attendre la CI verte** ; tag `v1.2.0` ; surveiller **Release** (nouveaux jobs `agent-windows`/`agent-macos` jamais exécutés : risque réel de première erreur) ; vérifier release, binaires, `SHA256SUMS`, image `ghcr.io/spp4tme/corvus:1.2.0`.
11. **Compte rendu final** exigé par `CLAUDE.md` (livré par étape avec hash, résultats `npm test`/`cargo test`/`npm audit`/`cargo audit`, ce qui n'a pas été testé, ce que l'utilisateur doit faire à la main).

## 5. Points d'attention et choses non validées (soyez honnête dans les docs)

- **Wiki** : le dépôt wiki a été cloné sur la machine précédente (`C:\Corvus-wiki`, branche `master`) et **contient un commit local non poussé** (`2c0f0fd`, 12 pages mises à jour). Il n'est **pas** dans ce dépôt.
  Refaites ces modifications dans votre clone du wiki (`https://github.com/spp4tme/Corvus-.wiki.git`) en tenant compte du §4 point 9. Rappel : mettre à jour les pages existantes, ne rien renommer ni supprimer, vérifier par grep que chaque lien `Corvus-/wiki/<Page>` du dépôt a son fichier.
- **`install.ps1`** (`server/assets/install.ps1`) suit un *contrat* avec l'agent : `corvus-agent.exe version`, `enroll --server --token --dir`, `run --service --dir`. Le service est créé par le script (`New-Service`, compte virtuel `NT SERVICE\CorvusAgent`, repli LocalService, `sc.exe failure`).
  L'agent crée `identity.json` avec une ACL **sans héritage** ; le script donne explicitement la lecture au compte du service. **Jamais exécuté de bout en bout.** Le binaire Windows n'est publié qu'à partir d'un tag.
- **Hôtes Windows côté SSH** : détection par une sonde (`echo corvus-os:%OS%:$env:OS`), mémorisée ; le garde-fou est dans `SshPool.exec` (409 `POSIX_ONLY`, rien de POSIX n'est envoyé). Les tests utilisent l'option `windowsLike` du faux sshd (`test/helpers/fake-sshd.js`) — une simulation.
- **uid** : sous Windows/macOS le champ `uid` des processus vaut `4294967295` (« non fourni ») ; l'UI n'affiche « root » que pour 0.
- **Absences assumées hors Linux** (capacités à `false`) : écrivain exact (fanotify), ports, services, paquets, connexions par processus, restauration, gel/arrêt de processus, isolement réseau, prévisualisation, anti-ransomware. Seule la lecture (`xray.live`) existe.
- **Limiteur de débit** : plafonds 1200/min par compte, 2400/min par IP, 10/min sauvegardes ; non mesurés sur un usage réel intensif ; WebSockets non soumis.
- **Proposition en attente de décision de l'utilisateur** (non faite) : le petit helper `feat` (lecture de `agent.support`) est écrit dans `rewind.js` et `xray.js` — extraction en pièce partagée à lui demander ; le libellé « SIGSTOP » sur la case de gel automatique est propre à Linux.
- Un échec **intermittent** de `clé privée chiffrée + passphrase` (`test/e2e.test.js`) a été vu une fois en exécution complète sous Windows (« Malformed OpenSSH private key ») ; non reproduit en 5 relances du fichier ; cause inconnue.

## 6. Environnement et pièges

- **Tests sous Windows** : `CORVUS_TEST_BASH` doit pointer vers Git Bash **et** le dossier `bin` de Git doit précéder `WindowsApps\bash.exe` dans le `PATH` (ce dernier est le lanceur WSL, sans distribution). `npm run check:pure` doit rester vert.
  Résultat de référence sur la machine précédente : **318 tests, 0 échec, 3 sautés** (liens symboliques sans mode développeur, nom de fichier avec `:`). Le test navigateur utilise Edge/Chrome (`CORVUS_TEST_BROWSER`).
- **Historique de `jalon-1.2` réécrit une fois** (à la demande de l'utilisateur, `--force-with-lease`, cette branche seulement) pour retirer toute mention de l'assistant des commits. Si vous aviez un clone avant le 2026-11-27 soir : `git fetch && git checkout -B jalon-1.2 origin/jalon-1.2`.
  `main` n'a jamais été réécrit ; `origin/main` ne contient aucune mention de l'assistant.
- `CLAUDE.md` interdit `push --force` et la réécriture d'historique ; l'exception ci-dessus était explicite et limitée. Ne la reproduisez pas sans nouvelle demande.
- Travaillez sur `jalon-1.2`, **un commit par étape**, `npm test` complet vert + `npm run check:pure` + `cargo test` avant chaque commit ; messages de commit en français, format `type(portée): résumé`, **sans aucune mention d'assistant**.
- Dépendances Rust à jour au moment de l'écriture : `sysinfo` 0.40 (Rust ≥ 1.95, `System::new()` est faillible), `notify` 9 (Rust ≥ 1.91), `windows-service` 0.8. La CI utilise la toolchain `stable`.

## 7. Où trouver quoi

- Serveur : `server/lib/agent-support.js` (capacités → fonctions disponibles + raisons), `server/lib/hostos.js` (détection Windows/POSIX), `server/lib/ratelimit.js`, `server/assets/install.ps1`, `server/lib/agent-install-windows.js`.
- Interface : `public/js/views/{rewind,xray,agents,hosts}.js`.
- Tests ajoutés : `test/{ratelimit,agent-platform,ui-platform,agent-install-windows,windows-hosts}.test.js`, `test/helpers/platform.js`.
- Protocole : `docs/protocole-agent.md` (champ `platform` facultatif, section « Plateforme »).
- CHANGELOG : section `## [Non publié] - jalon 1.2` (à transformer en `## [1.2.0] - date` à la release ; contient aussi la liste de ce qui n'est pas fait — à mettre à jour).
