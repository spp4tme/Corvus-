//! Radiographie de l'hôte (étape 7.1) : processus, connexions réseau et « lignée » (qui a lancé quoi,
//! y compris via quelle session SSH), lus dans /proc.
//!
//! Sondage de /proc toutes les 2 s, complété par le connecteur de processus du noyau (`kernel.rs`) quand il est
//! disponible : les `exec` arrivent alors tout de suite et un processus de moins de 2 s est vu (sans lui, il ne l'est pas).

use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
use std::os::unix::fs::MetadataExt;

pub struct Event {
    pub kind: &'static str,
    pub body: Value,
}

#[derive(Clone, Debug)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub uid: u32,
    pub start: u64, // « starttime » de /proc/PID/stat : (pid, start) identifie un processus sans ambiguïté (pids réutilisés)
    pub comm: String,
    pub exe: String,
    pub cmd: String,
}

/// Lit /proc/PID/stat : « pid (comm) S ppid … starttime ». `comm` peut contenir des espaces et des
/// parenthèses : on coupe donc sur la DERNIÈRE parenthèse fermante.
#[cfg(target_os = "linux")]
pub fn parse_stat(text: &str) -> Option<(String, u32, u64)> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    let comm = text.get(open + 1..close)?.to_string();
    let rest: Vec<&str> = text.get(close + 1..)?.split_whitespace().collect();
    // rest[0] = état, rest[1] = ppid, … rest[19] = starttime
    Some((comm, rest.get(1)?.parse().ok()?, rest.get(19)?.parse().ok()?))
}

#[cfg(target_os = "linux")]
pub fn read_proc(pid: u32) -> Option<Proc> {
    let base = format!("/proc/{pid}");
    let (comm, ppid, start) = parse_stat(&fs::read_to_string(format!("{base}/stat")).ok()?)?;
    let uid = fs::metadata(&base).ok()?.uid();
    let exe = fs::read_link(format!("{base}/exe")).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let cmd = fs::read(format!("{base}/cmdline")).map(|b| String::from_utf8_lossy(&b).replace('\0', " ").trim().chars().take(200).collect()).unwrap_or_default();
    Some(Proc { pid, ppid, uid, start, comm, exe, cmd })
}

#[cfg(target_os = "linux")]
pub fn read_all() -> HashMap<u32, Proc> {
    let mut out = HashMap::new();
    if let Ok(rd) = fs::read_dir("/proc") {
        for e in rd.flatten() {
            if let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) {
                if let Some(p) = read_proc(pid) { out.insert(pid, p); }
            }
        }
    }
    out
}

/// Windows et macOS : la liste vient de `sysinfo` (voir platform/portable.rs).
#[cfg(not(target_os = "linux"))]
pub fn read_all() -> HashMap<u32, Proc> {
    crate::platform::procs::read_all()
}

/// Hors Linux il n'y a pas de connecteur de processus : `note_exec` n'est jamais appelé, mais la fonction doit exister.
#[cfg(not(target_os = "linux"))]
pub fn read_proc(pid: u32) -> Option<Proc> {
    read_all().remove(&pid)
}

/// Les ancêtres d'un processus (le plus proche d'abord), jusqu'à 8 niveaux.
pub fn lineage(all: &HashMap<u32, Proc>, pid: u32) -> Vec<Value> {
    let mut out = Vec::new();
    let mut cur = all.get(&pid).map(|p| p.ppid);
    while let Some(pp) = cur {
        if pp == 0 || out.len() >= 8 { break; }
        let Some(p) = all.get(&pp) else { break };
        out.push(json!({ "pid": p.pid, "comm": p.comm, "exe": p.exe }));
        cur = Some(p.ppid);
    }
    out
}

/// « sshd: antho@pts/0 » parmi les ancêtres → ("antho", pid de ce sshd). Sert à relier une commande à une session SSH.
pub fn ssh_session(all: &HashMap<u32, Proc>, pid: u32) -> Option<(String, u32)> {
    let mut cur = all.get(&pid)?.ppid;
    for _ in 0..12 {
        let p = all.get(&cur)?;
        if p.comm == "sshd" || p.comm.starts_with("sshd-session") {
            if let Some(rest) = p.cmd.strip_prefix("sshd: ").or_else(|| p.cmd.strip_prefix("sshd-session: ")) {
                let who = rest.split(|c: char| c == '@' || c.is_whitespace()).next().unwrap_or("");
                if !who.is_empty() && !rest.starts_with('[') { return Some((who.to_string(), p.pid)); }
            }
        }
        if p.ppid == 0 || p.ppid == p.pid { return None; }
        cur = p.ppid;
    }
    None
}

