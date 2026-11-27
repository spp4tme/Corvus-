//! Ce que Windows et macOS partagent : les mêmes remplacements, et les mêmes absences.
//!
//! Absences assumées (annoncées comme telles dans les capacités, donc grisées dans l'interface) :
//!  - pas de connecteur noyau (fanotify, évènements `exec`) : l'écrivain exact d'un fichier est inconnu, les processus de moins
//!    de 2 s ne sont pas vus ;
//!  - pas de surveillance des ports en écoute, des services ni des paquets ;
//!  - pas de connexions réseau par processus, pas d'actions de fichiers (restaurer, supprimer), pas de gel/arrêt de processus,
//!    pas d'isolement réseau, pas de prévisualisation : seule la lecture (`xray.live`) existe.

use std::path::PathBuf;
use std::sync::mpsc::sync_channel;

use super::FsWatch;

/// Remplace `fanotify` / connecteur de processus : rien n'arrive jamais, le canal est déconnecté.
pub mod kernel {
    use crate::xray::Proc;
    use std::path::PathBuf;
    use std::sync::mpsc::{sync_channel, Receiver};

    /// Un fichier fermé après écriture, avec son auteur (jamais produit hors Linux).
    #[allow(dead_code)]
    pub struct WriteEv {
        pub path: String,
        pub proc: Proc,
    }

    #[allow(dead_code)]
    pub enum KernelEvent {
        Exec(Proc),
        Write(WriteEv),
    }

    pub struct Sources {
        pub rx: Receiver<KernelEvent>,
        pub exec: bool,
        pub fanotify: bool,
    }

    pub fn start(_roots: &[PathBuf]) -> Sources {
        let (_tx, rx) = sync_channel(1); // l'émetteur est jeté : `try_recv` répond « déconnecté », sans jamais rien livrer
        Sources { rx, exec: false, fanotify: false }
    }
}

/// Ports, services, paquets : propres à /proc, systemd et dpkg. Ici : aucun évènement.
pub mod sys {
    use crate::state::State;
    use serde_json::Value;

    pub struct Event {
        pub kind: &'static str,
        pub body: Value,
    }

    pub fn systemd_available() -> bool {
        false
    }
    pub fn check_ports(_state: &State) -> Vec<Event> {
        vec![]
    }
    pub fn check_services(_state: &State) -> Vec<Event> {
        vec![]
    }
    pub fn check_packages(_state: &State) -> Vec<Event> {
        vec![]
    }
}

/// La prévisualisation repose sur les espaces de noms Linux : elle n'existe pas ici.
pub mod preview {
    pub fn available() -> bool {
        false
    }
}

/// Actions nommées : seule la LECTURE (`xray.live`) existe. Aucune écriture, aucun signal, aucune règle réseau.
pub mod actions {
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};

    #[allow(dead_code)]
    pub struct Context<'a> {
        pub roots: &'a [PathBuf],
        pub agent_dir: &'a Path,
        pub allow_preview: bool,
    }

    pub fn names(_allow_preview: bool) -> Vec<&'static str> {
        vec!["xray.live"]
    }

    pub fn run(_ctx: &Context, name: &str, _args: &Value) -> Result<Value, String> {
        match name {
            "xray.live" => Ok(xray_live()),
            other => Err(format!("action non disponible sur cette plateforme : {other}")),
        }
    }

    /// Instantané des processus (sans connexions : non fournies hors Linux).
    fn xray_live() -> Value {
        let all = crate::xray::read_all();
        let mut procs: Vec<&crate::xray::Proc> = all.values().collect();
        procs.sort_by_key(|p| p.pid);
        let list: Vec<Value> = procs.iter().take(800).map(|p| json!({
            "pid": p.pid, "ppid": p.ppid, "uid": p.uid, "start": p.start, "comm": p.comm, "exe": p.exe, "cmd": p.cmd,
            "ssh": Value::Null,
        })).collect();
        json!({ "processes": list, "connections": [] })
    }
}

/// Métriques par `sysinfo` : mêmes noms que sous Linux (`cpu`, `mem`, `swap`, `df:<disque>`), plus `uptime` (secondes) et
/// `net:rx` / `net:tx` (octets par seconde, toutes interfaces). `load1` seulement sous macOS (Windows n'a pas de charge moyenne).
pub mod metrics {
    use std::collections::{BTreeMap, HashSet};
    use std::path::Path;
    use std::time::Instant;
    use sysinfo::{Disks, Networks, System};

