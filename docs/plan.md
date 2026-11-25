# Corvus 2 — audit de l'existant et plan (à valider)

Légende : ✅ fait · 🟡 partiel · ❌ absent.

## Décisions validées
1. Environnement : le **Pi** compile l'agent et exécute les tests réels (OpenSSH, eBPF, fanotify, OverlayFS) ; **GitHub Actions** pour la CI (x86_64 + ARM64, tests à chaque commit). Pas de WSL2.
2. Ordre : comptes + rôles + journal chaîné juste après la base.
3. Actions root sans agent : `sudo -n` avec une règle sudoers limitée, **générée et documentée par Corvus**.
4. Node ≥ 22.13 (`node:sqlite`).
5. Ed25519 entre agent et backend, versions de fichiers gérées par l'agent, pas d'enregistrement des frappes.
6. Certificats SSH : **reportés** — vérifié : `ssh2` 1.17 ne gère pas l'authentification par certificat OpenSSH (aucune occurrence de `-cert-v01@openssh.com` dans la bibliothèque).
7. **Stockage lourd déplaçable** : la base, les blobs (versions de fichiers, enregistrements de session) et les sauvegardes vont dans `CORVUS_STORAGE` (ex. un SSD monté sur `/mnt/ssd/corvus`), distinct de `CORVUS_DATA` (petit : clés, configuration). Corvus surveille l'espace libre et prévient (bandeau, notification push, journal) sous un seuil réglable.

## Répartition du travail
- **Fait sur le PC (sans le Pi)** : étapes 0, 3a, 2, 3b (sauf certificats), 4, 5.1, CI Node.
- **À faire sur le Pi** : voir `docs/suite-pi.md` (agent Rust, tests contre un vrai OpenSSH, 5.2, 6, 7).

---

## 1. Audit de l'existant face au cahier des charges

### Étape 0 — Stockage
| Demande | État | Aujourd'hui |
|---|---|---|
| SQLite WAL, migrations, couche unique | ❌ | 7 fichiers JSON (`hosts`, `sessions`, `known_hosts`, `services`, `push`, `vapid`) + `journal.jsonl` + `secrets.enc.json`, écriture atomique |
| Tables utilisateurs, alertes, métriques, snippets… | ❌ | — |
| Gros contenus chiffrés sur disque | ❌ | — |
| Rétention, agrégation | 🟡 | journal limité à 5 000 lignes, métriques non stockées |
| Sauvegarde / restauration / export chiffré | ❌ | — |

### Étape 1 — Agent
Entièrement ❌. Corvus fonctionne uniquement par SSH (ce mode restera le mode par défaut).

### Étape 2 — Robustesse
| Demande | État | Aujourd'hui |
|---|---|---|
| tmux + reprise après coupure | ✅ | tmux optionnel par hôte, reprise WebSocket à l'octet près, sessions gardées 5 min |
| Indicateur d'état de connexion | 🟡 | badge « Reconnexion… » par onglet ; pas d'état global ni de latence |
| Serveur hors ligne ne bloque pas l'UI | 🟡 | timeouts SSH (15 s) et exec ; la liste des hôtes ne contacte pas les hôtes ; pas d'état « injoignable depuis X min », pas de sondage de fond |
| CPU par cœur, E/S disque, stats TCP | ❌ | CPU global, RAM, disques, réseau |
| Historique 1 h / 24 h / 7 j / 1 an | ❌ | 60 points en mémoire du navigateur (3 min) |

