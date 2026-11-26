// Script d'installation de l'agent en une commande, servi par Corvus (GET /api/agent/install.sh, public).
//   curl -fsSL https://<corvus>/api/agent/install.sh | sudo sh -s -- --server https://<corvus> --token <jeton> [--full]
// Le script ne contient AUCUN secret : le jeton à usage unique est passé en argument. Il télécharge le binaire de la
// release GitHub correspondant à la version de ce Corvus, vérifie son SHA-256, installe l'unité systemd puis enrôle.
// Les deux fichiers systemd ci-dessous sont des copies EXACTES de deploy/agent/ (un test le vérifie) : l'image Docker
// n'embarque pas le dossier deploy/, d'où la copie.
export const UNIT = `# Service systemd de l'agent Corvus.
#   sudo install -m 755 corvus-agent /usr/local/bin/corvus-agent
#   sudo corvus-agent enroll --server https://<corvus>.<tailnet>.ts.net --token <jeton>
#   sudo cp deploy/agent/corvus-agent.service /etc/systemd/system/ && sudo systemctl enable --now corvus-agent
#
# Droits : à ce stade l'agent n'envoie que des métriques lues dans /proc et /sys, il n'a donc besoin
# d'AUCUNE capacité. Les capacités (CAP_KILL, CAP_BPF…) seront ajoutées avec les étapes 6 et 7,
# chacune justifiée dans docs/plan.md §2.4.
[Unit]
Description=Agent Corvus
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/corvus-agent run
Environment=CORVUS_AGENT_DIR=/var/lib/corvus-agent
StateDirectory=corvus-agent
StateDirectoryMode=0700
Restart=always
RestartSec=5
# Durcissement : lecture seule du système, aucun privilège, aucun accès aux dossiers personnels.
User=root
CapabilityBoundingSet=
AmbientCapabilities=
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
`;
export const FULL_CONF = `# Drop-in systemd : donne à l'agent les droits des étapes 5.2, 6, 7 (prévisualisation, restauration,
# gel / arrêt de processus, isolement réseau). À n'installer QUE sur un hôte où vous voulez ces fonctions.
#   sudo mkdir -p /etc/systemd/system/corvus-agent.service.d
#   sudo cp deploy/agent/corvus-agent-full.conf /etc/systemd/system/corvus-agent.service.d/full.conf
#   sudo systemctl daemon-reload && sudo systemctl restart corvus-agent
# Retour en arrière : sudo rm /etc/systemd/system/corvus-agent.service.d/full.conf (puis daemon-reload + restart).
#
# Pourquoi chaque droit :
#   CAP_SYS_ADMIN, CAP_SYS_CHROOT, CAP_MKNOD, CAP_SETUID/SETGID/SETPCAP : bac à sable de prévisualisation
#   CAP_CHOWN, CAP_FOWNER, CAP_DAC_OVERRIDE, CAP_DAC_READ_SEARCH : restaurer / lire des fichiers de tout propriétaire
#   CAP_KILL : geler, dégeler, arrêter un processus d'un autre utilisateur
#   CAP_SYS_PTRACE : lire /proc/<pid>/exe des processus des autres utilisateurs (sans elle, la Radiographie ne liste que ceux de root)
#   CAP_NET_ADMIN (+ AF_NETLINK) : poser la table nftables d'isolement
#   PrivateTmp=no, ProtectHome=no : voir /tmp et /home tels qu'ils sont (prévisualisation et restauration exactes)
# CAP_SETUID / CAP_SETGID sont aussi AMBIANTES : sans cela le processus n'a pas CAP_SETUID de façon effective et la
# prévisualisation « en tant qu'un utilisateur » échoue (setpriv : « setresuid failed: Operation not permitted »).
# Contrepartie honnête : l'agent est bien plus puissant qu'avec l'unité de base. Il n'exécute jamais de
# commande reçue du serveur : seules des actions nommées et validées existent (docs/protocole-agent.md).
[Service]
ExecStart=
ExecStart=/usr/local/bin/corvus-agent run --allow-preview
CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SYS_CHROOT CAP_MKNOD CAP_SETUID CAP_SETGID CAP_SETPCAP CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_KILL CAP_NET_ADMIN CAP_SYS_PTRACE
AmbientCapabilities=CAP_SETUID CAP_SETGID
ProtectSystem=no
RestrictNamespaces=no
# Sans ces deux lignes l'agent voit un /tmp privé et un /home vide : la prévisualisation serait faussée.
PrivateTmp=no
ProtectHome=no
MemoryDenyWriteExecute=no
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
`;

/** Dépôt des releases (peut être remplacé pour un fork, ou contourné avec CORVUS_AGENT_URL côté hôte). */
export const RELEASES = 'https://github.com/spp4tme/Corvus-/releases/download';

