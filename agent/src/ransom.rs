//! Défense anti-ransomware (étape 7.3) : fichiers pièges, détection de rafales de fichiers chiffrés
//! (entropie), attribution au processus qui écrit le plus, isolement réseau (nftables).
//!
//! Tout est local à l'agent et déterministe : pas d'IA, des seuils réglables. Corvus décide ensuite
//! (alerte, gel, isolement) selon les options de l'hôte ; rien de destructif n'est automatique par défaut.

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::io::Write;
use std::time::{Duration, Instant};

pub const HIGH_ENTROPY: f64 = 7.5;
const LOW_ENTROPY: f64 = 6.5;

/// Un fichier qui vient de changer ressemble-t-il à du chiffrement ? (jamais pour un secret suivi sans contenu)
pub fn is_suspect(kind: &str, body: &Value) -> bool {
    if body["reason"] == "secret" { return false; }
    let Some(e) = body["entropy"].as_f64() else { return false };
    if e < HIGH_ENTROPY { return false; }
    match kind {
        // Un fichier « normal » devenu aléatoire : le signe classique d'un chiffrement sur place.
        "file.modified" => body["prevEntropy"].as_f64().is_some_and(|p| p < LOW_ENTROPY),
        // Copie chiffrée écrite sous un nouveau nom (« .locked »).
        "file.created" => body["size"].as_i64().unwrap_or(0) >= 1024,
        _ => false,
    }
}

/// Fenêtre glissante : `threshold` fichiers suspects en `window` secondes = alerte, puis silence `cooldown`.
pub struct Detector {
    window: VecDeque<(Instant, String)>,
    pub threshold: usize,
    pub window_secs: u64,
    cooldown: Duration,
    last_fired: Option<Instant>,
}

impl Detector {
    pub fn new(threshold: usize, window_secs: u64) -> Self {
        Self { window: VecDeque::new(), threshold, window_secs, cooldown: Duration::from_secs(300), last_fired: None }
    }

    /// À appeler pour chaque changement de fichier. Retourne le corps de l'événement `ransom.suspect` quand le seuil est franchi.
    pub fn feed(&mut self, now: Instant, kind: &str, body: &Value) -> Option<Value> {
        if !is_suspect(kind, body) { return None; }
        self.window.push_back((now, body["path"].as_str().unwrap_or("?").to_string()));
        let horizon = Duration::from_secs(self.window_secs);
        while self.window.front().is_some_and(|(t, _)| now.duration_since(*t) > horizon) { self.window.pop_front(); }
        if self.window.len() < self.threshold { return None; }
        if self.last_fired.is_some_and(|t| now.duration_since(t) < self.cooldown) { return None; }
        self.last_fired = Some(now);
        let sample: Vec<&String> = self.window.iter().map(|(_, p)| p).take(10).collect();
        Some(json!({ "count": self.window.len(), "windowSec": self.window_secs, "threshold": self.threshold, "sample": sample }))
    }
}

// --- Fichiers pièges ----------------------------------------------------------------------------------

const DECOYS: [(&str, &str); 3] = [
    ("!corvus-leurre-budget.xlsx", "Budget previsionnel - document confidentiel\nposte;montant\nsalaires;125000\nloyer;24000\n"),
    ("!corvus-leurre-notes.docx", "Notes de reunion - ne pas diffuser\nPoints a traiter : contrats, facturation, sauvegardes.\n"),
    ("!corvus-leurre.txt", "Fichier piege Corvus : toute modification ou suppression de ce fichier declenche une alerte.\n"),
];

/// Crée les fichiers pièges (noms triés en premier, extensions attractives). Ne réécrit jamais un fichier existant.
pub fn create_canaries(dirs: &[PathBuf]) -> Vec<String> {
    let mut out = Vec::new();
    for d in dirs {
        for (name, content) in DECOYS {
            let p = d.join(name);
            if !p.exists() {
                let body = content.repeat(8); // > 512 octets : l'entropie reste mesurable
                if fs::write(&p, body).is_err() { continue; }
            }
            out.push(p.to_string_lossy().into_owned());
        }
    }
    out
}

// --- Qui écrit le plus ? -----------------------------------------------------------------------------------

// Un instantané : pour chaque pid, (starttime, octets écrits).
type Snapshot = HashMap<u32, (u64, u64)>;

#[derive(Default)]
pub struct IoTracker {
    snaps: VecDeque<(Instant, Snapshot)>,
}

