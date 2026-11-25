//! État persistant de l'agent (SQLite) : l'index des fichiers connus et quelques valeurs
//! mémorisées (ex. position de lecture dans un journal). Séparé du tampon d'événements.

use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub struct State {
    db: Connection,
}

/// Ce que l'on sait d'un fichier au dernier passage.
#[derive(Clone, Debug, PartialEq)]
pub struct FileInfo {
    pub path: String,
    pub sha: Option<String>, // None : trop gros ou illisible (on suit la taille/date seulement)
    pub size: i64,
    pub mtime_ns: i64,
    pub inode: i64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub entropy: Option<f64>, // entropie de Shannon (bits/octet) des 64 premiers Ko : ~7,9 = chiffré ou compressé
}

impl State {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let db = Connection::open(path)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS files (
                path TEXT PRIMARY KEY, sha TEXT, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL,
                inode INTEGER NOT NULL, mode INTEGER NOT NULL, uid INTEGER NOT NULL, gid INTEGER NOT NULL
             ) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;",
        )?;
        // Colonne ajoutée après la première version : l'erreur « existe déjà » est normale.
        let _ = db.execute("ALTER TABLE files ADD COLUMN entropy REAL", []);
        Ok(Self { db })
    }

    pub fn all_files(&self) -> rusqlite::Result<Vec<FileInfo>> {
        let mut st = self.db.prepare("SELECT path, sha, size, mtime_ns, inode, mode, uid, gid, entropy FROM files")?;
        let rows = st.query_map([], |r| Ok(FileInfo {
            path: r.get(0)?, sha: r.get(1)?, size: r.get(2)?, mtime_ns: r.get(3)?, inode: r.get(4)?,
            mode: r.get::<_, i64>(5)? as u32, uid: r.get::<_, i64>(6)? as u32, gid: r.get::<_, i64>(7)? as u32, entropy: r.get(8)?,
        }))?;
        rows.collect()
    }

    pub fn put_file(&self, f: &FileInfo) -> rusqlite::Result<()> {
        self.db.execute(
            "INSERT OR REPLACE INTO files (path, sha, size, mtime_ns, inode, mode, uid, gid, entropy) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![f.path, f.sha, f.size, f.mtime_ns, f.inode, f.mode as i64, f.uid as i64, f.gid as i64, f.entropy],
        )?;
        Ok(())
    }

    pub fn remove_file(&self, path: &str) -> rusqlite::Result<()> {
        self.db.execute("DELETE FROM files WHERE path = ?1", [path])?;
        Ok(())
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.db.query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0)).optional().ok().flatten()
    }

    pub fn set(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.db.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?1, ?2)", params![key, value])?;
        Ok(())
    }
}
