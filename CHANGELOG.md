# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/). Les versions suivent [SemVer](https://semver.org/lang/fr/).
Publier une version : mettre à jour ce fichier, `package.json` et `agent/Cargo.toml`, puis `git tag vX.Y.Z && git push origin vX.Y.Z`
(le workflow `.github/workflows/release.yml` fait le reste).

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
