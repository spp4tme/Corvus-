# Corvus

**Corvus** est une passerelle SSH/DevOps **auto-hébergée, gratuite et sans compte** pour les
machines de votre réseau **Tailscale**. C'est une PWA installable sur téléphone et sur PC :
terminal SSH à onglets, fichiers (SFTP), git distant, supervision et Docker, depuis n'importe quel
appareil de votre tailnet.

```
 Téléphone / PC (navigateur, PWA)
        │  HTTPS (tailscale serve) + WebSocket
        ▼
 Corvus (Node.js, sur votre PC ou un Raspberry Pi)
        │  SSH / SFTP (ssh2, pur JS)
        ▼
 Machines du tailnet (100.x.y.z ou machine.tailnet.ts.net)
```

Tailscale tourne sur vos appareils : Corvus **ne réimplémente pas** le VPN. Il ouvre les
connexions SSH à votre place et vous les présente dans le navigateur. Rien ne passe par un cloud
tiers.

---

## Sommaire

1. [Fonctionnalités](#fonctionnalités)
2. [Démarrage rapide](#démarrage-rapide-npm-start)
3. [Où l'héberger : PC ou Raspberry Pi ?](#où-lhéberger--pc-ou-raspberry-pi-)
4. [Installation sur Raspberry Pi (recommandé)](#installation-sur-raspberry-pi-recommandé)
5. [Installation avec Docker](#installation-avec-docker)
6. [Installation sur le PC](#installation-sur-le-pc)
7. [Exposer Corvus sur le tailnet (`tailscale serve`)](#exposer-corvus-sur-le-tailnet-tailscale-serve)
8. [Installer la PWA (iOS, Android, desktop)](#installer-la-pwa)
9. [Configuration](#configuration-variables-denvironnement)
10. [Sécurité](#sécurité)
11. [Claude Code](#claude-code)
12. [Tests](#tests)
13. [Structure du dépôt](#structure-du-dépôt)
14. [Limites connues](#limites-connues)

---

## Fonctionnalités

| Module | Ce qu'il fait |
|---|---|
| **Hôtes** | Ajout, modification, suppression ; alias, icône, groupes, épingles ; auth par mot de passe, clé privée (+ passphrase) ou agent SSH ; bouton **Tester la connexion** ; import depuis `tailscale status --json`. |
| **Terminal** | Onglets multiples (xterm.js), thèmes, taille de police, redimensionnement du PTY, **barre de touches mobile** (Esc, Tab, Ctrl/Alt, flèches, `\| ~ / -`, ^C, ^D, coller, copier, dictée), clavier externe, **OSC 52** (copie vers le presse-papiers), **reconnexion WebSocket automatique** (reprise à l'octet près), **mode tmux** (`tmux new-session -A`) pour survivre aux coupures. |
| **Claude Code** | Onglet **Claude** dans la navigation (et bouton sur chaque fiche d'hôte) : lance `claude` dans une session tmux dédiée, liste des sessions actives (Reprendre / Tuer / Nouvelle session). Voir [Claude Code](#claude-code). |
| **Fichiers** | Navigation SFTP, envoi (avec progression, glisser-déposer), téléchargement, nouveau dossier, renommer/déplacer, supprimer, **éditeur texte** (≤ 2 Mo, détection de conflit), aperçu d'images. |
| **Git** | Statut, branches (checkout, suivi, création), historique, diff, stage/unstage, commit, `pull --ff-only`, push, fetch, découverte des dépôts. |
| **Supervision** | CPU, RAM, swap, disques, réseau, uptime, charge, température (Pi), **graphiques temps réel** (relevé toutes les 3 s), processus (kill), **Docker** (liste, start/stop/restart, logs). |
| **Journal** | Historique local des connexions et actions (terminal, SFTP, git, Docker, accès). |
| **Services web** | Ouvre une interface web privée du tailnet via un proxy isolé (bac à sable). |
| **Bonus** | Dictée vocale (Web Speech API), **notifications push** quand une commande longue se termine ([docs/notifications.md](docs/notifications.md)). |

Interface **mobile d'abord** : thème sombre, cibles tactiles ≥ 44 px, safe-areas iOS, clavier
virtuel qui ne masque pas le terminal. Sur desktop : rail latéral.

---

## Démarrage rapide (`npm start`)

Prérequis : **Node.js 20 ou plus** ([nodejs.org](https://nodejs.org)). Aucune compilation native :
les dépendances sont 100 % JavaScript (`npm run check:pure` le vérifie).

```bash
git clone <ce dépôt> corvus && cd corvus
npm ci            # ou npm install
npm start
```

Au premier lancement, le **token d'accès** s'affiche dans la console :

```
================================================================
  PREMIER LANCEMENT — token d'accès Corvus (à coller dans l'app) :

  cv_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
================================================================
```

Ouvrez <http://127.0.0.1:7680>, collez le token, puis ajoutez un hôte (IP `100.x.y.z` ou
`machine.tailnet.ts.net`, utilisateur, mot de passe ou clé). Pour réafficher le token :
`npm run token`.

> Pour l'utiliser depuis le téléphone, exposez Corvus sur le tailnet :
> [voir `tailscale serve`](#exposer-corvus-sur-le-tailnet-tailscale-serve).

---

## Où l'héberger : PC ou Raspberry Pi ?

Corvus doit tourner sur une machine **membre du tailnet**. Deux options :

| | **(a) Sur le PC** | **(b) Sur un Raspberry Pi toujours allumé** ⭐ |
|---|---|---|
| Mise en place | La plus simple : `npm start` | Script d'installation ou Docker |
| Disponibilité | ❌ PC éteint ou en veille = Corvus inaccessible depuis le téléphone | ✅ Accessible en permanence, de partout via Tailscale |
| Sessions tmux | Elles vivent sur les hôtes cibles, mais vous ne pouvez pas les rouvrir si le PC dort | ✅ Rouvrables à tout moment depuis le téléphone |
| Notifications push | Seulement quand le PC tourne | ✅ En continu |
| Consommation | PC allumé | ~3–5 W |
| Matériel | Rien de plus | Pi 3B+/4/5 avec **Raspberry Pi OS 64 bits**, ~100 Mo de RAM pour Corvus |

**Recommandation : (b) le Raspberry Pi**, avec Tailscale installé dessus. Corvus devient votre
« bastion » personnel, joignable depuis le téléphone à tout moment. Le PC reste utile pour
essayer Corvus ou s'en servir ponctuellement.

---

## Installation sur Raspberry Pi (recommandé)

Sur un **Raspberry Pi OS 64 bits** (Bookworm ou plus récent) :

```bash
# 1. Tailscale (si ce n'est pas déjà fait)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# 2. Corvus
sudo apt install -y git
git clone <ce dépôt> ~/corvus && cd ~/corvus
sudo ./deploy/install-pi.sh

# 3. HTTPS sur le tailnet uniquement
sudo tailscale serve --bg --https=443 http://127.0.0.1:7680
```

Le script :
- installe Node.js depuis **nodejs.org**, avec vérification SHA256 et sans `curl | bash` ;
- crée l'utilisateur système `corvus` ;
- copie le code dans `/opt/corvus` et les données dans `/var/lib/corvus` (700) ;
- crée la configuration dans `/etc/corvus/corvus.env` (640) ;
- installe l'unité **systemd durcie** `corvus.service` ([deploy/corvus.service](deploy/corvus.service)) et l'active ;
- affiche le token.

Relancé plus tard, il fait office de **mise à jour** : `git pull && sudo ./deploy/install-pi.sh`.

Commandes utiles :

```bash
sudo systemctl status corvus
journalctl -u corvus -f
sudo -u corvus env CORVUS_DATA=/var/lib/corvus node /opt/corvus/server/cli.js token
sudo nano /etc/corvus/corvus.env && sudo systemctl restart corvus
```

Pour la reprise de session, installez **tmux** sur chaque machine cible (`sudo apt install tmux`),
puis cochez « tmux » dans la fiche de l'hôte.

---

## Installation avec Docker

Image **multi-architecture** (amd64/arm64), utilisateur non-root, système de fichiers en lecture
seule, volume `/data` :

```bash
docker compose up -d --build
docker compose exec corvus node server/cli.js token
sudo tailscale serve --bg --https=443 http://127.0.0.1:7680
```

`docker-compose.yml` utilise `network_mode: host`. Le conteneur écoute donc sur
`127.0.0.1:7680` **de l'hôte** et joint le tailnet via le Tailscale de l'hôte. Rien n'est publié
sur le LAN.

Pour construire pour les deux architectures, par exemple pour un registre privé :

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t corvus:latest .
```

> Dans le conteneur, le CLI `tailscale` est absent : l'import « Tailscale » et l'autorisation
> automatique de l'origine MagicDNS ne fonctionnent pas. Définissez
> `CORVUS_ALLOWED_ORIGINS=https://<machine>.<tailnet>.ts.net` dans `docker-compose.yml`.

---

## Installation sur le PC

**Windows** (sans droits administrateur) :

```powershell
cd C:\Corvus
npm ci
npm start
# ou : powershell -ExecutionPolicy Bypass -File deploy\windows\start-corvus.ps1
```

Démarrage automatique : Planificateur de tâches → *Créer une tâche* → déclencheur
« À l'ouverture de session » → action `powershell.exe`, arguments
`-WindowStyle Hidden -ExecutionPolicy Bypass -File C:\Corvus\deploy\windows\start-corvus.ps1`.

**Linux / macOS** : `npm ci && npm start`. Sur un PC Linux, l'unité systemd et le script
`deploy/install-pi.sh` fonctionnent aussi (Debian/Ubuntu x64).

Ensuite, exposez Corvus sur le tailnet ([section suivante](#exposer-corvus-sur-le-tailnet-tailscale-serve)).
Rappel : **PC éteint = Corvus inaccessible**.

---

## Exposer Corvus sur le tailnet (`tailscale serve`)

Corvus écoute par défaut sur **127.0.0.1** uniquement. `tailscale serve` le publie en **HTTPS,
seulement sur votre tailnet**, avec un certificat valide `*.ts.net` (nécessite MagicDNS et les
certificats HTTPS, activés dans la console Tailscale → DNS) :

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:7680
tailscale serve status
```

Corvus est alors joignable sur **`https://<machine>.<tailnet>.ts.net`** depuis tous vos appareils
connectés à Tailscale. Corvus autorise automatiquement cette origine si le CLI `tailscale` est
présent sur la machine.

> ⚠️ **N'utilisez jamais `tailscale funnel`** : il publierait Corvus, donc un accès shell à vos
> machines, sur **Internet**. N'ouvrez pas non plus le port 7680 sur votre box.

Alternative sans HTTPS : `BIND=100.x.y.z` (IP Tailscale de la machine), puis `http://100.x.y.z:7680`.
Fonctionne, mais sans HTTPS : pas d'installation PWA sur iOS, pas de push, presse-papiers limité.

---

## Installer la PWA

Ouvrez d'abord `https://<machine>.<tailnet>.ts.net` sur l'appareil, connecté à Tailscale.

| Plateforme | Installation |
|---|---|
| **iPhone / iPad** (Safari) | Bouton **Partager** → **Sur l'écran d'accueil** → Ajouter. Corvus s'ouvre en plein écran. Les notifications push exigent iOS 16.4+ et se règlent **depuis l'app installée** (Réglages → Notifications). |
| **Android** (Chrome) | Menu ⋮ → **Installer l'application** (ou bannière « Ajouter à l'écran d'accueil »). |
| **Windows / macOS / Linux** (Chrome, Edge) | Icône **Installer** dans la barre d'adresse, ou menu → *Installer Corvus*. |
| Firefox desktop | Pas d'installation PWA : utilisez Corvus dans un onglet. |

La coquille de l'app reste disponible hors ligne (service worker). Sans réseau, elle indique que
le serveur est injoignable. La connexion par token est demandée une fois par appareil
(session de 30 jours).

**Astuce clavier mobile** : la barre de touches reste au-dessus du clavier virtuel. Ctrl et Alt
s'appliquent à la **touche suivante** (Ctrl puis `c` = ^C). Un clavier Bluetooth fonctionne
directement.

---

## Configuration (variables d'environnement)

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `7680` | Port HTTP |
| `BIND` | `127.0.0.1` | Adresse d'écoute (IP publique refusée) |
| `CORVUS_DATA` | `./data` | Dossier des données (token, hôtes, secrets chiffrés, journal) |
| `CORVUS_MASTER_PASSPHRASE` | — | Passphrase de chiffrement des secrets (sinon : dérivée du token). Migration automatique. |
| `CORVUS_ALLOWED_ORIGINS` | — | Origines supplémentaires autorisées (séparées par des virgules) |
| `TRUST_PROXY` | `loopback` | Confiance dans `X-Forwarded-*` (valeur Express `trust proxy`) |
| `SESSION_TTL_DAYS` | `30` | Durée des sessions navigateur |
| `TERM_GRACE_SEC` | `300` | Survie d'un terminal sans navigateur attaché |
| `TERM_BUFFER_KB` | `256` | Tampon de reprise par terminal |
| `SSH_READY_TIMEOUT_MS` | `15000` | Délai de connexion SSH |
| `SSH_IDLE_MIN` | `10` | Fermeture des connexions SSH inactives |
| `MAX_UPLOAD_MB` | `1024` | Taille max d'un envoi de fichier |
| `MAX_PREVIEW_MB` | `20` | Taille max d'un aperçu d'image |
| `CORVUS_WEB_PROXY` | `1` | Active le proxy web |
| `CORVUS_PROXY_ALLOW_PRIVATE` | `0` | Autorise le proxy vers les réseaux privés (LAN) |
| `CORVUS_VAPID_SUBJECT` | `mailto:corvus@localhost` | Contact VAPID des notifications push |
| `TAILSCALE_BIN` | `tailscale` | Chemin du CLI Tailscale |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Commandes : `npm run token` (afficher le token), `npm run token:rotate` (nouveau token,
re-chiffrement, révocation des sessions).

---

## Sécurité

Résumé (détails et procédures dans [docs/securite.md](docs/securite.md)) :

- **Exposition** : 127.0.0.1 par défaut, refus d'un bind public, HTTPS via `tailscale serve`.
  **Jamais sur Internet.**
- **Authentification** : token de 256 bits (comparaison timing-safe), cookie de session
  `HttpOnly`/`SameSite=Strict`, limitation et délai sur les échecs.
- **Protection des requêtes** : anti-CSRF (en-tête `X-Corvus` + origine), Origin check sur le
  WebSocket, CSP stricte, aucun `innerHTML` avec des données distantes.
- **Secrets** : chiffrés au repos (AES-256-GCM + scrypt), fichiers en 600, jamais renvoyés au
  navigateur.
- **Host keys SSH** : TOFU, avec alerte et blocage en cas de changement.
- **Commandes** : entrées validées puis échappées ; messages de commit par stdin ; SFTP sans
  shell ; fichiers distants et proxy servis en bac à sable.

---

## Claude Code

L'onglet **Claude** de la navigation (comme Hôtes, Terminal, Fichiers ; le bouton « Claude Code » de
la fiche d'un hôte y mène) permet de choisir un hôte, puis ouvre dans le **Terminal** un onglet qui
lance `claude` sur cet hôte, **toujours dans tmux**. Si vous perdez le réseau ou fermez
l'application, Claude Code continue de tourner ; en rouvrant, vous reprenez la même session.

**Prérequis sur l'hôte** : `tmux` et `claude` installés pour l'utilisateur SSH. Si l'un manque,
Corvus n'ouvre pas de terminal : il affiche un message avec la commande d'installation
(`curl -fsSL https://claude.ai/install.sh | bash` ou `npm install -g @anthropic-ai/claude-code`,
`sudo apt install tmux`). Le premier lancement de `claude` demande de vous connecter à votre compte.

**Comportement**
- **La page Claude** affiche l'état de l'hôte (tmux, `claude` et sa version), les sessions actives
  avec **Reprendre** et **Tuer** (arrête la session tmux), et **Nouvelle session** avec un dossier
  de travail modifiable. Le terminal lui-même reste le terminal habituel.
- **Sessions** : nommées `corvus-claude-<hôte>-<n>` (`<hôte>` = alias en minuscules, 20 caractères
  maximum). Reprise par `tmux new-session -A`. La liste vient de `tmux list-sessions` : elle
  montre aussi les sessions ouvertes depuis un autre appareil.
- **Fiche de l'hôte** : *dossier de projet par défaut* (vide = dossier personnel) et *commande*
  (`claude` par défaut ; ex. `claude --continue`, `claude --model opus`).
- **Mobile** : dans un onglet Claude, la barre de touches ajoute **⇧Tab** (changer de mode dans
  Claude Code) et **Entrée** à Esc, Tab, Ctrl, Alt et flèches ; ces deux touches n'apparaissent pas
  dans un terminal ordinaire. Le champ de saisie d'xterm fait 16 px et le double-tap est neutralisé
  pour éviter les zooms.

**Sécurité**
- La commande est **construite côté serveur** (`server/lib/claude.js`). Le navigateur n'envoie que
  le nom de session (forme `corvus-claude-…-<n>` validée) et un dossier ; il ne peut pas fournir
  de commande.
- La commande de l'hôte doit commencer par `claude`, avec des mots simples (lettres, chiffres et
  `. _ = : @ / + , -`) : ni guillemets, ni `; | & $ > <`, ni texte libre avec espaces.
- Le dossier est échappé pour le shell (`~` développé hors quotes) ; il est vérifié (`test -d`)
  avant la création de la session.
- **`--dangerously-skip-permissions`** est accepté, mais : avertissement permanent dans la fiche
  de l'hôte et dans la liste des sessions, confirmation avant chaque **nouvelle** session, et
  mention dans le journal. Avec cette option, Claude Code agit **sans demander de confirmation** :
  réservez-la à une machine ou un dossier jetable.
- Le journal enregistre `claude-open` (nouvelle ou reprise) et `claude-kill`.

---

## Tests

```bash
npm test          # tout : unitaires + bout en bout + interface
npm run test:e2e  # bout en bout uniquement
npm run test:ui   # interface (Edge ou Chrome requis ; ignoré sinon)
npm run check:pure
```

- **Bout en bout** (`test/e2e.test.js`) : un vrai serveur Corvus (HTTP + WebSocket) face à un
  **sshd de test en pur JS** ([test/helpers/fake-sshd.js](test/helpers/fake-sshd.js), basé sur
  `ssh2.Server`). Ce sshd exécute les commandes via bash (Git for Windows sous Windows,
  `/bin/bash` sous Linux), sert le SFTP sur un dossier temporaire et fournit un faux `docker`
  qui journalise ses arguments. Couverture : auth, CSRF, hôtes, secrets, TOFU, terminal et
  reprise, SFTP, git (dont tentatives d'injection), supervision, processus, Docker, proxy, push,
  Claude Code (faux `tmux` et faux `claude` fournis par le sshd de test : numérotation, reprise,
  arrêt, dossier avec apostrophe, messages d'absence, tentatives d'injection).
- **Unitaires** (`test/unit.test.js`) : parseurs sur de **vraies sorties Linux** (Raspberry Pi :
  `/proc`, `df`, `ps`), `git status -z`, échappement shell vérifié dans un vrai `sh`, validateurs,
  coffre chiffré, classification d'adresses.
- **Interface** (`test/ui.test.js`) : Edge/Chrome headless via `playwright-core` (aucun navigateur
  téléchargé), viewport **375 px** (mobile) et 1280 px. Vérifie l'absence de débordement
  horizontal, les cibles tactiles ≥ 44 px et l'absence d'erreurs JavaScript. Parcours : connexion,
  ajout d'hôte, terminal, fichiers, git, supervision, Docker, services, réglages, Claude Code
  (onglet de navigation, session, reprise, arrêt). Captures dans
  `test-results/`.

---

## Structure du dépôt

```
server/                 Backend Node.js (Express + ws + ssh2)
  index.js              Point d'entrée (npm start)
  app.js                Assemblage HTTP/WebSocket, sécurité transverse
  config.js             Variables d'environnement
  cli.js                npm run token / token:rotate
  lib/                  auth, vault (chiffrement), ssh (pool + TOFU), terminal, sftp, git,
                        monitor, proxy, push, journal, validate, shell (échappement), claude (sessions tmux)…
  routes/               Routes REST par module
public/                 PWA (vanilla JS, modules ES, sans build)
  index.html, sw.js, manifest.webmanifest, icons/
  css/tokens.css        Source unique des valeurs de thème
  js/ui/                Composants partagés (boutons, champs, dialogues, graphiques…)
  js/views/             Une vue par module
deploy/                 install-pi.sh, corvus.service (systemd), windows/start-corvus.ps1
docs/                   securite.md, notifications.md
test/                   unit, e2e, ui + sshd de test
Dockerfile, docker-compose.yml
```

---

## Limites connues

**Validation**
- Les tests de bout en bout ont tourné face au **sshd de test pur JS** (sous Windows/MSYS2), pas
  face à un OpenSSH Linux réel. Les formats Linux sont couverts par des tests unitaires sur de
  vraies sorties. Un premier essai sur votre Pi reste recommandé.
- `Dockerfile`, `docker-compose.yml` et `deploy/install-pi.sh` n'ont **pas été exécutés** dans
  l'environnement de développement (pas de Docker ni de Linux) : seule la syntaxe du script a été
  vérifiée.
- Les notifications push n'ont pas été testées contre un vrai service de push. La signature VAPID
  est vérifiée par les tests, mais pas la réception sur un appareil.

**Usage**
- **Mono-utilisateur** : un seul token, pas de comptes ni de rôles.
- **Terminaux** : ils survivent aux coupures du navigateur, mais pas à un redémarrage de Corvus
  ni à une coupure SSH. Seul **tmux** permet de retrouver la session dans ces cas.
- **SSH** : pas de rebond (ProxyJump), pas de redirection de ports, pas de 2FA/TOTP
  (keyboard-interactive ne répond qu'avec le mot de passe). L'authentification « agent » exige
  `SSH_AUTH_SOCK` dans l'environnement du service.
- **Supervision** : suppose un hôte **Linux** (`/proc`) ; macOS/BSD sont partiels. Pas de
  `docker stats` ; les logs Docker se rafraîchissent à la demande (pas de suivi en direct).
- **Éditeur** : simple zone de texte, 2 Mo maximum, **UTF-8 uniquement**, pas de coloration
  syntaxique.
- **Proxy web** : servi sous un chemin préfixé, dans un bac à sable sans cookies. Les applications
  qui exigent une connexion par cookie ou des chemins absolus s'affichent mal ; ouvrez-les alors
  directement via `http://machine:port` sur le tailnet.
- **Import Tailscale** et **origine MagicDNS automatique** : exigent le CLI `tailscale` sur la
  machine Corvus (absent dans l'image Docker).
- **Sans HTTPS** : le presse-papiers (coller, OSC 52) passe par une boîte de saisie, pas de push,
  pas d'installation PWA sur iOS.
- **Dictée vocale** : Chrome, Edge et Safari seulement (pas Firefox) ; la reconnaissance peut
  passer par les serveurs du navigateur.
- **CSP** : `style-src 'unsafe-inline'` est nécessaire pour xterm.js (les scripts restent stricts).
- **Claude Code** : testé contre un **faux** `tmux` et un **faux** `claude` (le vrai `tmux` et le
  vrai `claude` n'ont pas été lancés par les tests) ; l'enchaînement réel (installation de `claude`,
  mode « sans confirmation », comportement d'un vrai `tmux` à la perte de réseau) est à essayer sur
  un hôte. La liste des sessions suppose un `tmux` récent (`list-sessions -F`). Les sessions Claude
  sont des sessions tmux : un `claude` qui se termine ferme la session.
- **Host keys** : en TOFU, la toute première connexion fait confiance à la clé présentée. Comparez
  l'empreinte affichée par « Tester » avec celle de la machine.

---

Licence : MIT. Corvus est un projet indépendant : nom, logo et interface originaux.
