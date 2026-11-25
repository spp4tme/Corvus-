//! Surveillance des fichiers par balayage régulier (étape 6).
//!
//! Choix volontairement simple (adapté à un débutant en Rust) : toutes les quelques secondes on
//! parcourt les dossiers surveillés et on compare `(date, taille, inode)` à l'index mémorisé. Un
//! fichier qui a changé est relu, son empreinte SHA-256 calculée, et un événement est créé.
//! Avantage sur inotify/fanotify : aucune dépendance au noyau, aucune limite de « watches ».
//! Limite : un fichier modifié puis remis dans son état initial entre deux balayages passe inaperçu.
//!
//! Les contenus (≤ 512 Ko) sont copiés dans `pending/<sha>` jusqu'à ce que Corvus confirme les avoir
//! reçus : ils partent alors vers le serveur, qui garde l'historique (un ransomware sur l'hôte ne peut
//! donc pas le chiffrer).

use crate::state::{FileInfo, State};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// Au-delà, on suit le fichier (taille, date) mais on n'en garde pas le contenu.
pub const MAX_VERSION_BYTES: u64 = 512 * 1024;
/// Garde-fou : un balayage s'arrête après autant de fichiers (dossier surveillé par erreur trop gros).
const MAX_FILES: usize = 20_000;

/// Fichiers dont le CONTENU n'est jamais copié vers le serveur (secrets) : on détecte leur
/// modification (empreinte) sans jamais en transmettre le texte.
pub fn is_secret(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or("");
    path.starts_with("/etc/ssl/private")
        || (path.starts_with("/etc/ssh/ssh_host_") && !path.ends_with(".pub"))
        || path.contains("/private/")
        || name.starts_with("shadow")
        || name.starts_with("gshadow")
        || name.ends_with(".key")
        || name.ends_with(".secret")
        || name == "id_rsa"
        || name == "id_ed25519"
}

pub struct Watcher {
    pub roots: Vec<PathBuf>,
    pub pending_dir: PathBuf,
}

