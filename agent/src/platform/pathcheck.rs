//! Validation de chemins POUR CHAQUE SYSTÈME. Fonctions pures (aucun accès au disque) : elles se testent sur les trois systèmes,
//! quel que soit celui où tourne la machine de test. Toute action ou option de l'agent qui reçoit un chemin passe par ici.
//!
//! Windows : `..`, chemins UNC (`\\serveur\partage`), espaces de noms d'appareils (`\\?\`, `\\.\`), flux de données alternatifs
//! (`fichier.txt:flux`, `::$DATA`), noms réservés (`CON`, `NUL`, `COM1`… même avec une extension), caractères interdits,
//! points et espaces finals (Windows les retire en silence : `a.` désigne `a`), et insensibilité à la casse.
//! macOS : chemins POSIX, mais système de fichiers insensible à la casse par défaut.

// Ces validateurs sont écrits et TESTÉS sur les trois systèmes (fonctions pures), mais chaque système n'utilise que les siens :
// sous Linux, ceux de Windows et macOS sont « inutilisés » sans que ce soit un oubli.
#![allow(dead_code)]

const MAX_PATH_CHARS: usize = 4096;

/// Noms que Windows traite comme des appareils, avec ou sans extension (`CON.txt` est `CON`).
const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
    "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn is_reserved_windows_name(component: &str) -> bool {
    // Le nom réservé est la partie avant le premier point, sans espaces finals (« CON .txt » reste réservé).
    let stem = component.split('.').next().unwrap_or("").trim_end_matches(' ');
    let upper = stem.to_ascii_uppercase();
    WINDOWS_RESERVED.contains(&upper.as_str())
        // COM¹ COM² COM³ et LPT¹ LPT² LPT³ (exposants) sont aussi des appareils pour Windows.
        || ["COM", "LPT"].iter().any(|p| upper.strip_prefix(p).is_some_and(|d| matches!(d, "\u{b9}" | "\u{b2}" | "\u{b3}")))
}

/// `None` = chemin acceptable comme chemin ABSOLU LOCAL Windows ; `Some(raison)` sinon.
pub fn windows_path_error(p: &str) -> Option<&'static str> {
    if p.is_empty() { return Some("chemin vide"); }
    if p.chars().count() > MAX_PATH_CHARS { return Some("chemin trop long"); }
    if p.chars().any(|c| c.is_control()) { return Some("caractère de contrôle (ou NUL) interdit"); }
    // UNC (\\serveur\partage, //serveur/partage) et espaces de noms d'appareils (\\?\, \\.\, \??\) : jamais.
    if p.starts_with("\\\\") || p.starts_with("//") || p.starts_with("\\??\\") { return Some("chemin UNC ou espace de noms d'appareil refusé"); }
    // Seule forme admise : lecteur local absolu « C:\… » ou « C:/… ».
    let b = p.as_bytes();
    if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || !(b[2] == b'\\' || b[2] == b'/') {
        return Some("chemin absolu avec lettre de lecteur requis (C:\\…)");
    }
    let rest = &p[3..];
    // « : » ailleurs que dans « C: » = flux de données alternatif (fichier.txt:flux, ::$DATA).
    if rest.contains(':') { return Some("flux de données alternatif (« : ») refusé"); }
    if rest.chars().any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*')) { return Some("caractère interdit sous Windows"); }
    for comp in rest.split(['\\', '/']) {
        if comp.is_empty() { continue; } // « C:\\a » : séparateur doublé, sans danger
        if comp == ".." { return Some("chemin non normalisé (« .. »)"); }
        if comp == "." { return Some("chemin non normalisé (« . »)"); }
        if comp.ends_with('.') || comp.ends_with(' ') { return Some("point ou espace final (Windows le retire en silence)"); }
        if is_reserved_windows_name(comp) { return Some("nom réservé Windows (CON, NUL, COM1…)"); }
    }
    None
}

/// `None` = chemin acceptable comme chemin ABSOLU POSIX (Linux, macOS) ; `Some(raison)` sinon.
pub fn posix_path_error(p: &str) -> Option<&'static str> {
    if p.is_empty() { return Some("chemin vide"); }
    if p.chars().count() > MAX_PATH_CHARS { return Some("chemin trop long"); }
    if p.contains('\0') || p.chars().any(|c| c.is_control()) { return Some("caractère de contrôle (ou NUL) interdit"); }
    if !p.starts_with('/') { return Some("chemin absolu requis"); }
    if p.split('/').any(|c| c == ".." || c == ".") { return Some("chemin non normalisé (« .. »)"); }
    None
}

