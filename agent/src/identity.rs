//! Identité de l'agent : sa clé privée Ed25519 (qui ne quitte jamais cette machine), la clé
//! publique de Corvus (reçue à l'enrôlement) et l'adresse du serveur. Fichier 0600 (Unix) ou à ACL restrictive (Windows).

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use std::{fs, io, path::Path};

#[derive(Serialize, Deserialize)]
pub struct Identity {
    pub server: String,
    pub agent_id: String,
    /// Clé publique de Corvus (base64) : sert à vérifier QUE c'est bien lui qui répond.
    pub server_public_key: String,
    /// Clé privée de l'agent (32 octets, base64).
    pub secret_key: String,
}

impl Identity {
    pub fn signing_key(&self) -> Result<SigningKey, String> {
        let bytes: [u8; 32] = B64
            .decode(&self.secret_key)
            .map_err(|e| format!("clé privée illisible : {e}"))?
            .try_into()
            .map_err(|_| "clé privée : 32 octets attendus".to_string())?;
        Ok(SigningKey::from_bytes(&bytes))
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        self.save_with(path, crate::platform::harden_secret)
    }

    fn save_with(&self, path: &Path, harden: impl Fn(&Path) -> io::Result<()>) -> io::Result<()> {
        let tmp = path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(self).map_err(io::Error::other)?;
        // Fichier VIDE d'abord, protégé (0600 sous Linux et macOS, ACL restrictive sous Windows), puis seulement rempli :
        // la clé privée n'est jamais, même un instant, dans un fichier lisible par un autre compte. Échec = erreur et
        // aucun fichier ne reste : on ne garde pas une clé qu'on n'a pas pu protéger.
        let ecrit = fs::write(&tmp, b"").and_then(|()| harden(&tmp)).and_then(|()| fs::write(&tmp, bytes));
        if let Err(e) = ecrit {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        fs::rename(tmp, path) // écriture atomique : jamais de fichier à moitié écrit
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        let text = fs::read_to_string(path)
            .map_err(|e| format!("identité introuvable ({}): {e}. Lancez d'abord « corvus-agent enroll ».", path.display()))?;
        serde_json::from_str(&text).map_err(|e| format!("identité illisible : {e}"))
    }
}

/// « https://corvus.exemple.ts.net/ » → « wss://corvus.exemple.ts.net/agent ».
pub fn websocket_url(server: &str) -> Result<String, String> {
    let s = server.trim().trim_end_matches('/');
    if let Some(rest) = s.strip_prefix("https://") {
        Ok(format!("wss://{rest}/agent"))
    } else if let Some(rest) = s.strip_prefix("http://") {
        Ok(format!("ws://{rest}/agent"))
    } else {
        Err("l'adresse du serveur doit commencer par https:// (ou http:// pour un test local)".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adresse_websocket() {
        assert_eq!(websocket_url("https://c.ts.net/").unwrap(), "wss://c.ts.net/agent");
        assert_eq!(websocket_url("http://127.0.0.1:7680").unwrap(), "ws://127.0.0.1:7680/agent");
        assert!(websocket_url("ftp://x").is_err());
    }

    #[test]
    fn aller_retour_sur_disque() {
        let dir = std::env::temp_dir().join(format!("corvus-id-{}", rand::random::<u64>()));
        fs::create_dir_all(&dir).unwrap();
        let id = Identity { server: "https://x".into(), agent_id: "ab".into(), server_public_key: "k".into(), secret_key: B64.encode([7u8; 32]) };
        id.save(&dir.join("identity.json")).unwrap();
        let back = Identity::load(&dir.join("identity.json")).unwrap();
        assert_eq!(back.agent_id, "ab");
        assert_eq!(back.signing_key().unwrap().to_bytes(), [7u8; 32]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(dir.join("identity.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    /// La clé privée ne doit JAMAIS être écrite dans un fichier pas encore protégé : au moment où la protection est posée,
    /// le fichier temporaire existe mais ne contient encore rien.
    #[test]
    fn la_cle_n_est_ecrite_qu_apres_la_protection_du_fichier() {
        let dir = std::env::temp_dir().join(format!("corvus-id-{}", rand::random::<u64>()));
        fs::create_dir_all(&dir).unwrap();
        let id = Identity { server: "https://x".into(), agent_id: "ab".into(), server_public_key: "k".into(), secret_key: B64.encode([7u8; 32]) };
        let vu = std::cell::Cell::new(None);
        id.save_with(&dir.join("identity.json"), |tmp| {
            vu.set(Some(fs::metadata(tmp).unwrap().len()));
            Ok(())
        })
        .unwrap();
        assert_eq!(vu.get(), Some(0), "le fichier contenait déjà la clé quand on l'a protégé");
        // Un échec de protection ne laisse ni clé, ni fichier temporaire.
        let r = id.save_with(&dir.join("autre.json"), |_| Err(io::Error::other("refus")));
        assert!(r.is_err() && !dir.join("autre.json").exists() && !dir.join("autre.tmp").exists());
    }
}
