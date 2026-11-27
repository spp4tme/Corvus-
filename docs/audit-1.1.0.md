# Audit de sécurité 1.1.0

Audit interne mené pendant la préparation de la 1.1.0 (novembre 2026). Principe : **chercher d'abord, prouver par un test qui
échoue, corriger, vérifier que le test passe, puis committer**. Les tests de cet audit sont dans `test/audit.test.js`,
`test/second-barrier.test.js` et les fichiers de test des nouvelles fonctions.

Ce document dit aussi **ce qui n'a pas été vérifié** et **ce qui reste ouvert** : un problème non corrigé y est listé comme tel.

## Méthode et limites

- Lecture du code serveur, des routes et du contrôle d'accès (`server/lib/access.js`, 144 routes), des constructions de commandes
  distantes, des routes de fichiers et de sauvegarde, du proxy web, du coffre, du journal, des WebSocket, du service worker et de
  l'agent Rust.
- Sondes dynamiques sur un Corvus de test (variantes de chemin : casse, « / » final, `%61`, `//`, `../`, identifiants en
  majuscules, caractères nuls).
- `npm audit --omit=dev --audit-level=high` : **0 vulnérabilité** (72 dépendances de production).
- `cargo clippy --all-targets -- -D warnings` : **7 avertissements corrigés**, puis 0.
- `cargo audit` : **1 vulnérabilité trouvée puis corrigée** (RUSTSEC-2026-0459, sévérité moyenne 6,8, SQLite embarqué dans `libsqlite3-sys` 0.30.1) ; 0 ensuite.
- **Ce n'est pas un test d'intrusion externe** : un seul relecteur, pas de fuzzing, pas d'analyse mémoire. L'absence de trouvaille sur
  un point ne prouve pas l'absence de défaut.

## Corrigé

| # | Gravité | Problème | Correction | Commit / test |
|---|---|---|---|---|
| 1 | **Haute** | **Un jeton d'API pouvait créer d'autres moyens de connexion** : un jeton volé pouvait, avant d'être révoqué, créer un nouveau jeton, enregistrer une passkey, ou (jeton d'administrateur) créer un compte administrateur. La révocation du jeton d'origine ne servait alors plus à rien. | Ces routes (`/me/tokens`, `/me/passkeys`, `/me/password`, `/users`, `/backups/restore`) exigent désormais une **session de navigateur** (mot de passe + TOTP ou passkey), jamais un jeton. | `2fc8a90`, `test/audit.test.js` |
| 2 | **Moyenne** | **Lectures trop larges pour un « lecteur »** : journaux système (`journalctl`), règles du pare-feu, liste des comptes de la machine, et contenu des anciennes versions de fichiers (copiées par l'agent, qui est root et lit ce que le compte SSH ne peut pas lire). | Réservés aux **opérateurs** : `admin/logs`, `admin/firewall`, `admin/users`, `rewind/diff`, `rewind/version/…`. | `b7abfe1`, `test/audit.test.js` |
| 3 | **Moyenne** | **Geler / dégeler / arrêter un processus par l'agent** (qui tourne en root) était permis à un simple opérateur : plus puissant que ce que son compte SSH permet. | Réservé à l'**administrateur de l'hôte** (comme l'isolement réseau). | `b7abfe1` |
| 4 | **Moyenne** | **Dépôt de fichier par un autre site** (« Partager vers Corvus ») : un formulaire caché sur un site tiers pouvait faire poster un fichier au service worker, qui l'aurait rangé dans la liste d'attente de l'utilisateur connecté (son cookie est envoyé par le service worker). | Le service worker n'accepte que les requêtes `Sec-Fetch-Site: none` (menu Partager du système) ou même origine ; sinon refus avant toute lecture. **Non vérifié sur un vrai téléphone** (voir plus bas). | `6f9ec89` |
| 5 | **Moyenne** | **Secrets mal protégés sans qu'on le dise** : sans passphrase maître, la clé qui chiffre les mots de passe et clés SSH est dérivée d'un fichier posé à côté de la base ; seul un message dans les journaux le signalait. | Avertissement **bloquant à l'installation** (`install-linux.sh` : définir la passphrase ou taper « je comprends » ; sans terminal, refus de la première installation sauf `--accept-no-passphrase`), **bandeau permanent** pour les administrateurs, alerte dans *Réglages → Stockage*, et `GET /api/system/status` expose `security`. | `228b58f` |
| 6 | Faible | **Empreinte de tête du journal non exportable** : pour détecter une réécriture complète de la chaîne par un attaquant root, il faut en avoir noté la tête ailleurs. | `sudo corvus journal-head` / `node server/cli.js journal-head` (code de sortie 2 si la chaîne est rompue). | `228b58f` |
| 7 | Faible | **« Infalsifiable » était inexact** : le chaînage rend toute modification *détectable*, pas *impossible* (un attaquant root peut tout recalculer). | Formulation corrigée (README, `docs/securite.md`, commentaires). | `228b58f` |
| 8 | Défense en profondeur | Le contrôle d'accès d'une route d'hôte ne reposait que sur `accessGuard` (un seul endroit). | **Seconde barrière générique** (`hostBarrier`) montée dans les routeurs : le droit sur l'hôte est revérifié au niveau canonique pour toute route `/hosts/:id/…`. Les identifiants d'hôte en majuscules sont traités comme des identifiants (404) au lieu d'être ignorés. | `b7abfe1`, `test/second-barrier.test.js` |
| 9 | Faible | Avertissements `clippy` dans l'agent. | Corrigés ; `cargo clippy -- -D warnings` fait partie de la CI. | `c0607b3` |
| 10 | Faible | Chaîne de livraison : actions GitHub appelées par étiquette modifiable (`@v4`), pas de `npm audit` / `cargo audit` en CI. | Actions **épinglées par empreinte de commit**, `npm audit`, `cargo audit`, `clippy`, CodeQL, OpenSSF Scorecard, Dependabot ; test qui interdit toute action non épinglée. | `a7b2161` |
| 11 | **Moyenne** | **Agent : SQLite embarqué vulnérable** (`libsqlite3-sys` 0.30.1, RUSTSEC-2026-0459 / CVE-2026-119375). L'agent s'en sert pour son tampon local d'événements. | `rusqlite` 0.32 → 0.43 (`libsqlite3-sys` 0.40) ; `cargo audit` fait partie de la CI. Mettez l'agent à jour avec Corvus (1.1.0). | `142c80b` |

