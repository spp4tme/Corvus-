//! Actions que Corvus peut demander à l'agent. Corvus n'envoie JAMAIS de commande shell : seulement
//! des actions NOMMÉES, dont chaque argument est validé ici avant toute exécution.
//!
//! Actuellement : `file.restore` (remet une version d'un fichier surveillé).

use crate::watch::{is_secret, MAX_VERSION_BYTES};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

pub struct Context<'a> {
    pub roots: &'a [PathBuf],
    pub agent_dir: &'a Path,
    /// `--allow-preview` : prévisualisation de commandes (désactivée par défaut).
    pub allow_preview: bool,
}

pub fn names(allow_preview: bool) -> Vec<&'static str> {
    let mut v = vec!["file.restore", "file.remove", "xray.live", "proc.freeze", "proc.thaw", "proc.kill", "net.status", "net.isolate", "net.release"];
    if allow_preview && crate::preview::available() { v.extend(["preview.run", "preview.apply"]); }
    v
}

/// Chemin absolu, normalisé, sans « .. », sous une racine surveillée. Rien d'autre n'est modifiable.
pub fn check_path(ctx: &Context, path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if !p.is_absolute() { return Err("chemin absolu requis".into()); }
    if p.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) { return Err("chemin non normalisé (« .. »)".into()); }
    if !ctx.roots.iter().any(|r| p.starts_with(r)) { return Err("chemin hors des dossiers surveillés".into()); }
    if is_secret(path) { return Err("les fichiers secrets ne sont jamais restaurés par Corvus".into()); }
    // Ni lien symbolique au bout, ni dossier parent qui en soit un (évite d'écrire ailleurs que prévu).
    let parent = p.parent().ok_or("chemin invalide")?;
    let real_parent = fs::canonicalize(parent).map_err(|_| "dossier parent introuvable".to_string())?;
    let real_roots_ok = ctx.roots.iter().filter_map(|r| fs::canonicalize(r).ok()).any(|r| real_parent.starts_with(r));
    if !real_roots_ok { return Err("le dossier parent sort des dossiers surveillés (lien symbolique ?)".into()); }
    if fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false) { return Err("la cible est un lien symbolique".into()); }
    Ok(real_parent.join(p.file_name().ok_or("chemin invalide")?))
}

pub fn run(ctx: &Context, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "file.restore" => file_restore(ctx, args),
        "file.remove" => file_remove(ctx, args),
        "xray.live" => Ok(xray_live()),
        "proc.freeze" | "proc.thaw" | "proc.kill" => {
            let pid = args["pid"].as_u64().ok_or("pid manquant")? as u32;
            let start = args["start"].as_u64().ok_or("start manquant (identifiant du processus)")?;
            let sig = match name { "proc.freeze" => libc::SIGSTOP, "proc.thaw" => libc::SIGCONT, _ => libc::SIGKILL };
            crate::xray::signal(pid, start, sig)
        }
        "preview.run" | "preview.apply" if !(ctx.allow_preview && crate::preview::available()) => Err("prévisualisation désactivée sur cet agent (--allow-preview, agent root)".into()),
        "preview.run" => crate::preview::run(ctx.agent_dir, args),
        "preview.apply" => crate::preview::apply(ctx.agent_dir, args),
        other => Err(format!("action inconnue : {other}")),
    }
}

/// Supprime un fichier créé après l'instant visé (ne touche ni aux dossiers ni aux liens).
/// Instantané des processus (avec lignée) et des connexions, pour l'écran Radiographie.
fn xray_live() -> Value {
    use crate::xray::*;
    let all = read_all();
    let conns = read_conns();
    let inodes = conns.iter().map(|c| c.inode).collect();
    let owners = socket_owners(&all, &inodes);
    let mut procs: Vec<&Proc> = all.values().filter(|p| !p.exe.is_empty()).collect();
    procs.sort_by_key(|p| p.pid);
    let list: Vec<Value> = procs.iter().take(800).map(|p| json!({
        "pid": p.pid, "ppid": p.ppid, "uid": p.uid, "start": p.start, "comm": p.comm, "exe": p.exe, "cmd": p.cmd,
        "ssh": ssh_session(&all, p.pid).map(|(u, _)| u),
    })).collect();
    let cs: Vec<Value> = conns.iter().take(500).map(|c| {
        let o = owners.get(&c.inode).and_then(|pid| all.get(pid));
        json!({ "local": c.local, "remote": c.remote, "uid": c.uid, "pid": o.map(|p| p.pid), "exe": o.map(|p| p.exe.clone()) })
    }).collect();
    json!({ "processes": list, "connections": cs })
}

fn file_remove(ctx: &Context, a: &Value) -> Result<Value, String> {
    let target = check_path(ctx, a["path"].as_str().ok_or("path manquant")?)?;
    let md = fs::symlink_metadata(&target).map_err(|_| "le fichier n'existe déjà plus".to_string())?;
    if !md.is_file() { return Err("seuls les fichiers ordinaires peuvent être supprimés".into()); }
    fs::remove_file(&target).map_err(|e| format!("suppression : {e}"))?;
    Ok(json!({ "path": target.to_string_lossy(), "removed": true }))
}