    #[derive(Default)]
    pub struct Sampler {
        sys: Option<System>,
        nets: Option<Networks>,
        last: Option<Instant>,
    }

    fn pct(used: u64, total: u64) -> f64 {
        ((used as f64 / total as f64) * 1000.0).round() / 10.0
    }

    /// « C:\ » → « C: », « /System/Volumes/Data » inchangé : le serveur n'accepte que `A-Za-z0-9_.:/-` dans un nom de mesure.
    pub fn mount_label(p: &Path) -> String {
        let s = p.to_string_lossy().replace('\\', "/");
        let t = if s.len() > 1 { s.trim_end_matches('/') } else { s.as_str() };
        let t = if t.is_empty() { "/" } else { t };
        t.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '/' | '-') { c } else { '_' }).collect()
    }

    impl Sampler {
        pub fn sample(&mut self) -> BTreeMap<String, f64> {
            let mut out = BTreeMap::new();
            let now = Instant::now();
            let first = self.last.is_none(); // le CPU et le débit sont des différences entre deux relevés
            let elapsed = self.last.map(|t| now.duration_since(t).as_secs_f64());

            if self.sys.is_none() {
                self.sys = System::new().ok();
            }
            if let Some(sys) = self.sys.as_mut() {
                sys.refresh_cpu_usage();
                sys.refresh_memory();
                if !first {
                    out.insert("cpu".to_string(), (f64::from(sys.global_cpu_usage()) * 10.0).round() / 10.0);
                }
                if sys.total_memory() > 0 {
                    out.insert("mem".to_string(), pct(sys.used_memory(), sys.total_memory()));
                }
                if sys.total_swap() > 0 {
                    out.insert("swap".to_string(), pct(sys.used_swap(), sys.total_swap()));
                }
            }
            if let Ok(up) = System::uptime() {
                out.insert("uptime".to_string(), up as f64);
            }
            if cfg!(target_os = "macos") {
                if let Ok(load) = System::load_average() {
                    out.insert("load1".to_string(), load.one);
                }
            }

            if let Ok(disks) = Disks::new_with_refreshed_list() {
                let mut seen = HashSet::new();
                for d in disks.iter() {
                    let total = d.total_space();
                    let label = mount_label(d.mount_point());
                    // macOS expose de nombreux volumes techniques (/System/Volumes/VM, Preboot…) : on garde « / » et les données.
                    let technical = cfg!(target_os = "macos") && label.starts_with("/System/Volumes/") && label != "/System/Volumes/Data";
                    if total == 0 || technical || !seen.insert(label.clone()) {
                        continue;
                    }
                    out.insert(format!("df:{label}"), pct(total.saturating_sub(d.available_space()), total));
                }
            }

            if self.nets.is_none() {
                self.nets = Networks::new_with_refreshed_list().ok();
            } else if let Some(n) = self.nets.as_mut() {
                n.refresh(true);
            }
            if let (Some(n), Some(dt)) = (self.nets.as_ref(), elapsed) {
                if dt > 0.0 {
                    let (mut rx, mut tx) = (0u64, 0u64);
                    for data in n.values() {
                        rx += data.received();
                        tx += data.transmitted();
                    }
                    out.insert("net:rx".to_string(), (rx as f64 / dt).round());
                    out.insert("net:tx".to_string(), (tx as f64 / dt).round());
                }
            }
            self.last = Some(now);
            out
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn etiquette_de_disque_acceptee_par_le_serveur() {
            assert_eq!(mount_label(Path::new(r"C:\")), "C:");
            assert_eq!(mount_label(Path::new("C:/")), "C:");
            assert_eq!(mount_label(Path::new("/")), "/");
            assert_eq!(mount_label(Path::new("/System/Volumes/Data")), "/System/Volumes/Data");
            assert_eq!(mount_label(Path::new("/Volumes/Mon disque")), "/Volumes/Mon_disque");
            for p in [r"C:\", "/", "/Volumes/Mon disque (2)", r"D:\Données"] {
                let l = mount_label(Path::new(p));
                assert!(l.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '/' | '-')), "{l}");
            }
        }

        #[test]
        fn les_releves_ont_les_noms_attendus() {
            let mut s = Sampler::default();
            let first = s.sample();
            assert!(!first.contains_key("cpu"), "premier relevé : pas de différence possible");
            assert!(first.contains_key("mem"), "mémoire : {first:?}");
            assert!(first.contains_key("uptime"), "uptime : {first:?}");
            assert!(first.keys().any(|k| k.starts_with("df:")), "au moins un disque : {first:?}");
            std::thread::sleep(std::time::Duration::from_millis(300));
            let second = s.sample();
            let cpu = second.get("cpu").copied();
            assert!(cpu.is_some_and(|c| (0.0..=100.0).contains(&c)), "cpu : {second:?}");
            for k in ["mem", "uptime"] {
                assert!(second[k] >= 0.0, "{k}");
            }
            assert!(second["mem"] <= 100.0);
            assert!(second.contains_key("net:rx") && second.contains_key("net:tx"), "réseau : {second:?}");
            for k in second.keys() {
                assert!(k.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '/' | '-')), "nom de mesure refusé par le serveur : {k}");
            }
        }
    }
}

