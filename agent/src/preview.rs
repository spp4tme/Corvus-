//! Prévisualisation d'une commande (étape 5.2) : elle est exécutée dans un « bac à sable » OverlayFS
//! (le système réel est en lecture seule, toutes les écritures vont dans une couche temporaire), sans
//! réseau, avec les capacités dangereuses retirées. On récupère ce qui AURAIT changé ; « appliquer »
//! rejoue ce diff, seulement si les fichiers d'origine n'ont pas bougé entre-temps.
//!
//! Désactivée par défaut : l'agent doit être lancé avec `--allow-preview` ET en root.
//! Limites honnêtes : réseau, bases de données, services et processus lancés ne sont pas simulés ;
//! les suppressions de dossiers entiers ne sont pas appliquées (seulement affichées).

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

const MAX_ENTRIES: usize = 500;
const MAX_TEXT: u64 = 64 * 1024;
const PREVIEW_TTL: Duration = Duration::from_secs(3600);
/// Chemins que « appliquer » ne touche jamais, quoi que contienne la couche.
const NEVER: [&str; 6] = ["/proc", "/sys", "/dev", "/run", "/tmp/corvus", "/var/lib/corvus-agent"];

/// Script exécuté dans de NOUVEAUX espaces de noms (montage, PID, réseau). Aucune donnée n'y est
/// interpolée : la commande et les ids arrivent par variables d'environnement (jamais dans le texte du script).
const SCRIPT: &str = r#"
set -eu
W="$P_WORK"
mount -t tmpfs -o "size=$P_SIZE" tmpfs "$W"
mkdir "$W/upper" "$W/work" "$W/merged"
mount -t overlay overlay -o "lowerdir=/,upperdir=$W/upper,workdir=$W/work" "$W/merged"
M="$W/merged"
mount -t proc proc "$M/proc"
mount -t tmpfs -o size=8m,mode=755 tmpfs "$M/dev"
mknod -m 666 "$M/dev/null" c 1 3
mknod -m 666 "$M/dev/zero" c 1 5
mknod -m 666 "$M/dev/random" c 1 8
mknod -m 666 "$M/dev/urandom" c 1 9
# /tmp reste celui de l'hôte (couche OverlayFS) : on peut donc prévisualiser une commande sur /tmp.
mount -t tmpfs tmpfs "$M/run"
DROP=-sys_admin,-sys_module,-sys_rawio,-sys_ptrace,-sys_boot,-sys_time,-mknod,-net_admin,-sys_chroot,-mac_admin,-mac_override,-sys_pacct,-sys_tty_config,-audit_control,-audit_write,-lease,-syslog,-wake_alarm,-block_suspend,-bpf,-perfmon,-checkpoint_restore
set +e
if [ "$P_ROOT" = 1 ]; then
  timeout -k 2 "$P_TIMEOUT" chroot "$M" setpriv --bounding-set="$DROP" --no-new-privs sh -c "$P_CMD" >"$W/stdout" 2>"$W/stderr" </dev/null
else
  timeout -k 2 "$P_TIMEOUT" chroot "$M" setpriv --reuid="$P_UID" --regid="$P_GID" --clear-groups --bounding-set=-all --no-new-privs sh -c "$P_CMD" >"$W/stdout" 2>"$W/stderr" </dev/null
fi
echo $? > "$P_OUT/exit"
set -e
head -c 65536 "$W/stdout" > "$P_OUT/stdout"
head -c 65536 "$W/stderr" > "$P_OUT/stderr"
mkdir -p "$P_OUT/upper"
cp -a "$W/upper/." "$P_OUT/upper/"
"#;

pub fn available() -> bool {
    // SAFETY : geteuid n'a aucun effet de bord.
    let root = unsafe { libc::geteuid() } == 0;
    root && ["unshare", "setpriv", "chroot", "timeout"].iter().all(|b| which(b))
}

fn which(bin: &str) -> bool {
    std::env::var("PATH").unwrap_or_default().split(':').any(|d| Path::new(d).join(bin).exists())
}