pub struct Change {
    pub kind: &'static str, // file.baseline | file.created | file.modified | file.meta | file.deleted
    pub body: Value,
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Entropie de Shannon en bits par octet (0 = uniforme, 8 = aléatoire). Un fichier chiffré approche 8 ;
/// du texte ou un document non compressé reste sous 6.
pub fn entropy(sample: &[u8]) -> Option<f64> {
    if sample.len() < 512 { return None; } // trop court pour être significatif
    let mut counts = [0u32; 256];
    for b in sample { counts[*b as usize] += 1; }
    let n = sample.len() as f64;
    Some(-counts.iter().filter(|c| **c > 0).map(|c| { let p = *c as f64 / n; p * p.log2() }).sum::<f64>())
}

const ENTROPY_SAMPLE: usize = 64 * 1024;

fn entropy_of_file(path: &Path, data: &Option<Vec<u8>>) -> Option<f64> {
    if let Some(d) = data { return entropy(&d[..d.len().min(ENTROPY_SAMPLE)]); }
    use std::io::Read;
    let mut buf = vec![0u8; ENTROPY_SAMPLE];
    let n = fs::File::open(path).ok()?.read(&mut buf).ok()?;
    entropy(&buf[..n])
}

fn info_of(path: &Path, md: &fs::Metadata, sha: Option<String>, entropy: Option<f64>) -> FileInfo {
    FileInfo {
        path: path.to_string_lossy().into_owned(), sha, size: md.len() as i64,
        mtime_ns: md.mtime() * 1_000_000_000 + md.mtime_nsec(), inode: md.ino() as i64,
        mode: md.mode() & 0o7777, uid: md.uid(), gid: md.gid(), entropy,
    }
}

fn body_of(f: &FileInfo, prev: Option<&FileInfo>) -> Value {
    let secret = is_secret(&f.path);
    let too_big = f.size as u64 > MAX_VERSION_BYTES;
    json!({
        "path": f.path, "sha": f.sha, "prevSha": prev.and_then(|p| p.sha.clone()), "size": f.size,
        "mode": f.mode, "uid": f.uid, "gid": f.gid,
        "entropy": f.entropy.map(|e| (e * 100.0).round() / 100.0), "prevEntropy": prev.and_then(|p| p.entropy).map(|e| (e * 100.0).round() / 100.0),
        "noContent": secret || too_big || f.sha.is_none(),
        "reason": if secret { "secret" } else if too_big { "trop-gros" } else { "" },
    })
}

impl Watcher {
    /// Un balayage complet. `baseline` = premier passage (état initial, pas des « créations »).
    pub fn scan(&self, state: &State, baseline: bool) -> Result<Vec<Change>, String> {
        let known: HashMap<String, FileInfo> = state.all_files().map_err(|e| e.to_string())?.into_iter().map(|f| (f.path.clone(), f)).collect();
        let mut seen: HashSet<String> = HashSet::new();
        let mut changes = Vec::new();
        let mut stack: Vec<PathBuf> = self.roots.clone();
        let mut count = 0usize;

        while let Some(p) = stack.pop() {
            let Ok(md) = fs::symlink_metadata(&p) else { continue };
            if md.file_type().is_symlink() { continue; }
            if md.is_dir() {
                if let Ok(rd) = fs::read_dir(&p) { stack.extend(rd.flatten().map(|e| e.path())); }
                continue;
            }
            if !md.is_file() { continue; }
            count += 1;
            if count > MAX_FILES { return Err(format!("plus de {MAX_FILES} fichiers sous la surveillance : réduisez les dossiers surveillés")); }
            let key = p.to_string_lossy().into_owned();
            seen.insert(key.clone());
            let prev = known.get(&key);
            let unchanged = prev.is_some_and(|k| k.size == md.len() as i64 && k.mtime_ns == md.mtime() * 1_000_000_000 + md.mtime_nsec() && k.inode == md.ino() as i64
                && k.mode == md.mode() & 0o7777 && k.uid == md.uid() && k.gid == md.gid());
            if unchanged { continue; }

            // Relecture + empreinte (sauf fichier trop gros : suivi sans contenu).
            let mut data: Option<Vec<u8>> = None;
            let sha = if md.len() <= MAX_VERSION_BYTES {
                match fs::read(&p) { Ok(d) => { let s = sha256_hex(&d); data = Some(d); Some(s) } Err(_) => None }
            } else { None };
            let ent = entropy_of_file(&p, &data);
            let info = info_of(&p, &md, sha.clone(), ent);
            let same_content = prev.is_some_and(|k| k.sha == sha && sha.is_some());
            let kind = match prev {
                None if baseline => "file.baseline",
                None => "file.created",
                Some(_) if same_content => "file.meta",
                Some(_) => "file.modified",
            };
            if let (Some(d), Some(s)) = (&data, &sha) {
                if !is_secret(&info.path) && !same_content { self.keep_content(s, d); }
            }
            changes.push(Change { kind, body: body_of(&info, prev) });
            state.put_file(&info).map_err(|e| e.to_string())?;
        }
        // Fichiers disparus (seulement ceux qui étaient sous les racines actuelles).
        for (path, old) in &known {
            if !seen.contains(path) && self.roots.iter().any(|r| Path::new(path).starts_with(r)) {
                changes.push(Change { kind: "file.deleted", body: body_of(old, Some(old)) });
                state.remove_file(path).map_err(|e| e.to_string())?;
            }
        }
        Ok(changes)
    }

    fn keep_content(&self, sha: &str, data: &[u8]) {
        let _ = fs::create_dir_all(&self.pending_dir);
        let f = self.pending_dir.join(sha);
        if !f.exists() { let _ = fs::write(f, data); }
    }

    /// Contenu en attente d'envoi (None si déjà envoyé / jamais conservé).
    pub fn pending_content(&self, sha: &str) -> Option<Vec<u8>> {
        if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
        fs::read(self.pending_dir.join(sha)).ok()
    }

