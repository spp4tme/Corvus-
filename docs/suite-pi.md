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
8. Workflow GitHub Actions (jamais exécuté : premier push → vérifier l'onglet Actions ; les
   runners ARM64 gratuits n'existent que pour les dépôts publics).
9. Notifications push d'alerte (hôte injoignable, espace disque) sur un vrai appareil.

## Reste à faire (sur le Pi)

### Étape 1 — Agent Corvus (Rust)
- Dossier `agent/` (crate `corvus-agent`), binaire statique musl ; le job CI `agent` s'active
  tout seul quand `agent/Cargo.toml` existe (`cross test` + `cross build` x86_64 et aarch64).
- **Protocole** (à documenter dans `docs/protocole-agent.md`, versionné) : WebSocket sortant
  vers `wss://<corvus>/agent`, enveloppe JSON `{ v, id, type, ts, body }`.
- **Enrôlement** : jeton à usage unique (15 min) créé par un admin → table `agent_enrollments`
  (déjà créée : `token_hash`, `host_id`, `expires_at`, `used_at`). L'agent génère une paire
  Ed25519, envoie sa clé publique → table `agents` (déjà créée). Authentification mutuelle par
  signature d'un défi à chaque connexion (Node : `crypto.sign(null, …)` / `crypto.verify` en
  Ed25519 natif ; Rust : crate `ed25519-dalek`).
- **Tampon local** SQLite côté agent (`rusqlite` avec la fonctionnalité `bundled`) : événements
  numérotés (`agent_seq`), renvoyés après coupure ; côté backend la contrainte
  `UNIQUE (agent_id, agent_seq)` de `agent_events` rend le renvoi idempotent (`INSERT OR IGNORE`).
- **Aucune commande shell** envoyée par le backend : seulement des actions nommées et validées,
  journalisées des deux côtés (`journal.add({ type: 'agent', … })` côté Node).
- Métriques de l'agent : écrire dans `metrics_raw` (mêmes noms que `server/lib/metrics.js` →
  `flatten`) pour réutiliser les graphiques.
- Service systemd avec `CapabilityBoundingSet` limité (voir plan §2.4), installation en une
  commande, désinstallation propre, mise à jour sans perte (le tampon SQLite reste en place).
- Interface : statut de l'agent sur la carte d'hôte (`hosts` → `role`/`status` déjà renvoyés),
  bouton « Installer l'agent » (affiche la commande avec le jeton).

### Étape 5.2 — Prévisualisation (OverlayFS / bubblewrap)
- Point d'accroche existant : `server/lib/risk.js` renvoie `preview: true` ; la boîte de dialogue
  `riskDialog` (`public/js/views/commands.js`) affiche « Prévisualisation : disponible avec
  l'agent ». Ajouter l'action « Prévisualiser » quand l'agent de l'hôte annonce la capacité.
- Sans réseau par défaut ; diff (créés / modifiés / supprimés + diff texte) ; « Appliquer »
  vérifie que les fichiers d'origine n'ont pas changé (sinon conflit) ; « Jeter ».
- Crochet shell optionnel installé par l'agent (bash `trap DEBUG` + `extdebug`, zsh `accept-line`)
  qui consulte les mêmes règles (`risk.js` → à porter ou à appeler via l'agent).
- Vérifier sur le Pi : `unshare -Urm` et OverlayFS non privilégié (noyau ≥ 5.11).

### Étape 6 — Rembobiner un serveur
- fanotify/inotify sur `/etc` + dossiers choisis, paquets, services, utilisateurs, crontabs,
  ports en écoute → `agent_events`.
- Versions de fichiers : magasin adressé par contenu dans l'agent (sha256 + zstd), copie vers le
  backend (`BlobStore` côté Node : `put(buffer, 'version')`).
- Interface : frise + curseur, état à T, diff entre deux instants, restauration avec confirmation
  (sauvegarder l'état courant juste avant, comme `server/lib/undo.js`).

### Étape 7 — Radiographie et défense
- eBPF (Aya, Rust nightly + `bpf-linker`, sous-crate optionnel) ; repli `/proc`.
  Vérifier d'abord : `ls /sys/kernel/btf/vmlinux` (BTF souvent absent des noyaux Raspberry Pi OS).
- Empreinte du normal : table `behavior_profile` (déjà créée : `host_id, kind, item, count,
  first_seen, last_seen, allowed`) ; alertes via `ctx.alerts.raise({ kind, severity, message,
  hostId })` (notification push incluse) ; gel SIGSTOP optionnel.
- Anti-ransomware : fichiers pièges, entropie, gel, isolement nftables qui **garde toujours
  `tailscale0` et le backend joignables**, restauration via l'étape 6. Démo : faux ransomware qui
  ne chiffre qu'un dossier de test créé pour l'occasion.

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