fn sha_file(p: &Path) -> Option<String> {
    let mut f = fs::File::open(p).ok()?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 { break; }
        h.update(&buf[..n]);
    }
    Some(hex::encode(h.finalize()))
}

fn text_of(p: &Path) -> Option<String> {
    let md = fs::metadata(p).ok()?;
    if !md.is_file() || md.len() > MAX_TEXT { return None; }
    String::from_utf8(fs::read(p).ok()?).ok()
}

/// (uid, gid) d'un compte d'après /etc/passwd.
pub fn lookup_user(name: &str) -> Result<(u32, u32), String> {
    if name.is_empty() || name.len() > 32 || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.') {
        return Err("nom d'utilisateur invalide".into());
    }
    let passwd = fs::read_to_string("/etc/passwd").map_err(|e| e.to_string())?;
    passwd.lines().find_map(|l| {
        let f: Vec<&str> = l.split(':').collect();
        (f.first() == Some(&name)).then(|| Some((f.get(2)?.parse().ok()?, f.get(3)?.parse().ok()?)))?
    }).ok_or_else(|| format!("utilisateur inconnu : {name}"))
}

fn purge_old(root: &Path) {
    let Ok(rd) = fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|d| d > PREVIEW_TTL);
        if old { let _ = fs::remove_dir_all(e.path()); }
    }
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn run(agent_dir: &Path, args: &Value) -> Result<Value, String> {
    if !available() { return Err("prévisualisation indisponible (agent non root ou unshare/setpriv/chroot absents)".into()); }
    let command = args["command"].as_str().ok_or("commande manquante")?;
    if command.is_empty() || command.len() > 4000 { return Err("commande vide ou trop longue".into()); }
    let as_root = args["root"].as_bool().unwrap_or(false);
    let (uid, gid) = if as_root { (0, 0) } else { lookup_user(args["user"].as_str().ok_or("utilisateur manquant")?)? };
    if !as_root && uid == 0 { return Err("pour root, utilisez l'option root (capacités réduites)".into()); }
    let timeout = args["timeoutSec"].as_u64().unwrap_or(30).clamp(1, 120);

    let previews = agent_dir.join("previews");
    fs::create_dir_all(&previews).map_err(|e| e.to_string())?;
    #[cfg(unix)] { let _ = fs::set_permissions(&previews, fs::Permissions::from_mode(0o700)); }
    purge_old(&previews);
    let id = format!("{:016x}", rand::random::<u64>());
    let out = previews.join(&id);
    fs::create_dir_all(&out).map_err(|e| e.to_string())?;

    let work = out.join("work"); // point de montage du tmpfs (disparaît avec le dossier de la prévisualisation)
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let status = Command::new("unshare")
        .args(["--mount", "--pid", "--net", "--fork", "--kill-child", "sh", "-c", SCRIPT])
        .env("P_CMD", command).env("P_UID", uid.to_string()).env("P_GID", gid.to_string())
        .env("P_ROOT", if as_root { "1" } else { "0" }).env("P_OUT", &out).env("P_WORK", &work).env("P_TIMEOUT", timeout.to_string()).env("P_SIZE", "256m")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped())
        .output().map_err(|e| format!("unshare : {e}"))?;
    if !out.join("exit").exists() {
        let _ = fs::remove_dir_all(&out);
        return Err(format!("bac à sable non démarré : {}", String::from_utf8_lossy(&status.stderr).trim().chars().take(300).collect::<String>()));
    }
    let exit: i64 = fs::read_to_string(out.join("exit")).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(-1);
    let read = |n: &str| String::from_utf8_lossy(&fs::read(out.join(n)).unwrap_or_default()).into_owned();

    let (entries, truncated) = diff_of(&out.join("upper"))?;
    let manifest = json!({ "id": id, "command": command, "root": as_root, "uid": uid, "gid": gid, "entries": entries, "truncated": truncated });
    fs::write(out.join("manifest.json"), manifest.to_string()).map_err(|e| e.to_string())?;
    Ok(json!({
        "id": id, "exit": exit, "stdout": read("stdout"), "stderr": read("stderr"), "durationMs": started.elapsed().as_millis() as u64,
        "timedOut": exit == 124 || exit == 137, "root": as_root, "entries": entries, "truncated": truncated,
    }))
}

