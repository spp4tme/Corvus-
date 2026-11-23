#!/usr/bin/env bash
# Installation de Corvus sur Raspberry Pi OS (64 bits) / Debian / Ubuntu, en service systemd.
#   sudo ./deploy/install-pi.sh            # installation ou mise à jour
#   sudo NODE_MAJOR=24 ./deploy/install-pi.sh
# Ce script :
#   1. installe Node.js (binaire officiel nodejs.org, SHA256 vérifié) si Node < 20 ;
#   2. crée l'utilisateur système « corvus », /opt/corvus (code) et /var/lib/corvus (données, 700) ;
#   3. installe les dépendances (100 % JS, aucune compilation) et l'unité systemd durcie ;
#   4. démarre Corvus sur 127.0.0.1:7680 et affiche le token d'accès.
set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-24}"
APP_DIR=/opt/corvus
DATA_DIR=/var/lib/corvus
ENV_FILE=/etc/corvus/corvus.env
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mErreur :\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "lancez ce script avec sudo"
command -v systemctl >/dev/null || die "systemd est requis"
[ -f "$SRC_DIR/server/index.js" ] || die "lancez le script depuis le dépôt Corvus (deploy/install-pi.sh)"

# --- 1. Node.js --------------------------------------------------------------------------
node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if node_ok; then
  say "Node.js $(node -v) déjà présent"
else
  case "$(uname -m)" in
    aarch64|arm64) ARCH=arm64 ;;
    x86_64|amd64) ARCH=x64 ;;
    armv7l) die "Raspberry Pi OS 32 bits non pris en charge par les binaires officiels Node ${NODE_MAJOR} : installez la version 64 bits" ;;
    *) die "architecture non prise en charge : $(uname -m)" ;;
  esac
  for tool in curl tar sha256sum xz; do command -v "$tool" >/dev/null || { apt-get update -qq; apt-get install -y -qq curl tar coreutils xz-utils; break; }; done
  BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  say "Téléchargement de Node.js ${NODE_MAJOR}.x (${ARCH}) depuis nodejs.org"
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  FILE="$(grep -oE "node-v[0-9.]+-linux-${ARCH}\.tar\.xz" "$TMP/SHASUMS256.txt" | head -n1)"
  [ -n "$FILE" ] || die "binaire introuvable pour linux-${ARCH}"
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && grep " ${FILE}\$" SHASUMS256.txt | sha256sum -c --status) || die "somme SHA256 invalide pour $FILE"
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$TMP/$FILE" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm /usr/local/bin/npm
  ln -sf /opt/node/bin/npx /usr/local/bin/npx
  say "Node.js $(node -v) installé dans /opt/node"
fi

# --- 2. Utilisateur et dossiers ------------------------------------------------------------
id corvus >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin corvus
install -d -o corvus -g corvus -m 700 "$DATA_DIR"
install -d -o root -g root -m 755 "$APP_DIR"
install -d -o root -g corvus -m 750 /etc/corvus

say "Copie du code vers $APP_DIR"
for item in server public package.json package-lock.json .npmrc README.md docs; do
  [ -e "$SRC_DIR/$item" ] && cp -a "$SRC_DIR/$item" "$APP_DIR/"
done
chown -R root:root "$APP_DIR"

# --- 3. Dépendances et configuration ---------------------------------------------------------
say "Installation des dépendances (production, sans compilation native)"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'EOF'
# Configuration Corvus (voir README). Redémarrer après modification : sudo systemctl restart corvus
BIND=127.0.0.1
PORT=7680
CORVUS_DATA=/var/lib/corvus
# CORVUS_MASTER_PASSPHRASE=une-longue-phrase-secrète
# CORVUS_ALLOWED_ORIGINS=https://raspberrypi.mon-tailnet.ts.net
# CORVUS_WEB_PROXY=1
# LOG_LEVEL=info
EOF
fi
chown root:corvus "$ENV_FILE"
chmod 640 "$ENV_FILE"

install -m 644 "$SRC_DIR/deploy/corvus.service" /etc/systemd/system/corvus.service
systemctl daemon-reload
systemctl enable corvus >/dev/null
systemctl restart corvus

# --- 4. Vérification -------------------------------------------------------------------------
for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:7680/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:7680/api/health" >/dev/null || die "Corvus ne répond pas : journalctl -u corvus -n 50"

TOKEN="$(sudo -u corvus env CORVUS_DATA="$DATA_DIR" /usr/local/bin/node "$APP_DIR/server/cli.js" token)"
say "Corvus est démarré sur http://127.0.0.1:7680 (service systemd « corvus »)"
echo
echo "  Token d'accès : $TOKEN"
echo
if command -v tailscale >/dev/null; then
  echo "  Exposez Corvus en HTTPS sur votre tailnet (uniquement) :"
  echo "    sudo tailscale serve --bg --https=443 http://127.0.0.1:7680"
  echo "    puis ouvrez https://$(tailscale status --json 2>/dev/null | grep -oE '"DNSName": *"[^"]+' | head -n1 | sed 's/.*"//; s/\.$//')"
else
  echo "  Tailscale n'est pas installé : curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up"
fi
echo
echo "  Conseil : sudo apt install tmux   (sur chaque machine cible, pour la reprise de session)"
echo "  Ne JAMAIS utiliser « tailscale funnel » ni exposer le port 7680 sur Internet."