### Étape 3 — Audit et accès
| Demande | État | Aujourd'hui |
|---|---|---|
| Enregistrement asciicast + relecture | ❌ | tampon circulaire de 256 Ko seulement |
| Journal infalsifiable | 🟡 | journal JSONL complet (connexions, SFTP, git, docker, échecs d'auth) mais non chaîné |
| Comptes multiples, rôles, droits par hôte | ❌ | un seul token d'accès |
| TOTP obligatoire, passkeys | ❌ | — |
| Certificats SSH courts | ❌ | mot de passe, clé, agent SSH |
| Partage de session en direct | 🟡 | techniquement plusieurs clients peuvent se rattacher à une session ; ni lecture seule, ni accord du propriétaire |

### Étape 4 — Productivité
| Demande | État | Aujourd'hui |
|---|---|---|
| Snippets, exécution multi-hôtes | ❌ | — |
| Autocomplétion (historique, chemins, n-grammes) | ❌ | — |
| Séquences répétées → bouton | ❌ | — |
| systemd, journalctl, pare-feu, utilisateurs, mises à jour | ❌ | processus (kill) et Docker (start/stop/logs) ✅ |

### Étapes 5, 6, 7 — Ctrl+Z, rembobinage, radiographie
Entièrement ❌. Éléments réutilisables : notifications push (alertes), journal, pool SSH.

### Hors liste mais présent (conservé)
Proxy web isolé vers les services du tailnet, contrôle vocal, Claude Code dans tmux, PWA hors ligne, import Tailscale.

---

## 2. Choix d'architecture

### 2.1 Vue d'ensemble

```
 Navigateur (PWA)  ──HTTPS/WSS (tailscale serve)──►  Backend Node (Pi)  ──SSH──►  Hôtes (mode SSH seul)
                                                        │   SQLite (WAL)
                                                        │   blobs chiffrés sur disque
                                                        ▲
                                        WSS sortant ────┘  Agent Rust (sur chaque hôte, optionnel)
                                        (l'agent appelle,      eBPF / fanotify / inotify,
                                         aucun port ouvert     SQLite local (tampon + historique)
                                         sur l'hôte)
```

### 2.2 Base de données : `node:sqlite` (intégré à Node)
- **Choix** : le module SQLite **intégré à Node.js** (`node:sqlite`, disponible sans option depuis Node 22.13, vérifié ici : SQLite 3.54). Aucune dépendance native : le contrôle « 100 % JavaScript » (`npm run check:pure`) reste vert et rien ne se compile sur le Pi.
- **Conséquence** : Node ≥ 22.13 exigé (Node 24 LTS recommandé, déjà installé par défaut par `install-linux.sh`). Le Dockerfile passe à `node:24-alpine`.
- Alternative écartée : `better-sqlite3` (module natif, compilation sur ARM64).
- Une seule couche d'accès `server/db/` : ouverture, `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, migrations numérotées (`001_init.sql`, `002_…`) appliquées dans une transaction et tracées dans `schema_migrations`. Aucune requête SQL ailleurs que dans les « dépôts » (`server/db/repos/*.js`).
- **Migration automatique** au premier démarrage : lecture des JSON existants → insertion → fichiers renommés en `*.migrated` (pas supprimés). Testée sur une copie des données actuelles.
- **Usure de la carte SD** : métriques écrites par lots (toutes les 30 s), WAL, `synchronous=NORMAL`.
- **Gros contenus** (enregistrements de session, sauvegardes de fichiers) : `data/blobs/<sha256[0:2]>/<sha256>`, compressés (zlib/brotli intégrés à Node) puis chiffrés AES-256-GCM avec la clé du coffre ; la base ne garde que la référence.
- **Sauvegarde** : `VACUUM INTO` (copie cohérente à chaud) + blobs → archive chiffrée téléchargeable ; restauration avec confirmation et redémarrage.
- **Rétention** : tâche horaire. Points bruts 7 jours → agrégats horaires (min/moy/max) 1 an ; audit jamais purgé automatiquement ; enregistrements de session 90 jours (réglable).

### 2.3 Comptes : remplace le token unique
- Le token actuel devient un **jeton d'amorçage** : il ne sert qu'à créer le premier compte admin (identifiant + mot de passe haché scrypt + TOTP), puis il est désactivé.
- TOTP (RFC 6238) codé avec `node:crypto`, sans dépendance. Passkeys (WebAuthn) en option : vérification codée à la main (petit décodeur CBOR + `node:crypto`). **Limite** : WebAuthn exige HTTPS sur un nom de domaine (`*.ts.net` via tailscale serve) ; pas d'accès par IP.
- Rôles admin / opérateur / lecture seule, droits par hôte ou par groupe, vérifiés par un seul middleware (`can(user, action, host)`).
- Jetons d'API personnels (Bearer) par utilisateur pour les clients non navigateur.
- Le chiffrement des secrets au repos ne change pas (clé de serveur dérivée de la passphrase maître) : les secrets SSH restent partagés entre comptes, filtrés par les droits.

### 2.4 Agent Rust
- **Un binaire**, `corvus-agent`, service systemd. Rust stable pour l'agent ; la partie eBPF (Aya) exige Rust *nightly* + `bpf-linker`, isolée dans un sous-crate optionnel : si le noyau ne l'accepte pas, l'agent tourne sans eBPF (repli /proc + inotify/fanotify) et le signale.
- **Connexion sortante** : l'agent ouvre un WebSocket vers le backend (`wss://corvus.<tailnet>.ts.net/agent`). Aucun port en écoute sur l'hôte.
- **Authentification mutuelle par clés Ed25519** :
  1. enrôlement : `curl … | sudo sh -s -- --token <jeton à usage unique, 15 min>` ;
  2. l'agent génère sa paire de clés, le backend enregistre la clé publique ; l'agent mémorise la clé publique du backend ;
  3. à chaque connexion, chacun signe un défi aléatoire de l'autre.
  Chiffrement : WireGuard (Tailscale) + TLS de tailscale serve. Choisi plutôt que mTLS, parce que Node ne sait pas générer de certificats X.509 sans dépendance, alors qu'Ed25519 est natif des deux côtés.
- **Protocole** : JSON, une enveloppe versionnée `{v, id, type, ts, body}`, décrit dans `docs/protocole-agent.md` avec un schéma par message. Rien de spécifique à Node : réutilisable par un backend Rust.
- **Le backend ne peut jamais envoyer de commande shell** à l'agent : uniquement des actions nommées et validées (`snapshot.restore {path, version}`, `process.freeze {pid}`…). Chaque action privilégiée est journalisée **des deux côtés**.
- **Droits** : l'agent tourne en root, mais avec `CapabilityBoundingSet` limité à ce qui sert (`CAP_BPF CAP_PERFMON CAP_SYS_ADMIN` pour fanotify, `CAP_KILL`, `CAP_NET_ADMIN` pour l'isolement, `CAP_DAC_READ_SEARCH`, `CAP_CHOWN`/`CAP_FOWNER` pour les restaurations), `ProtectSystem` et `ReadWritePaths` sur son dossier. Je l'explique honnêtement : rembobiner `/etc` ou geler un processus d'un autre utilisateur exige ces droits ; « minimal » veut dire « rien de plus ».
- **Tampon local** : SQLite (`rusqlite`, SQLite embarqué), file d'événements avec accusés de réception ; renvoi au retour de la connexion.
- Cross-compilation x86_64 et aarch64 avec `cross` (Docker), binaires statiques musl.