fn write_bytes(pid: u32) -> Option<u64> {
    fs::read_to_string(format!("/proc/{pid}/io")).ok()?.lines().find_map(|l| l.strip_prefix("write_bytes: ")?.trim().parse().ok())
}

impl IoTracker {
    pub fn record(&mut self, now: Instant, all: &HashMap<u32, crate::xray::Proc>) {
        let snap: HashMap<u32, (u64, u64)> = all.values().filter(|p| !p.exe.is_empty()).filter_map(|p| Some((p.pid, (p.start, write_bytes(p.pid)?)))).collect();
        self.snaps.push_back((now, snap));
        while self.snaps.len() > 15 { self.snaps.pop_front(); } // ~30 s d'historique à 2 s
    }

    /// Les `n` processus qui ont le plus écrit sur disque pendant la fenêtre : candidats (pas une preuve).
    /// Un candidat doit avoir un lien avec les dossiers touchés (`dirs`) : son dossier courant ou un fichier
    /// ouvert dedans. Sans cela, le plus gros écrivain du disque (une base de données qui vide ses tampons,
    /// par exemple) serait accusé à tort — et gelé par la réaction automatique. Les démons critiques ne sont
    /// jamais proposés.
    pub fn top(&self, n: usize, all: &HashMap<u32, crate::xray::Proc>, dirs: &[String]) -> Vec<Value> {
        let (Some((_, old)), Some((_, new))) = (self.snaps.front(), self.snaps.back()) else { return vec![] };
        let me = std::process::id();
        let mut v: Vec<(u32, u64)> = new.iter().filter(|(pid, _)| **pid != me).filter_map(|(pid, (start, bytes))| {
            let (ostart, obytes) = old.get(pid)?;
            (ostart == start && bytes > obytes).then(|| (*pid, bytes - obytes))
        }).collect();
        v.sort_by_key(|x| std::cmp::Reverse(x.1));
        v.into_iter().filter_map(|(pid, delta)| {
            let p = all.get(&pid)?;
            if never_auto(&p.comm) || !touches_dirs(pid, dirs) { return None; }
            Some(json!({ "pid": pid, "start": p.start, "exe": p.exe, "uid": p.uid, "writtenBytes": delta }))
        }).take(n).collect()
    }
}

/// Démons dont le gel automatique ferait plus de dégâts qu'un ransomware présumé (bases de données, moteurs de
/// conteneurs, journal, planificateur) : jamais désignés comme écrivain principal.
const NEVER_AUTO: [&str; 14] = [
    "postgres", "postmaster", "mysqld", "mariadbd", "mongod", "redis-server", "dockerd", "containerd", "systemd-journal",
    "journald", "cron", "rsyslogd", "systemd", "kworker",
];

pub fn never_auto(comm: &str) -> bool {
    NEVER_AUTO.iter().any(|n| comm.starts_with(n))
}

/// Dossier parent d'un chemin (chaîne), sans toucher au disque.
pub fn parent_dir(path: &str) -> Option<String> {
    let p = std::path::Path::new(path).parent()?.to_str()?;
    (!p.is_empty()).then(|| p.to_string())
}

/// Le processus a-t-il son dossier courant ou un fichier ouvert dans l'un de ces dossiers (ou dessous) ?
/// Lecture de /proc/PID/{cwd,fd} : demande d'être root pour les processus des autres utilisateurs.
pub fn touches_dirs(pid: u32, dirs: &[String]) -> bool {
    if dirs.is_empty() { return false; }
    let inside = |target: &std::path::Path| dirs.iter().any(|d| target.starts_with(d));
    if fs::read_link(format!("/proc/{pid}/cwd")).is_ok_and(|t| inside(&t)) { return true; }
    let Ok(rd) = fs::read_dir(format!("/proc/{pid}/fd")) else { return false };
    rd.flatten().any(|e| fs::read_link(e.path()).is_ok_and(|t| inside(&t)))
}

// --- Isolement réseau (nftables) -------------------------------------------------------------------------------

const TABLE: &str = "corvus_isolate";

