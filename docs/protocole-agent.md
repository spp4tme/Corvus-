# Protocole Corvus ↔ agent — version 1

L'agent (`agent/`, Rust) est un petit programme installé sur un hôte. Il **se connecte à Corvus**
(aucun port ouvert sur l'hôte) et lui envoie métriques et événements. Corvus **ne peut lui envoyer
aucune commande shell** : seules des *actions nommées et validées* seront définies (étapes 5.2, 6, 7) ;
la version 1 n'en contient aucune.

Code de référence : `server/lib/agents.js` (serveur), `agent/src/protocol.rs` et `agent/src/main.rs` (agent).

## 1. Enveloppe
Tous les messages sont du JSON texte sur un WebSocket :

```json
{ "v": 1, "id": "chaîne unique", "type": "…", "ts": 1760000000000, "body": { } }
```
`v` est la version du protocole : un message d'une autre version ferme la connexion (code 4001).

## 2. Enrôlement (une seule fois, HTTPS)
1. Un administrateur crée un jeton : `POST /api/agents/enrollments {hostId}` → `{token, expiresAt}`.
   Le jeton est aléatoire (256 bits), **valable 15 minutes, à usage unique** ; seul son SHA-256 est stocké.
2. Sur l'hôte : `corvus-agent enroll --server https://… --token …`. L'agent **génère sa paire Ed25519 ;
   la clé privée ne quitte jamais l'hôte** (fichier `identity.json`, mode 0600).
3. `POST /api/agent/enroll {token, publicKey, version, hostname, capabilities}` (public, limité par IP en
   cas d'échecs) → `{agentId, serverPublicKey, hostId, protocol}`. L'agent **mémorise la clé publique de
   Corvus** : c'est ce qui lui permet ensuite de reconnaître le vrai serveur.

Clés Ed25519 en base64, **32 octets bruts**.

## 3. Connexion et authentification mutuelle (`wss://…/agent`)
Aucune session navigateur : l'authentification *est* l'échange ci-dessous. Une requête portant un en-tête
`Origin` (donc venant d'une page web) est refusée (403).

| Sens | Type | Corps |
|---|---|---|
| S → A | `hello` | `{challenge, protocol}` — 32 octets aléatoires (base64) |
| A → S | `auth` | `{agentId, signature, challenge}` — signature du défi du serveur + **défi de l'agent** |
| S → A | `auth_ok` | `{signature, lastSeq}` — signature du défi de l'agent + dernier `seq` reçu |
| A → S | `hello_agent` | `{version, capabilities}` |

Texte signé : `corvus-agent-v1|<rôle>|<défi base64>` avec `rôle = agent` ou `server`. Le rôle empêche de
rejouer une signature de l'un comme celle de l'autre. **L'agent vérifie la signature du serveur** avec la
clé reçue à l'enrôlement et se déconnecte si elle est invalide : un faux serveur ne peut pas se faire
passer pour Corvus. Le serveur répond de la même façon (`error`, fermeture 4001) à un agent inconnu et à
une mauvaise signature, pour ne pas révéler quels agents existent. Délai : 10 s pour s'authentifier.

Une seule connexion par agent : une nouvelle remplace l'ancienne (fermeture 4002). Un agent révoqué est
déconnecté (4003).

## 4. Messages de l'agent
| Type | Corps | Effet |
|---|---|---|
| `events` | `{items: [{seq, ts, type, body}]}` (≤ 500) | stockés dans `agent_events` ; **idempotent** : `UNIQUE (agent, seq)` + `INSERT OR IGNORE` ; réponse `ack {upTo}` |
| `metrics` | `{ts, values: {nom: nombre}}` (≤ 200) | écrits dans `metrics_raw` (mêmes noms que `server/lib/metrics.js` : `cpu`, `mem`, `swap`, `load1`, `temp`, `df:/`…) → graphiques existants |
| `ping` | `{}` | réponse `pong` |

`seq` est un entier croissant attribué par l'agent (jamais réutilisé). L'agent garde chaque événement dans
son **tampon SQLite local** jusqu'à l'`ack` : après une coupure il renvoie tout ce qui n'est pas confirmé ;
`lastSeq` dans `auth_ok` lui permet de purger ce que le serveur a déjà reçu. Les métriques ne sont pas
mises en tampon (une mesure manquée pendant une coupure n'a pas d'intérêt).

Tout message invalide ferme la connexion (4001) : l'agent se reconnecte (1 s, 2 s, 4 s… jusqu'à 30 s).

## 5. Surveillance des fichiers et rembobinage (étape 6)
L'agent surveille des dossiers (`--watch /etc,/var/spool/cron` par défaut) par **balayage toutes les 10 s**
(date, taille, inode ; empreinte SHA-256 seulement si le fichier a changé). Pas d'inotify/fanotify : aucune
dépendance au noyau, aucune limite de « watches » ; en contrepartie, un fichier modifié puis remis à
l'identique entre deux balayages passe inaperçu.

Événements `events` produits (corps : `path, sha, prevSha, size, mode, uid, gid, noContent, reason`) :
`file.baseline` (état initial), `file.created`, `file.modified`, `file.meta` (droits seuls), `file.deleted`,
`port.snapshot|open|close`, `service.snapshot|changed|gone` (systemd), `pkg.change` (journal dpkg),
`action.done`.

| Sens | Type | Corps |
|---|---|---|
| A → S | `version` | `{sha256, data}` — contenu (≤ 512 Ko, base64) envoyé AVANT l'événement qui le cite ; le serveur recalcule l'empreinte et refuse si elle diffère |
| S → A | `action` | `{name, args}` (id dans l'enveloppe) — action nommée, voir ci-dessous |
| A → S | `action_result` | `{reqId, ok, data \| error}` |

**Jamais de commande shell.** Actions : `file.restore {path, sha256, data, mode, uid, gid}` et
`file.remove {path}`. L'agent valide tout : chemin absolu, normalisé, **sous un dossier surveillé**, parent
non symbolique, cible non symbolique, jamais un fichier secret ; pour `file.restore`, l'empreinte du contenu
reçu doit correspondre ; écriture atomique (fichier temporaire + renommage). Avant d'agir, l'agent
fait un balayage immédiat : l'état actuel est donc dans l'historique et la restauration est annulable.

**Secrets** (`/etc/shadow*`, clés SSH d'hôte, `*.key`, `/etc/ssl/private`…) : leur modification est détectée
(empreinte) mais **leur contenu n'est jamais copié** ni restaurable (`noContent: true`).

Côté serveur : contenus chiffrés dans le `BlobStore` (table `agent_versions`), purgés après
`RETENTION_REWIND_DAYS` (90 jours) avec les événements qui les citent. API : `GET /api/hosts/:id/rewind/{events,changes,diff,version/:sha}`,
`POST /api/hosts/:id/rewind/restore {at, paths, confirm: true}` (**administrateur de l'hôte**, journalisé).

## 5 bis. Prévisualisation (étape 5.2)
Actions `preview.run {command, root, user, timeoutSec}` et `preview.apply {id}` ; annoncées dans
`capabilities.actions` seulement si l'agent tourne en root avec `--allow-preview`. L'agent lance le script
fixe de `agent/src/preview.rs` dans de nouveaux espaces de noms (`unshare --mount --pid --net`) : la commande
et les identifiants arrivent par variables d'environnement, jamais dans le texte du script. L'identifiant
d'une prévisualisation est un hexadécimal de 16 caractères (aucun chemin) ; les prévisualisations expirent
après 1 h ; `apply` refuse tout chemin sous `/proc`, `/sys`, `/dev`, `/run`, au dossier de l'agent, ou non
normalisé, et vérifie l'empreinte de chaque fichier d'origine avant d'écrire quoi que ce soit.

## 5 ter. Radiographie (étape 7.1)
Lecture de /proc toutes les 2 s (processus) et 6 s (connexions TCP établies non locales). Événements :
`proc.snapshot` (premier passage), `proc.start {pid, ppid, uid, start, exe, comm, cmd, lineage, via}`,
`proc.exit`, `proc.burst`, `conn.snapshot|open|close`. `lineage` = ancêtres (jusqu'à 8), `via` = session SSH
d'origine (« sshd: utilisateur@pts/0 » parmi les ancêtres). `(pid, start)` — `start` = « starttime » de
/proc — identifie un processus sans ambiguïté malgré la réutilisation des pids.
Actions : `xray.live` (lecture), `proc.freeze` (SIGSTOP), `proc.thaw` (SIGCONT), `proc.kill` (SIGKILL).
L'agent refuse : pid ≤ 1, un `start` qui ne correspond plus (pid réutilisé), un thread noyau, les processus
protégés (`systemd`, `sshd`, `tailscaled`, `corvus-agent`…) et l'agent lui-même ou ses ancêtres.
**Limite** : sondage, pas eBPF — un processus vivant moins de 2 s n'est pas vu.

## 6. Limites
- Balayage : pas de temps réel au-delà de 10 s ; fichiers > 512 Ko suivis sans contenu (non restaurables).
- Si l'agent est hors ligne pendant qu'un fichier change deux fois, seule la dernière version est connue.
- Corvus ne restaure que ce qu'un agent en ligne accepte ; pas de restauration de dossiers entiers « d'un coup » :
  la liste des différences est calculée, puis vous cochez les fichiers.
- Pas de TLS propre à Corvus : la confidentialité vient de Tailscale (WireGuard) + `tailscale serve`.
  Les signatures Ed25519 garantissent l'authenticité, pas le secret des échanges sur un réseau en clair :
  n'utilisez `http://` qu'en local.
