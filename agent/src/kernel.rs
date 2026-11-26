//! Sources « noyau » (étape 7, sans eBPF) : deux fils qui lisent le noyau en continu et envoient leurs
//! observations à la boucle principale par un canal.
//!
//!  - **fanotify** : dit EXACTEMENT quel processus vient de fermer un fichier après y avoir écrit
//!    (attribution exacte, même si le processus est mort entre-temps) et déclenche un balayage immédiat.
//!    Demande CAP_SYS_ADMIN.
//!  - **connecteur de processus (netlink)** : prévient à chaque `exec`, donc avant le sondage de 2 s de /proc ;
//!    un processus de moins de 2 s est vu. Demande CAP_NET_ADMIN (et AF_NETLINK dans l'unité systemd).
//!
//! Si le noyau ou les droits manquent, la source est simplement absente et l'agent retombe sur le balayage
//! et le sondage de /proc (comportement des versions précédentes). Limite honnête : le fil lit /proc juste
//! après l'événement ; un processus qui meurt en moins d'une milliseconde peut encore passer entre les mailles.
//! eBPF ferait mieux, mais exige Rust nightly et `bpf-linker` (hors du parti pris « simple et statique »).

use crate::xray::{read_proc, Proc};
use std::path::PathBuf;
use std::sync::mpsc::{sync_channel, Receiver};
use std::thread;

/// Un fichier fermé après écriture, avec son auteur.
pub struct WriteEv {
    pub path: String,
    pub proc: Proc,
}

pub enum KernelEvent {
    Exec(Proc),
    Write(WriteEv),
}

pub struct Sources {
    pub rx: Receiver<KernelEvent>,
    pub exec: bool,
    pub fanotify: bool,
}

/// Systèmes de fichiers « réels » dont on surveille les lancements de programmes.
const REAL_FS: [&str; 9] = ["ext4", "ext3", "ext2", "xfs", "btrfs", "f2fs", "vfat", "overlay", "zfs"];

/// Points de montage des systèmes de fichiers réels, lus dans /proc/self/mountinfo.
/// Ligne : « id parent maj:min racine point-de-montage options… - type source options ».
pub fn real_mounts(mountinfo: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in mountinfo.lines() {
        let Some((before, after)) = line.split_once(" - ") else { continue };
        let fstype = after.split_whitespace().next().unwrap_or("");
        let Some(mp) = before.split_whitespace().nth(4) else { continue };
        if REAL_FS.contains(&fstype) && !out.iter().any(|m: &String| m == mp) {
            out.push(mp.replace("\\040", " "));
        }
    }
    out
}

pub fn start(roots: &[PathBuf]) -> Sources {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let (tx, rx) = sync_channel(4000); // plein : on jette (mieux vaut perdre un événement que bloquer le noyau)
    let none = |rx| Sources { rx, exec: false, fanotify: false };
    // SAFETY : appels système avec des chemins CString valides ; le descripteur est fermé si rien n'a pu être marqué.
    let fd = unsafe { libc::fanotify_init(libc::FAN_CLASS_NOTIF | libc::FAN_CLOEXEC, (libc::O_RDONLY | libc::O_LARGEFILE) as u32) };
    if fd < 0 { return none(rx); }
    let mark = |path: &[u8], mask: u64| -> bool {
        let Ok(c) = CString::new(path) else { return false };
        // On marque le POINT DE MONTAGE (fanotify ne suit pas un dossier récursivement) ; les événements des autres
        // dossiers du même montage sont écartés plus bas.
        unsafe { libc::fanotify_mark(fd, libc::FAN_MARK_ADD | libc::FAN_MARK_MOUNT, mask, libc::AT_FDCWD, c.as_ptr()) == 0 }
    };
    let mut watching = false;
    for r in roots { watching |= mark(r.as_os_str().as_bytes(), libc::FAN_CLOSE_WRITE); }
    let mut exec = false;
    for mp in real_mounts(&std::fs::read_to_string("/proc/self/mountinfo").unwrap_or_default()) { exec |= mark(mp.as_bytes(), libc::FAN_OPEN_EXEC); }
    if !watching && !exec { unsafe { libc::close(fd); } return none(rx); }

    let prefixes: Vec<String> = roots.iter().map(|r| r.to_string_lossy().into_owned()).collect();
    let me = std::process::id();
    thread::spawn(move || {
        let mut buf = vec![0u8; 32 * 1024];
        let meta = std::mem::size_of::<libc::fanotify_event_metadata>();
        loop {
            // SAFETY : `buf` est un tampon local de la taille annoncée.
            let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
            if n < 0 {
                if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) { continue; }
                break;
            }
            let mut off = 0usize;
            while off + meta <= n as usize {
                // SAFETY : on vient de vérifier qu'une structure complète tient dans le tampon ; lecture non alignée.
                let ev: libc::fanotify_event_metadata = unsafe { std::ptr::read_unaligned(buf.as_ptr().add(off).cast()) };
                if (ev.event_len as usize) < meta { break; }
                if ev.vers != libc::FANOTIFY_METADATA_VERSION { return; }
                if ev.fd >= 0 {
                    let path = std::fs::read_link(format!("/proc/self/fd/{}", ev.fd)).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
                    unsafe { libc::close(ev.fd); } // chaque événement apporte un descripteur à fermer
                    let pid = ev.pid as u32;
                    if ev.mask & libc::FAN_OPEN_EXEC != 0 && !path.is_empty() {
                        if let Some(mut p) = read_proc(pid) {
                            // À ce stade le processus n'a pas encore changé d'image : on lui donne le programme qui démarre.
                            p.comm = path.rsplit('/').next().unwrap_or("").chars().take(15).collect();
                            p.exe = path.clone();
                            p.cmd = path.clone();
                            let _ = tx.try_send(KernelEvent::Exec(p));
                        }
                    }
                    if ev.mask & libc::FAN_CLOSE_WRITE != 0 && pid != me && prefixes.iter().any(|p| path.starts_with(p.as_str())) {
                        if let Some(proc) = read_proc(pid) { let _ = tx.try_send(KernelEvent::Write(WriteEv { path, proc })); }
                    }
                }
                off += ev.event_len as usize;
            }
        }
    });
    Sources { rx, exec, fanotify: watching }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn montages_reels_seulement() {
        let info = "26 1 179:2 / / rw,relatime shared:1 - ext4 /dev/mmcblk0p2 rw\n\
                    30 26 0:6 / /proc rw - proc proc rw\n\
                    40 26 179:1 / /boot/firmware rw - vfat /dev/mmcblk0p1 rw\n\
                    41 26 8:1 / /mnt/ssd\\040test rw - ext4 /dev/sda1 rw\n\
                    42 26 0:30 / /run rw - tmpfs tmpfs rw\n\
                    43 26 179:2 / / rw - ext4 /dev/mmcblk0p2 rw";
        assert_eq!(real_mounts(info), vec!["/", "/boot/firmware", "/mnt/ssd test"]);
        assert!(real_mounts("").is_empty());
        assert!(real_mounts("ligne sans séparateur").is_empty());
    }
}