/// Parcourt la couche d'écriture : ce qui y est = ce que la commande a créé / modifié / supprimé.
fn diff_of(upper: &Path) -> Result<(Vec<Value>, bool), String> {
    let mut out = Vec::new();
    let mut stack = vec![upper.to_path_buf()];
    let mut truncated = false;
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        let mut children: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        children.sort();
        for p in children {
            let rel = p.strip_prefix(upper).map_err(|e| e.to_string())?;
            let real = Path::new("/").join(rel);
            let real_s = real.to_string_lossy().into_owned();
            let Ok(md) = fs::symlink_metadata(&p) else { continue };
            if NEVER.iter().any(|n| real_s == *n || real_s.starts_with(&format!("{n}/"))) { continue; }
            if out.len() >= MAX_ENTRIES { truncated = true; break; }
            let ft = md.file_type();
            let existed = fs::symlink_metadata(&real).is_ok();
            let base_sha = if existed { sha_file(&real) } else { None };
            if ft.is_char_device() && md.rdev() == 0 { // « whiteout » : suppression
                let was_dir = fs::symlink_metadata(&real).map(|m| m.is_dir()).unwrap_or(false);
                out.push(json!({ "path": real_s, "kind": "deleted", "type": if was_dir { "dir" } else { "file" }, "baseSha": base_sha, "before": text_of(&real) }));
            } else if ft.is_dir() {
                if !existed { out.push(json!({ "path": real_s, "kind": "created", "type": "dir", "mode": md.mode() & 0o7777, "uid": md.uid(), "gid": md.gid() })); }
                stack.push(p);
            } else if ft.is_symlink() {
                let target = fs::read_link(&p).map(|t| t.to_string_lossy().into_owned()).unwrap_or_default();
                out.push(json!({ "path": real_s, "kind": if existed { "modified" } else { "created" }, "type": "symlink", "target": target }));
            } else if ft.is_file() {
                out.push(json!({
                    "path": real_s, "kind": if existed { "modified" } else { "created" }, "type": "file", "size": md.len(),
                    "mode": md.mode() & 0o7777, "uid": md.uid(), "gid": md.gid(), "baseSha": base_sha, "afterSha": sha_file(&p),
                    "before": if existed { text_of(&real) } else { None }, "after": text_of(&p),
                }));
            }
        }
    }
    Ok((out, truncated))
}

