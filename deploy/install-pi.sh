#!/usr/bin/env bash
# Raccourci conservé pour la compatibilité : l'installateur est maintenant générique
# (Raspberry Pi, serveur ou PC Linux) → deploy/install-linux.sh
exec "$(dirname "${BASH_SOURCE[0]}")/install-linux.sh" "$@"
