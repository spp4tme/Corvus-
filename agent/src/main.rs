//! corvus-agent — petit programme installé sur un hôte. Il se CONNECTE à Corvus (aucun port ouvert
//! sur l'hôte), s'authentifie par signature Ed25519 dans les deux sens, puis envoie métriques et
//! événements. Corvus ne peut lui envoyer AUCUNE commande shell.
//!
//! Usage :
//!   corvus-agent enroll --server https://corvus.exemple.ts.net --token <jeton>   (une seule fois)
//!   corvus-agent run                                                              (service)

mod actions;
mod buffer;
mod identity;
mod metrics;
mod preview;
mod protocol;
mod ransom;
mod state;
mod sys;
mod watch;
mod xray;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use buffer::Buffer;
use ed25519_dalek::SigningKey;
use identity::{websocket_url, Identity};
use rand::rngs::OsRng;
use serde_json::{json, Value};
use std::{collections::HashSet, env, path::PathBuf, process, thread, time::{Duration, Instant}};
use tungstenite::{stream::MaybeTlsStream, Message, WebSocket};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("enroll") => enroll(&args[1..]),
        Some("run") => run(&args[1..]),
        Some("version") | Some("--version") => { println!("corvus-agent {VERSION}"); Ok(()) }
        _ => Err("usage : corvus-agent enroll --server URL --token JETON | run | version\n  option commune : --dir DOSSIER (défaut : $CORVUS_AGENT_DIR ou /var/lib/corvus-agent)".into()),
    };
    if let Err(e) = result {
        eprintln!("erreur : {e}");
        process::exit(1);
    }
}