/// Règles d'isolement. Toujours autorisés : l'interface locale, **tailscale0**, le trafic de tailscaled lui-même
/// (paquets marqués 0x80000, y compris WireGuard direct sur udp/41641) et **le serveur Corvus** (adresses `allow`).
/// Tout le reste — y compris les connexions déjà établies — est coupé.
pub fn ruleset(allow: &[IpAddr]) -> String {
    let v4: Vec<String> = allow.iter().filter(|i| i.is_ipv4()).map(|i| i.to_string()).collect();
    let v6: Vec<String> = allow.iter().filter(|i| i.is_ipv6()).map(|i| i.to_string()).collect();
    let mut input = String::new();
    let mut output = String::new();
    if !v4.is_empty() { input += &format!("    ip saddr {{ {} }} accept\n", v4.join(", ")); output += &format!("    ip daddr {{ {} }} accept\n", v4.join(", ")); }
    if !v6.is_empty() { input += &format!("    ip6 saddr {{ {} }} accept\n", v6.join(", ")); output += &format!("    ip6 daddr {{ {} }} accept\n", v6.join(", ")); }
    format!(
        "table inet {TABLE} {{\n  chain input {{\n    type filter hook input priority -300; policy drop;\n    iifname \"lo\" accept\n    iifname \"tailscale0\" accept\n    udp dport 41641 accept\n{input}  }}\n  chain output {{\n    type filter hook output priority -300; policy drop;\n    oifname \"lo\" accept\n    oifname \"tailscale0\" accept\n    meta mark & 0xff0000 == 0x80000 accept\n{output}  }}\n}}\n"
    )
}

/// Adresses du serveur Corvus (résolution de l'hôte de l'URL) + adresses supplémentaires explicites.
pub fn allowed_addresses(server_url: &str, extra: &[String]) -> Vec<IpAddr> {
    let host_port = server_url.trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or("");
    let with_port = if host_port.contains(':') { host_port.to_string() } else { format!("{host_port}:443") };
    let mut out: Vec<IpAddr> = with_port.to_socket_addrs().map(|it| it.map(|a| a.ip()).collect()).unwrap_or_default();
    out.extend(extra.iter().filter_map(|s| s.parse::<IpAddr>().ok()));
    out.sort();
    out.dedup();
    out
}

fn nft(args: &[&str], stdin: Option<&str>) -> Result<String, String> {
    let mut child = Command::new("nft").args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("nft introuvable : {e}"))?;
    if let (Some(text), Some(mut si)) = (stdin, child.stdin.take()) { si.write_all(text.as_bytes()).map_err(|e| e.to_string())?; }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).into_owned()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

pub fn available() -> bool {
    // SAFETY : geteuid sans effet de bord.
    let root = unsafe { libc::geteuid() } == 0;
    root && std::env::var("PATH").unwrap_or_default().split(':').any(|d| std::path::Path::new(d).join("nft").exists())
}

pub fn active() -> bool {
    nft(&["list", "table", "inet", TABLE], None).is_ok()
}

/// Pose l'isolement. Refuse si le serveur Corvus n'a aucune adresse connue (on se couperait de lui).
pub fn isolate(allow: &[IpAddr]) -> Result<(), String> {
    if allow.is_empty() { return Err("adresse du serveur Corvus introuvable : isolement refusé (l'agent s'en couperait)".into()); }
    let _ = release(); // une seule table à la fois
    let rules = ruleset(allow);
    nft(&["-c", "-f", "-"], Some(&rules)).map_err(|e| format!("règles invalides : {e}"))?; // validation sans effet
    nft(&["-f", "-"], Some(&rules)).map(|_| ())
}

