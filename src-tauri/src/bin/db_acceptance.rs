//! Test-only installed-data probe. This binary is gated behind the
//! `acceptance-tools` feature and is never part of the production bundle.

use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const APPLICATION_IDENTIFIER: &str = "au.com.stanwoottonlocksmiths.swl-pricing";
const DATABASE_FILENAME: &str = "swl-pricing.sqlite3";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AcceptanceEvidence {
    integrity: &'static str,
    schema_version: i64,
    catalogue_items: i64,
    approvals: i64,
    price_history: i64,
    competitor_references: i64,
    sources: i64,
    profiles: i64,
    aliases: i64,
    settings: i64,
    catalogue_item_ids: Vec<String>,
    approval_ids: Vec<String>,
    approval_item_ids: Vec<String>,
    price_history_ids: Vec<String>,
    price_history_item_ids: Vec<String>,
    price_history_approval_ids: Vec<String>,
    verified_migration_backups: Vec<MigrationBackupEvidence>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AcceptanceRecordCounts {
    catalogue_items: i64,
    approvals: i64,
    price_history: i64,
    competitor_references: i64,
    sources: i64,
    profiles: i64,
    aliases: i64,
    settings: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationBackupEvidence {
    id: String,
    schema_version: i64,
    record_counts: AcceptanceRecordCounts,
    sha256_verified: bool,
    integrity: &'static str,
    catalogue_item_ids: Vec<String>,
    approval_ids: Vec<String>,
    approval_item_ids: Vec<String>,
    price_history_ids: Vec<String>,
    price_history_item_ids: Vec<String>,
    price_history_approval_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationBackupManifest {
    id: String,
    filename: String,
    schema_version: i64,
    sha256: String,
    byte_length: u64,
    reason: String,
    application_version: String,
    created_at: String,
    record_counts: AcceptanceRecordCounts,
}

fn ordered_identifiers(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<Vec<String>, &'static str> {
    let allowed = matches!(
        (table, column),
        ("catalogue_items", "id")
            | ("approvals", "id")
            | ("approvals", "item_id")
            | ("price_history", "id")
            | ("price_history", "item_id")
            | ("price_history", "approval_id")
    );
    if !allowed {
        return Err("identifier target rejected");
    }
    let mut statement = connection
        .prepare(&format!(
            "SELECT {column} FROM {table} ORDER BY {column},id LIMIT 1001"
        ))
        .map_err(|_| "identifier query unavailable")?;
    let values = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "identifier query unavailable")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "identifier query unavailable")?;
    if values.len() > 1_000
        || values.iter().any(|value| {
            value.is_empty() || value.len() > 128 || value.chars().any(char::is_control)
        })
    {
        return Err("identifier evidence is outside the acceptance bound");
    }
    Ok(values)
}

fn stable_database_path() -> Result<PathBuf, &'static str> {
    let local_app_data = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable")?;
    Ok(PathBuf::from(local_app_data)
        .join(APPLICATION_IDENTIFIER)
        .join(DATABASE_FILENAME))
}

