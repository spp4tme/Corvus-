//! Changements « système » qui ne sont pas des fichiers surveillés : ports en écoute, services
//! systemd, paquets installés (journal dpkg). Chaque détecteur compare l'état actuel à celui
//! mémorisé dans la table `kv` et produit des événements.

use crate::state::State;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::process::Command;

pub struct Event {
    pub kind: &'static str,
    pub body: Value,
}

fn load_set(state: &State, key: &str) -> Option<BTreeSet<String>> {
    serde_json::from_str(&state.get(key)?).ok()
}
fn save_set(state: &State, key: &str, set: &BTreeSet<String>) {
    let _ = state.set(key, &serde_json::to_string(set).unwrap_or_default());
}

/// Compare `now` à l'ensemble mémorisé : instantané la première fois, ouvertures/fermetures ensuite.
fn diff_events(state: &State, key: &str, now: BTreeSet<String>, snapshot_kind: &'static str, added: &'static str, removed: &'static str) -> Vec<Event> {
    let mut out = Vec::new();
    match load_set(state, key) {
        None => out.push(Event { kind: snapshot_kind, body: json!({ "items": now }) }),
        Some(before) => {
            for x in now.difference(&before) { out.push(Event { kind: added, body: json!({ "item": x }) }); }
            for x in before.difference(&now) { out.push(Event { kind: removed, body: json!({ "item": x }) }); }
        }
    }
    save_set(state, key, &now);
    out
}

// --- Ports en écoute ------------------------------------------------------------------------------

/// Décode une ligne de /proc/net/tcp : « 0100007F:1F90 » → « 127.0.0.1:8080 » (IPv4) ou « [..]:port ».
fn decode_addr(hex: &str, v6: bool) -> Option<String> {
    let (ip, port) = hex.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    if v6 {
        if ip.len() != 32 { return None; }
        let all_zero = ip.bytes().all(|b| b == b'0');
        let loop6 = ip == "00000000000000000000000001000000";
        return Some(format!("{}:{port}", if all_zero { "[::]" } else if loop6 { "[::1]" } else { "[v6]" }));
    }
    let n = u32::from_str_radix(ip, 16).ok()?.to_le_bytes();
    Some(format!("{}.{}.{}.{}:{port}", n[0], n[1], n[2], n[3]))
}

pub fn listening_ports() -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for (file, v6, proto) in [("/proc/net/tcp", false, "tcp"), ("/proc/net/tcp6", true, "tcp6")] {
        let Ok(text) = fs::read_to_string(file) else { continue };
        for line in text.lines().skip(1) {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() > 3 && f[3] == "0A" {
                if let Some(a) = decode_addr(f[1], v6) { out.insert(format!("{proto} {a}")); }
            }
        }
    }
    out
}

pub fn check_ports(state: &State) -> Vec<Event> {
    diff_events(state, "ports", listening_ports(), "port.snapshot", "port.open", "port.close")
}

// --- Services systemd -----------------------------------------------------------------------------

pub fn parse_unit_files(text: &str) -> BTreeSet<String> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let (name, st) = (it.next()?, it.next()?);
            name.ends_with(".service").then(|| format!("{name} {st}"))
        })
        .collect()
}

pub fn systemd_available() -> bool {
    std::path::Path::new("/run/systemd/system").exists()
}

pub fn check_services(state: &State) -> Vec<Event> {
    if !systemd_available() { return vec![]; }
    let Ok(out) = Command::new("systemctl").args(["list-unit-files", "--type=service", "--no-legend", "--no-pager"]).output() else { return vec![] };
    if !out.status.success() { return vec![]; }
    diff_events(state, "services", parse_unit_files(&String::from_utf8_lossy(&out.stdout)), "service.snapshot", "service.changed", "service.gone")
}

// --- Paquets (journal dpkg) -------------------------------------------------------------------------

/// « 2025-01-02 10:00:00 upgrade nginx:arm64 1.0 1.1 » → événement ; les autres lignes sont ignorées.
pub fn parse_dpkg_line(line: &str) -> Option<Event> {
    let f: Vec<&str> = line.split_whitespace().collect();
    if f.len() < 5 || !matches!(f[2], "install" | "upgrade" | "remove" | "purge") { return None; }
    Some(Event { kind: "pkg.change", body: json!({ "action": f[2], "name": f[3], "from": f[4], "to": f.get(5).copied().unwrap_or(""), "at": format!("{} {}", f[0], f[1]) }) })
}

pub fn check_packages(state: &State) -> Vec<Event> {
    const LOG: &str = "/var/log/dpkg.log";
    let Ok(meta) = fs::metadata(LOG) else { return vec![] };
    let size = meta.len();
    let key = "dpkg.offset";
    let offset: u64 = state.get(key).and_then(|v| v.parse().ok()).unwrap_or(size); // premier passage : on ne rejoue pas l'historique
    let start = if offset > size { 0 } else { offset }; // journal tourné
    let mut out = Vec::new();
    if let Ok(data) = fs::read(LOG) {
        let from = (start as usize).min(data.len());
        for line in String::from_utf8_lossy(&data[from..]).lines() {
            if let Some(e) = parse_dpkg_line(line) { out.push(e); }
        }
    }
    let _ = state.set(key, &size.to_string());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adresse_ipv4_et_port() {
        assert_eq!(decode_addr("0100007F:1F90", false).unwrap(), "127.0.0.1:8080");
        assert_eq!(decode_addr("00000000:0016", false).unwrap(), "0.0.0.0:22");
        assert_eq!(decode_addr("00000000000000000000000000000000:0016", true).unwrap(), "[::]:22");
    }

    #[test]
    fn unites_systemd() {
        let t = "ssh.service  enabled  enabled\ncron.service enabled enabled\nfoo.timer enabled enabled\n";
        let s = parse_unit_files(t);
        assert!(s.contains("ssh.service enabled") && s.contains("cron.service enabled"));
        assert_eq!(s.len(), 2, "seules les unités .service comptent");
    }

    #[test]
    fn journal_dpkg() {
        let e = parse_dpkg_line("2025-01-02 10:00:00 upgrade nginx:arm64 1.0 1.1").unwrap();
        assert_eq!(e.body["action"], "upgrade");
        assert_eq!(e.body["to"], "1.1");
        assert!(parse_dpkg_line("2025-01-02 10:00:00 status installed nginx:arm64 1.1").is_none());
    }

    #[test]
    fn instantane_puis_differences() {
        let d = std::env::temp_dir().join(format!("corvus-sys-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&d).unwrap();
        let st = State::open(&d.join("s.db")).unwrap();
        let a: BTreeSet<String> = ["tcp 0.0.0.0:22".to_string()].into();
        let e = diff_events(&st, "k", a.clone(), "snap", "open", "close");
        assert_eq!(e[0].kind, "snap");
        let mut b = a.clone();
        b.insert("tcp 0.0.0.0:80".into());
        let e = diff_events(&st, "k", b, "snap", "open", "close");
        assert_eq!((e.len(), e[0].kind), (1, "open"));
        let e = diff_events(&st, "k", a, "snap", "open", "close");
        assert_eq!((e.len(), e[0].kind), (1, "close"));
    }
}
