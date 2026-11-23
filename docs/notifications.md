# Notifications « commande terminée »

Corvus surveille la sortie des terminaux et réagit à la séquence d'échappement **OSC 777**
(`ESC ] 777 ; notify ; <titre> ; <message> BEL`), qu'émettent aussi d'autres terminaux (urxvt,
foot, Ghostty…). À chaque séquence reçue :

1. une entrée est ajoutée au **journal** ;
2. une **notification push** est envoyée à chaque appareil abonné (Réglages → Notifications).

## Prérequis

- Corvus accessible en **HTTPS** (`tailscale serve`) : le push l'exige.
- **iPhone/iPad** : iOS ou iPadOS 16.4 ou plus, Corvus **installé sur l'écran d'accueil**, puis
  activation depuis l'app installée.
- **Android / desktop** : Chrome, Edge ou Firefox. Le serveur Corvus doit pouvoir joindre Internet
  pour contacter le service de push du navigateur.

## Envoyer une notification à la main

Ajoutez cette fonction dans le `~/.bashrc` (ou `~/.zshrc`) des machines cibles :

```bash
# Envoie une notification Corvus : notify "message" ["titre"]
notify() {
  local esc
  if [ -n "$TMUX" ]; then
    # tmux doit laisser passer la séquence (tmux ≥ 3.3 : set -g allow-passthrough on)
    printf '\033Ptmux;\033\033]777;notify;%s;%s\007\033\\' "${2:-$(hostname)}" "$1"
  else
    printf '\033]777;notify;%s;%s\007' "${2:-$(hostname)}" "$1"
  fi
}
```

Puis :

```bash
make -j4 && notify "Build terminé ✔" || notify "Build ÉCHOUÉ ✘"
apt full-upgrade -y; notify "Mise à jour terminée"
```

Avec tmux, ajoutez dans `~/.tmux.conf` :

```
set -g allow-passthrough on
```

## Notification automatique des commandes longues (bash)

Ce bloc notifie chaque commande qui a duré **plus de 30 secondes** :

```bash
# ~/.bashrc — notifications Corvus automatiques (≥ 30 s)
__corvus_t0=0
__corvus_cmd=''
__corvus_preexec() { [ -z "$__corvus_cmd" ] && { __corvus_t0=$SECONDS; __corvus_cmd=$BASH_COMMAND; }; }
__corvus_precmd() {
  local rc=$? dt=$((SECONDS - __corvus_t0))
  if [ -n "$__corvus_cmd" ] && [ "$dt" -ge 30 ]; then
    notify "$([ $rc -eq 0 ] && echo ✔ || echo "✘ ($rc)") ${__corvus_cmd:0:80} — ${dt}s" "$(hostname)"
  fi
  __corvus_cmd=''
}
trap '__corvus_preexec' DEBUG
PROMPT_COMMAND="__corvus_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
```

Pour zsh, utilisez les hooks `preexec` et `precmd` (`autoload -Uz add-zsh-hook`) sur le même principe.

## Limites

- Corvus ne voit que la sortie des terminaux qu'il gère : la session doit exister côté serveur.
  C'est le cas tant qu'un onglet est ouvert, puis pendant `TERM_GRACE_SEC` (5 min par défaut)
  après fermeture du navigateur. Pour une commande très longue avec le téléphone en veille,
  augmentez ce délai (ex. `TERM_GRACE_SEC=86400`) ou utilisez tmux et rouvrez l'onglet.
- Le push ne transporte aucun contenu. Si la session du navigateur a expiré, la notification
  affiche un texte générique.
