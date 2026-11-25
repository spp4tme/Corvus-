// Analyse des commandes shell par RÈGLES (aucune IA) : niveau de risque, raisons lisibles,
// fichiers touchés (pour le mode « annulable ») et effets impossibles à annuler.
//
// Le découpage reste volontairement simple (pas un vrai parseur shell) : en cas de doute
// (substitution $(…), `…`, eval, sous-shell), la commande est déclarée « non annulable » et la
// prévisualisation est proposée. Mieux vaut refuser d'annuler que promettre à tort.

/** Découpe une ligne en commandes simples ; chaque mot garde sa forme « citée ou non ». */
export function tokenize(line) {
  const cmds = [];
  let words = [];
  let cur = null; // { text, quoted, raw }
  let redirect = null;
  const pushWord = () => {
    if (!cur) return;
    if (redirect) { words.push({ ...cur, redirect }); redirect = null; } else words.push(cur);
    cur = null;
  };
  const endCmd = (op) => {
    pushWord();
    if (words.length) cmds.push({ words, op });
    words = [];
  };
  const s = String(line);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      cur = cur || { text: '', quoted: false, raw: '' };
      cur.text += s[i + 1];
      cur.raw += ch + s[i + 1];
      cur.quoted = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = s.indexOf(ch, i + 1);
      const part = end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
      cur = cur || { text: '', quoted: false, raw: '' };
      cur.text += part;
      cur.raw += end < 0 ? s.slice(i) : s.slice(i, end + 1);
      cur.quoted = true;
      if (ch === '"' && /[$`]/.test(part)) cur.dynamic = true;
      i = end < 0 ? s.length : end;
      continue;
    }
    if (/\s/.test(ch)) { pushWord(); continue; }
    if (ch === ';' || ch === '&' || ch === '|') {
      const two = s.slice(i, i + 2);
      const op = two === '&&' || two === '||' || two === '>|' ? two : ch;
      if (op.length === 2) i++;
      endCmd(op);
      continue;
    }
    if (ch === '>' || ch === '<') {
      pushWord();
      // Les redirections vers un descripteur (2>&1, >&2) ne visent pas un fichier.
      const m = /^(>>|>|<)(&\d+)?/.exec(s.slice(i));
      const fdBefore = words.length && /^\d$/.test(words[words.length - 1]?.text) && !words[words.length - 1].quoted;
      if (fdBefore) words.pop();
      i += m[0].length - 1;
      if (!m[2]) redirect = m[1];
      continue;
    }
    cur = cur || { text: '', quoted: false, raw: '' };
    cur.text += ch;
    cur.raw += ch;
    if (ch === '$' || ch === '`') cur.dynamic = true;
  }
  endCmd(null);
  return cmds;
}

const sysPath = /^(\/|\/(etc|boot|usr|bin|sbin|lib|lib64|var\/lib|root)(\/|$))/;
const isOpt = (w) => /^-/.test(w.text) && !w.quoted;

// Effets que Corvus ne sait jamais annuler (réseau, services, bases…).
const NOT_UNDOABLE = [
  [/^(reboot|shutdown|poweroff|halt)$/, 'redémarrage / arrêt de la machine'],
  [/^systemctl$/, 'services (systemd)'],
  [/^(service|rc-service)$/, 'services'],
  [/^(iptables|ip6tables|nft|ufw|firewall-cmd)$/, 'pare-feu (accès réseau)'],
  [/^(ip|ifconfig|nmcli|route)$/, 'configuration réseau'],
  [/^(curl|wget|scp|rsync|ssh|nc|ncat)$/, 'effets réseau (envoi, téléchargement)'],
  [/^(mysql|psql|mongo|mongosh|redis-cli|sqlite3)$/, 'bases de données'],
  [/^(docker|podman|kubectl)$/, 'conteneurs'],
  [/^(apt|apt-get|dnf|yum|pacman|apk|zypper|snap|pip|pip3|npm)$/, 'paquets installés / supprimés'],
  [/^(kill|pkill|killall)$/, 'processus arrêtés'],
  [/^(useradd|userdel|usermod|passwd|groupadd|groupdel|chpasswd)$/, 'comptes utilisateurs'],
  [/^(crontab)$/, 'tâches planifiées'],
  [/^git$/, 'dépôt git (historique, distant)'],
  [/^(dd|mkfs.*|wipefs|fdisk|parted|sgdisk|mkswap|shred)$/, 'disques bruts'],
];

/**
 * @returns {{ level: 'safe'|'caution'|'danger', reasons: string[], files: string[], undoable: boolean,
 *            notUndoable: string[], preview: boolean, sudo: boolean, dynamic: boolean }}
 */
export function analyze(line) {
  const reasons = [];
  const files = [];
  const notUndoable = new Set();
  let level = 0; // 0 safe, 1 caution, 2 danger
  let sudo = false;
  let dynamic = false;
  let backupable = true;
  const raise = (l, why) => { level = Math.max(level, l); if (why && !reasons.includes(why)) reasons.push(why); };
  const text = String(line || '').trim();
  if (!text) return { level: 'safe', reasons: [], files: [], undoable: false, notUndoable: [], preview: false, sudo: false, dynamic: false };

  if (/:\(\)\s*\{.*\|.*&\s*\}\s*;?\s*:/.test(text)) raise(2, 'bombe fork : rend la machine inutilisable');
  if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(text)) raise(2, 'script téléchargé exécuté directement (curl | sh)');
  if (/\$\(|`|\beval\b|\bsource\b|^\.\s/.test(text)) { dynamic = true; backupable = false; }

  for (const cmd of tokenize(text)) {
    let words = cmd.words.filter((w) => !w.redirect);
    const redirects = cmd.words.filter((w) => w.redirect && w.redirect !== '<');
    // Préfixes : sudo, env, nice, time…
    while (words.length && /^(sudo|doas|env|nice|nohup|time|command|exec|stdbuf|ionice)$/.test(words[0].text)) {
      if (/^(sudo|doas)$/.test(words[0].text)) sudo = true;
      words = words.slice(1);
      while (words.length && (isOpt(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].text))) words = words.slice(1);
    }
    if (!words.length) continue;
    if (words.some((w) => w.dynamic)) { dynamic = true; backupable = false; }
    const name = words[0].text.split('/').pop();
    const args = words.slice(1);
    const opts = args.filter(isOpt).map((w) => w.text);
    const operands = args.filter((w) => !isOpt(w));
    const hasOpt = (re) => opts.some((o) => re.test(o));
    for (const [re, why] of NOT_UNDOABLE) if (re.test(name)) notUndoable.add(why);

    for (const r of redirects) {
      if (r.redirect === '>' || r.redirect === '>|') {
        raise(1, `écrase le fichier ${r.text}`);
        files.push(r.text);
      } else {
        files.push(r.text);
      }
      if (sysPath.test(r.text)) raise(2, `écrit dans un dossier système (${r.text})`);
    }

    switch (name) {
      case 'rm': {
        const recursive = hasOpt(/^-[a-zA-Z]*[rR]|^--recursive$/);
        const force = hasOpt(/^-[a-zA-Z]*f|^--force$/);
        raise(recursive || force ? 2 : 1, recursive ? 'suppression récursive (rm -r)' : 'suppression de fichiers (rm)');
        for (const o of operands) {
          if (/^(\/|\/\*|~|~\/|\*|\.|\.\.|\$HOME)\/?$/.test(o.text)) raise(2, `cible extrêmement large : ${o.text}`);
          if (sysPath.test(o.text)) raise(2, `supprime dans un dossier système (${o.text})`);
          files.push(o.text);
        }
        if (hasOpt(/^--no-preserve-root$/)) raise(2, '--no-preserve-root');
        break;
      }
      case 'mv': case 'cp': case 'install': case 'ln': {
        if (name === 'cp' && !hasOpt(/^-[a-zA-Z]*f/) && operands.length < 2) break;
        raise(1, name === 'mv' ? 'déplace / renomme (mv) : peut écraser la destination' : `${name} peut écraser la destination`);
        if (name === 'mv') for (const o of operands) files.push(o.text);
        else if (operands.length) files.push(operands[operands.length - 1].text);
        if (hasOpt(/^-[a-zA-Z]*[rR]/) && name === 'cp') backupable = false;
        if (operands.some((o) => sysPath.test(o.text))) raise(2, 'modifie un dossier système');
        break;
      }
      case 'sed': case 'perl': {
        if (!hasOpt(/^-[a-zA-Z]*i|^--in-place/)) break;
        raise(1, `modifie des fichiers sur place (${name} -i)`);
        // Premier opérande = le script, sauf s'il a été fourni par -e.
        const fileOps = hasOpt(/^-[a-zA-Z]*e$|^--expression/) ? operands : operands.slice(1);
        for (const o of fileOps) files.push(o.text);
        if (fileOps.some((o) => sysPath.test(o.text))) raise(2, 'modifie des fichiers système');
        break;
      }
      case 'truncate': case 'tee': {
        if (name === 'tee' && hasOpt(/^-[a-zA-Z]*a|^--append/)) { for (const o of operands) files.push(o.text); raise(1, 'ajoute à des fichiers (tee -a)'); break; }
        raise(1, name === 'tee' ? 'écrase des fichiers (tee)' : 'tronque des fichiers');
        for (const o of name === 'truncate' ? operands.filter((x) => !/^\d/.test(x.text)) : operands) files.push(o.text);
        break;
      }
      case 'chmod': case 'chown': case 'chgrp': {
        const rec = hasOpt(/^-[a-zA-Z]*R|^--recursive$/);
        raise(rec ? 2 : 1, rec ? `${name} récursif` : `change les droits (${name})`);
        if (rec) backupable = false;
        for (const o of operands.slice(1)) {
          files.push(o.text);
          if (sysPath.test(o.text)) raise(2, `droits d'un fichier système (${o.text})`);
        }
        break;
      }
      case 'find':
        if (args.some((w) => /^-(delete|exec|execdir|ok)$/.test(w.text))) { raise(2, 'find avec -delete / -exec : fichiers touchés imprévisibles'); backupable = false; }
        break;
      case 'dd': case 'shred': case 'wipefs': case 'fdisk': case 'parted': case 'sgdisk': case 'mkswap':
        raise(2, `outil disque destructeur (${name})`); backupable = false; break;
      case 'reboot': case 'shutdown': case 'poweroff': case 'halt':
        raise(2, 'redémarre ou arrête la machine'); break;
      case 'systemctl':
        if (operands.some((o) => /^(stop|disable|mask|kill|isolate|poweroff|reboot|halt)$/.test(o.text))) raise(2, 'arrête ou désactive un service');
        else if (operands.some((o) => /^(restart|reload|start|enable)$/.test(o.text))) raise(1, 'modifie un service');
        break;
      case 'kill': case 'pkill': case 'killall':
        raise(hasOpt(/^-(9|KILL|s\s*KILL)$/) || operands.some((o) => o.text === '1' || o.text === '-1') ? 2 : 1, 'arrête des processus'); break;
      case 'iptables': case 'ip6tables': case 'nft': case 'ufw': case 'firewall-cmd':
        if (args.some((w) => /^(-F|--flush|flush|reset|disable|-X|delete)$/.test(w.text))) raise(2, 'vide ou désactive le pare-feu : risque de perdre l\'accès');
        else raise(1, 'modifie le pare-feu');
        break;
      case 'git':
        if (operands[0]?.text === 'reset' && hasOpt(/^--hard$/)) raise(2, 'git reset --hard : modifications locales perdues');
        if (operands[0]?.text === 'clean' && hasOpt(/^-[a-zA-Z]*f/)) raise(2, 'git clean -f : fichiers non suivis supprimés');
        if (operands[0]?.text === 'push' && hasOpt(/^(-f|--force|--force-with-lease)$/)) raise(2, 'git push --force : réécrit l\'historique distant');
        if (operands[0]?.text === 'checkout' && operands.some((o) => o.text === '.' )) raise(1, 'git checkout . : modifications locales perdues');
        break;
      case 'docker': case 'podman':
        if (operands.some((o) => /^(rm|rmi|prune|kill|stop)$/.test(o.text)) || (operands[0]?.text === 'system' && operands[1]?.text === 'prune')) raise(2, 'supprime ou arrête des conteneurs / images');
        break;
      case 'apt': case 'apt-get': case 'dnf': case 'yum': case 'pacman': case 'zypper': case 'apk':
        if (operands.some((o) => /^(remove|purge|autoremove|erase|del)$/.test(o.text)) || hasOpt(/^-R/)) raise(2, 'désinstalle des paquets');
        else if (operands.some((o) => /^(install|upgrade|dist-upgrade|full-upgrade|update|add)$/.test(o.text)) || hasOpt(/^-S/)) raise(1, 'installe / met à jour des paquets');
        break;
      case 'userdel': case 'groupdel': raise(2, 'supprime un compte ou un groupe'); break;
      case 'passwd': case 'usermod': case 'chpasswd': raise(1, 'modifie un compte'); break;
      case 'crontab': if (hasOpt(/^-[a-zA-Z]*r/)) raise(2, 'crontab -r : supprime toutes les tâches planifiées'); break;
      default:
        if (/^mkfs/.test(name)) raise(2, 'formate un système de fichiers');
    }
  }
  if (sudo) raise(Math.max(level, 1), 'exécuté avec sudo (droits root)');
  const uniqueFiles = [...new Set(files)].slice(0, 200);
  const undoable = level > 0 && backupable && !dynamic && uniqueFiles.length > 0 && !sudo;
  return {
    level: ['safe', 'caution', 'danger'][level],
    reasons,
    files: uniqueFiles,
    undoable,
    notUndoable: [...notUndoable],
    // Proposer la prévisualisation quand l'annulation n'est pas possible ou que le risque est fort.
    preview: level === 2 || (level > 0 && !undoable),
    sudo,
    dynamic,
  };
}
