//! macOS — **EXPÉRIMENTAL** : écrit et testé par la CI sur un runner macOS, mais jamais essayé sur un Mac réel de l'utilisateur.
//! Métriques et processus par `sysinfo` (qui s'appuie sur `sysctl`/`libproc`), surveillance par FSEvents (via `notify`),
//! exécution en LaunchDaemon (voir `deploy/agent/com.corvus.agent.plist` et `install.sh`).

use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const NAME: &str = "macos";
pub const FSNOTIFY: bool = true;

pub fn default_data_dir() -> PathBuf {
    PathBuf::from("/Library/Application Support/CorvusAgent")
}

/// `/etc` est un LIEN SYMBOLIQUE vers `/private/etc` : le balayage ignore les liens, on surveille donc la cible réelle.
pub fn default_watch_roots() -> String {
    "/private/etc,/Library/LaunchDaemons,/Library/LaunchAgents".into()
}

pub fn is_root_path(p: &str) -> bool {
    super::pathcheck::posix_path_error(p).is_none()
}

pub fn hostname() -> String {
    Command::new("hostname").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

pub fn is_secret_extra(path: &str) -> bool {
    super::pathcheck::macos_is_secret(path)
}

pub fn harden_secret(path: &Path) -> io::Result<()> {
    super::restrict_to_owner(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dossiers_par_defaut_valides() {
        for r in default_watch_roots().split(',') {
            assert!(is_root_path(r), "{r}");
        }
        assert!(default_data_dir().is_absolute());
    }

    #[test]
    fn identite_en_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("corvus-mac-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("identity.json");
        std::fs::write(&f, b"x").unwrap();
        harden_secret(&f).unwrap();
        assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
