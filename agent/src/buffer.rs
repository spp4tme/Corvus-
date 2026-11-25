//! Tampon local SQLite : les événements sont numérotés (`seq`) et conservés jusqu'à ce que Corvus
//! confirme les avoir reçus (« ack »). Si la connexion tombe, rien n'est perdu : le renvoi est
//! sans effet côté serveur grâce à la contrainte UNIQUE (agent, seq).

use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::Path;

pub struct Buffer {
    db: Connection,
}

pub struct Event {
    pub seq: i64,
    pub ts: i64,
    pub kind: String,
    pub body: Value,
}

impl Buffer {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let db = Connection::open(path)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS events (
                seq  INTEGER PRIMARY KEY AUTOINCREMENT,
                ts   INTEGER NOT NULL,
                kind TEXT NOT NULL,
                body TEXT NOT NULL
             );",
        )?;
        Ok(Self { db })
    }

    /// Ajoute un événement ; retourne son numéro.
    pub fn push(&self, ts: i64, kind: &str, body: &Value) -> rusqlite::Result<i64> {
        self.db.execute(
            "INSERT INTO events (ts, kind, body) VALUES (?1, ?2, ?3)",
            params![ts, kind, body.to_string()],
        )?;
        Ok(self.db.last_insert_rowid())
    }

    /// Événements pas encore confirmés, du plus ancien au plus récent (par lot).
    pub fn pending(&self, limit: usize) -> rusqlite::Result<Vec<Event>> {
        let mut stmt = self.db.prepare("SELECT seq, ts, kind, body FROM events ORDER BY seq LIMIT ?1")?;
        let rows = stmt.query_map([limit as i64], |r| {
            let body: String = r.get(3)?;
            Ok(Event { seq: r.get(0)?, ts: r.get(1)?, kind: r.get(2)?, body: serde_json::from_str(&body).unwrap_or(Value::Null) })
        })?;
        rows.collect()
    }

    /// Supprime tout ce que Corvus a confirmé (numéros ≤ `up_to`).
    pub fn ack(&self, up_to: i64) -> rusqlite::Result<usize> {
        self.db.execute("DELETE FROM events WHERE seq <= ?1", [up_to])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tampon() -> Buffer {
        let dir = std::env::temp_dir().join(format!("corvus-agent-test-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        Buffer::open(&dir.join("buffer.db")).unwrap()
    }

    #[test]
    fn les_evenements_restent_jusqu_a_l_ack() {
        let t = tampon();
        let a = t.push(1, "boot", &json!({"x": 1})).unwrap();
        let b = t.push(2, "autre", &json!({})).unwrap();
        assert_eq!((a, b), (1, 2));
        assert_eq!(t.pending(10).unwrap().len(), 2);
        t.ack(1).unwrap();
        let reste = t.pending(10).unwrap();
        assert_eq!(reste.len(), 1);
        assert_eq!(reste[0].seq, 2);
        assert_eq!(reste[0].kind, "autre");
    }

    #[test]
    fn les_numeros_ne_sont_jamais_reutilises() {
        let t = tampon();
        t.push(1, "a", &json!({})).unwrap();
        t.ack(1).unwrap();
        // AUTOINCREMENT : après un ack, le numéro suivant est 2, pas 1 (sinon le serveur ignorerait l'événement).
        assert_eq!(t.push(2, "b", &json!({})).unwrap(), 2);
    }
}