    /// Supprime les contenus que plus aucun événement en attente ne référence.
    pub fn purge_pending(&self, still_needed: &HashSet<String>) {
        let Ok(rd) = fs::read_dir(&self.pending_dir) else { return };
        for e in rd.flatten() {
            if let Some(name) = e.file_name().to_str() {
                if !still_needed.contains(name) { let _ = fs::remove_file(e.path()); }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dossier(nom: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("corvus-watch-{nom}-{}", rand::random::<u64>()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn detecte_creation_modification_suppression() {
        let racine = dossier("r");
        let data = dossier("d");
        let etat = State::open(&data.join("state.db")).unwrap();
        let w = Watcher { roots: vec![racine.clone()], pending_dir: data.join("pending") };
        fs::write(racine.join("a.conf"), "un").unwrap();

        let c = w.scan(&etat, true).unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].kind, "file.baseline");
        assert!(w.scan(&etat, false).unwrap().is_empty(), "rien n'a changé");

        fs::write(racine.join("b.conf"), "deux").unwrap();
        let c = w.scan(&etat, false).unwrap();
        assert_eq!((c.len(), c[0].kind), (1, "file.created"));

        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(racine.join("a.conf"), "un modifié").unwrap();
        let c = w.scan(&etat, false).unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].kind, "file.modified");
        assert_ne!(c[0].body["sha"], c[0].body["prevSha"]);
        assert!(w.pending_content(c[0].body["sha"].as_str().unwrap()).is_some());

        fs::remove_file(racine.join("b.conf")).unwrap();
        let c = w.scan(&etat, false).unwrap();
        assert_eq!((c.len(), c[0].kind), (1, "file.deleted"));
    }

    #[test]
    fn les_secrets_sont_suivis_sans_contenu() {
        assert!(is_secret("/etc/shadow"));
        assert!(is_secret("/etc/ssh/ssh_host_ed25519_key"));
        assert!(!is_secret("/etc/ssh/ssh_host_ed25519_key.pub"));
        assert!(!is_secret("/etc/hosts"));
        let racine = dossier("s");
        let data = dossier("sd");
        let etat = State::open(&data.join("state.db")).unwrap();
        let w = Watcher { roots: vec![racine.clone()], pending_dir: data.join("pending") };
        fs::write(racine.join("mon.key"), "secret").unwrap();
        let c = w.scan(&etat, false).unwrap();
        assert_eq!(c[0].body["noContent"], true);
        assert!(w.pending_content(c[0].body["sha"].as_str().unwrap()).is_none(), "le contenu d'un secret n'est jamais conservé");
    }

    #[test]
    fn un_changement_de_droits_est_un_evenement_meta() {
        use std::os::unix::fs::PermissionsExt;
        let racine = dossier("m");
        let data = dossier("md");
        let etat = State::open(&data.join("state.db")).unwrap();
        let w = Watcher { roots: vec![racine.clone()], pending_dir: data.join("pending") };
        fs::write(racine.join("x"), "x").unwrap();
        w.scan(&etat, true).unwrap();
        fs::set_permissions(racine.join("x"), fs::Permissions::from_mode(0o600)).unwrap();
        let c = w.scan(&etat, false).unwrap();
        assert_eq!(c[0].kind, "file.meta");
    }
}

#[cfg(test)]
mod tests_entropie {
    use super::*;

    #[test]
    fn texte_bas_aleatoire_haut() {
        let texte = "Bonjour, ceci est un document de test assez ordinaire. ".repeat(100);
        assert!(entropy(texte.as_bytes()).unwrap() < 5.0);
        let alea: Vec<u8> = (0..65536u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8 ^ (i >> 5) as u8).collect();
        assert!(entropy(&alea).unwrap() > 7.5, "{:?}", entropy(&alea));
        assert!(entropy(b"court").is_none());
    }
}