## Examiné, aucun défaut trouvé

- **Variantes de chemin** (`%61dmin`, `//`, `/Admin/Logs/`, `;x`, identifiants en majuscules ou avec un nul) : refus ou 404, jamais
  d'accès. Express ne décode pas `%61` dans les segments littéraux, donc la route n'est pas atteinte.
- **Injection de commande** (`hostadmin.js`, `git.js`, `monitor.js`, `claude.js`, `terminal.js`, `agent-install.js`) : toutes les
  valeurs passent par `q()` (quotes POSIX, refus du nul) après validation stricte ; signaux en liste blanche ; noms de session tmux
  validés. Aucune interpolation sans échappement trouvée par recherche systématique.
- **Fichiers** : écriture atomique (fichier temporaire puis renommage), `Content-Disposition` sans caractère de contrôle, fichiers
  distants servis sous `CSP: sandbox`, noms de sauvegarde et d'entrées d'archive validés strictement (pas de « zip slip »),
  paramètres du KDF de sauvegarde bornés.
- **Authentification** : sessions aléatoires hachées, expiration, révocation à la désactivation du compte, TOTP anti-rejeu
  (fenêtre ±1 pas), échecs limités par IP **et** par compte, réponse indiscernable pour un compte inexistant, passkeys avec
  vérification de l'utilisateur exigée.
- **WebSocket** : authentification et vérification d'`Origin` sur chaque mise à niveau, reconstruction de l'IP via `X-Forwarded-For`
  seulement depuis la boucle locale, terminaux revérifiés toutes les 10 s et à chaque changement de compte.
- **Proxy web** : cible vérifiée **après** résolution DNS et connexion à l'adresse vérifiée (anti DNS-rebinding), redirections non
  suivies, cookie jamais transmis, jeton Corvus retiré, page sous `CSP: sandbox`, `window.opener` coupé.
- **En-têtes** : CSP stricte, `frame-ancestors 'self'`, COOP/CORP `same-origin`, `nosniff`, `Referrer-Policy: no-referrer`,
  cookie `HttpOnly; SameSite=Strict`. Aucun `innerHTML` (recherche systématique sur `public/`).
- **Agent Rust** : authentification mutuelle Ed25519 avec rôle dans le texte signé, chemins absolus, normalisés, sous un dossier
  surveillé, parent et cible non symboliques, jamais un fichier secret, écriture atomique ; pid + `starttime` pour les signaux ;
  processus protégés refusés ; aucune action qui exécute une commande arbitraire.
- **Vault** : AES-256-GCM, clé de données enveloppée par une clé dérivée (scrypt), fichiers en 0600, secrets jamais renvoyés au
  navigateur ni écrits dans le journal (le texte des erreurs et le détail du journal ne contiennent que des noms et des chemins).

## Nouvelles fonctions 1.1.0 : surface d'attaque