// --- Connexions -------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // hors Linux : aucune connexion n'est lue
pub struct Conn {
    pub local: String,
    pub remote: String,
    pub uid: u32,
    pub inode: u64,
}

#[cfg(target_os = "linux")]
fn addr(hex: &str, v6: bool) -> Option<String> {
    let (ip, port) = hex.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    if v6 {
        if ip.len() != 32 { return None; }
        let b: Vec<u8> = (0..16).map(|i| u8::from_str_radix(&ip[i * 2..i * 2 + 2], 16).unwrap_or(0)).collect();
        // /proc écrit chaque mot de 4 octets à l'envers.
        let mut o = [0u8; 16];
        for w in 0..4 { for k in 0..4 { o[w * 4 + k] = b[w * 4 + 3 - k]; } }
        return Some(format!("[{}]:{port}", std::net::Ipv6Addr::from(o)));
    }
    let n = u32::from_str_radix(ip, 16).ok()?.to_le_bytes();
    Some(format!("{}.{}.{}.{}:{port}", n[0], n[1], n[2], n[3]))
}

#[cfg(target_os = "linux")]
fn is_loopback(a: &str) -> bool {
    a.starts_with("127.") || a.starts_with("[::1]") || a.starts_with("[::ffff:127.")
}

/// Windows et macOS : connexions par processus non fournies (il faudrait la table TCP du système) : liste vide, dit comme tel.
#[cfg(not(target_os = "linux"))]
pub fn read_conns() -> Vec<Conn> {
    Vec::new()
}

#[cfg(not(target_os = "linux"))]
pub fn socket_owners(_all: &HashMap<u32, Proc>, _wanted: &HashSet<u64>) -> HashMap<u64, u32> {
    HashMap::new()
}

#[cfg(target_os = "linux")]
pub fn read_conns() -> Vec<Conn> {
    let mut out = Vec::new();
    for (file, v6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
        let Ok(text) = fs::read_to_string(file) else { continue };
        for line in text.lines().skip(1) {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 10 || f[3] != "01" { continue; } // 01 = ESTABLISHED
            let (Some(l), Some(r)) = (addr(f[1], v6), addr(f[2], v6)) else { continue };
            if is_loopback(&r) { continue; }
            out.push(Conn { local: l, remote: r, uid: f[7].parse().unwrap_or(0), inode: f[9].parse().unwrap_or(0) });
        }
    }
    out
}

/// inode de socket → pid propriétaire (lecture de /proc/PID/fd).
#[cfg(target_os = "linux")]
pub fn socket_owners(all: &HashMap<u32, Proc>, wanted: &HashSet<u64>) -> HashMap<u64, u32> {
    let mut out = HashMap::new();
    if wanted.is_empty() { return out; }
    for pid in all.keys() {
        let Ok(rd) = fs::read_dir(format!("/proc/{pid}/fd")) else { continue };
        for fd in rd.flatten() {
            if let Ok(t) = fs::read_link(fd.path()) {
                let s = t.to_string_lossy();
                if let Some(n) = s.strip_prefix("socket:[").and_then(|x| x.strip_suffix(']')).and_then(|x| x.parse::<u64>().ok()) {
                    if wanted.contains(&n) { out.entry(n).or_insert(*pid); }
                }
            }
        }
    }
    out
}

// --- Échantillonneur ------------------------------------------------------------------------------------

#[derive(Default)]
pub struct Xray {
    procs: Option<HashMap<(u32, u64), Proc>>,
    conns: Option<BTreeMap<String, Value>>,
}

const MAX_PER_TICK: usize = 100;

/// Événement « processus démarré » (avec sa lignée et la session SSH d'origine éventuelle).
fn start_event(p: &Proc, all: &HashMap<u32, Proc>) -> Event {
    let via = ssh_session(all, p.pid).map(|(u, s)| json!({ "ssh": u, "sshd": s }));
    Event { kind: "proc.start", body: json!({
        "pid": p.pid, "ppid": p.ppid, "uid": p.uid, "start": p.start, "exe": p.exe, "comm": p.comm, "cmd": p.cmd,
        "lineage": lineage(all, p.pid), "via": via,
    }) }
}

