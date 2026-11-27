# Corvus — règles de travail pour Claude Code

Ce fichier est lu automatiquement à chaque session. **Il passe avant tout prompt de jalon** si les deux se contredisent
(sauf si le prompt dit explicitement qu'il remplace une règle). Réponds, commente et commite **en français**.

## Le projet
Corvus : passerelle SSH auto-hébergée (PWA + serveur Node 22 + agent Rust facultatif), accessible **uniquement via Tailscale**.
Elle détient des accès SSH vers toutes les machines de l'utilisateur : **la sécurité prime sur tout le reste**.
- Serveur : `server/` (JavaScript pur, Express 5, SQLite via `node:sqlite`). Routeurs dans `server/routes/`, logique dans `server/lib/`.
- Frontend : `public/` (JS sans framework, **jamais d'`innerHTML`** : `textContent` ou `public/js/ui/dom.js`).
- Agent : `agent/` (Rust). Protocole : `docs/protocole-agent.md`. Tests : `test/` (`node:test`, faux sshd dans `test/helpers/`).
- Promesses du README à ne jamais casser : auto-hébergé, **sans cloud, sans télémétrie, sans IA**, confirmation avant toute action
  destructive, tout est journalisé, **aucune dépendance à un binaire natif côté Node** (`npm run check:pure`).
- Ne gonfle jamais le code pour faire du volume. La taille est une conséquence du travail, pas un objectif.

## Sécurité (non négociable)
1. **Express route sans tenir compte de la casse ni du « / » final.** Une faille réelle est née de là (corrigée en 1.0.1). Toute
   décision d'autorisation se prend dans le routeur lui-même, jamais seulement dans un middleware.
2. **Nouvelle route — liste de contrôle, dans cet ordre :**
   a. `roleGuard(ctx, '<rôle>')` dans le routeur (`server/lib/access.js`) ;
   b. `ctx.requireHost(user, hostId, niveau)` pour toute route liée à un hôte (hôte non accordé = **404**, jamais 403) ;
   c. règle ajoutée à `GLOBAL_RULES` / `hostLevel` si le rôle dépasse « viewer » ;
   d. test dans `test/second-barrier.test.js` (routeur monté **sans** `accessGuard`, un compte trop faible doit être refusé) ;
   e. test de variantes (`/Route`, `/route/`, `//`) dans `test/accounts.test.js` ;
   f. entrée de journal (`ctx.journal.add`) : compte, IP, hôte, résultat — **jamais** de secret ni de contenu de fichier.
3. Rôles : `viewer` lit, `operator` agit, `admin` administre. Un droit par hôte ne dépasse jamais le rôle du compte.
4. **Toute action destructive ou irréversible exige `confirm: true` côté serveur.** Pas d'action destructive en un seul tap.
5. Valide toute entrée (`server/lib/validate.js`) : types, longueurs, chemins (`..`, liens symboliques, octets nuls),
   identifiants. Tout argument de commande construit côté serveur est échappé (quotes POSIX) ; jamais de concaténation brute ;
   les fichiers passent par SFTP, pas par un shell.
6. **Borne tout** : tailles lues/écrites/renvoyées, durées, nombre d'éléments, concurrence, débit. Aucune lecture non bornée en mémoire.
7. Secrets : dans le vault uniquement, jamais en clair en base, jamais dans les journaux, erreurs, sauvegardes ou réponses d'API.
8. Toute requête sortante du serveur (webhooks, intégrations) : cibles définies par un administrateur, validées, avec délai
   maximal, taille maximale, redirections refusées ou revalidées. Pas de requête vers une cible fournie par un utilisateur.
9. Pas de nouvelle dépendance sans raison solide : pure JS côté Node, versions épinglées, mentionnée dans le commit. Côté Rust,
   dépendances minimales et justifiées.
10. En cas de doute entre commodité et sécurité : la sécurité, et dis-le dans le rapport.

## Tests
- Après **chaque étape** : `npm test` complet vert + `npm run check:pure` (+ `cargo test` si l'agent change). Ne commite jamais un test rouge.
- Chaque fonction a : tests unitaires, un test e2e (faux sshd), tests de droits (viewer / operator / admin / hôte non accordé /
  aucun compte) et tests d'entrées hostiles (chemins, très longues valeurs, caractères de contrôle, casse, « / » final).
- Ajoute chaque nouveau fichier de test au script `npm test` de `package.json`.
- Sous Windows, les tests s'appuient sur bash : `CORVUS_TEST_BASH` doit pointer vers Git Bash.
- Si un test échoue pour une raison qui semble liée à l'environnement, **fais une expérience témoin sur le code d'origine**
  (`git stash`) avant de conclure. Ne dis jamais « c'est l'environnement » sans l'avoir vérifié.
- **Honnêteté** : ne marque rien « validé » qu'une machine réelle n'a pas observé. Ce qui n'a été testé qu'avec un faux hôte ou
  n'a pas pu être testé est écrit comme tel dans le rapport, le CHANGELOG et le wiki (comme dans `docs/suite-pi.md`).

## Git
- Début de jalon : `git status` propre, `git pull --rebase`. Travaille sur `main`.
- **Un commit par étape**, format `type(portée): résumé en français`, tests de l'étape dans le même commit.
- **Ne pousse qu'à la fin du jalon.** **JAMAIS `git push --force`, ni `--force-with-lease`, ni réécriture d'historique, ni
  suppression de tag existant.** Si le push est refusé : `git pull --rebase`, relance les tests, repousse normalement.
- Ne commite jamais de fichier `.patch`, d'archive, de secret, ni de dossier `data/`.

## Documentation
- **Le README est volontairement minimaliste** : n'y ajoute que des badges réels et une puce par nouvelle fonction. La
  documentation vit dans le **wiki** (`https://github.com/spp4tme/Corvus-.wiki.git`, branche `master`, dépôt séparé : clone-le
  hors du dépôt Corvus, lis `Home.md` et `_Sidebar.md`).
- **Mets à jour les pages existantes, ne crée pas de doublons. Ne renomme et ne supprime aucune page** : l'interface et le
  README pointent vers elles par leur nom. Avant de pousser le wiki, vérifie par grep que chaque lien `Corvus-/wiki/<Page>` du
  dépôt a toujours son fichier `<Page>.md`.
- Chaque nouveauté : une page (ou une section) dans le wiki, ajoutée à `_Sidebar.md` et `Home.md` ; `Securite.md` et
  `Limites-connues.md` à jour ; `CHANGELOG.md` à jour.
- Aucun badge décoratif ou mensonger : un badge reflète une mesure réelle, et son URL doit répondre.

## Release (en fin de jalon)
1. Versionne : `package.json`, `package-lock.json` (entrées du projet uniquement), `agent/Cargo.toml`, `agent/Cargo.lock`
   (uniquement `corvus-agent`), l'assertion de version dans `test/agent.test.js`, l'exemple d'installation, et une section
   `## [X.Y.Z] - AAAA-MM-JJ` dans `CHANGELOG.md` (le workflow en tire les notes).
2. Rejoue localement le contrôle de `.github/workflows/release.yml` (tag = package.json = Cargo.toml = section CHANGELOG) ;
   `cargo build --release`, suite complète.
3. `git push` (+ wiki). **Attends la CI verte** (`gh run watch`). Rouge = tu corriges, tu n'étiquettes pas.
4. `git tag vX.Y.Z && git push origin vX.Y.Z`, surveille le workflow **Release**, puis vérifie : release avec archive, binaires,
   `SHA256SUMS`, notes ; image `ghcr.io/spp4tme/corvus:X.Y.Z`.
5. Si la release échoue : ne improvise pas. Diagnostique, n'efface un tag que si rien n'a été publié, corrige, re-tague, explique.

## Déroulé d'un jalon
Plan en tâches → pour chaque étape : implémenter → tests → commit → à la fin : **audit court** propre au jalon (écris d'abord un
test qui exploite le problème, corrige, vérifie, commite `fix(sécurité): …`) → docs → version → push → CI verte → tag → vérification.

## Quand t'arrêter
Arrête-toi et demande si : le jalon précédent n'est pas publié (tag absent ou CI rouge) ; une règle ci-dessus t'oblige à une
action contraire à la demande ; une étape exige une décision irréversible ; tu découvres une faille grave hors périmètre
(corrige-la ou signale-la en premier). Si tu bloques sur une étape, commite ce qui est sain, note le blocage et continue.

## Compte rendu final (obligatoire)
Livré par étape (hash de chaque commit) ; résultats de `npm test`, `cargo test`, `npm audit`, `cargo audit` ; failles trouvées
et corrigées (gravité) ; **ce qui n'a pas pu être testé ou reste ouvert** ; lien de la release ; ce que je dois faire à la main.
