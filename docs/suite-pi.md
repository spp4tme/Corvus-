# Suite du travail sur le Raspberry Pi (pour Claude Code sur le Pi)

Ce document reprend le travail là où le PC Windows s'est arrêté. Lisez d'abord
[`docs/plan.md`](plan.md) (décisions validées), puis ce fichier.

## Règles du projet (rappel)

- Une étape = un commit + tests + README à jour. À chaque étape, **lister ce qui n'a pas pu être testé**.
- Le propriétaire **débute en Rust** : code simple, commenté en français, pas d'astuces inutiles ;
  expliquer les choix importants dans le message de fin d'étape.
- **Zéro IA** dans l'application : règles, statistiques, algorithmes déterministes.
- Gratuit, auto-hébergé, aucun cloud, aucune télémétrie. Backend Node en dépendances 100 % JS
  (`npm run check:pure`), agent en Rust.
- Toute action destructive ou de restauration demande une **confirmation explicite**. Rien de
  modifiant n'est automatique, sauf le gel d'un processus (SIGSTOP), qui reste optionnel.
- Les fonctions agent / eBPF / instantanés se désactivent proprement (message clair) si le
  système ne les supporte pas.
- Données lourdes sur le SSD : `CORVUS_STORAGE` (voir README, « Stockage »).

## Déjà fait (PC)

| Étape | Commit | Contenu |
|---|---|---|
| 0 | `1f330be`, `93f600d` | SQLite (`node:sqlite`, WAL, migrations `server/db/schema.js`), migration des JSON, coffre à enveloppe (DEK), blobs chiffrés, rétention, sauvegarde/restauration `.cvbk`, `CORVUS_STORAGE`, alerte d'espace disque |
| 3a | `6c4a25b` | Comptes, TOTP obligatoire, rôles + droits par hôte/groupe (`server/lib/access.js`), jetons d'API, journal chaîné SHA-256 |
| 2 | `43d818a` | Sonde d'état des hôtes, CPU par cœur, E/S disque, TCP, historique 1 h → 1 an |
| 3b | `00aef8c` | Enregistrement asciicast + lecteur, partage en direct, passkeys. Certificats SSH : reportés (ssh2 ne les gère pas) |
| 4 + 5.1 | `5cf5b73` | Snippets, multi-hôtes, suggestions n-grammes, routines, admin façon Cockpit + sudoers, analyse des commandes risquées, mode annulable |
| CI | (ce commit) | `.github/workflows/ci.yml` : tests x86_64 + ARM64, OpenSSH réel, job agent prêt |

## Ce qui n'a PAS pu être testé sur le PC (à vérifier en premier sur le Pi)

1. `npm test` complet **sous Linux ARM64** (le sshd de test utilisait le bash de Git pour Windows).
2. `CORVUS_REAL_SSH=127.0.0.1:22:<user>:<mdp> node --test test/real-ssh.test.js` contre le sshd
   du Pi (supervision `/proc/diskstats` + `/proc/net/snmp`, SFTP, annulation, admin, sudoers).
3. Onglet **Admin** avec un vrai systemd / journald / ufw / nftables / apt, et la règle sudoers
   générée (l'installer : `sudo visudo -cf /etc/sudoers.d/corvus`, puis tester start/stop d'un
   service sans danger, ex. `cron`).
4. `deploy/install-linux.sh` avec `CORVUS_STORAGE=/mnt/ssd/corvus` (ReadWritePaths du service).
5. Migration d'une **vraie** installation 0.1 (dossier `data/` existant) vers SQLite.
6. Sauvegarde → restauration → bouton « Redémarrer » sous systemd (code de sortie 75).
7. Passkeys sur un vrai téléphone via `https://<machine>.<tailnet>.ts.net`.
8. ~~Workflow GitHub Actions~~ ✅ fait 2026-11-25 : les 5 jobs passent (node x86_64 et ARM64, real-openssh, agent x86_64
   et aarch64).
9. Notifications push d'alerte (hôte injoignable, espace disque) sur un vrai appareil.

## Ce qui a été fait sur le Pi (étapes 1 à 7)