impl Xray {
    /// Un `exec` annoncé par le noyau (connecteur de processus) : l'événement part tout de suite, et le sondage de /proc
    /// ne le répétera pas (le processus est déjà connu). Rien avant le premier instantané : il fera foi.
    pub fn note_exec(&mut self, p: &Proc) -> Option<Event> {
        let procs = self.procs.as_mut()?;
        if p.exe.is_empty() || procs.contains_key(&(p.pid, p.start)) { return None; }
        procs.insert((p.pid, p.start), p.clone());
        // Ancêtres lus à la demande (pas tout /proc) : de quoi remonter la lignée et la session SSH.
        let mut all = HashMap::new();
        let mut cur = Some(p.clone());
        while let Some(q) = cur {
            let parent = q.ppid;
            all.insert(q.pid, q);
            if parent == 0 || all.len() >= 14 || all.contains_key(&parent) { break; }
            cur = read_proc(parent);
        }
        Some(start_event(p, &all))
    }

    /// Processus : instantané la première fois, puis démarrages / arrêts. `all` est réutilisé par `sample_conns`.
    pub fn sample_procs(&mut self, all: &HashMap<u32, Proc>) -> Vec<Event> {
        let now: HashMap<(u32, u64), Proc> = all.values().map(|p| ((p.pid, p.start), p.clone())).collect();
        let mut out = Vec::new();
        match &self.procs {
            None => {
                let list: Vec<Value> = now.values().filter(|p| !p.exe.is_empty()).take(1000).map(|p| json!({ "pid": p.pid, "ppid": p.ppid, "uid": p.uid, "exe": p.exe, "comm": p.comm })).collect();
                out.push(Event { kind: "proc.snapshot", body: json!({ "processes": list }) });
            }
            Some(before) => {
                let mut started = 0;
                for (k, p) in &now {
                    if before.contains_key(k) || p.exe.is_empty() { continue; } // exe vide = thread noyau
                    started += 1;
                    if started > MAX_PER_TICK { continue; }
                    out.push(start_event(p, all));
                }
                if started > MAX_PER_TICK { out.push(Event { kind: "proc.burst", body: json!({ "count": started }) }); }
                for (k, p) in before { if !now.contains_key(k) && !p.exe.is_empty() { out.push(Event { kind: "proc.exit", body: json!({ "pid": p.pid, "exe": p.exe }) }); } }
            }
        }
        self.procs = Some(now);
        out
    }

    pub fn sample_conns(&mut self, all: &HashMap<u32, Proc>) -> Vec<Event> {
        let conns = read_conns();
        let inodes: HashSet<u64> = conns.iter().map(|c| c.inode).collect();
        let owners = socket_owners(all, &inodes);
        let mut now: BTreeMap<String, Value> = BTreeMap::new();
        for c in &conns {
            let owner = owners.get(&c.inode).and_then(|pid| all.get(pid));
            let exe = owner.map(|p| p.exe.clone()).unwrap_or_default();
            let key = format!("{}|{}|{}", exe, c.local, c.remote);
            now.insert(key, json!({ "local": c.local, "remote": c.remote, "uid": c.uid, "pid": owner.map(|p| p.pid), "exe": exe, "comm": owner.map(|p| p.comm.clone()) }));
        }
        let mut out = Vec::new();
        match &self.conns {
            None => out.push(Event { kind: "conn.snapshot", body: json!({ "connections": now.values().take(500).collect::<Vec<_>>() }) }),
            Some(before) => {
                for (k, v) in now.iter().filter(|(k, _)| !before.contains_key(*k)).take(MAX_PER_TICK) { let _ = k; out.push(Event { kind: "conn.open", body: v.clone() }); }
                for (k, v) in before.iter().filter(|(k, _)| !now.contains_key(*k)).take(MAX_PER_TICK) { let _ = k; out.push(Event { kind: "conn.close", body: v.clone() }); }
            }
        }
        self.conns = Some(now);
        out
    }
}

// --- Actions sur un processus -------------------------------------------------------------------------

/// Processus que l'agent refuse de toucher, même si Corvus le demande (on ne coupe pas la branche sur laquelle on est assis).
#[cfg(target_os = "linux")]
const PROTECTED: [&str; 8] = ["systemd", "init", "sshd", "tailscaled", "corvus-agent", "kthreadd", "dbus-daemon", "systemd-logind"];

