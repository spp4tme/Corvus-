//! corvus-agent — petit programme installé sur un hôte. Il se CONNECTE à Corvus (aucun port ouvert
//! sur l'hôte), s'authentifie par signature Ed25519 dans les deux sens, puis envoie métriques et
//! événements. Corvus ne peut lui envoyer AUCUNE commande shell.
//!
//! Usage :
//!   corvus-agent enroll --server https://corvus.exemple.ts.net --token <jeton>   (une seule fois)
//!   corvus-agent run                                                              (service)

mod buffer;
mod identity;
mod metrics;
mod protocol;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use buffer::Buffer;
use ed25519_dalek::SigningKey;
use identity::{websocket_url, Identity};
use rand::rngs::OsRng;
use serde_json::{json, Value};
use std::{env, path::PathBuf, process, thread, time::{Duration, Instant}};
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

fn capabilities() -> Value {
    // Fonctions avancées : désactivées pour l'instant (étapes 6 et 7).
    json!({ "metrics": true, "fanotify": false, "ebpf": false, "snapshots": false })
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
            "capabilities": capabilities(),
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
    buffer.push(protocol::now_ms() as i64, "agent.start", &json!({ "version": VERSION })).map_err(|e| e.to_string())?;

    // Reconnexion automatique : 1 s, 2 s, 4 s… jusqu'à 30 s. Le tampon garde les événements entre-temps.
    let mut wait = 1u64;
    loop {
        let started = Instant::now();
        match session(&identity, &buffer, interval) {
            Ok(()) => eprintln!("connexion fermée par Corvus"),
            Err(e) => eprintln!("connexion perdue : {e}"),
        }
        // Une session qui a duré a réussi à se connecter : on repart de 1 s.
        wait = if started.elapsed() > Duration::from_secs(60) { 1 } else { (wait * 2).min(30) };
        eprintln!("nouvelle tentative dans {wait} s");
        thread::sleep(Duration::from_secs(wait));
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
fn session(identity: &Identity, buffer: &Buffer, interval: Duration) -> Result<(), String> {
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

    send(&mut ws, "hello_agent", json!({ "version": VERSION, "capabilities": capabilities() }))?;

    set_read_timeout(&ws, Duration::from_secs(1));
    let mut sampler = metrics::Sampler::default();
    let mut next_metrics = Instant::now();
    let mut next_ping = Instant::now() + Duration::from_secs(25);
    let mut in_flight = false; // un lot attend son « ack » : on n'en envoie pas un second

    loop {
        // Événements du tampon (envoyés tant que Corvus ne les a pas confirmés).
        if !in_flight {
            let pending = buffer.pending(200).map_err(|e| e.to_string())?;
            if !pending.is_empty() {
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
                }
                Some("pong") => {}
                Some("error") => return Err(format!("erreur de Corvus : {}", msg["body"]["message"])),
                // Corvus ne peut envoyer aucune action pour l'instant ; tout le reste est ignoré.
                other => eprintln!("message ignoré : {other:?}"),
            }
        }
    }
}