### 2.5 Ctrl+Z du terminal
- **Où intercepter une commande** : (a) une **barre de commande Corvus** sous le terminal (et la dictée) : la commande y est analysée avant envoi ; (b) en option, un **crochet shell** installé par l'agent pour bash (`trap DEBUG` + `extdebug`, qui peut annuler une commande) et zsh (widget `accept-line`) : il marche aussi quand on tape directement dans le terminal. Sans agent, seule la barre de commande est protégée.
- **Prévisualiser** : `bwrap --overlay-src / --tmp-overlay` (ou `unshare` + OverlayFS) **sans réseau par défaut** ; le dossier « upper » donne le diff exact. « Appliquer » rejoue le diff après avoir vérifié que les fichiers d'origine n'ont pas changé entre-temps (sinon : conflit affiché). Commandes `sudo` : prévisualisation seulement via l'agent (root).
- **Annulable** : règles sur la commande analysée (rm, mv, cp -f, sed -i, truncate, chmod/chown -R, redirections `>` vers un fichier existant, écritures dans /etc…) ; les fichiers ciblés sont copiés (blobs chiffrés) avant exécution ; bouton « Annuler la dernière commande ».
- **Limites affichées** : réseau, bases de données, services, processus lancés, commandes dont les fichiers touchés ne sont pas déductibles des arguments (scripts) → proposer la prévisualisation.