/// Rejoue le diff réel. TOUT est vérifié d'abord : un seul fichier d'origine modifié = conflit, rien n'est écrit.
pub fn apply(agent_dir: &Path, args: &Value) -> Result<Value, String> {
    let id = args["id"].as_str().ok_or("id manquant")?;
    if !valid_id(id) { return Err("id invalide".into()); }
    let dir = agent_dir.join("previews").join(id);
    let manifest: Value = serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).map_err(|_| "prévisualisation expirée ou inconnue".to_string())?).map_err(|e| e.to_string())?;
    let entries = manifest["entries"].as_array().ok_or("manifeste invalide")?;
    let upper = dir.join("upper");

    let mut conflicts = Vec::new();
    for e in entries {
        let path = e["path"].as_str().unwrap_or("");
        let real = Path::new(path);
        if !real.is_absolute() || real.components().any(|c| matches!(c, std::path::Component::ParentDir)) { return Err("chemin invalide dans le manifeste".into()); }
        if NEVER.iter().any(|n| path == *n || path.starts_with(&format!("{n}/"))) { return Err(format!("chemin interdit : {path}")); }
        if e["type"] == "dir" && e["kind"] == "deleted" { continue; } // non appliqué (affiché seulement)
        if e["type"] == "dir" { continue; }
        let now = if fs::symlink_metadata(real).is_ok() { sha_file(real) } else { None };
        let base = e["baseSha"].as_str().map(String::from);
        if now != base { conflicts.push(path.to_string()); }
    }
    if !conflicts.is_empty() { return Err(format!("conflit : ces fichiers ont changé depuis la prévisualisation : {}", conflicts.join(", "))); }

    let mut done = 0;
    let mut skipped = Vec::new();
    // Dossiers d'abord (triés du plus court au plus long), puis fichiers, puis suppressions.
    let mut order: Vec<&Value> = entries.iter().collect();
    order.sort_by_key(|e| (e["kind"] == "deleted", e["type"] != "dir", e["path"].as_str().map(str::len).unwrap_or(0)));
    for e in order {
        let path = e["path"].as_str().unwrap_or("");
        let real = Path::new(path);
        let rel = real.strip_prefix("/").map_err(|e| e.to_string())?;
        match (e["kind"].as_str(), e["type"].as_str()) {
            (Some("deleted"), Some("dir")) => skipped.push(format!("{path} (dossier : non supprimé automatiquement)")),
            (Some("deleted"), _) => { fs::remove_file(real).map_err(|e| format!("{path} : {e}"))?; done += 1; }
            (_, Some("dir")) => { fs::create_dir_all(real).map_err(|e| format!("{path} : {e}"))?; apply_meta(real, e); done += 1; }
            (_, Some("symlink")) => {
                let _ = fs::remove_file(real);
                std::os::unix::fs::symlink(e["target"].as_str().unwrap_or(""), real).map_err(|e| format!("{path} : {e}"))?;
                done += 1;
            }
            _ => {
                let data = fs::read(upper.join(rel)).map_err(|e| format!("{path} : couche illisible : {e}"))?;
                if let Some(sha) = e["afterSha"].as_str() { if hex::encode(Sha256::digest(&data)) != sha { return Err(format!("{path} : contenu de la couche altéré")); } }
                let tmp = real.with_extension(format!("corvus-apply-{}", std::process::id()));
                fs::write(&tmp, &data).map_err(|e| format!("{path} : {e}"))?;
                apply_meta(&tmp, e);
                fs::rename(&tmp, real).map_err(|e| { let _ = fs::remove_file(&tmp); format!("{path} : {e}") })?;
                done += 1;
            }
        }
    }
    let _ = fs::remove_dir_all(&dir); // un diff ne s'applique qu'une fois
    Ok(json!({ "applied": done, "skipped": skipped }))
}

fn apply_meta(p: &Path, e: &Value) {
    if let Some(m) = e["mode"].as_u64() { let _ = fs::set_permissions(p, fs::Permissions::from_mode(m as u32 & 0o7777)); }
    if let (Some(u), Some(g)) = (e["uid"].as_u64(), e["gid"].as_u64()) {
        if let Ok(c) = std::ffi::CString::new(p.to_string_lossy().as_bytes()) {
            // SAFETY : chemin C valide ; échec toléré (agent non root : on garde le propriétaire courant).
            unsafe { libc::chown(c.as_ptr(), u as u32, g as u32); }
        }
    }
}

/// Texte base64 d'un fichier de la couche (pour d'éventuels besoins de l'interface).
#[allow(dead_code)]
pub fn upper_b64(agent_dir: &Path, id: &str, rel: &str) -> Option<String> {
    if !valid_id(id) || rel.contains("..") { return None; }
    fs::read(agent_dir.join("previews").join(id).join("upper").join(rel.trim_start_matches('/'))).ok().map(|d| B64.encode(d))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiants_et_utilisateurs_valides() {
        assert!(valid_id("0123456789abcdef"));
        assert!(!valid_id("../../etc/passwd"));
        assert!(!valid_id("0123456789abcdeg"));
        assert!(lookup_user("root").is_ok());
        assert!(lookup_user("a b; rm").is_err());
        assert!(lookup_user("n_existe_pas_xyz").is_err());
    }

    #[test]
    fn apply_refuse_un_id_hors_previews() {
        let d = std::env::temp_dir().join(format!("corvus-prev-{}", rand::random::<u64>()));
        fs::create_dir_all(&d).unwrap();
        assert!(apply(&d, &json!({ "id": "../../x" })).is_err());
        assert!(apply(&d, &json!({ "id": "0123456789abcdef" })).unwrap_err().contains("expirée"));
    }
}
