# Politique de sécurité

Corvus donne un **accès shell** à vos machines. Un défaut de sécurité y est donc grave : merci de le signaler **en privé**.

## Signaler une vulnérabilité

Utilisez le signalement privé de GitHub :
**[Security → Report a vulnerability](https://github.com/spp4tme/Corvus-/security/advisories/new)** (GitHub Security Advisories).

N'ouvrez **pas** de ticket public et ne publiez aucun détail exploitable avant la correction. Indiquez :

- la version de Corvus (écran Réglages, ou `GET /api/health`) et le système ;
- ce qui est possible pour l'attaquant (lire, écrire, exécuter, se faire passer pour un compte…) et **avec quels droits de départ**
  (aucun compte, lecteur, opérateur, administrateur, simple accès au tailnet…) ;
- les étapes pour reproduire, idéalement un test qui échoue ;
- si vous le souhaitez, comment vous voulez être crédité.

Corvus est un projet personnel, maintenu sur le temps libre : **accusé de réception sous 7 jours**, correction visée sous 30 jours
pour une faille confirmée. Une correction est publiée comme version corrective (`1.1.x`) avec une mention dans la section
« Sécurité » du [CHANGELOG](CHANGELOG.md).

## Versions prises en charge

| Version | Correctifs de sécurité |
|---|---|
| **1.1.x** | ✅ |
| 1.0.x | ⚠️ seulement les failles critiques, le temps de migrer vers 1.1 |
| < 1.0 | ❌ |

L'agent (`corvus-agent`) a le même numéro de version que Corvus : mettez les deux à jour ensemble.

## Ce qui est dans le périmètre

- le serveur Corvus (`server/`), l'interface (`public/`), le service worker, les scripts d'installation (`deploy/`) ;
- l'agent Rust (`agent/`) et son protocole (`docs/protocole-agent.md`) ;
- l'image Docker et les binaires publiés avec chaque release ;
- le contournement de l'authentification, des rôles (lecteur / opérateur / administrateur) ou des droits par hôte ;
- l'injection de commande, la traversée de chemin, la fuite de secrets ou de contenu de fichiers, le rejeu, le CSRF, le SSRF.

## Ce qui est hors périmètre

- l'exposition de Corvus sur Internet (`tailscale funnel`, redirection de port…) : **elle est explicitement déconseillée** ;
- un attaquant déjà **root sur le serveur Corvus** (il lit les secrets si aucune passphrase maître n'est définie, et peut
  recalculer le journal d'audit : voir [docs/modele-de-menace.md](docs/modele-de-menace.md)) ;
- un appareil du tailnet compromis dont le propriétaire possède un compte Corvus valide, avec son TOTP ;
- les vulnérabilités de Tailscale, de Node.js, d'OpenSSH ou de systemd eux-mêmes (signalez-les à leurs projets) ;
- les attaques par déni de service sans gain d'accès (flot de requêtes depuis le tailnet…) ;
- les rapports issus d'un scanner automatique sans scénario d'exploitation.

## Bonnes pratiques de déploiement

Le [wiki](https://github.com/spp4tme/Corvus-/wiki/Securite) détaille la configuration sûre. Les trois essentielles :
**ne jamais exposer Corvus sur Internet** ; **définir `CORVUS_MASTER_PASSPHRASE`** ; **noter l'empreinte de tête du journal**
(`sudo corvus journal-head`) ailleurs que sur le serveur.

Les audits internes sont décrits dans [docs/audit-1.1.0.md](docs/audit-1.1.0.md) (ce qui a été trouvé, corrigé, et ce qui n'a pas
pu être vérifié).