/// Valeur d'une option « --nom valeur ».
fn opt(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn data_dir(args: &[String]) -> PathBuf {
    PathBuf::from(opt(args, "--dir").or_else(|| env::var("CORVUS_AGENT_DIR").ok()).unwrap_or_else(|| "/var/lib/corvus-agent".into()))
}

fn capabilities(allow_preview: bool) -> Value {
    // eBPF et fanotify : pas encore (étape 7) ; les fichiers sont suivis par balayage régulier.
    json!({
        "metrics": true, "files": true, "ports": true,
        "services": sys::systemd_available(),
        "packages": std::path::Path::new("/var/log/dpkg.log").exists(),
        "actions": actions::names(allow_preview),
        "preview": allow_preview && preview::available(),
        "ransom": true, "isolation": ransom::available(), "xray": true,
        "fanotify": false, "ebpf": false,
    })
}

/// Dossiers surveillés : --watch a,b (ou $CORVUS_AGENT_WATCH), par défaut /etc et les crontabs.
fn watch_roots(args: &[String]) -> Vec<PathBuf> {
    let raw = opt(args, "--watch").or_else(|| env::var("CORVUS_AGENT_WATCH").ok()).unwrap_or_else(|| "/etc,/var/spool/cron".into());
    raw.split(',').map(str::trim).filter(|p| p.starts_with('/') && std::path::Path::new(p).exists()).map(PathBuf::from).collect()
}

/// Tout ce que l'agent observe, même hors connexion : les événements vont dans le tampon SQLite.
struct Collector {
    agent_dir: PathBuf,
    allow_preview: bool,
    state: state::State,
    xray: xray::Xray,
    io: ransom::IoTracker,
    detector: ransom::Detector,
    canaries: HashSet<String>,
    server_url: String,
    extra_allow: Vec<String>,
    isolation_until: Option<Instant>,
    watcher: watch::Watcher,
    scan_every: Duration,
    next_scan: Instant,
    next_ports: Instant,
    next_services: Instant,
    next_pkgs: Instant,
    next_xray: Instant,
    next_conns: Instant,
}

impl Collector {
    /// Détections après chaque changement de fichier : fichier piège touché, rafale de fichiers chiffrés.
    fn after_change(&mut self, buffer: &Buffer, ts: i64, kind: &str, body: &Value) {
        let path = body["path"].as_str().unwrap_or("");
        if self.canaries.contains(path) && matches!(kind, "file.modified" | "file.deleted") {
            let writers = self.io.top(3, &xray::read_all());
            let _ = buffer.push(ts, "canary.touched", &json!({ "path": path, "change": kind, "writers": writers }));
        }
        if let Some(mut ev) = self.detector.feed(Instant::now(), kind, body) {
            ev["writers"] = json!(self.io.top(3, &xray::read_all()));
            let _ = buffer.push(ts, "ransom.suspect", &ev);
        }
    }

    /// Fin automatique de l'isolement (filet de sécurité : on ne reste jamais coupé du réseau indéfiniment).
    fn check_isolation_expiry(&mut self, buffer: &Buffer) {
        if self.isolation_until.is_some_and(|t| Instant::now() >= t) {
            self.isolation_until = None;
            let _ = self.state.set("isolation.until", "");
            let r = ransom::release();
            let _ = buffer.push(protocol::now_ms() as i64, "net.released", &json!({ "auto": true, "ok": r.is_ok(), "error": r.err() }));
        }
    }

    /// Actions réseau (isolement). Retourne None si `name` n'en est pas une.
    fn net_action(&mut self, name: &str, args: &Value, buffer: &Buffer) -> Option<Result<Value, String>> {
        let ts = protocol::now_ms() as i64;
        Some(match name {
            "net.isolate" => (|| {
                if !ransom::available() { return Err("isolement indisponible (agent non root ou nft absent)".to_string()); }
                let ttl = args["ttlSec"].as_u64().unwrap_or(900).clamp(60, 86_400);
                let allow = ransom::allowed_addresses(&self.server_url, &self.extra_allow);
                ransom::isolate(&allow)?;
                self.isolation_until = Some(Instant::now() + Duration::from_secs(ttl));
                let until_ms = ts as u64 + ttl * 1000;
                let _ = self.state.set("isolation.until", &until_ms.to_string());
                let _ = buffer.push(ts, "net.isolated", &json!({ "ttlSec": ttl, "allow": allow.iter().map(|a| a.to_string()).collect::<Vec<_>>() }));
                Ok(json!({ "isolated": true, "ttlSec": ttl, "allow": allow.iter().map(|a| a.to_string()).collect::<Vec<_>>() }))
            })(),
            "net.release" => ransom::release().map(|_| {
                self.isolation_until = None;
                let _ = self.state.set("isolation.until", "");
                let _ = buffer.push(ts, "net.released", &json!({ "auto": false, "ok": true }));
                json!({ "isolated": false })
            }),
            "net.status" => Ok(json!({ "available": ransom::available(), "isolated": ransom::available() && ransom::active(),
                "remainingSec": self.isolation_until.map(|t| t.saturating_duration_since(Instant::now()).as_secs()) })),
            _ => return None,
        })
    }

    /// Balayage immédiat (avant une action : l'état actuel d'un fichier doit être dans l'historique).
    fn scan_now(&mut self, buffer: &Buffer) {
        self.next_scan = Instant::now();
        self.tick(buffer);
    }

    fn tick(&mut self, buffer: &Buffer) {
        let now = Instant::now();
        let ts = protocol::now_ms() as i64;
        self.check_isolation_expiry(buffer);
        if now >= self.next_scan {
            self.next_scan = now + self.scan_every;
            let baseline = self.state.get("baseline.files").is_none();
            match self.watcher.scan(&self.state, baseline) {
                Ok(changes) => {
                    for c in changes {
                        let _ = buffer.push(ts, c.kind, &c.body);
                        self.after_change(buffer, ts, c.kind, &c.body);
                    }
                    if baseline { let _ = self.state.set("baseline.files", "1"); }
                }
                Err(e) => eprintln!("balayage : {e}"),
            }
        }
        let push = |events: Vec<sys::Event>| { for e in events { let _ = buffer.push(ts, e.kind, &e.body); } };
        if now >= self.next_xray {
            self.next_xray = now + Duration::from_secs(2);
            let all = xray::read_all();
            self.io.record(now, &all);
            for e in self.xray.sample_procs(&all) { let _ = buffer.push(ts, e.kind, &e.body); }
            if now >= self.next_conns {
                self.next_conns = now + Duration::from_secs(6);
                for e in self.xray.sample_conns(&all) { let _ = buffer.push(ts, e.kind, &e.body); }
            }
        }
        if now >= self.next_ports { self.next_ports = now + Duration::from_secs(10); push(sys::check_ports(&self.state)); }
        if now >= self.next_services { self.next_services = now + Duration::from_secs(60); push(sys::check_services(&self.state)); }
        if now >= self.next_pkgs { self.next_pkgs = now + Duration::from_secs(30); push(sys::check_packages(&self.state)); }
    }
}

// --- Enrôlement ---------------------------------------------------------------------------------

fn enroll(args: &[String]) -> Result<(), String> {
    let server = opt(args, "--server").ok_or("--server est requis")?;
    let token = opt(args, "--token").ok_or("--token est requis")?;
    let dir = data_dir(args);
    std::fs::create_dir_all(&dir).map_err(|e| format!("dossier {} : {e}", dir.display()))?;
    let id_path = dir.join("identity.json");
    if id_path.exists() {
        return Err(format!("{} existe déjà : cet hôte est déjà enrôlé (supprimez-le pour recommencer).", id_path.display()));
    }
    websocket_url(&server)?; // valide l'adresse avant d'aller plus loin

    // La clé privée est créée ICI et n'est jamais envoyée : seule la clé publique part.
    let key = SigningKey::generate(&mut OsRng);
    let hostname = std::fs::read_to_string("/etc/hostname").unwrap_or_default().trim().to_string();
    let resp: Value = ureq::post(&format!("{}/api/agent/enroll", server.trim_end_matches('/')))
        .send_json(json!({
            "token": token,
            "publicKey": B64.encode(key.verifying_key().to_bytes()),
            "version": VERSION,
            "hostname": hostname,
            "capabilities": capabilities(false),
        }))
        .map_err(|e| match e {
            ureq::Error::Status(code, r) => format!("enrôlement refusé ({code}) : {}", r.into_string().unwrap_or_default()),
            other => format!("serveur injoignable : {other}"),
        })?
        .into_json()
        .map_err(|e| format!("réponse illisible : {e}"))?;

    let identity = Identity {
        server: server.trim_end_matches('/').to_string(),
        agent_id: resp["agentId"].as_str().ok_or("réponse sans agentId")?.to_string(),
        server_public_key: resp["serverPublicKey"].as_str().ok_or("réponse sans clé du serveur")?.to_string(),
        secret_key: B64.encode(key.to_bytes()),
    };
    identity.save(&id_path).map_err(|e| format!("écriture de l'identité : {e}"))?;
    println!("Enrôlé : agent {} (identité enregistrée dans {})", identity.agent_id, id_path.display());
    Ok(())
}

// --- Exécution ------------------------------------------------------------------------------------

fn run(args: &[String]) -> Result<(), String> {
    let dir = data_dir(args);
    let identity = Identity::load(&dir.join("identity.json"))?;
    let interval = Duration::from_secs(opt(args, "--interval").and_then(|v| v.parse().ok()).unwrap_or(30).max(1));
    let buffer = Buffer::open(&dir.join("buffer.db")).map_err(|e| format!("tampon : {e}"))?;
    let mut roots = watch_roots(args);
    // Fichiers pièges : --canary dossier1,dossier2 (ajoutés aux dossiers surveillés).
    let canary_dirs: Vec<PathBuf> = opt(args, "--canary").map(|v| v.split(',').map(str::trim).filter(|p| p.starts_with('/') && std::path::Path::new(p).is_dir()).map(PathBuf::from).collect()).unwrap_or_default();
    let canaries: HashSet<String> = ransom::create_canaries(&canary_dirs).into_iter().collect();
    for d in &canary_dirs { if !roots.contains(d) { roots.push(d.clone()); } }
    let now = Instant::now();
    let mut collector = Collector {
        agent_dir: dir.clone(),
        allow_preview: args.iter().any(|a| a == "--allow-preview"),
        state: state::State::open(&dir.join("state.db")).map_err(|e| format!("état : {e}"))?,
        xray: xray::Xray::default(),
        watcher: watch::Watcher { roots: roots.clone(), pending_dir: dir.join("pending") },
        scan_every: Duration::from_secs(opt(args, "--scan-interval").and_then(|v| v.parse().ok()).unwrap_or(if canaries.is_empty() { 10 } else { 3 }).max(1)),
        io: ransom::IoTracker::default(),
        detector: ransom::Detector::new(opt(args, "--ransom-threshold").and_then(|v| v.parse().ok()).unwrap_or(20).max(2), 30),
        canaries,
        server_url: identity.server.clone(),
        extra_allow: opt(args, "--isolate-allow").map(|v| v.split(',').map(|x| x.trim().to_string()).collect()).unwrap_or_default(),
        isolation_until: None,
        next_scan: now, next_ports: now, next_services: now, next_pkgs: now, next_xray: now, next_conns: now,
    };
    // Démarrage prudent : un isolement oublié (agent redémarré, minuteur perdu) ne doit jamais durer.
    if ransom::available() && ransom::active() {
        let until: u64 = collector.state.get("isolation.until").and_then(|v| v.parse().ok()).unwrap_or(0);
        if until <= protocol::now_ms() {
            let ok = ransom::release().is_ok();
            let _ = buffer.push(protocol::now_ms() as i64, "net.released", &json!({ "auto": true, "atStart": true, "ok": ok }));
        } else {
            collector.isolation_until = Some(Instant::now() + Duration::from_millis(until - protocol::now_ms()));
        }
    }
    buffer.push(protocol::now_ms() as i64, "agent.start", &json!({ "version": VERSION, "watch": roots })).map_err(|e| e.to_string())?;
    eprintln!("surveillance : {roots:?}");

    // Reconnexion automatique : 1 s, 2 s, 4 s… jusqu'à 30 s. L'observation continue pendant l'attente.
    let mut wait = 1u64;
    loop {
        let started = Instant::now();
        match session(&identity, &buffer, &mut collector, interval) {
            Ok(()) => eprintln!("connexion fermée par Corvus"),
            Err(e) => eprintln!("connexion perdue : {e}"),
        }
        wait = if started.elapsed() > Duration::from_secs(60) { 1 } else { (wait * 2).min(30) };
        eprintln!("nouvelle tentative dans {wait} s");
        for _ in 0..wait { collector.tick(&buffer); thread::sleep(Duration::from_secs(1)); }
    }
}

type Socket = WebSocket<MaybeTlsStream<std::net::TcpStream>>;

/// Délai de lecture court : permet d'alterner « lire les messages » et « envoyer les métriques ».
fn set_read_timeout(ws: &Socket, d: Duration) {
    match ws.get_ref() {
        MaybeTlsStream::Plain(s) => { let _ = s.set_read_timeout(Some(d)); }
        MaybeTlsStream::Rustls(s) => { let _ = s.get_ref().set_read_timeout(Some(d)); }
        _ => {}
    }
}

fn recv(ws: &mut Socket) -> Result<Option<Value>, String> {
    match ws.read() {
        Ok(Message::Text(t)) => serde_json::from_str(&t).map(Some).map_err(|e| format!("JSON invalide du serveur : {e}")),
        Ok(Message::Close(_)) => Err("fermé par le serveur".into()),
        Ok(_) => Ok(None), // ping/pong/binaire : géré par la bibliothèque ou ignoré
        Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn send(ws: &mut Socket, kind: &str, body: Value) -> Result<(), String> {
    ws.send(Message::text(protocol::envelope(kind, body))).map_err(|e| e.to_string())
}

/// Une connexion complète : poignée de main, puis boucle d'envoi jusqu'à la coupure.
fn session(identity: &Identity, buffer: &Buffer, collector: &mut Collector, interval: Duration) -> Result<(), String> {
    let key = identity.signing_key()?;
    let (mut ws, _) = tungstenite::connect(websocket_url(&identity.server)?).map_err(|e| format!("connexion : {e}"))?;
    set_read_timeout(&ws, Duration::from_secs(10));

    // 1. Le serveur envoie un défi ; on le signe avec NOTRE clé privée et on lui pose le nôtre.
    let hello = recv(&mut ws)?.ok_or("pas de « hello » du serveur")?;
    if hello["type"] != "hello" { return Err("premier message inattendu".into()); }
    let challenge = hello["body"]["challenge"].as_str().ok_or("défi manquant")?.to_string();
    let my_challenge = B64.encode(rand::random::<[u8; 32]>());
    send(&mut ws, "auth", json!({
        "agentId": identity.agent_id,
        "signature": protocol::sign_challenge(&key, &challenge),
        "challenge": my_challenge,
    }))?;

    // 2. Le serveur doit prouver qui il est : sa signature de NOTRE défi, vérifiée avec la clé
    //    reçue à l'enrôlement. Sans cela, on se déconnecte (protège contre un faux serveur).
    let ok = recv(&mut ws)?.ok_or("pas de réponse d'authentification")?;
    if ok["type"] == "error" { return Err(format!("refusé par Corvus : {}", ok["body"]["message"])); }
    if ok["type"] != "auth_ok" { return Err("réponse d'authentification inattendue".into()); }
    protocol::verify_server(&identity.server_public_key, &my_challenge, ok["body"]["signature"].as_str().unwrap_or(""))?;
    if let Some(last) = ok["body"]["lastSeq"].as_i64() { let _ = buffer.ack(last); } // déjà reçu avant la coupure
    eprintln!("connecté à Corvus (agent {})", identity.agent_id);

    send(&mut ws, "hello_agent", json!({ "version": VERSION, "capabilities": capabilities(collector.allow_preview) }))?;

    set_read_timeout(&ws, Duration::from_secs(1));
    let mut sampler = metrics::Sampler::default();
    let mut next_metrics = Instant::now();
    let mut next_ping = Instant::now() + Duration::from_secs(25);
    let mut in_flight = false; // un lot attend son « ack » : on n'en envoie pas un second
    let mut uploaded: HashSet<String> = HashSet::new(); // contenus déjà envoyés pendant cette connexion

    loop {
        collector.tick(buffer);
        // Événements du tampon (envoyés tant que Corvus ne les a pas confirmés).
        if !in_flight {
            let pending = buffer.pending(200).map_err(|e| e.to_string())?;
            if !pending.is_empty() {
                // Les contenus de fichiers partent AVANT les événements qui les citent.
                for e in &pending {
                    if let Some(sha) = e.body["sha"].as_str() {
                        if e.body["noContent"] != true && uploaded.insert(sha.to_string()) {
                            if let Some(data) = collector.watcher.pending_content(sha) {
                                send(&mut ws, "version", json!({ "sha256": sha, "data": B64.encode(data) }))?;
                            }
                        }
                    }
                }
                let items: Vec<Value> = pending.iter().map(|e| json!({ "seq": e.seq, "ts": e.ts, "type": e.kind, "body": e.body })).collect();
                send(&mut ws, "events", json!({ "items": items }))?;
                in_flight = true;
            }
        }
        if Instant::now() >= next_metrics {
            send(&mut ws, "metrics", json!({ "ts": protocol::now_ms(), "values": sampler.sample() }))?;
            next_metrics = Instant::now() + interval;
        }
        if Instant::now() >= next_ping {
            send(&mut ws, "ping", json!({}))?;
            next_ping = Instant::now() + Duration::from_secs(25);
        }
        if let Some(msg) = recv(&mut ws)? {
            match msg["type"].as_str() {
                Some("ack") => {
                    if let Some(n) = msg["body"]["upTo"].as_i64() { buffer.ack(n).map_err(|e| e.to_string())?; }
                    in_flight = false;
                    // Les contenus que plus aucun événement en attente ne cite peuvent être effacés.
                    let needed: HashSet<String> = buffer.pending(100_000).map_err(|e| e.to_string())?.iter().filter_map(|e| e.body["sha"].as_str().map(String::from)).collect();
                    collector.watcher.purge_pending(&needed);
                    uploaded.retain(|s| needed.contains(s));
                }
                Some("action") => {
                    // Action NOMMÉE demandée par Corvus : validée par `actions::run`, jamais exécutée comme commande.
                    let name = msg["body"]["name"].as_str().unwrap_or("");
                    collector.scan_now(buffer);
                    let result = match collector.net_action(name, &msg["body"]["args"], buffer) {
                        Some(r) => r,
                        None => {
                            let ctx = actions::Context { roots: &collector.watcher.roots, agent_dir: &collector.agent_dir, allow_preview: collector.allow_preview };
                            actions::run(&ctx, name, &msg["body"]["args"])
                        }
                    };
                    let ts = protocol::now_ms() as i64;
                    let (ok, payload) = match &result { Ok(v) => (true, json!({ "data": v })), Err(e) => (false, json!({ "error": e })) };
                    let _ = buffer.push(ts, "action.done", &json!({ "name": name, "ok": ok, "path": msg["body"]["args"]["path"] }));
                    let mut body = json!({ "reqId": msg["id"], "ok": ok });
                    body.as_object_mut().unwrap().extend(payload.as_object().unwrap().clone());
                    send(&mut ws, "action_result", body)?;
                }
                Some("pong") => {}
                Some("error") => return Err(format!("erreur de Corvus : {}", msg["body"]["message"])),
                // Corvus ne peut envoyer aucune action pour l'instant ; tout le reste est ignoré.
                other => eprintln!("message ignoré : {other:?}"),
            }
        }
    }
}
