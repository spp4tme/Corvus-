<div align="center">

<img src="public/icons/icon-512.png" alt="Logo Corvus : un corbeau dans un médaillon" width="160" height="160">

# Corvus

**Votre bastion SSH de poche, et le gardien de vos machines.**<br>
Terminal, fichiers, git, supervision et défense, depuis le navigateur de votre téléphone, sur votre réseau **Tailscale**.<br>
Auto-hébergé, gratuit, sans cloud, sans télémétrie, **sans IA**.

[![CI](https://github.com/spp4tme/Corvus-/actions/workflows/ci.yml/badge.svg)](https://github.com/spp4tme/Corvus-/actions/workflows/ci.yml)
[![CodeQL](https://github.com/spp4tme/Corvus-/actions/workflows/codeql.yml/badge.svg)](https://github.com/spp4tme/Corvus-/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/spp4tme/Corvus-/badge)](https://scorecard.dev/viewer/?uri=github.com/spp4tme/Corvus-)
[![PR Dependabot ouvertes](https://img.shields.io/github/issues-search/spp4tme/Corvus-?query=is%3Apr%20is%3Aopen%20author%3Aapp%2Fdependabot&label=PR%20Dependabot%20ouvertes)](https://github.com/spp4tme/Corvus-/pulls?q=is%3Apr+is%3Aopen+author%3Aapp%2Fdependabot)
[![Release](https://github.com/spp4tme/Corvus-/actions/workflows/release.yml/badge.svg)](https://github.com/spp4tme/Corvus-/actions/workflows/release.yml)
[![Version](https://img.shields.io/github/v/release/spp4tme/Corvus-?display_name=tag&sort=semver)](https://github.com/spp4tme/Corvus-/releases/latest)
[![Licence](https://img.shields.io/github/license/spp4tme/Corvus-)](LICENSE)
[![Node](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fspp4tme%2FCorvus-%2Fmain%2Fpackage.json&query=%24.engines.node&label=Node&logo=node.js&logoColor=white)](package.json)
[![Agent Rust](https://img.shields.io/badge/dynamic/toml?url=https%3A%2F%2Fraw.githubusercontent.com%2Fspp4tme%2FCorvus-%2Fmain%2Fagent%2FCargo.toml&query=%24.package.version&label=agent%20Rust&logo=rust&logoColor=white)](agent/)
[![Image Docker](https://ghcr-badge.egpl.dev/spp4tme/corvus/latest_tag?trim=major&label=image%20Docker)](https://github.com/spp4tme/Corvus-/pkgs/container/corvus)

[![Dernier commit](https://img.shields.io/github/last-commit/spp4tme/Corvus-)](https://github.com/spp4tme/Corvus-/commits/main)
[![Étoiles](https://img.shields.io/github/stars/spp4tme/Corvus-?style=flat)](https://github.com/spp4tme/Corvus-)
[![Tickets ouverts](https://img.shields.io/github/issues/spp4tme/Corvus-)](https://github.com/spp4tme/Corvus-/issues)
[![PR bienvenues](https://img.shields.io/badge/PR-bienvenues-brightgreen)](https://github.com/spp4tme/Corvus-/wiki/Contribuer)
[![Téléchargements](https://img.shields.io/github/downloads/spp4tme/Corvus-/latest/total)](https://github.com/spp4tme/Corvus-/releases/latest)
[![Taille du dépôt](https://img.shields.io/github/repo-size/spp4tme/Corvus-)](https://github.com/spp4tme/Corvus-)
[![Langage principal](https://img.shields.io/github/languages/top/spp4tme/Corvus-)](https://github.com/spp4tme/Corvus-)
[![SemVer](https://img.shields.io/badge/SemVer-2.0.0-blue)](https://semver.org/lang/fr/)
![Plateformes](https://img.shields.io/badge/plateformes-Linux%20%C2%B7%20amd64%20%C2%B7%20arm64-informational)
![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8)
![Tailscale](https://img.shields.io/badge/r%C3%A9seau-Tailscale-242424)

<img src="docs/img/hotes.png" alt="Corvus : la liste des hôtes avec leur état en continu" width="760">

</div>

## Installer

| Vous voulez… | Commande |
|---|---|
| **Essayer** (Node.js 22.13+) | `git clone https://github.com/spp4tme/Corvus-.git corvus && cd corvus && npm ci && npm start` |
| **Un service** sur Linux / Raspberry Pi | `tar xzf corvus-*.tar.gz && cd corvus-* && sudo ./deploy/install-linux.sh` (archive de la [dernière release](https://github.com/spp4tme/Corvus-/releases/latest)) |
| **Docker** (amd64, arm64) | `docker run -d --name corvus --network host -v corvus-data:/data ghcr.io/spp4tme/corvus:latest` |

Corvus n'écoute que sur `127.0.0.1:7680`. Au premier lancement, un token s'affiche : il sert à créer le compte administrateur.
**Ne l'exposez jamais sur Internet** : utilisez `tailscale serve` ([comment](https://github.com/spp4tme/Corvus-/wiki/Tailscale-et-PWA)).

## Ce que fait Corvus

- **Terminal, fichiers, git, supervision, Docker** sur vos machines, en SSH, avec une interface pensée d'abord pour le téléphone (PWA).
- **Comptes** avec TOTP obligatoire, passkeys, rôles, droits par hôte, journal d'audit infalsifiable.
- **Défense avec l'agent facultatif** (Rust, 3 Mo, aucun port ouvert sur l'hôte) : **Rembobiner** les fichiers, **prévisualiser** une
  commande risquée, **radiographier** les processus, repérer l'inhabituel, bloquer un **ransomware**.
- **Agent Windows et macOS** : lecture seule (métriques, processus, fichiers), Windows testé sur une vraie machine, service compris, macOS **expérimental** et jamais essayé sur un Mac réel ([wiki](https://github.com/spp4tme/Corvus-/wiki/Installation-Windows-et-macOS)).
- **Hôte « agent seul »** : suivre un PC avec l'agent, sans SSH, sans utilisateur ni mot de passe ([wiki](https://github.com/spp4tme/Corvus-/wiki/Agent-installation)).
- Règles et statistiques, **jamais d'IA**. Toute action destructive demande une confirmation et laisse une trace.
- **Comparer** un fichier de configuration entre 2 à 5 hôtes, côte à côte, mots de passe masqués ([wiki](https://github.com/spp4tme/Corvus-/wiki/Comparer)).
- **Rechercher dans vos replays** de sessions et exporter en `.cast` ([wiki](https://github.com/spp4tme/Corvus-/wiki/Enregistrements-et-partage)).
- **Notifications avec boutons** : Ouvrir, Acquitter, Isoler… (la confirmation reste dans l'application) ([wiki](https://github.com/spp4tme/Corvus-/wiki/Notifications)).
- **Copier un fichier ou un dossier d'un hôte à l'autre**, annulable ([wiki](https://github.com/spp4tme/Corvus-/wiki/Copie-d-hote-a-hote)).
- **Partager vers Corvus** depuis le menu Partager (Android, ordinateur) ; sur **iPhone**, Safari ne le permet pas : utilisez un Raccourci Apple
  ([wiki](https://github.com/spp4tme/Corvus-/wiki/Raccourci-iPhone)).

## Documentation

Tout est dans le **[wiki](https://github.com/spp4tme/Corvus-/wiki)** :

| | |
|---|---|
| [Démarrage rapide](https://github.com/spp4tme/Corvus-/wiki/Demarrage-rapide) | [Installation Linux](https://github.com/spp4tme/Corvus-/wiki/Installation-Linux) · [Docker](https://github.com/spp4tme/Corvus-/wiki/Installation-Docker) · [Windows et macOS](https://github.com/spp4tme/Corvus-/wiki/Installation-Windows-et-macOS) |
| [Configuration](https://github.com/spp4tme/Corvus-/wiki/Configuration) | [Sécurité](https://github.com/spp4tme/Corvus-/wiki/Securite) · [L'agent](https://github.com/spp4tme/Corvus-/wiki/Agent-vue-d-ensemble) · [Dépannage](https://github.com/spp4tme/Corvus-/wiki/Depannage) |
| [Limites connues](https://github.com/spp4tme/Corvus-/wiki/Limites-connues) | [Contribuer](https://github.com/spp4tme/Corvus-/wiki/Contribuer) · [Changelog](CHANGELOG.md) |

Documents techniques du dépôt : [protocole de l'agent](docs/protocole-agent.md), [sécurité](docs/securite.md),
[notifications](docs/notifications.md), [validations réelles](docs/suite-pi.md).

---

Licence : MIT. Corvus est un projet indépendant : nom, logo et interface originaux.