/// Valide une cible `(pid, start)` : elle doit exister avec le MÊME starttime (pas un pid réutilisé),
/// ne pas être protégée, ni un ancêtre de l'agent, ni un thread noyau.
#[cfg(target_os = "linux")]
pub fn check_target(pid: u32, start: u64) -> Result<Proc, String> {
    if pid <= 1 { return Err("pid refusé".into()); }
    let p = read_proc(pid).ok_or("processus introuvable")?;
    if p.start != start { return Err("le processus a changé (pid réutilisé) : actualisez".into()); }
    if p.exe.is_empty() { return Err("thread noyau : refusé".into()); }
    if PROTECTED.contains(&p.comm.as_str()) { return Err(format!("processus protégé : {}", p.comm)); }
    let me = std::process::id();
    let all = read_all();
    let mut cur = Some(me);
    let mut guard = 0;
    while let Some(c) = cur {
        if c == pid { return Err("c'est l'agent lui-même ou l'un de ses ancêtres : refusé".into()); }
        cur = all.get(&c).map(|x| x.ppid).filter(|x| *x > 1);
        guard += 1;
        if guard > 32 { break; }
    }
    Ok(p)
}

#[cfg(target_os = "linux")]
pub fn signal(pid: u32, start: u64, sig: i32) -> Result<Value, String> {
    let p = check_target(pid, start)?;
    // SAFETY : kill n'a pas d'effet mémoire ; pid et signal validés ci-dessus.
    let rc = unsafe { libc::kill(pid as i32, sig) };
    if rc != 0 { return Err(format!("kill a échoué : {}", std::io::Error::last_os_error())); }
    Ok(json!({ "pid": pid, "exe": p.exe, "signal": sig }))
}

#[cfg(all(test, target_os = "linux"))] // lit /proc, envoie des signaux : propre à Linux
mod tests {
    use super::*;

    #[test]
    fn stat_avec_espaces_et_parentheses_dans_le_nom() {
        let t = "123 (mon (drôle) prog) S 45 123 123 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10 18446744073709551615";
        let (comm, ppid, start) = parse_stat(t).unwrap();
        assert_eq!(comm, "mon (drôle) prog");
        assert_eq!(ppid, 45);
        assert_eq!(start, 987654);
    }

    #[test]
    fn le_processus_courant_et_sa_lignee() {
        let all = read_all();
        let me = all.get(&std::process::id()).expect("l'agent se voit lui-même");
        assert!(!me.exe.is_empty());
        let l = lineage(&all, me.pid);
        assert!(!l.is_empty(), "un processus a au moins un parent");
    }

    #[test]
    fn instantane_puis_demarrages() {
        let mut x = Xray::default();
        let all = read_all();
        let first = x.sample_procs(&all);
        assert_eq!(first[0].kind, "proc.snapshot");
        let child = std::process::Command::new("sleep").arg("5").spawn().unwrap();
        let all2 = read_all();
        let ev = x.sample_procs(&all2);
        let started = ev.iter().find(|e| e.kind == "proc.start" && e.body["pid"] == child.id()).expect("le sleep est vu");
        assert!(started.body["exe"].as_str().unwrap().ends_with("sleep"));
        assert!(!started.body["lineage"].as_array().unwrap().is_empty());
        let mut child = child;
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn decodage_adresses() {
        assert_eq!(addr("0100007F:1F90", false).unwrap(), "127.0.0.1:8080");
        assert_eq!(addr("00000000000000000000000001000000:0050", true).unwrap(), "[::1]:80");
        assert!(is_loopback("127.0.0.1:22"));
        assert!(!is_loopback("10.0.0.1:22"));
    }

    #[test]
    fn les_cibles_dangereuses_sont_refusees() {
        assert!(check_target(1, 0).is_err());
        assert!(check_target(std::process::id(), 0).is_err());
        let me = read_proc(std::process::id()).unwrap();
        assert!(check_target(me.pid, me.start).unwrap_err().contains("agent lui-même"));
        assert!(check_target(999_999, 0).is_err());
    }

    #[test]
    fn gel_et_degel_reels() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let p = read_proc(child.id()).unwrap();
        signal(p.pid, p.start, libc::SIGSTOP).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        let state = fs::read_to_string(format!("/proc/{}/stat", p.pid)).unwrap();
        assert!(state.split(')').next_back().unwrap().trim_start().starts_with('T'), "le processus est arrêté : {state}");
        signal(p.pid, p.start, libc::SIGCONT).unwrap();
        assert!(signal(p.pid, p.start + 1, libc::SIGCONT).is_err(), "mauvais starttime refusé");
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