fn norm_ci(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// `path` est-il `root` ou dessous, SANS tenir compte de la casse ni du type de séparateur (Windows, macOS) ?
/// La coupure doit tomber sur une frontière de dossier : `C:\Donnees2` n'est pas sous `C:\Donnees`.
pub fn is_within_ci(root: &str, path: &str) -> bool {
    let (r, p) = (norm_ci(root), norm_ci(path));
    if r.is_empty() { return false; }
    p == r || p.strip_prefix(&r).is_some_and(|rest| rest.starts_with('/'))
}

/// Fichiers secrets propres à Windows : leur modification est détectée, leur contenu n'est JAMAIS copié.
pub fn windows_is_secret(path: &str) -> bool {
    let lower = path.to_lowercase().replace('/', "\\");
    let name = lower.rsplit('\\').next().unwrap_or("");
    lower.contains("\\.ssh\\")
        || (lower.contains("\\ssh\\ssh_host_") && !lower.ends_with(".pub"))
        || lower.contains("\\microsoft\\crypto\\")
        || lower.contains("\\microsoft\\protect\\")
        || lower.contains("\\system32\\config\\")
        || [".pfx", ".p12", ".key", ".kdbx", ".secret"].iter().any(|e| name.ends_with(e))
        || matches!(name, "id_rsa" | "id_ed25519" | "ntds.dit")
}

/// Fichiers secrets propres à macOS (trousseaux, base des comptes).
pub fn macos_is_secret(path: &str) -> bool {
    let lower = path.to_lowercase();
    let name = lower.rsplit('/').next().unwrap_or("");
    lower.contains("/library/keychains/")
        || name.ends_with(".keychain") || name.ends_with(".keychain-db")
        || name == "master.passwd"
        || lower.contains("/var/db/dslocal/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_chemins_acceptes() {
        for p in [r"C:\Windows\System32\drivers\etc", "C:/ProgramData/ssh", r"D:\donnees\fichier.txt", r"c:\a\b\c", r"C:\Program Files\App", r"C:\\a"] {
            assert_eq!(windows_path_error(p), None, "{p}");
        }
    }

    #[test]
    fn windows_chemins_hostiles() {
        let bad = [
            "", r"relatif\fichier", r"C:fichier", r"C:", r"\Windows", "/etc/passwd",
            r"C:\a\..\b", r"C:\a\.\b", r"C:\..", "C:/a/../../b",
            r"\\serveur\partage\x", "//serveur/partage/x", r"\\?\C:\x", r"\\.\PhysicalDrive0", r"\??\C:\x",
            r"C:\a\fichier.txt:flux", r"C:\a\fichier.txt::$DATA", r"C:\a:b", r"C:\x\:bidon",
            r"C:\a\CON", r"C:\a\nul", r"C:\a\Aux.txt", r"C:\a\COM1", r"C:\a\com9.log", r"C:\a\LPT1", r"C:\a\LPT9.x", r"C:\a\CON .txt", "C:\\a\\COM\u{b9}", "C:\\a\\lpt\u{b2}.txt",
            r"C:\a\b.", r"C:\a\b ", r"C:\a. \b",
            "C:\\a\\b\0c", "C:\\a\\b\nc", "C:\\a\\b\tc",
            r"C:\a\b?", r"C:\a\*", r"C:\a\b|c", r"C:\a\<b>", "C:\\a\\\"b",
        ];
        for p in bad {
            assert!(windows_path_error(p).is_some(), "accepté à tort : {p:?}");
        }
        assert!(windows_path_error(&format!("C:\\{}", "a".repeat(5000))).is_some(), "trop long");
    }

    #[test]
    fn windows_noms_proches_mais_valides() {
        // Ces noms ressemblent à des noms réservés sans en être : ils doivent passer.
        for p in [r"C:\a\CONSOLE", r"C:\a\console.txt", r"C:\a\COM10", r"C:\a\LPT10", r"C:\a\NULL", r"C:\a\auxiliaire", r"C:\a\PRN2"] {
            assert_eq!(windows_path_error(p), None, "{p}");
        }
    }

    #[test]
    fn posix_chemins() {
        assert_eq!(posix_path_error("/etc"), None);
        assert_eq!(posix_path_error("/Library/LaunchDaemons"), None);
        for p in ["", "etc", "./etc", "/a/../b", "/a/./b", "/a\0b", "/a\nb", "..", "~/x"] {
            assert!(posix_path_error(p).is_some(), "accepté à tort : {p:?}");
        }
        assert!(posix_path_error(&format!("/{}", "a".repeat(5000))).is_some());
    }

    #[test]
    fn dessous_sans_tenir_compte_de_la_casse_ni_des_separateurs() {
        assert!(is_within_ci(r"C:\ProgramData\ssh", r"c:/programdata/SSH/sshd_config"));
        assert!(is_within_ci(r"C:\ProgramData\ssh\", r"C:\ProgramData\ssh"));
        assert!(is_within_ci("/Library/LaunchDaemons", "/library/launchdaemons/x.plist"));
        assert!(!is_within_ci(r"C:\Donnees", r"C:\Donnees2\x"), "la frontière de dossier compte");
        assert!(!is_within_ci(r"C:\Donnees", r"C:\Autre"));
        assert!(!is_within_ci("", r"C:\x"));
    }

    #[test]
    fn secrets_windows_et_macos() {
        for p in [r"C:\Users\a\.ssh\id_ed25519", r"C:\ProgramData\ssh\ssh_host_ed25519_key", r"C:\x\cert.PFX", r"C:\Windows\System32\config\SAM", r"C:\x\NTDS.DIT", r"c:/users/a/.ssh/config"] {
            assert!(windows_is_secret(p), "{p}");
        }
        assert!(!windows_is_secret(r"C:\ProgramData\ssh\ssh_host_ed25519_key.pub"));
        assert!(!windows_is_secret(r"C:\Windows\System32\drivers\etc\hosts"));
        for p in ["/Library/Keychains/System.keychain", "/Users/a/Library/Keychains/login.keychain-db", "/private/etc/master.passwd"] {
            assert!(macos_is_secret(p), "{p}");
        }
        assert!(!macos_is_secret("/private/etc/hosts"));
    }
}