| Étape | Commit | Contenu |
|---|---|---|
| 1.1 | `8031c8b` | Agent Rust (`agent/`), enrôlement par jeton à usage unique, authentification mutuelle Ed25519, tampon SQLite, métriques |
| 1.2 | `279077b` | Écran Agents, badge sur la carte d'hôte, alerte « agent hors ligne », disques (statvfs) |
| 6.1 | `325212f` | Surveillance par balayage, versions chiffrées côté serveur, restauration par l'agent |
| 6.2 | `3d39600` | Écran Rembobiner |
| 5.2 | `bfb0d45` | Prévisualisation dans un bac à sable OverlayFS (agent root, `--allow-preview`) |
| 7.1 | `402a94e` | Radiographie : processus, lignée, session SSH, connexions, gel / dégel / arrêt |
| 7.2 | `d0b526d` | Empreinte du normal, anomalies, gel automatique optionnel |
| 7.3 | (voir `git log`) | Fichiers pièges, entropie, isolement nftables, faux ransomware de démonstration |

Protocole complet : [`protocole-agent.md`](protocole-agent.md). Écarts assumés par rapport au plan :
balayage régulier au lieu de fanotify/inotify ; `/proc` au lieu d'eBPF (BTF est pourtant présent sur ce noyau) ;
l'agent ne garde pas de magasin de versions local (le serveur en est le magasin, chiffré) ; pas de zstd (brotli côté serveur).

## Validation en conditions réelles (à faire maintenant, dans cet ordre)

Ordre : du moins risqué au plus risqué. Pour chaque point : exécuter, noter le résultat (✅ / ❌ + message)
dans la colonne « Résultat » ci-dessous, corriger ce qui casse (un commit par correction, avec test), puis passer au
suivant. **Ne pas sauter au point F** tant que A à E ne sont pas verts. Les points marqués 👤 demandent le propriétaire.

