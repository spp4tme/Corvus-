# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/). Les versions suivent [SemVer](https://semver.org/lang/fr/).
Publier une version : mettre à jour ce fichier, `package.json` et `agent/Cargo.toml`, puis `git tag vX.Y.Z && git push origin vX.Y.Z`
(le workflow `.github/workflows/release.yml` fait le reste).

## [Non publié]

### Corrigé
- **Supervision** : `df` n'est plus mal découpé quand le nom du système de fichiers ou le point de montage contient des espaces (ex. `C:/Program Files/Git`).
- **Interface** : le libellé « SIGSTOP » de la case de gel automatique n'apparaît plus là où le gel n'existe pas (hors Linux) ; helper `agentFeature` partagé entre Rembobiner et Radiographie.

### Tests
- Les 3 échecs connus sous Windows sont résolus : traduction de `/tmp` par le faux SFTP (Git Bash récent) et `df`.
- Échec intermittent « Malformed OpenSSH private key » expliqué : `ssh2` génère parfois une clé chiffrée qu'il ne relit pas (≈ 0,7 %, mesuré). Le faux sshd la contrôle, la régénère et la garde en cache. Ce n'est pas un défaut de Corvus.
- Suite complète sous Windows : 332 tests, 0 échec, 7 sautés (raisons écrites).

## [1.2.0] - 2026-11-27

L'agent Rust fonctionne aussi sous **Windows** et **macOS** (expérimental). Ce qui a été observé sur une machine réelle et ce qui ne l'a pas été est écrit
explicitement ci-dessous : *validé par la CI* ou *simulé* n'est pas *validé sur une machine réelle*.

