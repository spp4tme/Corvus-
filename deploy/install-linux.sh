#!/usr/bin/env bash
# Installation de Corvus sur un serveur ou un PC Linux (systemd) : Debian, Ubuntu, Raspberry Pi OS,
# Fedora, RHEL/Rocky/Alma, openSUSE, Arch… en x86_64 ou arm64.
#
#   sudo ./deploy/install-linux.sh                 installation ou mise à jour
#   sudo ./deploy/install-linux.sh --no-service    copie + dépendances, sans systemd (lancement à la main)
#   sudo ./deploy/install-linux.sh --uninstall     retire le service et le code (garde les données)
#   sudo ./deploy/install-linux.sh --uninstall --purge   … et supprime aussi les données (tokens, secrets !)
#   sudo NODE_MAJOR=22 ./deploy/install-linux.sh   choisir la version de Node.js à installer si absente
#
# Ce script :
#   1. installe Node.js 22.13+ (binaire officiel nodejs.org, SHA256 vérifié) s'il manque ;
#   2. crée l'utilisateur système « corvus », /opt/corvus (code) et /var/lib/corvus (données, 700) ;
#   3. installe les dépendances (100 % JavaScript, aucune compilation) et l'unité systemd durcie ;
#   4. démarre Corvus sur 127.0.0.1:7680 (jamais exposé) et affiche le token d'accès ;
#   5. installe la commande `corvus` (token, status, logs, rotate-token).
#
# Variables de personnalisation (rarement utiles) : CORVUS_APP_DIR, CORVUS_DATA_DIR, CORVUS_ENV_FILE, CORVUS_CLI.
set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-24}"
APP_DIR="${CORVUS_APP_DIR:-/opt/corvus}"
DATA_DIR="${CORVUS_DATA_DIR:-/var/lib/corvus}"
ENV_FILE="${CORVUS_ENV_FILE:-/etc/corvus/corvus.env}"
UNIT=/etc/systemd/system/corvus.service
CLI="${CORVUS_CLI:-/usr/local/bin/corvus}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SERVICE=1 UNINSTALL=0 PURGE=0
for arg in "$@"; do
  case "$arg" in
    --no-service) SERVICE=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'Option inconnue : %s (voir --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mAttention :\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mErreur :\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || die "ce script est prévu pour Linux (macOS / Windows : voir le README, section « Sur un PC »)"
[ "$(id -u)" -eq 0 ] || die "lancez ce script avec sudo"
if [ "$SERVICE" -eq 1 ]; then
  command -v systemctl >/dev/null || die "systemd est introuvable. Sans systemd (Alpine, conteneur…), utilisez --no-service puis lancez : node $APP_DIR/server/index.js"
fi

# --- Désinstallation ------------------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
  if command -v systemctl >/dev/null && [ -f "$UNIT" ]; then
    systemctl disable --now corvus >/dev/null 2>&1 || true
    rm -f "$UNIT"
    systemctl daemon-reload
  fi
  rm -f "$CLI"
  rm -rf "$APP_DIR"
  say "Service et code supprimés."
  if [ "$PURGE" -eq 1 ]; then
    rm -rf "$DATA_DIR" "$(dirname "$ENV_FILE")"
    id corvus >/dev/null 2>&1 && userdel corvus 2>/dev/null || true
    say "Données et configuration supprimées (token, secrets chiffrés, hôtes)."
  else
    say "Données conservées dans $DATA_DIR (ajoutez --purge pour les supprimer)."
  fi
  exit 0
fi

[ -f "$SRC_DIR/server/index.js" ] || die "lancez le script depuis le dépôt Corvus (deploy/install-linux.sh)"

# --- 1. Node.js --------------------------------------------------------------------------
pkg_install() {
  if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq "$@"
  elif command -v dnf >/dev/null; then dnf install -y -q "$@"
  elif command -v yum >/dev/null; then yum install -y -q "$@"
  elif command -v zypper >/dev/null; then zypper --non-interactive install "$@"
  elif command -v pacman >/dev/null; then pacman -Sy --noconfirm --needed "$@"
  else die "installez manuellement : $* (gestionnaire de paquets non reconnu)"
  fi
}
# Node 22.13 minimum : module SQLite intégré (node:sqlite).
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; }

if node_ok; then
  say "Node.js $(node -v) déjà présent"