| Point | Résultat |
|---|---|
| A. Tests sous Linux ARM64 | ✅ 2026-11-25 : `check:pure` ✅, `cargo test` 33/33 ✅, `cargo build --release` ✅, `npm test` 172 ✅ / 0 ❌ (7 ignorés : navigateur absent) ; `real-ssh` contre le vrai sshd 5/5 ✅ (compte jetable supprimé). Piège : un binaire `target/debug` périmé fait échouer le test `/tmp` de la prévisualisation → refaire `cargo build` (pas seulement `cargo test`). |
| B. Installation sur le SSD + sauvegarde / restauration / redémarrage | ⚠️ 2026-11-25 : validé sur une **copie** (`/opt/corvus-test`, port 7690, unité `corvus-test`, stockage `/mnt/ssd-test/corvus` sur le même disque, pas de SSD monté ni de données 0.1 à migrer). ✅ installation `--no-service`, base SQLite dans le stockage séparé, sauvegarde `.cvbk`, restauration, redémarrage (code 75 puis relance par systemd, hôte repère retrouvé), alerte disque faible. Non testé : vrai SSD, migration 0.1, `install-linux.sh` avec service (il écrase toujours `corvus.service` : unité non configurable). Copie supprimée. |
| C. Onglet Admin + règle sudoers | ✅ 2026-11-25 (sur une copie de Corvus + compte jetable, hôte = le Pi en SSH local) : règle générée acceptée par `visudo -cf` (« parsed OK »), installée dans `/etc/sudoers.d/` ; `cron` stop / start / restart réels ; sans `confirm` → `CONFIRM_REQUIRED` (service inchangé) ; pare-feu ufw lu, mises à jour apt listées, actions tracées dans le journal. Journal : vide sans le groupe `systemd-journal` (indice affiché par Corvus, `journalctl` volontairement absent de la règle), complet après `usermod -aG` + nouvelle connexion. Non fait sur la vraie installation (pas d'identifiants admin) : à refaire à la main avec `/etc/sudoers.d/corvus` si voulu. Compte et copie supprimés. |
| D. Agent sous systemd + `wss://` + interface avec le vrai agent | ⚠️ 2026-11-25 : fait sur une **copie** (Corvus :7690 + agent `corvus-agent-test`, Tailscale Serve temporaire sur :8444) car un agent réel tourne déjà (enrôlé en `http://127.0.0.1:7680`, vieux binaire) et je n'ai pas d'identifiants admin. ✅ étape 2-4 : enrôlement `https://` → `wss://`, pair en TLS via tailscaled (:8444), aucune erreur de droits ; étape 6 : enrôlement vers l'IP `100.x` refusé, aucune identité créée ; étape 7 : prévisualisation (diff, fichiers réels intacts) ; étape 8 (par l'API, pas de navigateur) : Rembobiner (création, modification, restauration avec `confirm`) et Radiographie (geler / dégeler / tuer un `sleep`) ; étape 9 : binaire réinstallé + restart → même identité, tampon conservé, pas de doublons. **Corrigés** (`787a84c`, commit suivant) : `CAP_SETUID/SETGID` non effectives → prévisualisation « utilisateur » en échec (`setresuid failed`) ; `CAP_SYS_PTRACE` absente → Radiographie ne listait que 3 processus (root). **Appliqué au vrai agent** (16:32) : `full.conf` + binaire récent, `daemon-reload` + `restart` ; même identité, reconnecté, `CapAmb` = SETUID/SETGID. **Découvert** : Tailscale DNS est désactivé sur le Pi (`accept-dns=false`), le Pi ne résout donc pas son propre nom `*.ts.net` (étape 2 impossible telle quelle depuis le Pi ; j'ai utilisé une ligne `/etc/hosts` temporaire, retirée) ; le Serve réel est sur `:8443`, pas `:443`. **Étape 5 faite le 2026-11-25 16:35** (sur la copie) : `tailscale down` 20 s puis `up` → l'agent reste connecté (connexion locale du Pi vers lui-même, jamais coupée : le test ne prouve rien de plus). Coupure réelle de la liaison (Corvus de test arrêté 20 s) → `502`, nouvelles tentatives à 2, 4, 8, 16 s, reconnexion seule, 2 événements créés pendant la panne reçus **une seule fois** (pas de doublon dans Rembobiner) ✅. **Non fait** : étape 1 sur :443 ; vraie interface dans un navigateur. Copie nettoyée. |
| E. 👤 Téléphone : passkey, notifications push, PWA | ⚠️ 2026-11-25 (iPhone, `https://…:8443`) : ✅ passkey enregistrée puis connexion par passkey ; ✅ notification de test reçue **après correction** : le 1er essai donnait `push refusé (403) pour web.push.apple.com` (contact VAPID `mailto:corvus@localhost` rejeté par Apple) → `CORVUS_VAPID_SUBJECT=mailto:corvus@example.com` posé dans `/etc/corvus/corvus.env` (sauvegarde `~/corvus.env.bak-*`), défaut du dépôt corrigé + test. Un `push refusé (0)` isolé (erreur réseau vers Apple) a suivi, sans conséquence visible (1 seul abonnement). **Non confirmé / non fait** : installation PWA (« sur l'écran d'accueil ») non confirmée explicitement ; alerte « hôte injoignable » non provoquée. ✅ alerte « agent hors ligne » : `corvus-agent` arrêté 3 min (19:32:16) → alerte `agent.offline` créée à 19:34:21 (2 min 5 s), notification reçue sur l'iPhone, aucune erreur push ; agent relancé à 19:35:16, reconnecté avec la même identité. |
| F. 👤 Isolement réseau anti-ransomware | ⚠️ 2026-11-25 sur le Pi, via l'API avec un agent root temporaire (60 s, minuteur systemd de secours) : ✅ `tailscale ping` de l'iPhone passe pendant l'isolement, ✅ internet et DNS coupés, ✅ Corvus local joignable, ✅ levée manuelle : table `corvus_isolate` supprimée, réseau normal. ✅ **levée automatique à l'expiration** (2026-11-25 19:38, agent de test sur une copie, 60 s) : table `corvus_isolate` posée à 19:38:40, internet coupé, Corvus local joignable, table supprimée par l'agent entre 19:39:29 et 19:39:36 (≈ 60 s ; la minuterie de secours à +110 s n'a pas servi), réseau normal ensuite. Mon ping vers l'iPhone n'a pas répondu même hors isolement (iPhone au repos) : joignabilité Tailscale pendant l'isolement non revérifiée par ce test (voir le test précédent). Reste : bouton de la Radiographie, lien Tailscale relayé (DERP), hôte distant, puis la démo `fake-ransomware.sh` + restauration par Rembobiner. |