### 2.6 Rembobinage
- Événements : fanotify (ou inotify en repli) sur `/etc` + dossiers choisis ; paquets (journaux dpkg/apt/dnf/pacman) ; services (`systemctl list-unit-files` différentiel) ; utilisateurs (`/etc/passwd`, `group`) ; crontabs ; ports en écoute (`/proc/net/tcp*`), relevés périodiquement par différence.
- **Versions de fichiers** : magasin adressé par contenu **dans l'agent** (sha256, zstd), plutôt que restic : pas de binaire externe, et le volume (`/etc`, configs) reste petit. Instantanés Btrfs/ZFS utilisés en plus s'ils sont disponibles (rare sur Raspberry Pi OS, qui est en ext4).
- Copie des versions vers le backend (option recommandée) : un ransomware sur l'hôte ne peut pas chiffrer l'historique stocké sur le Pi.
- Interface : frise + curseur, état à un instant T, diff entre deux instants, restauration (fichier / dossier / config) avec confirmation et sauvegarde de l'état courant juste avant.

### 2.7 Radiographie et défense (sans IA)
- eBPF : tracepoints `sched_process_exec/exit`, kprobes `tcp_connect`/`inet_csk_accept` ; repli `/proc` (sondage 2 s, moins précis).
- **Lignée** : arbre `ppid` + session sshd (IP source lue dans l'environnement/journal sshd) → shell → commandes → binaire.
- **Empreinte du normal** : 14 jours d'apprentissage, compteurs déterministes par hôte (binaire+utilisateur, ports en écoute, destinations agrégées en /24 et port, histogramme horaire d'activité). Anomalie = élément jamais vu (ou vu moins de N fois) après apprentissage, ou activité dans une heure « creuse ». Seuils réglables, liste d'autorisation.
- **Gel optionnel** (SIGSTOP) puis choix « tuer » ou « autoriser » par notification.
- **Anti-ransomware** : fichiers pièges ; détection d'écritures en rafale (fanotify `CLOSE_WRITE`) avec entropie de Shannon > seuil sur un échantillon ; gel ; **isolement réseau nftables qui garde toujours Tailscale et le backend joignables** (sinon on perd la main) ; restauration via l'étape 6. Démo : faux ransomware (script) qui ne chiffre qu'un dossier de test créé pour l'occasion.

---

## 3. Découpage proposé (un sous-point = un commit + tests + README)

> **Proposition de réordonnancement** : faire les comptes, les rôles et le journal chaîné (3a) **juste après la base**. Toutes les routes devront vérifier les droits et tout écrire dans le journal chaîné ; ajouter ça à la fin obligerait à reprendre chaque route.