### Ajouté
- **Agent Windows** (x64) : métriques (`cpu`, `mem`, `swap`, `df:<disque>`, `uptime`, `net:rx`/`net:tx`) et processus par `sysinfo`, évènements de fichiers par
  `ReadDirectoryChangesW` (`notify`) qui *déclenchent* le balayage (le balayage reste la source de vérité), service Windows (`run --service`), identité protégée par une
  **ACL restrictive sans héritage** (SYSTEM, Administrateurs, propriétaire). Chemins validés pour Windows (UNC, `\?\`, flux `:`, noms réservés, points finals, casse).
  *Observé sur un vrai Windows 11 : enrôlement, connexion authentifiée, métriques, Radiographie en direct, évènement de fichier, ACL réelle (`icacls`). **Pas observé** : le service Windows
  (`run --service`, droits d'administrateur requis) ni `install.ps1` de bout en bout.*
- **Agent macOS** (Apple Silicon et Intel, **EXPÉRIMENTAL**, **non signé**) : mêmes fonctions de lecture que Windows (FSEvents, `load1`), surveille `/private/etc`.
  **Jamais essayé sur un Mac réel** : compilé et testé par la CI sur des runners GitHub seulement.
- **Installation en une commande** : `install.ps1` (Windows ; SHA-256 vérifié avant toute exécution, paramètres validés, `-DryRun`, `-Uninstall`, dossier d'installation
  refusé s'il est modifiable par un non-administrateur) et **`install.sh` pour macOS** (binaire et identité dans `/Library/Application Support/CorvusAgent`, propriété de root, jamais
  `/usr/local/bin` ; LaunchDaemon `com.corvus.agent`). L'écran « Installer un agent » propose la bonne commande selon le système. `--full` n'existe que sous Linux.
  *`install.ps1` et la branche macOS de `install.sh` n'ont **jamais été exécutés pour de vrai** : le premier seulement en `-DryRun`, la seconde seulement en simulation (faux `uname`).*
- **Plateforme et capacités des agents** (serveur + interface) : `platform` (`linux|windows|macos`, facultatif, absent = linux, protocole v1 inchangé). Rembobiner, Radiographie et
  Agents **grisent ou masquent avec une explication** ce que l'agent d'un hôte ne propose pas ; le serveur répond `409 UNSUPPORTED` au lieu d'envoyer l'action. La plateforme
  **informe seulement** : aucun droit n'en dépend.
- **Hôtes Windows côté SSH** (OpenSSH Server) : détection du système, réglage « Système de l'hôte », fonctions qui supposent un shell POSIX **désactivées** (409 `POSIX_ONLY`).
  *Testé avec un faux hôte (simulation de cmd.exe), pas avec un vrai OpenSSH Server pour Windows (terminal ConPTY, SFTP, chemins `/C:/…` non vérifiés).*
- Release : binaires `corvus-agent-<v>-windows-x86_64.exe`, `-macos-aarch64`, `-macos-x86_64`, tous dans `SHA256SUMS` ; CI Windows et macOS (job `agent-os`).

### Sécurité
- **Limiteur de débit** des routes authentifiées de `/api` (JavaScript pur) : seau à jetons **par compte** (1200/min) et **par IP** (2400/min), plafond **plus strict pour les
  sauvegardes** (10/min). Réglables (`CORVUS_RATE_ACCOUNT_PER_MIN`, `CORVUS_RATE_IP_PER_MIN`, `CORVUS_RATE_BACKUP_PER_MIN`), jamais désactivables. Dépassement : **429** + `Retry-After`,
  une entrée de journal par minute et par compte/IP. *Plafonds non mesurés sous un usage réel intensif ; les WebSockets n'y sont pas soumis.*
- **Faible** : la clé privée de l'agent n'est plus écrite avant la protection du fichier (0600 / ACL) : elle était lisible un instant selon les droits hérités du dossier (`--dir`).
- Hors Linux, les capacités sont **fausses** (ports, services, restauration, gel, isolement réseau, prévisualisation, anti-ransomware) : seule la lecture existe, et le serveur ne se fie pas à `platform` pour les droits.

### Corrigé
- Alerte « programme jamais vu » : tous les `|` du chemin sont remplacés (`replaceAll`), côté serveur et interface.
- Test d'ACL de l'agent Windows indépendant de la langue de Windows ; `clippy -D warnings` sur le code Windows/macOS.

### Modifié
- Image Docker de base **épinglée par empreinte** (`node:24-alpine@sha256:…`, amd64 + arm64) ; Dependabot propose les mises à jour. *Non reconstruite localement.*
- Dépendances de l'agent hors Linux : `sysinfo`, `notify`, `windows-service` (aucune ajoutée côté Node : `npm run check:pure` reste vert).
- `test/agent-install.test.js` ajouté au script `npm test` (il n'y figurait pas) ; tests rendus portables sous Windows.

### Pas fait / limites connues
- Agent Windows : service (`run --service`) et `install.ps1` jamais exécutés pour de vrai ; OpenSSH Server pour Windows jamais essayé.
- Agent macOS : jamais essayé sur un Mac réel (ni binaire, ni `install.sh`, ni LaunchDaemon).
- Hors Linux : pas d'écrivain exact (fanotify), de ports, services, paquets, restauration, gel/arrêt de processus, isolement réseau, prévisualisation ni anti-ransomware.
- Sur la machine de développement Windows, 3 tests Node échouent aussi sur `main` (sortie de `df` de Git Bash avec espaces, chemins `/tmp` du faux sshd) : sans lien avec ce jalon.

## [1.1.0] - 2026-11-27

Cinq fonctions nouvelles, et un audit de sécurité complet (rapport : `docs/audit-1.1.0.md`).

### Ajouté
- **Comparer** : un fichier de configuration lu sur 2 à 5 hôtes (SFTP, sans shell), différences côte à côte, blocs identiques repliés ; les mots de passe,
  jetons et clés sont **masqués côté serveur** (révélation sur demande, journalisée) ; diff en JavaScript pur, tailles bornées.
- **Replays** : **recherche plein texte** dans une session ou dans toutes celles que vous pouvez relire (déchiffrement à la volée, sans index sur disque,
  séquences d'échappement retirées même coupées entre deux paquets, bornée en temps, requête jamais journalisée) et **export `.cast`**.
- **Notifications** : boutons **Ouvrir**, **Acquitter** et **Isoler…** calculés par compte ; « Isoler… » ouvre l'écran de confirmation, il n'isole jamais d'un seul geste ;
  le push reste sans contenu.
- **Copie d'hôte à hôte** (Fichiers → ⋯) : fichier ou dossier en flux par Corvus, progression, annulation sans résidu, jamais d'écrasement sans confirmation,
  liens symboliques jamais suivis, écriture atomique, limites (`COPY_MAX_MB`, `COPY_MAX_FILES`, `COPY_MAX_MBPS`).
- **Partager vers Corvus** : menu Partager d'Android et des ordinateurs (`share_target`), stockage temporaire propre au compte, envoi après le choix de l'hôte et du dossier.
  **iPhone** : Safari ne le permet pas ; page du wiki « Raccourci iPhone » (jeton d'API personnel).
- `sudo corvus journal-head` : empreinte de tête du journal d'audit à noter hors du serveur (code de sortie 2 si la chaîne est rompue).
- `SECURITY.md` (signalement privé), `docs/modele-de-menace.md`, `docs/audit-1.1.0.md`.
- CI : `npm audit`, `cargo audit`, `cargo clippy -- -D warnings`, CodeQL, OpenSSF Scorecard, Dependabot ; **actions GitHub épinglées par empreinte de commit**.

### Sécurité
Correctifs de l'audit (détails et gravité dans `docs/audit-1.1.0.md`) — **mise à jour recommandée, agents compris** :
- **Haute** : un **jeton d'API ne peut plus créer** de jeton, de passkey ni de compte (un jeton volé pouvait se perpétuer après sa révocation). Ces actions exigent une session de navigateur.
- **Moyenne** : un **lecteur** ne lit plus les journaux système, le pare-feu, les comptes de l'hôte ni l'historique des fichiers (réservés aux opérateurs) ;
  geler / dégeler / arrêter un processus par l'agent (root) est réservé à l'**administrateur de l'hôte**.
- **Moyenne** : SQLite embarqué dans l'**agent** mis à jour (RUSTSEC-2026-0459, CVE-2026-119375).
- **Moyenne** : « Partager vers Corvus » refuse les dépôts venus d'un autre site.
- **Moyenne** : **avertissement bloquant sans passphrase maître** (script d'installation, bandeau pour les administrateurs, réglages).
- Seconde barrière générique sur toutes les routes d'hôte ; identifiants d'hôte en majuscules traités comme des identifiants.
- « Journal infalsifiable » corrigé en « à chaînage cryptographique (toute modification est détectable) ».

### Modifié
- Droits : voir « Sécurité » ci-dessus (lecteur → opérateur pour quatre lectures ; processus de l'agent → administrateur).
- Le protocole de l'agent et les données restent compatibles avec la 1.0.x.

### Limites connues
- Partager vers Corvus et les boutons des notifications : testés par logique, **pas sur un vrai téléphone**. Pas de partage natif sur iPhone.
- Voir « Reste ouvert » dans `docs/audit-1.1.0.md` (jetons d'API sans expiration, rôle « lecteur » large, restauration de sauvegarde non bornée…).

## [1.0.2] - 2026-11-27

### Modifié
- Documentation : le README est minimaliste, la documentation complète est dans le **wiki** du dépôt (37 pages : installation,
  utilisation, agent, sécurité, dépannage). Deux messages de l'interface renvoient désormais au wiki au lieu du README.

## [1.0.1] - 2026-11-27

### Corrigé
- Droits par hôte : le contrôle de rôle ne tient plus compte de la casse ni d'un `/` final dans le chemin.

### Validé sur le Pi (agent 1.0.0)
- Isolement réseau : API, bouton de l'interface et levée automatique à l'expiration (voir `docs/suite-pi.md`).

## [1.0.0] - 2026-11-26

La première version stable : l'agent s'installe en une commande et sait désigner exactement qui écrit.

### Ajouté
- **Installation de l'agent en une commande** : l'écran Agents affiche `curl -fsSL …/api/agent/install.sh | sudo sh -s -- --server … --token …`.
  Le script détecte x86_64 / aarch64, télécharge le binaire de la release de la même version, **vérifie son SHA-256**, installe
  l'unité systemd (`--full` : droits complets), enrôle et démarre l'agent. `--dry-run` montre les étapes sans rien modifier.
- **fanotify** dans l'agent (droits complets) : l'**écrivain exact** d'un fichier est désigné même s'il est déjà mort (alertes
  ransomware), les **programmes de moins de 2 s** sont vus par l'empreinte du normal, et une écriture déclenche aussitôt un
  balayage des fichiers surveillés. Sans les droits, l'agent retombe sur le balayage et `/proc` comme avant.
- Nouvelle capacité annoncée : `procEvents` (en plus de `fanotify`).

### Modifié
- Numérotation : 1.0.0. Le protocole de l'agent et les données restent compatibles avec la 0.2.x.

### Limites connues
- Pas d'eBPF (Rust nightly et `bpf-linker` requis). À l'`exec`, les arguments ne sont pas encore connus.
- Pas de certificats SSH courts (bloqués par la bibliothèque `ssh2`).
- Voir « Limites connues » dans le README.

## [0.2.1] - 2026-11-26

### Modifié
- **Nouveau logo** : un corbeau de profil dessiné plume par plume dans un médaillon à graduations (`scripts/make-logo.mjs`).
  Icônes de la PWA, en-tête, écran de connexion et README mis à jour.
- Rembobinage : l'état des fichiers est regroupé par chemin dans SQLite (les changements récents d'un hôte actif n'étaient
  plus vus), l'état à l'instant visé est calculé une seule fois par restauration, le diff tient en un seul bloc mémoire.
- Enregistrements : la relecture est refusée quand l'accès à l'hôte est retiré.
- Productivité : réimporter l'historique du shell remplace l'import précédent (plus de doublons) ; l'annulation est protégée
  par un verrou atomique contre la double restauration.

## [0.2.0] - 2026-11-26

La version « multi-comptes + agent » : Corvus ne se limite plus à un terminal, il surveille, protège et sait revenir en arrière.

### Ajouté
- **Agent Corvus** (Rust, binaire statique de 3 Mo, facultatif) : enrôlement par jeton à usage unique, authentification mutuelle
  Ed25519, tampon local sans doublon après une coupure, protocole documenté (`docs/protocole-agent.md`).
- **Rembobiner** : surveillance des fichiers, versions chiffrées côté serveur, curseur de temps, diff coloré, restauration
  confirmée (jamais automatique).
- **Prévisualiser** une commande risquée dans un bac à sable (OverlayFS, sans réseau, capacités abandonnées), puis appliquer le
  diff seulement si rien n'a changé entre-temps.
- **Radiographie** : processus et lignée, session SSH d'origine, connexions, gel / dégel / arrêt de processus validés.
- **Empreinte du normal** : apprentissage de 14 jours, alerte sur tout programme, destination ou port jamais vu, alerte
  critique en heure creuse. Statistiques et règles simples, aucune IA.
- **Anti-ransomware** : fichiers pièges, détection de rafales de fichiers chiffrés (entropie), alertes critiques, isolement réseau
  nftables optionnel (Tailscale et Corvus restent joignables, levée automatique), démonstration avec un faux ransomware.
- **Comptes** nominatifs, TOTP obligatoire, passkeys (WebAuthn), rôles et droits par hôte, jetons d'API, journal d'audit
  chaîné par SHA-256.
- **Stockage SQLite** (option : disque externe), sauvegarde et restauration chiffrées en un bouton, rétention automatique.
- **Supervision étendue** : état des hôtes en continu, CPU par cœur, E/S disque, TCP, historique de 1 h à 1 an.
- **Enregistrement et relecture** des sessions, partage de terminal en direct (spectateur ou co-pilote).
- **Productivité** : snippets, exécution sur plusieurs hôtes, routines, suggestions sans IA, analyse des commandes risquées,
  mode annulable, administration façon Cockpit (services, journal, pare-feu, mises à jour, sudoers limité).
- **Contrôle vocal** continu (dictée, commandes parlées, symboles).
- **Installeurs** Linux et Windows, image Docker multi-architecture, CI GitHub (Node x86_64 et ARM64, OpenSSH réel, agent Rust).
- Cette **release** : archive de Corvus, binaires de l'agent (x86_64 et aarch64), empreintes SHA-256 et image Docker publiée
  sur `ghcr.io`.

### Modifié
- Interface refondue (« plumage ») : dock flottant, mobile d'abord, 320 px pris en charge.
- Durcissements issus d'audits : limiteurs d'essais, HSTS, droits des connexions revérifiés, enregistrement SFTP atomique,
  chemins git littéraux, capacités de l'agent bornées.

### Limites connues
- Pas d'eBPF ni de fanotify : les fichiers sont surveillés par balayage (3 à 10 s) et les processus lus dans `/proc` (2 s).
- L'isolement réseau n'a été validé qu'avec une liaison Tailscale directe.
- Voir « Limites connues » dans le README.

## [0.1.0] - 2026-11-24

### Ajouté
- Première version : hôtes SSH, terminal à onglets (xterm.js), fichiers SFTP, git distant, supervision et Docker, PWA,
  bouton Claude Code (sessions tmux), proxy de services web, notifications push.