### A. Tests sous Linux ARM64 (le Pi)
```bash
npm ci && npm run check:pure && npm test
(cd agent && cargo test && cargo build --release)
npm test   # relancer : les tests « avec le vrai agent » ne s'exécutent que si le binaire existe
```
Puis contre le vrai sshd du Pi (compte de test jetable, `sudo -n` autorisé pour les tests d'admin) :
```bash
CORVUS_REAL_SSH=127.0.0.1:22:<utilisateur>:<motdepasse> node --test test/real-ssh.test.js
```

### B. Installation, stockage sur le SSD, sauvegarde
```bash
sudo CORVUS_STORAGE=/mnt/ssd/corvus ./deploy/install-linux.sh
systemctl status corvus && corvus status
```
- Si une ancienne installation 0.1 existe (dossier `data/` avec des JSON) : vérifier que la migration vers SQLite
  reprend hôtes, secrets et journal (fichiers renommés en `*.migrated`).
- Réglages → Stockage : l'espace libre du SSD s'affiche ; une alerte apparaît si on baisse `minFreeMb` au-dessus de
  l'espace libre.
- Créer une sauvegarde `.cvbk`, la restaurer, cliquer « Redémarrer » : systemd doit relancer Corvus (code 75) et les
  données restaurées doivent être là.

### C. Onglet Admin et sudoers
- Hôte = le Pi lui-même. Onglet **Admin** → copier la règle sudoers générée vers `/etc/sudoers.d/corvus`, puis
  `sudo visudo -cf /etc/sudoers.d/corvus` (doit répondre « parsed OK »).
- Démarrer / arrêter / redémarrer `cron` (service sans danger), journal en direct, pare-feu (ufw ou nftables en
  lecture), mises à jour en attente. Toute action modifiante doit demander une confirmation.

### D. Agent sous systemd, `wss://`, interface
1. `sudo tailscale serve status` doit publier `https://<pi>.<tailnet>.ts.net` → `http://127.0.0.1:7680`.
2. Installer l'agent comme un utilisateur le ferait (README, section agent) :
   `sudo install -m 755 agent/target/release/corvus-agent /usr/local/bin/`, jeton depuis l'écran **Agents**, puis
   `sudo corvus-agent enroll --server https://<pi>.<tailnet>.ts.net --token <jeton>` (→ `wss://` automatiquement).
3. `sudo cp deploy/agent/corvus-agent.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now corvus-agent`
   puis `journalctl -u corvus-agent -f` : connecté, sans erreur de droits (CapabilityBoundingSet).
4. `sudo ss -tnp | grep corvus-agent` : le pair doit être en `:443` (TLS), pas `:7680`.
5. Reconnexion : `sudo tailscale down; sleep 20; sudo tailscale up` → l'agent revient seul, les événements en attente
   arrivent une seule fois (pas de doublons dans Rembobiner).
6. Certificat refusé : nouveau jeton, `corvus-agent enroll --server https://<IP 100.x> --token … --dir /tmp/a2` doit
   échouer (erreur de certificat). Nettoyer `/tmp/a2`.
7. Drop-in de prévisualisation (`deploy/agent/corvus-agent-preview.conf`, mode d'emploi en tête du fichier) puis, dans
   l'interface : **Prévisualiser** une commande risquée (ex. `rm -rf ~/essai` sur un dossier d'essai) → diff, « Jeter ».
8. Ouvrir dans un navigateur avec le vrai agent : Agents, Rembobiner (modifier un fichier de `/etc` sans danger, ex. un
   fichier créé pour l'occasion, voir la différence, restaurer avec confirmation), Radiographie (processus, lignée,
   connexions, geler/dégeler un `sleep 1000`).
9. Mise à jour sans perte : réinstaller le binaire, `systemctl restart corvus-agent` → même identité, tampon conservé.

### E. 👤 Téléphone (avec le propriétaire)
Via `https://<pi>.<tailnet>.ts.net` : installer la PWA, enregistrer une passkey et se connecter avec, activer les
notifications puis provoquer une alerte (arrêter un hôte de test → « hôte injoignable », ou agent arrêté → « agent hors
ligne » après 2 min).

### F. 👤 Isolement réseau anti-ransomware (en dernier)
Validé jusqu'ici seulement par `nft -c`, un espace de noms réseau jetable et les tests Rust. À faire sur un hôte **non
critique**, propriétaire présent, **avec un accès console de secours** (écran + clavier ou console du fournisseur) :
déclencher l'isolement depuis la Radiographie avec une durée courte (60 s), vérifier que Corvus et `tailscale0` restent
joignables (marquage `0x80000` de tailscaled, `udp/41641`) et que le reste est coupé, puis la levée (manuelle, et
automatique à l'expiration).
**Résultat partiel (2026-11-25, le Pi lui-même, par l'API)** : le marquage `0x80000` (confirmé par `ip rule`) et `tailscale0`
laissent passer Tailscale (ping de l'iPhone OK pendant l'isolement, connexion directe) ; internet et DNS sont coupés ; la
levée manuelle remet tout en place. Pas encore essayé : le bouton de l'écran Radiographie, l'expiration automatique,
un lien relayé (DERP), un hôte distant.

**Démo du faux ransomware (2026-11-25, le Pi, par l'API, agent root avec les réglages par défaut : seuil 20 en 30 s,
balayage 3 s)** : ✅ fichier piège détecté 7 s après le début de l'attaque, ✅ rafale « 20 fichiers chiffrés en 30 s »
détectée, ✅ 4 alertes critiques et le journal (`canary`, `suspect`), ✅ Rembobiner : 67 différences toutes restaurables,
67/67 restaurées, les 30 documents identiques aux originaux, aucun `.locked` restant, propriétaire conservé. Aucune
réaction automatique (gel et isolement désactivés par défaut). Pas encore essayé : les boutons de l'interface
(Rembobiner), un hôte distant, les réactions automatiques activées.

## Après la validation (à décider avec le propriétaire)

1. **Version 1.0** (recommandé en premier) : numéro de version, binaire de l'agent publié par la CI, installation de
   l'agent en une commande depuis l'écran Agents.
2. **eBPF (Aya) / fanotify** : processus de moins de 2 s, attribution exacte des écritures (Rust nightly + `bpf-linker`).
3. **Certificats SSH courts** : bloqués par `ssh2` ; seulement si le besoin est réel.

Déjà vérifié sur le PC : écrans Agents, Rembobiner, Radiographie ouverts dans Edge (375 px et 1280 px) avec un agent
simulé — aucune erreur JS, pas de débordement, cibles tactiles ≥ 44 px.

## Repères dans le code

- Accès base : `ctx.db` (`server/db/index.js` : `run/get/all/tx/getMeta/setMeta`). Nouvelle table
  → **nouvelle migration** dans `server/db/schema.js` (ne jamais modifier une migration publiée).
- Droits : `server/lib/access.js` (`hostLevel`, `GLOBAL_RULES`). Une route `/hosts/:id/...` est
  protégée d'office (lecture = viewer, écriture = operator, `/admin/*` = admin).
- Journal : `ctx.journal.add({ type, event, host, detail, ok })` — le compte et l'IP sont ajoutés
  automatiquement (AsyncLocalStorage) ; `user: null` pour une action système.
- Tâches de fond : modèle `HostStatus` / `MetricsCollector` (`start/stop`, coupées dans les tests
  par `hostProbeSec: 0, metricsIntervalSec: 0`).
- Tests : `test/helpers/corvus.js` (`startCorvus`, `makeUser`, `freshCode`), sshd de test
  `test/helpers/fake-sshd.js`. Lancer : `npm test`.
- Attention en éditant des fichiers via des scripts shell : les `\\` peuvent être réduits ;
  préférer l'édition directe des fichiers.
