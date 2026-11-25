//! Protocole Corvus ↔ agent (version 1). Voir docs/protocole-agent.md.
//!
//! Chaque message est une « enveloppe » JSON : { v, id, type, ts, body }.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde_json::{json, Value};

pub const PROTOCOL: u64 = 1;

/// Fabrique une enveloppe prête à être envoyée.
pub fn envelope(kind: &str, body: Value) -> String {
    let id: u64 = rand::random();
    json!({ "v": PROTOCOL, "id": format!("{id:016x}"), "type": kind, "ts": now_ms(), "body": body }).to_string()
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Texte réellement signé : le rôle (« agent » ou « server ») est inclus pour qu'une signature
/// faite pour l'un ne puisse jamais être rejouée comme celle de l'autre.
pub fn signed_text(role: &str, challenge_b64: &str) -> Vec<u8> {
    format!("corvus-agent-v{PROTOCOL}|{role}|{challenge_b64}").into_bytes()
}

/// Signe le défi du serveur avec la clé privée de l'agent (résultat en base64).
pub fn sign_challenge(key: &SigningKey, challenge_b64: &str) -> String {
    let sig: Signature = key.sign(&signed_text("agent", challenge_b64));
    B64.encode(sig.to_bytes())
}

/// Vérifie que le serveur a bien signé NOTRE défi avec la clé publique reçue à l'enrôlement.
pub fn verify_server(server_public_b64: &str, my_challenge_b64: &str, signature_b64: &str) -> Result<(), String> {
    let pk_bytes: [u8; 32] = B64
        .decode(server_public_b64)
        .map_err(|e| format!("clé du serveur illisible : {e}"))?
        .try_into()
        .map_err(|_| "clé du serveur : 32 octets attendus".to_string())?;
    let key = VerifyingKey::from_bytes(&pk_bytes).map_err(|e| format!("clé du serveur invalide : {e}"))?;
    let sig_bytes: [u8; 64] = B64
        .decode(signature_b64)
        .map_err(|e| format!("signature illisible : {e}"))?
        .try_into()
        .map_err(|_| "signature : 64 octets attendus".to_string())?;
    key.verify(&signed_text("server", my_challenge_b64), &Signature::from_bytes(&sig_bytes))
        .map_err(|_| "signature du serveur INVALIDE : connexion abandonnée".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;

    #[test]
    fn la_signature_du_serveur_est_verifiee() {
        let serveur = SigningKey::generate(&mut OsRng);
        let pub_b64 = B64.encode(serveur.verifying_key().to_bytes());
        let defi = "AAAA";
        let sig: Signature = serveur.sign(&signed_text("server", defi));
        assert!(verify_server(&pub_b64, defi, &B64.encode(sig.to_bytes())).is_ok());
        // Autre défi → refus.
        assert!(verify_server(&pub_b64, "BBBB", &B64.encode(sig.to_bytes())).is_err());
        // Signature faite avec le rôle « agent » → refus (le rôle est dans le texte signé).
        let sig_agent: Signature = serveur.sign(&signed_text("agent", defi));
        assert!(verify_server(&pub_b64, defi, &B64.encode(sig_agent.to_bytes())).is_err());
    }

    #[test]
    fn la_signature_de_l_agent_a_le_role_agent() {
        let agent = SigningKey::generate(&mut OsRng);
        let sig = sign_challenge(&agent, "defi");
        let bytes: [u8; 64] = B64.decode(sig).unwrap().try_into().unwrap();
        assert!(agent.verifying_key().verify(&signed_text("agent", "defi"), &Signature::from_bytes(&bytes)).is_ok());
        assert!(agent.verifying_key().verify(&signed_text("server", "defi"), &Signature::from_bytes(&bytes)).is_err());
    }
}
