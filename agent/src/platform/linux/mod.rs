//! Linux : /proc, /sys, fanotify, systemd, nftables. Le comportement est celui des versions 1.0 et 1.1, sans changement :
//! `kernel`, `metrics` et `sys` sont les anciens modules du même nom, déplacés ici.

pub mod kernel;
pub mod metrics;
pub mod sys;

use super::FsWatch;
use std::path::{Path, PathBuf};

pub const NAME: &str = "linux";
/// Sous Linux la réactivité vient de fanotify (si l'agent a les droits) puis du balayage : pas de moniteur `notify`.
pub const FSNOTIFY: bool = false;

pub fn default_data_dir() -> PathBuf {
    PathBuf::from("/var/lib/corvus-agent")
}

pub fn default_watch_roots() -> String {
    "/etc,/var/spool/cron".into()
}

pub fn is_root_path(p: &str) -> bool {
    p.starts_with('/')
}

pub fn hostname() -> String {
    std::fs::read_to_string("/etc/hostname").unwrap_or_default().trim().to_string()
}

pub fn harden_secret(path: &Path) -> std::io::Result<()> {
    super::restrict_to_owner(path)
}

pub fn is_secret_extra(_path: &str) -> bool {
    false
}

pub fn fs_events(_roots: &[PathBuf]) -> FsWatch {
    FsWatch::inactive()
}
