#!/usr/bin/env bash
# FAUX RANSOMWARE pour démontrer la défense de Corvus (étape 7.3). INOFFENSIF PAR CONSTRUCTION :
#  - il ne travaille QUE dans le dossier de démonstration qu'il crée lui-même (marqueur .corvus-demo-marker) ;
#  - il refuse tout autre dossier, tout lien symbolique, tout chemin hors /tmp ;
#  - « chiffrer » = remplacer le contenu par des octets aléatoires et renommer en .locked (rien d'irrécupérable :
#    Corvus conserve les versions, donc la restauration par Rembobiner remet tout en place).
#
# Utilisation :
#   1) bash fake-ransomware.sh prepare            → crée le dossier de démo et affiche la commande de l'agent à lancer
#   2) lancer l'agent avec --watch et --canary sur ce dossier (la commande est affichée)
#   3) bash fake-ransomware.sh attack <dossier>   → « chiffre » les fichiers de démo
#   4) bash fake-ransomware.sh clean <dossier>    → supprime le dossier de démo
set -euo pipefail
MARKER=.corvus-demo-marker

check_dir() {
  local d="$1"
  [[ "$d" == /tmp/corvus-ransomware-demo-* ]] || { echo "refusé : dossier hors /tmp/corvus-ransomware-demo-*" >&2; exit 2; }
  [[ -d "$d" && ! -L "$d" && -f "$d/$MARKER" ]] || { echo "refusé : ce n'est pas un dossier de démonstration créé par ce script" >&2; exit 2; }
}

case "${1:-}" in
  prepare)
    d=$(mktemp -d /tmp/corvus-ransomware-demo-XXXXXX)
    touch "$d/$MARKER"
    for i in $(seq 1 30); do
      { echo "Document de démonstration n°$i — contenu ordinaire, lisible, plutôt répétitif."; for _ in $(seq 1 60); do echo "Ligne de texte d'exemple pour que l'entropie reste basse avant l'attaque ($i)."; done; } > "$d/document-$i.txt"
    done
    echo "Dossier de démonstration : $d"
    echo "Agent à lancer (dans un autre terminal) :"
    echo "  corvus-agent run --watch $d --canary $d --ransom-threshold 10 --scan-interval 2"
    echo "Puis : bash $0 attack $d"
    ;;
  attack)
    d="${2:?dossier requis}"; check_dir "$d"
    echo "Attaque simulée dans $d …"
    for f in "$d"/*; do
      [[ -f "$f" && ! -L "$f" ]] || continue
      head -c "$(stat -c %s "$f")" /dev/urandom > "$f.tmp" && mv "$f.tmp" "$f" && mv "$f" "$f.locked"
      sleep 0.2
    done
    # Une rançon, comme dans la vraie vie.
    echo "VOS FICHIERS SONT CHIFFRES (démonstration Corvus — rien n'est perdu)" > "$d/LISEZ-MOI.txt"
    echo "Terminé : ouvrez Corvus → Rembobiner, choisissez un instant avant l'attaque, restaurez."
    ;;
  clean)
    d="${2:?dossier requis}"; check_dir "$d"; rm -rf -- "$d"; echo "Supprimé."
    ;;
  *) echo "usage : $0 prepare | attack <dossier> | clean <dossier>" >&2; exit 1 ;;
esac
