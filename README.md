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
3. [Où l'héberger : PC, serveur ou Raspberry Pi ?](#où-lhéberger--pc-serveur-ou-raspberry-pi-)
4. [Installation sur Linux : serveur, PC, Raspberry Pi (recommandé)](#installation-sur-linux--serveur-pc-raspberry-pi-recommandé)
5. [Installation avec Docker](#installation-avec-docker)
6. [Installation sur un PC Windows ou macOS](#installation-sur-un-pc-windows-ou-macos)
7. [Exposer Corvus sur le tailnet (`tailscale serve`)](#exposer-corvus-sur-le-tailnet-tailscale-serve)
8. [Installer la PWA (iOS, Android, desktop)](#installer-la-pwa)
9. [Configuration](#configuration-variables-denvironnement)
10. [Sécurité](#sécurité)
11. [Claude Code](#claude-code)
12. [Agent Corvus (optionnel)](#agent-corvus-optionnel)
13. [Tests](#tests)
14. [Structure du dépôt](#structure-du-dépôt)
15. [Limites connues](#limites-connues)

---

## Fonctionnalités

| Module | Ce qu'il fait |
|---|---|
| **Hôtes** | Ajout, modification, suppression ; alias, icône, groupes, épingles ; **état en continu** (« en ligne · 23 ms » / « injoignable depuis 12 min », sonde TCP de fond, alerte après 5 min) ; auth par mot de passe, clé privée (+ passphrase) ou agent SSH ; bouton **Tester la connexion** ; import depuis `tailscale status --json`. |
| **Terminal** | Onglets multiples (xterm.js), thèmes, taille de police, redimensionnement du PTY, **barre de touches mobile** (Esc, Tab, Ctrl/Alt, flèches, `\| ~ / -`, ^C, ^D, coller, copier, dictée), clavier externe, **OSC 52** (copie vers le presse-papiers), **reconnexion WebSocket automatique** (reprise à l'octet près), **mode tmux** (`tmux new-session -A`) pour survivre aux coupures, **défilement de l'historique au doigt** sur mobile (voir [Terminal sur mobile](#terminal-sur-mobile)). |
| **Claude Code** | Onglet **Claude** dans la navigation (et bouton sur chaque fiche d'hôte) : lance `claude` dans une session tmux dédiée, liste des sessions actives (Reprendre / Tuer / Nouvelle session). Voir [Claude Code](#claude-code). |
| **Fichiers** | Navigation SFTP, envoi (avec progression, glisser-déposer), téléchargement, nouveau dossier, renommer/déplacer, supprimer, **éditeur texte** (≤ 2 Mo, détection de conflit), aperçu d'images. |
| **Git** | Statut, branches (checkout, suivi, création), historique, diff, stage/unstage, commit, `pull --ff-only`, push, fetch, découverte des dépôts. |
| **Supervision** | CPU (global et **par cœur**), RAM, swap, disques, **E/S disque** (débit, IOPS), réseau, **TCP** (connexions établies, retransmissions), uptime, charge, température (Pi), graphiques temps réel (3 s), **historique stocké** (collecte de fond toutes les 30 s : 1 h, 24 h, 7 jours, 1 an), processus (kill), **Docker** (liste, start/stop/restart, logs). |
| **Journal** | Journal d'audit **infalsifiable** (chaîné par SHA-256, vérifiable) : connexions, terminaux, SFTP, git, Docker, comptes, sauvegardes, avec le compte et l'IP. |
| **Enregistrements** | Chaque session de terminal est enregistrée (asciicast, **sortie seulement**, chiffrée) et se relit comme une vidéo : lecture / pause, vitesse ×0,5 à ×8, saut des pauses, barre de progression, **recherche de texte**. |
| **Partage en direct** | Le propriétaire d'un terminal l'ouvre à un autre compte en **spectateur** (sans clavier) ou **co-pilote**, et retire l'accès quand il veut. |
| **Commandes** | **Snippets** (par hôte ou globaux), **exécution sur plusieurs hôtes** avec résultats côte à côte, **routines** détectées dans l'historique → bouton en un clic. |
| **Barre de commande** | Sous le terminal : suggestions **sans IA** (historique fréquence × récence, chemins via SFTP, commande suivante par n-grammes), **analyse des commandes risquées** avant envoi, mode **« annulable »** (Ctrl+Z du terminal : fichiers sauvegardés avant, restaurés en un bouton). |
| **Admin** | Façon Cockpit, par hôte : services systemd (état, démarrer / arrêter / redémarrer), **journal en direct** filtrable, pare-feu (ufw en lecture/écriture, nftables en lecture), utilisateurs, **mises à jour en attente**, règle **sudoers limitée** générée. |
| **Comptes** | Comptes nominatifs, **TOTP obligatoire**, **passkeys** (WebAuthn) en option, rôles administrateur / opérateur / lecture seule, droits par hôte ou groupe, jetons d'API. |
| **Stockage** | Base SQLite (option : SSD externe), rétention automatique, **sauvegarde / restauration chiffrées en un bouton**, alerte d'espace disque. |
| **Services web** | Ouvre une interface web privée du tailnet via un proxy isolé (bac à sable). |
| **Bonus** | Dictée vocale (Web Speech API), **notifications push** quand une commande longue se termine ([docs/notifications.md](docs/notifications.md)). |

Interface **mobile d'abord** : thème sombre, cibles tactiles ≥ 44 px, safe-areas iOS, clavier
virtuel qui ne masque pas le terminal. Sur desktop : rail latéral.

---

## Démarrage rapide (`npm start`)

Prérequis : **Node.js 22.13 ou plus** (24 LTS recommandé) ([nodejs.org](https://nodejs.org)). Aucune compilation native :
les dépendances sont 100 % JavaScript (`npm run check:pure` le vérifie).

```bash
git clone https://github.com/spp4tme/Corvus-.git corvus && cd corvus
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

Ouvrez <http://127.0.0.1:7680>, collez le token puis **créez le compte administrateur**
(identifiant, mot de passe, puis double authentification TOTP dans votre application
d'authentification : Aegis, Google Authenticator, 1Password…). Ajoutez ensuite un hôte (IP
`100.x.y.z` ou `machine.tailnet.ts.net`, utilisateur, mot de passe ou clé). Le token ne sert plus
qu'à cette première étape ; pour le réafficher : `npm run token`.

Autres comptes : *Réglages → Utilisateurs* (rôle, hôtes ou groupes accordés, mot de passe
provisoire à changer à la première connexion, TOTP enrôlé à ce moment-là).

> **Chaque installation génère son propre token** et garde ses secrets dans son dossier `data/`
> (ignoré par git) : le dépôt ne contient aucune clé, aucun token ni aucun identifiant.

> Pour l'utiliser depuis le téléphone, exposez Corvus sur le tailnet :
> [voir `tailscale serve`](#exposer-corvus-sur-le-tailnet-tailscale-serve).

---

## Où l'héberger : PC, serveur ou Raspberry Pi ?

Corvus doit tourner sur une machine **membre du tailnet**, ou joignable par un tunnel SSH. Deux
familles d'hébergement :

| | **(a) Sur un PC** | **(b) Sur un serveur Linux ou un Raspberry Pi toujours allumé** ⭐ |
|---|---|---|
| Mise en place | La plus simple : `npm start` ou le script Windows | Script d'installation Linux ou Docker |
| Disponibilité | ❌ PC éteint ou en veille = Corvus inaccessible depuis le téléphone | ✅ Accessible en permanence, de partout via Tailscale |
| Sessions tmux | Elles vivent sur les hôtes cibles, mais vous ne pouvez pas les rouvrir si le PC dort | ✅ Rouvrables à tout moment depuis le téléphone |
| Notifications push | Seulement quand le PC tourne | ✅ En continu |
| Consommation | PC allumé | ~3–5 W (Pi) ; ~100 Mo de RAM pour Corvus |
| Matériel | Rien de plus | Tout Linux avec systemd (x86_64 ou arm64) : VPS, mini-PC, NAS, Pi 3B+/4/5 en **Raspberry Pi OS 64 bits** |

**Recommandation : (b)**, avec Tailscale installé dessus. Corvus devient votre « bastion »
personnel, joignable depuis le téléphone à tout moment. Le PC reste utile pour essayer Corvus ou
s'en servir ponctuellement.

---

## Installation sur Linux : serveur, PC, Raspberry Pi (recommandé)

**Un seul script** pour toutes les distributions avec systemd — Debian, Ubuntu, Raspberry Pi OS,
Fedora, RHEL/Rocky/Alma, openSUSE, Arch — en **x86_64 ou arm64** :

```bash
# 1. Corvus (git : sudo apt install -y git  /  sudo dnf install -y git)
git clone https://github.com/spp4tme/Corvus-.git ~/corvus && cd ~/corvus
sudo ./deploy/install-linux.sh

# 2. Y accéder depuis votre téléphone ou votre PC : voir « Accéder à Corvus » ci-dessous
```

Le script :
- installe Node.js 22.13+ depuis **nodejs.org**, avec vérification SHA256 et sans `curl | bash`
  (seulement si votre système n'en a pas déjà un assez récent) ;
- crée l'utilisateur système `corvus` ;
- copie le code dans `/opt/corvus` et les données dans `/var/lib/corvus` (700) ;
- crée la configuration dans `/etc/corvus/corvus.env` (640) ;
- installe l'unité **systemd durcie** `corvus.service` ([deploy/corvus.service](deploy/corvus.service)) et l'active ;
- installe la commande d'administration **`corvus`** ;
- affiche le token d'accès.

Corvus n'écoute qu'en **127.0.0.1:7680** : rien n'est exposé sur le réseau tant que vous ne le
décidez pas.

### Accéder à Corvus

| Méthode | Commande | Quand l'utiliser |
|---|---|---|
| **Tailscale** (recommandé) | `curl -fsSL https://tailscale.com/install.sh \| sh && sudo tailscale up`<br>`sudo tailscale serve --bg --https=443 http://127.0.0.1:7680` | HTTPS valide, téléphone, PWA, notifications push |
| **Tunnel SSH** (rien à installer) | `ssh -L 7680:127.0.0.1:7680 utilisateur@serveur`, puis <http://127.0.0.1:7680> | Test rapide depuis un PC ; pas de HTTPS, donc pas de push ni de PWA iOS |

### Administration

```bash
sudo corvus token            # afficher le token d'accès
sudo corvus rotate-token     # nouveau token, re-chiffrement des secrets, sessions révoquées
sudo corvus status           # état du service
sudo corvus logs 200         # 200 dernières lignes du journal
sudo corvus restart
sudo nano /etc/corvus/corvus.env && sudo corvus restart    # configuration
```

### Mise à jour, options, désinstallation

```bash
cd ~/corvus && git pull && sudo ./deploy/install-linux.sh      # mise à jour (données conservées)
sudo ./deploy/install-linux.sh --no-service                    # copie + dépendances, sans systemd
sudo NODE_MAJOR=22 ./deploy/install-linux.sh                   # version de Node.js installée si absente
sudo ./deploy/install-linux.sh --uninstall                     # retire service et code, garde les données
sudo ./deploy/install-linux.sh --uninstall --purge             # … et supprime aussi les données
```

`deploy/install-pi.sh` est conservé comme alias de `install-linux.sh`. Sans systemd (Alpine,
conteneur), utilisez `--no-service` ou [Docker](#installation-avec-docker).

**Recommandé** : définissez `CORVUS_MASTER_PASSPHRASE` dans `/etc/corvus/corvus.env`. Sans
passphrase, les secrets sont chiffrés avec une clé dérivée du token, stocké dans le même
dossier : voler `/var/lib/corvus` donnerait accès aux secrets.

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

## Installation sur un PC Windows ou macOS

**Windows 10/11** (sans droits administrateur) — un script fait tout :

```powershell
git clone https://github.com/spp4tme/Corvus-.git C:\Corvus
cd C:\Corvus
powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1
```

Il vérifie Node.js 22.13+ (et l'installe avec `winget` s'il manque), installe les dépendances,
crée une **tâche planifiée « Corvus »** (démarrage à l'ouverture de session, fenêtre masquée,
redémarrage automatique, journal dans `data\corvus.log`), démarre Corvus et affiche le token.
Options : `-Port 7681`, `-NoAutostart` (pas de tâche planifiée), `-Uninstall` (retire la tâche et
arrête Corvus ; `data\` est conservé).

Sans script : `npm ci` puis `npm start`, ou
`powershell -ExecutionPolicy Bypass -File deploy\windows\start-corvus.ps1`.

**macOS** : installez Node.js 22.13+ (`brew install node`), puis `npm ci && npm start`. Pour un
démarrage automatique, créez un agent `launchd` (`~/Library/LaunchAgents/corvus.plist`) qui lance
`node /chemin/vers/corvus/server/index.js` avec `RunAtLoad` et `KeepAlive`.

**PC Linux** : utilisez le [script Linux](#installation-sur-linux--serveur-pc-raspberry-pi-recommandé)
ci-dessus, ou `npm ci && npm start` pour un essai sans service.

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
le serveur est injoignable. La connexion (mot de passe + code TOTP) est demandée une fois par appareil
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
| `CORVUS_DATA` | `./data` | Petit dossier de configuration (token d'amorçage) ; contient aussi la base si `CORVUS_STORAGE` est vide |
| `CORVUS_STORAGE` | — | **Données lourdes** : base SQLite, enregistrements de session, sauvegardes. Ex. `/mnt/ssd/corvus` sur un SSD externe. Le dossier doit exister : Corvus refuse de démarrer si le disque n'est pas monté |
| `HOST_PROBE_SEC` | `60` | Intervalle de la sonde d'état des hôtes (0 = désactivée) ; les hôtes injoignables sont re-testés de plus en plus rarement (jusqu'à 15 min) |
| `HOST_DOWN_ALERT_MIN` | `5` | Alerte (journal + push) quand un hôte reste injoignable plus longtemps |
| `METRICS_INTERVAL_SEC` | `30` | Collecte de fond des métriques (0 = désactivée) ; un hôte injoignable est sauté |
| `RECORD_SESSIONS` | `1` | Enregistre les sessions de terminal (sortie seulement) |
| `RECORDING_MAX_MB` | `50` | Taille max d'un enregistrement (au-delà, il s'arrête proprement) |
| `CORVUS_MIN_FREE_MB` | `2048` | Seuil d'alerte d'espace libre (le plus grand de ce seuil et de 5 % du disque) |
| `RETENTION_METRICS_RAW_DAYS` | `7` | Conservation des métriques détaillées (ensuite : agrégats horaires) |
| `RETENTION_METRICS_HOURLY_DAYS` | `365` | Conservation des agrégats horaires |
| `RETENTION_RECORDINGS_DAYS` | `90` | Conservation des enregistrements de session |
| `RETENTION_UNDO_DAYS` | `30` | Conservation des sauvegardes « annulables » |
| `CORVUS_MASTER_PASSPHRASE` | — | Passphrase de chiffrement des secrets (**recommandée** : sinon la clé est dérivée du token, stocké dans le même dossier). Migration automatique. |
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

### Stockage : base SQLite et disque externe

Toutes les données sont dans une base **SQLite** (`corvus.db`, mode WAL), via le module SQLite
**intégré à Node.js** (≥ 22.13) : aucune dépendance native. Au premier démarrage, les anciens
fichiers JSON (`hosts.json`, `journal.jsonl`, `secrets.enc.json`…) sont **migrés
automatiquement** puis renommés en `*.migrated` (rien n'est supprimé).

Sur un Raspberry Pi, placez les données lourdes sur un SSD plutôt que sur la carte SD :

```bash
sudo mkdir -p /mnt/ssd/corvus && sudo chown corvus:corvus /mnt/ssd/corvus && sudo chmod 700 /mnt/ssd/corvus
echo 'CORVUS_STORAGE=/mnt/ssd/corvus' | sudo tee -a /etc/corvus/corvus.env
sudo ./deploy/install-linux.sh   # autorise l'écriture sur le SSD (ReadWritePaths) et redémarre
```

Corvus surveille l'espace libre (toutes les 10 min) et prévient par un bandeau, une notification
push et le journal quand il passe sous `CORVUS_MIN_FREE_MB`.

**Rétention** (tâche horaire) : métriques détaillées 7 jours puis agrégées par heure (min / moy /
max) pendant 1 an, enregistrements de session 90 jours, sauvegardes « annulables » 30 jours.
Le journal d'audit n'est **jamais** purgé. Durées réglables (voir le tableau ci-dessus).

**Gros contenus** (enregistrements de session, copies de fichiers) : `<stockage>/blobs/`,
compressés (brotli) puis chiffrés (AES-256-GCM, clé du coffre), dédupliqués par empreinte.

### Sauvegarde et restauration

*Réglages → Stockage et sauvegardes* :

- **Créer une sauvegarde** : un fichier `.cvbk` (base, enregistrements, token d'amorçage) chiffré
  par un mot de passe choisi à ce moment-là (10 caractères min.), dans `<stockage>/backups/`.
  Téléchargeable pour la garder ailleurs.
- **Restaurer** (depuis la liste ou un fichier) : le fichier est déchiffré et vérifié
  (`integrity_check`), puis appliqué **au prochain démarrage**. L'état remplacé est conservé dans
  `<stockage>/pre-restore-<date>/`. Le bouton « Redémarrer » fonctionne sous systemd et Docker.
- Si une passphrase maître est utilisée, elle reste nécessaire après restauration.

---

## Sécurité

Résumé (détails et procédures dans [docs/securite.md](docs/securite.md)) :

- **Exposition** : 127.0.0.1 par défaut, refus d'un bind public, HTTPS via `tailscale serve`.
  **Jamais sur Internet.**
- **Comptes** : identifiant + mot de passe + **TOTP obligatoire** ; rôles administrateur /
  opérateur / lecture seule, droits par hôte ou par groupe ; jetons d'API personnels. Le token
  affiché au premier lancement sert seulement à créer le premier administrateur.
- **Journal d'audit infalsifiable** : chaîné par SHA-256, vérifiable depuis *Journal*.
- **Protection des requêtes** : anti-CSRF (en-tête `X-Corvus` + origine), Origin check sur le
  WebSocket, CSP stricte, aucun `innerHTML` avec des données distantes.
- **Secrets** : chiffrés au repos (AES-256-GCM + scrypt), fichiers en 600, jamais renvoyés au
  navigateur.
- **Host keys SSH** : TOFU, avec alerte et blocage en cas de changement.
- **Commandes** : entrées validées puis échappées ; messages de commit par stdin ; SFTP sans
  shell ; fichiers distants et proxy servis en bac à sable.

---

## Terminal sur mobile

- **Défiler l'historique** : glissez un doigt vers le bas sur le terminal pour remonter, vers le
  haut pour redescendre. Le geste est converti en molette de souris : avec **tmux**, l'historique
  défile et la sortie du mode copie est automatique en bas. Les sessions tmux et Claude lancées
  par Corvus activent `mouse on` (`tmux set -g mouse on` pour une session existante). Sans tmux,
  c'est l'historique du terminal (xterm.js) qui défile.
- La page ne bouge pas pendant le geste (`touch-action: none` dans la zone du terminal).
- **Sélection de texte** : avec `mouse on`, tmux gère la souris. Sur ordinateur, Maj + glisser
  sélectionne comme avant ; la copie depuis tmux passe par OSC 52 (presse-papiers).

## Barre de commande, Ctrl+Z du terminal et administration

**Barre de commande** (sous le terminal, désactivable dans les Réglages) : tapez la commande, elle
est **analysée par des règles** avant d'être envoyée au shell. Commande sans risque : envoyée
directement. Commande à risque (`rm`, `mv`, `sed -i`, `chmod -R`, `> fichier`, écritures dans
`/etc`, `systemctl stop`, `git push --force`, `curl | sh`…) : les raisons s'affichent, puis :

- **Exécuter avec annulation** : les fichiers visés sont copiés (chiffrés) avant ; le bouton
  **« Annuler : … »** les remet exactement en place (contenu, droits, date) et retire ceux que la
  commande a créés. Conservation : 30 jours.
- **Exécuter quand même** / **Annuler**.

Limites, affichées à chaque fois : seuls les fichiers **déductibles des arguments** sont
sauvegardés (pas ceux modifiés par un script) ; pas de `sudo` (fichiers root) ni de `$( … )` ;
200 Mo / 2 000 fichiers au plus ; réseau, services, paquets, bases de données et processus ne
s'annulent jamais. La **prévisualisation** en bac à sable (OverlayFS) arrivera avec l'agent.

Pour les chemins relatifs, Corvus doit connaître le dossier courant du shell : il le lit dans la
séquence **OSC 7** (émise par zsh/fish avec la plupart des thèmes). Pour bash, ajoutez à `~/.bashrc` :

```bash
PROMPT_COMMAND='printf "\033]7;file://%s%s\033\\" "$HOSTNAME" "$PWD"'${PROMPT_COMMAND:+;$PROMPT_COMMAND}
```

Sans OSC 7, le mode annulable n'est proposé que pour des chemins absolus ou en `~/`.

**Suggestions** (sans IA) : historique de l'hôte classé par fréquence × récence, complétion de
chemins par SFTP, et « commande suivante » apprise sur vos propres enchaînements (n-grammes).
*Commandes → Routines* importe `~/.bash_history` / `~/.zsh_history` et repère les suites de
commandes répétées pour en faire un bouton.

**Admin** : les actions root passent par `sudo -n` (jamais de mot de passe stocké). L'onglet
*Sudo* génère une règle **limitée** aux actions de Corvus (pas de shell, pas de `journalctl`/`less`
qui permettraient d'en sortir), à installer avec `sudo visudo -cf` après relecture. Garde-fous :
Corvus refuse de bloquer son propre port SSH ou de verrouiller le compte SSH qu'il utilise. Les
mises à jour s'installent **dans un terminal** (commande tapée, jamais validée à votre place).

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

## Agent Corvus (optionnel)

Par défaut Corvus travaille **uniquement par SSH**, sans rien installer sur les hôtes. L'**agent**
(`agent/`, en Rust) est un petit programme facultatif qui se connecte **vers** Corvus (aucun port ouvert
sur l'hôte) et lui envoie des métriques ; il prépare les fonctions avancées du plan (`docs/plan.md`).
État actuel : enrôlement, authentification mutuelle Ed25519, tampon local, métriques. Rien d'autre.

```bash
# 1. Compiler (une fois, sur une machine avec Rust ; binaire statique musl, environ 3 Mo)
cd agent && rustup target add aarch64-unknown-linux-musl     # ou x86_64-unknown-linux-musl
cargo build --release --target aarch64-unknown-linux-musl

# 2. Créer un jeton à usage unique (15 min) pour un hôte : API admin
curl -s -X POST -H "Authorization: Bearer <jeton d'API admin>" -H 'content-type: application/json' \
     -d '{"hostId":"<id de l'hôte>"}' https://<corvus>/api/agents/enrollments

# 3. Sur l'hôte : installer, enrôler, démarrer
sudo install -m 755 corvus-agent /usr/local/bin/
sudo corvus-agent enroll --server https://<corvus>.<tailnet>.ts.net --token <jeton>
sudo cp deploy/agent/corvus-agent.service /etc/systemd/system/ && sudo systemctl enable --now corvus-agent
```

La clé privée de l'agent ne quitte jamais l'hôte ; l'agent vérifie que c'est bien Corvus qui répond ;
Corvus ne peut lui envoyer aucune commande shell. Détails : [`docs/protocole-agent.md`](docs/protocole-agent.md).
Écrans : **Agents** (installation avec jeton affiché une fois, état, révocation) et **Rembobiner**.

### Rembobiner un hôte (agent requis)
L'agent surveille `/etc` et les crontabs (option `--watch dossier1,dossier2`) par balayage toutes les 10 s,
ainsi que les ports en écoute, les services systemd et les paquets (journal dpkg). Chaque version de fichier
(≤ 512 Ko) est copiée, **chiffrée**, sur le serveur Corvus : un ransomware sur l'hôte ne peut pas toucher
l'historique. Dans **Rembobiner**, un curseur de temps montre ce qu'un retour à l'instant choisi changerait
(diff coloré à l'appui) ; **Restaurer** demande une confirmation explicite, exige d'être **administrateur de
l'hôte**, est journalisé (journal chaîné) et reste annulable (l'état actuel est lui-même dans l'historique).
Les fichiers secrets (`/etc/shadow`, clés SSH d'hôte, `*.key`…) sont suivis **sans jamais copier leur contenu**
et ne sont pas restaurables. Historique conservé `RETENTION_REWIND_DAYS` jours (90).

---

## Tests

```bash
npm test          # tout : unitaires + bout en bout + comptes + passkeys + productivité + interface (liste explicite de fichiers : compatible Node 22.13 et plus)
npm run test:e2e  # bout en bout uniquement
npm run test:ui   # interface (Edge ou Chrome requis ; ignoré sinon)
npm run check:pure
```

- **Bout en bout** (`test/e2e.test.js`) : un vrai serveur Corvus (HTTP + WebSocket) face à un
  **sshd de test en pur JS** ([test/helpers/fake-sshd.js](test/helpers/fake-sshd.js), basé sur
  `ssh2.Server`). Ce sshd exécute les commandes via bash (Git for Windows sous Windows,
  `/bin/bash` sous Linux ; `tmux` et `claude` réels sont masqués quand un test les veut absents), sert le SFTP sur un dossier temporaire et fournit un faux `docker`
  qui journalise ses arguments. Couverture : auth, CSRF, hôtes, secrets, TOFU, terminal et
  reprise, SFTP, git (dont tentatives d'injection), supervision, processus, Docker, proxy, push,
  Claude Code (faux `tmux` et faux `claude` fournis par le sshd de test : numérotation, reprise,
  arrêt, dossier avec apostrophe, messages d'absence, tentatives d'injection).
- **Unitaires** (`test/unit.test.js`) : parseurs sur de **vraies sorties Linux** (Raspberry Pi :
  `/proc`, `df`, `ps`), `git status -z`, échappement shell vérifié dans un vrai `sh`, validateurs,
  coffre chiffré, classification d'adresses, et les régressions de l'audit (proxy qui ne peut pas changer d'hôte, limiteur,
  connexions SFTP maintenues, limite des notifications).
- **Interface** (`test/ui.test.js`) : Edge/Chrome headless via `playwright-core` (aucun navigateur
  téléchargé), viewport **375 px** (mobile) et 1280 px. Vérifie l'absence de débordement
  horizontal, les cibles tactiles ≥ 44 px et l'absence d'erreurs JavaScript. Parcours : connexion,
  ajout d'hôte, terminal, fichiers, git, supervision, Docker, services, réglages, Claude Code
  (onglet de navigation, session, reprise, arrêt). Captures dans
  `test-results/`.

---

### Intégration continue et tests sur un vrai OpenSSH

`.github/workflows/ci.yml` lance `npm test` à chaque push sur Linux **x86_64 et ARM64**, puis
`test/real-ssh.test.js` contre un **vrai OpenSSH** (compte de test créé sur le runner). Pour le
lancer sur le Pi : `CORVUS_REAL_SSH=127.0.0.1:22:<utilisateur>:<mot de passe> node --test test/real-ssh.test.js`.
Le job `agent` (Rust, x86_64 + aarch64) s'active quand `agent/Cargo.toml` existe.

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
  db/                   SQLite : couche d'accès unique (index.js), migrations (schema.js), import des anciens JSON
  routes/               Routes REST par module
public/                 PWA (vanilla JS, modules ES, sans build)
  index.html, sw.js, manifest.webmanifest, icons/
  css/tokens.css        Source unique des valeurs de thème
  js/ui/                Composants partagés (boutons, champs, dialogues, graphiques…)
  js/views/             Une vue par module
deploy/                 install-linux.sh (install-pi.sh = alias), corvus.service (systemd),
                        windows/install-windows.ps1 et start-corvus.ps1
agent/                  Agent Rust (cargo build / cargo test) ; deploy/agent/ : service systemd
docs/                   securite.md, notifications.md, plan.md, protocole-agent.md, suite-pi.md
test/                   unit, e2e, ui + sshd de test
Dockerfile, docker-compose.yml
```

---

## Limites connues

**Validation**
- Les tests de bout en bout (85 tests unitaires + e2e) passent sous **Linux (Raspberry Pi, Node 24)**
  face au **sshd de test pur JS**, pas face à un OpenSSH réel dans la suite automatique ; Corvus a
  aussi été utilisé en vrai sur un Raspberry Pi (terminal, tmux, Claude Code, onglet Git).
- `deploy/install-linux.sh` a été exécuté (dossiers temporaires, `--no-service`, commande `corvus`)
  mais **pas l'installation systemd complète sur une machine vierge**, ni sur Fedora/Arch/openSUSE.
- `deploy/windows/install-windows.ps1`, `Dockerfile` et `docker-compose.yml` n'ont **pas été
  exécutés** (pas de Windows ni de Docker dans l'environnement de développement).
- Les notifications push n'ont pas été testées contre un vrai service de push. La signature VAPID
  est vérifiée par les tests, mais pas la réception sur un appareil.

**Usage**
- **Certificats SSH de courte durée** : reportés — la bibliothèque `ssh2` (1.17) ne sait pas
  s'authentifier par certificat OpenSSH.
- **Passkeys** : exigent HTTPS sur un nom de domaine (`https://<machine>.<tailnet>.ts.net`) ou
  `localhost` ; l'attestation (modèle d'authentificateur) n'est pas vérifiée.
- **QR code TOTP** : pas de QR code à l'enrôlement (aucune dépendance ajoutée) : lien
  `otpauth://` (ouvre l'application sur le téléphone) ou saisie manuelle de la clé.
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
