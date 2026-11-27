//! Tout ce qui est propre à un système d'exploitation, derrière une seule porte : le reste de l'agent (protocole, tampon,
//! détection d'entropie, boucle principale…) est le même partout.
//!
//! - `linux/`   : /proc, fanotify, systemd, nftables (inchangé depuis 1.1) ;
//! - `windows/` : métriques et processus (sysinfo), surveillance par `ReadDirectoryChangesW` (notify), service Windows, ACL ;
//! - `macos/`   : métriques et processus (sysinfo), surveillance par FSEvents (notify). **Expérimental** : aucune machine réelle ne l'a validé ;
//! - `portable` : ce que Windows et macOS partagent (mêmes remplacements, mêmes absences).
//!
//! Chaque système exporte les mêmes noms (voir la fin de ce fichier pour la liste) ; ce que le système ne sait pas faire est
//! simplement absent des *capacités* annoncées à Corvus, qui grise alors la fonction dans l'interface.

pub mod pathcheck;

#[cfg(unix)]
use std::path::Path;
use std::sync::mpsc::{sync_channel, Receiver};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(not(target_os = "linux"))]
mod portable;
#[cfg(not(target_os = "linux"))]
pub use portable::{actions, fs_events, kernel, metrics, preview, procs, sys};

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
compile_error!("corvus-agent ne gère que Linux, Windows et macOS");

/// Surveillance de fichiers par évènements du système. Elle ne remplace PAS le balayage (qui reste la source de vérité :
/// date, taille, empreinte) : elle le déclenche tout de suite au lieu d'attendre le prochain tour.
pub struct FsWatch {
    /// Un signal par rafale d'évènements (capacité 1 : le trop-plein est jeté, un balayage suffit).
    pub rx: Receiver<()>,
    /// Vrai si au moins un dossier est réellement surveillé par le système.
    pub active: bool,
    _guard: Option<Box<dyn std::any::Any>>,
}

impl FsWatch {
    /// Pas de surveillance par évènements : le canal est déconnecté, il ne signalera jamais rien.
    pub fn inactive() -> Self {
        let (_tx, rx) = sync_channel(1);
        FsWatch { rx, active: false, _guard: None }
    }

    /// `guard` garde le moniteur du système en vie (le fermer arrête la surveillance).
    #[cfg(not(target_os = "linux"))]
    pub fn with_guard(rx: Receiver<()>, active: bool, guard: Box<dyn std::any::Any>) -> Self {
        FsWatch { rx, active, _guard: Some(guard) }
    }
}

/// Droits 0600 : le propriétaire seul lit et écrit (identité de l'agent). Linux et macOS.
#[cfg(unix)]
pub fn restrict_to_owner(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

// Ce que chaque système exporte (mêmes noms, mêmes types) :
//   const NAME: &str                     « linux » | « windows » | « macos » (annoncé à Corvus : informatif)
//   const FSNOTIFY: bool                 surveillance par évènements du système disponible (annoncée : `fsnotify`)
//   fn default_data_dir() -> PathBuf     dossier des données de l'agent (identité, tampon)
//   fn default_watch_roots() -> String   dossiers surveillés par défaut, séparés par des virgules
//   fn is_root_path(&str) -> bool        chemin acceptable comme dossier surveillé (validé pour CE système)
//   fn hostname() -> String
//   fn harden_secret(&Path) -> io::Result<()>   fichier secret réservé à son propriétaire (0600 / ACL)
//   fn is_secret_extra(&str) -> bool     fichiers secrets propres au système (leur contenu n'est jamais copié)
//   mod kernel, metrics, sys, preview, actions, procs (Windows/macOS) ; fn fs_events(&[PathBuf]) -> FsWatch
