//! Relevés lus dans /proc et /sys (Linux). Mêmes noms que le backend Corvus (`cpu`, `mem`, …)
//! pour réutiliser ses graphiques tels quels.

use std::collections::BTreeMap;
use std::fs;

#[derive(Default)]
pub struct Sampler {
    /// (total, inactif) au relevé précédent : le CPU est une différence entre deux relevés.
    last_cpu: Option<(u64, u64)>,
}

fn read(path: &str) -> Option<String> {
    fs::read_to_string(path).ok()
}

/// Lit une valeur « Clé:   123 kB » dans /proc/meminfo.
fn meminfo(text: &str, key: &str) -> Option<f64> {
    text.lines()
        .find_map(|l| l.strip_prefix(key)?.strip_prefix(':')?.split_whitespace().next()?.parse::<f64>().ok())
}

impl Sampler {
    pub fn sample(&mut self) -> BTreeMap<String, f64> {
        let mut out = BTreeMap::new();

        if let Some(stat) = read("/proc/stat") {
            if let Some(line) = stat.lines().next() {
                let n: Vec<u64> = line.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
                if n.len() >= 5 {
                    let total: u64 = n.iter().take(8).sum();
                    let idle = n[3] + n[4]; // idle + iowait
                    if let Some((pt, pi)) = self.last_cpu {
                        let dt = total.saturating_sub(pt);
                        if dt > 0 {
                            let busy = dt.saturating_sub(idle.saturating_sub(pi));
                            out.insert("cpu".into(), (busy as f64 / dt as f64 * 1000.0).round() / 10.0);
                        }
                    }
                    self.last_cpu = Some((total, idle));
                }
            }
        }
        if let Some(m) = read("/proc/meminfo") {
            if let (Some(total), Some(avail)) = (meminfo(&m, "MemTotal"), meminfo(&m, "MemAvailable")) {
                if total > 0.0 {
                    out.insert("mem".into(), ((total - avail) / total * 1000.0).round() / 10.0);
                }
            }
            if let (Some(total), Some(free)) = (meminfo(&m, "SwapTotal"), meminfo(&m, "SwapFree")) {
                if total > 0.0 {
                    out.insert("swap".into(), ((total - free) / total * 1000.0).round() / 10.0);
                }
            }
        }
        if let Some(l) = read("/proc/loadavg") {
            if let Some(v) = l.split_whitespace().next().and_then(|x| x.parse::<f64>().ok()) {
                out.insert("load1".into(), v);
            }
        }
        if let Some(t) = read("/sys/class/thermal/thermal_zone0/temp") {
            if let Ok(milli) = t.trim().parse::<f64>() {
                out.insert("temp".into(), milli / 1000.0);
            }
        }
        for (mount, pct) in disks() {
            out.insert(format!("df:{mount}"), pct);
        }
        out
    }
}

/// Systèmes de fichiers « réels » (disques), pour ne pas compter /proc, /sys, tmpfs, etc.
const REAL_FS: [&str; 7] = ["ext4", "ext3", "xfs", "btrfs", "f2fs", "vfat", "zfs"];

/// (point de montage, % utilisé) pour chaque disque, en lisant /proc/mounts puis statvfs.
fn disks() -> Vec<(String, f64)> {
    let mounts = read("/proc/mounts").unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for line in mounts.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        // « overlay » (racine d'un conteneur, d'un bac à sable) : retenu seulement pour « / »,
        // sinon on compterait les couches de chaque conteneur Docker de l'hôte.
        if f.len() < 3 {
            continue;
        }
        let est_disque = REAL_FS.contains(&f[2]) || (f[2] == "overlay" && f[1] == "/");
        if !est_disque || !seen.insert(f[0].to_string()) {
            continue;
        }
        let mount = f[1].replace("\\040", " "); // /proc/mounts écrit l'espace « \040 »
        if let Some(p) = used_percent(&mount) {
            out.push((mount, p));
        }
    }
    out
}

fn used_percent(path: &str) -> Option<f64> {
    let c = std::ffi::CString::new(path).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY : `c` est une chaîne C valide, `st` une structure vide que statvfs remplit.
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 || st.f_blocks == 0 {
        return None;
    }
    let total = st.f_blocks as f64;
    let avail = st.f_bavail as f64;
    Some(((total - avail) / total * 1000.0).round() / 10.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meminfo_lit_une_cle() {
        let t = "MemTotal:        1000 kB\nMemAvailable:     250 kB\n";
        assert_eq!(meminfo(t, "MemTotal"), Some(1000.0));
        assert_eq!(meminfo(t, "MemAvailable"), Some(250.0));
        assert_eq!(meminfo(t, "Absent"), None);
    }

    #[test]
    fn le_cpu_demande_deux_releves() {
        let mut s = Sampler::default();
        assert!(!s.sample().contains_key("cpu"), "premier relevé : pas de différence possible");
        std::thread::sleep(std::time::Duration::from_millis(50));
        let v = s.sample();
        if let Some(c) = v.get("cpu") {
            assert!((0.0..=100.0).contains(c));
        }
        assert!(v.contains_key("mem"));
        assert!(v.keys().any(|k| k == "df:/"), "le disque racine doit être relevé : {v:?}");
    }
}
