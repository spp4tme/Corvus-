# Sécurité de Corvus

Corvus donne un **shell sur vos machines** à ses utilisateurs. Il est conçu pour
n'être joignable **que depuis votre tailnet Tailscale**.

## Règles d'exposition

| ✅ À faire | ❌ À ne jamais faire |
|---|---|
| `BIND=127.0.0.1` (défaut) + `tailscale serve --https=443 http://127.0.0.1:7680` | `tailscale funnel` (publie sur Internet) |
| ou `BIND=100.x.y.z` (IP Tailscale de la machine) | redirection de port sur la box, `BIND=<IP publique>` |
| HTTPS via `tailscale serve` (certificat `*.ts.net` automatique) | reverse-proxy public (nginx, Cloudflare Tunnel…) |

Corvus **refuse de démarrer** si `BIND` est une adresse IP publique (contournable uniquement avec
`CORVUS_ALLOW_PUBLIC_BIND=1`, à ne pas utiliser). `0.0.0.0` et les adresses LAN déclenchent un
avertissement.

Vous pouvez en plus restreindre l'accès avec les **ACL Tailscale** (n'autoriser que vos appareils
vers le port 443 de la machine Corvus).

## Mesures en place

### Comptes et authentification
- **Comptes nominatifs** : identifiant + mot de passe (12 caractères min., haché **scrypt**
  N=2¹⁵) + **TOTP obligatoire** (RFC 6238, 6 chiffres / 30 s, anti-rejeu : un code ne sert
  qu'une fois). Le secret TOTP est stocké dans le coffre chiffré.
- **Premier lancement** : le token aléatoire de 256 bits (`data/token`, 600) sert uniquement à
  créer le premier administrateur. Il ne permet plus de se connecter ensuite (il reste la clé du
  coffre si aucune passphrase maître n'est définie).
- **Rôles** : administrateur (tout), opérateur (utilise les hôtes accordés), lecture seule.
  Droits par hôte, par groupe ou « tous les hôtes » ; un droit ne dépasse jamais le rôle du compte.
  Un hôte non accordé est **invisible** (404). Un seul middleware décide pour toutes les routes
  (`server/lib/access.js`) : toute nouvelle route d'hôte est protégée d'office.
- Comptes créés par un administrateur : **mot de passe provisoire** à changer et TOTP à enrôler
  à la première connexion. Dernier administrateur protégé (ni supprimé, ni rétrogradé).
- Cookie de session `HttpOnly; SameSite=Strict` (+ `Secure` en HTTPS), 30 jours
  (`SESSION_TTL_DAYS`) ; désactiver un compte coupe ses sessions.
- **Jetons d'API personnels** (`cvu_…`, Bearer) pour les scripts, révocables, stockés hachés.
- **Limitation des échecs** par IP **et** par identifiant : délai exponentiel (0,25 s → 8 s),
  blocage 15 min après 10 échecs. Réponse en temps constant que le compte existe ou non.
- Rotation du token d'amorçage : `npm run token:rotate` (ré-emballe la clé du coffre, révoque
  toutes les sessions). Tant que le serveur n'a pas redémarré, il refuse de modifier les secrets.

### Passkeys, enregistrements, partage
- **Passkeys** (WebAuthn, option) : connexion sans mot de passe, **vérification de l'utilisateur
  exigée** sur l'appareil (empreinte, visage ou code) ; défi à usage unique (5 min), origine et
  domaine vérifiés, compteur anti-clonage. Vérification codée sans dépendance (CBOR + node:crypto).
- **Enregistrements** : sortie du terminal uniquement (les frappes, donc les mots de passe tapés
  pour sudo, ne sont jamais enregistrées), stockés compressés + chiffrés, 90 jours. Un compte ne
  relit que ses sessions (l'administrateur toutes) ; chaque relecture est journalisée.
- **Partage en direct** : uniquement sur invitation du propriétaire, à un compte qui a accès à
  l'hôte (co-pilote : rôle opérateur exigé) ; un spectateur ne peut ni taper, ni redimensionner,
  ni fermer ; retrait immédiat ; tout est journalisé.

### Journal d'audit infalsifiable
- Connexions (réussies et échouées), terminaux, transferts SFTP, git, Docker, processus, comptes,
  hôtes, sauvegardes : chaque entrée indique le compte, l'IP et l'hôte.
- **Chaînage SHA-256** : chaque entrée contient l'empreinte de la précédente. *Journal → Vérifier
  l'intégrité* recalcule toute la chaîne et signale la première entrée modifiée ou supprimée.
- Le journal n'est jamais vidé ni purgé. **Limite** : un attaquant root sur le serveur Corvus
  peut recalculer toute la chaîne ; notez l'empreinte de tête affichée (ou exportez-la) pour
  comparer plus tard.

### API et WebSocket
- Toutes les routes `/api/*` (sauf `health` et `auth/*`) et `/ws/*` exigent un compte
  authentifié (session cookie après TOTP, ou jeton d'API).
- **Anti-CSRF** : toute mutation par cookie exige l'en-tête `X-Corvus: 1` (impossible à envoyer
  cross-origin sans pré-vol CORS, que Corvus n'accorde jamais) et une origine identique.
- **Origin check WebSocket** : obligatoire pour les navigateurs. L'origine MagicDNS
  `https://<machine>.<tailnet>.ts.net` est autorisée automatiquement si le CLI `tailscale` est présent ;
  sinon, `CORVUS_ALLOWED_ORIGINS`.
- En-têtes : CSP stricte (`script-src 'self'`, `object-src 'none'`, `base-uri 'none'`,
  `frame-ancestors 'self'`), `nosniff`, `Referrer-Policy: no-referrer`, COOP.
  `style-src` autorise `'unsafe-inline'`, requis par xterm.js ; les scripts restent stricts.
- Le frontend n'utilise **jamais `innerHTML`** : toute donnée distante passe par `textContent`.

### Secrets
- Mots de passe, clés privées et passphrases chiffrés au repos : **AES-256-GCM**, clé dérivée par
  par une clé de données elle-même chiffrée par une clé dérivée (**scrypt** N=2¹⁵) de
  `CORVUS_MASTER_PASSPHRASE` si définie, sinon du token d'amorçage. Stockés dans SQLite.
- Fichiers de données en 600, dossier en 700.
- Les secrets ne sont **jamais renvoyés** au frontend (seulement `hasPassword` / `hasKey`).
- Avec une passphrase maître, voler le dossier `data/` ne suffit plus à lire les secrets.

### SSH
- Host keys en **TOFU** : l'empreinte SHA-256 est mémorisée à la première connexion. Si elle
  change, la connexion est **refusée** et une alerte affiche les deux empreintes. Vérifiez la
  nouvelle hors-bande (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` sur la machine) avant
  de l'accepter.
- Toute commande construite côté serveur échappe ses arguments (quotes POSIX), après validation
  stricte : chemins, identifiants, SHA, noms de branche (sous-ensemble de `git check-ref-format`),
  noms de conteneur, PID, signaux en liste blanche.
- Les messages de commit passent par stdin ; les opérations de fichiers passent par SFTP
  (aucun shell).
- Les fichiers distants téléchargés ou prévisualisés sont servis sous `CSP: sandbox` : un SVG ou
  un HTML malveillant ne peut pas s'exécuter dans l'origine Corvus.

### Proxy web
- Cibles limitées aux adresses Tailscale et loopback, vérifiées **après** résolution DNS
  (anti DNS-rebinding). Le chemin demandé ne peut jamais changer d'hôte ni sortir du préfixe du
  service enregistré (`//autre-hote/…` est refusé). Pour le LAN, définir `CORVUS_PROXY_ALLOW_PRIVATE=1`.
- Accès par jeton aléatoire (expiration glissante de 12 h). Le cookie Corvus n'est jamais transmis.
- Pages servies sous `CSP: sandbox` sans `allow-same-origin` : origine opaque, aucun accès à l'API.

### Notifications push
- VAPID (ES256), push **sans contenu** : le détail est récupéré par le service worker avec la session.
- Les notifications déclenchées par un terminal (OSC 777) sont limitées à une toutes les 3 s par session : un processus distant ne peut pas inonder le journal ni vos appareils.
- Seuls les services de push des navigateurs (Google, Mozilla, Apple, Microsoft) sont contactés (anti-SSRF).

## Que faire si…

- **Token compromis** : `npm run token:rotate` puis redémarrez Corvus.
- **Appareil perdu** : un administrateur désactive le compte ou réinitialise son TOTP (coupe ses
  sessions), et retirez l'appareil du tailnet.
- **Administrateur unique qui perd son TOTP** : arrêtez Corvus, puis
  `sqlite3 <stockage>/corvus.db "UPDATE users SET totp_enabled=0 WHERE username='admin'"` :
  l'enrôlement sera redemandé à la connexion suivante (mot de passe toujours exigé).
- **Alerte host key** : ne vous connectez pas tant que vous n'avez pas vérifié l'empreinte.
