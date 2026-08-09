//! Test-only lower-version data seeder. This binary is feature-gated and is
//! never included in the production Tauri bundle.

use std::collections::BTreeSet;
use std::path::PathBuf;

use rusqlite::{params, Connection, OpenFlags};

const APPLICATION_IDENTIFIER: &str = "au.com.stanwoottonlocksmiths.swl-pricing";
const DATABASE_FILENAME: &str = "swl-pricing.sqlite3";

fn stable_database_path() -> Result<PathBuf, &'static str> {
    let local_app_data = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable")?;
    Ok(PathBuf::from(local_app_data)
        .join(APPLICATION_IDENTIFIER)
        .join(DATABASE_FILENAME))
}

fn table_count(connection: &Connection, table: &str) -> Result<i64, &'static str> {
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
        return Err("table target rejected");
    }
    connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(|_| "former database count unavailable")
}

fn verify_former_partial_shell(
    connection: &Connection,
    require_empty: bool,
) -> Result<(), &'static str> {
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|_| "former database integrity unavailable")?;
    if integrity != "ok" {
        return Err("former database integrity failed");
    }
    let foreign_key_failure = connection
        .prepare("PRAGMA foreign_key_check")
        .and_then(|mut statement| statement.query([])?.next().map(|row| row.is_some()))
        .map_err(|_| "former database relationship check unavailable")?;
    if foreign_key_failure {
        return Err("former database relationship check failed");
    }
    let tables = connection
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<BTreeSet<_>, _>>()
        })
        .map_err(|_| "former database schema unavailable")?;
    let expected = [
        "approved_aliases",
        "approvals",
        "catalogue_items",
        "competitor_references",
        "mapping_profiles",
        "price_history",
        "schema_metadata",
        "settings",
        "source_registry",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<BTreeSet<_>>();
    if tables != expected {
        return Err("database is not the exact former partial-shell schema");
    }
    let versions = connection
        .prepare("SELECT version FROM schema_metadata")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| "former schema metadata unavailable")?;
    if versions != [1] {
        return Err("former schema metadata is not version one");
    }
    if require_empty {
        for table in [
            "catalogue_items",
            "approvals",
            "price_history",
            "competitor_references",
            "source_registry",
            "mapping_profiles",
            "approved_aliases",
            "settings",
        ] {
            if table_count(connection, table)? != 0 {
                return Err("former database already contains operational records");
            }
        }
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args_os().len() != 1 {
        return Err("this seeder does not accept an arbitrary database path".into());
    }
    if std::env::var("SWL_DISPOSABLE_ACCEPTANCE").as_deref() != Ok("YES") {
        return Err("disposable acceptance marker is required".into());
    }
    let database = stable_database_path()?;
    let mut connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
    )?;
    connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")?;
    verify_former_partial_shell(&connection, true)?;
    let transaction = connection.transaction()?;
    transaction.execute(
        "INSERT INTO catalogue_items(id,item_number,description,cost_cents,sell_price_cents,gst_basis,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            "item-legacy",
            "000042",
            "Synthetic legacy acceptance item",
            10_000_i64,
            13_000_i64,
            "unknown",
            "2026-08-09T00:00:00Z"
        ],
    )?;
    transaction.execute(
        "INSERT INTO approvals(id,item_id,approved_by,proposed_sell_cents,reason,approved_at)
         VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            "approval-legacy",
            "item-legacy",
            "synthetic-operator",
            13_000_i64,
            "Synthetic legacy acceptance approval",
            "2026-08-09T00:00:00Z"
        ],
    )?;
    transaction.execute(
        "INSERT INTO price_history(id,item_id,cost_cents,sell_price_cents,approval_id,recorded_at)
         VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            "history-legacy",
            "item-legacy",
            10_000_i64,
            13_000_i64,
            "approval-legacy",
            "2026-08-09T00:00:00Z"
        ],
    )?;
    transaction.commit()?;
    verify_former_partial_shell(&connection, false)?;
    let counts = (
        table_count(&connection, "catalogue_items")?,
        table_count(&connection, "approvals")?,
        table_count(&connection, "price_history")?,
    );
    if counts != (1, 1, 1) {
        return Err("synthetic former records were not seeded exactly".into());
    }
    for table in [
        "competitor_references",
        "source_registry",
        "mapping_profiles",
        "approved_aliases",
        "settings",
    ] {
        if table_count(&connection, table)? != 0 {
            return Err("unexpected former records appeared during seeding".into());
        }
    }
    println!(
        r#"{{"seeded":true,"catalogueItemId":"item-legacy","approvalId":"approval-legacy","priceHistoryId":"history-legacy"}}"#
    );
    Ok(())
}
