# Sécurité de Corvus

Corvus donne un **shell sur vos machines** à quiconque possède son token. Il est conçu pour
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

### Authentification
- Token aléatoire de 256 bits généré au premier lancement (`data/token`, permissions 600).
- Comparaison **timing-safe** (sur empreintes SHA-256 de taille fixe).
- Échange du token contre un cookie de session `HttpOnly; SameSite=Strict` (+ `Secure` en HTTPS),
  durée 30 jours (`SESSION_TTL_DAYS`). Le token n'est jamais stocké dans le navigateur.
- `Authorization: Bearer <token>` accepté pour les scripts.
- **Limitation des échecs** : délai exponentiel (0,25 s → 8 s) par tentative, blocage 15 min
  après 10 échecs **par IP**. Le volume global d'échecs n'alourdit que le délai (4 s minimum) et ne
  bloque jamais un autre appareil : personne ne peut vous enfermer dehors.
- Rotation : `npm run token:rotate` (re-chiffre les secrets, révoque toutes les sessions).

### API et WebSocket
- Toutes les routes `/api/*` (sauf `health`, `auth/status`, `auth/login`) et `/ws/*` exigent
  l'authentification.
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
  **scrypt** (N=2¹⁵) de `CORVUS_MASTER_PASSPHRASE` si définie, sinon du token.
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
- **Appareil perdu** : rotation du token (révoque toutes les sessions), et retirez l'appareil du tailnet.
- **Alerte host key** : ne vous connectez pas tant que vous n'avez pas vérifié l'empreinte.