else
  case "$(uname -m)" in
    aarch64|arm64) ARCH=arm64 ;;
    x86_64|amd64) ARCH=x64 ;;
    armv7l) ARCH=armv7l ;;
    *) die "architecture non prise en charge : $(uname -m)" ;;
  esac
  for tool in curl tar sha256sum xz; do
    command -v "$tool" >/dev/null && continue
    case "$tool" in
      sha256sum) pkg_install coreutils ;;
      xz) pkg_install xz-utils 2>/dev/null || pkg_install xz ;;
      *) pkg_install "$tool" ;;
    esac
  done
  BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  say "Téléchargement de Node.js ${NODE_MAJOR}.x (${ARCH}) depuis nodejs.org"
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  FILE="$(grep -oE "node-v[0-9.]+-linux-${ARCH}\.tar\.xz" "$TMP/SHASUMS256.txt" | head -n1 || true)"
  [ -n "$FILE" ] || die "pas de binaire Node ${NODE_MAJOR} pour linux-${ARCH} : installez Node.js 22.13+ vous-même (gestionnaire de paquets, nvm…) puis relancez"
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && grep " ${FILE}\$" SHASUMS256.txt | sha256sum -c --status) || die "somme SHA256 invalide pour $FILE"
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$TMP/$FILE" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm /usr/local/bin/npm
  ln -sf /opt/node/bin/npx /usr/local/bin/npx
  say "Node.js $(node -v) installé dans /opt/node"
fi
NODE_BIN="$(readlink -f "$(command -v node)")"
NPM_BIN="$(command -v npm || true)"
[ -n "$NPM_BIN" ] || die "npm est introuvable (installez le paquet npm ou Node.js avec npm)"

# --- 2. Utilisateur et dossiers ------------------------------------------------------------
NOLOGIN="$(command -v nologin || true)"; NOLOGIN="${NOLOGIN:-/bin/false}"
id corvus >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell "$NOLOGIN" corvus
install -d -o corvus -g corvus -m 700 "$DATA_DIR"
install -d -o root -g root -m 755 "$APP_DIR"
install -d -o root -g corvus -m 750 "$(dirname "$ENV_FILE")"

say "Copie du code vers $APP_DIR"
for item in server public package.json package-lock.json .npmrc README.md docs LICENSE; do
  [ -e "$SRC_DIR/$item" ] || continue
  rm -rf "${APP_DIR:?}/$item"
  cp -a "$SRC_DIR/$item" "$APP_DIR/"
done
chown -R root:root "$APP_DIR"

# --- 3. Dépendances et configuration ---------------------------------------------------------
say "Installation des dépendances (production, sans compilation native)"
(cd "$APP_DIR" && "$NPM_BIN" ci --omit=dev --no-audit --no-fund --loglevel=error)

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
# Configuration Corvus (voir README). Redémarrer après modification : sudo systemctl restart corvus
BIND=127.0.0.1
PORT=7680
CORVUS_DATA=$DATA_DIR
# Fortement recommandé : sans passphrase, les secrets sont chiffrés avec une clé dérivée du token
# (stocké dans le même dossier). Avec une passphrase, voler $DATA_DIR ne suffit plus.
# CORVUS_MASTER_PASSPHRASE=une-longue-phrase-secrète
# CORVUS_ALLOWED_ORIGINS=https://mon-serveur.mon-tailnet.ts.net
# CORVUS_WEB_PROXY=1
# LOG_LEVEL=info
# Données lourdes (base, enregistrements, sauvegardes) sur un SSD externe :
# CORVUS_STORAGE=/mnt/ssd/corvus
EOF
fi
chown root:corvus "$ENV_FILE"
chmod 640 "$ENV_FILE"

PORT_NOW="$(sed -n 's/^PORT=\([0-9]*\).*/\1/p' "$ENV_FILE" | tail -n1)"; PORT_NOW="${PORT_NOW:-7680}"

