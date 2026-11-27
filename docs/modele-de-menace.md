# Modèle de menace de Corvus

Document court : ce que Corvus protège, contre qui, et ce qu'il ne protège **pas**. Détails techniques :
[securite.md](securite.md) ; audit : [audit-1.1.0.md](audit-1.1.0.md).

## Ce qu'il faut protéger (actifs)

| Actif | Pourquoi c'est critique |
|---|---|
| **Accès SSH vers toutes vos machines** (mots de passe, clés privées, passphrases) | Corvus les détient : les voler = entrer partout |
| **Sessions de terminal** (en direct et enregistrées) | Elles montrent ce qui s'affiche sur vos machines |
| **Contenu des fichiers** (SFTP, historique de Rembobiner, copies « annulables ») | Configuration, clés, données |
| **Droit d'agir** : exécuter, supprimer, restaurer, isoler un hôte | Toute action destructive est une arme |
| **Journal d'audit** | Preuve de ce qui s'est passé |
| **Agent** (root sur certains hôtes) | Une porte privilégiée vers la machine |

## Qui l'attaque (adversaires considérés)

1. **Un appareil ou un service du tailnet, sans compte Corvus** : peut atteindre le port, tenter des mots de passe, forger des
   requêtes. → Doit échouer : TOTP obligatoire, limitation des essais, CSRF, Origin, en-têtes.
2. **Un compte à faibles droits** (lecteur, opérateur, accès à quelques hôtes) : veut lire ou agir au-delà. → Rôles, droits par hôte,
   hôte non accordé invisible (404), second contrôle dans chaque routeur.
3. **Un jeton d'API volé** (script, Raccourci Apple, fichier de configuration lu) : veut s'installer durablement. → Un jeton ne crée
   ni jeton, ni passkey, ni compte ; il se révoque.
4. **Une page web malveillante ouverte dans votre navigateur** : CSRF, dépôt de fichier par formulaire caché, vol de contenu. →
   Cookie `SameSite=Strict`, en-tête `X-Corvus`, Origin, CSP stricte, service worker qui refuse les dépôts venus d'un autre site.
5. **Un service du tailnet proxifié par Corvus** : veut sortir du bac à sable ou viser le réseau interne. → Cibles limitées à
   Tailscale et loopback (DNS vérifié après résolution), page servie sous `CSP: sandbox`, cookie jamais transmis.
6. **Un hôte compromis** : veut remonter vers Corvus. → L'agent se connecte *vers* Corvus avec authentification mutuelle ; Corvus
   n'envoie jamais de commande shell à l'agent, seulement des actions nommées et validées ; les clés SSH ne quittent pas Corvus.
7. **Un ransomware sur un hôte** : chiffre des fichiers. → Fichiers pièges, détection par entropie, historique chiffré côté Corvus
   (hors d'atteinte de l'hôte), isolement réseau, restauration confirmée.
8. **Quelqu'un qui obtient une copie du dossier de données ou d'une sauvegarde** : veut les secrets. → Chiffrement AES-256-GCM ;
   **avec une passphrase maître**, la copie seule ne suffit pas.

## Ce que Corvus protège

- l'accès non autorisé depuis le réseau (authentification forte, limitation d'essais, anti-CSRF, Origin) ;
- l'élévation de droits entre comptes et entre hôtes ;
- les secrets au repos (si passphrase maître) et leur absence des journaux, erreurs et sauvegardes en clair ;
- l'intégrité détectable du journal d'audit (chaînage SHA-256) ;
- l'historique des fichiers contre un attaquant qui n'est que sur l'hôte surveillé.

## Ce que Corvus ne protège pas

- **Un attaquant root sur le serveur Corvus** : il lit la mémoire, les secrets (surtout sans passphrase maître), peut recalculer toute
  la chaîne du journal. *Parades partielles* : passphrase maître, empreinte de tête notée hors du serveur (`corvus journal-head`).
- **Un administrateur malveillant** : il a, par définition, tous les droits sur Corvus et sur les hôtes accordés.
- **Un compte dont l'appareil et le TOTP sont volés ensemble**, ou un jeton d'API **volé** : ils agissent avec les droits de leur
  propriétaire jusqu'à révocation (les jetons n'expirent pas : révoquez-les).
- **La lecture par un « lecteur »** : un lecteur voit tout ce que le compte SSH de l'hôte peut lire (fichiers, processus, logs
  Docker, dépôts git). *« Lecture seule » ne veut pas dire « sans information »* : n'accordez ce rôle qu'à des personnes de confiance.
- **Internet** : Corvus n'est pas conçu pour y être exposé. Ne jamais utiliser `tailscale funnel`.
- **La disponibilité** : un appareil du tailnet peut bloquer la connexion d'un compte en multipliant les échecs pendant 15 minutes.
- **Les vulnérabilités du système sous-jacent** (Node.js, OpenSSH, noyau, Tailscale).
- **L'IA** : il n'y en a pas dans l'application ; l'onglet Claude se contente de lancer l'outil Claude Code installé sur vos hôtes,
  avec ses propres droits.

## Hypothèses

- Le tailnet est géré par vous (ACL Tailscale, appareils autorisés).
- Les administrateurs sont de confiance.
- Le serveur Corvus est à jour et n'héberge pas d'autres services exposés.