export function installScript(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('version invalide');
  return `#!/bin/sh
# Installation de l'agent Corvus ${version} (généré par votre serveur Corvus). Lisez-le avant de l'exécuter.
#   --server URL   adresse de Corvus (obligatoire)   --token JETON   jeton à usage unique (obligatoire)
#   --full         droits complets (prévisualisation, restauration, gel de processus, isolement réseau)
#   --dry-run      affiche ce qui serait fait sans rien modifier
# Variables : CORVUS_AGENT_URL (binaire ailleurs que sur GitHub), CORVUS_AGENT_SERVER (adresse d'enrôlement si elle diffère).
set -eu
VERSION="${version}"
BASE="${RELEASES}/v$VERSION"
SERVER=""; TOKEN=""; FULL=0; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="\${2:-}"; shift 2 ;;
    --token) TOKEN="\${2:-}"; shift 2 ;;
    --full) FULL=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
done
[ -n "$SERVER" ] && [ -n "$TOKEN" ] || { echo "Usage : sh install.sh --server https://corvus --token JETON [--full] [--dry-run]" >&2; exit 2; }
say() { printf '==> %s\\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then echo "    (simulation) $*"; else "$@"; fi; }

[ "$(uname -s)" = Linux ] || { echo "L'agent ne fonctionne que sous Linux." >&2; exit 1; }
case "$(uname -m)" in
  x86_64|amd64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  *) echo "Architecture non prise en charge : $(uname -m) (x86_64 et aarch64 seulement)." >&2; exit 1 ;;
esac
if [ "$DRY" = 0 ]; then
  [ "$(id -u)" = 0 ] || { echo "Lancez ce script avec sudo (root est nécessaire pour installer l'unité systemd)." >&2; exit 1; }
  command -v systemctl >/dev/null 2>&1 || { echo "systemd est requis." >&2; exit 1; }
fi
if command -v curl >/dev/null 2>&1; then GET() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then GET() { wget -q "$1" -O "$2"; }
else echo "curl ou wget est requis." >&2; exit 1; fi
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum est requis pour vérifier le binaire." >&2; exit 1; }

NAME="corvus-agent-$VERSION-linux-$ARCH"
URL="\${CORVUS_AGENT_URL:-$BASE/$NAME}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
say "Agent Corvus $VERSION pour $ARCH"
if [ "$DRY" = 1 ]; then
  echo "    (simulation) télécharger $URL"
  echo "    (simulation) vérifier le SHA-256 avec $BASE/SHA256SUMS"
else
  say "Téléchargement : $URL"
  GET "$URL" "$TMP/agent" || { echo "Téléchargement impossible (la version $VERSION est-elle publiée ?)." >&2; exit 1; }
  if [ -z "\${CORVUS_AGENT_URL:-}" ]; then
    GET "$BASE/SHA256SUMS" "$TMP/sums" || { echo "SHA256SUMS introuvable : installation refusée." >&2; exit 1; }
    WANT="$(grep " $NAME\\$" "$TMP/sums" | cut -d' ' -f1)"
    GOT="$(sha256sum "$TMP/agent" | cut -d' ' -f1)"
    [ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { echo "Empreinte SHA-256 incorrecte : installation refusée." >&2; exit 1; }
    say "Empreinte SHA-256 vérifiée"
  else
    echo "    Attention : binaire fourni par CORVUS_AGENT_URL, empreinte non vérifiée." >&2
  fi
  chmod 755 "$TMP/agent"
  "$TMP/agent" version >/dev/null 2>&1 || { echo "Le binaire téléchargé ne s'exécute pas sur cette machine." >&2; exit 1; }
fi

say "Installation dans /usr/local/bin/corvus-agent"
if [ "$DRY" = 1 ]; then echo "    (simulation) install -m 755 agent /usr/local/bin/corvus-agent"; else install -m 755 "$TMP/agent" /usr/local/bin/corvus-agent; fi

say "Unité systemd"
if [ "$DRY" = 1 ]; then echo "    (simulation) écrire /etc/systemd/system/corvus-agent.service"; else
cat > /etc/systemd/system/corvus-agent.service <<'CORVUS_UNIT_EOF'
${UNIT}CORVUS_UNIT_EOF
fi
if [ "$FULL" = 1 ]; then
  say "Droits complets (full.conf) : voir les commentaires du fichier pour le détail de chaque droit"
  run mkdir -p /etc/systemd/system/corvus-agent.service.d
  if [ "$DRY" = 1 ]; then echo "    (simulation) écrire /etc/systemd/system/corvus-agent.service.d/full.conf"; else
cat > /etc/systemd/system/corvus-agent.service.d/full.conf <<'CORVUS_FULL_EOF'
${FULL_CONF}CORVUS_FULL_EOF
  fi
fi

say "Enrôlement auprès de $SERVER"
if [ "$DRY" = 1 ]; then echo "    (simulation) corvus-agent enroll --server $SERVER --token ********"; else
  /usr/local/bin/corvus-agent enroll --server "\${CORVUS_AGENT_SERVER:-$SERVER}" --token "$TOKEN" || {
    echo "Enrôlement refusé : jeton expiré ou déjà utilisé (créez-en un autre), ou Corvus injoignable depuis cette machine." >&2
    echo "Astuce : si l'adresse Tailscale (*.ts.net) ne se résout pas ici, relancez avec CORVUS_AGENT_SERVER=http://127.0.0.1:7680 si Corvus tourne sur cette machine." >&2
    exit 1
  }
fi

say "Démarrage"
run systemctl daemon-reload
run systemctl enable --now corvus-agent
say "Terminé : l'agent apparaît « en ligne » dans l'écran Agents de Corvus."
`;
}