# Commande d'administration : sudo corvus token | status | logs | rotate-token | restart
cat > "$CLI" <<'EOF'
#!/usr/bin/env bash
# Généré par deploy/install-linux.sh
set -e
[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"
ENV_FILE='__ENV_FILE__'
export CORVUS_DATA='__DATA_DIR__'
CORVUS_MASTER_PASSPHRASE="$(sed -n 's/^CORVUS_MASTER_PASSPHRASE=//p' "$ENV_FILE" 2>/dev/null | tail -n1 | sed 's/^"\(.*\)"$/\1/')"
export CORVUS_MASTER_PASSPHRASE
CORVUS_STORAGE="$(sed -n 's/^CORVUS_STORAGE=//p' "$ENV_FILE" 2>/dev/null | tail -n1 | sed 's/^"\(.*\)"$/\1/')"
export CORVUS_STORAGE
cli() {
  if command -v runuser >/dev/null; then runuser -u corvus -- '__NODE__' '__APP_DIR__/server/cli.js' "$@"
  else sudo -E -u corvus '__NODE__' '__APP_DIR__/server/cli.js' "$@"; fi
}
case "${1:-}" in
  token) cli token ;;
  rotate-token) cli rotate-token; systemctl restart corvus ;;
  status) systemctl status corvus --no-pager ;;
  logs) journalctl -u corvus -n "${2:-100}" --no-pager ;;
  restart) systemctl restart corvus ;;
  *) echo "Usage : sudo corvus token | rotate-token | status | logs [n] | restart" >&2; exit 1 ;;
esac
EOF
sed -i "s|__ENV_FILE__|$ENV_FILE|g; s|__DATA_DIR__|$DATA_DIR|g; s|__NODE__|$NODE_BIN|g; s|__APP_DIR__|$APP_DIR|g" "$CLI"
chmod 755 "$CLI"

if [ "$SERVICE" -eq 0 ]; then
  say "Installé dans $APP_DIR (sans service)."
  echo
  echo "  Lancer :  sudo -u corvus env CORVUS_DATA=$DATA_DIR $NODE_BIN $APP_DIR/server/index.js"
  echo "  Token  :  sudo corvus token"
  exit 0
fi

# Stockage lourd sur un autre disque (CORVUS_STORAGE dans $ENV_FILE) : le service doit pouvoir y écrire.
STORAGE_DIR="$(sed -n 's/^CORVUS_STORAGE=//p' "$ENV_FILE" | tail -n1 | sed 's/^"\(.*\)"$/\1/')"
RW_PATHS="$DATA_DIR"
if [ -n "$STORAGE_DIR" ]; then
  [ -d "$STORAGE_DIR" ] || die "CORVUS_STORAGE=$STORAGE_DIR introuvable : montez le disque et créez le dossier (propriétaire corvus, chmod 700)"
  chown corvus:corvus "$STORAGE_DIR" && chmod 700 "$STORAGE_DIR"
  RW_PATHS="$DATA_DIR $STORAGE_DIR"
fi
sed "s|^ExecStart=.*|ExecStart=$NODE_BIN $APP_DIR/server/index.js|; s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR|; s|^ReadWritePaths=.*|ReadWritePaths=$RW_PATHS|" \
  "$SRC_DIR/deploy/corvus.service" > "$UNIT"
chmod 644 "$UNIT"
systemctl daemon-reload
systemctl enable corvus >/dev/null
systemctl restart corvus

# --- 4. Vérification -------------------------------------------------------------------------
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${PORT_NOW}/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:${PORT_NOW}/api/health" >/dev/null || die "Corvus ne répond pas : sudo corvus logs"

TOKEN="$("$CLI" token)"
say "Corvus est démarré sur http://127.0.0.1:${PORT_NOW} (service systemd « corvus »)"
echo
echo "  Token d'accès : $TOKEN"
echo "  (réaffichable avec : sudo corvus token)"
echo
echo "  Comment y accéder depuis votre appareil — Corvus n'écoute QUE sur 127.0.0.1 :"
if command -v tailscale >/dev/null; then
  echo "    sudo tailscale serve --bg --https=443 http://127.0.0.1:${PORT_NOW}     (HTTPS, tailnet uniquement)"
else
  echo "    • Tailscale (recommandé) : curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up"
  echo "      puis : sudo tailscale serve --bg --https=443 http://127.0.0.1:${PORT_NOW}"
fi
echo "    • ou un tunnel SSH, sans rien installer :  ssh -L ${PORT_NOW}:127.0.0.1:${PORT_NOW} utilisateur@ce-serveur"
echo "      puis ouvrez http://127.0.0.1:${PORT_NOW} sur votre appareil."
echo
echo "  Conseils :"
echo "    • activez CORVUS_MASTER_PASSPHRASE dans $ENV_FILE (puis : sudo corvus restart) ;"
echo "    • installez tmux sur chaque machine pilotée (reprise de session, Claude Code) ;"
echo "    • ne JAMAIS utiliser « tailscale funnel » ni exposer le port ${PORT_NOW} sur Internet."