pub fn release() -> Result<(), String> {
    if !active() { return Ok(()); }
    nft(&["delete", "table", "inet", TABLE], None).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_processus_sans_lien_avec_les_dossiers_touches_nest_pas_accuse() {
        let dir = std::env::temp_dir().join(format!("corvus-top-{}", std::process::id()));
        let other = std::env::temp_dir().join(format!("corvus-top-autre-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(&other).unwrap();
        let f = fs::File::create(dir.join("doc.txt")).unwrap(); // fichier ouvert par CE processus
        let me = std::process::id();
        assert!(touches_dirs(me, &[dir.to_string_lossy().into_owned()]), "fichier ouvert dans le dossier");
        assert!(!touches_dirs(me, &[other.to_string_lossy().into_owned()]), "aucun lien avec cet autre dossier");
        assert!(!touches_dirs(me, &[]), "pas de dossier connu : personne n'est accusé");
        drop(f);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&other);
    }

    #[test]
    fn les_demons_critiques_ne_sont_jamais_proposes() {
        for c in ["postgres", "mariadbd", "dockerd", "systemd-journald", "cron"] { assert!(never_auto(c), "{c}"); }
        for c in ["python3", "mv", "ransom", "openssl"] { assert!(!never_auto(c), "{c}"); }
        assert_eq!(parent_dir("/tmp/x/a.doc").as_deref(), Some("/tmp/x"));
        assert_eq!(parent_dir("a"), None);
    }

    fn e(kind: &str, ent: f64, prev: Option<f64>, size: i64, path: &str) -> (String, Value) {
        (kind.to_string(), json!({ "path": path, "entropy": ent, "prevEntropy": prev, "size": size, "reason": "" }))
    }

    #[test]
    fn les_fichiers_suspects() {
        let (k, b) = e("file.modified", 7.9, Some(4.0), 5000, "/h/a.doc");
        assert!(is_suspect(&k, &b));
        let (k, b) = e("file.modified", 7.9, Some(7.9), 5000, "/h/a.zip");
        assert!(!is_suspect(&k, &b), "un zip qui change reste aléatoire : pas un chiffrement");
        let (k, b) = e("file.modified", 4.0, Some(4.0), 5000, "/h/a.txt");
        assert!(!is_suspect(&k, &b));
        let (k, b) = e("file.created", 7.9, None, 4096, "/h/a.doc.locked");
        assert!(is_suspect(&k, &b));
        let (k, b) = e("file.created", 7.9, None, 100, "/h/petit");
        assert!(!is_suspect(&k, &b));
    }

    #[test]
    fn rafale_puis_silence() {
        let mut d = Detector::new(5, 30);
        let t0 = Instant::now();
        let (k, b) = e("file.modified", 7.9, Some(3.0), 5000, "/h/x");
        for i in 0..4 { assert!(d.feed(t0 + Duration::from_secs(i), &k, &b).is_none()); }
        let fired = d.feed(t0 + Duration::from_secs(4), &k, &b).expect("5e fichier : alerte");
        assert_eq!(fired["count"], 5);
        assert!(d.feed(t0 + Duration::from_secs(5), &k, &b).is_none(), "silence pendant le délai de repos");
    }

    #[test]
    fn des_changements_espaces_ne_declenchent_rien() {
        let mut d = Detector::new(5, 30);
        let t0 = Instant::now();
        let (k, b) = e("file.modified", 7.9, Some(3.0), 5000, "/h/x");
        for i in 0..20 { assert!(d.feed(t0 + Duration::from_secs(i * 60), &k, &b).is_none()); }
    }

    #[test]
    fn leurres_non_ecrases() {
        let d = std::env::temp_dir().join(format!("corvus-leurre-{}", rand::random::<u64>()));
        fs::create_dir_all(&d).unwrap();
        let l = create_canaries(std::slice::from_ref(&d));
        assert_eq!(l.len(), 3);
        fs::write(d.join("!corvus-leurre.txt"), "modifié par l'utilisateur").unwrap();
        create_canaries(std::slice::from_ref(&d));
        assert_eq!(fs::read_to_string(d.join("!corvus-leurre.txt")).unwrap(), "modifié par l'utilisateur");
    }

    #[test]
    fn l_isolement_garde_toujours_tailscale_et_le_serveur() {
        let r = ruleset(&["100.64.0.1".parse().unwrap(), "2001:db8::1".parse().unwrap()]);
        for must in ["iifname \"lo\" accept", "iifname \"tailscale0\" accept", "oifname \"tailscale0\" accept", "meta mark & 0xff0000 == 0x80000 accept",
                     "udp dport 41641 accept", "ip daddr { 100.64.0.1 } accept", "ip saddr { 100.64.0.1 } accept", "ip6 daddr { 2001:db8::1 } accept"] {
            assert!(r.contains(must), "règle manquante : {must}\n{r}");
        }
        assert_eq!(r.matches("policy drop").count(), 2);
        assert!(!r.contains("established"), "les connexions déjà établies sont coupées aussi");
    }

    #[test]
    fn pas_d_isolement_sans_adresse_du_serveur() {
        assert!(isolate(&[]).unwrap_err().contains("refusé"));
        assert!(allowed_addresses("http://127.0.0.1:7680", &["10.0.0.9".into(), "pas-une-ip".into()]).contains(&"10.0.0.9".parse().unwrap()));
    }
}