/// Liste des processus par `sysinfo`. `uid` vaut `u32::MAX` (« non fourni ») : sysinfo n'expose pas d'identifiant numérique
/// portable (Windows a des SID, pas d'uid). Un processus dont l'exécutable est illisible (accès refusé) garde son nom comme `exe`.
pub mod procs {
    use crate::xray::Proc;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    thread_local! {
        // Un seul `System` réutilisé (le recréer à chaque relevé est coûteux) ; la boucle de l'agent n'a qu'un fil.
        static SYS: RefCell<Option<System>> = const { RefCell::new(None) };
    }

    pub fn read_all() -> HashMap<u32, Proc> {
        SYS.with(|cell| {
            let mut slot = cell.borrow_mut();
            if slot.is_none() {
                *slot = System::new().ok();
            }
            let Some(sys) = slot.as_mut() else { return HashMap::new() };
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet).with_cmd(UpdateKind::OnlyIfNotSet),
            );
            let mut out = HashMap::new();
            for (pid, p) in sys.processes() {
                let pid = pid.as_u32();
                let name = p.name().to_string_lossy().into_owned();
                let exe = p.exe().map(|x| x.to_string_lossy().into_owned()).filter(|x| !x.is_empty()).unwrap_or_else(|| name.clone());
                let cmd: String = p.cmd().iter().map(|a| a.to_string_lossy()).collect::<Vec<_>>().join(" ").chars().take(200).collect();
                out.insert(pid, Proc { pid, ppid: p.parent().map(|x| x.as_u32()).unwrap_or(0), uid: u32::MAX, start: p.start_time(), comm: name, exe, cmd });
            }
            out
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn l_agent_se_voit_lui_meme() {
            let all = read_all();
            let me = all.get(&std::process::id()).expect("le processus de test doit figurer dans la liste");
            assert!(!me.exe.is_empty() && !me.comm.is_empty());
            assert_eq!(me.uid, u32::MAX);
            assert!(all.len() > 3, "au moins quelques processus : {}", all.len());
        }
    }
}

/// Surveillance par évènements du système (ReadDirectoryChangesW sous Windows, FSEvents sous macOS) via `notify`.
/// Elle ne remplace pas le balayage : elle le déclenche tout de suite. Un dossier illisible est signalé, pas fatal.
pub fn fs_events(roots: &[PathBuf]) -> FsWatch {
    use notify::{RecursiveMode, Watcher};
    let (tx, rx) = sync_channel::<()>(1);
    let handler = move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let _ = tx.try_send(()); // plein = un balayage est déjà demandé
        }
    };
    let mut watcher = match notify::recommended_watcher(handler) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("surveillance par évènements indisponible ({e}) : balayage régulier seulement");
            return FsWatch::inactive();
        }
    };
    let mut any = false;
    for r in roots {
        match watcher.watch(r, RecursiveMode::Recursive) {
            Ok(()) => any = true,
            Err(e) => eprintln!("surveillance de {} impossible : {e}", r.display()),
        }
    }
    FsWatch::with_guard(rx, any, Box::new(watcher))
}
