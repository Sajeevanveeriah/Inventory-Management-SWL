//! Native capabilities for the SWL Pricing and Inventory Control desktop shell.
//!
//! The frontend is the same local-first web application; the shell adds only
//! two capabilities: a native output-folder picker and safe file writing into
//! that folder. All filenames are sanitised here so a compromised or buggy
//! frontend can never traverse outside the operator-chosen folder.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MAX_EXPORT_BYTES: usize = 50 * 1024 * 1024;

struct Database(Mutex<Connection>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopHealth {
    ok: bool,
    provider: &'static str,
    live_search_configured: bool,
    fixture_mode: bool,
    schema_version: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalInput {
    item_id: String,
    approved_by: String,
    proposed_sell_cents: i64,
    reason: String,
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(format!("{label} is invalid."));
    }
    Ok(())
}

fn open_database(path: &Path) -> Result<Connection, String> {
    let mut connection = Connection::open(path)
        .map_err(|_| "The local database could not be opened.".to_string())?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
        .map_err(|_| "The local database safety settings could not be enabled.".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|_| "The database migration could not start.".to_string())?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_metadata(version INTEGER NOT NULL);
         INSERT INTO schema_metadata(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_metadata);
         CREATE TABLE IF NOT EXISTS catalogue_items(
           id TEXT PRIMARY KEY, item_number TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
           cost_cents INTEGER NOT NULL CHECK(cost_cents >= 0), sell_price_cents INTEGER NOT NULL CHECK(sell_price_cents >= 0),
           gst_basis TEXT NOT NULL CHECK(gst_basis IN ('inc-gst','ex-gst','unknown')), updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS approvals(
           id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES catalogue_items(id) ON DELETE RESTRICT,
           approved_by TEXT NOT NULL, proposed_sell_cents INTEGER NOT NULL CHECK(proposed_sell_cents >= 0),
           reason TEXT NOT NULL, approved_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS price_history(
           id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES catalogue_items(id) ON DELETE RESTRICT,
           cost_cents INTEGER NOT NULL CHECK(cost_cents >= 0), sell_price_cents INTEGER NOT NULL CHECK(sell_price_cents >= 0),
           approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE RESTRICT, recorded_at TEXT NOT NULL);
         CREATE TRIGGER IF NOT EXISTS price_history_no_update BEFORE UPDATE ON price_history BEGIN SELECT RAISE(ABORT, 'append-only'); END;
         CREATE TRIGGER IF NOT EXISTS price_history_no_delete BEFORE DELETE ON price_history BEGIN SELECT RAISE(ABORT, 'append-only'); END;
         CREATE TABLE IF NOT EXISTS competitor_references(
           id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES catalogue_items(id) ON DELETE RESTRICT,
           observation_json TEXT NOT NULL, attached_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS source_registry(id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS mapping_profiles(id TEXT PRIMARY KEY, profile_json TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS approved_aliases(supplier_code TEXT PRIMARY KEY, item_number TEXT NOT NULL, approved_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY CHECK(id='settings'), settings_json TEXT NOT NULL, updated_at TEXT NOT NULL);"
    ).map_err(|_| "The database migration failed; existing data was not changed.".to_string())?;
    transaction
        .commit()
        .map_err(|_| "The database migration could not be committed.".to_string())?;
    connection
        .execute_batch("PRAGMA integrity_check;")
        .map_err(|_| "The local database failed its integrity check.".to_string())?;
    Ok(connection)
}

/// Windows reserved device names that must not be used as file stems.
const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Reduce an arbitrary requested filename to a safe basename:
/// no directory components, no Windows-invalid characters, no reserved device
/// names, no trailing dots or spaces, bounded length, never empty.
pub fn sanitise_filename(requested: &str) -> String {
    // Keep only the final path component regardless of separator style.
    let base = requested
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .trim();

    let mut cleaned: String = base
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();

    // Windows rejects names ending in a dot or space.
    while cleaned.ends_with('.') || cleaned.ends_with(' ') {
        cleaned.pop();
    }

    cleaned = cleaned.chars().take(180).collect();

    let stem = cleaned.split('.').next().unwrap_or_default().to_uppercase();
    if cleaned.is_empty() || WINDOWS_RESERVED.contains(&stem.as_str()) {
        return format!("swl-output-{cleaned}");
    }
    cleaned
}

/// A destination folder is only acceptable when it exists, is a directory and
/// is expressed as an absolute path (as returned by the native picker).
fn validate_folder(folder: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(folder);
    if !path.is_absolute() {
        return Err("The output folder must be an absolute path.".into());
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("The output folder path must not contain '..'.".into());
    }
    if !path.is_dir() {
        return Err("The output folder does not exist or is not a folder.".into());
    }
    Ok(path)
}

#[tauri::command]
async fn choose_output_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    match picked {
        Some(folder) => {
            let path: PathBuf = folder
                .into_path()
                .map_err(|_| "The chosen folder path could not be resolved.".to_string())?;
            Ok(Some(path.to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}

#[tauri::command]
async fn write_export_file(
    folder: String,
    filename: String,
    contents: Vec<u8>,
) -> Result<String, String> {
    if contents.is_empty() || contents.len() > MAX_EXPORT_BYTES {
        return Err("The output file size is outside the supported range.".into());
    }
    let dir = validate_folder(&folder)?;
    let safe_name = sanitise_filename(&filename);
    let destination: PathBuf = dir.join(&safe_name);
    // Defence in depth: the joined path must stay inside the chosen folder.
    if destination.parent() != Some(dir.as_path()) {
        return Err("The output filename resolved outside the chosen folder.".into());
    }
    if destination.exists() {
        return Err("A file with this name already exists. No file was overwritten.".into());
    }
    let temporary = dir.join(format!(".swl-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&contents)?;
        file.flush()?;
        file.sync_all()?;
        if file.metadata()?.len() != contents.len() as u64 {
            return Err(io::Error::new(io::ErrorKind::WriteZero, "length mismatch"));
        }
        fs::rename(&temporary, &destination)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "The file could not be written safely: {}.",
            error.kind()
        ));
    }
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
fn desktop_health(database: tauri::State<'_, Database>) -> Result<DesktopHealth, String> {
    let connection = database
        .0
        .lock()
        .map_err(|_| "The local database is busy.".to_string())?;
    let schema_version = connection
        .query_row("SELECT version FROM schema_metadata LIMIT 1", [], |row| {
            row.get(0)
        })
        .map_err(|_| "The database schema could not be read.".to_string())?;
    Ok(DesktopHealth {
        ok: true,
        provider: "not-configured",
        live_search_configured: false,
        fixture_mode: false,
        schema_version,
    })
}

#[tauri::command]
fn append_approval(
    database: tauri::State<'_, Database>,
    input: ApprovalInput,
) -> Result<String, String> {
    validate_identifier(&input.item_id, "Item identifier")?;
    validate_identifier(&input.approved_by, "Approver")?;
    if !(0..=1_000_000_000).contains(&input.proposed_sell_cents) || input.reason.len() > 1000 {
        return Err("The approval values are outside the supported range.".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let connection = database
        .0
        .lock()
        .map_err(|_| "The local database is busy.".to_string())?;
    connection.execute("INSERT INTO approvals(id,item_id,approved_by,proposed_sell_cents,reason,approved_at) VALUES(?1,?2,?3,?4,?5,datetime('now'))",
        params![id, input.item_id, input.approved_by, input.proposed_sell_cents, input.reason])
        .map_err(|_| "The approval could not be recorded.".to_string())?;
    Ok(id)
}

#[tauri::command]
fn shell_info() -> serde_json::Value {
    serde_json::json!({
        "shell": "tauri",
        "os": std::env::consts::OS,
        "version": env!("CARGO_PKG_VERSION"),
    })
}

/// Referenced by `main.rs`; also usable as a mobile/library entry point.
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            fs::create_dir_all(&data_dir)?;
            let database =
                open_database(&data_dir.join("swl-pricing.sqlite3")).map_err(io::Error::other)?;
            app.manage(Database(Mutex::new(database)));
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            choose_output_folder,
            write_export_file,
            shell_info,
            desktop_health,
            append_approval
        ])
        .run(tauri::generate_context!())
        .expect("error while running the SWL desktop application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn keeps_ordinary_export_names() {
        assert_eq!(
            sanitise_filename("20260805_demo_import_run-abc.xlsx"),
            "20260805_demo_import_run-abc.xlsx"
        );
    }

    #[test]
    fn strips_directory_components_in_both_separator_styles() {
        assert_eq!(sanitise_filename("../../etc/passwd"), "passwd");
        assert_eq!(
            sanitise_filename("C:\\Windows\\system32\\evil.dll"),
            "evil.dll"
        );
        assert_eq!(sanitise_filename("a/b/c/report.xlsx"), "report.xlsx");
    }

    #[test]
    fn replaces_windows_invalid_characters() {
        assert_eq!(
            sanitise_filename("a<b>c:d\"e|f?g*h.txt"),
            "a_b_c_d_e_f_g_h.txt"
        );
        assert_eq!(sanitise_filename("tab\there.txt"), "tab_here.txt");
    }

    #[test]
    fn removes_trailing_dots_and_spaces() {
        assert_eq!(sanitise_filename("report.xlsx. . "), "report.xlsx");
    }

    #[test]
    fn refuses_reserved_device_names_and_empty_names() {
        assert_eq!(sanitise_filename("CON.txt"), "swl-output-CON.txt");
        assert_eq!(sanitise_filename("aux"), "swl-output-aux");
        assert_eq!(sanitise_filename("   "), "swl-output-");
    }

    #[test]
    fn bounds_filename_length() {
        let long = "x".repeat(400) + ".xlsx";
        assert!(sanitise_filename(&long).len() <= 180);
    }

    #[test]
    fn unicode_filename_truncation_is_safe() {
        let value = format!("{}-report.xlsx", "🔐".repeat(200));
        let cleaned = sanitise_filename(&value);
        assert!(cleaned.chars().count() <= 180);
    }

    #[test]
    fn database_migration_is_idempotent_and_enforces_foreign_keys() {
        let path = std::env::temp_dir().join(format!("swl-{}.sqlite3", uuid::Uuid::new_v4()));
        let connection = open_database(&path).unwrap();
        drop(connection);
        let connection = open_database(&path).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT version FROM schema_metadata", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(connection.execute("INSERT INTO approvals(id,item_id,approved_by,proposed_sell_cents,reason,approved_at) VALUES('a','missing','operator',100,'test','now')", []).is_err());
        drop(connection);
        fs::remove_file(path).ok();
    }

    #[test]
    fn rejects_relative_and_traversal_folders() {
        assert!(validate_folder("relative/path").is_err());
        let root = if cfg!(windows) {
            "C:\\definitely\\missing\\.."
        } else {
            "/definitely/missing/.."
        };
        assert!(validate_folder(root).is_err());
    }

    #[test]
    fn accepts_a_real_absolute_folder() {
        let dir = std::env::temp_dir();
        assert!(validate_folder(&dir.to_string_lossy()).is_ok());
    }

    #[test]
    fn write_stays_inside_the_chosen_folder() {
        let dir = std::env::temp_dir().join("swl-desktop-test");
        fs::create_dir_all(&dir).unwrap();
        let dirs = dir.to_string_lossy().into_owned();
        let safe = sanitise_filename("../escape.txt");
        let destination = Path::new(&dirs).join(&safe);
        assert_eq!(destination.parent().unwrap(), dir.as_path());
        fs::remove_dir_all(&dir).ok();
    }
}
