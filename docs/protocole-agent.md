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

## 5. Limites de la version 1
- Pas d'action envoyée par Corvus (le canal existe, mais aucune action n'est définie).
- Pas de TLS propre à Corvus : la confidentialité vient de Tailscale (WireGuard) + `tailscale serve`.
  Les signatures Ed25519 garantissent l'authenticité, pas le secret des métriques sur un réseau en clair :
  n'utilisez `http://` qu'en local.
- Pas encore d'alerte « agent hors ligne » ni de bouton « Installer l'agent » dans l'interface (API seulement).