fn file_restore(ctx: &Context, a: &Value) -> Result<Value, String> {
    let path = a["path"].as_str().ok_or("path manquant")?;
    let target = check_path(ctx, path)?;
    let sha = a["sha256"].as_str().ok_or("sha256 manquant")?;
    let data = B64.decode(a["data"].as_str().ok_or("contenu manquant")?).map_err(|e| format!("contenu illisible : {e}"))?;
    if data.len() as u64 > MAX_VERSION_BYTES { return Err("contenu trop gros".into()); }
    // Le contenu envoyé doit correspondre EXACTEMENT à l'empreinte annoncée.
    if hex::encode(Sha256::digest(&data)) != sha { return Err("empreinte différente du contenu reçu : restauration refusée".into()); }
    let mode = a["mode"].as_u64().unwrap_or(0o644) as u32 & 0o7777;
    let (uid, gid) = (a["uid"].as_u64().unwrap_or(0) as u32, a["gid"].as_u64().unwrap_or(0) as u32);

    // Écriture atomique : fichier temporaire dans le même dossier, puis renommage.
    let tmp = target.with_extension(format!("corvus-restore-{}", std::process::id()));
    fs::write(&tmp, &data).map_err(|e| format!("écriture : {e}"))?;
    let finish = || -> Result<(), String> {
        fs::set_permissions(&tmp, fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())?;
        // chown ne réussit qu'en root ; sans root on garde le propriétaire courant et on le signale.
        let c = std::ffi::CString::new(tmp.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
        // SAFETY : chemin C valide, appel sans effet mémoire.
        let rc = unsafe { libc::chown(c.as_ptr(), uid, gid) };
        if rc != 0 && unsafe { libc::geteuid() } == 0 { return Err("chown a échoué".into()); }
        fs::rename(&tmp, &target).map_err(|e| format!("renommage : {e}"))
    };
    if let Err(e) = finish() { let _ = fs::remove_file(&tmp); return Err(e); }
    let md = fs::metadata(&target).map_err(|e| e.to_string())?;
    Ok(json!({ "path": target.to_string_lossy(), "size": md.len(), "mode": md.mode() & 0o7777 }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dossier() -> PathBuf {
        let d = std::env::temp_dir().join(format!("corvus-act-{}", rand::random::<u64>()));
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    fn args(path: &Path, contenu: &str) -> Value {
        json!({ "path": path.to_string_lossy(), "sha256": hex::encode(Sha256::digest(contenu.as_bytes())), "data": B64.encode(contenu), "mode": 0o640, "uid": unsafe { libc::geteuid() }, "gid": unsafe { libc::getegid() } })
    }

    #[test]
    fn restaure_atomiquement_avec_les_droits() {
        let d = dossier();
        let f = d.join("a.conf");
        fs::write(&f, "nouveau").unwrap();
        let ctx = Context { roots: std::slice::from_ref(&d), agent_dir: &d, allow_preview: false };
        run(&ctx, "file.restore", &args(&f, "ancien")).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "ancien");
        assert_eq!(fs::metadata(&f).unwrap().mode() & 0o777, 0o640);
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1, "aucun fichier temporaire ne reste");
    }

    #[test]
    fn supprime_un_fichier_ordinaire_seulement() {
        let d = dossier();
        let ctx = Context { roots: std::slice::from_ref(&d), agent_dir: &d, allow_preview: false };
        fs::write(d.join("x"), "x").unwrap();
        run(&ctx, "file.remove", &json!({ "path": d.join("x").to_string_lossy() })).unwrap();
        assert!(!d.join("x").exists());
        fs::create_dir(d.join("sous")).unwrap();
        assert!(run(&ctx, "file.remove", &json!({ "path": d.join("sous").to_string_lossy() })).is_err());
    }

    #[test]
    fn refuse_ce_qui_est_dangereux() {
        let d = dossier();
        let ctx = Context { roots: std::slice::from_ref(&d), agent_dir: &d, allow_preview: false };
        // hors racine, « .. », relatif, secret, empreinte fausse, action inconnue
        assert!(run(&ctx, "file.restore", &args(Path::new("/etc/passwd"), "x")).is_err());
        assert!(run(&ctx, "file.restore", &args(&d.join("../x"), "x")).is_err());
        assert!(run(&ctx, "file.restore", &args(Path::new("rel"), "x")).is_err());
        assert!(run(&ctx, "file.restore", &args(&d.join("shadow"), "x")).is_err());
        let mut mauvais = args(&d.join("b"), "x");
        mauvais["sha256"] = json!("0".repeat(64));
        assert!(run(&ctx, "file.restore", &mauvais).unwrap_err().contains("empreinte"));
        assert!(run(&ctx, "rm -rf /", &json!({})).is_err());
        assert!(run(&ctx, "file.remove", &json!({ "path": "/etc/hostname" })).is_err());
        // lien symbolique à la place du fichier : refusé
        std::os::unix::fs::symlink("/etc/hostname", d.join("lien")).unwrap();
        assert!(run(&ctx, "file.restore", &args(&d.join("lien"), "x")).is_err());
    }
}