fn sha256_file(path: &Path) -> Result<String, &'static str> {
    let mut reader = BufReader::new(File::open(path).map_err(|_| "backup could not be read")?);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| "backup could not be read")?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn migration_backup_evidence(
    data_dir: &Path,
) -> Result<Vec<MigrationBackupEvidence>, &'static str> {
    let backup_dir = data_dir.join("backups");
    if !backup_dir.exists() {
        return Ok(Vec::new());
    }
    let mut verified = Vec::new();
    for entry in fs::read_dir(backup_dir).map_err(|_| "backup directory unavailable")? {
        let entry = entry.map_err(|_| "backup directory unavailable")?;
        let metadata = entry
            .metadata()
            .map_err(|_| "backup manifest metadata unavailable")?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !metadata.is_file() || !name.ends_with(".manifest.json") {
            continue;
        }
        if metadata.len() == 0 || metadata.len() > 64 * 1024 {
            return Err("backup manifest is outside the acceptance bound");
        }
        let bytes = fs::read(entry.path()).map_err(|_| "backup manifest unavailable")?;
        let manifest: MigrationBackupManifest =
            serde_json::from_slice(&bytes).map_err(|_| "backup manifest invalid")?;
        if manifest.reason != "migration" || manifest.schema_version != 1 {
            continue;
        }
        if manifest.id.is_empty()
            || manifest.id.len() > 128
            || manifest.id.chars().any(char::is_control)
            || manifest.filename != format!("{}.sqlite3", manifest.id)
            || manifest.sha256.len() != 64
            || !manifest
                .sha256
                .bytes()
                .all(|value| value.is_ascii_hexdigit())
            || manifest.application_version.is_empty()
            || manifest.application_version.len() > 64
            || manifest.created_at.len() > 64
            || manifest.created_at.chars().any(char::is_control)
        {
            return Err("migration backup manifest invalid");
        }
        let database = entry
            .path()
            .parent()
            .ok_or("backup path invalid")?
            .join(&manifest.filename);
        let database_metadata =
            fs::symlink_metadata(&database).map_err(|_| "migration backup unavailable")?;
        if !database_metadata.is_file()
            || database_metadata.len() != manifest.byte_length
            || sha256_file(&database)? != manifest.sha256
        {
            return Err("migration backup verification failed");
        }
        let connection = Connection::open_with_flags(
            database,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| "migration backup could not be opened")?;
        let integrity: String = connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|_| "migration backup integrity unavailable")?;
        if integrity != "ok" {
            return Err("migration backup integrity failed");
        }
        let foreign_key_failure = connection
            .prepare("PRAGMA foreign_key_check")
            .and_then(|mut statement| statement.query([])?.next().map(|row| row.is_some()))
            .map_err(|_| "migration backup relationship check unavailable")?;
        if foreign_key_failure {
            return Err("migration backup relationship check failed");
        }
        let actual_counts = AcceptanceRecordCounts {
            catalogue_items: count(&connection, "catalogue_items")?,
            approvals: count(&connection, "approvals")?,
            price_history: count(&connection, "price_history")?,
            competitor_references: count(&connection, "competitor_references")?,
            sources: count(&connection, "source_registry")?,
            profiles: count(&connection, "mapping_profiles")?,
            aliases: count(&connection, "approved_aliases")?,
            settings: count(&connection, "settings")?,
        };
        if actual_counts != manifest.record_counts {
            return Err("migration backup record counts did not match manifest");
        }
        verified.push(MigrationBackupEvidence {
            id: manifest.id,
            schema_version: manifest.schema_version,
            record_counts: actual_counts,
            sha256_verified: true,
            integrity: "ok",
            catalogue_item_ids: ordered_identifiers(&connection, "catalogue_items", "id")?,
            approval_ids: ordered_identifiers(&connection, "approvals", "id")?,
            approval_item_ids: ordered_identifiers(&connection, "approvals", "item_id")?,
            price_history_ids: ordered_identifiers(&connection, "price_history", "id")?,
            price_history_item_ids: ordered_identifiers(&connection, "price_history", "item_id")?,
            price_history_approval_ids: ordered_identifiers(
                &connection,
                "price_history",
                "approval_id",
            )?,
        });
        if verified.len() > 100 {
            return Err("too many migration backups for acceptance evidence");
        }
    }
    verified.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(verified)
}

fn count(connection: &Connection, table: &str) -> Result<i64, &'static str> {
    if !matches!(
        table,
        "catalogue_items"
            | "approvals"
            | "price_history"
            | "competitor_references"
            | "source_registry"
            | "mapping_profiles"
            | "approved_aliases"
            | "settings"
    ) {
        return Err("count target rejected");
    }
    connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(|_| "record count unavailable")
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args_os().len() != 1 {
        return Err("this probe does not accept an arbitrary database path".into());
    }
    let database_path = stable_database_path()?;
    let data_dir = database_path
        .parent()
        .ok_or("stable application data path is invalid")?;
    let connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let integrity =
        connection.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))?;
    if integrity != "ok" {
        return Err("database integrity check failed".into());
    }
    let mut foreign_key_statement = connection.prepare("PRAGMA foreign_key_check")?;
    let mut foreign_key_rows = foreign_key_statement.query([])?;
    let foreign_key_failure = foreign_key_rows.next()?.is_some();
    if foreign_key_failure {
        return Err("database relationship check failed".into());
    }
    let verified_migration_backups = migration_backup_evidence(data_dir)?;
    let evidence = AcceptanceEvidence {
        integrity: "ok",
        schema_version: connection.query_row(
            "SELECT version FROM schema_metadata LIMIT 1",
            [],
            |row| row.get(0),
        )?,
        catalogue_items: count(&connection, "catalogue_items")?,
        approvals: count(&connection, "approvals")?,
        price_history: count(&connection, "price_history")?,
        competitor_references: count(&connection, "competitor_references")?,
        sources: count(&connection, "source_registry")?,
        profiles: count(&connection, "mapping_profiles")?,
        aliases: count(&connection, "approved_aliases")?,
        settings: count(&connection, "settings")?,
        catalogue_item_ids: ordered_identifiers(&connection, "catalogue_items", "id")?,
        approval_ids: ordered_identifiers(&connection, "approvals", "id")?,
        approval_item_ids: ordered_identifiers(&connection, "approvals", "item_id")?,
        price_history_ids: ordered_identifiers(&connection, "price_history", "id")?,
        price_history_item_ids: ordered_identifiers(&connection, "price_history", "item_id")?,
        price_history_approval_ids: ordered_identifiers(
            &connection,
            "price_history",
            "approval_id",
        )?,
        verified_migration_backups,
    };
    println!("{}", serde_json::to_string(&evidence)?);
    Ok(())
}
