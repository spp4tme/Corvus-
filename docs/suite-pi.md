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

## Reste à faire / à vérifier

1. **Sur un vrai réseau Tailscale** : l'isolement réseau (`net.isolate`) n'a été validé que par `nft -c`, dans un espace de
   noms réseau jetable et par les tests Rust. Le marquage `0x80000` des paquets de tailscaled et `udp/41641` doivent être
   vérifiés sur un hôte non critique AVEC un accès console de secours (la levée automatique est le filet de sécurité).
2. **systemd** : l'unité `deploy/agent/corvus-agent.service` et le drop-in de prévisualisation n'ont pas été lancés sous systemd.
3. **TLS** : l'agent n'a été essayé qu'en `ws://` local ; `wss://` (rustls) via `tailscale serve` reste à essayer.
4. **CI GitHub Actions** : job Rust (`cross`) et compilation de l'agent dans le job Node jamais exécutés.
5. **Interface** : écrans Agents, Rembobiner, Radiographie, Prévisualiser : syntaxe vérifiée, jamais ouverts dans un navigateur.
6. **eBPF (Aya)** : non fait (Rust nightly + `bpf-linker`) ; apporterait les processus de moins de 2 s et l'attribution exacte
   des écritures (fanotify aussi).
7. Points 1 à 9 de la liste « pas pu être testé sur le PC » ci-dessus : toujours à faire s'ils ne l'ont pas été.

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
