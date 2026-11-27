//! Windows : métriques et processus par `sysinfo`, surveillance de fichiers par `ReadDirectoryChangesW` (via `notify`),
//! exécution en service Windows, identité protégée par une ACL restrictive (l'équivalent du mode 0600).

pub mod service;

use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const NAME: &str = "windows";
/// `ReadDirectoryChangesW` : le système signale les changements, le balayage en donne le détail (empreinte, taille, date).
pub const FSNOTIFY: bool = true;

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string())
}

pub fn default_data_dir() -> PathBuf {
    PathBuf::from(env_or("ProgramData", r"C:\ProgramData")).join("CorvusAgent")
}

/// Par défaut : la configuration d'OpenSSH Server et le fichier `hosts` (cibles classiques d'une modification discrète).
pub fn default_watch_roots() -> String {
    format!("{}\\ssh,{}\\System32\\drivers\\etc", env_or("ProgramData", r"C:\ProgramData"), env_or("SystemRoot", r"C:\Windows"))
}

/// Un dossier surveillé doit être un chemin LOCAL absolu et normalisé : ni UNC, ni flux de données, ni nom réservé, ni `..`.
pub fn is_root_path(p: &str) -> bool {
    super::pathcheck::windows_path_error(p).is_none()
}

pub fn hostname() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

pub fn is_secret_extra(path: &str) -> bool {
    super::pathcheck::windows_is_secret(path)
}

/// Programme système appelé par son chemin complet (jamais par une recherche dans le PATH : pas de détournement).
fn system32(exe: &str) -> PathBuf {
    PathBuf::from(env_or("SystemRoot", r"C:\Windows")).join("System32").join(exe)
}

/// Rend le fichier lisible par SON PROPRIÉTAIRE (le compte qui exécute l'agent), SYSTEM et les Administrateurs seulement :
/// l'héritage est coupé, donc ni `Users`, ni `Everyone`, ni `Authenticated Users`. Échec = erreur (on n'enregistre pas
/// une clé privée dans un fichier qu'on n'a pas pu protéger).
pub fn harden_secret(path: &Path) -> io::Result<()> {
    let who = Command::new(system32("whoami.exe")).output()?;
    let me = String::from_utf8_lossy(&who.stdout).trim().to_string();
    if !who.status.success() || me.is_empty() || me.contains(['\r', '\n']) {
        return Err(io::Error::other("whoami n'a pas donné d'identité exploitable"));
    }
    // SID bien connus (indépendants de la langue de Windows) : SYSTEM = S-1-5-18, Administrateurs = S-1-5-32-544.
    let out = Command::new(system32("icacls.exe"))
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(format!("{me}:(F)"))
        .args(["/grant:r", "*S-1-5-18:(F)", "/grant:r", "*S-1-5-32-544:(F)"])
        .output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("icacls : {}", String::from_utf8_lossy(&out.stdout).trim())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dossiers_par_defaut_valides() {
        for r in default_watch_roots().split(',') {
            assert!(is_root_path(r), "dossier par défaut refusé par sa propre validation : {r}");
        }
        assert!(default_data_dir().is_absolute());
    }

    #[test]
    fn dossier_surveille_hostile_refuse() {
        for p in [r"\\serveur\partage", r"C:\a\..\b", r"C:\x:flux", r"C:\CON", "/etc", "relatif"] {
            assert!(!is_root_path(p), "{p}");
        }
    }

    /// L'identité ne doit être lisible ni par « Users », ni par « Everyone », ni par « Authenticated Users ».
    #[test]
    fn identite_protegee_par_acl() {
        let dir = std::env::temp_dir().join(format!("corvus-acl-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("identity.json");
        std::fs::write(&f, b"secret").unwrap();
        harden_secret(&f).expect("icacls doit réussir sur un fichier à nous");
        let out = Command::new(system32("icacls.exe")).arg(&f).output().unwrap();
        let acl = String::from_utf8_lossy(&out.stdout).to_lowercase();
        for banned in ["everyone", "authenticated users", "builtin\\users", "utilisateurs authentifiés", "tout le monde"] {
            assert!(!acl.contains(banned), "ACL trop large ({banned}) : {acl}");
        }
        // Indépendant de la langue de Windows : exactement trois entrées (SYSTEM, Administrateurs, propriétaire), toutes en contrôle total.
        assert_eq!(acl.matches(":(f)").count(), 3, "ACL attendue : SYSTEM, Administrateurs et propriétaire seulement : {acl}");
        // Le propriétaire (nous) lit toujours.
        assert_eq!(std::fs::read(&f).unwrap(), b"secret");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