| # | Contenu | Dépend de |
|---|---|---|
| 0.1 | Couche SQLite, migrations, schéma complet | — |
| 0.2 | Migration automatique JSON → SQLite, bascule de tous les modules | 0.1 |
| 0.3 | Blobs chiffrés, rétention, sauvegarde/restauration/export | 0.2 |
| 3a.1 | Comptes, mots de passe, TOTP obligatoire, jeton d'amorçage, jetons d'API | 0.2 |
| 3a.2 | Rôles et droits par hôte/groupe sur toutes les routes | 3a.1 |
| 3a.3 | Journal chaîné par hash + vérification dans l'app | 0.2 |
| 2.1 | État par hôte (sondage de fond, « injoignable depuis »), indicateur de connexion global | 0.2 |
| 2.2 | Métriques étendues (par cœur, E/S, TCP) stockées + graphiques 1 h / 24 h / 7 j / 1 an | 0.3 |
| 3b.1 | Enregistrement asciicast + lecteur (vitesse, saut des pauses, recherche) | 0.3 |
| 3b.2 | Partage en direct (spectateur / co-pilote, accord du propriétaire) | 3a.2 |
| 3b.3 | Passkeys (WebAuthn) | 3a.1 |
| 3b.4 | CA SSH Corvus + certificats courts (voir risque ssh2 ci-dessous) | 3a.2 |
| 4.1 | Snippets + exécution multi-hôtes | 3a.2 |
| 4.2 | Historique, complétion de chemins, n-grammes, séquences répétées | 0.2 |
| 4.3 | Admin façon Cockpit : systemd, journalctl en direct, pare-feu, utilisateurs, mises à jour | 3a.2 |
| 1.1 | Agent : squelette Rust, enrôlement, protocole v1, tampon SQLite, installation/désinstallation/mise à jour | 0.2 |
| 1.2 | Agent : métriques et événements de base (sans eBPF) | 1.1 |
| 5.1 | Analyse des commandes risquées + barre de commande + mode annulable | 0.3 |
| 5.2 | Mode prévisualisation (bwrap/overlay) + crochet shell via l'agent | 1.1 |
| 6.1 | Surveillance des changements + magasin de versions | 1.2 |
| 6.2 | Frise, diff entre instants, restauration | 6.1 |
| 7.1 | eBPF (Aya) : processus, connexions, graphe, lignée | 1.2 |
| 7.2 | Empreinte du normal, alertes, gel | 7.1 |
| 7.3 | Anti-ransomware + isolement + démo | 6.2, 7.2 |

Ordre de grandeur honnête : c'est un programme de plusieurs mois, environ 25 commits conséquents. Les étapes 5 à 7 contiennent l'essentiel du risque technique.

**Avancement** : ✅ 0.1–0.3, 3a.1–3a.3, 2.1–2.2, 3b.1–3b.3, 4.1–4.3, 5.1, CI (Node + OpenSSH réel).
⏸ 3b.4 (certificats SSH : `ssh2` ne les gère pas). ⏳ 1.x, 5.2, 6.x, 7.x : sur le Pi, voir
[`suite-pi.md`](suite-pi.md).

---

## 4. Risques et limites connus dès maintenant

1. **Environnement de développement** : ce PC n'a ni Rust, ni Docker, ni distribution WSL. Sans environnement Linux, je ne peux ni compiler l'agent, ni tester eBPF/fanotify/OverlayFS, ni faire les tests de bout en bout contre un **vrai** OpenSSH (les tests actuels utilisent un faux serveur SSH écrit avec ssh2). Il faut l'une des solutions de la question 1.
2. **Noyau du Raspberry Pi** : eBPF avec Aya fonctionne au mieux avec BTF (`/sys/kernel/btf/vmlinux`), souvent absent des noyaux Raspberry Pi OS. Prévu : repli /proc.
3. **OverlayFS sans root** : exige un noyau ≥ 5.11 et les espaces de noms utilisateur autorisés ; certaines distributions les bloquent (Ubuntu 24.04 via AppArmor). Repli : prévisualisation via l'agent seulement.
4. **Commandes « vues » sans agent** : en SSH pur, la commande tapée n'est connue qu'au mieux (barre Corvus, ou marqueurs de prompt OSC 133 si le shell les émet). Fiable avec le crochet shell ou eBPF (`execve`).
5. **Journal infalsifiable** : le chaînage détecte toute modification ou suppression *partielle*. Quelqu'un qui est root sur le Pi peut cependant tout recalculer. Parade prévue : l'empreinte de tête est affichée, exportable, et recopiée périodiquement sur les agents.
6. **Certificats SSH utilisateur** : je ne suis pas sûr que la bibliothèque `ssh2` sache s'authentifier par certificat OpenSSH. À vérifier en début d'étape 3b.4 ; sinon l'étape sera reportée ou demandera une contribution à ssh2.
7. **Enregistrement des sessions** : la sortie est enregistrée ; les **frappes clavier ne le sont pas** par défaut, car les mots de passe tapés (sudo) y figureraient en clair.
8. **Isolement anti-ransomware** : une règle nftables mal posée coupe l'accès. L'isolement exclut toujours `tailscale0` et le backend, et s'annule tout seul au bout de N minutes sans confirmation (option).