| Fonction | Contrôles |
|---|---|
| **Comparer** | viewer sur **chaque** hôte lu (404 sinon, avant toute lecture), 2 à 5 hôtes, 512 Ko, refus du binaire et du non-UTF-8, valeurs sensibles masquées **côté serveur** (jamais envoyées sans demande), révélation journalisée à part, journal sans contenu. |
| **Recherche et export des enregistrements** | mêmes droits que la relecture (ses sessions, hôte encore accessible), 404 identique pour une session inexistante, déchiffrement à la volée **sans index**, requête bornée (200 caractères, pas d'expression régulière), temps borné, pagination, **la requête n'est jamais écrite dans le journal**. |
| **Actions des notifications** | le push reste **sans contenu** ; les boutons sont calculés par le serveur selon les droits du compte ; « Isoler… » **n'isole pas** : il ouvre l'écran de confirmation ; « Acquitter » passe par la route existante (droits, journal, CSRF). |
| **Copie d'hôte à hôte** | viewer source + operator destination (404 si non accordé), pas d'écrasement sans `confirm: true`, un dossier n'est jamais fusionné, liens symboliques jamais suivis ni recréés, taille / nombre / profondeur / copies simultanées bornés, écriture atomique, annulation sans résidu, copie visible et annulable par son seul propriétaire. |
| **Partager vers Corvus** | rien n'est envoyé sans le choix explicite de l'hôte et du dossier ; stockage temporaire **propre au compte**, 30 min, effacé à la déconnexion ; refus des dépôts d'un autre site ; envoi iPhone par jeton personnel sur l'API d'envoi existante (droits, limite de taille, journal, pas d'écrasement). |

## Reste ouvert (non corrigé) — à connaître

1. **« Lecteur » = lecture de tout ce que le compte SSH peut lire** (fichiers par SFTP, processus, logs Docker, dépôts git). C'est la
   définition actuelle du rôle ; elle est décrite dans le modèle de menace. N'accordez ce rôle qu'à des personnes de confiance.
2. **Jetons d'API sans expiration ni portée** : un jeton agit avec tous les droits de son compte, sans le TOTP (c'est son usage), et
   n'expire pas. Il ne peut plus se reproduire (correctif 1) mais doit être **révoqué** à la main. Une durée de vie et des
   portées seraient un chantier à part.
3. **Verrouillage d'un compte par un tiers** : dix échecs avec le nom d'un compte le bloquent 15 minutes pour tout le monde (limiteur
   par compte). Choix assumé (contre l'attaque par essais) ; un appareil du tailnet peut en abuser pour gêner.
4. **Restauration de sauvegarde** : le fichier envoyé n'est pas borné en taille, et la décompression non plus. Il faut être
   administrateur, et une archive piégée doit être chiffrée avec le mot de passe de sauvegarde (donc connu de l'attaquant).
5. **`GET /api/auth/status`** (sans authentification) indique la version de Corvus : utile à qui cherche une version vulnérable.
6. **Proxy web** : `rejectUnauthorized: false` vers les services du tailnet (certificats auto-signés fréquents) ; le transport reste
   protégé par WireGuard, mais l'identité du service n'est pas vérifiée.
7. **Journal** : un attaquant root sur le serveur peut le réécrire entièrement ; seule une empreinte de tête **notée ailleurs** le
   détecte.
8. **Cache de service worker** : les fichiers « partagés » restent dans le stockage du navigateur jusqu'à envoi, annulation,
   déconnexion ou 30 min ; un autre logiciel avec accès au profil du navigateur peut les lire.

## Non vérifié

- **Partager vers Corvus sur un vrai Android** et le contrôle `Sec-Fetch-Site` du correctif 4 : la valeur envoyée par le navigateur
  pour une requête du menu Partager n'a pas été observée. Si un téléphone répondait « origine refusée » pour un partage légitime,
  le comportement est sûr (refus) mais la fonction serait inutilisable : à essayer avant de s'y fier.
- **Notifications avec boutons** sur iOS (ils sont ignorés par Safari : le clic sur la notification ouvre l'application) et sur un
  vrai Android : seule la logique est testée, pas l'affichage.
- **Copie d'hôte à hôte contre un vrai OpenSSH** (les tests utilisent le faux serveur SFTP, qui ignore `chmod` : les droits d'origine ne
  sont donc pas vérifiés).
- **Installation en une commande de l'agent** sur machine vierge, **image Docker** avec un vrai `docker run`.
- Le code de vérification **WebAuthn** (`webauthn.js`, CBOR et signatures) n'a été relu que superficiellement et n'a pas été fuzzé.
- `git.js` et `claude.js` : relus pour l'échappement, mais pas testés avec des entrées générées au hasard.
