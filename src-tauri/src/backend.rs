use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use quick_xml::{events::Event, Reader as XmlReader};
use reqwest::{redirect, StatusCode, Url};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;
use zip::{CompressionMethod, ZipArchive};

const APPLICATION_ID: &str = "swl-pricing-inventory-control";
const APPLICATION_READY_TITLE: &str = "SWL Pricing and Inventory Control";
const DATABASE_FILENAME: &str = "swl-pricing.sqlite3";
const BACKUP_DIRECTORY: &str = "backups";
const CURRENT_SCHEMA_VERSION: i64 = 6;
const CONFIGURATION_SCHEMA_VERSION: i64 = 1;
const MAX_IDENTIFIER_BYTES: usize = 128;
const MAX_DESCRIPTION_BYTES: usize = 2_000;
const MAX_JSON_BYTES: usize = 1024 * 1024;
const MAX_IMPORT_BYTES: usize = 10 * 1024 * 1024;
const MAX_BUSINESS_INPUT_BYTES: u64 = 25 * 1024 * 1024;
const MAX_EXPORT_BYTES: u64 = 50 * 1024 * 1024;
const MAX_EXPORT_CHUNK_BYTES: usize = 256 * 1024;
const MAX_BATCH_RECORDS: usize = 50_000;
const MAX_SEARCH_QUERY_BYTES: usize = 512;
const MAX_PROVIDER_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_PROVIDER_CALLS_PER_MINUTE: u32 = 10;
const MAX_PROVIDER_ITEMS: usize = 100;
const MAX_CANDIDATE_TOKEN_BYTES: usize = 8_192;
const MAX_REMEMBERED_CANDIDATES: usize = 500;
const SEARCH_CANDIDATE_TTL: Duration = Duration::from_secs(15 * 60);
const DEFAULT_PROVIDER_LOCATION: &str = "Geelong, Victoria, Australia";
const MAX_PENDING_OPERATIONS: usize = 32;
const MAX_INPUT_GRANTS: usize = 8;
const MAX_OUTPUT_GRANTS: usize = 16;
const MAX_EXPORT_SESSIONS: usize = 8;
const MAX_EXPORT_BATCHES: usize = 4;
const MAX_AGGREGATE_INPUT_BYTES: u64 = 100 * 1024 * 1024;
const MAX_AGGREGATE_EXPORT_BYTES: u64 = 100 * 1024 * 1024;
const TOKEN_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_XLSX_ENTRIES: usize = 10_000;
const MAX_XLSX_ENTRY_EXPANDED_BYTES: u64 = 25 * 1024 * 1024;
const MAX_XLSX_EXPANDED_BYTES: u64 = 100 * 1024 * 1024;
const MAX_XLSX_WORKSHEETS: usize = 20;
const MAX_XLSX_ROWS_PER_SHEET: usize = 50_001;
const MAX_XLSX_COLUMNS_PER_SHEET: usize = 100;
const RESTORE_JOURNAL_FILENAME: &str = ".swl-restore-journal.json";
const RESET_CONFIRMATION: &str = "ERASE SWL LOCAL DATA";
const PROVIDER_ID: &str = "serpapi";
const PROVIDER_HOST: &str = "serpapi.com";
const PROVIDER_ENDPOINT: &str = "https://serpapi.com/search.json";
const PROVIDER_ACCOUNT_ENDPOINT: &str = "https://serpapi.com/account.json";
const PRODUCTION_CREDENTIAL_TARGET: &str =
    "au.com.stanwoottonlocksmiths.swl-pricing/provider/serpapi";
const LOCAL_TEST_CREDENTIAL_TARGET: &str =
    "au.com.stanwoottonlocksmiths.swl-pricing.local-test/provider/serpapi";
const LOCAL_TEST_PROFILE_BUILD_SETTING: Option<&str> =
    option_env!("SWL_DESKTOP_LOCAL_TEST_PROFILE");

const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

const COUNT_TABLES: &[(&str, &str)] = &[
    ("catalogueItems", "catalogue_items"),
    ("approvals", "approvals"),
    ("priceHistory", "price_history"),
    ("competitorReferences", "competitor_references"),
    ("sources", "source_registry"),
    ("profiles", "mapping_profiles"),
    ("aliases", "approved_aliases"),
    ("settings", "settings"),
    ("brands", "brands"),
    ("suppliers", "suppliers"),
    ("productSupplierOffers", "product_supplier_offers"),
    ("productOfferSelections", "product_offer_selections"),
    ("supplierOfferVersions", "supplier_offer_versions"),
    ("offerSelectionVersions", "offer_selection_versions"),
    ("supplierVersions", "supplier_versions"),
    ("brandVersions", "brand_versions"),
    ("productMetadataVersions", "product_metadata_versions"),
    ("syncRuns", "sync_runs"),
    ("syncCheckpoints", "sync_checkpoints"),
    ("syncItemOutcomes", "sync_item_outcomes"),
    ("settingsAudit", "settings_audit"),
];

const MIGRATIONS: &[(i64, &str, &str)] = &[
    (
        1,
        "initial-native-store",
        r#"
        CREATE TABLE IF NOT EXISTS schema_migrations(
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS schema_metadata(
          version INTEGER NOT NULL CHECK(version >= 1)
        );
        INSERT INTO schema_metadata(version)
          SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_metadata);
        CREATE TABLE IF NOT EXISTS catalogue_items(
          id TEXT PRIMARY KEY,
          item_number TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL,
          cost_cents INTEGER NOT NULL CHECK(cost_cents BETWEEN 0 AND 1000000000),
          sell_price_cents INTEGER NOT NULL CHECK(sell_price_cents BETWEEN 0 AND 1000000000),
          gst_basis TEXT NOT NULL CHECK(gst_basis IN ('inc-gst','ex-gst','unknown')),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS approvals(
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL REFERENCES catalogue_items(id) ON DELETE RESTRICT,
          approved_by TEXT NOT NULL,
          proposed_sell_cents INTEGER NOT NULL CHECK(proposed_sell_cents BETWEEN 0 AND 1000000000),
          reason TEXT NOT NULL,
          approved_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS price_history(
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL REFERENCES catalogue_items(id) ON DELETE RESTRICT,
          cost_cents INTEGER NOT NULL CHECK(cost_cents BETWEEN 0 AND 1000000000),
          sell_price_cents INTEGER NOT NULL CHECK(sell_price_cents BETWEEN 0 AND 1000000000),
          approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE RESTRICT,
          recorded_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS competitor_references(
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL REFERENCES catalogue_items(id) ON DELETE RESTRICT,
          observation_json TEXT NOT NULL,
          attached_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS source_registry(
          id TEXT PRIMARY KEY,
          state_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mapping_profiles(
          id TEXT PRIMARY KEY,
          profile_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS approved_aliases(
          supplier_code TEXT PRIMARY KEY,
          item_number TEXT NOT NULL,
          approved_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings(
          id TEXT PRIMARY KEY CHECK(id='settings'),
          settings_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        "#,
    ),
    (
        2,
        "append-only-and-import-ledger",
        r#"
        CREATE TRIGGER IF NOT EXISTS approvals_no_update
          BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT, 'append-only'); END;
        CREATE TRIGGER IF NOT EXISTS approvals_no_delete
          BEFORE DELETE ON approvals BEGIN SELECT RAISE(ABORT, 'append-only'); END;
        CREATE TRIGGER IF NOT EXISTS price_history_no_update
          BEFORE UPDATE ON price_history BEGIN SELECT RAISE(ABORT, 'append-only'); END;
        CREATE TRIGGER IF NOT EXISTS price_history_no_delete
          BEFORE DELETE ON price_history BEGIN SELECT RAISE(ABORT, 'append-only'); END;
        CREATE TABLE IF NOT EXISTS configuration_imports(
          source_id TEXT PRIMARY KEY,
          content_sha256 TEXT NOT NULL,
          imported_at TEXT NOT NULL,
          profile_count INTEGER NOT NULL CHECK(profile_count >= 0),
          alias_count INTEGER NOT NULL CHECK(alias_count >= 0),
          settings_count INTEGER NOT NULL CHECK(settings_count IN (0,1))
        );
        CREATE TABLE IF NOT EXISTS provider_state(
          provider TEXT PRIMARY KEY,
          paid_calls_enabled INTEGER NOT NULL DEFAULT 0 CHECK(paid_calls_enabled IN (0,1)),
          last_validated_at TEXT
        );
        INSERT OR IGNORE INTO provider_state(provider,paid_calls_enabled,last_validated_at)
          VALUES('serpapi',0,NULL);
        UPDATE schema_metadata SET version=2;
        "#,
    ),
    (
        3,
        "bounded-provider-call-budget",
        r#"
        ALTER TABLE provider_state
          ADD COLUMN cost_ceiling_cents INTEGER NOT NULL DEFAULT 0
          CHECK(cost_ceiling_cents BETWEEN 0 AND 1000000000);
        ALTER TABLE provider_state
          ADD COLUMN cost_per_call_cents INTEGER NOT NULL DEFAULT 0
          CHECK(cost_per_call_cents BETWEEN 0 AND 1000000000);
        ALTER TABLE provider_state
          ADD COLUMN spent_cents INTEGER NOT NULL DEFAULT 0
          CHECK(spent_cents BETWEEN 0 AND 1000000000);
        UPDATE provider_state
          SET paid_calls_enabled=0,cost_ceiling_cents=0,cost_per_call_cents=0,spent_cents=0;
        UPDATE schema_metadata SET version=3;
        "#,
    ),
    (
        4,
        "catalogue-supplier-provenance-and-sync-ledger",
        r#"
        CREATE TABLE brands(
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          markup_hundredths INTEGER CHECK(markup_hundredths IS NULL OR markup_hundredths BETWEEN 0 AND 99999),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE suppliers(
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
          external_reference TEXT,
          updated_at TEXT NOT NULL
        );
        ALTER TABLE catalogue_items ADD COLUMN item_kind TEXT NOT NULL DEFAULT 'physical-product'
          CHECK(item_kind IN ('physical-product','service','labour'));
        ALTER TABLE catalogue_items ADD COLUMN brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL;
        ALTER TABLE catalogue_items ADD COLUMN product_markup_hundredths INTEGER
          CHECK(product_markup_hundredths IS NULL OR product_markup_hundredths BETWEEN 0 AND 99999);
        ALTER TABLE catalogue_items ADD COLUMN description_source TEXT NOT NULL DEFAULT 'legacy-local';
        ALTER TABLE catalogue_items ADD COLUMN upstream_reference TEXT;
        ALTER TABLE catalogue_items ADD COLUMN servicem8_reference TEXT;
        ALTER TABLE catalogue_items ADD COLUMN barcode TEXT;
        ALTER TABLE catalogue_items ADD COLUMN sell_price_gst_basis TEXT NOT NULL DEFAULT 'unknown'
          CHECK(sell_price_gst_basis IN ('inc-gst','ex-gst','unknown'));
        CREATE TABLE product_supplier_offers(
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES catalogue_items(id) ON DELETE RESTRICT,
          supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
          supplier_sku TEXT NOT NULL,
          cost_cents INTEGER NOT NULL CHECK(cost_cents BETWEEN 0 AND 1000000000),
          gst_basis TEXT NOT NULL CHECK(gst_basis IN ('inc-gst','ex-gst','unknown')),
          currency TEXT NOT NULL DEFAULT 'AUD' CHECK(currency='AUD'),
          active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
          is_preferred INTEGER NOT NULL DEFAULT 0 CHECK(is_preferred IN (0,1)),
          valid_from TEXT,
          valid_until TEXT,
          provenance_type TEXT NOT NULL CHECK(provenance_type IN ('legacy-local','manual','supplier-file','xero')),
          provenance_reference TEXT,
          observed_at TEXT NOT NULL,
          UNIQUE(id,product_id)
        );
        CREATE UNIQUE INDEX one_active_preferred_offer_per_product
          ON product_supplier_offers(product_id) WHERE active=1 AND is_preferred=1;
        CREATE TABLE product_offer_selections(
          product_id TEXT PRIMARY KEY REFERENCES catalogue_items(id) ON DELETE RESTRICT,
          offer_id TEXT NOT NULL,
          selected_by TEXT NOT NULL,
          reason TEXT NOT NULL,
          selected_at TEXT NOT NULL,
          FOREIGN KEY(offer_id,product_id) REFERENCES product_supplier_offers(id,product_id) ON DELETE RESTRICT
        );
        ALTER TABLE price_history ADD COLUMN selected_offer_id TEXT REFERENCES product_supplier_offers(id) ON DELETE RESTRICT;
        ALTER TABLE price_history ADD COLUMN cost_basis_cents INTEGER NOT NULL DEFAULT 0
          CHECK(cost_basis_cents BETWEEN 0 AND 1000000000);
        ALTER TABLE price_history ADD COLUMN markup_source_type TEXT NOT NULL DEFAULT 'legacy-global'
          CHECK(markup_source_type IN ('product','brand','global','legacy-global'));
        ALTER TABLE price_history ADD COLUMN markup_source_id TEXT;
        ALTER TABLE price_history ADD COLUMN applied_markup_hundredths INTEGER
          CHECK(applied_markup_hundredths IS NULL OR applied_markup_hundredths BETWEEN 0 AND 99999);
        ALTER TABLE price_history ADD COLUMN supplier_id_snapshot TEXT;
        ALTER TABLE price_history ADD COLUMN supplier_name_snapshot TEXT;
        ALTER TABLE price_history ADD COLUMN supplier_sku_snapshot TEXT;
        ALTER TABLE price_history ADD COLUMN cost_gst_basis TEXT NOT NULL DEFAULT 'unknown'
          CHECK(cost_gst_basis IN ('inc-gst','ex-gst','unknown'));
        ALTER TABLE price_history ADD COLUMN currency TEXT CHECK(currency IS NULL OR currency='AUD');
        ALTER TABLE price_history ADD COLUMN sell_price_gst_basis TEXT NOT NULL DEFAULT 'unknown'
          CHECK(sell_price_gst_basis IN ('inc-gst','ex-gst','unknown'));
        ALTER TABLE price_history ADD COLUMN brand_id_snapshot TEXT;
        ALTER TABLE price_history ADD COLUMN item_kind_snapshot TEXT
          CHECK(item_kind_snapshot IS NULL OR item_kind_snapshot IN ('physical-product','service','labour'));
        ALTER TABLE price_history ADD COLUMN pricing_explanation TEXT NOT NULL DEFAULT 'Legacy price record; offer and markup provenance unresolved';
        ALTER TABLE price_history ADD COLUMN pricing_rule_version TEXT NOT NULL DEFAULT 'legacy-unresolved';
        ALTER TABLE price_history ADD COLUMN provenance_state TEXT NOT NULL DEFAULT 'legacy-unresolved'
          CHECK(provenance_state IN ('resolved','legacy-unresolved'));
        DROP TRIGGER price_history_no_update;
        UPDATE price_history SET cost_basis_cents=cost_cents;
        CREATE TRIGGER price_history_no_update BEFORE UPDATE ON price_history BEGIN SELECT RAISE(ABORT,'append-only'); END;
        CREATE TABLE sync_runs(
          id TEXT PRIMARY KEY,
          system TEXT NOT NULL CHECK(system IN ('xero','servicem8')),
          direction TEXT NOT NULL CHECK(direction IN ('upstream-read','downstream-write')),
          status TEXT NOT NULL CHECK(status IN ('preview','running','completed','partial','failed')),
          mode TEXT NOT NULL CHECK(mode IN ('preview','approved')),
          started_at TEXT NOT NULL,
          completed_at TEXT,
          approved_by TEXT,
          summary_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE sync_checkpoints(
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE RESTRICT,
          cursor_value TEXT NOT NULL,
          recorded_at TEXT NOT NULL
        );
        CREATE TABLE sync_item_outcomes(
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE RESTRICT,
          item_id TEXT REFERENCES catalogue_items(id) ON DELETE RESTRICT,
          external_id TEXT,
          action TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('planned','succeeded','skipped','failed')),
          message TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 0 AND 100),
          retryable INTEGER NOT NULL CHECK(retryable IN (0,1)),
          error_class TEXT,
          reconciliation TEXT NOT NULL CHECK(reconciliation IN ('not-run','matched','mismatch','not-applicable')),
          recorded_at TEXT NOT NULL
        );
        CREATE TABLE settings_audit(
          id TEXT PRIMARY KEY,
          previous_json TEXT,
          current_json TEXT NOT NULL,
          changed_by TEXT NOT NULL,
          changed_at TEXT NOT NULL
        );
        CREATE TRIGGER settings_audit_no_update BEFORE UPDATE ON settings_audit BEGIN SELECT RAISE(ABORT,'append-only'); END;
        CREATE TRIGGER settings_audit_no_delete BEFORE DELETE ON settings_audit BEGIN SELECT RAISE(ABORT,'append-only'); END;
        CREATE TRIGGER sync_item_outcomes_no_update BEFORE UPDATE ON sync_item_outcomes BEGIN SELECT RAISE(ABORT,'append-only'); END;
        CREATE TRIGGER sync_item_outcomes_no_delete BEFORE DELETE ON sync_item_outcomes BEGIN SELECT RAISE(ABORT,'append-only'); END;
        UPDATE settings SET settings_json=json_set(settings_json,'$.glassTint','clear')
          WHERE json_type(settings_json,'$.glassTint') IS NULL;
        INSERT INTO settings_audit(id,previous_json,current_json,changed_by,changed_at)
          SELECT 'schema4-settings-' || lower(hex(randomblob(8))),NULL,settings_json,'schema-migration',updated_at
          FROM settings;
        INSERT OR IGNORE INTO suppliers(id,name,active,external_reference,updated_at)
          SELECT 'legacy-supplier','Legacy catalogue supplier',1,NULL,datetime('now')
          WHERE EXISTS(SELECT 1 FROM catalogue_items);
        INSERT INTO product_supplier_offers(id,product_id,supplier_id,supplier_sku,cost_cents,gst_basis,currency,active,is_preferred,provenance_type,provenance_reference,observed_at)
          SELECT 'legacy-offer-' || id,id,'legacy-supplier',item_number,cost_cents,gst_basis,'AUD',1,1,'legacy-local',item_number,updated_at
          FROM catalogue_items;
        INSERT INTO product_offer_selections(product_id,offer_id,selected_by,reason,selected_at)
          SELECT id,'legacy-offer-' || id,'schema-migration','Preserved legacy catalogue cost',updated_at
          FROM catalogue_items;
        UPDATE schema_metadata SET version=4;
        "#,
    ),
    (
        5,
        "auditable-stale-safe-offer-mutations",
        r#"
        ALTER TABLE brands ADD COLUMN canonical_key TEXT;
        ALTER TABLE product_supplier_offers ADD COLUMN normalized_supplier_sku TEXT;
        CREATE TABLE supplier_offer_versions(
          offer_id TEXT NOT NULL REFERENCES product_supplier_offers(id) ON DELETE RESTRICT,
          version INTEGER NOT NULL CHECK(version >= 1),
          snapshot_json TEXT NOT NULL,
          changed_at TEXT NOT NULL,
          PRIMARY KEY(offer_id,version)
        );
        CREATE TABLE offer_selection_versions(
          product_id TEXT NOT NULL REFERENCES catalogue_items(id) ON DELETE RESTRICT,
          version INTEGER NOT NULL CHECK(version >= 1),
          snapshot_json TEXT NOT NULL,
          changed_at TEXT NOT NULL,
          PRIMARY KEY(product_id,version)
        );
        INSERT INTO supplier_offer_versions(offer_id,version,snapshot_json,changed_at)
          SELECT id,1,json_object(
            'id',id,'productId',product_id,'supplierId',supplier_id,'supplierSku',supplier_sku,
            'costCents',cost_cents,'gstBasis',gst_basis,'currency',currency,'active',json(active),
            'isPreferred',json(is_preferred),'validFrom',valid_from,'validUntil',valid_until,
            'provenanceType',provenance_type,'provenanceReference',provenance_reference,
            'observedAt',observed_at),observed_at
          FROM product_supplier_offers;
        INSERT INTO offer_selection_versions(product_id,version,snapshot_json,changed_at)
          SELECT product_id,1,json_object(
            'productId',product_id,'offerId',offer_id,'selectedBy',selected_by,
            'reason',reason,'selectedAt',selected_at),selected_at
          FROM product_offer_selections;
        CREATE TRIGGER supplier_offer_versions_no_update BEFORE UPDATE ON supplier_offer_versions BEGIN SELECT RAISE(ABORT,'append-only'); END;
        CREATE TRIGGER supplier_offer_versions_no_delete BEFORE DELETE ON supplier_offer_versions BEGIN SELECT RAISE(ABORT,'append-only'); END;
        CREATE TRIGGER offer_selection_versions_no_update BEFORE UPDATE ON offer_selection_versions BEGIN SELECT RAISE(ABORT,'append-only'); END;
        CREATE TRIGGER offer_selection_versions_no_delete BEFORE DELETE ON offer_selection_versions BEGIN SELECT RAISE(ABORT,'append-only'); END;
        UPDATE schema_metadata SET version=5;
        "#,
    ),
    (
        6,
        "auditable-stale-safe-pricing-rule-inputs",
        r#"
        UPDATE suppliers
          SET updated_at=substr(updated_at,1,10) || 'T' || substr(updated_at,12,8) || 'Z'
          WHERE length(updated_at)=19 AND substr(updated_at,11,1)=' ';
        CREATE TABLE supplier_versions(
          supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
          version INTEGER NOT NULL CHECK(version >= 1),
          snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) BETWEEN 2 AND 1048576 AND json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
          changed_at TEXT NOT NULL,
          PRIMARY KEY(supplier_id,version)
        );
        INSERT INTO supplier_versions(supplier_id,version,snapshot_json,changed_at)
          SELECT id,1,json_object(
            'id',id,'name',name,'active',json(CASE active WHEN 1 THEN 'true' ELSE 'false' END),
            'externalReference',external_reference,'updatedAt',updated_at),updated_at
          FROM suppliers;
        CREATE TRIGGER supplier_versions_no_update BEFORE UPDATE ON supplier_versions BEGIN SELECT RAISE(ABORT,'append-only'); END;
        CREATE TRIGGER supplier_versions_no_delete BEFORE DELETE ON supplier_versions BEGIN SELECT RAISE(ABORT,'append-only'); END;
        CREATE TABLE brand_versions(
          brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
          version INTEGER NOT NULL CHECK(version >= 1),
          snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) BETWEEN 2 AND 1048576 AND json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
          changed_at TEXT NOT NULL,
          PRIMARY KEY(brand_id,version)
        );
        INSERT INTO brand_versions(brand_id,version,snapshot_json,changed_at)
          SELECT id,1,json_object(
            'id',id,'name',name,'markupHundredths',markup_hundredths,
            'updatedAt',updated_at),updated_at
          FROM brands;
        CREATE TRIGGER brand_versions_no_update BEFORE UPDATE ON brand_versions BEGIN SELECT RAISE(ABORT,'append-only'); END;
        CREATE TRIGGER brand_versions_no_delete BEFORE DELETE ON brand_versions BEGIN SELECT RAISE(ABORT,'append-only'); END;
        CREATE TABLE product_metadata_versions(
          product_id TEXT NOT NULL REFERENCES catalogue_items(id) ON DELETE RESTRICT,
          version INTEGER NOT NULL CHECK(version >= 1),
          snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) BETWEEN 2 AND 1048576 AND json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
          changed_at TEXT NOT NULL,
          PRIMARY KEY(product_id,version)
        );
        INSERT INTO product_metadata_versions(product_id,version,snapshot_json,changed_at)
          SELECT id,1,json_object(
            'productId',id,'itemKind',item_kind,'brandId',brand_id,
            'markupOverrideHundredths',product_markup_hundredths,
            'xeroReference',upstream_reference,'servicem8Reference',servicem8_reference,
            'barcodeGtin',barcode,'updatedAt',updated_at),updated_at
          FROM catalogue_items;
        CREATE TRIGGER product_metadata_versions_no_update BEFORE UPDATE ON product_metadata_versions BEGIN SELECT RAISE(ABORT,'append-only'); END;
        CREATE TRIGGER product_metadata_versions_no_delete BEFORE DELETE ON product_metadata_versions BEGIN SELECT RAISE(ABORT,'append-only'); END;
        UPDATE schema_metadata SET version=6;
        "#,
    ),
];

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DesktopHealth {
    ok: bool,
    provider: String,
    live_search_configured: bool,
    fixture_mode: bool,
    schema_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogueItem {
    id: String,
    item_number: String,
    description: String,
    cost_cents: i64,
    sell_price_cents: i64,
    gst_basis: String,
    sell_price_gst_basis: String,
    item_kind: String,
    brand_id: Option<String>,
    markup_override_percent: Option<String>,
    xero_reference: Option<String>,
    servicem8_reference: Option<String>,
    #[serde(rename = "barcodeGtin")]
    barcode: Option<String>,
    selected_offer_id: Option<String>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApprovalRecord {
    id: String,
    item_id: String,
    approved_by: String,
    proposed_sell_cents: i64,
    reason: String,
    approved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PriceHistoryRecord {
    id: String,
    item_id: String,
    cost: String,
    sell_price: String,
    cost_cents: i64,
    sell_price_cents: i64,
    approval_id: String,
    selected_offer_id: Option<String>,
    cost_basis_cents: i64,
    markup_source_type: String,
    markup_source_id: Option<String>,
    applied_markup_hundredths: Option<i64>,
    #[serde(rename = "supplierId")]
    supplier_id_snapshot: Option<String>,
    #[serde(rename = "supplierName")]
    supplier_name_snapshot: Option<String>,
    #[serde(rename = "supplierSku")]
    supplier_sku_snapshot: Option<String>,
    cost_gst_basis: String,
    sell_price_gst_basis: String,
    currency: Option<String>,
    #[serde(rename = "brandId")]
    brand_id_snapshot: Option<String>,
    #[serde(rename = "itemKind")]
    item_kind_snapshot: Option<String>,
    pricing_explanation: String,
    #[serde(rename = "ruleVersion")]
    pricing_rule_version: String,
    provenance_state: String,
    recorded_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrandRecord {
    id: String,
    name: String,
    markup_hundredths: Option<i64>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SupplierRecord {
    id: String,
    name: String,
    active: bool,
    external_reference: Option<String>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SupplierOfferRecord {
    id: String,
    product_id: String,
    supplier_id: String,
    supplier_sku: String,
    cost_cents: i64,
    gst_basis: String,
    currency: String,
    active: bool,
    is_preferred: bool,
    valid_from: Option<String>,
    valid_until: Option<String>,
    provenance_type: String,
    provenance_reference: Option<String>,
    observed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OfferSelectionRecord {
    product_id: String,
    offer_id: String,
    selected_by: String,
    reason: String,
    selected_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncRunRecord {
    id: String,
    system: String,
    direction: String,
    status: String,
    mode: String,
    started_at: String,
    completed_at: Option<String>,
    approved_by: Option<String>,
    summary: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncCheckpointRecord {
    id: String,
    run_id: String,
    cursor_value: String,
    recorded_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncItemOutcomeRecord {
    id: String,
    run_id: String,
    item_id: Option<String>,
    external_id: Option<String>,
    action: String,
    status: String,
    message: String,
    idempotency_key: String,
    attempt_count: i64,
    retryable: bool,
    error_class: Option<String>,
    reconciliation: String,
    recorded_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsAuditRecord {
    id: String,
    previous: Option<Value>,
    current: Value,
    changed_by: String,
    changed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductMetadataUpdate {
    product_id: String,
    item_kind: String,
    brand_id: Option<String>,
    markup_override_percent: Option<String>,
    xero_reference: Option<String>,
    servicem8_reference: Option<String>,
    #[serde(rename = "barcodeGtin")]
    barcode: Option<String>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductMetadataVersionSnapshot {
    product_id: String,
    item_kind: String,
    brand_id: Option<String>,
    markup_override_hundredths: Option<i64>,
    xero_reference: Option<String>,
    servicem8_reference: Option<String>,
    barcode_gtin: Option<String>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublishApprovedChange {
    item: CatalogueItem,
    approved_by: String,
    reason: String,
    #[serde(default)]
    pricing_provenance: Option<PricingProvenance>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PricingProvenance {
    selected_offer_id: Option<String>,
    supplier_id: Option<String>,
    supplier_name: Option<String>,
    supplier_sku: Option<String>,
    cost_gst_basis: String,
    currency: String,
    markup_percent: String,
    markup_source: String,
    markup_source_id: Option<String>,
    brand_id: Option<String>,
    item_kind: String,
    sell_price_gst_basis: String,
    explanation: String,
    rule_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishedChange {
    item: CatalogueItem,
    approval: ApprovalRecord,
    price_history: PriceHistoryRecord,
}

type LiveCompetitorEvidence = SearchResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManualCompetitorEvidence {
    sku: String,
    source_name: String,
    approved_source: bool,
    observed_at: String,
    price: String,
    currency: String,
    gst_basis: String,
    shipping: String,
    stock_status: String,
    condition: String,
    pack_compatible: bool,
    product_only: bool,
    match_confidence: f64,
    review_state: String,
    ambiguous_match: Option<bool>,
    url: Option<String>,
    pack_size: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
enum CompetitorEvidence {
    Live(Box<LiveCompetitorEvidence>),
    Manual(Box<ManualCompetitorEvidence>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompetitorReferenceRecord {
    id: String,
    item_id: String,
    observation: CompetitorEvidence,
    attached_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceRecord {
    id: String,
    name: String,
    access_method: String,
    automated_access_note: String,
    enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MappingProfileRecord {
    id: String,
    name: String,
    version: i64,
    supplier_mapping: BTreeMap<String, i64>,
    supplier_headers: Vec<String>,
    servicem8_mapping: BTreeMap<String, i64>,
    servicem8_headers: Vec<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AliasRecord {
    supplier_code: String,
    item_number: String,
    approved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigurationCounts {
    profiles: usize,
    aliases: usize,
    settings: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigurationData {
    profiles: Vec<MappingProfileRecord>,
    aliases: Vec<AliasRecord>,
    settings: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigurationEnvelope {
    schema_version: i64,
    application: String,
    exported_at: String,
    counts: ConfigurationCounts,
    data: ConfigurationData,
    sha256: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ConfigurationConflicts {
    profiles: usize,
    aliases: usize,
    settings: usize,
}

impl ConfigurationConflicts {
    fn any(&self) -> bool {
        self.profiles > 0 || self.aliases > 0 || self.settings > 0
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigurationPreview {
    preview_token: String,
    schema_version: i64,
    counts: ConfigurationCounts,
    conflicts: ConfigurationConflicts,
    valid: bool,
    validation_messages: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigurationMigrationStatus {
    legacy_configuration_found: bool,
    already_imported: bool,
    counts: ConfigurationCounts,
    valid: bool,
    invalid_counts: ConfigurationCounts,
    validation_messages: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct BackupRecordCounts {
    catalogue_items: i64,
    approvals: i64,
    price_history: i64,
    competitor_references: i64,
    sources: i64,
    profiles: i64,
    aliases: i64,
    settings: i64,
    brands: i64,
    suppliers: i64,
    product_supplier_offers: i64,
    product_offer_selections: i64,
    supplier_offer_versions: i64,
    offer_selection_versions: i64,
    supplier_versions: i64,
    brand_versions: i64,
    product_metadata_versions: i64,
    sync_runs: i64,
    sync_checkpoints: i64,
    sync_item_outcomes: i64,
    settings_audit: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupSummary {
    id: String,
    filename: String,
    created_at: String,
    application_version: String,
    schema_version: i64,
    sha256: String,
    record_counts: BackupRecordCounts,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    #[serde(flatten)]
    summary: BackupSummary,
    byte_length: u64,
    reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreJournal {
    version: i64,
    backup_id: String,
    temporary_filename: String,
    rollback_filename: String,
    target_schema_version: i64,
    target_record_counts: BackupRecordCounts,
    rollback_schema_version: i64,
    rollback_record_counts: BackupRecordCounts,
    rollback_sha256: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestorePreview {
    #[serde(flatten)]
    summary: BackupSummary,
    preview_token: String,
    integrity_ok: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResetPreview {
    reset_token: String,
    confirmation_phrase: String,
    scope: Vec<String>,
    record_counts: BackupRecordCounts,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderStatus {
    provider: String,
    state: String,
    paid_calls_enabled: bool,
    cost_ceiling_aud: String,
    cost_ceiling_cents: i64,
    cost_per_call_cents: i64,
    spent_cents: i64,
    credential_configured: bool,
    credential_hint: Option<String>,
    last_validated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    rename_all = "camelCase",
    deny_unknown_fields,
    try_from = "SearchResultWire"
)]
struct SearchResult {
    search_query: Option<String>,
    selected_product_title: Option<String>,
    selected_product_brand: Option<String>,
    selected_product_id: Option<String>,
    title: String,
    price_cents: i64,
    price_aud: String,
    item_price_cents: i64,
    item_price_aud: String,
    shipping_cents: Option<i64>,
    shipping_aud: Option<String>,
    estimated_tax_cents: Option<i64>,
    estimated_tax_aud: Option<String>,
    total_price_cents: Option<i64>,
    total_price_aud: Option<String>,
    comparison_price_cents: Option<i64>,
    comparison_price_aud: Option<String>,
    price_basis: String,
    original_price_text: String,
    currency_basis: String,
    currency: String,
    gst_basis: String,
    pack_size: Option<String>,
    condition: String,
    availability: String,
    financing: bool,
    comparison_eligible: bool,
    exclusion_reasons: Vec<String>,
    seller: String,
    source_domain: String,
    url: String,
    retrieved_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchResultWire {
    search_query: Option<String>,
    selected_product_title: Option<String>,
    selected_product_brand: Option<String>,
    selected_product_id: Option<String>,
    title: String,
    price_cents: i64,
    price_aud: String,
    item_price_cents: Option<i64>,
    item_price_aud: Option<String>,
    shipping_cents: Option<i64>,
    shipping_aud: Option<String>,
    estimated_tax_cents: Option<i64>,
    estimated_tax_aud: Option<String>,
    total_price_cents: Option<i64>,
    total_price_aud: Option<String>,
    comparison_price_cents: Option<i64>,
    comparison_price_aud: Option<String>,
    price_basis: Option<String>,
    original_price_text: Option<String>,
    currency_basis: Option<String>,
    currency: String,
    gst_basis: String,
    pack_size: Option<String>,
    condition: Option<String>,
    availability: Option<String>,
    financing: Option<bool>,
    comparison_eligible: Option<bool>,
    exclusion_reasons: Option<Vec<String>>,
    seller: String,
    source_domain: String,
    url: String,
    retrieved_at: String,
}

impl TryFrom<SearchResultWire> for SearchResult {
    type Error = String;

    fn try_from(value: SearchResultWire) -> Result<Self, Self::Error> {
        let legacy = value.item_price_cents.is_none();
        if legacy {
            if value.item_price_aud.is_some()
                || value.shipping_cents.is_some()
                || value.shipping_aud.is_some()
                || value.estimated_tax_cents.is_some()
                || value.estimated_tax_aud.is_some()
                || value.total_price_cents.is_some()
                || value.total_price_aud.is_some()
                || value.comparison_price_cents.is_some()
                || value.comparison_price_aud.is_some()
                || value.price_basis.is_some()
                || value.original_price_text.is_some()
                || value.currency_basis.is_some()
                || value.condition.is_some()
                || value.availability.is_some()
                || value.financing.is_some()
                || value.comparison_eligible.is_some()
                || value.exclusion_reasons.is_some()
            {
                return Err(
                    "A live competitor observation used a partial result contract.".to_string(),
                );
            }
            return Ok(Self {
                search_query: value.search_query,
                selected_product_title: value.selected_product_title,
                selected_product_brand: value.selected_product_brand,
                selected_product_id: value.selected_product_id,
                title: value.title,
                price_cents: value.price_cents,
                price_aud: value.price_aud.clone(),
                item_price_cents: value.price_cents,
                item_price_aud: value.price_aud.clone(),
                shipping_cents: None,
                shipping_aud: None,
                estimated_tax_cents: None,
                estimated_tax_aud: None,
                total_price_cents: None,
                total_price_aud: None,
                comparison_price_cents: None,
                comparison_price_aud: None,
                price_basis: "not_comparable".to_string(),
                original_price_text: value.price_aud,
                currency_basis: "inferred-au-localisation".to_string(),
                currency: value.currency,
                gst_basis: value.gst_basis,
                pack_size: value.pack_size,
                condition: "unknown".to_string(),
                availability: "unknown".to_string(),
                financing: false,
                comparison_eligible: false,
                exclusion_reasons: vec![
                    "unknown_comparison_total".to_string(),
                    "unverified_product_identity".to_string(),
                ],
                seller: value.seller,
                source_domain: value.source_domain,
                url: value.url,
                retrieved_at: value.retrieved_at,
            });
        }
        Ok(Self {
            search_query: value.search_query,
            selected_product_title: value.selected_product_title,
            selected_product_brand: value.selected_product_brand,
            selected_product_id: value.selected_product_id,
            title: value.title,
            price_cents: value.price_cents,
            price_aud: value.price_aud,
            item_price_cents: value.item_price_cents.ok_or_else(|| {
                "A live competitor observation omitted its item price.".to_string()
            })?,
            item_price_aud: value.item_price_aud.ok_or_else(|| {
                "A live competitor observation omitted its item price text.".to_string()
            })?,
            shipping_cents: value.shipping_cents,
            shipping_aud: value.shipping_aud,
            estimated_tax_cents: value.estimated_tax_cents,
            estimated_tax_aud: value.estimated_tax_aud,
            total_price_cents: value.total_price_cents,
            total_price_aud: value.total_price_aud,
            comparison_price_cents: value.comparison_price_cents,
            comparison_price_aud: value.comparison_price_aud,
            price_basis: value.price_basis.ok_or_else(|| {
                "A live competitor observation omitted its price basis.".to_string()
            })?,
            original_price_text: value.original_price_text.ok_or_else(|| {
                "A live competitor observation omitted its original price.".to_string()
            })?,
            currency_basis: value.currency_basis.ok_or_else(|| {
                "A live competitor observation omitted its currency basis.".to_string()
            })?,
            currency: value.currency,
            gst_basis: value.gst_basis,
            pack_size: value.pack_size,
            condition: value.condition.ok_or_else(|| {
                "A live competitor observation omitted its condition.".to_string()
            })?,
            availability: value.availability.ok_or_else(|| {
                "A live competitor observation omitted its availability.".to_string()
            })?,
            financing: value.financing.ok_or_else(|| {
                "A live competitor observation omitted financing status.".to_string()
            })?,
            comparison_eligible: value.comparison_eligible.ok_or_else(|| {
                "A live competitor observation omitted comparison eligibility.".to_string()
            })?,
            exclusion_reasons: value.exclusion_reasons.ok_or_else(|| {
                "A live competitor observation omitted exclusion reasons.".to_string()
            })?,
            seller: value.seller,
            source_domain: value.source_domain,
            url: value.url,
            retrieved_at: value.retrieved_at,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductCandidate {
    token: String,
    title: String,
    brand: Option<String>,
    product_id: Option<String>,
    product_url: String,
    displayed_price: Option<String>,
    price_cents: Option<i64>,
    multiple_sources: bool,
    pack_size: Option<String>,
    condition: String,
    position: i64,
}

#[derive(Debug, Clone)]
struct RememberedCandidate {
    query: String,
    candidate: ProductCandidate,
    issued_at: Instant,
    sequence: u64,
}

#[derive(Default)]
struct RememberedCandidateStore {
    entries: HashMap<String, RememberedCandidate>,
    next_sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectedProduct {
    title: String,
    brand: Option<String>,
    product_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchBand {
    lowest: String,
    median: String,
    highest: String,
    lowest_cents: i64,
    median_cents: i64,
    highest_cents: i64,
    priced_results: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchCoverage {
    provider_queried: String,
    sources_with_price: usize,
    source_domains: Vec<String>,
    priced_results: usize,
    provider_candidates: usize,
    parsed_offers: usize,
    comparable_offers: usize,
    excluded_offers: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchOutcome {
    state: String,
    query: String,
    query_kind: String,
    provider: String,
    candidates: Vec<ProductCandidate>,
    selected_product: Option<SelectedProduct>,
    results: Vec<SearchResult>,
    band: Option<SearchBand>,
    retrieved_at: Option<String>,
    cached: Option<bool>,
    detail: Option<String>,
    coverage: Option<SearchCoverage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DestinationGrant {
    grant_id: String,
    display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InputGrantSummary {
    grant_id: String,
    display_name: String,
    length: u64,
    extension: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BeginExportResult {
    session_id: String,
    conflict: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportBatchFileRequest {
    filename: String,
    length: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportBatchReservation {
    batch_id: String,
}

#[derive(Clone)]
struct PendingImport {
    envelope: ConfigurationEnvelope,
    source_id: String,
    content_sha256: String,
    conflicts: ConfigurationConflicts,
    created_at: Instant,
}

#[derive(Clone)]
struct PendingRestore {
    backup_id: String,
    expected_sha256: String,
    created_at: Instant,
}

#[derive(Clone)]
struct PendingReset {
    counts: BackupRecordCounts,
    provider_paid_calls_enabled: bool,
    credential_configured: bool,
    database_digest: String,
    credential_fingerprint: Option<String>,
    created_at: Instant,
}

#[derive(Clone)]
struct OutputGrant {
    directory: PathBuf,
    identity: DirectoryIdentity,
    _lease: Arc<DirectoryLease>,
    created_at: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DirectoryIdentity {
    #[cfg(windows)]
    Windows { volume: u64, file_id: [u8; 16] },
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
}

struct DirectoryLease {
    #[cfg(windows)]
    handle: usize,
}

#[cfg(windows)]
unsafe impl Send for DirectoryLease {}
#[cfg(windows)]
unsafe impl Sync for DirectoryLease {}

#[cfg(windows)]
impl Drop for DirectoryLease {
    fn drop(&mut self) {
        #[link(name = "Kernel32")]
        extern "system" {
            #[link_name = "CloseHandle"]
            fn close_handle(handle: *mut std::ffi::c_void) -> i32;
        }
        // SAFETY: the handle is created once by CreateFileW and this Arc-owned
        // lease closes it exactly once after all grant clones are gone.
        unsafe { close_handle(self.handle as *mut std::ffi::c_void) };
    }
}

struct InputGrant {
    file: File,
    length: u64,
    created_at: Instant,
}

struct ExportSession {
    #[cfg(test)]
    grant_id: String,
    #[cfg(test)]
    destination: PathBuf,
    temporary: PathBuf,
    filename: String,
    expected_length: u64,
    expected_sha256: String,
    written: u64,
    hasher: Sha256,
    file: Option<File>,
    created_at: Instant,
}

struct ExportBatchFile {
    length: u64,
    sha256: String,
    session_id: Option<String>,
    ready_temporary: Option<PathBuf>,
}

struct ExportBatch {
    grant_id: String,
    files: BTreeMap<String, ExportBatchFile>,
    created_at: Instant,
}

impl Drop for ExportBatch {
    fn drop(&mut self) {
        for file in self.files.values_mut() {
            if let Some(temporary) = file.ready_temporary.take() {
                let _ = fs::remove_file(temporary);
            }
        }
    }
}

impl Drop for ExportSession {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = fs::remove_file(&self.temporary);
    }
}

struct SearchLimiter {
    window_started: Instant,
    calls: u32,
}

impl Default for SearchLimiter {
    fn default() -> Self {
        Self {
            window_started: Instant::now(),
            calls: 0,
        }
    }
}

trait CredentialStore: Send + Sync {
    fn set(&self, secret: &str) -> Result<(), String>;
    fn get(&self) -> Result<Option<String>, String>;
    fn remove(&self) -> Result<(), String>;
}

struct AppState {
    data_dir: PathBuf,
    database_path: PathBuf,
    mutation_gate: Mutex<()>,
    in_flight_provider_searches: AtomicUsize,
    pending_imports: Mutex<HashMap<String, PendingImport>>,
    pending_restores: Mutex<HashMap<String, PendingRestore>>,
    pending_resets: Mutex<HashMap<String, PendingReset>>,
    output_grants: Mutex<HashMap<String, OutputGrant>>,
    input_grants: Mutex<HashMap<String, InputGrant>>,
    export_sessions: Mutex<HashMap<String, ExportSession>>,
    export_batches: Mutex<HashMap<String, ExportBatch>>,
    search_limiter: Mutex<SearchLimiter>,
    search_candidates: Mutex<RememberedCandidateStore>,
    credential_store: Arc<dyn CredentialStore>,
}

impl AppState {
    fn new(data_dir: PathBuf, credential_store: Arc<dyn CredentialStore>) -> Self {
        let database_path = data_dir.join(DATABASE_FILENAME);
        Self {
            data_dir,
            database_path,
            mutation_gate: Mutex::new(()),
            in_flight_provider_searches: AtomicUsize::new(0),
            pending_imports: Mutex::new(HashMap::new()),
            pending_restores: Mutex::new(HashMap::new()),
            pending_resets: Mutex::new(HashMap::new()),
            output_grants: Mutex::new(HashMap::new()),
            input_grants: Mutex::new(HashMap::new()),
            export_sessions: Mutex::new(HashMap::new()),
            export_batches: Mutex::new(HashMap::new()),
            search_limiter: Mutex::new(SearchLimiter::default()),
            search_candidates: Mutex::new(RememberedCandidateStore::default()),
            credential_store,
        }
    }
}

fn safe_lock<T>(value: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    value
        .lock()
        .map_err(|_| "The local operation could not obtain its safety lock.".to_string())
}

fn lock_mutation_gate(state: &AppState) -> Result<MutexGuard<'_, ()>, String> {
    let gate = safe_lock(&state.mutation_gate)?;
    if state.in_flight_provider_searches.load(Ordering::Acquire) != 0 {
        return Err(
            "A native provider search is in progress. Retry this data or credential operation after it finishes."
                .to_string(),
        );
    }
    Ok(gate)
}

struct ProviderSearchLease<'a> {
    in_flight: &'a AtomicUsize,
}

impl Drop for ProviderSearchLease<'_> {
    fn drop(&mut self) {
        let previous = self.in_flight.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "provider search lease underflow");
    }
}

fn prune_expired_and_require_capacity<T, F>(
    values: &mut HashMap<String, T>,
    maximum: usize,
    created_at: F,
    label: &str,
) -> Result<(), String>
where
    F: Fn(&T) -> Instant,
{
    values.retain(|_, value| created_at(value).elapsed() <= TOKEN_TTL);
    if values.len() >= maximum {
        return Err(format!(
            "Too many {label} are active. Finish or cancel one first."
        ));
    }
    Ok(())
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn civil_date(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

fn now_text() -> String {
    let seconds = now_epoch_seconds();
    let (year, month, day) = civil_date((seconds / 86_400) as i64);
    let within_day = seconds % 86_400;
    let hour = within_day / 3_600;
    let minute = (within_day % 3_600) / 60;
    let second = within_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn date_prefix() -> String {
    // Civil date conversion avoids a locale or network dependency and produces
    // the required YYYYMMDD prefix for every native recovery artefact.
    let (year, month, day) = civil_date((now_epoch_seconds() / 86_400) as i64);
    format!("{year:04}{month:02}{day:02}")
}

fn credential_target_for_build_settings(local_profile_value: Option<&str>) -> &'static str {
    if local_profile_value == Some("1") {
        LOCAL_TEST_CREDENTIAL_TARGET
    } else {
        PRODUCTION_CREDENTIAL_TARGET
    }
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.trim() != value
        || value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(format!("{label} is invalid."));
    }
    Ok(())
}

fn validate_text(value: &str, label: &str, max: usize, allow_empty: bool) -> Result<(), String> {
    if (!allow_empty && value.trim().is_empty())
        || value.len() > max
        || value.chars().any(char::is_control)
    {
        return Err(format!("{label} is outside the supported range."));
    }
    Ok(())
}

fn validate_timestamp(value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let shape_ok = matches!(bytes.len(), 20 | 24)
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':')
        && ((bytes.len() == 20 && bytes.get(19) == Some(&b'Z'))
            || (bytes.len() == 24 && bytes.get(19) == Some(&b'.') && bytes.get(23) == Some(&b'Z')))
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) || byte.is_ascii_digit()
        });
    if !shape_ok {
        return Err("Timestamp is invalid.".to_string());
    }
    let parse = |range: std::ops::Range<usize>| -> Result<u32, String> {
        std::str::from_utf8(&bytes[range])
            .ok()
            .and_then(|part| part.parse::<u32>().ok())
            .ok_or_else(|| "Timestamp is invalid.".to_string())
    };
    let year = parse(0..4)?;
    let month = parse(5..7)?;
    let day = parse(8..10)?;
    let hour = parse(11..13)?;
    let minute = parse(14..16)?;
    let second = parse(17..19)?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let maximum_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if year < 2000 || day == 0 || day > maximum_day || hour > 23 || minute > 59 || second > 59 {
        return Err("Timestamp is invalid.".to_string());
    }
    Ok(())
}

fn timestamp_order_key(value: &str) -> Result<[u32; 7], String> {
    validate_timestamp(value)?;
    let parse = |range: std::ops::Range<usize>| {
        value[range]
            .parse::<u32>()
            .map_err(|_| "Timestamp is invalid.".to_string())
    };
    let milliseconds = if value.len() == 24 { parse(20..23)? } else { 0 };
    Ok([
        parse(0..4)?,
        parse(5..7)?,
        parse(8..10)?,
        parse(11..13)?,
        parse(14..16)?,
        parse(17..19)?,
        milliseconds,
    ])
}

fn validate_cents(value: i64, label: &str) -> Result<(), String> {
    if !(0..=1_000_000_000).contains(&value) {
        return Err(format!("{label} is outside the supported range."));
    }
    Ok(())
}

fn minimum_sell_cents(cost_cents: i64) -> Result<i64, String> {
    validate_cents(cost_cents, "Cost")?;
    cost_cents
        .checked_mul(130)
        .and_then(|value| value.checked_add(50))
        .map(|value| value / 100)
        .ok_or_else(|| "The markup calculation exceeded the supported range.".to_string())
}

fn gst_exclusive_cost_cents(cost_cents: i64, gst_basis: &str) -> Result<i64, String> {
    validate_cents(cost_cents, "Cost")?;
    match gst_basis {
        "inc-gst" => cost_cents
            .checked_mul(10)
            .and_then(|value| value.checked_add(5))
            .map(|value| value / 11)
            .ok_or_else(|| {
                "The GST-exclusive cost calculation exceeded the supported range.".to_string()
            }),
        "ex-gst" | "unknown" => Ok(cost_cents),
        _ => Err("GST basis is invalid.".to_string()),
    }
}

fn expected_sell_cents(
    offer_cost_cents: i64,
    cost_gst_basis: &str,
    markup_hundredths: i64,
    sell_gst_basis: &str,
) -> Result<i64, String> {
    if !matches!(cost_gst_basis, "inc-gst" | "ex-gst") {
        return Err("The selected offer GST basis must be confirmed before publication.".into());
    }
    if !(0..=99_999).contains(&markup_hundredths) {
        return Err("The resolved markup is outside the supported range.".into());
    }
    let cost_ex_gst_cents = gst_exclusive_cost_cents(offer_cost_cents, cost_gst_basis)?;
    let sell_ex_gst_cents = cost_ex_gst_cents
        .checked_mul(10_000 + markup_hundredths)
        .and_then(|value| value.checked_add(5_000))
        .map(|value| value / 10_000)
        .ok_or_else(|| {
            "The exact sell-price calculation exceeded the supported range.".to_string()
        })?;
    let sell_cents = match sell_gst_basis {
        "ex-gst" => sell_ex_gst_cents,
        "inc-gst" => sell_ex_gst_cents
            .checked_mul(11)
            .and_then(|value| value.checked_add(5))
            .map(|value| value / 10)
            .ok_or_else(|| {
                "The GST-inclusive sell-price calculation exceeded the supported range.".to_string()
            })?,
        _ => return Err("The sell-price GST basis must be confirmed before publication.".into()),
    };
    validate_cents(sell_cents, "Expected sell price")?;
    Ok(sell_cents)
}

struct SelectedOfferPricingBasis {
    offer_id: Option<String>,
    offer_cost_cents: i64,
    cost_basis_cents: i64,
    supplier_id: Option<String>,
    supplier_name: Option<String>,
    supplier_sku: Option<String>,
    gst_basis: String,
    currency: Option<String>,
}

fn selected_offer_pricing_basis(
    connection: &Connection,
    product_id: &str,
) -> Result<SelectedOfferPricingBasis, String> {
    let selected = connection
        .query_row(
            "SELECT o.id,o.cost_cents,o.gst_basis,o.supplier_id,s.name,o.supplier_sku,o.currency
             FROM product_offer_selections sel
             JOIN product_supplier_offers o ON o.id=sel.offer_id AND o.product_id=sel.product_id
             JOIN suppliers s ON s.id=o.supplier_id AND s.active=1
             WHERE sel.product_id=?1 AND o.active=1
               AND (o.valid_from IS NULL OR datetime(o.valid_from)<=datetime('now'))
               AND (o.valid_until IS NULL OR datetime(o.valid_until)>=datetime('now'))",
            params![product_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "The selected supplier offer could not be validated.".to_string())?;
    match selected {
        Some((
            offer_id,
            cost_cents,
            gst_basis,
            supplier_id,
            supplier_name,
            supplier_sku,
            currency,
        )) => Ok(SelectedOfferPricingBasis {
            offer_id: Some(offer_id),
            offer_cost_cents: cost_cents,
            cost_basis_cents: gst_exclusive_cost_cents(cost_cents, &gst_basis)?,
            supplier_id: Some(supplier_id),
            supplier_name: Some(supplier_name),
            supplier_sku: Some(supplier_sku),
            gst_basis,
            currency: Some(currency),
        }),
        None => Err("An active selected supplier offer is required for publication.".to_string()),
    }
}

fn validate_json(value: &Value, label: &str) -> Result<String, String> {
    let serialised =
        serde_json::to_string(value).map_err(|_| format!("{label} could not be validated."))?;
    if serialised.len() > MAX_JSON_BYTES {
        return Err(format!("{label} is too large."));
    }
    Ok(serialised)
}

fn validate_evidence_money(
    value: &str,
    label: &str,
    require_two_decimals: bool,
) -> Result<i64, String> {
    if value.is_empty() || value.len() > 32 || value.chars().any(char::is_control) {
        return Err(format!("{label} is invalid."));
    }
    let Some((whole, fractional)) = value.split_once('.') else {
        return Err(format!("{label} is invalid."));
    };
    let fractional_length_ok = if require_two_decimals {
        fractional.len() == 2
    } else {
        matches!(fractional.len(), 1 | 2)
    };
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fractional_length_ok
        || !fractional.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(format!("{label} is invalid."));
    }
    let whole = whole
        .parse::<i64>()
        .map_err(|_| format!("{label} is outside the supported range."))?;
    let first = i64::from(fractional.as_bytes()[0] - b'0');
    let second = fractional
        .as_bytes()
        .get(1)
        .map(|byte| i64::from(*byte - b'0'))
        .unwrap_or(0);
    let cents = whole
        .checked_mul(100)
        .and_then(|amount| amount.checked_add(first * 10 + second))
        .ok_or_else(|| format!("{label} is outside the supported range."))?;
    validate_cents(cents, label)?;
    Ok(cents)
}

fn validate_optional_evidence_money(
    cents: Option<i64>,
    amount: Option<&str>,
    label: &str,
) -> Result<(), String> {
    match (cents, amount) {
        (None, None) => Ok(()),
        (Some(cents), Some(amount)) => {
            validate_cents(cents, label)?;
            if validate_evidence_money(amount, label, true)? != cents {
                return Err(format!("{label} fields do not agree."));
            }
            Ok(())
        }
        _ => Err(format!("{label} fields do not agree.")),
    }
}

fn validate_live_competitor_evidence(evidence: &LiveCompetitorEvidence) -> Result<(), String> {
    let has_selection_context = evidence.search_query.is_some()
        || evidence.selected_product_title.is_some()
        || evidence.selected_product_brand.is_some()
        || evidence.selected_product_id.is_some();
    if has_selection_context {
        validate_text(
            evidence
                .search_query
                .as_deref()
                .ok_or_else(|| "Competitor search context is incomplete.".to_string())?,
            "Competitor search query",
            512,
            false,
        )?;
        validate_text(
            evidence
                .selected_product_title
                .as_deref()
                .ok_or_else(|| "Competitor search context is incomplete.".to_string())?,
            "Competitor selected product title",
            1_000,
            false,
        )?;
        if let Some(brand) = evidence.selected_product_brand.as_deref() {
            validate_text(brand, "Competitor selected product brand", 256, false)?;
        }
        if let Some(product_id) = evidence.selected_product_id.as_deref() {
            validate_text(
                product_id,
                "Competitor selected product identifier",
                256,
                false,
            )?;
        }
    }
    validate_text(&evidence.title, "Competitor title", 1_000, false)?;
    validate_cents(evidence.price_cents, "Competitor price")?;
    if validate_evidence_money(&evidence.price_aud, "Competitor price", true)?
        != evidence.price_cents
    {
        return Err("Competitor price fields do not agree.".to_string());
    }
    validate_cents(evidence.item_price_cents, "Competitor item price")?;
    if evidence.price_cents != evidence.item_price_cents
        || validate_evidence_money(&evidence.item_price_aud, "Competitor item price", true)?
            != evidence.item_price_cents
    {
        return Err("Competitor item price fields do not agree.".to_string());
    }
    validate_optional_evidence_money(
        evidence.shipping_cents,
        evidence.shipping_aud.as_deref(),
        "Competitor shipping",
    )?;
    validate_optional_evidence_money(
        evidence.estimated_tax_cents,
        evidence.estimated_tax_aud.as_deref(),
        "Competitor estimated tax",
    )?;
    validate_optional_evidence_money(
        evidence.total_price_cents,
        evidence.total_price_aud.as_deref(),
        "Competitor total price",
    )?;
    validate_optional_evidence_money(
        evidence.comparison_price_cents,
        evidence.comparison_price_aud.as_deref(),
        "Competitor comparison price",
    )?;
    if !matches!(
        evidence.price_basis.as_str(),
        "provider_total" | "item_plus_shipping" | "not_comparable"
    ) {
        return Err("Competitor price basis is invalid.".to_string());
    }
    validate_text(
        &evidence.original_price_text,
        "Competitor original price",
        64,
        false,
    )?;
    if !matches!(
        evidence.currency_basis.as_str(),
        "explicit-aud" | "inferred-au-localisation"
    ) {
        return Err("Competitor currency basis is invalid.".to_string());
    }
    if parse_aud_cents(&evidence.original_price_text) != Some(evidence.item_price_cents)
        || currency_basis(&evidence.original_price_text)
            .is_some_and(|basis| basis != evidence.currency_basis.as_str())
    {
        return Err("Competitor original price fields do not agree.".to_string());
    }
    if evidence.currency != "AUD" {
        return Err("Competitor currency is invalid.".to_string());
    }
    if !matches!(
        evidence.gst_basis.as_str(),
        "inc-gst" | "ex-gst" | "unknown"
    ) {
        return Err("Competitor GST basis is invalid.".to_string());
    }
    if let Some(pack_size) = evidence.pack_size.as_deref() {
        validate_text(pack_size, "Competitor pack size", 256, true)?;
    }
    if !matches!(evidence.condition.as_str(), "new" | "used" | "unknown") {
        return Err("Competitor condition is invalid.".to_string());
    }
    if !matches!(
        evidence.availability.as_str(),
        "in-stock" | "out-of-stock" | "unknown"
    ) {
        return Err("Competitor availability is invalid.".to_string());
    }
    if evidence.exclusion_reasons.len() > 20 {
        return Err("Competitor exclusions are invalid.".to_string());
    }
    let mut exclusions = HashSet::new();
    for reason in &evidence.exclusion_reasons {
        validate_text(reason, "Competitor exclusion", 128, false)?;
        if !exclusions.insert(reason) {
            return Err("Competitor exclusions are invalid.".to_string());
        }
    }
    if evidence.comparison_eligible {
        let comparison = evidence
            .comparison_price_cents
            .ok_or_else(|| "Competitor comparison is invalid.".to_string())?;
        if !evidence.exclusion_reasons.is_empty() || evidence.price_basis == "not_comparable" {
            return Err("Competitor comparison is invalid.".to_string());
        }
        match evidence.price_basis.as_str() {
            "provider_total" if evidence.total_price_cents == Some(comparison) => {}
            "item_plus_shipping"
                if evidence
                    .shipping_cents
                    .and_then(|shipping| evidence.item_price_cents.checked_add(shipping))
                    == Some(comparison) => {}
            _ => return Err("Competitor comparison is invalid.".to_string()),
        }
    } else if evidence.exclusion_reasons.is_empty()
        || evidence.comparison_price_cents.is_some()
        || evidence.price_basis != "not_comparable"
    {
        return Err("Competitor exclusion is invalid.".to_string());
    }
    if (evidence.financing && evidence.total_price_cents.is_none() && evidence.comparison_eligible)
        || (evidence.condition == "used" && evidence.comparison_eligible)
        || (evidence.availability == "out-of-stock" && evidence.comparison_eligible)
    {
        return Err("Competitor eligibility is invalid.".to_string());
    }
    validate_text(&evidence.seller, "Competitor seller", 512, false)?;
    validate_text(
        &evidence.source_domain,
        "Competitor source domain",
        253,
        false,
    )?;
    let source_url = validate_source_url(&evidence.url)?;
    if !source_url
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case(&evidence.source_domain))
    {
        return Err("Competitor source domain does not match its URL.".to_string());
    }
    let source_host = source_url.host_str().unwrap_or_default();
    if [
        "serpapi.com",
        "google.com",
        "google.com.au",
        "googleadservices.com",
    ]
    .iter()
    .any(|parent| is_host_or_subdomain(source_host, parent))
    {
        return Err("Competitor URL is not a direct merchant URL.".to_string());
    }
    validate_timestamp(&evidence.retrieved_at)
}

fn validate_manual_competitor_evidence(evidence: &ManualCompetitorEvidence) -> Result<(), String> {
    validate_identifier(&evidence.sku, "Competitor SKU")?;
    validate_text(&evidence.source_name, "Competitor source name", 256, false)?;
    validate_timestamp(&evidence.observed_at)?;
    validate_evidence_money(&evidence.price, "Competitor price", false)?;
    validate_evidence_money(&evidence.shipping, "Competitor shipping", false)?;
    if evidence.currency != "AUD" {
        return Err("Competitor currency is invalid.".to_string());
    }
    if !matches!(
        evidence.gst_basis.as_str(),
        "inc-gst" | "ex-gst" | "unknown"
    ) {
        return Err("Competitor GST basis is invalid.".to_string());
    }
    if !matches!(
        evidence.stock_status.as_str(),
        "in-stock" | "out-of-stock" | "unknown"
    ) {
        return Err("Competitor stock status is invalid.".to_string());
    }
    if !matches!(evidence.condition.as_str(), "new" | "used" | "unknown") {
        return Err("Competitor condition is invalid.".to_string());
    }
    if !evidence.match_confidence.is_finite() || !(0.0..=1.0).contains(&evidence.match_confidence) {
        return Err("Competitor match confidence is invalid.".to_string());
    }
    if !matches!(
        evidence.review_state.as_str(),
        "accepted" | "rejected" | "quarantined"
    ) {
        return Err("Competitor review state is invalid.".to_string());
    }
    if let Some(url) = evidence.url.as_deref() {
        validate_source_url(url)?;
    }
    if let Some(pack_size) = evidence.pack_size.as_deref() {
        validate_text(pack_size, "Competitor pack size", 256, true)?;
    }
    Ok(())
}

fn validate_competitor_evidence(evidence: &CompetitorEvidence) -> Result<(), String> {
    match evidence {
        CompetitorEvidence::Live(value) => validate_live_competitor_evidence(value),
        CompetitorEvidence::Manual(value) => validate_manual_competitor_evidence(value),
    }
}

fn validate_catalogue_item(item: &CatalogueItem) -> Result<(), String> {
    validate_identifier(&item.id, "Item identifier")?;
    validate_identifier(&item.item_number, "Item number")?;
    validate_text(
        &item.description,
        "Item description",
        MAX_DESCRIPTION_BYTES,
        true,
    )?;
    validate_cents(item.cost_cents, "Cost")?;
    validate_cents(item.sell_price_cents, "Sell price")?;
    validate_timestamp(&item.updated_at)?;
    if !matches!(item.gst_basis.as_str(), "inc-gst" | "ex-gst" | "unknown") {
        return Err("GST basis is invalid.".to_string());
    }
    if !matches!(
        item.sell_price_gst_basis.as_str(),
        "inc-gst" | "ex-gst" | "unknown"
    ) {
        return Err("Sell-price GST basis is invalid.".to_string());
    }
    if !matches!(
        item.item_kind.as_str(),
        "physical-product" | "service" | "labour"
    ) {
        return Err("Item kind is invalid.".to_string());
    }
    if let Some(value) = item.brand_id.as_deref() {
        validate_identifier(value, "Brand identifier")?;
    }
    if let Some(value) = item.markup_override_percent.as_deref() {
        parse_markup_override_hundredths(value)?;
    }
    validate_optional_text(item.xero_reference.as_deref(), "Xero reference", 256)?;
    validate_optional_text(
        item.servicem8_reference.as_deref(),
        "ServiceM8 reference",
        256,
    )?;
    if let Some(value) = item.barcode.as_deref() {
        if value.len() > 64 || value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("Barcode must contain 1 to 64 digits.".to_string());
        }
    }
    if let Some(value) = item.selected_offer_id.as_deref() {
        validate_identifier(value, "Selected offer identifier")?;
    }
    Ok(())
}

fn validate_profile(profile: &MappingProfileRecord) -> Result<(), String> {
    validate_identifier(&profile.id, "Profile identifier")?;
    validate_text(&profile.name, "Profile name", 160, false)?;
    if !(1..=1_000_000).contains(&profile.version)
        || profile.supplier_headers.len() > 512
        || profile.servicem8_headers.len() > 512
        || profile.supplier_mapping.len() > 512
        || profile.servicem8_mapping.len() > 512
    {
        return Err("The mapping profile is outside the supported range.".to_string());
    }
    for header in profile
        .supplier_headers
        .iter()
        .chain(profile.servicem8_headers.iter())
    {
        validate_text(header, "Mapping header", 512, true)?;
    }
    for index in profile
        .supplier_mapping
        .values()
        .chain(profile.servicem8_mapping.values())
    {
        if !(0..=4_095).contains(index) {
            return Err("A mapping column is outside the supported range.".to_string());
        }
    }
    validate_timestamp(&profile.created_at)?;
    validate_timestamp(&profile.updated_at)?;
    let value = serde_json::to_value(profile)
        .map_err(|_| "The mapping profile could not be validated.".to_string())?;
    validate_json(&value, "Mapping profile")?;
    Ok(())
}

fn validate_alias(alias: &AliasRecord) -> Result<(), String> {
    validate_identifier(&alias.supplier_code, "Supplier code")?;
    validate_identifier(&alias.item_number, "Item number")?;
    validate_timestamp(&alias.approved_at)
}

fn validate_source(source: &SourceRecord) -> Result<(), String> {
    validate_identifier(&source.id, "Source identifier")?;
    validate_text(&source.name, "Source name", 256, false)?;
    validate_text(
        &source.automated_access_note,
        "Automated access note",
        2_000,
        true,
    )?;
    if !matches!(
        source.access_method.as_str(),
        "live-api" | "manual-entry" | "file-import"
    ) {
        return Err("Source access method is invalid.".to_string());
    }
    Ok(())
}

fn money_string(cents: i64) -> String {
    format!("{}.{:02}", cents / 100, cents % 100)
}

fn markup_string(hundredths: i64) -> String {
    let whole = hundredths / 100;
    let fraction = hundredths % 100;
    if fraction == 0 {
        whole.to_string()
    } else if fraction % 10 == 0 {
        format!("{whole}.{}", fraction / 10)
    } else {
        format!("{whole}.{fraction:02}")
    }
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|_| "The backup could not be verified.".to_string())?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    // Tauri initialises the database on the Windows GUI thread, whose default
    // stack reserve is 1 MiB. Keep the bounded streaming buffer on the heap so
    // creating the first migration backup cannot exhaust that stack.
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| "The backup could not be verified.".to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn hash_digest_part(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

/// Hashes the complete logical native store in a deterministic order. The
/// digest binds destructive-operation previews to record values and policy,
/// not merely to counts, while no business value crosses IPC or enters logs.
fn logical_database_digest(connection: &Connection) -> Result<String, String> {
    const QUERIES: &[(&str, &str, usize)] = &[
        (
            "schema_migrations",
            "SELECT version,name,sha256,applied_at FROM schema_migrations ORDER BY version",
            4,
        ),
        (
            "schema_metadata",
            "SELECT version FROM schema_metadata ORDER BY version",
            1,
        ),
        (
            "catalogue_items",
            "SELECT id,item_number,description,cost_cents,sell_price_cents,gst_basis,sell_price_gst_basis,item_kind,brand_id,product_markup_hundredths,description_source,upstream_reference,servicem8_reference,barcode,updated_at FROM catalogue_items ORDER BY id",
            15,
        ),
        (
            "approvals",
            "SELECT id,item_id,approved_by,proposed_sell_cents,reason,approved_at FROM approvals ORDER BY id",
            6,
        ),
        (
            "price_history",
            "SELECT id,item_id,cost_cents,sell_price_cents,approval_id,selected_offer_id,cost_basis_cents,markup_source_type,markup_source_id,applied_markup_hundredths,supplier_id_snapshot,supplier_name_snapshot,supplier_sku_snapshot,cost_gst_basis,sell_price_gst_basis,currency,brand_id_snapshot,item_kind_snapshot,pricing_explanation,pricing_rule_version,provenance_state,recorded_at FROM price_history ORDER BY id",
            22,
        ),
        (
            "competitor_references",
            "SELECT id,item_id,observation_json,attached_at FROM competitor_references ORDER BY id",
            4,
        ),
        (
            "source_registry",
            "SELECT id,state_json,updated_at FROM source_registry ORDER BY id",
            3,
        ),
        (
            "mapping_profiles",
            "SELECT id,profile_json,updated_at FROM mapping_profiles ORDER BY id",
            3,
        ),
        (
            "approved_aliases",
            "SELECT supplier_code,item_number,approved_at FROM approved_aliases ORDER BY supplier_code",
            3,
        ),
        (
            "settings",
            "SELECT id,settings_json,updated_at FROM settings ORDER BY id",
            3,
        ),
        (
            "configuration_imports",
            "SELECT source_id,content_sha256,imported_at,profile_count,alias_count,settings_count FROM configuration_imports ORDER BY source_id",
            6,
        ),
        (
            "provider_state",
            "SELECT provider,paid_calls_enabled,last_validated_at,cost_ceiling_cents,cost_per_call_cents,spent_cents FROM provider_state ORDER BY provider",
            6,
        ),
        ("brands","SELECT id,name,canonical_key,markup_hundredths,updated_at FROM brands ORDER BY id",5),
        ("suppliers","SELECT id,name,active,external_reference,updated_at FROM suppliers ORDER BY id",5),
        ("product_supplier_offers","SELECT id,product_id,supplier_id,supplier_sku,normalized_supplier_sku,cost_cents,gst_basis,currency,active,is_preferred,valid_from,valid_until,provenance_type,provenance_reference,observed_at FROM product_supplier_offers ORDER BY id",15),
        ("product_offer_selections","SELECT product_id,offer_id,selected_by,reason,selected_at FROM product_offer_selections ORDER BY product_id",5),
        ("supplier_offer_versions","SELECT offer_id,version,snapshot_json,changed_at FROM supplier_offer_versions ORDER BY offer_id,version",4),
        ("offer_selection_versions","SELECT product_id,version,snapshot_json,changed_at FROM offer_selection_versions ORDER BY product_id,version",4),
        ("supplier_versions","SELECT supplier_id,version,snapshot_json,changed_at FROM supplier_versions ORDER BY supplier_id,version",4),
        ("brand_versions","SELECT brand_id,version,snapshot_json,changed_at FROM brand_versions ORDER BY brand_id,version",4),
        ("product_metadata_versions","SELECT product_id,version,snapshot_json,changed_at FROM product_metadata_versions ORDER BY product_id,version",4),
        ("sync_runs","SELECT id,system,direction,status,mode,started_at,completed_at,approved_by,summary_json FROM sync_runs ORDER BY id",9),
        ("sync_checkpoints","SELECT id,run_id,cursor_value,recorded_at FROM sync_checkpoints ORDER BY id",4),
        ("sync_item_outcomes","SELECT id,run_id,item_id,external_id,action,status,message,idempotency_key,attempt_count,retryable,error_class,reconciliation,recorded_at FROM sync_item_outcomes ORDER BY id",13),
        ("settings_audit","SELECT id,previous_json,current_json,changed_by,changed_at FROM settings_audit ORDER BY id",5),
    ];

    let mut hasher = Sha256::new();
    for (label, sql, columns) in QUERIES {
        hash_digest_part(&mut hasher, label.as_bytes());
        let mut statement = connection
            .prepare(sql)
            .map_err(|_| "The reset preview could not inspect the local database.".to_string())?;
        let mut rows = statement
            .query([])
            .map_err(|_| "The reset preview could not inspect the local database.".to_string())?;
        while let Some(row) = rows
            .next()
            .map_err(|_| "The reset preview could not inspect the local database.".to_string())?
        {
            hasher.update([0xff]);
            for index in 0..*columns {
                use rusqlite::types::ValueRef;
                match row.get_ref(index).map_err(|_| {
                    "The reset preview could not inspect the local database.".to_string()
                })? {
                    ValueRef::Null => hasher.update([0]),
                    ValueRef::Integer(value) => {
                        hasher.update([1]);
                        hasher.update(value.to_le_bytes());
                    }
                    ValueRef::Real(value) => {
                        hasher.update([2]);
                        hasher.update(value.to_bits().to_le_bytes());
                    }
                    ValueRef::Text(value) => {
                        hasher.update([3]);
                        hash_digest_part(&mut hasher, value);
                    }
                    ValueRef::Blob(value) => {
                        hasher.update([4]);
                        hash_digest_part(&mut hasher, value);
                    }
                }
            }
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn credential_fingerprint(state: &AppState) -> Result<Option<String>, String> {
    state
        .credential_store
        .get()
        .map(|secret| secret.map(|value| sha256_bytes(value.as_bytes())))
}

fn open_connection(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
    )
    .map_err(|_| "The local database could not be opened.".to_string())?;
    configure_connection(connection)
}

fn open_connection_create(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
    )
    .map_err(|_| "The local database could not be created.".to_string())?;
    configure_connection(connection)
}

fn configure_connection(connection: Connection) -> Result<Connection, String> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
        )
        .map_err(|_| "The local database safety settings could not be enabled.".to_string())?;
    Ok(connection)
}

fn open_readonly_connection(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "The local database could not be opened safely.".to_string())
}

fn assert_integrity(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA integrity_check")
        .map_err(|_| "The local database failed its integrity check.".to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "The local database failed its integrity check.".to_string())?;
    let results = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "The local database failed its integrity check.".to_string())?;
    if results.as_slice() != ["ok"] {
        return Err("The local database failed its integrity check.".to_string());
    }
    let mut foreign_keys = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(|_| "The local database failed its relationship check.".to_string())?;
    if foreign_keys
        .query([])
        .and_then(|mut rows| rows.next().map(|row| row.is_some()))
        .map_err(|_| "The local database failed its relationship check.".to_string())?
    {
        return Err("The local database failed its relationship check.".to_string());
    }
    Ok(())
}

fn schema_version(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row("SELECT version FROM schema_metadata LIMIT 1", [], |row| {
            row.get(0)
        })
        .map_err(|_| "The database schema could not be read.".to_string())
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    if !COUNT_TABLES.iter().any(|(_, allowed)| *allowed == table)
        && !matches!(table, "schema_metadata" | "schema_migrations")
    {
        return Err("A database metadata target was rejected.".to_string());
    }
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            params![table],
            |row| row.get(0),
        )
        .map_err(|_| "The database metadata could not be read.".to_string())
}

fn schema_version_or_zero(connection: &Connection) -> Result<i64, String> {
    if table_exists(connection, "schema_metadata")? {
        schema_version(connection)
    } else {
        Ok(0)
    }
}

fn table_count(connection: &Connection, table: &str) -> Result<i64, String> {
    if !COUNT_TABLES.iter().any(|(_, allowed)| *allowed == table) {
        return Err("A database count target was rejected.".to_string());
    }
    connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(|_| "The database record counts could not be read.".to_string())
}

fn record_counts(connection: &Connection) -> Result<BackupRecordCounts, String> {
    Ok(BackupRecordCounts {
        catalogue_items: table_count(connection, "catalogue_items")?,
        approvals: table_count(connection, "approvals")?,
        price_history: table_count(connection, "price_history")?,
        competitor_references: table_count(connection, "competitor_references")?,
        sources: table_count(connection, "source_registry")?,
        profiles: table_count(connection, "mapping_profiles")?,
        aliases: table_count(connection, "approved_aliases")?,
        settings: table_count(connection, "settings")?,
        brands: table_count(connection, "brands")?,
        suppliers: table_count(connection, "suppliers")?,
        product_supplier_offers: table_count(connection, "product_supplier_offers")?,
        product_offer_selections: table_count(connection, "product_offer_selections")?,
        supplier_offer_versions: table_count(connection, "supplier_offer_versions")?,
        offer_selection_versions: table_count(connection, "offer_selection_versions")?,
        supplier_versions: table_count(connection, "supplier_versions")?,
        brand_versions: table_count(connection, "brand_versions")?,
        product_metadata_versions: table_count(connection, "product_metadata_versions")?,
        sync_runs: table_count(connection, "sync_runs")?,
        sync_checkpoints: table_count(connection, "sync_checkpoints")?,
        sync_item_outcomes: table_count(connection, "sync_item_outcomes")?,
        settings_audit: table_count(connection, "settings_audit")?,
    })
}

fn record_counts_for_version(
    connection: &Connection,
    version: i64,
) -> Result<BackupRecordCounts, String> {
    if version >= CURRENT_SCHEMA_VERSION {
        return record_counts(connection);
    }
    let count = |table: &str| -> Result<i64, String> {
        if table_exists(connection, table)? {
            table_count(connection, table)
        } else {
            Ok(0)
        }
    };
    Ok(BackupRecordCounts {
        catalogue_items: count("catalogue_items")?,
        approvals: count("approvals")?,
        price_history: count("price_history")?,
        competitor_references: count("competitor_references")?,
        sources: count("source_registry")?,
        profiles: count("mapping_profiles")?,
        aliases: count("approved_aliases")?,
        settings: count("settings")?,
        brands: count("brands")?,
        suppliers: count("suppliers")?,
        product_supplier_offers: count("product_supplier_offers")?,
        product_offer_selections: count("product_offer_selections")?,
        supplier_offer_versions: count("supplier_offer_versions")?,
        offer_selection_versions: count("offer_selection_versions")?,
        supplier_versions: count("supplier_versions")?,
        brand_versions: count("brand_versions")?,
        product_metadata_versions: count("product_metadata_versions")?,
        sync_runs: count("sync_runs")?,
        sync_checkpoints: count("sync_checkpoints")?,
        sync_item_outcomes: count("sync_item_outcomes")?,
        settings_audit: count("settings_audit")?,
    })
}

fn validate_backup_id(id: &str) -> Result<(), String> {
    let Some((date, uuid_text)) = id.split_once("-SWL-Backup-") else {
        return Err("The backup identifier is invalid.".to_string());
    };
    if date.len() != 8 || !date.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("The backup identifier is invalid.".to_string());
    }
    let year = date[0..4].parse::<u32>().unwrap_or_default();
    let month = date[4..6].parse::<u32>().unwrap_or_default();
    let day = date[6..8].parse::<u32>().unwrap_or_default();
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let maximum_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    let uuid =
        Uuid::parse_str(uuid_text).map_err(|_| "The backup identifier is invalid.".to_string())?;
    if year < 2000 || day == 0 || day > maximum_day || uuid.hyphenated().to_string() != uuid_text {
        return Err("The backup identifier is invalid.".to_string());
    }
    Ok(())
}

fn backup_paths(data_dir: &Path, id: &str) -> Result<(PathBuf, PathBuf), String> {
    validate_backup_id(id)?;
    let directory = data_dir.join(BACKUP_DIRECTORY);
    let paths = (
        directory.join(format!("{id}.sqlite3")),
        directory.join(format!("{id}.manifest.json")),
    );
    if paths.0.parent() != Some(directory.as_path())
        || paths.1.parent() != Some(directory.as_path())
    {
        return Err("The backup path escaped its application-data folder.".to_string());
    }
    Ok(paths)
}

fn sqlite_backup(source_path: &Path, destination_path: &Path) -> Result<(), String> {
    if destination_path.exists() {
        return Err("The backup destination already exists.".to_string());
    }
    // Opening the live source read-only is essential: even changing journal
    // mode before the copy would mutate the database that this backup protects.
    let source = open_readonly_connection(source_path)?;
    assert_integrity(&source)?;
    let mut destination = Connection::open(destination_path)
        .map_err(|_| "The backup could not be created.".to_string())?;
    let backup = rusqlite::backup::Backup::new(&source, &mut destination)
        .map_err(|_| "The backup could not be created.".to_string())?;
    backup
        .run_to_completion(16, Duration::from_millis(20), None)
        .map_err(|_| "The backup could not be created.".to_string())?;
    drop(backup);
    assert_integrity(&destination)?;
    destination
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|_| "The backup could not be finalised.".to_string())?;
    drop(destination);
    Ok(())
}

fn write_json_atomically(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| "The recovery metadata could not be encoded.".to_string())?;
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.flush()?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("The recovery metadata could not be written safely.".to_string());
    }
    Ok(())
}

fn create_verified_backup_at(
    database_path: &Path,
    data_dir: &Path,
    reason: &str,
) -> Result<BackupSummary, String> {
    validate_text(reason, "Backup reason", 64, false)?;
    let backup_directory = data_dir.join(BACKUP_DIRECTORY);
    fs::create_dir_all(&backup_directory)
        .map_err(|_| "The backup folder could not be created.".to_string())?;
    reject_link_components(&backup_directory)?;
    let id = format!("{}-SWL-Backup-{}", date_prefix(), Uuid::new_v4());
    let (database_backup, manifest_path) = backup_paths(data_dir, &id)?;
    if let Err(error) = sqlite_backup(database_path, &database_backup) {
        let _ = fs::remove_file(&database_backup);
        return Err(error);
    }
    let result = (|| -> Result<BackupSummary, String> {
        let backup_connection = open_connection(&database_backup)?;
        let version = schema_version_or_zero(&backup_connection)?;
        let counts = record_counts_for_version(&backup_connection, version)?;
        if version == CURRENT_SCHEMA_VERSION {
            validate_current_database(&backup_connection)?;
        } else {
            assert_integrity(&backup_connection)?;
        }
        drop(backup_connection);
        let byte_length = fs::metadata(&database_backup)
            .map_err(|_| "The backup could not be verified.".to_string())?
            .len();
        let sha256 = sha256_file(&database_backup)?;
        let summary = BackupSummary {
            id: id.clone(),
            filename: format!("{id}.sqlite3"),
            created_at: now_text(),
            application_version: env!("CARGO_PKG_VERSION").to_string(),
            schema_version: version,
            sha256,
            record_counts: counts,
        };
        let manifest = BackupManifest {
            summary: summary.clone(),
            byte_length,
            reason: reason.to_string(),
        };
        write_json_atomically(&manifest_path, &manifest)?;
        verify_backup(data_dir, &id)?;
        Ok(summary)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&database_backup);
        let _ = fs::remove_file(&manifest_path);
    }
    result
}

fn read_backup_manifest(data_dir: &Path, id: &str) -> Result<BackupManifest, String> {
    let (_, manifest_path) = backup_paths(data_dir, id)?;
    reject_link_components(&manifest_path)?;
    let path_metadata = fs::symlink_metadata(&manifest_path)
        .map_err(|_| "The selected backup metadata could not be read.".to_string())?;
    if !path_metadata.is_file()
        || path_metadata.file_type().is_symlink()
        || is_reparse_point(&path_metadata)
        || path_metadata.len() > MAX_JSON_BYTES as u64
    {
        return Err("The selected backup metadata is invalid.".to_string());
    }
    let file = File::open(&manifest_path)
        .map_err(|_| "The selected backup metadata could not be read.".to_string())?;
    let handle_metadata = file
        .metadata()
        .map_err(|_| "The selected backup metadata could not be read.".to_string())?;
    if !handle_metadata.is_file()
        || is_reparse_point(&handle_metadata)
        || handle_metadata.len() != path_metadata.len()
    {
        return Err("The selected backup metadata changed while it was opened.".to_string());
    }
    let mut bytes = Vec::with_capacity(handle_metadata.len() as usize);
    file.take(MAX_JSON_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "The selected backup metadata could not be read.".to_string())?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err("The selected backup metadata is too large.".to_string());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "The selected backup metadata is invalid.".to_string())
}

fn verify_backup(data_dir: &Path, id: &str) -> Result<BackupManifest, String> {
    let manifest = read_backup_manifest(data_dir, id)?;
    if manifest.summary.id != id
        || manifest.summary.application_version.is_empty()
        || manifest.summary.schema_version < 0
        || manifest.summary.sha256.len() != 64
    {
        return Err("The selected backup metadata is invalid.".to_string());
    }
    let (database_backup, _) = backup_paths(data_dir, id)?;
    reject_link_components(&database_backup)?;
    let metadata = fs::symlink_metadata(&database_backup)
        .map_err(|_| "The selected backup could not be read.".to_string())?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || is_reparse_point(&metadata)
    {
        return Err("The selected backup is not a regular file.".to_string());
    }
    if metadata.len() != manifest.byte_length
        || sha256_file(&database_backup)? != manifest.summary.sha256
    {
        return Err("The selected backup checksum did not match.".to_string());
    }
    let connection = open_connection(&database_backup)?;
    assert_integrity(&connection)?;
    let version = schema_version_or_zero(&connection)?;
    if version != manifest.summary.schema_version
        || record_counts_for_version(&connection, version)? != manifest.summary.record_counts
    {
        return Err("The selected backup record counts did not match.".to_string());
    }
    if version == CURRENT_SCHEMA_VERSION {
        validate_current_database(&connection)?;
    }
    Ok(manifest)
}

const PARTIAL_SHELL_TABLES: &[&str] = &[
    "schema_metadata",
    "catalogue_items",
    "approvals",
    "price_history",
    "competitor_references",
    "source_registry",
    "mapping_profiles",
    "approved_aliases",
    "settings",
];

fn classify_unversioned_database(connection: &Connection) -> Result<Option<bool>, String> {
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_master
             WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map_err(|_| "The unversioned database schema could not be inspected.".to_string())?;
    let tables = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "The unversioned database schema could not be inspected.".to_string())?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|_| "The unversioned database schema could not be inspected.".to_string())?;
    if tables.is_empty() {
        return Ok(None);
    }
    let expected = PARTIAL_SHELL_TABLES
        .iter()
        .map(|table| (*table).to_string())
        .collect::<HashSet<_>>();
    if tables != expected {
        return Ok(Some(false));
    }
    let versions = connection
        .prepare("SELECT version FROM schema_metadata")
        .and_then(|mut query| {
            query
                .query_map([], |row| row.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| "The former SWL schema metadata is invalid.".to_string())?;
    if versions != [1] {
        return Ok(Some(false));
    }
    Ok(Some(true))
}

fn rebuild_partial_shell_schema(
    transaction: &Transaction<'_>,
    migration_sql: &str,
) -> Result<(), String> {
    transaction
        .execute_batch(
            "DROP TRIGGER IF EXISTS price_history_no_update;
             DROP TRIGGER IF EXISTS price_history_no_delete;
             ALTER TABLE schema_metadata RENAME TO former_schema_metadata;
             ALTER TABLE catalogue_items RENAME TO former_catalogue_items;
             ALTER TABLE approvals RENAME TO former_approvals;
             ALTER TABLE price_history RENAME TO former_price_history;
             ALTER TABLE competitor_references RENAME TO former_competitor_references;
             ALTER TABLE source_registry RENAME TO former_source_registry;
             ALTER TABLE mapping_profiles RENAME TO former_mapping_profiles;
             ALTER TABLE approved_aliases RENAME TO former_approved_aliases;
             ALTER TABLE settings RENAME TO former_settings;",
        )
        .map_err(|_| "The former SWL schema could not be prepared safely.".to_string())?;
    transaction
        .execute_batch(migration_sql)
        .map_err(|_| "The replacement SWL schema could not be created.".to_string())?;
    transaction
        .execute_batch(
            "INSERT INTO catalogue_items(id,item_number,description,cost_cents,sell_price_cents,gst_basis,updated_at)
               SELECT id,item_number,description,cost_cents,sell_price_cents,gst_basis,updated_at FROM former_catalogue_items;
             INSERT INTO approvals(id,item_id,approved_by,proposed_sell_cents,reason,approved_at)
               SELECT id,item_id,approved_by,proposed_sell_cents,reason,approved_at FROM former_approvals;
             INSERT INTO price_history(id,item_id,cost_cents,sell_price_cents,approval_id,recorded_at)
               SELECT id,item_id,cost_cents,sell_price_cents,approval_id,recorded_at FROM former_price_history;
             INSERT INTO competitor_references(id,item_id,observation_json,attached_at)
               SELECT id,item_id,observation_json,attached_at FROM former_competitor_references;
             INSERT INTO source_registry(id,state_json,updated_at)
               SELECT id,state_json,updated_at FROM former_source_registry;
             INSERT INTO mapping_profiles(id,profile_json,updated_at)
               SELECT id,profile_json,updated_at FROM former_mapping_profiles;
             INSERT INTO approved_aliases(supplier_code,item_number,approved_at)
               SELECT supplier_code,item_number,approved_at FROM former_approved_aliases;
             INSERT INTO settings(id,settings_json,updated_at)
               SELECT id,settings_json,updated_at FROM former_settings;",
        )
        .map_err(|_| {
            "Former SWL records did not satisfy the current validated schema.".to_string()
        })?;
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
        let former = format!("former_{table}");
        let former_count: i64 = transaction
            .query_row(&format!("SELECT COUNT(*) FROM {former}"), [], |row| {
                row.get(0)
            })
            .map_err(|_| "Former SWL record counts could not be verified.".to_string())?;
        let current_count: i64 = transaction
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .map_err(|_| "Migrated SWL record counts could not be verified.".to_string())?;
        if former_count != current_count {
            return Err("Migrated SWL record counts did not match.".to_string());
        }
    }
    transaction
        .execute_batch(
            "DROP TABLE former_competitor_references;
             DROP TABLE former_price_history;
             DROP TABLE former_approvals;
             DROP TABLE former_catalogue_items;
             DROP TABLE former_source_registry;
             DROP TABLE former_mapping_profiles;
             DROP TABLE former_approved_aliases;
             DROP TABLE former_settings;
             DROP TABLE former_schema_metadata;",
        )
        .map_err(|_| "The former SWL schema could not be retired safely.".to_string())?;
    assert_integrity(transaction)
}

fn validate_preserved_operational_rows(connection: &Connection) -> Result<(), String> {
    let mut catalogue_statement = connection
        .prepare("SELECT c.id,c.item_number,c.description,c.cost_cents,c.sell_price_cents,c.gst_basis,c.sell_price_gst_basis,c.item_kind,c.brand_id,c.product_markup_hundredths,c.upstream_reference,c.servicem8_reference,c.barcode,c.updated_at,s.offer_id FROM catalogue_items c LEFT JOIN product_offer_selections s ON s.product_id=c.id")
        .map_err(|_| "Migrated catalogue rows could not be validated.".to_string())?;
    let catalogue = catalogue_statement
        .query_map([], |row| {
            Ok(CatalogueItem {
                id: row.get(0)?,
                item_number: row.get(1)?,
                description: row.get(2)?,
                cost_cents: row.get(3)?,
                sell_price_cents: row.get(4)?,
                gst_basis: row.get(5)?,
                sell_price_gst_basis: row.get(6)?,
                item_kind: row.get(7)?,
                brand_id: row.get(8)?,
                markup_override_percent: row.get::<_, Option<i64>>(9)?.map(markup_string),
                xero_reference: row.get(10)?,
                servicem8_reference: row.get(11)?,
                barcode: row.get(12)?,
                updated_at: row.get(13)?,
                selected_offer_id: row.get(14)?,
            })
        })
        .map_err(|_| "Migrated catalogue rows could not be validated.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Migrated catalogue rows could not be validated.".to_string())?;
    for item in catalogue {
        validate_catalogue_item(&item)?;
        let cost_basis = gst_exclusive_cost_cents(item.cost_cents, &item.gst_basis)?;
        let sell_basis =
            gst_exclusive_cost_cents(item.sell_price_cents, &item.sell_price_gst_basis)?;
        if sell_basis < minimum_sell_cents(cost_basis)? {
            return Err("A migrated catalogue row is below the markup floor.".to_string());
        }
    }

    for approval in query_approvals(connection, None)? {
        validate_identifier(&approval.id, "Approval identifier")?;
        validate_identifier(&approval.item_id, "Approval item identifier")?;
        validate_identifier(&approval.approved_by, "Approver")?;
        validate_cents(approval.proposed_sell_cents, "Approved sell price")?;
        validate_text(&approval.reason, "Approval reason", 1_000, false)?;
        validate_timestamp(&approval.approved_at)?;
    }
    for history in query_price_history(connection, None)? {
        validate_identifier(&history.id, "Price history identifier")?;
        validate_identifier(&history.item_id, "Price history item identifier")?;
        validate_identifier(&history.approval_id, "Price history approval identifier")?;
        validate_cents(history.cost_cents, "Historical cost")?;
        validate_cents(history.sell_price_cents, "Historical sell price")?;
        let sell_basis =
            gst_exclusive_cost_cents(history.sell_price_cents, &history.sell_price_gst_basis)?;
        if sell_basis < minimum_sell_cents(history.cost_basis_cents)? {
            return Err("A migrated price-history row is below the markup floor.".to_string());
        }
        validate_timestamp(&history.recorded_at)?;
        let linked: (String, i64) = connection
            .query_row(
                "SELECT item_id,proposed_sell_cents FROM approvals WHERE id=?1",
                params![history.approval_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| "A migrated price-history approval link is invalid.".to_string())?;
        if linked != (history.item_id.clone(), history.sell_price_cents) {
            return Err("A migrated price-history approval link is invalid.".to_string());
        }
    }

    let mut references_statement = connection
        .prepare("SELECT observation_json,attached_at FROM competitor_references")
        .map_err(|_| "Migrated competitor references could not be validated.".to_string())?;
    let references = references_statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| "Migrated competitor references could not be validated.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Migrated competitor references could not be validated.".to_string())?;
    for (serialised, attached_at) in references {
        let evidence: CompetitorEvidence = serde_json::from_str(&serialised)
            .map_err(|_| "A migrated competitor reference is invalid.".to_string())?;
        validate_competitor_evidence(&evidence)?;
        validate_timestamp(&attached_at)?;
    }

    let mut sources_statement = connection
        .prepare("SELECT id,state_json,updated_at FROM source_registry")
        .map_err(|_| "Migrated sources could not be validated.".to_string())?;
    let sources = sources_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|_| "Migrated sources could not be validated.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Migrated sources could not be validated.".to_string())?;
    for (stored_id, serialised, updated_at) in sources {
        let source: SourceRecord = serde_json::from_str(&serialised)
            .map_err(|_| "A migrated source is invalid.".to_string())?;
        validate_source(&source)?;
        if source.id != stored_id {
            return Err("A migrated source identifier is inconsistent.".to_string());
        }
        validate_timestamp(&updated_at)?;
    }

    let mut profiles_statement = connection
        .prepare("SELECT id,profile_json,updated_at FROM mapping_profiles")
        .map_err(|_| "Migrated profiles could not be validated.".to_string())?;
    let profiles = profiles_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|_| "Migrated profiles could not be validated.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Migrated profiles could not be validated.".to_string())?;
    for (stored_id, serialised, updated_at) in profiles {
        let profile: MappingProfileRecord = serde_json::from_str(&serialised)
            .map_err(|_| "A migrated profile is invalid.".to_string())?;
        validate_profile(&profile)?;
        if profile.id != stored_id || profile.updated_at != updated_at {
            return Err("A migrated profile identifier or timestamp is inconsistent.".to_string());
        }
    }

    let mut aliases_statement = connection
        .prepare("SELECT supplier_code,item_number,approved_at FROM approved_aliases")
        .map_err(|_| "Migrated aliases could not be validated.".to_string())?;
    let aliases = aliases_statement
        .query_map([], |row| {
            Ok(AliasRecord {
                supplier_code: row.get(0)?,
                item_number: row.get(1)?,
                approved_at: row.get(2)?,
            })
        })
        .map_err(|_| "Migrated aliases could not be validated.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Migrated aliases could not be validated.".to_string())?;
    for alias in aliases {
        validate_alias(&alias)?;
    }

    let mut settings_statement = connection
        .prepare("SELECT settings_json,updated_at FROM settings")
        .map_err(|_| "Migrated settings could not be validated.".to_string())?;
    let settings = settings_statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| "Migrated settings could not be validated.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Migrated settings could not be validated.".to_string())?;
    for (serialised, updated_at) in settings {
        let value: Value = serde_json::from_str(&serialised)
            .map_err(|_| "Migrated settings are invalid.".to_string())?;
        validate_settings(&value)?;
        validate_timestamp(&updated_at)?;
    }
    Ok(())
}

fn validate_current_pricing_rule_audit_snapshots(connection: &Connection) -> Result<(), String> {
    let suppliers = connection
        .prepare(
            "SELECT s.id,s.name,s.active,s.external_reference,s.updated_at,
                    (SELECT snapshot_json FROM supplier_versions v WHERE v.supplier_id=s.id ORDER BY version DESC LIMIT 1)
             FROM suppliers s ORDER BY s.id",
        )
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((
                        SupplierRecord {
                            id: row.get(0)?,
                            name: row.get(1)?,
                            active: row.get(2)?,
                            external_reference: row.get(3)?,
                            updated_at: row.get(4)?,
                        },
                        row.get::<_, Option<String>>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| "Current supplier audit snapshots failed verification.".to_string())?;
    for (current, latest) in suppliers {
        let recorded = latest
            .as_deref()
            .and_then(|value| serde_json::from_str::<SupplierRecord>(value).ok());
        if recorded.as_ref() != Some(&current) {
            return Err("Current supplier audit snapshots failed verification.".to_string());
        }
    }

    let brands = connection
        .prepare(
            "SELECT b.id,b.name,b.markup_hundredths,b.updated_at,
                    (SELECT snapshot_json FROM brand_versions v WHERE v.brand_id=b.id ORDER BY version DESC LIMIT 1)
             FROM brands b ORDER BY b.id",
        )
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((
                        BrandRecord {
                            id: row.get(0)?,
                            name: row.get(1)?,
                            markup_hundredths: row.get(2)?,
                            updated_at: row.get(3)?,
                        },
                        row.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| "Current brand audit snapshots failed verification.".to_string())?;
    for (current, latest) in brands {
        let recorded = latest
            .as_deref()
            .and_then(|value| serde_json::from_str::<BrandRecord>(value).ok());
        if recorded.as_ref() != Some(&current) {
            return Err("Current brand audit snapshots failed verification.".to_string());
        }
    }

    let products = connection
        .prepare(
            "SELECT c.id,c.item_kind,c.brand_id,c.product_markup_hundredths,c.upstream_reference,c.servicem8_reference,c.barcode,c.updated_at,
                    (SELECT snapshot_json FROM product_metadata_versions v WHERE v.product_id=c.id ORDER BY version DESC LIMIT 1)
             FROM catalogue_items c ORDER BY c.id",
        )
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((
                        ProductMetadataVersionSnapshot {
                            product_id: row.get(0)?,
                            item_kind: row.get(1)?,
                            brand_id: row.get(2)?,
                            markup_override_hundredths: row.get(3)?,
                            xero_reference: row.get(4)?,
                            servicem8_reference: row.get(5)?,
                            barcode_gtin: row.get(6)?,
                            updated_at: row.get(7)?,
                        },
                        row.get::<_, Option<String>>(8)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| "Current product metadata audit snapshots failed verification.".to_string())?;
    for (current, latest) in products {
        let recorded = latest
            .as_deref()
            .and_then(|value| serde_json::from_str::<ProductMetadataVersionSnapshot>(value).ok());
        if recorded.as_ref() != Some(&current) {
            return Err(
                "Current product metadata audit snapshots failed verification.".to_string(),
            );
        }
    }
    Ok(())
}

fn validate_current_database(connection: &Connection) -> Result<(), String> {
    assert_integrity(connection)?;
    if schema_version(connection)? != CURRENT_SCHEMA_VERSION {
        return Err("The database schema version is not supported.".to_string());
    }
    let metadata_versions = connection
        .prepare("SELECT version FROM schema_metadata")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| "The database schema metadata failed verification.".to_string())?;
    if metadata_versions != [CURRENT_SCHEMA_VERSION] {
        return Err("The database schema metadata failed verification.".to_string());
    }
    let expected_tables = [
        "approved_aliases",
        "approvals",
        "catalogue_items",
        "competitor_references",
        "configuration_imports",
        "mapping_profiles",
        "price_history",
        "provider_state",
        "schema_metadata",
        "schema_migrations",
        "settings",
        "brands",
        "suppliers",
        "product_supplier_offers",
        "product_offer_selections",
        "supplier_offer_versions",
        "offer_selection_versions",
        "supplier_versions",
        "brand_versions",
        "product_metadata_versions",
        "sync_runs",
        "sync_checkpoints",
        "sync_item_outcomes",
        "settings_audit",
        "source_registry",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<HashSet<_>>();
    let tables = connection
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<HashSet<_>, _>>()
        })
        .map_err(|_| "The database schema objects could not be verified.".to_string())?;
    if tables != expected_tables {
        return Err("The database schema objects failed verification.".to_string());
    }
    let expected_triggers = [
        "approvals_no_delete",
        "approvals_no_update",
        "price_history_no_delete",
        "price_history_no_update",
        "settings_audit_no_delete",
        "settings_audit_no_update",
        "sync_item_outcomes_no_delete",
        "sync_item_outcomes_no_update",
        "supplier_offer_versions_no_delete",
        "supplier_offer_versions_no_update",
        "offer_selection_versions_no_delete",
        "offer_selection_versions_no_update",
        "brands_canonical_key_required_insert",
        "brands_canonical_key_required_update",
        "offers_normalized_sku_required_insert",
        "offers_normalized_sku_required_update",
        "supplier_versions_no_delete",
        "supplier_versions_no_update",
        "brand_versions_no_delete",
        "brand_versions_no_update",
        "product_metadata_versions_no_delete",
        "product_metadata_versions_no_update",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<HashSet<_>>();
    let triggers = connection
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<HashSet<_>, _>>()
        })
        .map_err(|_| "The database append-only guards could not be verified.".to_string())?;
    if triggers != expected_triggers {
        return Err("The database append-only guards failed verification.".to_string());
    }
    let registry = connection
        .prepare("SELECT version,name,sha256 FROM schema_migrations ORDER BY version")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| "The database migration registry could not be verified.".to_string())?;
    if registry.len() != MIGRATIONS.len()
        || registry.iter().zip(MIGRATIONS).any(
            |((stored_version, stored_name, stored_sha), (version, name, sql))| {
                stored_version != version
                    || stored_name != name
                    || stored_sha != &sha256_bytes(sql.as_bytes())
            },
        )
    {
        return Err("The database migration registry failed verification.".to_string());
    }
    validate_preserved_operational_rows(connection)?;
    let brands = connection
        .prepare("SELECT name,canonical_key FROM brands")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| "Canonical brand identities failed verification.".to_string())?;
    for (name, stored_key) in brands {
        let (normalised_name, canonical_key) = normalise_identity(&name, "Brand name", 256)?;
        if name != normalised_name || stored_key != canonical_key {
            return Err("Canonical brand identities failed verification.".to_string());
        }
    }
    let offer_skus = connection
        .prepare("SELECT supplier_sku,normalized_supplier_sku FROM product_supplier_offers")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| "Normalised supplier SKU identities failed verification.".to_string())?;
    for (sku, stored_key) in offer_skus {
        let (normalised_sku, normalized_key) = normalise_identity(&sku, "Supplier SKU", 256)?;
        if sku != normalised_sku || stored_key != normalized_key {
            return Err("Normalised supplier SKU identities failed verification.".to_string());
        }
    }
    for (sql, label, require_strictly_increasing_time) in [
        (
            "SELECT offer_id,version,snapshot_json,changed_at FROM supplier_offer_versions ORDER BY offer_id,version",
            "Supplier offer audit",
            false,
        ),
        (
            "SELECT product_id,version,snapshot_json,changed_at FROM offer_selection_versions ORDER BY product_id,version",
            "Offer selection audit",
            false,
        ),
        (
            "SELECT supplier_id,version,snapshot_json,changed_at FROM supplier_versions ORDER BY supplier_id,version",
            "Supplier audit",
            true,
        ),
        (
            "SELECT brand_id,version,snapshot_json,changed_at FROM brand_versions ORDER BY brand_id,version",
            "Brand audit",
            true,
        ),
        (
            "SELECT product_id,version,snapshot_json,changed_at FROM product_metadata_versions ORDER BY product_id,version",
            "Product metadata audit",
            true,
        ),
    ] {
        let versions = connection
            .prepare(sql)
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(|_| format!("{label} versions failed verification."))?;
        let mut last_versions = HashMap::new();
        let mut last_changed_at = HashMap::new();
        for (id, version, snapshot, changed_at) in versions {
            let expected = last_versions.get(&id).copied().unwrap_or(0) + 1;
            let value = serde_json::from_str::<Value>(&snapshot)
                .ok()
                .filter(Value::is_object);
            let changed_at_key = timestamp_order_key(&changed_at)
                .map_err(|_| format!("{label} versions failed verification."))?;
            if version != expected
                || snapshot.len() > MAX_JSON_BYTES
                || value.is_none()
                || (require_strictly_increasing_time
                    && last_changed_at
                        .get(&id)
                        .is_some_and(|previous| changed_at_key <= *previous))
            {
                return Err(format!("{label} versions failed verification."));
            }
            let value = value.expect("checked audit JSON object");
            let typed_valid = match label {
                "Supplier audit" => serde_json::from_value::<SupplierRecord>(value)
                    .ok()
                    .filter(|record| {
                        record.id == id
                            && record.updated_at == changed_at
                            && validate_supplier(record).is_ok()
                    })
                    .is_some(),
                "Brand audit" => serde_json::from_value::<BrandRecord>(value)
                    .ok()
                    .filter(|record| {
                        record.id == id
                            && record.updated_at == changed_at
                            && validate_brand(record).is_ok()
                    })
                    .is_some(),
                "Product metadata audit" => {
                    serde_json::from_value::<ProductMetadataVersionSnapshot>(value)
                        .ok()
                        .filter(|record| {
                            record.product_id == id
                                && record.updated_at == changed_at
                                && validate_product_metadata_snapshot(record).is_ok()
                        })
                        .is_some()
                }
                _ => true,
            };
            if !typed_valid {
                return Err(format!("{label} versions failed verification."));
            }
            last_versions.insert(id.clone(), version);
            if require_strictly_increasing_time {
                last_changed_at.insert(id, changed_at_key);
            }
        }
    }
    validate_current_pricing_rule_audit_snapshots(connection)?;

    let provider: (i64, Option<String>, i64, i64, i64) = connection
        .query_row(
            "SELECT paid_calls_enabled,last_validated_at,cost_ceiling_cents,cost_per_call_cents,spent_cents
             FROM provider_state WHERE provider=?1",
            params![PROVIDER_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .map_err(|_| "Provider policy state failed verification.".to_string())?;
    let provider_rows: i64 = connection
        .query_row("SELECT COUNT(*) FROM provider_state", [], |row| row.get(0))
        .map_err(|_| "Provider policy state failed verification.".to_string())?;
    if provider_rows != 1
        || !matches!(provider.0, 0 | 1)
        || provider
            .1
            .as_deref()
            .is_some_and(|value| validate_timestamp(value).is_err())
        || validate_cents(provider.2, "Provider cost ceiling").is_err()
        || validate_cents(provider.3, "Provider call cost").is_err()
        || validate_cents(provider.4, "Provider reserved cost").is_err()
        || provider.4 > provider.2
        || (provider.0 == 1
            && (provider.1.is_none()
                || provider.2 == 0
                || provider.3 == 0
                || provider.3 > provider.2))
    {
        return Err("Provider policy state failed verification.".to_string());
    }
    let mut imports = connection
        .prepare(
            "SELECT source_id,content_sha256,imported_at,profile_count,alias_count,settings_count
             FROM configuration_imports",
        )
        .map_err(|_| "Configuration import records failed verification.".to_string())?;
    let mut rows = imports
        .query([])
        .map_err(|_| "Configuration import records failed verification.".to_string())?;
    while let Some(row) = rows
        .next()
        .map_err(|_| "Configuration import records failed verification.".to_string())?
    {
        let source_id: String = row
            .get(0)
            .map_err(|_| "Configuration import records failed verification.".to_string())?;
        let checksum: String = row
            .get(1)
            .map_err(|_| "Configuration import records failed verification.".to_string())?;
        let imported_at: String = row
            .get(2)
            .map_err(|_| "Configuration import records failed verification.".to_string())?;
        let counts = (
            row.get::<_, i64>(3).unwrap_or(-1),
            row.get::<_, i64>(4).unwrap_or(-1),
            row.get::<_, i64>(5).unwrap_or(-1),
        );
        if validate_identifier(&source_id, "Configuration source").is_err()
            || checksum.len() != 64
            || !checksum.bytes().all(|value| value.is_ascii_hexdigit())
            || validate_timestamp(&imported_at).is_err()
            || counts.0 < 0
            || counts.1 < 0
            || !matches!(counts.2, 0 | 1)
        {
            return Err("Configuration import records failed verification.".to_string());
        }
    }
    Ok(())
}

fn apply_migrations(database_path: &Path, data_dir: &Path) -> Result<(), String> {
    apply_migrations_with(database_path, data_dir, MIGRATIONS)
}

fn prepare_schema5_canonical_keys(transaction: &Transaction<'_>) -> Result<(), String> {
    let brands = transaction
        .prepare("SELECT id,name,markup_hundredths FROM brands ORDER BY id")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| "Brand identities could not be prepared for migration.".to_string())?;
    let mut groups: BTreeMap<String, Vec<(String, String, Option<i64>)>> = BTreeMap::new();
    for (id, name, markup) in brands {
        let (display, key) = normalise_identity(&name, "Brand name", 256)?;
        groups.entry(key).or_default().push((id, display, markup));
    }
    for (key, mut group) in groups {
        group.sort_by(|left, right| left.0.cmp(&right.0));
        let distinct_markups = group
            .iter()
            .filter_map(|(_, _, markup)| *markup)
            .collect::<HashSet<_>>();
        if distinct_markups.len() > 1 {
            return Err("Canonical brand collisions contain conflicting markup facts.".into());
        }
        let (keeper_id, keeper_name, keeper_markup) = group[0].clone();
        let resolved_markup = distinct_markups.into_iter().next().or(keeper_markup);
        for (duplicate_id, _, _) in group.iter().skip(1) {
            transaction
                .execute(
                    "UPDATE catalogue_items SET brand_id=?1 WHERE brand_id=?2",
                    params![keeper_id, duplicate_id],
                )
                .map_err(|_| "Canonical brand references could not be merged.".to_string())?;
            transaction
                .execute("DELETE FROM brands WHERE id=?1", params![duplicate_id])
                .map_err(|_| "Canonical duplicate brands could not be merged.".to_string())?;
        }
        transaction
            .execute(
                "UPDATE brands SET name=?1,markup_hundredths=?2,canonical_key=?3 WHERE id=?4",
                params![keeper_name, resolved_markup, key, keeper_id],
            )
            .map_err(|_| "Canonical brand identity could not be stored.".to_string())?;
    }

    let offers = transaction
        .prepare("SELECT id,product_id,supplier_id,supplier_sku FROM product_supplier_offers ORDER BY id")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| "Supplier SKU identities could not be prepared for migration.".to_string())?;
    let mut identities = HashSet::new();
    for (id, product_id, supplier_id, supplier_sku) in offers {
        let (_, normalized) = normalise_identity(&supplier_sku, "Supplier SKU", 256)?;
        if !identities.insert((product_id, supplier_id, normalized.clone())) {
            return Err("Normalised supplier SKU migration found conflicting offers.".into());
        }
        transaction
            .execute(
                "UPDATE product_supplier_offers SET normalized_supplier_sku=?1 WHERE id=?2",
                params![normalized, id],
            )
            .map_err(|_| "Normalised supplier SKU could not be stored.".to_string())?;
    }
    transaction
        .execute_batch(
            "CREATE UNIQUE INDEX brand_canonical_key_unique ON brands(canonical_key);
             CREATE UNIQUE INDEX offer_product_supplier_sku_unique ON product_supplier_offers(product_id,supplier_id,normalized_supplier_sku);
             CREATE TRIGGER brands_canonical_key_required_insert BEFORE INSERT ON brands WHEN NEW.canonical_key IS NULL OR NEW.canonical_key='' BEGIN SELECT RAISE(ABORT,'canonical brand key required'); END;
             CREATE TRIGGER brands_canonical_key_required_update BEFORE UPDATE OF canonical_key ON brands WHEN NEW.canonical_key IS NULL OR NEW.canonical_key='' BEGIN SELECT RAISE(ABORT,'canonical brand key required'); END;
             CREATE TRIGGER offers_normalized_sku_required_insert BEFORE INSERT ON product_supplier_offers WHEN NEW.normalized_supplier_sku IS NULL OR NEW.normalized_supplier_sku='' BEGIN SELECT RAISE(ABORT,'normalized supplier SKU required'); END;
             CREATE TRIGGER offers_normalized_sku_required_update BEFORE UPDATE OF normalized_supplier_sku ON product_supplier_offers WHEN NEW.normalized_supplier_sku IS NULL OR NEW.normalized_supplier_sku='' BEGIN SELECT RAISE(ABORT,'normalized supplier SKU required'); END;",
        )
        .map_err(|_| "Canonical identity constraints could not be created.".to_string())?;
    Ok(())
}

fn apply_migrations_with(
    database_path: &Path,
    data_dir: &Path,
    migrations: &[(i64, &str, &str)],
) -> Result<(), String> {
    fs::create_dir_all(data_dir)
        .map_err(|_| "The application data folder could not be created.".to_string())?;
    let existing = database_path.exists()
        && fs::metadata(database_path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false);
    let connection = if existing {
        Some(open_readonly_connection(database_path)?)
    } else {
        None
    };
    let (applied, rebuild_partial_shell, unsupported_unversioned) = if let Some(connection) =
        connection.as_ref()
    {
        assert_integrity(connection)?;
        if !table_exists(connection, "schema_migrations")? {
            match classify_unversioned_database(connection)? {
                None => (Vec::new(), false, false),
                Some(true) => (Vec::new(), true, false),
                Some(false) => (Vec::new(), false, true),
            }
        } else {
            let mut statement = connection
                .prepare("SELECT version,name,sha256 FROM schema_migrations ORDER BY version")
                .map_err(|_| "The database migration registry could not be read.".to_string())?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|_| "The database migration registry could not be read.".to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "The database migration registry could not be read.".to_string())?;
            (rows, false, false)
        }
    } else {
        (Vec::new(), false, false)
    };
    if unsupported_unversioned {
        drop(connection);
        create_verified_backup_at(database_path, data_dir, "migration")?;
        return Err(
            "The unversioned database schema is not a recognised SWL desktop store; no migration was applied."
                .to_string(),
        );
    }
    for (index, (version, stored_name, stored_sha256)) in applied.iter().enumerate() {
        let Some((_, expected_name, expected_sql)) = migrations
            .iter()
            .find(|(candidate, _, _)| candidate == version)
        else {
            return Err(
                "The database was created by an unsupported application version.".to_string(),
            );
        };
        if *version != index as i64 + 1 {
            return Err("The database migration registry failed verification.".to_string());
        }
        if stored_name != expected_name || stored_sha256 != &sha256_bytes(expected_sql.as_bytes()) {
            return Err("The database migration registry failed verification.".to_string());
        }
    }
    let applied_versions = applied
        .iter()
        .map(|(version, _, _)| *version)
        .collect::<HashSet<_>>();
    let pending = migrations
        .iter()
        .filter(|(version, _, _)| !applied_versions.contains(version))
        .copied()
        .collect::<Vec<_>>();
    if pending.is_empty() {
        let connection = connection
            .ok_or_else(|| "The database migration registry failed verification.".to_string())?;
        if schema_version(&connection)? != CURRENT_SCHEMA_VERSION {
            return Err("The database schema version is not supported.".to_string());
        }
        validate_current_database(&connection)?;
        return Ok(());
    }
    drop(connection);

    let rollback = if existing {
        Some(create_verified_backup_at(
            database_path,
            data_dir,
            "migration",
        )?)
    } else {
        None
    };

    let migration_result = (|| -> Result<(), String> {
        let mut connection = if existing {
            open_connection(database_path)?
        } else {
            open_connection_create(database_path)?
        };
        let mut rebuild_partial_shell = rebuild_partial_shell;
        for (version, name, sql) in pending {
            let transaction = connection
                .transaction()
                .map_err(|_| "The database migration could not start.".to_string())?;
            if rebuild_partial_shell && version == 1 {
                rebuild_partial_shell_schema(&transaction, sql)?;
                rebuild_partial_shell = false;
            } else {
                transaction
                    .execute_batch(sql)
                    .map_err(|_| "The database migration failed.".to_string())?;
            }
            if version == 5 {
                prepare_schema5_canonical_keys(&transaction)?;
            }
            transaction
                .execute(
                    "INSERT INTO schema_migrations(version,name,sha256,applied_at) VALUES(?1,?2,?3,datetime('now'))",
                    params![version, name, sha256_bytes(sql.as_bytes())],
                )
                .map_err(|_| "The database migration could not be recorded.".to_string())?;
            transaction
                .commit()
                .map_err(|_| "The database migration could not be committed.".to_string())?;
        }
        if schema_version(&connection)? != CURRENT_SCHEMA_VERSION {
            return Err("The database schema version is not supported.".to_string());
        }
        validate_current_database(&connection)
    })();

    if migration_result.is_err() {
        if let Some(summary) = rollback {
            restore_backup_files(database_path, data_dir, &summary.id)?;
        } else {
            let _ = fs::remove_file(database_path);
        }
        return Err("The database migration failed; the prior database was restored.".to_string());
    }
    Ok(())
}

fn validate_restore_work_filename(filename: &str, prefix: &str) -> Result<(), String> {
    let uuid = filename
        .strip_prefix(prefix)
        .and_then(|value| value.strip_suffix(".sqlite3"))
        .ok_or_else(|| "The restore recovery metadata is invalid.".to_string())?;
    let parsed = Uuid::parse_str(uuid)
        .map_err(|_| "The restore recovery metadata is invalid.".to_string())?;
    if parsed.hyphenated().to_string() != uuid {
        return Err("The restore recovery metadata is invalid.".to_string());
    }
    Ok(())
}

fn restore_work_path(data_dir: &Path, filename: &str, prefix: &str) -> Result<PathBuf, String> {
    validate_restore_work_filename(filename, prefix)?;
    let path = data_dir.join(filename);
    if path.parent() != Some(data_dir) {
        return Err("The restore recovery path escaped application data.".to_string());
    }
    Ok(path)
}

fn database_matches_state(
    path: &Path,
    expected_version: i64,
    expected_counts: &BackupRecordCounts,
) -> bool {
    let Ok(connection) = open_readonly_connection(path) else {
        return false;
    };
    let structurally_valid = if expected_version == CURRENT_SCHEMA_VERSION {
        validate_current_database(&connection).is_ok()
    } else {
        assert_integrity(&connection).is_ok()
    };
    let actual_version = schema_version_or_zero(&connection);
    let actual_counts = record_counts_for_version(&connection, expected_version);
    structurally_valid
        && actual_version.is_ok_and(|value| value == expected_version)
        && actual_counts.is_ok_and(|value| value == *expected_counts)
}

#[cfg(windows)]
fn atomic_replace_database(replacement: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    extern "system" {
        #[link_name = "ReplaceFileW"]
        fn replace_file_w(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
        #[link_name = "MoveFileExW"]
        fn move_file_ex_w(existing: *const u16, destination: *const u16, flags: u32) -> i32;
    }

    // ReplaceFileW has no supported write-through flag. Flag 0 avoids the
    // unrelated IGNORE_MERGE_ERRORS value (0x2); the replacement file itself
    // is explicitly flushed before the atomic replacement.
    const REPLACEFILE_FLAGS: u32 = 0;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(replacement)
        .and_then(|file| file.sync_all())
        .map_err(|_| "The restored database could not be flushed before activation.".to_string())?;
    let replacement_wide = replacement
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: the buffers are null-terminated and remain alive for each
    // synchronous call. No backup name or replace-on-move flag is supplied.
    let result = unsafe {
        if destination.exists() {
            replace_file_w(
                destination_wide.as_ptr(),
                replacement_wide.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_FLAGS,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } else {
            move_file_ex_w(
                replacement_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if result == 0 {
        return Err("The restored database could not be activated atomically.".to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace_database(replacement: &Path, destination: &Path) -> Result<(), String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(replacement)
        .and_then(|file| file.sync_all())
        .map_err(|_| "The restored database could not be flushed before activation.".to_string())?;
    fs::rename(replacement, destination)
        .map_err(|_| "The restored database could not be activated atomically.".to_string())
}

#[cfg(not(windows))]
fn sync_directory(path: &Path) {
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
    }
}

#[cfg(windows)]
fn sync_directory(_path: &Path) {}

fn read_restore_journal(data_dir: &Path) -> Result<Option<RestoreJournal>, String> {
    let path = data_dir.join(RESTORE_JOURNAL_FILENAME);
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| "The restore recovery journal could not be verified.".to_string())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || is_reparse_point(&metadata)
        || metadata.len() == 0
        || metadata.len() > 64 * 1024
    {
        return Err("The restore recovery journal is invalid.".to_string());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(&path)
        .and_then(|file| file.take(64 * 1024 + 1).read_to_end(&mut bytes))
        .map_err(|_| "The restore recovery journal could not be read.".to_string())?;
    if bytes.len() as u64 != metadata.len() || bytes.len() > 64 * 1024 {
        return Err("The restore recovery journal changed while it was read.".to_string());
    }
    let journal: RestoreJournal = serde_json::from_slice(&bytes)
        .map_err(|_| "The restore recovery journal is invalid.".to_string())?;
    if journal.version != 1
        || journal.rollback_sha256.len() != 64
        || !journal
            .rollback_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("The restore recovery journal is invalid.".to_string());
    }
    validate_backup_id(&journal.backup_id)?;
    validate_timestamp(&journal.created_at)?;
    validate_restore_work_filename(&journal.temporary_filename, ".swl-restore-")?;
    validate_restore_work_filename(&journal.rollback_filename, ".swl-rollback-")?;
    Ok(Some(journal))
}

fn recover_interrupted_restore(database_path: &Path, data_dir: &Path) -> Result<(), String> {
    let Some(journal) = read_restore_journal(data_dir)? else {
        return Ok(());
    };
    let temporary = restore_work_path(data_dir, &journal.temporary_filename, ".swl-restore-")?;
    let rollback = restore_work_path(data_dir, &journal.rollback_filename, ".swl-rollback-")?;
    if !database_matches_state(
        database_path,
        journal.target_schema_version,
        &journal.target_record_counts,
    ) {
        if !database_matches_state(
            &rollback,
            journal.rollback_schema_version,
            &journal.rollback_record_counts,
        ) || sha256_file(&rollback)? != journal.rollback_sha256
        {
            return Err("The interrupted restore rollback failed verification.".to_string());
        }
        remove_sqlite_sidecars(database_path);
        atomic_replace_database(&rollback, database_path)?;
        if !database_matches_state(
            database_path,
            journal.rollback_schema_version,
            &journal.rollback_record_counts,
        ) {
            return Err(
                "The interrupted restore could not recover the prior database.".to_string(),
            );
        }
    }
    let _ = fs::remove_file(&temporary);
    let _ = fs::remove_file(&rollback);
    fs::remove_file(data_dir.join(RESTORE_JOURNAL_FILENAME))
        .map_err(|_| "The restore recovery journal could not be retired.".to_string())?;
    sync_directory(data_dir);
    Ok(())
}

fn restore_backup_files(database_path: &Path, data_dir: &Path, id: &str) -> Result<(), String> {
    recover_interrupted_restore(database_path, data_dir)?;
    let manifest = verify_backup(data_dir, id)?;
    let (source_path, _) = backup_paths(data_dir, id)?;
    let temporary_filename = format!(".swl-restore-{}.sqlite3", Uuid::new_v4());
    let rollback_filename = format!(".swl-rollback-{}.sqlite3", Uuid::new_v4());
    let temporary = restore_work_path(data_dir, &temporary_filename, ".swl-restore-")?;
    let rollback = restore_work_path(data_dir, &rollback_filename, ".swl-rollback-")?;
    let result = (|| -> Result<(), String> {
        sqlite_backup(&source_path, &temporary)?;
        // The verified source remains bound to the manifest SHA-256. SQLite's
        // backup API may produce a byte-different but logically identical
        // database image, so the staged copy is accepted only by complete
        // schema/count/integrity verification rather than physical equality.
        if !database_matches_state(
            &temporary,
            manifest.summary.schema_version,
            &manifest.summary.record_counts,
        ) {
            return Err("The restored database did not match its verified manifest.".to_string());
        }
        let live = open_connection(database_path)?;
        live.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|_| "The live database could not be checkpointed for restore.".to_string())?;
        let rollback_schema_version = schema_version_or_zero(&live)?;
        let rollback_record_counts = record_counts_for_version(&live, rollback_schema_version)?;
        assert_integrity(&live)?;
        drop(live);
        remove_sqlite_sidecars(database_path);
        sqlite_backup(database_path, &rollback)?;
        let rollback_sha256 = sha256_file(&rollback)?;
        let journal = RestoreJournal {
            version: 1,
            backup_id: id.to_string(),
            temporary_filename: temporary_filename.clone(),
            rollback_filename: rollback_filename.clone(),
            target_schema_version: manifest.summary.schema_version,
            target_record_counts: manifest.summary.record_counts.clone(),
            rollback_schema_version,
            rollback_record_counts,
            rollback_sha256,
            created_at: now_text(),
        };
        let journal_path = data_dir.join(RESTORE_JOURNAL_FILENAME);
        if journal_path.exists() {
            return Err("An earlier restore recovery journal is still active.".to_string());
        }
        write_json_atomically(&journal_path, &journal)?;
        sync_directory(data_dir);
        remove_sqlite_sidecars(&temporary);
        atomic_replace_database(&temporary, database_path)?;
        sync_directory(data_dir);
        if !database_matches_state(
            database_path,
            manifest.summary.schema_version,
            &manifest.summary.record_counts,
        ) {
            recover_interrupted_restore(database_path, data_dir)?;
            return Err("The restored database failed final verification.".to_string());
        }
        let _ = fs::remove_file(&rollback);
        let _ = fs::remove_file(&temporary);
        let _ = fs::remove_file(&journal_path);
        sync_directory(data_dir);
        Ok(())
    })();
    if result.is_err() {
        if data_dir.join(RESTORE_JOURNAL_FILENAME).exists() {
            let _ = recover_interrupted_restore(database_path, data_dir);
        } else {
            let _ = fs::remove_file(&temporary);
            let _ = fs::remove_file(&rollback);
        }
    }
    result
}

fn restore_with_postcheck<F>(
    database_path: &Path,
    data_dir: &Path,
    backup_id: &str,
    postcheck: F,
) -> Result<(), String>
where
    F: FnOnce(&Path, &Path) -> Result<(), String>,
{
    let pre_restore = create_verified_backup_at(database_path, data_dir, "restore")?;
    restore_backup_files(database_path, data_dir, backup_id)?;
    if postcheck(database_path, data_dir).is_err() {
        restore_backup_files(database_path, data_dir, &pre_restore.id).map_err(|_| {
            "Restore migration failed and the prior database could not be recovered.".to_string()
        })?;
        return Err(
            "Restore migration failed; the database from before restore was recovered.".to_string(),
        );
    }
    Ok(())
}

fn remove_sqlite_sidecars(database_path: &Path) {
    let value = database_path.to_string_lossy();
    let _ = fs::remove_file(format!("{value}-wal"));
    let _ = fs::remove_file(format!("{value}-shm"));
}

#[tauri::command]
fn desktop_health(state: State<'_, AppState>) -> Result<DesktopHealth, String> {
    let connection = open_connection(&state.database_path)?;
    let status = provider_status_inner(&state, &connection)?;
    Ok(DesktopHealth {
        ok: true,
        provider: status.provider,
        live_search_configured: status.credential_configured,
        fixture_mode: false,
        schema_version: schema_version(&connection)?,
    })
}

#[tauri::command]
fn list_catalogue_items(state: State<'_, AppState>) -> Result<Vec<CatalogueItem>, String> {
    let connection = open_connection(&state.database_path)?;
    let mut statement = connection
        .prepare("SELECT c.id,c.item_number,c.description,c.cost_cents,c.sell_price_cents,c.gst_basis,c.sell_price_gst_basis,c.item_kind,c.brand_id,c.product_markup_hundredths,c.upstream_reference,c.servicem8_reference,c.barcode,c.updated_at,s.offer_id FROM catalogue_items c LEFT JOIN product_offer_selections s ON s.product_id=c.id ORDER BY c.item_number,c.id")
        .map_err(|_| "The catalogue could not be read.".to_string())?;
    let items = statement
        .query_map([], |row| {
            Ok(CatalogueItem {
                id: row.get(0)?,
                item_number: row.get(1)?,
                description: row.get(2)?,
                cost_cents: row.get(3)?,
                sell_price_cents: row.get(4)?,
                gst_basis: row.get(5)?,
                sell_price_gst_basis: row.get(6)?,
                item_kind: row.get(7)?,
                brand_id: row.get(8)?,
                markup_override_percent: row.get::<_, Option<i64>>(9)?.map(markup_string),
                xero_reference: row.get(10)?,
                servicem8_reference: row.get(11)?,
                barcode: row.get(12)?,
                updated_at: row.get(13)?,
                selected_offer_id: row.get(14)?,
            })
        })
        .map_err(|_| "The catalogue could not be read.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "The catalogue could not be read.".to_string())?;
    Ok(items)
}

#[cfg(test)]
fn update_catalogue_metadata(
    connection: &mut Connection,
    items: &[CatalogueItem],
) -> Result<(), String> {
    if items.is_empty() || items.len() > MAX_BATCH_RECORDS {
        return Err("The catalogue batch size is outside the supported range.".to_string());
    }
    let mut identifiers = HashSet::new();
    let mut item_numbers = HashSet::new();
    for item in items {
        validate_catalogue_item(item)?;
        if !identifiers.insert(&item.id) || !item_numbers.insert(&item.item_number) {
            return Err("The catalogue batch contains duplicate identifiers.".to_string());
        }
    }
    let transaction = connection
        .transaction()
        .map_err(|_| "The catalogue update could not start.".to_string())?;
    for item in items {
        let existing = transaction
            .query_row(
                "SELECT cost_cents,sell_price_cents,gst_basis FROM catalogue_items WHERE id=?1",
                params![item.id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| "The existing catalogue item could not be verified.".to_string())?
            .ok_or_else(|| {
                "New catalogue items require an approved publication transaction.".to_string()
            })?;
        if existing
            != (
                item.cost_cents,
                item.sell_price_cents,
                item.gst_basis.clone(),
            )
        {
            return Err(
                "Cost, sell price and GST-basis changes require an approved publication transaction."
                    .to_string(),
            );
        }
        transaction
            .execute(
                "UPDATE catalogue_items SET item_number=?1,description=?2,gst_basis=?3,updated_at=?4 WHERE id=?5",
                params![
                    item.item_number,
                    item.description,
                    item.gst_basis,
                    item.updated_at,
                    item.id
                ],
            )
            .map_err(|_| "The catalogue update was rejected.".to_string())?;
        let snapshot = query_product_metadata_snapshot(&transaction, &item.id)?;
        append_product_metadata_version(&transaction, &snapshot)?;
    }
    assert_integrity(&transaction)?;
    transaction
        .commit()
        .map_err(|_| "The catalogue update could not be committed.".to_string())?;
    Ok(())
}

fn publish_approved_changes_inner(
    connection: &mut Connection,
    changes: &[PublishApprovedChange],
) -> Result<Vec<PublishedChange>, String> {
    if changes.is_empty() || changes.len() > MAX_BATCH_RECORDS {
        return Err("The approved publication batch size is outside the supported range.".into());
    }
    let mut item_ids = HashSet::new();
    let mut item_numbers = HashSet::new();
    for change in changes {
        validate_catalogue_item(&change.item)?;
        validate_identifier(&change.approved_by, "Approver")?;
        validate_text(&change.reason, "Approval reason", 1_000, false)?;
        let provenance = change.pricing_provenance.as_ref().ok_or_else(|| {
            "Verified pricing provenance is required for every publication.".to_string()
        })?;
        if provenance.selected_offer_id.is_none()
            || provenance.supplier_id.is_none()
            || provenance.supplier_name.is_none()
            || provenance.supplier_sku.is_none()
        {
            return Err(
                "A complete selected supplier-offer provenance snapshot is required.".to_string(),
            );
        }
        if !item_ids.insert(&change.item.id) || !item_numbers.insert(&change.item.item_number) {
            return Err("The approved publication batch contains duplicate items.".into());
        }
    }
    let transaction = connection
        .transaction()
        .map_err(|_| "The approved publication could not start.".to_string())?;
    let mut published = Vec::with_capacity(changes.len());
    for change in changes {
        let current_updated_at = transaction
            .query_row(
                "SELECT updated_at FROM catalogue_items WHERE id=?1",
                params![change.item.id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| "The current catalogue version could not be read.".to_string())?;
        if let Some(current_updated_at) = current_updated_at {
            if timestamp_order_key(&change.item.updated_at)?
                <= timestamp_order_key(&current_updated_at)?
            {
                return Err(
                    "The approved catalogue publication is stale; reload the latest product."
                        .to_string(),
                );
            }
        }
        let approved_at = now_text();
        let product_markup_hundredths = change
            .item
            .markup_override_percent
            .as_deref()
            .map(parse_markup_override_hundredths)
            .transpose()?
            .map(i64::from);
        let approval = ApprovalRecord {
            id: Uuid::new_v4().to_string(),
            item_id: change.item.id.clone(),
            approved_by: change.approved_by.clone(),
            proposed_sell_cents: change.item.sell_price_cents,
            reason: change.reason.clone(),
            approved_at: approved_at.clone(),
        };
        transaction.execute(
            "INSERT INTO catalogue_items(id,item_number,description,cost_cents,sell_price_cents,gst_basis,sell_price_gst_basis,item_kind,brand_id,product_markup_hundredths,upstream_reference,servicem8_reference,barcode,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
             ON CONFLICT(id) DO UPDATE SET item_number=excluded.item_number,description=excluded.description,cost_cents=excluded.cost_cents,
               sell_price_cents=excluded.sell_price_cents,gst_basis=excluded.gst_basis,sell_price_gst_basis=excluded.sell_price_gst_basis,
               item_kind=excluded.item_kind,brand_id=excluded.brand_id,product_markup_hundredths=excluded.product_markup_hundredths,
               upstream_reference=excluded.upstream_reference,servicem8_reference=excluded.servicem8_reference,barcode=excluded.barcode,updated_at=excluded.updated_at",
            params![change.item.id,change.item.item_number,change.item.description,change.item.cost_cents,change.item.sell_price_cents,
                change.item.gst_basis,change.item.sell_price_gst_basis,change.item.item_kind,change.item.brand_id,product_markup_hundredths,
                change.item.xero_reference,change.item.servicem8_reference,change.item.barcode,change.item.updated_at],
        ).map_err(|_|"The approved catalogue publication was rejected.".to_string())?;
        let product_snapshot = query_product_metadata_snapshot(&transaction, &change.item.id)?;
        append_product_metadata_version(&transaction, &product_snapshot)?;
        if let Some(provenance) = change.pricing_provenance.as_ref() {
            if let (Some(offer_id), Some(supplier_id), Some(supplier_name), Some(supplier_sku)) = (
                provenance.selected_offer_id.as_deref(),
                provenance.supplier_id.as_deref(),
                provenance.supplier_name.as_deref(),
                provenance.supplier_sku.as_deref(),
            ) {
                validate_identifier(offer_id, "Offer identifier")?;
                validate_identifier(supplier_id, "Supplier identifier")?;
                validate_text(supplier_name, "Supplier name", 256, false)?;
                let (normalised_supplier_sku, normalized_supplier_sku) =
                    normalise_identity(supplier_sku, "Supplier SKU", 256)?;
                if provenance.currency != "AUD"
                    || !matches!(
                        provenance.cost_gst_basis.as_str(),
                        "inc-gst" | "ex-gst" | "unknown"
                    )
                {
                    return Err("Initial supplier-offer provenance is invalid.".to_string());
                }
                let supplier_inserted = transaction.execute("INSERT OR IGNORE INTO suppliers(id,name,active,updated_at) VALUES(?1,?2,1,?3)",params![supplier_id,supplier_name,change.item.updated_at])
                    .map_err(|_|"The initial supplier could not be saved.".to_string())?;
                if supplier_inserted == 1 {
                    append_supplier_version(
                        &transaction,
                        &SupplierRecord {
                            id: supplier_id.to_string(),
                            name: supplier_name.to_string(),
                            active: true,
                            external_reference: None,
                            updated_at: change.item.updated_at.clone(),
                        },
                    )?;
                }
                let stored_name: String = transaction
                    .query_row(
                        "SELECT name FROM suppliers WHERE id=?1",
                        params![supplier_id],
                        |row| row.get(0),
                    )
                    .map_err(|_| "The initial supplier could not be verified.".to_string())?;
                if stored_name != supplier_name {
                    return Err(
                        "Supplier provenance does not match the stored supplier.".to_string()
                    );
                }
                let offer_inserted = transaction.execute("INSERT OR IGNORE INTO product_supplier_offers(id,product_id,supplier_id,supplier_sku,normalized_supplier_sku,cost_cents,gst_basis,currency,active,is_preferred,provenance_type,observed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'AUD',1,1,'supplier-file',?8)",params![offer_id,change.item.id,supplier_id,normalised_supplier_sku,normalized_supplier_sku,change.item.cost_cents,provenance.cost_gst_basis,change.item.updated_at])
                    .map_err(|_|"The initial supplier offer could not be saved.".to_string())?;
                let selection_inserted = transaction.execute("INSERT OR IGNORE INTO product_offer_selections(product_id,offer_id,selected_by,reason,selected_at) VALUES(?1,?2,?3,?4,?5)",params![change.item.id,offer_id,change.approved_by,"Initial approved supplier offer",change.item.updated_at])
                    .map_err(|_|"The initial supplier offer could not be selected.".to_string())?;
                if offer_inserted == 1 {
                    let stored_offer = query_supplier_offer(&transaction, offer_id)?;
                    append_supplier_offer_version(
                        &transaction,
                        &stored_offer,
                        &change.item.updated_at,
                    )?;
                }
                if selection_inserted == 1 {
                    append_offer_selection_version(
                        &transaction,
                        &OfferSelectionRecord {
                            product_id: change.item.id.clone(),
                            offer_id: offer_id.to_string(),
                            selected_by: change.approved_by.clone(),
                            reason: "Initial approved supplier offer".to_string(),
                            selected_at: change.item.updated_at.clone(),
                        },
                    )?;
                }
            }
        }
        let pricing_basis = selected_offer_pricing_basis(&transaction, &change.item.id)?;
        let selected_offer_id = pricing_basis.offer_id;
        let offer_cost_cents = pricing_basis.offer_cost_cents;
        let cost_basis_cents = pricing_basis.cost_basis_cents;
        let supplier_id_snapshot = pricing_basis.supplier_id;
        let supplier_name_snapshot = pricing_basis.supplier_name;
        let supplier_sku_snapshot = pricing_basis.supplier_sku;
        let cost_gst_basis = pricing_basis.gst_basis;
        let currency = pricing_basis.currency;
        let sell_basis = gst_exclusive_cost_cents(
            change.item.sell_price_cents,
            &change.item.sell_price_gst_basis,
        )?;
        if sell_basis < minimum_sell_cents(cost_basis_cents)? {
            return Err("The sell price is below the required 30 percent markup floor.".into());
        }
        let brand_markup = match change.item.brand_id.as_deref() {
            Some(brand_id) => transaction
                .query_row(
                    "SELECT markup_hundredths FROM brands WHERE id=?1",
                    params![brand_id],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .optional()
                .map_err(|_| "The brand markup could not be resolved.".to_string())?
                .ok_or_else(|| "The selected brand does not exist.".to_string())?,
            None => None,
        };
        let (markup_source_type, markup_source_id, applied_markup_hundredths) =
            if let Some(value) = product_markup_hundredths {
                ("product".to_string(), Some(change.item.id.clone()), value)
            } else if let Some(value) = brand_markup {
                ("brand".to_string(), change.item.brand_id.clone(), value)
            } else {
                (
                    "global".to_string(),
                    None,
                    global_markup_hundredths(&transaction)?,
                )
            };
        let exact_sell_cents = expected_sell_cents(
            offer_cost_cents,
            &cost_gst_basis,
            applied_markup_hundredths,
            &change.item.sell_price_gst_basis,
        )?;
        if change.item.sell_price_cents != exact_sell_cents {
            return Err(
                "The sell price does not equal the verified selected-offer price calculation."
                    .to_string(),
            );
        }
        if change.item.cost_cents != offer_cost_cents {
            return Err("The catalogue cost does not match the selected supplier offer.".into());
        }
        let provenance_state = if selected_offer_id.is_some() {
            "resolved"
        } else {
            "legacy-unresolved"
        }
        .to_string();
        let explanation = if selected_offer_id.is_some() {
            format!(
                "Selected supplier offer with {} markup applied to GST-exclusive cost",
                markup_source_type
            )
        } else {
            "No selected supplier offer; legacy cost provenance unresolved".to_string()
        };
        if let Some(claimed) = change.pricing_provenance.as_ref() {
            validate_text(
                &claimed.explanation,
                "Pricing provenance explanation",
                2_000,
                true,
            )?;
            let verified_currency = currency.as_deref().ok_or_else(|| {
                "Pricing provenance cannot be verified without a selected supplier offer."
                    .to_string()
            })?;
            if claimed.selected_offer_id != selected_offer_id
                || claimed.supplier_id != supplier_id_snapshot
                || claimed.supplier_name != supplier_name_snapshot
                || claimed.supplier_sku != supplier_sku_snapshot
                || claimed.cost_gst_basis != cost_gst_basis
                || claimed.currency != verified_currency
                || claimed.markup_percent != markup_string(applied_markup_hundredths)
                || claimed.markup_source != markup_source_type
                || claimed.markup_source_id != markup_source_id
                || claimed.brand_id != change.item.brand_id
                || claimed.item_kind != change.item.item_kind
                || claimed.sell_price_gst_basis != change.item.sell_price_gst_basis
                || claimed.rule_version != "pricing-rule-v1"
            {
                return Err(
                    "Pricing provenance is stale or does not match persisted pricing facts."
                        .to_string(),
                );
            }
        }
        if change.item.selected_offer_id != selected_offer_id {
            return Err(
                "The catalogue selection is stale; reload the selected supplier offer.".to_string(),
            );
        }
        let history = PriceHistoryRecord {
            id: Uuid::new_v4().to_string(),
            item_id: change.item.id.clone(),
            cost: money_string(change.item.cost_cents),
            sell_price: money_string(change.item.sell_price_cents),
            cost_cents: change.item.cost_cents,
            sell_price_cents: change.item.sell_price_cents,
            approval_id: approval.id.clone(),
            selected_offer_id,
            cost_basis_cents,
            markup_source_type,
            markup_source_id,
            applied_markup_hundredths: Some(applied_markup_hundredths),
            supplier_id_snapshot,
            supplier_name_snapshot,
            supplier_sku_snapshot,
            cost_gst_basis,
            sell_price_gst_basis: change.item.sell_price_gst_basis.clone(),
            currency,
            brand_id_snapshot: change.item.brand_id.clone(),
            item_kind_snapshot: Some(change.item.item_kind.clone()),
            pricing_explanation: explanation,
            pricing_rule_version: "pricing-rule-v1".to_string(),
            provenance_state,
            recorded_at: approved_at,
        };
        transaction
            .execute(
                "INSERT INTO approvals(id,item_id,approved_by,proposed_sell_cents,reason,approved_at) VALUES(?1,?2,?3,?4,?5,?6)",
                params![approval.id,approval.item_id,approval.approved_by,approval.proposed_sell_cents,approval.reason,approval.approved_at],
            )
            .map_err(|_| "The publication approval could not be recorded.".to_string())?;
        transaction
            .execute(
                "INSERT INTO price_history(id,item_id,cost_cents,sell_price_cents,approval_id,selected_offer_id,cost_basis_cents,markup_source_type,markup_source_id,applied_markup_hundredths,supplier_id_snapshot,supplier_name_snapshot,supplier_sku_snapshot,cost_gst_basis,sell_price_gst_basis,currency,brand_id_snapshot,item_kind_snapshot,pricing_explanation,pricing_rule_version,provenance_state,recorded_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
                params![history.id,history.item_id,history.cost_cents,history.sell_price_cents,history.approval_id,
                    history.selected_offer_id,history.cost_basis_cents,history.markup_source_type,history.markup_source_id,
                    history.applied_markup_hundredths,history.supplier_id_snapshot,history.supplier_name_snapshot,history.supplier_sku_snapshot,
                    history.cost_gst_basis,history.sell_price_gst_basis,history.currency,history.brand_id_snapshot,history.item_kind_snapshot,
                    history.pricing_explanation,history.pricing_rule_version,history.provenance_state,history.recorded_at],
            )
            .map_err(|_| "The approved price history could not be recorded.".to_string())?;
        published.push(PublishedChange {
            item: change.item.clone(),
            approval,
            price_history: history,
        });
    }
    assert_integrity(&transaction)?;
    transaction
        .commit()
        .map_err(|_| "The approved publication could not be committed.".to_string())?;
    Ok(published)
}

#[tauri::command]
fn publish_approved_changes(
    state: State<'_, AppState>,
    changes: Vec<PublishApprovedChange>,
) -> Result<Vec<PublishedChange>, String> {
    let _gate = lock_mutation_gate(&state)?;
    publish_approved_changes_at(&state, &changes)
}

fn publish_approved_changes_at(
    state: &AppState,
    changes: &[PublishApprovedChange],
) -> Result<Vec<PublishedChange>, String> {
    let mut connection = open_connection(&state.database_path)?;
    let overwrites_existing = changes.iter().try_fold(false, |found, change| {
        let exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM catalogue_items WHERE id=?1)",
                params![change.item.id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|_| "The existing catalogue could not be checked.".to_string())?;
        Ok::<_, String>(found || exists)
    })?;
    if overwrites_existing {
        drop(connection);
        create_verified_backup_at(
            &state.database_path,
            &state.data_dir,
            "approved-publication",
        )?;
        connection = open_connection(&state.database_path)?;
    }
    publish_approved_changes_inner(&mut connection, changes)
}

fn query_approvals(
    connection: &Connection,
    item_id: Option<&str>,
) -> Result<Vec<ApprovalRecord>, String> {
    if let Some(identifier) = item_id {
        validate_identifier(identifier, "Item identifier")?;
    }
    let mut statement = connection
        .prepare(
            "SELECT id,item_id,approved_by,proposed_sell_cents,reason,approved_at FROM approvals
             WHERE (?1 IS NULL OR item_id=?1) ORDER BY approved_at,id",
        )
        .map_err(|_| "The approval history could not be read.".to_string())?;
    let approvals = statement
        .query_map(params![item_id], |row| {
            Ok(ApprovalRecord {
                id: row.get(0)?,
                item_id: row.get(1)?,
                approved_by: row.get(2)?,
                proposed_sell_cents: row.get(3)?,
                reason: row.get(4)?,
                approved_at: row.get(5)?,
            })
        })
        .map_err(|_| "The approval history could not be read.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "The approval history could not be read.".to_string())?;
    Ok(approvals)
}

#[tauri::command]
fn list_approvals(
    state: State<'_, AppState>,
    item_id: Option<String>,
) -> Result<Vec<ApprovalRecord>, String> {
    let connection = open_connection(&state.database_path)?;
    query_approvals(&connection, item_id.as_deref())
}

fn query_price_history(
    connection: &Connection,
    item_id: Option<&str>,
) -> Result<Vec<PriceHistoryRecord>, String> {
    if let Some(identifier) = item_id {
        validate_identifier(identifier, "Item identifier")?;
    }
    let mut statement = connection
        .prepare(
            "SELECT id,item_id,cost_cents,sell_price_cents,approval_id,selected_offer_id,cost_basis_cents,
                    markup_source_type,markup_source_id,applied_markup_hundredths,supplier_id_snapshot,supplier_name_snapshot,supplier_sku_snapshot,
                    cost_gst_basis,sell_price_gst_basis,currency,brand_id_snapshot,item_kind_snapshot,pricing_explanation,pricing_rule_version,provenance_state,recorded_at FROM price_history
             WHERE (?1 IS NULL OR item_id=?1) ORDER BY recorded_at,id",
        )
        .map_err(|_| "The price history could not be read.".to_string())?;
    let history = statement
        .query_map(params![item_id], |row| {
            let cost_cents: i64 = row.get(2)?;
            let sell_price_cents: i64 = row.get(3)?;
            Ok(PriceHistoryRecord {
                id: row.get(0)?,
                item_id: row.get(1)?,
                cost: money_string(cost_cents),
                sell_price: money_string(sell_price_cents),
                cost_cents,
                sell_price_cents,
                approval_id: row.get(4)?,
                selected_offer_id: row.get(5)?,
                cost_basis_cents: row.get(6)?,
                markup_source_type: row.get(7)?,
                markup_source_id: row.get(8)?,
                applied_markup_hundredths: row.get(9)?,
                supplier_id_snapshot: row.get(10)?,
                supplier_name_snapshot: row.get(11)?,
                supplier_sku_snapshot: row.get(12)?,
                cost_gst_basis: row.get(13)?,
                sell_price_gst_basis: row.get(14)?,
                currency: row.get(15)?,
                brand_id_snapshot: row.get(16)?,
                item_kind_snapshot: row.get(17)?,
                pricing_explanation: row.get(18)?,
                pricing_rule_version: row.get(19)?,
                provenance_state: row.get(20)?,
                recorded_at: row.get(21)?,
            })
        })
        .map_err(|_| "The price history could not be read.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "The price history could not be read.".to_string())?;
    Ok(history)
}

#[tauri::command]
fn list_price_history(
    state: State<'_, AppState>,
    item_id: Option<String>,
) -> Result<Vec<PriceHistoryRecord>, String> {
    let connection = open_connection(&state.database_path)?;
    query_price_history(&connection, item_id.as_deref())
}

#[tauri::command]
fn list_competitor_references(
    state: State<'_, AppState>,
    item_id: Option<String>,
) -> Result<Vec<CompetitorReferenceRecord>, String> {
    if let Some(identifier) = item_id.as_deref() {
        validate_identifier(identifier, "Item identifier")?;
    }
    let connection = open_connection(&state.database_path)?;
    let mut statement = connection
        .prepare(
            "SELECT id,item_id,observation_json,attached_at FROM competitor_references
             WHERE (?1 IS NULL OR item_id=?1) ORDER BY attached_at,id",
        )
        .map_err(|_| "The competitor references could not be read.".to_string())?;
    let raw = statement
        .query_map(params![item_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|_| "The competitor references could not be read.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "The competitor references could not be read.".to_string())?;
    raw.into_iter()
        .map(|(id, item_id, serialised, attached_at)| {
            let observation: CompetitorEvidence = serde_json::from_str(&serialised)
                .map_err(|_| "A stored competitor reference is invalid.".to_string())?;
            validate_competitor_evidence(&observation)
                .map_err(|_| "A stored competitor reference is invalid.".to_string())?;
            Ok(CompetitorReferenceRecord {
                id,
                item_id,
                observation,
                attached_at,
            })
        })
        .collect()
}

#[tauri::command]
fn attach_competitor_reference(
    state: State<'_, AppState>,
    item_id: String,
    observation: CompetitorEvidence,
) -> Result<CompetitorReferenceRecord, String> {
    attach_competitor_reference_inner(&state, item_id, observation)
}

fn attach_competitor_reference_inner(
    state: &AppState,
    item_id: String,
    observation: CompetitorEvidence,
) -> Result<CompetitorReferenceRecord, String> {
    validate_identifier(&item_id, "Item identifier")?;
    validate_competitor_evidence(&observation)?;
    let observation_value = serde_json::to_value(&observation)
        .map_err(|_| "Competitor observation could not be validated.".to_string())?;
    let serialised = validate_json(&observation_value, "Competitor observation")?;
    let _gate = lock_mutation_gate(state)?;
    let connection = open_connection(&state.database_path)?;
    let record = CompetitorReferenceRecord {
        id: Uuid::new_v4().to_string(),
        item_id,
        observation,
        attached_at: now_text(),
    };
    connection
        .execute(
            "INSERT INTO competitor_references(id,item_id,observation_json,attached_at) VALUES(?1,?2,?3,?4)",
            params![record.id, record.item_id, serialised, record.attached_at],
        )
        .map_err(|_| "The competitor reference could not be attached.".to_string())?;
    Ok(record)
}

#[tauri::command]
fn list_sources(state: State<'_, AppState>) -> Result<Vec<SourceRecord>, String> {
    let connection = open_connection(&state.database_path)?;
    let mut statement = connection
        .prepare("SELECT state_json FROM source_registry ORDER BY id")
        .map_err(|_| "The source registry could not be read.".to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "The source registry could not be read.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "The source registry could not be read.".to_string())?;
    rows.into_iter()
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|_| "A stored source registry record is invalid.".to_string())
        })
        .collect()
}

#[tauri::command]
fn replace_sources(
    state: State<'_, AppState>,
    sources: Vec<SourceRecord>,
) -> Result<Vec<SourceRecord>, String> {
    if sources.len() > 1_000 {
        return Err("The source registry is too large.".to_string());
    }
    let mut identifiers = HashSet::new();
    for source in &sources {
        validate_source(source)?;
        if !identifiers.insert(&source.id) {
            return Err("The source registry contains a duplicate identifier.".to_string());
        }
    }
    let _gate = lock_mutation_gate(&state)?;
    create_verified_backup_at(&state.database_path, &state.data_dir, "replace-sources")?;
    let mut connection = open_connection(&state.database_path)?;
    let transaction = connection
        .transaction()
        .map_err(|_| "The source registry update could not start.".to_string())?;
    transaction
        .execute("DELETE FROM source_registry", [])
        .map_err(|_| "The source registry could not be replaced.".to_string())?;
    for source in &sources {
        let value = serde_json::to_string(source)
            .map_err(|_| "A source registry record could not be encoded.".to_string())?;
        transaction
            .execute(
                "INSERT INTO source_registry(id,state_json,updated_at) VALUES(?1,?2,?3)",
                params![source.id, value, now_text()],
            )
            .map_err(|_| "The source registry could not be replaced.".to_string())?;
    }
    assert_integrity(&transaction)?;
    transaction
        .commit()
        .map_err(|_| "The source registry update could not be committed.".to_string())?;
    Ok(sources)
}

#[tauri::command]
fn list_mapping_profiles(state: State<'_, AppState>) -> Result<Vec<MappingProfileRecord>, String> {
    let connection = open_connection(&state.database_path)?;
    let mut statement = connection
        .prepare("SELECT profile_json FROM mapping_profiles ORDER BY id")
        .map_err(|_| "The mapping profiles could not be read.".to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "The mapping profiles could not be read.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "The mapping profiles could not be read.".to_string())?;
    rows.into_iter()
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|_| "A stored mapping profile is invalid.".to_string())
        })
        .collect()
}

#[tauri::command]
fn save_mapping_profile(
    state: State<'_, AppState>,
    profile: MappingProfileRecord,
) -> Result<MappingProfileRecord, String> {
    let _gate = lock_mutation_gate(&state)?;
    save_mapping_profile_inner(&state, profile)
}

fn save_mapping_profile_inner(
    state: &AppState,
    profile: MappingProfileRecord,
) -> Result<MappingProfileRecord, String> {
    validate_profile(&profile)?;
    let serialised = serde_json::to_string(&profile)
        .map_err(|_| "The mapping profile could not be encoded.".to_string())?;
    let mut connection = open_connection(&state.database_path)?;
    let overwrites = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM mapping_profiles WHERE id=?1)",
            params![profile.id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|_| "The mapping profile could not be checked.".to_string())?;
    if overwrites {
        drop(connection);
        create_verified_backup_at(&state.database_path, &state.data_dir, "overwrite-profile")?;
        connection = open_connection(&state.database_path)?;
    }
    let transaction = connection
        .transaction()
        .map_err(|_| "The mapping profile update could not start.".to_string())?;
    transaction
        .execute(
            "INSERT INTO mapping_profiles(id,profile_json,updated_at) VALUES(?1,?2,?3)
             ON CONFLICT(id) DO UPDATE SET profile_json=excluded.profile_json,updated_at=excluded.updated_at",
            params![profile.id, serialised, profile.updated_at],
        )
        .map_err(|_| "The mapping profile could not be saved.".to_string())?;
    assert_integrity(&transaction)?;
    transaction
        .commit()
        .map_err(|_| "The mapping profile could not be committed.".to_string())?;
    Ok(profile)
}

#[tauri::command]
fn delete_mapping_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    validate_identifier(&id, "Profile identifier")?;
    let _gate = lock_mutation_gate(&state)?;
    create_verified_backup_at(&state.database_path, &state.data_dir, "delete-profile")?;
    let mut connection = open_connection(&state.database_path)?;
    let transaction = connection
        .transaction()
        .map_err(|_| "The mapping profile deletion could not start.".to_string())?;
    transaction
        .execute("DELETE FROM mapping_profiles WHERE id=?1", params![id])
        .map_err(|_| "The mapping profile could not be deleted.".to_string())?;
    assert_integrity(&transaction)?;
    transaction
        .commit()
        .map_err(|_| "The mapping profile deletion could not be committed.".to_string())?;
    Ok(())
}

#[tauri::command]
fn list_aliases(state: State<'_, AppState>) -> Result<Vec<AliasRecord>, String> {
    let connection = open_connection(&state.database_path)?;
    let mut statement = connection
        .prepare("SELECT supplier_code,item_number,approved_at FROM approved_aliases ORDER BY supplier_code")
        .map_err(|_| "The approved aliases could not be read.".to_string())?;
    let aliases = statement
        .query_map([], |row| {
            Ok(AliasRecord {
                supplier_code: row.get(0)?,
                item_number: row.get(1)?,
                approved_at: row.get(2)?,
            })
        })
        .map_err(|_| "The approved aliases could not be read.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "The approved aliases could not be read.".to_string())?;
    Ok(aliases)
}

#[tauri::command]
fn save_alias(state: State<'_, AppState>, alias: AliasRecord) -> Result<AliasRecord, String> {
    let _gate = lock_mutation_gate(&state)?;
    save_alias_inner(&state, alias)
}

fn save_alias_inner(state: &AppState, alias: AliasRecord) -> Result<AliasRecord, String> {
    validate_alias(&alias)?;
    let mut connection = open_connection(&state.database_path)?;
    let overwrites = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM approved_aliases WHERE supplier_code=?1)",
            params![alias.supplier_code],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|_| "The approved alias could not be checked.".to_string())?;
    if overwrites {
        drop(connection);
        create_verified_backup_at(&state.database_path, &state.data_dir, "overwrite-alias")?;
        connection = open_connection(&state.database_path)?;
    }
    let transaction = connection
        .transaction()
        .map_err(|_| "The approved alias update could not start.".to_string())?;
    transaction
        .execute(
            "INSERT INTO approved_aliases(supplier_code,item_number,approved_at) VALUES(?1,?2,?3)
             ON CONFLICT(supplier_code) DO UPDATE SET item_number=excluded.item_number,approved_at=excluded.approved_at",
            params![alias.supplier_code, alias.item_number, alias.approved_at],
        )
        .map_err(|_| "The approved alias could not be saved.".to_string())?;
    assert_integrity(&transaction)?;
    transaction
        .commit()
        .map_err(|_| "The approved alias could not be committed.".to_string())?;
    Ok(alias)
}

#[tauri::command]
fn delete_alias(state: State<'_, AppState>, supplier_code: String) -> Result<(), String> {
    validate_identifier(&supplier_code, "Supplier code")?;
    let _gate = lock_mutation_gate(&state)?;
    create_verified_backup_at(&state.database_path, &state.data_dir, "delete-alias")?;
    let mut connection = open_connection(&state.database_path)?;
    let transaction = connection
        .transaction()
        .map_err(|_| "The approved alias deletion could not start.".to_string())?;
    transaction
        .execute(
            "DELETE FROM approved_aliases WHERE supplier_code=?1",
            params![supplier_code],
        )
        .map_err(|_| "The approved alias could not be deleted.".to_string())?;
    assert_integrity(&transaction)?;
    transaction
        .commit()
        .map_err(|_| "The approved alias deletion could not be committed.".to_string())?;
    Ok(())
}

fn parse_markup_hundredths(markup: &str) -> Result<u32, String> {
    let mut parts = markup.split('.');
    let whole = parts.next().unwrap_or_default();
    let fractional = parts.next();
    if parts.next().is_some()
        || whole.is_empty()
        || whole.len() > 3
        || !whole.bytes().all(|value| value.is_ascii_digit())
        || fractional.is_some_and(|value| {
            value.is_empty() || value.len() > 2 || !value.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        return Err("Markup setting is invalid.".to_string());
    }
    let whole = whole
        .parse::<u32>()
        .map_err(|_| "Markup setting is invalid.".to_string())?;
    let fractional = match fractional.unwrap_or_default().as_bytes() {
        [] => 0,
        [first] => u32::from(*first - b'0') * 10,
        [first, second] => u32::from(*first - b'0') * 10 + u32::from(*second - b'0'),
        _ => return Err("Markup setting is invalid.".to_string()),
    };
    let value = whole * 100 + fractional;
    if !(3_000..=99_999).contains(&value) {
        return Err("Markup must preserve the 30 percent minimum.".to_string());
    }
    Ok(value)
}

fn parse_markup_override_hundredths(markup: &str) -> Result<u32, String> {
    let mut parts = markup.split('.');
    let whole = parts.next().unwrap_or_default();
    let fractional = parts.next();
    if parts.next().is_some()
        || whole.is_empty()
        || whole.len() > 3
        || !whole.bytes().all(|value| value.is_ascii_digit())
        || fractional.is_some_and(|value| {
            value.is_empty() || value.len() > 2 || !value.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        return Err("Markup override is invalid.".to_string());
    }
    let whole = whole
        .parse::<u32>()
        .map_err(|_| "Markup override is invalid.".to_string())?;
    let fractional = match fractional.unwrap_or_default().as_bytes() {
        [] => 0,
        [first] => u32::from(*first - b'0') * 10,
        [first, second] => u32::from(*first - b'0') * 10 + u32::from(*second - b'0'),
        _ => return Err("Markup override is invalid.".to_string()),
    };
    let value = whole * 100 + fractional;
    if value > 99_999 {
        return Err("Markup override is invalid.".to_string());
    }
    Ok(value)
}

fn validate_settings(settings: &Value) -> Result<String, String> {
    let object = settings
        .as_object()
        .ok_or_else(|| "Settings must be a JSON object.".to_string())?;
    if object.len() != 4
        || !["markupPercent", "taxHandling", "theme", "glassTint"]
            .iter()
            .all(|key| object.contains_key(*key))
    {
        return Err("Settings contain an unsupported field.".to_string());
    }
    let markup = object
        .get("markupPercent")
        .and_then(Value::as_str)
        .ok_or_else(|| "Markup setting is invalid.".to_string())?;
    parse_markup_hundredths(markup)?;
    let tax = object
        .get("taxHandling")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(tax, "not-configured" | "prices-ex-gst" | "prices-inc-gst") {
        return Err("Tax handling setting is invalid.".to_string());
    }
    let theme = object
        .get("theme")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(theme, "system" | "light" | "dark") {
        return Err("Theme setting is invalid.".to_string());
    }
    let glass_tint = object
        .get("glassTint")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(glass_tint, "clear" | "tinted") {
        return Err("Glass tint setting is invalid.".to_string());
    }
    validate_json(settings, "Settings")
}

fn global_markup_hundredths(connection: &Connection) -> Result<i64, String> {
    let stored = connection
        .query_row(
            "SELECT settings_json FROM settings WHERE id='settings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "Global markup setting could not be read.".to_string())?;
    match stored {
        Some(serialised) => {
            let value: Value = serde_json::from_str(&serialised)
                .map_err(|_| "Global markup setting is invalid.".to_string())?;
            validate_settings(&value)?;
            value
                .get("markupPercent")
                .and_then(Value::as_str)
                .ok_or_else(|| "Global markup setting is invalid.".to_string())
                .and_then(|value| parse_markup_hundredths(value).map(i64::from))
        }
        None => Ok(3_000),
    }
}

#[tauri::command]
fn load_settings(state: State<'_, AppState>) -> Result<Value, String> {
    let connection = open_connection(&state.database_path)?;
    let serialised = connection
        .query_row(
            "SELECT settings_json FROM settings WHERE id='settings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "Settings could not be read.".to_string())?;
    match serialised {
        Some(value) => {
            serde_json::from_str(&value).map_err(|_| "The stored settings are invalid.".to_string())
        }
        None => Ok(json!({
            "markupPercent": "30",
            "taxHandling": "not-configured",
            "theme": "system",
            "glassTint": "clear"
        })),
    }
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: Value) -> Result<Value, String> {
    let _gate = lock_mutation_gate(&state)?;
    save_settings_inner(&state, settings)
}

fn save_settings_inner(state: &AppState, settings: Value) -> Result<Value, String> {
    let serialised = validate_settings(&settings)?;
    let mut connection = open_connection(&state.database_path)?;
    let overwrites = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE id='settings')",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|_| "Settings could not be checked.".to_string())?;
    if overwrites {
        drop(connection);
        create_verified_backup_at(&state.database_path, &state.data_dir, "overwrite-settings")?;
        connection = open_connection(&state.database_path)?;
    }
    let transaction = connection
        .transaction()
        .map_err(|_| "Settings update could not start.".to_string())?;
    let previous = transaction
        .query_row(
            "SELECT settings_json FROM settings WHERE id='settings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "Settings could not be checked.".to_string())?;
    let changed_at = now_text();
    transaction
        .execute(
            "INSERT INTO settings(id,settings_json,updated_at) VALUES('settings',?1,?2)
             ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at",
            params![serialised, changed_at],
        )
        .map_err(|_| "Settings could not be saved.".to_string())?;
    transaction
        .execute(
            "INSERT INTO settings_audit(id,previous_json,current_json,changed_by,changed_at) VALUES(?1,?2,?3,'local-operator',?4)",
            params![Uuid::new_v4().to_string(), previous, serialised, changed_at],
        )
        .map_err(|_| "The settings audit record could not be saved.".to_string())?;
    assert_integrity(&transaction)?;
    transaction
        .commit()
        .map_err(|_| "Settings update could not be committed.".to_string())?;
    Ok(settings)
}

fn validate_optional_text(value: Option<&str>, label: &str, maximum: usize) -> Result<(), String> {
    if let Some(value) = value {
        validate_text(value, label, maximum, false)?;
    }
    Ok(())
}

fn normalise_identity(
    value: &str,
    label: &str,
    maximum: usize,
) -> Result<(String, String), String> {
    let display = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if display.is_empty() || display.len() > maximum || display.chars().any(char::is_control) {
        return Err(format!("{label} is outside the supported range."));
    }
    Ok((display.clone(), display.to_lowercase()))
}

fn validate_brand(brand: &BrandRecord) -> Result<(), String> {
    validate_identifier(&brand.id, "Brand identifier")?;
    normalise_identity(&brand.name, "Brand name", 256)?;
    if brand
        .markup_hundredths
        .is_some_and(|value| !(0..=99_999).contains(&value))
    {
        return Err("Brand markup is outside the supported range.".to_string());
    }
    validate_timestamp(&brand.updated_at)
}

fn validate_supplier(supplier: &SupplierRecord) -> Result<(), String> {
    validate_identifier(&supplier.id, "Supplier identifier")?;
    validate_text(&supplier.name, "Supplier name", 256, false)?;
    validate_optional_text(
        supplier.external_reference.as_deref(),
        "Supplier external reference",
        256,
    )?;
    validate_timestamp(&supplier.updated_at)
}

fn validate_offer(offer: &SupplierOfferRecord) -> Result<(), String> {
    validate_identifier(&offer.id, "Offer identifier")?;
    validate_identifier(&offer.product_id, "Offer product identifier")?;
    validate_identifier(&offer.supplier_id, "Offer supplier identifier")?;
    normalise_identity(&offer.supplier_sku, "Supplier SKU", 256)?;
    validate_cents(offer.cost_cents, "Offer cost")?;
    if !matches!(offer.gst_basis.as_str(), "inc-gst" | "ex-gst" | "unknown") {
        return Err("Offer GST basis is invalid.".to_string());
    }
    if offer.currency != "AUD" {
        return Err("Offer currency must be AUD.".to_string());
    }
    if !matches!(
        offer.provenance_type.as_str(),
        "legacy-local" | "manual" | "supplier-file" | "xero"
    ) {
        return Err("Offer provenance type is invalid.".to_string());
    }
    validate_optional_text(
        offer.provenance_reference.as_deref(),
        "Offer provenance reference",
        1_000,
    )?;
    if let Some(value) = offer.valid_from.as_deref() {
        validate_timestamp(value)?;
    }
    if let Some(value) = offer.valid_until.as_deref() {
        validate_timestamp(value)?;
    }
    if let Some((from, until)) = offer.valid_from.as_ref().zip(offer.valid_until.as_ref()) {
        if timestamp_order_key(from)? > timestamp_order_key(until)? {
            return Err("Offer validity dates are inconsistent.".to_string());
        }
    }
    validate_timestamp(&offer.observed_at)
}

fn validate_sync_run(run: &SyncRunRecord) -> Result<String, String> {
    validate_identifier(&run.id, "Sync run identifier")?;
    if !matches!(run.system.as_str(), "xero" | "servicem8")
        || !matches!(run.direction.as_str(), "upstream-read" | "downstream-write")
        || (run.system == "xero" && run.direction != "upstream-read")
        || (run.system == "servicem8" && run.direction != "downstream-write")
    {
        return Err("Sync system and direction are invalid.".to_string());
    }
    if !matches!(
        run.status.as_str(),
        "preview" | "running" | "completed" | "partial" | "failed"
    ) || !matches!(run.mode.as_str(), "preview" | "approved")
    {
        return Err("Sync run state is invalid.".to_string());
    }
    if run.system == "servicem8" && run.mode == "approved" && run.approved_by.is_none() {
        return Err("An approved ServiceM8 write requires an approver.".to_string());
    }
    validate_timestamp(&run.started_at)?;
    if let Some(value) = run.completed_at.as_deref() {
        validate_timestamp(value)?;
    }
    if let Some(value) = run.approved_by.as_deref() {
        validate_identifier(value, "Sync approver")?;
    }
    validate_json(&run.summary, "Sync summary")
}

#[tauri::command]
fn list_brands(state: State<'_, AppState>) -> Result<Vec<BrandRecord>, String> {
    let connection = open_connection(&state.database_path)?;
    let mut statement = connection
        .prepare("SELECT id,name,markup_hundredths,updated_at FROM brands ORDER BY name,id")
        .map_err(|_| "Brands could not be read.".to_string())?;
    let records = statement
        .query_map([], |row| {
            Ok(BrandRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                markup_hundredths: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .map_err(|_| "Brands could not be read.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Brands could not be read.".to_string())?;
    Ok(records)
}

fn append_brand_version(transaction: &Transaction<'_>, brand: &BrandRecord) -> Result<(), String> {
    let version = transaction
        .query_row(
            "SELECT COALESCE(MAX(version),0)+1 FROM brand_versions WHERE brand_id=?1",
            params![brand.id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| "The brand audit version could not be resolved.".to_string())?;
    let snapshot = serde_json::to_value(brand)
        .map_err(|_| "The brand audit snapshot could not be created.".to_string())?;
    let serialised = validate_json(&snapshot, "Brand audit snapshot")?;
    transaction
        .execute(
            "INSERT INTO brand_versions(brand_id,version,snapshot_json,changed_at) VALUES(?1,?2,?3,?4)",
            params![brand.id, version, serialised, brand.updated_at],
        )
        .map_err(|_| "The brand audit version could not be appended.".to_string())?;
    Ok(())
}

#[tauri::command]
fn save_brand(state: State<'_, AppState>, brand: BrandRecord) -> Result<BrandRecord, String> {
    let _gate = lock_mutation_gate(&state)?;
    let mut connection = open_connection(&state.database_path)?;
    save_brand_inner(&mut connection, brand)
}

fn save_brand_inner(
    connection: &mut Connection,
    brand: BrandRecord,
) -> Result<BrandRecord, String> {
    validate_brand(&brand)?;
    let (normalised_name, canonical_key) = normalise_identity(&brand.name, "Brand name", 256)?;
    let mut stored = brand;
    stored.name = normalised_name;
    let transaction = connection
        .transaction()
        .map_err(|_| "The brand update could not start.".to_string())?;
    let current = transaction
        .query_row(
            "SELECT updated_at FROM brands WHERE id=?1",
            params![stored.id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "The current brand version could not be read.".to_string())?;
    if let Some(updated_at) = current {
        if timestamp_order_key(&stored.updated_at)? <= timestamp_order_key(&updated_at)? {
            return Err("The brand update is stale; reload the latest brand.".to_string());
        }
    }
    transaction.execute(
        "INSERT INTO brands(id,name,markup_hundredths,updated_at,canonical_key) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,markup_hundredths=excluded.markup_hundredths,updated_at=excluded.updated_at,canonical_key=excluded.canonical_key",
        params![stored.id,stored.name,stored.markup_hundredths,stored.updated_at,canonical_key],
    ).map_err(|_| "The brand could not be saved.".to_string())?;
    append_brand_version(&transaction, &stored)?;
    assert_integrity(&transaction)?;
    transaction
        .commit()
        .map_err(|_| "The brand could not be committed.".to_string())?;
    Ok(stored)
}

#[tauri::command]
fn list_suppliers(state: State<'_, AppState>) -> Result<Vec<SupplierRecord>, String> {
    let connection = open_connection(&state.database_path)?;
    let mut statement = connection
        .prepare(
            "SELECT id,name,active,external_reference,updated_at FROM suppliers ORDER BY name,id",
        )
        .map_err(|_| "Suppliers could not be read.".to_string())?;
    let records = statement
        .query_map([], |row| {
            Ok(SupplierRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                active: row.get(2)?,
                external_reference: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|_| "Suppliers could not be read.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Suppliers could not be read.".to_string())?;
    Ok(records)
}

#[tauri::command]
fn save_supplier(
    state: State<'_, AppState>,
    supplier: SupplierRecord,
) -> Result<SupplierRecord, String> {
    let _gate = lock_mutation_gate(&state)?;
    let mut connection = open_connection(&state.database_path)?;
    save_supplier_inner(&mut connection, supplier)
}

fn append_supplier_version(
    transaction: &Transaction<'_>,
    supplier: &SupplierRecord,
) -> Result<(), String> {
    let version = transaction
        .query_row(
            "SELECT COALESCE(MAX(version),0)+1 FROM supplier_versions WHERE supplier_id=?1",
            params![supplier.id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| "The supplier audit version could not be resolved.".to_string())?;
    let snapshot = serde_json::to_value(supplier)
        .map_err(|_| "The supplier audit snapshot could not be created.".to_string())?;
    let serialised = validate_json(&snapshot, "Supplier audit snapshot")?;
    transaction.execute(
        "INSERT INTO supplier_versions(supplier_id,version,snapshot_json,changed_at) VALUES(?1,?2,?3,?4)",
        params![supplier.id,version,serialised,supplier.updated_at],
    ).map_err(|_| "The supplier audit version could not be appended.".to_string())?;
    Ok(())
}

fn save_supplier_inner(
    connection: &mut Connection,
    supplier: SupplierRecord,
) -> Result<SupplierRecord, String> {
    validate_supplier(&supplier)?;
    let transaction = connection
        .transaction()
        .map_err(|_| "The supplier update could not start.".to_string())?;
    let current = transaction
        .query_row(
            "SELECT updated_at FROM suppliers WHERE id=?1",
            params![supplier.id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "The current supplier version could not be read.".to_string())?;
    if let Some(updated_at) = current {
        if timestamp_order_key(&supplier.updated_at)? <= timestamp_order_key(&updated_at)? {
            return Err("The supplier update is stale; reload the latest supplier.".to_string());
        }
    }
    transaction.execute(
        "INSERT INTO suppliers(id,name,active,external_reference,updated_at) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=excluded.active,external_reference=excluded.external_reference,updated_at=excluded.updated_at",
        params![supplier.id,supplier.name,supplier.active,supplier.external_reference,supplier.updated_at],
    ).map_err(|_| "The supplier could not be saved.".to_string())?;
    append_supplier_version(&transaction, &supplier)?;
    assert_integrity(&transaction)?;
    transaction
        .commit()
        .map_err(|_| "The supplier could not be committed.".to_string())?;
    Ok(supplier)
}

#[tauri::command]
fn list_supplier_offers(
    state: State<'_, AppState>,
    product_id: Option<String>,
) -> Result<Vec<SupplierOfferRecord>, String> {
    if let Some(value) = product_id.as_deref() {
        validate_identifier(value, "Product identifier")?;
    }
    let connection = open_connection(&state.database_path)?;
    let mut statement = connection.prepare(
        "SELECT id,product_id,supplier_id,supplier_sku,cost_cents,gst_basis,currency,active,is_preferred,valid_from,valid_until,provenance_type,provenance_reference,observed_at
         FROM product_supplier_offers WHERE (?1 IS NULL OR product_id=?1) ORDER BY product_id,supplier_id,id"
    ).map_err(|_| "Supplier offers could not be read.".to_string())?;
    let records = statement
        .query_map(params![product_id], |row| {
            Ok(SupplierOfferRecord {
                id: row.get(0)?,
                product_id: row.get(1)?,
                supplier_id: row.get(2)?,
                supplier_sku: row.get(3)?,
                cost_cents: row.get(4)?,
                gst_basis: row.get(5)?,
                currency: row.get(6)?,
                active: row.get(7)?,
                is_preferred: row.get(8)?,
                valid_from: row.get(9)?,
                valid_until: row.get(10)?,
                provenance_type: row.get(11)?,
                provenance_reference: row.get(12)?,
                observed_at: row.get(13)?,
            })
        })
        .map_err(|_| "Supplier offers could not be read.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Supplier offers could not be read.".to_string())?;
    Ok(records)
}

fn query_supplier_offer(
    connection: &Connection,
    offer_id: &str,
) -> Result<SupplierOfferRecord, String> {
    connection
        .query_row(
            "SELECT id,product_id,supplier_id,supplier_sku,cost_cents,gst_basis,currency,active,is_preferred,valid_from,valid_until,provenance_type,provenance_reference,observed_at
             FROM product_supplier_offers WHERE id=?1",
            params![offer_id],
            |row| {
                Ok(SupplierOfferRecord {
                    id: row.get(0)?,
                    product_id: row.get(1)?,
                    supplier_id: row.get(2)?,
                    supplier_sku: row.get(3)?,
                    cost_cents: row.get(4)?,
                    gst_basis: row.get(5)?,
                    currency: row.get(6)?,
                    active: row.get(7)?,
                    is_preferred: row.get(8)?,
                    valid_from: row.get(9)?,
                    valid_until: row.get(10)?,
                    provenance_type: row.get(11)?,
                    provenance_reference: row.get(12)?,
                    observed_at: row.get(13)?,
                })
            },
        )
        .map_err(|_| "The supplier offer could not be read for audit.".to_string())
}

fn append_supplier_offer_version(
    transaction: &Transaction<'_>,
    offer: &SupplierOfferRecord,
    changed_at: &str,
) -> Result<(), String> {
    let version = transaction
        .query_row(
            "SELECT COALESCE(MAX(version),0)+1 FROM supplier_offer_versions WHERE offer_id=?1",
            params![offer.id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| "The supplier offer audit version could not be resolved.".to_string())?;
    let snapshot = serde_json::to_string(offer)
        .map_err(|_| "The supplier offer audit snapshot could not be created.".to_string())?;
    transaction
        .execute(
            "INSERT INTO supplier_offer_versions(offer_id,version,snapshot_json,changed_at) VALUES(?1,?2,?3,?4)",
            params![offer.id, version, snapshot, changed_at],
        )
        .map_err(|_| "The supplier offer audit version could not be appended.".to_string())?;
    Ok(())
}

fn append_offer_selection_version(
    transaction: &Transaction<'_>,
    selection: &OfferSelectionRecord,
) -> Result<(), String> {
    let version = transaction
        .query_row(
            "SELECT COALESCE(MAX(version),0)+1 FROM offer_selection_versions WHERE product_id=?1",
            params![selection.product_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| "The offer selection audit version could not be resolved.".to_string())?;
    let snapshot = serde_json::to_string(selection)
        .map_err(|_| "The offer selection audit snapshot could not be created.".to_string())?;
    transaction
        .execute(
            "INSERT INTO offer_selection_versions(product_id,version,snapshot_json,changed_at) VALUES(?1,?2,?3,?4)",
            params![selection.product_id, version, snapshot, selection.selected_at],
        )
        .map_err(|_| "The offer selection audit version could not be appended.".to_string())?;
    Ok(())
}

#[tauri::command]
fn save_supplier_offer(
    state: State<'_, AppState>,
    offer: SupplierOfferRecord,
) -> Result<SupplierOfferRecord, String> {
    let _gate = lock_mutation_gate(&state)?;
    let mut connection = open_connection(&state.database_path)?;
    save_supplier_offer_inner(&mut connection, offer)
}

fn save_supplier_offer_inner(
    connection: &mut Connection,
    offer: SupplierOfferRecord,
) -> Result<SupplierOfferRecord, String> {
    validate_offer(&offer)?;
    let (normalised_sku, normalized_supplier_sku) =
        normalise_identity(&offer.supplier_sku, "Supplier SKU", 256)?;
    let mut offer = offer;
    offer.supplier_sku = normalised_sku;
    let transaction = connection
        .transaction()
        .map_err(|_| "The supplier offer update could not start.".to_string())?;
    let existing = transaction
        .query_row(
            "SELECT product_id,observed_at FROM product_supplier_offers WHERE id=?1",
            params![offer.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|_| "The current supplier offer version could not be read.".to_string())?;
    if let Some((product_id, observed_at)) = existing {
        if product_id != offer.product_id {
            return Err("A supplier offer cannot be moved to another product.".to_string());
        }
        if timestamp_order_key(&offer.observed_at)? <= timestamp_order_key(&observed_at)? {
            return Err("The supplier offer update is stale; reload the latest offer.".to_string());
        }
    }
    transaction.execute(
        "INSERT INTO product_supplier_offers(id,product_id,supplier_id,supplier_sku,normalized_supplier_sku,cost_cents,gst_basis,currency,active,is_preferred,valid_from,valid_until,provenance_type,provenance_reference,observed_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
         ON CONFLICT(id) DO UPDATE SET product_id=excluded.product_id,supplier_id=excluded.supplier_id,supplier_sku=excluded.supplier_sku,
           normalized_supplier_sku=excluded.normalized_supplier_sku,cost_cents=excluded.cost_cents,gst_basis=excluded.gst_basis,currency=excluded.currency,active=excluded.active,is_preferred=excluded.is_preferred,
           valid_from=excluded.valid_from,valid_until=excluded.valid_until,provenance_type=excluded.provenance_type,
           provenance_reference=excluded.provenance_reference,observed_at=excluded.observed_at",
        params![offer.id,offer.product_id,offer.supplier_id,offer.supplier_sku,normalized_supplier_sku,offer.cost_cents,offer.gst_basis,offer.currency,offer.active,
          offer.is_preferred,offer.valid_from,offer.valid_until,offer.provenance_type,offer.provenance_reference,offer.observed_at]
    ).map_err(|_| "The supplier offer could not be saved.".to_string())?;
    let stored = query_supplier_offer(&transaction, &offer.id)?;
    append_supplier_offer_version(&transaction, &stored, &offer.observed_at)?;
    assert_integrity(&transaction)?;
    transaction
        .commit()
        .map_err(|_| "The supplier offer could not be committed.".to_string())?;
    Ok(offer)
}

#[tauri::command]
fn list_offer_selections(state: State<'_, AppState>) -> Result<Vec<OfferSelectionRecord>, String> {
    let connection = open_connection(&state.database_path)?;
    let mut statement = connection.prepare("SELECT product_id,offer_id,selected_by,reason,selected_at FROM product_offer_selections ORDER BY product_id")
        .map_err(|_| "Offer selections could not be read.".to_string())?;
    let records = statement
        .query_map([], |row| {
            Ok(OfferSelectionRecord {
                product_id: row.get(0)?,
                offer_id: row.get(1)?,
                selected_by: row.get(2)?,
                reason: row.get(3)?,
                selected_at: row.get(4)?,
            })
        })
        .map_err(|_| "Offer selections could not be read.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Offer selections could not be read.".to_string())?;
    Ok(records)
}

#[tauri::command]
fn select_product_offer(
    state: State<'_, AppState>,
    selection: OfferSelectionRecord,
) -> Result<OfferSelectionRecord, String> {
    let _gate = lock_mutation_gate(&state)?;
    let mut connection = open_connection(&state.database_path)?;
    select_product_offer_inner(&mut connection, selection)
}

fn select_product_offer_inner(
    connection: &mut Connection,
    selection: OfferSelectionRecord,
) -> Result<OfferSelectionRecord, String> {
    validate_identifier(&selection.product_id, "Selection product identifier")?;
    validate_identifier(&selection.offer_id, "Selection offer identifier")?;
    validate_identifier(&selection.selected_by, "Selection operator")?;
    validate_text(&selection.reason, "Selection reason", 1_000, false)?;
    validate_timestamp(&selection.selected_at)?;
    let transaction = connection
        .transaction()
        .map_err(|_| "The offer selection could not start.".to_string())?;
    let prior_selected_at = transaction
        .query_row(
            "SELECT selected_at FROM product_offer_selections WHERE product_id=?1",
            params![selection.product_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "The current offer selection version could not be read.".to_string())?;
    if let Some(prior) = prior_selected_at {
        if timestamp_order_key(&selection.selected_at)? <= timestamp_order_key(&prior)? {
            return Err("The offer selection update is stale; reload the latest selection.".into());
        }
    }
    let eligible: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM product_supplier_offers o JOIN suppliers s ON s.id=o.supplier_id
          WHERE o.id=?1 AND o.product_id=?2 AND o.active=1 AND s.active=1
          AND (o.valid_from IS NULL OR datetime(o.valid_from)<=datetime(?3))
          AND (o.valid_until IS NULL OR datetime(o.valid_until)>=datetime(?3)))",
        params![selection.offer_id,selection.product_id,selection.selected_at], |row| row.get(0)
    ).map_err(|_| "The supplier offer could not be validated.".to_string())?;
    if !eligible {
        return Err(
            "The selected offer is not active, valid and owned by this product.".to_string(),
        );
    }
    let prior_preferred = transaction
        .prepare("SELECT id FROM product_supplier_offers WHERE product_id=?1 AND is_preferred=1")
        .and_then(|mut statement| {
            statement
                .query_map(params![selection.product_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| "The prior preferred offers could not be read.".to_string())?;
    let target_was_preferred = prior_preferred.iter().any(|id| id == &selection.offer_id);
    transaction
        .execute(
            "UPDATE product_supplier_offers SET is_preferred=0 WHERE product_id=?1",
            params![selection.product_id],
        )
        .map_err(|_| "The prior preferred offer could not be cleared.".to_string())?;
    transaction
        .execute(
            "UPDATE product_supplier_offers SET is_preferred=1 WHERE id=?1 AND product_id=?2",
            params![selection.offer_id, selection.product_id],
        )
        .map_err(|_| "The preferred offer could not be set.".to_string())?;
    transaction.execute(
        "INSERT INTO product_offer_selections(product_id,offer_id,selected_by,reason,selected_at) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(product_id) DO UPDATE SET offer_id=excluded.offer_id,selected_by=excluded.selected_by,reason=excluded.reason,selected_at=excluded.selected_at",
        params![selection.product_id,selection.offer_id,selection.selected_by,selection.reason,selection.selected_at]
    ).map_err(|_| "The offer selection could not be saved.".to_string())?;
    let mut changed_offer_ids = prior_preferred
        .into_iter()
        .filter(|id| id != &selection.offer_id)
        .collect::<HashSet<_>>();
    if !target_was_preferred {
        changed_offer_ids.insert(selection.offer_id.clone());
    }
    for offer_id in changed_offer_ids {
        let offer = query_supplier_offer(&transaction, &offer_id)?;
        append_supplier_offer_version(&transaction, &offer, &selection.selected_at)?;
    }
    append_offer_selection_version(&transaction, &selection)?;
    assert_integrity(&transaction)?;
    transaction
        .commit()
        .map_err(|_| "The offer selection could not be committed.".to_string())?;
    Ok(selection)
}

#[tauri::command]
fn update_product_metadata(
    state: State<'_, AppState>,
    update: ProductMetadataUpdate,
) -> Result<ProductMetadataUpdate, String> {
    let _gate = lock_mutation_gate(&state)?;
    let mut connection = open_connection(&state.database_path)?;
    update_product_metadata_inner(&mut connection, update)
}

fn validate_product_metadata_snapshot(
    snapshot: &ProductMetadataVersionSnapshot,
) -> Result<(), String> {
    validate_identifier(&snapshot.product_id, "Product identifier")?;
    if !matches!(
        snapshot.item_kind.as_str(),
        "physical-product" | "service" | "labour"
    ) {
        return Err("Product item kind is invalid.".to_string());
    }
    if let Some(value) = snapshot.brand_id.as_deref() {
        validate_identifier(value, "Brand identifier")?;
    }
    if snapshot
        .markup_override_hundredths
        .is_some_and(|value| !(0..=99_999).contains(&value))
    {
        return Err("Product markup is outside the supported range.".to_string());
    }
    validate_optional_text(snapshot.xero_reference.as_deref(), "Xero reference", 256)?;
    validate_optional_text(
        snapshot.servicem8_reference.as_deref(),
        "ServiceM8 reference",
        256,
    )?;
    if let Some(value) = snapshot.barcode_gtin.as_deref() {
        if value.is_empty() || value.len() > 64 || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("Barcode must contain 1 to 64 digits.".to_string());
        }
    }
    validate_timestamp(&snapshot.updated_at)
}

fn query_product_metadata_snapshot(
    connection: &Connection,
    product_id: &str,
) -> Result<ProductMetadataVersionSnapshot, String> {
    let snapshot = connection
        .query_row(
            "SELECT id,item_kind,brand_id,product_markup_hundredths,upstream_reference,servicem8_reference,barcode,updated_at
             FROM catalogue_items WHERE id=?1",
            params![product_id],
            |row| {
                Ok(ProductMetadataVersionSnapshot {
                    product_id: row.get(0)?,
                    item_kind: row.get(1)?,
                    brand_id: row.get(2)?,
                    markup_override_hundredths: row.get(3)?,
                    xero_reference: row.get(4)?,
                    servicem8_reference: row.get(5)?,
                    barcode_gtin: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )
        .map_err(|_| "The product metadata snapshot could not be read.".to_string())?;
    validate_product_metadata_snapshot(&snapshot)?;
    Ok(snapshot)
}

fn append_product_metadata_version(
    transaction: &Transaction<'_>,
    snapshot: &ProductMetadataVersionSnapshot,
) -> Result<(), String> {
    validate_product_metadata_snapshot(snapshot)?;
    let version = transaction
        .query_row(
            "SELECT COALESCE(MAX(version),0)+1 FROM product_metadata_versions WHERE product_id=?1",
            params![snapshot.product_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| "The product metadata audit version could not be resolved.".to_string())?;
    let value = serde_json::to_value(snapshot)
        .map_err(|_| "The product metadata audit snapshot could not be created.".to_string())?;
    let serialised = validate_json(&value, "Product metadata audit snapshot")?;
    transaction
        .execute(
            "INSERT INTO product_metadata_versions(product_id,version,snapshot_json,changed_at) VALUES(?1,?2,?3,?4)",
            params![snapshot.product_id, version, serialised, snapshot.updated_at],
        )
        .map_err(|_| "The product metadata audit version could not be appended.".to_string())?;
    Ok(())
}

fn update_product_metadata_inner(
    connection: &mut Connection,
    update: ProductMetadataUpdate,
) -> Result<ProductMetadataUpdate, String> {
    validate_identifier(&update.product_id, "Product identifier")?;
    if !matches!(
        update.item_kind.as_str(),
        "physical-product" | "service" | "labour"
    ) {
        return Err("Product item kind is invalid.".to_string());
    }
    if let Some(value) = update.brand_id.as_deref() {
        validate_identifier(value, "Brand identifier")?;
    }
    let markup_hundredths = update
        .markup_override_percent
        .as_deref()
        .map(parse_markup_override_hundredths)
        .transpose()?
        .map(i64::from);
    validate_optional_text(update.xero_reference.as_deref(), "Xero reference", 256)?;
    validate_optional_text(
        update.servicem8_reference.as_deref(),
        "ServiceM8 reference",
        256,
    )?;
    if let Some(value) = update.barcode.as_deref() {
        if value.is_empty() || value.len() > 64 || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("Barcode must contain 1 to 64 digits.".to_string());
        }
    }
    validate_timestamp(&update.updated_at)?;
    let transaction = connection
        .transaction()
        .map_err(|_| "The product metadata update could not start.".to_string())?;
    let current_updated_at = transaction
        .query_row(
            "SELECT updated_at FROM catalogue_items WHERE id=?1",
            params![update.product_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "The current product metadata version could not be read.".to_string())?
        .ok_or_else(|| "The product was not found.".to_string())?;
    if timestamp_order_key(&update.updated_at)? <= timestamp_order_key(&current_updated_at)? {
        return Err("The product metadata update is stale; reload the latest product.".to_string());
    }
    let changed = transaction.execute(
        "UPDATE catalogue_items SET item_kind=?1,brand_id=?2,product_markup_hundredths=?3,upstream_reference=?4,servicem8_reference=?5,barcode=?6,updated_at=?7 WHERE id=?8",
        params![update.item_kind,update.brand_id,markup_hundredths,update.xero_reference,update.servicem8_reference,update.barcode,update.updated_at,update.product_id]
    ).map_err(|_| "Product metadata could not be updated.".to_string())?;
    if changed != 1 {
        return Err("The product was not found.".to_string());
    }
    let snapshot = query_product_metadata_snapshot(&transaction, &update.product_id)?;
    append_product_metadata_version(&transaction, &snapshot)?;
    assert_integrity(&transaction)?;
    transaction
        .commit()
        .map_err(|_| "The product metadata update could not be committed.".to_string())?;
    Ok(update)
}

#[tauri::command]
fn list_settings_audit(state: State<'_, AppState>) -> Result<Vec<SettingsAuditRecord>, String> {
    let connection = open_connection(&state.database_path)?;
    let mut statement = connection.prepare("SELECT id,previous_json,current_json,changed_by,changed_at FROM settings_audit ORDER BY changed_at,id")
        .map_err(|_| "Settings audit could not be read.".to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|_| "Settings audit could not be read.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Settings audit could not be read.".to_string())?;
    rows.into_iter()
        .map(|(id, previous, current, changed_by, changed_at)| {
            Ok(SettingsAuditRecord {
                id,
                previous: previous
                    .map(|value| {
                        serde_json::from_str(&value)
                            .map_err(|_| "Settings audit is invalid.".to_string())
                    })
                    .transpose()?,
                current: serde_json::from_str(&current)
                    .map_err(|_| "Settings audit is invalid.".to_string())?,
                changed_by,
                changed_at,
            })
        })
        .collect()
}

#[tauri::command]
fn list_sync_runs(state: State<'_, AppState>) -> Result<Vec<SyncRunRecord>, String> {
    let connection = open_connection(&state.database_path)?;
    let mut statement = connection.prepare("SELECT id,system,direction,status,mode,started_at,completed_at,approved_by,summary_json FROM sync_runs ORDER BY started_at,id")
        .map_err(|_| "Sync runs could not be read.".to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
            ))
        })
        .map_err(|_| "Sync runs could not be read.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Sync runs could not be read.".to_string())?;
    rows.into_iter()
        .map(|row| {
            Ok(SyncRunRecord {
                id: row.0,
                system: row.1,
                direction: row.2,
                status: row.3,
                mode: row.4,
                started_at: row.5,
                completed_at: row.6,
                approved_by: row.7,
                summary: serde_json::from_str(&row.8)
                    .map_err(|_| "A sync summary is invalid.".to_string())?,
            })
        })
        .collect()
}

#[tauri::command]
fn save_sync_run(state: State<'_, AppState>, run: SyncRunRecord) -> Result<SyncRunRecord, String> {
    let summary = validate_sync_run(&run)?;
    let _gate = lock_mutation_gate(&state)?;
    let connection = open_connection(&state.database_path)?;
    let changed = connection.execute(
        "INSERT INTO sync_runs(id,system,direction,status,mode,started_at,completed_at,approved_by,summary_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at,summary_json=excluded.summary_json
         WHERE sync_runs.system=excluded.system AND sync_runs.direction=excluded.direction AND sync_runs.mode=excluded.mode
           AND sync_runs.started_at=excluded.started_at AND sync_runs.approved_by IS excluded.approved_by",
        params![run.id,run.system,run.direction,run.status,run.mode,run.started_at,run.completed_at,run.approved_by,summary]
    ).map_err(|_| "The sync run could not be saved.".to_string())?;
    if changed != 1 {
        return Err(
            "The sync run identity or approval facts do not match the existing record.".to_string(),
        );
    }
    Ok(run)
}

#[tauri::command]
fn list_sync_checkpoints(
    state: State<'_, AppState>,
    run_id: Option<String>,
) -> Result<Vec<SyncCheckpointRecord>, String> {
    if let Some(value) = run_id.as_deref() {
        validate_identifier(value, "Sync run identifier")?;
    }
    let connection = open_connection(&state.database_path)?;
    let mut statement=connection.prepare("SELECT id,run_id,cursor_value,recorded_at FROM sync_checkpoints WHERE (?1 IS NULL OR run_id=?1) ORDER BY recorded_at,id")
        .map_err(|_|"Sync checkpoints could not be read.".to_string())?;
    let records = statement
        .query_map(params![run_id], |row| {
            Ok(SyncCheckpointRecord {
                id: row.get(0)?,
                run_id: row.get(1)?,
                cursor_value: row.get(2)?,
                recorded_at: row.get(3)?,
            })
        })
        .map_err(|_| "Sync checkpoints could not be read.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Sync checkpoints could not be read.".to_string())?;
    Ok(records)
}

#[tauri::command]
fn append_sync_checkpoint(
    state: State<'_, AppState>,
    checkpoint: SyncCheckpointRecord,
) -> Result<SyncCheckpointRecord, String> {
    validate_identifier(&checkpoint.id, "Checkpoint identifier")?;
    validate_identifier(&checkpoint.run_id, "Sync run identifier")?;
    validate_text(&checkpoint.cursor_value, "Sync cursor", 1_000, false)?;
    validate_timestamp(&checkpoint.recorded_at)?;
    let _gate = lock_mutation_gate(&state)?;
    let connection = open_connection(&state.database_path)?;
    connection
        .execute(
            "INSERT INTO sync_checkpoints(id,run_id,cursor_value,recorded_at) VALUES(?1,?2,?3,?4)",
            params![
                checkpoint.id,
                checkpoint.run_id,
                checkpoint.cursor_value,
                checkpoint.recorded_at
            ],
        )
        .map_err(|_| "The sync checkpoint could not be appended.".to_string())?;
    Ok(checkpoint)
}

#[tauri::command]
fn list_sync_item_outcomes(
    state: State<'_, AppState>,
    run_id: Option<String>,
) -> Result<Vec<SyncItemOutcomeRecord>, String> {
    if let Some(value) = run_id.as_deref() {
        validate_identifier(value, "Sync run identifier")?;
    }
    let connection = open_connection(&state.database_path)?;
    let mut statement=connection.prepare("SELECT id,run_id,item_id,external_id,action,status,message,idempotency_key,attempt_count,retryable,error_class,reconciliation,recorded_at FROM sync_item_outcomes WHERE (?1 IS NULL OR run_id=?1) ORDER BY recorded_at,id")
        .map_err(|_|"Sync item outcomes could not be read.".to_string())?;
    let records = statement
        .query_map(params![run_id], |row| {
            Ok(SyncItemOutcomeRecord {
                id: row.get(0)?,
                run_id: row.get(1)?,
                item_id: row.get(2)?,
                external_id: row.get(3)?,
                action: row.get(4)?,
                status: row.get(5)?,
                message: row.get(6)?,
                idempotency_key: row.get(7)?,
                attempt_count: row.get(8)?,
                retryable: row.get(9)?,
                error_class: row.get(10)?,
                reconciliation: row.get(11)?,
                recorded_at: row.get(12)?,
            })
        })
        .map_err(|_| "Sync item outcomes could not be read.".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Sync item outcomes could not be read.".to_string())?;
    Ok(records)
}

#[tauri::command]
fn append_sync_item_outcome(
    state: State<'_, AppState>,
    outcome: SyncItemOutcomeRecord,
) -> Result<SyncItemOutcomeRecord, String> {
    validate_identifier(&outcome.id, "Sync outcome identifier")?;
    validate_identifier(&outcome.run_id, "Sync run identifier")?;
    if let Some(value) = outcome.item_id.as_deref() {
        validate_identifier(value, "Product identifier")?;
    }
    validate_optional_text(
        outcome.external_id.as_deref(),
        "External item identifier",
        256,
    )?;
    validate_text(&outcome.action, "Sync action", 128, false)?;
    if !matches!(
        outcome.status.as_str(),
        "planned" | "succeeded" | "skipped" | "failed"
    ) {
        return Err("Sync outcome status is invalid.".to_string());
    }
    validate_text(&outcome.message, "Sync outcome message", 2_000, true)?;
    validate_identifier(&outcome.idempotency_key, "Idempotency key")?;
    if !(0..=100).contains(&outcome.attempt_count) {
        return Err("Sync attempt count is invalid.".to_string());
    }
    validate_optional_text(outcome.error_class.as_deref(), "Sync error class", 128)?;
    if !matches!(
        outcome.reconciliation.as_str(),
        "not-run" | "matched" | "mismatch" | "not-applicable"
    ) {
        return Err("Reconciliation result is invalid.".to_string());
    }
    validate_timestamp(&outcome.recorded_at)?;
    let _gate = lock_mutation_gate(&state)?;
    let connection = open_connection(&state.database_path)?;
    connection.execute("INSERT INTO sync_item_outcomes(id,run_id,item_id,external_id,action,status,message,idempotency_key,attempt_count,retryable,error_class,reconciliation,recorded_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",params![outcome.id,outcome.run_id,outcome.item_id,outcome.external_id,outcome.action,outcome.status,outcome.message,outcome.idempotency_key,outcome.attempt_count,outcome.retryable,outcome.error_class,outcome.reconciliation,outcome.recorded_at])
        .map_err(|_|"The sync item outcome could not be appended.".to_string())?;
    Ok(outcome)
}

fn configuration_payload_value(envelope: &ConfigurationEnvelope) -> Result<Value, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct WithoutHash<'a> {
        schema_version: i64,
        application: &'a str,
        exported_at: &'a str,
        counts: &'a ConfigurationCounts,
        data: &'a ConfigurationData,
    }
    serde_json::to_value(&WithoutHash {
        schema_version: envelope.schema_version,
        application: &envelope.application,
        exported_at: &envelope.exported_at,
        counts: &envelope.counts,
        data: &envelope.data,
    })
    .map_err(|_| "The configuration export could not be encoded.".to_string())
}

fn configuration_source_value(envelope: &ConfigurationEnvelope) -> Result<Value, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SourceSnapshot<'a> {
        schema_version: i64,
        application: &'a str,
        counts: &'a ConfigurationCounts,
        data: &'a ConfigurationData,
    }
    serde_json::to_value(&SourceSnapshot {
        schema_version: envelope.schema_version,
        application: &envelope.application,
        counts: &envelope.counts,
        data: &envelope.data,
    })
    .map_err(|_| "The configuration source could not be encoded.".to_string())
}

fn recursively_sorted_json(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut entries = object.into_iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            let mut sorted = serde_json::Map::new();
            for (key, value) in entries {
                sorted.insert(key, recursively_sorted_json(value));
            }
            Value::Object(sorted)
        }
        Value::Array(values) => {
            Value::Array(values.into_iter().map(recursively_sorted_json).collect())
        }
        scalar => scalar,
    }
}

fn configuration_payload_sha256(envelope: &ConfigurationEnvelope) -> Result<String, String> {
    let canonical = recursively_sorted_json(configuration_payload_value(envelope)?);
    let bytes = serde_json::to_vec(&canonical)
        .map_err(|_| "The configuration export could not be encoded.".to_string())?;
    Ok(sha256_bytes(&bytes))
}

fn configuration_source_sha256(envelope: &ConfigurationEnvelope) -> Result<String, String> {
    // The source identity deliberately excludes exportedAt and the transport
    // checksum. Regenerating an envelope for the same inspected WebView data
    // therefore remains idempotent, while any profile, alias or setting change
    // produces a distinct source identity.
    let canonical = recursively_sorted_json(configuration_source_value(envelope)?);
    let bytes = serde_json::to_vec(&canonical)
        .map_err(|_| "The configuration source could not be encoded.".to_string())?;
    Ok(sha256_bytes(&bytes))
}

fn legacy_configuration_payload_sha256(envelope: &ConfigurationEnvelope) -> Result<String, String> {
    let bytes = serde_json::to_vec(&configuration_payload_value(envelope)?)
        .map_err(|_| "The configuration export could not be encoded.".to_string())?;
    Ok(sha256_bytes(&bytes))
}

fn configuration_from_database(connection: &Connection) -> Result<ConfigurationEnvelope, String> {
    let profiles = {
        let mut statement = connection
            .prepare("SELECT profile_json FROM mapping_profiles ORDER BY id")
            .map_err(|_| "The configuration could not be read.".to_string())?;
        let values = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| "The configuration could not be read.".to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "The configuration could not be read.".to_string())?
            .into_iter()
            .map(|value| {
                serde_json::from_str(&value)
                    .map_err(|_| "A stored mapping profile is invalid.".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        values
    };
    let aliases = {
        let mut statement = connection
            .prepare("SELECT supplier_code,item_number,approved_at FROM approved_aliases ORDER BY supplier_code")
            .map_err(|_| "The configuration could not be read.".to_string())?;
        let values = statement
            .query_map([], |row| {
                Ok(AliasRecord {
                    supplier_code: row.get(0)?,
                    item_number: row.get(1)?,
                    approved_at: row.get(2)?,
                })
            })
            .map_err(|_| "The configuration could not be read.".to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "The configuration could not be read.".to_string())?;
        values
    };
    let settings = connection
        .query_row(
            "SELECT settings_json FROM settings WHERE id='settings'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "The configuration could not be read.".to_string())?
        .map(|value| {
            serde_json::from_str(&value).map_err(|_| "The stored settings are invalid.".to_string())
        })
        .transpose()?
        .unwrap_or_else(
            || json!({"markupPercent":"30","taxHandling":"not-configured","theme":"system","glassTint":"clear"}),
        );
    let counts = ConfigurationCounts {
        profiles: profiles.len(),
        aliases: aliases.len(),
        settings: 1,
    };
    let mut envelope = ConfigurationEnvelope {
        schema_version: CONFIGURATION_SCHEMA_VERSION,
        application: APPLICATION_ID.to_string(),
        exported_at: now_text(),
        counts,
        data: ConfigurationData {
            profiles,
            aliases,
            settings,
        },
        sha256: String::new(),
    };
    envelope.sha256 = configuration_payload_sha256(&envelope)?;
    Ok(envelope)
}

fn validate_configuration_envelope(envelope: &ConfigurationEnvelope) -> Result<(), String> {
    if envelope.schema_version != CONFIGURATION_SCHEMA_VERSION {
        return Err("The configuration schema version is not supported.".to_string());
    }
    if envelope.application != APPLICATION_ID {
        return Err("The configuration belongs to a different application.".to_string());
    }
    validate_timestamp(&envelope.exported_at)?;
    if envelope.data.profiles.len() > 1_000
        || envelope.data.aliases.len() > 100_000
        || envelope.counts.profiles != envelope.data.profiles.len()
        || envelope.counts.aliases != envelope.data.aliases.len()
        || envelope.counts.settings != 1
    {
        return Err("The configuration counts are invalid.".to_string());
    }
    let mut profile_ids = HashSet::new();
    for profile in &envelope.data.profiles {
        validate_profile(profile)?;
        if !profile_ids.insert(&profile.id) {
            return Err("The configuration contains a duplicate profile.".to_string());
        }
    }
    let mut alias_ids = HashSet::new();
    for alias in &envelope.data.aliases {
        validate_alias(alias)?;
        if !alias_ids.insert(&alias.supplier_code) {
            return Err("The configuration contains a duplicate alias.".to_string());
        }
    }
    validate_settings(&envelope.data.settings)?;
    if envelope.sha256.len() != 64
        || !envelope
            .sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("The configuration checksum is invalid.".to_string());
    }
    Ok(())
}

fn verify_configuration_checksum(envelope: &ConfigurationEnvelope) -> bool {
    configuration_payload_sha256(envelope).is_ok_and(|digest| digest == envelope.sha256)
        || legacy_configuration_payload_sha256(envelope)
            .is_ok_and(|digest| digest == envelope.sha256)
}

fn configuration_source_was_imported(
    connection: &Connection,
    source_id: &str,
    legacy_envelope_sha256: Option<&str>,
) -> Result<bool, String> {
    let legacy = legacy_envelope_sha256.unwrap_or(source_id);
    connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM configuration_imports
               WHERE source_id=?1
                  OR (source_id=?2 AND content_sha256=?2)
             )",
            params![source_id, legacy],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|_| "The configuration import ledger could not be read.".to_string())
}

fn configuration_conflicts(
    connection: &Connection,
    envelope: &ConfigurationEnvelope,
) -> Result<ConfigurationConflicts, String> {
    let mut profile_conflicts = 0;
    for profile in &envelope.data.profiles {
        let exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM mapping_profiles WHERE id=?1)",
                params![profile.id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|_| "The existing configuration could not be checked.".to_string())?;
        profile_conflicts += usize::from(exists);
    }
    let mut alias_conflicts = 0;
    for alias in &envelope.data.aliases {
        let exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM approved_aliases WHERE supplier_code=?1)",
                params![alias.supplier_code],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|_| "The existing configuration could not be checked.".to_string())?;
        alias_conflicts += usize::from(exists);
    }
    let settings = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE id='settings')",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|_| "The existing configuration could not be checked.".to_string())?;
    Ok(ConfigurationConflicts {
        profiles: profile_conflicts,
        aliases: alias_conflicts,
        settings: usize::from(settings),
    })
}

#[tauri::command]
fn export_configuration(state: State<'_, AppState>) -> Result<ConfigurationEnvelope, String> {
    let connection = open_connection(&state.database_path)?;
    configuration_from_database(&connection)
}

#[tauri::command]
fn preview_configuration_import(
    state: State<'_, AppState>,
    serialised: String,
) -> Result<ConfigurationPreview, String> {
    preview_configuration_import_inner(&state, serialised)
}

fn preview_configuration_import_inner(
    state: &AppState,
    serialised: String,
) -> Result<ConfigurationPreview, String> {
    if serialised.is_empty() || serialised.len() > MAX_IMPORT_BYTES {
        return Err("The configuration import size is outside the supported range.".to_string());
    }
    let envelope: ConfigurationEnvelope = serde_json::from_str(&serialised)
        .map_err(|_| "The configuration import is malformed.".to_string())?;
    validate_configuration_envelope(&envelope)?;
    if !verify_configuration_checksum(&envelope) {
        return Err("The configuration checksum did not match.".to_string());
    }
    let source_sha256 = configuration_source_sha256(&envelope)?;
    let connection = open_connection(&state.database_path)?;
    let already_imported =
        configuration_source_was_imported(&connection, &source_sha256, Some(&envelope.sha256))?;
    let conflicts = if already_imported {
        ConfigurationConflicts::default()
    } else {
        configuration_conflicts(&connection, &envelope)?
    };
    let preview_token = Uuid::new_v4().to_string();
    let mut pending_imports = safe_lock(&state.pending_imports)?;
    prune_expired_and_require_capacity(
        &mut pending_imports,
        MAX_PENDING_OPERATIONS,
        |pending| pending.created_at,
        "configuration import previews",
    )?;
    pending_imports.insert(
        preview_token.clone(),
        PendingImport {
            source_id: source_sha256,
            content_sha256: envelope.sha256.clone(),
            envelope: envelope.clone(),
            conflicts: conflicts.clone(),
            created_at: Instant::now(),
        },
    );
    let valid = already_imported || !conflicts.any();
    let validation_messages = if already_imported {
        vec![
            "This exact configuration was already imported; applying it again makes no changes."
                .to_string(),
        ]
    } else if valid {
        Vec::new()
    } else {
        vec![
            "The configuration conflicts with existing records; live data will not be changed."
                .to_string(),
        ]
    };
    Ok(ConfigurationPreview {
        preview_token,
        schema_version: envelope.schema_version,
        counts: envelope.counts,
        conflicts,
        valid,
        validation_messages,
    })
}

#[cfg(test)]
fn apply_configuration_import_inner(
    state: &AppState,
    pending: PendingImport,
) -> Result<ConfigurationCounts, String> {
    let _gate = lock_mutation_gate(state)?;
    apply_configuration_import_under_gate(state, pending)
}

fn apply_configuration_import_under_gate(
    state: &AppState,
    pending: PendingImport,
) -> Result<ConfigurationCounts, String> {
    if pending.created_at.elapsed() > Duration::from_secs(30 * 60) {
        return Err("The configuration preview has expired.".to_string());
    }
    validate_configuration_envelope(&pending.envelope)?;
    if pending.content_sha256 != pending.envelope.sha256
        || pending.source_id != configuration_source_sha256(&pending.envelope)?
    {
        return Err("The configuration preview no longer matches its input.".to_string());
    }
    let connection = open_connection(&state.database_path)?;
    let already_imported = configuration_source_was_imported(
        &connection,
        &pending.source_id,
        Some(&pending.envelope.sha256),
    )?;
    if already_imported {
        return Ok(pending.envelope.counts);
    }
    let live_conflicts = configuration_conflicts(&connection, &pending.envelope)?;
    if pending.conflicts.any() || live_conflicts.any() {
        return Err(
            "The configuration conflicts with existing records; live data was not changed."
                .to_string(),
        );
    }
    drop(connection);

    let pre_import = create_verified_backup_at(&state.database_path, &state.data_dir, "import")?;
    let mut connection = open_connection(&state.database_path)?;
    let already_imported = configuration_source_was_imported(
        &connection,
        &pending.source_id,
        Some(&pending.envelope.sha256),
    )?;
    if already_imported {
        return Ok(pending.envelope.counts);
    }
    if configuration_conflicts(&connection, &pending.envelope)?.any() {
        return Err(
            "The configuration conflicts with existing records; live data was not changed."
                .to_string(),
        );
    }
    let transaction = connection
        .transaction()
        .map_err(|_| "The configuration import could not start.".to_string())?;
    for profile in &pending.envelope.data.profiles {
        let serialised = serde_json::to_string(profile)
            .map_err(|_| "A mapping profile could not be encoded.".to_string())?;
        transaction
            .execute(
                "INSERT INTO mapping_profiles(id,profile_json,updated_at) VALUES(?1,?2,?3)
                 ON CONFLICT(id) DO UPDATE SET profile_json=excluded.profile_json,updated_at=excluded.updated_at",
                params![profile.id, serialised, profile.updated_at],
            )
            .map_err(|_| "A mapping profile could not be imported.".to_string())?;
    }
    for alias in &pending.envelope.data.aliases {
        transaction
            .execute(
                "INSERT INTO approved_aliases(supplier_code,item_number,approved_at) VALUES(?1,?2,?3)
                 ON CONFLICT(supplier_code) DO UPDATE SET item_number=excluded.item_number,approved_at=excluded.approved_at",
                params![alias.supplier_code, alias.item_number, alias.approved_at],
            )
            .map_err(|_| "An approved alias could not be imported.".to_string())?;
    }
    let settings = validate_settings(&pending.envelope.data.settings)?;
    transaction
        .execute(
            "INSERT INTO settings(id,settings_json,updated_at) VALUES('settings',?1,?2)
             ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at",
            params![settings, now_text()],
        )
        .map_err(|_| "Settings could not be imported.".to_string())?;
    transaction
        .execute(
            "INSERT INTO configuration_imports(source_id,content_sha256,imported_at,profile_count,alias_count,settings_count)
             VALUES(?1,?2,?3,?4,?5,1)",
            params![
                pending.source_id,
                pending.content_sha256,
                now_text(),
                pending.envelope.counts.profiles as i64,
                pending.envelope.counts.aliases as i64
            ],
        )
        .map_err(|_| "The configuration import could not be recorded.".to_string())?;
    transaction
        .commit()
        .map_err(|_| "The configuration import could not be committed.".to_string())?;
    if assert_integrity(&connection).is_err() {
        drop(connection);
        restore_backup_files(&state.database_path, &state.data_dir, &pre_import.id).map_err(
            |_| {
                "Configuration verification failed and the prior database could not be recovered."
                    .to_string()
            },
        )?;
        return Err(
            "Configuration verification failed; the prior database was restored.".to_string(),
        );
    }
    Ok(pending.envelope.counts)
}

#[tauri::command]
fn apply_configuration_import(
    state: State<'_, AppState>,
    preview_token: String,
) -> Result<ConfigurationCounts, String> {
    apply_configuration_import_at(&state, preview_token)
}

fn apply_configuration_import_at(
    state: &AppState,
    preview_token: String,
) -> Result<ConfigurationCounts, String> {
    validate_identifier(&preview_token, "Preview token")?;
    let _gate = lock_mutation_gate(state)?;
    let pending = safe_lock(&state.pending_imports)?
        .remove(&preview_token)
        .ok_or_else(|| {
            "The configuration preview is missing or has already been used.".to_string()
        })?;
    apply_configuration_import_under_gate(state, pending)
}

fn configuration_migration_status_inner(
    state: &AppState,
    legacy_serialised: Option<String>,
) -> Result<ConfigurationMigrationStatus, String> {
    let connection = open_connection(&state.database_path)?;
    let configuration = configuration_from_database(&connection)?;
    let Some(serialised) = legacy_serialised else {
        return Ok(ConfigurationMigrationStatus {
            legacy_configuration_found: false,
            already_imported: false,
            counts: configuration.counts,
            valid: true,
            invalid_counts: ConfigurationCounts {
                profiles: 0,
                aliases: 0,
                settings: 0,
            },
            validation_messages: Vec::new(),
        });
    };
    if serialised.is_empty() || serialised.len() > MAX_IMPORT_BYTES {
        return Err("The legacy configuration size is outside the supported range.".to_string());
    }
    let envelope: ConfigurationEnvelope = serde_json::from_str(&serialised)
        .map_err(|_| "The legacy configuration is malformed.".to_string())?;
    validate_configuration_envelope(&envelope)?;
    if !verify_configuration_checksum(&envelope) {
        return Err("The legacy configuration checksum did not match.".to_string());
    }
    let source_id = configuration_source_sha256(&envelope)?;
    let already_imported =
        configuration_source_was_imported(&connection, &source_id, Some(&envelope.sha256))?;
    let counts = if already_imported {
        configuration.counts
    } else {
        envelope.counts
    };
    Ok(ConfigurationMigrationStatus {
        legacy_configuration_found: true,
        already_imported,
        counts,
        valid: true,
        invalid_counts: ConfigurationCounts {
            profiles: 0,
            aliases: 0,
            settings: 0,
        },
        validation_messages: if already_imported {
            vec!["This exact legacy configuration was already imported.".to_string()]
        } else {
            Vec::new()
        },
    })
}

#[tauri::command]
fn configuration_migration_status(
    state: State<'_, AppState>,
    legacy_serialised: Option<String>,
) -> Result<ConfigurationMigrationStatus, String> {
    configuration_migration_status_inner(&state, legacy_serialised)
}

fn valid_backup_reason(reason: &str) -> bool {
    matches!(
        reason,
        "migration" | "import" | "restore" | "reset" | "manual"
    )
}

#[tauri::command]
fn create_backup(state: State<'_, AppState>, reason: String) -> Result<BackupSummary, String> {
    if !valid_backup_reason(&reason) {
        return Err("Backup reason is invalid.".to_string());
    }
    let _gate = lock_mutation_gate(&state)?;
    create_verified_backup_at(&state.database_path, &state.data_dir, &reason)
}

fn list_backups_inner(state: &AppState) -> Result<Vec<BackupSummary>, String> {
    let directory = state.data_dir.join(BACKUP_DIRECTORY);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut summaries = Vec::new();
    for entry in
        fs::read_dir(directory).map_err(|_| "The backup list could not be read.".to_string())?
    {
        let entry = entry.map_err(|_| "The backup list could not be read.".to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".manifest.json") else {
            continue;
        };
        if let Ok(manifest) = verify_backup(&state.data_dir, id) {
            summaries.push(manifest.summary);
        }
    }
    summaries.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(summaries)
}

#[tauri::command]
fn list_backups(state: State<'_, AppState>) -> Result<Vec<BackupSummary>, String> {
    list_backups_inner(&state)
}

#[tauri::command]
fn preview_restore(
    state: State<'_, AppState>,
    backup_id: Option<String>,
) -> Result<RestorePreview, String> {
    preview_restore_inner(&state, backup_id)
}

fn preview_restore_inner(
    state: &AppState,
    backup_id: Option<String>,
) -> Result<RestorePreview, String> {
    let selected = match backup_id {
        Some(value) => value,
        None => list_backups_inner(state)?
            .into_iter()
            .next()
            .map(|summary| summary.id)
            .ok_or_else(|| "No verified backup is available to restore.".to_string())?,
    };
    let manifest = verify_backup(&state.data_dir, &selected)?;
    let preview_token = Uuid::new_v4().to_string();
    let mut pending_restores = safe_lock(&state.pending_restores)?;
    prune_expired_and_require_capacity(
        &mut pending_restores,
        MAX_PENDING_OPERATIONS,
        |pending| pending.created_at,
        "restore previews",
    )?;
    pending_restores.insert(
        preview_token.clone(),
        PendingRestore {
            backup_id: selected,
            expected_sha256: manifest.summary.sha256.clone(),
            created_at: Instant::now(),
        },
    );
    Ok(RestorePreview {
        summary: manifest.summary,
        preview_token,
        integrity_ok: true,
    })
}

#[tauri::command]
fn restore_backup(
    state: State<'_, AppState>,
    preview_token: String,
) -> Result<BackupSummary, String> {
    restore_backup_at(&state, preview_token)
}

fn restore_backup_at(state: &AppState, preview_token: String) -> Result<BackupSummary, String> {
    validate_identifier(&preview_token, "Preview token")?;
    // Acquire the shared mutation gate before consuming the single-use token. A
    // restore must not race a native provider request that has already reserved
    // budget and snapshotted the protected credential.
    let _gate = lock_mutation_gate(state)?;
    let pending = safe_lock(&state.pending_restores)?
        .remove(&preview_token)
        .ok_or_else(|| "The restore preview is missing or has already been used.".to_string())?;
    if pending.created_at.elapsed() > Duration::from_secs(30 * 60) {
        return Err("The restore preview has expired.".to_string());
    }
    let manifest = verify_backup(&state.data_dir, &pending.backup_id)?;
    if manifest.summary.sha256 != pending.expected_sha256 {
        return Err("The backup changed after it was previewed.".to_string());
    }
    restore_with_postcheck(
        &state.database_path,
        &state.data_dir,
        &pending.backup_id,
        apply_migrations_and_reset_provider_policy,
    )?;
    clear_search_candidates(state);
    Ok(manifest.summary)
}

fn apply_migrations_and_reset_provider_policy(
    database_path: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    apply_migrations(database_path, data_dir)?;
    let connection = open_connection(database_path)?;
    connection
        .execute(
            "UPDATE provider_state SET paid_calls_enabled=0,last_validated_at=NULL,
             cost_ceiling_cents=0,cost_per_call_cents=0,spent_cents=0 WHERE provider=?1",
            params![PROVIDER_ID],
        )
        .map_err(|_| "Provider policy could not be reset after restore.".to_string())?;
    validate_current_database(&connection)
}

#[tauri::command]
fn preview_reset(state: State<'_, AppState>) -> Result<ResetPreview, String> {
    let _gate = lock_mutation_gate(&state)?;
    preview_reset_inner(&state)
}

fn preview_reset_inner(state: &AppState) -> Result<ResetPreview, String> {
    let connection = open_connection(&state.database_path)?;
    let counts = record_counts(&connection)?;
    let provider = provider_status_inner(state, &connection)?;
    let database_digest = logical_database_digest(&connection)?;
    let credential_fingerprint = credential_fingerprint(state)?;
    let reset_token = Uuid::new_v4().to_string();
    let mut pending_resets = safe_lock(&state.pending_resets)?;
    prune_expired_and_require_capacity(
        &mut pending_resets,
        MAX_PENDING_OPERATIONS,
        |pending| pending.created_at,
        "reset previews",
    )?;
    pending_resets.insert(
        reset_token.clone(),
        PendingReset {
            counts: counts.clone(),
            provider_paid_calls_enabled: provider.paid_calls_enabled,
            credential_configured: provider.credential_configured,
            database_digest,
            credential_fingerprint,
            created_at: Instant::now(),
        },
    );
    Ok(ResetPreview {
        reset_token,
        confirmation_phrase: RESET_CONFIRMATION.to_string(),
        scope: vec![
            "catalogue items".to_string(),
            "approvals and price history".to_string(),
            "competitor references and sources".to_string(),
            "mapping profiles, aliases and settings".to_string(),
            "brands, suppliers, offers and explicit offer selections".to_string(),
            "append-only supplier-offer and selection version history".to_string(),
            "append-only supplier version history".to_string(),
            "append-only brand and product metadata version history".to_string(),
            "sync runs, checkpoints, outcomes and settings audit".to_string(),
            "provider state and the Windows-protected provider credential".to_string(),
        ],
        record_counts: counts,
    })
}

fn delete_operational_data(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            "DROP TRIGGER IF EXISTS approvals_no_delete;
             DROP TRIGGER IF EXISTS price_history_no_delete;
             DROP TRIGGER IF EXISTS settings_audit_no_delete;
             DROP TRIGGER IF EXISTS sync_item_outcomes_no_delete;
             DROP TRIGGER IF EXISTS supplier_offer_versions_no_delete;
             DROP TRIGGER IF EXISTS offer_selection_versions_no_delete;
             DROP TRIGGER IF EXISTS supplier_versions_no_delete;
             DROP TRIGGER IF EXISTS brand_versions_no_delete;
             DROP TRIGGER IF EXISTS product_metadata_versions_no_delete;
             DELETE FROM competitor_references;
             DELETE FROM price_history;
             DELETE FROM approvals;
             DELETE FROM sync_item_outcomes;
             DELETE FROM sync_checkpoints;
             DELETE FROM sync_runs;
             DELETE FROM supplier_offer_versions;
             DELETE FROM offer_selection_versions;
             DELETE FROM supplier_versions;
             DELETE FROM brand_versions;
             DELETE FROM product_metadata_versions;
             DELETE FROM product_offer_selections;
             DELETE FROM product_supplier_offers;
             DELETE FROM catalogue_items;
             DELETE FROM brands;
             DELETE FROM suppliers;
             DELETE FROM source_registry;
             DELETE FROM mapping_profiles;
             DELETE FROM approved_aliases;
             DELETE FROM settings;
             DELETE FROM settings_audit;
             DELETE FROM configuration_imports;
             DELETE FROM provider_state;
             INSERT INTO provider_state(provider,paid_calls_enabled,last_validated_at)
               VALUES('serpapi',0,NULL);
             CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals BEGIN SELECT RAISE(ABORT, 'append-only'); END;
             CREATE TRIGGER price_history_no_delete BEFORE DELETE ON price_history BEGIN SELECT RAISE(ABORT, 'append-only'); END;
             CREATE TRIGGER settings_audit_no_delete BEFORE DELETE ON settings_audit BEGIN SELECT RAISE(ABORT, 'append-only'); END;
             CREATE TRIGGER sync_item_outcomes_no_delete BEFORE DELETE ON sync_item_outcomes BEGIN SELECT RAISE(ABORT, 'append-only'); END;
             CREATE TRIGGER supplier_offer_versions_no_delete BEFORE DELETE ON supplier_offer_versions BEGIN SELECT RAISE(ABORT, 'append-only'); END;
             CREATE TRIGGER offer_selection_versions_no_delete BEFORE DELETE ON offer_selection_versions BEGIN SELECT RAISE(ABORT, 'append-only'); END;
             CREATE TRIGGER supplier_versions_no_delete BEFORE DELETE ON supplier_versions BEGIN SELECT RAISE(ABORT, 'append-only'); END;
             CREATE TRIGGER brand_versions_no_delete BEFORE DELETE ON brand_versions BEGIN SELECT RAISE(ABORT, 'append-only'); END;
             CREATE TRIGGER product_metadata_versions_no_delete BEFORE DELETE ON product_metadata_versions BEGIN SELECT RAISE(ABORT, 'append-only'); END;",
        )
        .map_err(|_| "Application data could not be erased safely.".to_string())
}

fn reset_application_data_inner(
    state: &AppState,
    pending: PendingReset,
) -> Result<BackupSummary, String> {
    let connection = open_connection(&state.database_path)?;
    let provider_before = provider_status_inner(state, &connection)?;
    if record_counts(&connection)? != pending.counts
        || provider_before.paid_calls_enabled != pending.provider_paid_calls_enabled
        || provider_before.credential_configured != pending.credential_configured
        || logical_database_digest(&connection)? != pending.database_digest
        || credential_fingerprint(state)? != pending.credential_fingerprint
    {
        return Err("Application data changed after reset was previewed.".to_string());
    }
    drop(connection);
    let pre_reset = create_verified_backup_at(&state.database_path, &state.data_dir, "reset")?;
    let mut connection = open_connection(&state.database_path)?;
    if logical_database_digest(&connection)? != pending.database_digest
        || credential_fingerprint(state)? != pending.credential_fingerprint
    {
        return Err("Application data changed while the reset backup was created.".to_string());
    }
    let database_reset = (|| -> Result<(), String> {
        let transaction = connection
            .transaction()
            .map_err(|_| "Application data reset could not start.".to_string())?;
        delete_operational_data(&transaction)?;
        transaction
            .commit()
            .map_err(|_| "Application data reset could not be committed.".to_string())?;
        assert_integrity(&connection)?;
        let provider_after = provider_status_inner(state, &connection)?;
        if record_counts(&connection)? != BackupRecordCounts::default()
            || provider_after.paid_calls_enabled
            || provider_after.last_validated_at.is_some()
        {
            return Err("Application data reset verification failed.".to_string());
        }
        Ok(())
    })();
    drop(connection);
    if database_reset.is_err() {
        restore_backup_files(&state.database_path, &state.data_dir, &pre_reset.id).map_err(
            |_| {
                "Application data reset failed and the prior database could not be recovered."
                    .to_string()
            },
        )?;
        return Err(
            "Application data reset failed verification; prior data was restored.".to_string(),
        );
    }
    if state.credential_store.remove().is_err() {
        restore_backup_files(&state.database_path, &state.data_dir, &pre_reset.id).map_err(
            |_| {
                "Credential removal failed and the prior database could not be recovered."
                    .to_string()
            },
        )?;
        return Err(
            "Credential removal failed; the database from before reset was recovered.".to_string(),
        );
    }
    clear_search_candidates(state);
    Ok(pre_reset)
}

fn validate_reset_confirmation(confirmation: &str) -> Result<(), String> {
    if confirmation != RESET_CONFIRMATION {
        return Err("The reset confirmation phrase did not match.".to_string());
    }
    Ok(())
}

#[tauri::command]
fn reset_application_data(
    state: State<'_, AppState>,
    reset_token: String,
    confirmation: String,
) -> Result<BackupSummary, String> {
    reset_application_data_at(&state, reset_token, confirmation)
}

fn reset_application_data_at(
    state: &AppState,
    reset_token: String,
    confirmation: String,
) -> Result<BackupSummary, String> {
    validate_identifier(&reset_token, "Reset token")?;
    validate_reset_confirmation(&confirmation)?;
    // Do not consume the preview while an authorised provider request is in
    // flight. This keeps retry semantics explicit and prevents erasure or
    // credential removal while the snapshotted credential is being used.
    let _gate = lock_mutation_gate(state)?;
    let pending = safe_lock(&state.pending_resets)?
        .remove(&reset_token)
        .ok_or_else(|| "The reset preview is missing or has already been used.".to_string())?;
    if pending.created_at.elapsed() > Duration::from_secs(15 * 60) {
        return Err("The reset preview has expired.".to_string());
    }
    reset_application_data_inner(state, pending)
}

#[cfg(windows)]
struct WindowsCredentialStore;

#[cfg(windows)]
mod wincred {
    use std::ffi::c_void;

    #[repr(C)]
    pub struct FileTime {
        pub _low: u32,
        pub _high: u32,
    }

    #[repr(C)]
    pub struct CredentialW {
        pub _flags: u32,
        pub _credential_type: u32,
        pub _target_name: *mut u16,
        pub _comment: *mut u16,
        pub _last_written: FileTime,
        pub credential_blob_size: u32,
        pub credential_blob: *mut u8,
        pub _persist: u32,
        pub _attribute_count: u32,
        pub _attributes: *mut c_void,
        pub _target_alias: *mut u16,
        pub _user_name: *mut u16,
    }

    pub const CRED_TYPE_GENERIC: u32 = 1;
    pub const CRED_PERSIST_LOCAL_MACHINE: u32 = 2;
    pub const ERROR_NOT_FOUND: i32 = 1168;

    #[link(name = "Advapi32")]
    extern "system" {
        #[link_name = "CredWriteW"]
        pub fn cred_write_w(credential: *const CredentialW, flags: u32) -> i32;
        #[link_name = "CredReadW"]
        pub fn cred_read_w(
            target_name: *const u16,
            credential_type: u32,
            flags: u32,
            credential: *mut *mut CredentialW,
        ) -> i32;
        #[link_name = "CredDeleteW"]
        pub fn cred_delete_w(target_name: *const u16, credential_type: u32, flags: u32) -> i32;
        #[link_name = "CredFree"]
        pub fn cred_free(buffer: *const c_void);
    }
}

#[cfg(windows)]
fn credential_target() -> Vec<u16> {
    credential_target_for_build_settings(LOCAL_TEST_PROFILE_BUILD_SETTING)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
impl CredentialStore for WindowsCredentialStore {
    fn set(&self, secret: &str) -> Result<(), String> {
        let mut target = credential_target();
        let mut username: Vec<u16> = "SWL".encode_utf16().chain(std::iter::once(0)).collect();
        let mut blob = secret.as_bytes().to_vec();
        let credential = wincred::CredentialW {
            _flags: 0,
            _credential_type: wincred::CRED_TYPE_GENERIC,
            _target_name: target.as_mut_ptr(),
            _comment: std::ptr::null_mut(),
            _last_written: wincred::FileTime { _low: 0, _high: 0 },
            credential_blob_size: blob.len() as u32,
            credential_blob: blob.as_mut_ptr(),
            _persist: wincred::CRED_PERSIST_LOCAL_MACHINE,
            _attribute_count: 0,
            _attributes: std::ptr::null_mut(),
            _target_alias: std::ptr::null_mut(),
            _user_name: username.as_mut_ptr(),
        };
        // SAFETY: every pointer remains valid for the duration of the synchronous
        // Windows Credential Manager call, and the blob length is validated.
        let written = unsafe { wincred::cred_write_w(&credential, 0) };
        blob.fill(0);
        if written == 0 {
            return Err("The credential could not be stored in Windows Credential Manager.".into());
        }
        Ok(())
    }

    fn get(&self) -> Result<Option<String>, String> {
        let target = credential_target();
        let mut pointer: *mut wincred::CredentialW = std::ptr::null_mut();
        // SAFETY: target is null terminated and pointer is populated by the API.
        let read = unsafe {
            wincred::cred_read_w(target.as_ptr(), wincred::CRED_TYPE_GENERIC, 0, &mut pointer)
        };
        if read == 0 {
            let error = io::Error::last_os_error().raw_os_error();
            if !pointer.is_null() {
                // SAFETY: defensive cleanup if the API supplied a buffer even
                // though it returned failure.
                unsafe { wincred::cred_free(pointer.cast()) };
            }
            if error == Some(wincred::ERROR_NOT_FOUND) {
                return Ok(None);
            }
            return Err("The protected credential could not be read.".into());
        }
        if pointer.is_null() {
            return Err("The protected credential could not be read.".into());
        }
        // SAFETY: CredReadW returned a CREDENTIALW allocation. Inspect only its
        // fixed header before deciding whether the blob pointer and size are safe.
        let (blob, blob_size) = unsafe {
            let credential = &*pointer;
            (
                credential.credential_blob,
                credential.credential_blob_size as usize,
            )
        };
        if blob.is_null() || !(1..=1_024).contains(&blob_size) {
            // SAFETY: the pointer was allocated by CredReadW and must be freed
            // even when its embedded blob is malformed or outside our bound.
            unsafe { wincred::cred_free(pointer.cast()) };
            return Err("The protected credential is invalid.".to_string());
        }
        // SAFETY: the pointer is non-null and the blob is bounded above by the
        // same 1024-byte limit used when credentials are written.
        let bytes = unsafe { std::slice::from_raw_parts(blob, blob_size).to_vec() };
        // SAFETY: the pointer was allocated by CredReadW.
        unsafe { wincred::cred_free(pointer.cast()) };
        let secret = String::from_utf8(bytes)
            .map_err(|_| "The protected credential is invalid.".to_string())?;
        Ok(Some(secret))
    }

    fn remove(&self) -> Result<(), String> {
        let target = credential_target();
        // SAFETY: target is a stable, null-terminated UTF-16 string.
        let deleted =
            unsafe { wincred::cred_delete_w(target.as_ptr(), wincred::CRED_TYPE_GENERIC, 0) };
        if deleted == 0
            && io::Error::last_os_error().raw_os_error() != Some(wincred::ERROR_NOT_FOUND)
        {
            return Err("The protected credential could not be removed.".into());
        }
        Ok(())
    }
}

#[cfg(not(windows))]
struct UnsupportedCredentialStore;

#[cfg(not(windows))]
impl CredentialStore for UnsupportedCredentialStore {
    fn set(&self, _secret: &str) -> Result<(), String> {
        Err("Protected provider credentials are available only in the Windows application.".into())
    }

    fn get(&self) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn remove(&self) -> Result<(), String> {
        Ok(())
    }
}

fn platform_credential_store() -> Arc<dyn CredentialStore> {
    #[cfg(windows)]
    {
        Arc::new(WindowsCredentialStore)
    }
    #[cfg(not(windows))]
    {
        Arc::new(UnsupportedCredentialStore)
    }
}

fn validate_credential(secret: &str) -> Result<(), String> {
    if secret.len() < 8
        || secret.len() > 1_024
        || secret.trim() != secret
        || secret.chars().any(char::is_control)
    {
        return Err("The provider credential is outside the supported range.".to_string());
    }
    Ok(())
}

fn provider_status_inner(
    state: &AppState,
    connection: &Connection,
) -> Result<ProviderStatus, String> {
    let credential_configured = state.credential_store.get()?.is_some();
    let (
        paid_calls_enabled,
        last_validated_at,
        cost_ceiling_cents,
        cost_per_call_cents,
        spent_cents,
    ) = connection
        .query_row(
            "SELECT paid_calls_enabled,last_validated_at,cost_ceiling_cents,cost_per_call_cents,spent_cents
             FROM provider_state WHERE provider=?1",
            params![PROVIDER_ID],
            |row| {
                Ok((
                    row.get::<_, bool>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .map_err(|_| "Provider state could not be read.".to_string())?;
    let policy_enabled = paid_calls_enabled && credential_configured;
    let quota_exhausted = policy_enabled
        && (cost_ceiling_cents <= 0
            || cost_per_call_cents <= 0
            || cost_per_call_cents > cost_ceiling_cents
            || spent_cents > cost_ceiling_cents - cost_per_call_cents);
    Ok(ProviderStatus {
        provider: PROVIDER_ID.to_string(),
        state: if !credential_configured {
            "not_configured".to_string()
        } else if quota_exhausted {
            "quota_exhausted".to_string()
        } else {
            "configured".to_string()
        },
        paid_calls_enabled: policy_enabled,
        cost_ceiling_aud: money_string(cost_ceiling_cents),
        cost_ceiling_cents,
        cost_per_call_cents,
        spent_cents,
        credential_configured,
        credential_hint: credential_configured.then(|| "stored in Windows".to_string()),
        last_validated_at: credential_configured.then_some(last_validated_at).flatten(),
    })
}

#[tauri::command]
fn provider_status(state: State<'_, AppState>) -> Result<ProviderStatus, String> {
    let connection = open_connection(&state.database_path)?;
    provider_status_inner(&state, &connection)
}

fn store_credential(
    state: &AppState,
    secret: String,
    replace: bool,
) -> Result<ProviderStatus, String> {
    validate_credential(&secret)?;
    let prior = state.credential_store.get()?;
    let present = prior.is_some();
    if present && !replace {
        return Err(
            "A provider credential is already configured. Use replace instead.".to_string(),
        );
    }
    if !present && replace {
        return Err("No provider credential exists to replace.".to_string());
    }
    state.credential_store.set(&secret)?;
    let connection = match open_connection(&state.database_path) {
        Ok(value) => value,
        Err(error) => {
            match prior.as_deref() {
                Some(value) => state.credential_store.set(value)?,
                None => state.credential_store.remove()?,
            }
            return Err(error);
        }
    };
    if connection
        .execute(
            "UPDATE provider_state SET paid_calls_enabled=0,last_validated_at=NULL,
             cost_ceiling_cents=0,cost_per_call_cents=0,spent_cents=0 WHERE provider=?1",
            params![PROVIDER_ID],
        )
        .is_err()
    {
        match prior.as_deref() {
            Some(value) => state.credential_store.set(value)?,
            None => state.credential_store.remove()?,
        }
        return Err("Provider state could not be reset after credential change.".to_string());
    }
    clear_search_candidates(state);
    provider_status_inner(state, &connection)
}

#[tauri::command]
fn configure_provider_credential(
    state: State<'_, AppState>,
    secret: String,
) -> Result<ProviderStatus, String> {
    let _gate = lock_mutation_gate(&state)?;
    store_credential(&state, secret, false)
}

#[tauri::command]
fn replace_provider_credential(
    state: State<'_, AppState>,
    secret: String,
) -> Result<ProviderStatus, String> {
    let _gate = lock_mutation_gate(&state)?;
    store_credential(&state, secret, true)
}

fn validate_provider_account_payload(body: &[u8]) -> Result<(), String> {
    let payload: Value = serde_json::from_slice(body)
        .map_err(|_| "The provider account response was invalid.".to_string())?;
    let account_id = payload
        .get("account_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let status = payload
        .get("account_status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if account_id.is_empty()
        || account_id.len() > MAX_IDENTIFIER_BYTES
        || !status.eq_ignore_ascii_case("active")
    {
        return Err("The provider account is not active or recognised.".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn validate_provider_credential(
    state: State<'_, AppState>,
) -> Result<ProviderStatus, String> {
    let secret = state
        .credential_store
        .get()?
        .ok_or_else(|| "No provider credential is configured.".to_string())?;
    validate_credential(&secret)?;
    let client = reqwest::Client::builder()
        .redirect(redirect::Policy::none())
        .https_only(true)
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .user_agent(format!("SWL-Pricing-Desktop/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "The provider validation client could not be initialised.".to_string())?;
    let endpoint = allowlisted_provider_url(PROVIDER_ACCOUNT_ENDPOINT)?;
    let response = client
        .get(endpoint)
        .query(&[("api_key", secret.as_str())])
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "Provider credential validation timed out.".to_string()
            } else {
                "Provider credential validation could not reach the provider.".to_string()
            }
        })?;
    if response.status().is_redirection() {
        return Err("The provider validation redirect was rejected.".to_string());
    }
    if !response.status().is_success() {
        return Err("The provider rejected the stored credential.".to_string());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROVIDER_RESPONSE_BYTES as u64)
    {
        return Err("The provider account response exceeded the safe size limit.".to_string());
    }
    let mut response = response;
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The provider account response could not be read.".to_string())?
    {
        if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_RESPONSE_BYTES {
            return Err("The provider account response exceeded the safe size limit.".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    validate_provider_account_payload(&body)?;
    let _gate = lock_mutation_gate(&state)?;
    if state.credential_store.get()?.as_deref() != Some(secret.as_str()) {
        return Err("The provider credential changed during validation.".to_string());
    }
    let connection = open_connection(&state.database_path)?;
    connection
        .execute(
            "UPDATE provider_state SET last_validated_at=?1 WHERE provider=?2",
            params![now_text(), PROVIDER_ID],
        )
        .map_err(|_| "Provider validation state could not be saved.".to_string())?;
    provider_status_inner(&state, &connection)
}

#[tauri::command]
fn remove_provider_credential(state: State<'_, AppState>) -> Result<ProviderStatus, String> {
    remove_provider_credential_at(&state)
}

fn remove_provider_credential_at(state: &AppState) -> Result<ProviderStatus, String> {
    let _gate = lock_mutation_gate(state)?;
    let mut connection = open_connection(&state.database_path)?;
    remove_provider_credential_inner(state, &mut connection)
}

fn remove_provider_credential_inner(
    state: &AppState,
    connection: &mut Connection,
) -> Result<ProviderStatus, String> {
    let prior = state.credential_store.get()?;
    let transaction = connection
        .transaction()
        .map_err(|_| "Provider credential removal could not start.".to_string())?;
    transaction
        .execute(
            "UPDATE provider_state SET last_validated_at=NULL,paid_calls_enabled=0,
             cost_ceiling_cents=0,cost_per_call_cents=0,spent_cents=0 WHERE provider=?1",
            params![PROVIDER_ID],
        )
        .map_err(|_| "Provider state could not be cleared.".to_string())?;
    state.credential_store.remove()?;
    if transaction.commit().is_err() {
        if let Some(secret) = prior {
            state.credential_store.set(&secret).map_err(|_| {
                "Provider state failed to commit and the protected credential could not be recovered."
                    .to_string()
            })?;
        }
        return Err("Provider credential removal could not be committed.".to_string());
    }
    clear_search_candidates(state);
    provider_status_inner(state, connection)
}

fn set_provider_paid_calls_inner(
    state: &AppState,
    connection: &Connection,
    enabled: bool,
    cost_ceiling_cents: Option<i64>,
    cost_per_call_cents: Option<i64>,
) -> Result<ProviderStatus, String> {
    if enabled {
        if state.credential_store.get()?.is_none() {
            return Err(
                "A protected provider credential is required before paid calls can be enabled."
                    .to_string(),
            );
        }
        let validated: bool = connection
            .query_row(
                "SELECT last_validated_at IS NOT NULL FROM provider_state WHERE provider=?1",
                params![PROVIDER_ID],
                |row| row.get(0),
            )
            .map_err(|_| "Provider validation state could not be read.".to_string())?;
        if !validated {
            return Err("The protected provider credential must be validated first.".to_string());
        }
        let ceiling = cost_ceiling_cents
            .ok_or_else(|| "A positive provider cost ceiling is required.".to_string())?;
        let per_call = cost_per_call_cents
            .ok_or_else(|| "A positive maximum cost per call is required.".to_string())?;
        validate_cents(ceiling, "Provider cost ceiling")?;
        validate_cents(per_call, "Provider per-call cost")?;
        if ceiling == 0 || per_call == 0 || per_call > ceiling {
            return Err("The provider cost budget is invalid.".to_string());
        }
        connection
            .execute(
                "UPDATE provider_state SET paid_calls_enabled=1,cost_ceiling_cents=?1,
                 cost_per_call_cents=?2,spent_cents=0 WHERE provider=?3",
                params![ceiling, per_call, PROVIDER_ID],
            )
            .map_err(|_| "Provider call policy could not be saved.".to_string())?;
    } else {
        connection
            .execute(
                "UPDATE provider_state SET paid_calls_enabled=0 WHERE provider=?1",
                params![PROVIDER_ID],
            )
            .map_err(|_| "Provider call policy could not be saved.".to_string())?;
    }
    clear_search_candidates(state);
    provider_status_inner(state, connection)
}

#[tauri::command]
fn set_provider_paid_calls(
    state: State<'_, AppState>,
    enabled: bool,
    cost_ceiling_cents: Option<i64>,
    cost_per_call_cents: Option<i64>,
) -> Result<ProviderStatus, String> {
    let _gate = lock_mutation_gate(&state)?;
    let connection = open_connection(&state.database_path)?;
    set_provider_paid_calls_inner(
        &state,
        &connection,
        enabled,
        cost_ceiling_cents,
        cost_per_call_cents,
    )
}

fn reserve_provider_call(connection: &Connection) -> Result<(), String> {
    let updated = connection
        .execute(
            "UPDATE provider_state SET spent_cents=spent_cents+cost_per_call_cents
             WHERE provider=?1 AND paid_calls_enabled=1 AND last_validated_at IS NOT NULL
             AND cost_per_call_cents>0 AND cost_ceiling_cents>0
             AND spent_cents<=cost_ceiling_cents-cost_per_call_cents",
            params![PROVIDER_ID],
        )
        .map_err(|_| "Provider call budget could not be reserved.".to_string())?;
    if updated != 1 {
        return Err("quota_exhausted".to_string());
    }
    Ok(())
}

fn authorise_provider_search(
    state: &AppState,
) -> Result<(String, ProviderSearchLease<'_>), String> {
    // Serialise the policy/credential snapshot and pessimistic reservation with
    // every destructive mutation. The database handle is deliberately dropped
    // before the lease is returned and therefore never crosses the HTTPS await.
    let _gate = safe_lock(&state.mutation_gate)?;
    let connection = open_connection(&state.database_path)?;
    let paid_calls_enabled = connection
        .query_row(
            "SELECT paid_calls_enabled FROM provider_state WHERE provider=?1",
            params![PROVIDER_ID],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|_| "Provider state could not be read.".to_string())?;
    if !paid_calls_enabled {
        return Err("not_configured".to_string());
    }
    let credential = state
        .credential_store
        .get()?
        .ok_or_else(|| "not_configured".to_string())?;
    validate_credential(&credential)?;
    allow_search_call(state)?;
    reserve_provider_call(&connection)?;
    drop(connection);
    state
        .in_flight_provider_searches
        .fetch_add(1, Ordering::AcqRel);
    Ok((
        credential,
        ProviderSearchLease {
            in_flight: &state.in_flight_provider_searches,
        },
    ))
}

fn query_kind(query: &str) -> String {
    if query.is_empty() {
        "empty".to_string()
    } else if query.chars().all(|character| character.is_ascii_digit())
        && matches!(query.len(), 8 | 12..=14)
    {
        "barcode".to_string()
    } else if !query.contains(char::is_whitespace)
        && query.chars().any(|character| character.is_ascii_digit())
        && query
            .chars()
            .any(|character| character.is_ascii_alphanumeric())
    {
        "identifier".to_string()
    } else {
        "free-text".to_string()
    }
}

fn normalise_search_query(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn empty_search(state: &str, query: &str, provider: &str, detail: &str) -> SearchOutcome {
    SearchOutcome {
        state: state.to_string(),
        query: query.to_string(),
        query_kind: query_kind(query),
        provider: provider.to_string(),
        candidates: Vec::new(),
        selected_product: None,
        results: Vec::new(),
        band: None,
        retrieved_at: None,
        cached: Some(false),
        detail: Some(detail.to_string()),
        coverage: None,
    }
}

fn search_band(results: &[SearchResult]) -> Option<SearchBand> {
    let mut values = results
        .iter()
        .filter(|result| result.comparison_eligible)
        .filter_map(|result| result.comparison_price_cents)
        .collect::<Vec<_>>();
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let median = if values.len() % 2 == 1 {
        values[values.len() / 2]
    } else {
        let left = values[values.len() / 2 - 1];
        let right = values[values.len() / 2];
        // Half-up to the nearest cent without binary floating point.
        left + (right - left + 1) / 2
    };
    Some(SearchBand {
        lowest: money_string(values[0]),
        median: money_string(median),
        highest: money_string(*values.last()?),
        lowest_cents: values[0],
        median_cents: median,
        highest_cents: *values.last()?,
        priced_results: values.len(),
    })
}

fn parse_aud_cents(value: &str) -> Option<i64> {
    let trimmed = value
        .trim()
        .strip_prefix('+')
        .unwrap_or(value.trim())
        .trim();
    let uppercase = trimmed.to_ascii_uppercase();
    let numeric = if uppercase.starts_with("AUD") || uppercase.starts_with("AU$") {
        &trimmed[3..]
    } else if uppercase.starts_with("A$") {
        &trimmed[2..]
    } else if uppercase.starts_with('$') {
        &trimmed[1..]
    } else if trimmed.as_bytes().first().is_some_and(u8::is_ascii_digit) {
        trimmed
    } else {
        return None;
    };
    let cleaned = numeric.replace(['$', ',', ' '], "").trim().to_string();
    if cleaned.is_empty() || cleaned.starts_with('-') {
        return None;
    }
    let mut parts = cleaned.split('.');
    let whole = parts.next()?.parse::<i64>().ok()?;
    let decimal = parts.next().unwrap_or("");
    if parts.next().is_some() || !decimal.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    let first = decimal.as_bytes().first().copied().unwrap_or(b'0') - b'0';
    let second = decimal.as_bytes().get(1).copied().unwrap_or(b'0') - b'0';
    let round_up = decimal.as_bytes().get(2).copied().unwrap_or(b'0') >= b'5';
    let fractional = i64::from(first) * 10 + i64::from(second) + i64::from(round_up);
    let cents = whole.checked_mul(100)?.checked_add(fractional)?;
    (cents <= 1_000_000_000).then_some(cents)
}

fn allow_search_call(state: &AppState) -> Result<(), String> {
    let mut limiter = safe_lock(&state.search_limiter)?;
    if limiter.window_started.elapsed() >= Duration::from_secs(60) {
        limiter.window_started = Instant::now();
        limiter.calls = 0;
    }
    if limiter.calls >= MAX_PROVIDER_CALLS_PER_MINUTE {
        return Err("rate_limited".to_string());
    }
    limiter.calls += 1;
    Ok(())
}

fn allowlisted_provider_url(value: &str) -> Result<Url, String> {
    let url =
        Url::parse(value).map_err(|_| "The native provider endpoint is invalid.".to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some(PROVIDER_HOST)
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "/search.json" | "/account.json")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("The native provider endpoint is not allowlisted.".to_string());
    }
    Ok(url)
}

fn provider_payload_error_state(payload: &Value) -> Option<&'static str> {
    let message = payload.get("error")?.as_str()?.to_ascii_lowercase();
    if message.contains("quota")
        || message.contains("run out of searches")
        || message.contains("no searches left")
        || message.contains("credit")
    {
        Some("quota_exhausted")
    } else {
        Some("provider_error")
    }
}

#[derive(Debug, Clone)]
struct ProviderMetadata {
    observed_at: Option<String>,
    cache_allowed: bool,
    stores_may_continue: bool,
}

fn provider_timestamp(value: &str) -> Option<String> {
    if value.len() != 23 || !value.is_ascii() || !value.ends_with(" UTC") {
        return None;
    }
    let bytes = value.as_bytes();
    if bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b' ')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
        || bytes.get(19) != Some(&b' ')
    {
        return None;
    }
    let timestamp = format!("{}T{}Z", &value[..10], &value[11..19]);
    validate_timestamp(&timestamp).ok().map(|_| timestamp)
}

fn provider_metadata(
    payload: &Value,
    stores_may_continue: bool,
) -> Result<ProviderMetadata, String> {
    let metadata = payload
        .get("search_metadata")
        .and_then(Value::as_object)
        .ok_or_else(|| "The provider metadata was invalid.".to_string())?;
    if metadata.get("status").and_then(Value::as_str) != Some("Success") {
        return Err("The provider search did not complete.".to_string());
    }
    let observed_at = metadata
        .get("processed_at")
        .and_then(Value::as_str)
        .and_then(provider_timestamp)
        .or_else(|| {
            metadata
                .get("created_at")
                .and_then(Value::as_str)
                .and_then(provider_timestamp)
        });
    let cache_allowed = payload
        .get("search_parameters")
        .and_then(Value::as_object)
        .and_then(|parameters| parameters.get("no_cache"))
        .and_then(Value::as_bool)
        != Some(true);
    Ok(ProviderMetadata {
        observed_at,
        cache_allowed,
        stores_may_continue,
    })
}

fn normalise_au_location(value: Option<&str>) -> Option<String> {
    let value = value.unwrap_or(DEFAULT_PROVIDER_LOCATION);
    if validate_text(value, "Provider location", 256, false).is_err() {
        return None;
    }
    let parts = value.split(',').map(str::trim).collect::<Vec<_>>();
    if parts.len() < 3
        || parts.iter().any(|part| part.is_empty())
        || !parts
            .last()
            .is_some_and(|country| country.eq_ignore_ascii_case("Australia"))
    {
        return None;
    }
    Some(parts.join(", "))
}

fn configured_provider_location() -> Result<String, String> {
    let configured = std::env::var("SERPAPI_LOCATION").ok();
    normalise_au_location(configured.as_deref()).ok_or_else(|| {
        "SERPAPI_LOCATION must be a bounded city, state, Australia value.".to_string()
    })
}

fn provider_query(query: &str) -> String {
    if matches!(query_kind(query).as_str(), "identifier" | "barcode") {
        format!("\"{query}\"")
    } else {
        query.to_string()
    }
}

fn provider_request_parameters(
    query: &str,
    candidate_token: Option<&str>,
    credential: &str,
    location: &str,
) -> Result<Vec<(String, String)>, String> {
    validate_text(credential, "Provider credential", 1_024, false)?;
    if let Some(token) = candidate_token {
        validate_text(token, "Candidate token", MAX_CANDIDATE_TOKEN_BYTES, false)?;
        return Ok(vec![
            ("engine".to_string(), "google_immersive_product".to_string()),
            ("page_token".to_string(), token.to_string()),
            ("more_stores".to_string(), "true".to_string()),
            ("api_key".to_string(), credential.to_string()),
        ]);
    }
    let location = normalise_au_location(Some(location))
        .ok_or_else(|| "The provider location is invalid.".to_string())?;
    Ok(vec![
        ("engine".to_string(), "google_shopping".to_string()),
        ("q".to_string(), provider_query(query)),
        ("google_domain".to_string(), "google.com.au".to_string()),
        ("gl".to_string(), "au".to_string()),
        ("hl".to_string(), "en".to_string()),
        ("device".to_string(), "desktop".to_string()),
        ("location".to_string(), location),
        ("api_key".to_string(), credential.to_string()),
    ])
}

fn numeric_amount_to_cents(value: Option<&Value>) -> Option<i64> {
    let amount = value?.as_f64()?;
    if !amount.is_finite() || amount < 0.0 {
        return None;
    }
    parse_aud_cents(&format!("{amount:.2}"))
}

fn component_to_cents(
    object: &serde_json::Map<String, Value>,
    extracted_key: &str,
    text_key: &str,
    allow_free: bool,
) -> Result<Option<i64>, ()> {
    let extracted_value = object.get(extracted_key).filter(|value| !value.is_null());
    let text_value = object.get(text_key).filter(|value| !value.is_null());
    let extracted_cents = numeric_amount_to_cents(extracted_value);
    let text_cents = text_value.and_then(|value| {
        let text = value.as_str()?.trim();
        if allow_free
            && matches!(
                text.to_ascii_lowercase().as_str(),
                "free" | "free delivery" | "free shipping"
            )
        {
            Some(0)
        } else {
            parse_aud_cents(text)
        }
    });
    if extracted_value.is_some() && text_value.is_some() {
        return match (extracted_cents, text_cents) {
            (Some(extracted), Some(text)) if extracted == text => Ok(Some(extracted)),
            _ => Err(()),
        };
    }
    Ok(extracted_cents.or(text_cents))
}

fn bounded_provider_text(value: Option<&Value>, maximum: usize) -> Option<&str> {
    let text = value?.as_str()?;
    (validate_text(text, "Provider value", maximum, false).is_ok()).then_some(text)
}

fn pack_size_from_title(title: &str) -> Option<String> {
    let words = title
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    for window in words.windows(3) {
        if matches!(
            window[0].as_str(),
            "pack" | "box" | "carton" | "bag" | "set"
        ) && window[1] == "of"
            && window[2]
                .parse::<u16>()
                .is_ok_and(|count| (1..=9_999).contains(&count))
        {
            return Some(format!("pack of {}", window[2]));
        }
    }
    for window in words.windows(2) {
        if window[0]
            .parse::<u16>()
            .is_ok_and(|count| (1..=9_999).contains(&count))
            && matches!(window[1].as_str(), "pack" | "pk")
        {
            return Some(format!("pack of {}", window[0]));
        }
    }
    None
}

fn normalised_words(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn condition_from_text(value: &str) -> &'static str {
    let words = normalised_words(value);
    let padded = format!(" {words} ");
    if [" used ", " refurbished ", " pre owned ", " second hand "]
        .iter()
        .any(|term| padded.contains(term))
    {
        "used"
    } else if padded.contains(" new ") {
        "new"
    } else {
        "unknown"
    }
}

fn normalise_https_url(value: &str) -> Option<Url> {
    if validate_text(value, "Provider URL", 2_048, false).is_err() {
        return None;
    }
    let url = Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}

fn is_host_or_subdomain(host: &str, parent: &str) -> bool {
    let host = host.trim_end_matches('.');
    host.eq_ignore_ascii_case(parent) || host.to_ascii_lowercase().ends_with(&format!(".{parent}"))
}

fn google_product_url(value: &str) -> Option<String> {
    let mut url = normalise_https_url(value)?;
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    if !is_host_or_subdomain(&host, "google.com") && !is_host_or_subdomain(&host, "google.com.au") {
        return None;
    }
    url.set_host(Some(&host)).ok()?;
    Some(url.to_string())
}

fn direct_merchant_url(value: &str) -> Option<(String, String)> {
    let mut url = normalise_https_url(value)?;
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    if [
        "serpapi.com",
        "google.com",
        "google.com.au",
        "googleadservices.com",
    ]
    .iter()
    .any(|parent| is_host_or_subdomain(&host, parent))
    {
        return None;
    }
    url.set_host(Some(&host)).ok()?;
    url.set_fragment(None);
    Some((url.to_string(), host))
}

fn currency_basis(value: &str) -> Option<&'static str> {
    let trimmed = value.trim().to_ascii_uppercase();
    if trimmed.starts_with("AUD") || trimmed.starts_with("AU$") || trimmed.starts_with("A$") {
        Some("explicit-aud")
    } else if trimmed.starts_with('$') {
        Some("inferred-au-localisation")
    } else {
        None
    }
}

fn checked_provider_array<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a [Value], String> {
    let Some(value) = object.get(key) else {
        return Ok(&[]);
    };
    let array = value
        .as_array()
        .ok_or_else(|| "The provider result collection was invalid.".to_string())?;
    if array.len() > MAX_PROVIDER_ITEMS {
        return Err("The provider result count exceeded the safe limit.".to_string());
    }
    Ok(array)
}

fn shopping_rows(payload: &Value) -> Result<Vec<&Value>, String> {
    let body = payload
        .as_object()
        .ok_or_else(|| "The provider response shape was invalid.".to_string())?;
    let mut rows = Vec::new();
    rows.extend(checked_provider_array(body, "shopping_results")?);
    rows.extend(checked_provider_array(body, "inline_shopping_results")?);
    for category in checked_provider_array(body, "categorized_shopping_results")? {
        let category = category
            .as_object()
            .ok_or_else(|| "The categorised provider results were invalid.".to_string())?;
        rows.extend(checked_provider_array(category, "shopping_results")?);
        if rows.len() > MAX_PROVIDER_ITEMS {
            return Err("The provider result count exceeded the safe limit.".to_string());
        }
    }
    if rows.len() > MAX_PROVIDER_ITEMS {
        return Err("The provider result count exceeded the safe limit.".to_string());
    }
    Ok(rows)
}

fn normalise_candidate(value: &Value) -> Option<ProductCandidate> {
    let item = value.as_object()?;
    let title = bounded_provider_text(item.get("title"), 1_000)?;
    let token = bounded_provider_text(
        item.get("immersive_product_page_token"),
        MAX_CANDIDATE_TOKEN_BYTES,
    )?;
    let product_url = google_product_url(bounded_provider_text(item.get("product_link"), 2_048)?)?;
    let position = item.get("position")?.as_i64()?;
    if !(0..=10_000).contains(&position) {
        return None;
    }
    let displayed_price = bounded_provider_text(item.get("price"), 64).map(str::to_string);
    let price_cents = component_to_cents(item, "extracted_price", "price", false)
        .ok()
        .flatten();
    let condition = if bounded_provider_text(item.get("second_hand_condition"), 256).is_some() {
        "used"
    } else {
        condition_from_text(title)
    };
    Some(ProductCandidate {
        token: token.to_string(),
        title: title.to_string(),
        brand: bounded_provider_text(item.get("brand"), 256).map(str::to_string),
        product_id: bounded_provider_text(item.get("product_id"), 256).map(str::to_string),
        product_url,
        displayed_price,
        price_cents,
        multiple_sources: item.get("multiple_sources").and_then(Value::as_bool) == Some(true),
        pack_size: pack_size_from_title(title),
        condition: condition.to_string(),
        position,
    })
}

fn provider_detail(metadata: &ProviderMetadata, prefix: &str) -> String {
    let mut notes = Vec::new();
    if !prefix.is_empty() {
        notes.push(prefix.to_string());
    }
    if metadata.stores_may_continue {
        notes.push(
            "SerpAPI reports additional store pages beyond this bounded response.".to_string(),
        );
    }
    if metadata.cache_allowed {
        notes.push(
            "SerpAPI may serve an identical request from its provider cache for up to one hour."
                .to_string(),
        );
    }
    notes.join(" ")
}

fn validate_discovery_response_parameters(
    payload: &Value,
    expected_location: &str,
    expected_query: &str,
) -> Result<(), String> {
    let parameters = payload
        .get("search_parameters")
        .and_then(Value::as_object)
        .ok_or_else(|| "The shopping response parameters were invalid.".to_string())?;
    if parameters.get("engine").and_then(Value::as_str) != Some("google_shopping") {
        return Err("The shopping response engine was invalid.".to_string());
    }
    for (key, expected) in [
        ("google_domain", "google.com.au"),
        ("gl", "au"),
        ("hl", "en"),
        ("device", "desktop"),
        ("location", expected_location),
    ] {
        if parameters.contains_key(key)
            && parameters.get(key).and_then(Value::as_str) != Some(expected)
        {
            return Err("The shopping response localisation was invalid.".to_string());
        }
    }
    if let Some(echoed_query) = parameters.get("q") {
        let echoed_query = echoed_query
            .as_str()
            .ok_or_else(|| "The shopping response query was invalid.".to_string())?;
        let canonical = |value: &str| {
            value
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()
        };
        if canonical(echoed_query) != canonical(expected_query) {
            return Err("The shopping response query was invalid.".to_string());
        }
    }
    Ok(())
}

fn validate_offer_response_parameters(payload: &Value, token: &str) -> Result<(), String> {
    let parameters = payload
        .get("search_parameters")
        .and_then(Value::as_object)
        .ok_or_else(|| "The immersive response parameters were invalid.".to_string())?;
    if parameters.get("engine").and_then(Value::as_str) != Some("google_immersive_product")
        || parameters.get("page_token").and_then(Value::as_str) != Some(token)
    {
        return Err("The immersive response selection was invalid.".to_string());
    }
    Ok(())
}

fn parse_shopping_discovery(
    payload: &Value,
    query: &str,
    expected_location: &str,
) -> Result<SearchOutcome, String> {
    validate_discovery_response_parameters(payload, expected_location, &provider_query(query))?;
    let metadata = provider_metadata(payload, false)?;
    let retrieved_at = metadata.observed_at.clone().unwrap_or_else(now_text);
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for row in shopping_rows(payload)? {
        let Some(candidate) = normalise_candidate(row) else {
            continue;
        };
        if seen.insert(candidate.token.clone()) {
            candidates.push(candidate);
        }
    }
    let state = if candidates.is_empty() {
        "empty"
    } else {
        "selection_required"
    };
    let prefix = if candidates.is_empty() {
        "No selectable product cluster was returned by this bounded search; this does not establish that the product is unavailable."
    } else {
        "Choose the exact product candidate before comparing merchant offers. This candidate list is bounded and is not exhaustive."
    };
    Ok(SearchOutcome {
        state: state.to_string(),
        query: query.to_string(),
        query_kind: query_kind(query),
        provider: PROVIDER_ID.to_string(),
        coverage: Some(SearchCoverage {
            provider_queried: PROVIDER_ID.to_string(),
            sources_with_price: 0,
            source_domains: Vec::new(),
            priced_results: 0,
            provider_candidates: candidates.len(),
            parsed_offers: 0,
            comparable_offers: 0,
            excluded_offers: 0,
        }),
        candidates,
        selected_product: None,
        results: Vec::new(),
        band: None,
        retrieved_at: Some(retrieved_at),
        cached: Some(false),
        detail: Some(provider_detail(&metadata, prefix)),
    })
}

fn bounded_offer_details(store: &serde_json::Map<String, Value>) -> Option<Vec<String>> {
    let Some(value) = store.get("details_and_offers") else {
        return Some(Vec::new());
    };
    let details = value.as_array()?;
    if details.len() > 50 {
        return None;
    }
    details
        .iter()
        .map(|detail| bounded_provider_text(Some(detail), 512).map(str::to_string))
        .collect()
}

fn offer_condition(
    store: &serde_json::Map<String, Value>,
    candidate: Option<&ProductCandidate>,
    details: &[String],
) -> String {
    if candidate.is_some_and(|candidate| candidate.condition == "used") {
        return "used".to_string();
    }
    for key in ["condition", "second_hand_condition"] {
        if let Some(value) = bounded_provider_text(store.get(key), 256) {
            let condition = condition_from_text(value);
            if condition != "unknown" {
                return condition.to_string();
            }
        }
    }
    let title = bounded_provider_text(store.get("title"), 1_000).unwrap_or_default();
    condition_from_text(&format!("{title} {}", details.join(" "))).to_string()
}

fn offer_availability(store: &serde_json::Map<String, Value>, details: &[String]) -> String {
    let explicit = bounded_provider_text(store.get("availability"), 256).unwrap_or_default();
    let combined = normalised_words(&format!("{explicit} {}", details.join(" ")));
    if ["out of stock", "sold out", "unavailable"]
        .iter()
        .any(|term| combined.contains(term))
    {
        "out-of-stock".to_string()
    } else if ["in stock", "available online"]
        .iter()
        .any(|term| combined.contains(term))
    {
        "in-stock".to_string()
    } else {
        "unknown".to_string()
    }
}

fn offer_is_financing(store: &serde_json::Map<String, Value>) -> bool {
    store
        .get("monthly_payment_duration")
        .and_then(Value::as_i64)
        .is_some_and(|months| (1..=1_200).contains(&months))
        || bounded_provider_text(store.get("installments_description"), 512).is_some()
        || bounded_provider_text(store.get("down_payment"), 64).is_some()
}

fn normalise_offer(
    value: &Value,
    candidate: Option<&ProductCandidate>,
    retrieved_at: &str,
) -> Option<SearchResult> {
    let store = value.as_object()?;
    let seller = bounded_provider_text(store.get("name"), 512)?;
    let title = bounded_provider_text(store.get("title"), 1_000)?;
    let (url, source_domain) =
        direct_merchant_url(bounded_provider_text(store.get("link"), 2_048)?)?;
    let original_price_text = bounded_provider_text(store.get("price"), 64)?;
    let currency_basis = currency_basis(original_price_text)?;
    let item_price_cents = component_to_cents(store, "extracted_price", "price", false)
        .ok()
        .flatten()?;
    let details = bounded_offer_details(store)?;
    let shipping_cents = component_to_cents(store, "shipping_extracted", "shipping", true).ok()?;
    let estimated_tax_cents =
        component_to_cents(store, "extracted_estimated_tax", "estimated_tax", false).ok()?;
    let total_price_cents = component_to_cents(store, "extracted_total", "total", false).ok()?;
    let condition = offer_condition(store, candidate, &details);
    let availability = offer_availability(store, &details);
    let financing = offer_is_financing(store);
    let pack_size = pack_size_from_title(title);
    let pack_mismatch = candidate.is_some_and(|selected| {
        (selected.pack_size.is_some() || pack_size.is_some())
            && selected.pack_size.as_deref() != pack_size.as_deref()
    });
    let mut exclusion_reasons = Vec::new();
    let mut proposed_comparison = None;
    let mut proposed_basis = "not_comparable";
    if let Some(total) = total_price_cents {
        proposed_comparison = Some(total);
        proposed_basis = "provider_total";
    } else if !financing
        && shipping_cents.is_some()
        && matches!(estimated_tax_cents, None | Some(0))
    {
        proposed_comparison = item_price_cents
            .checked_add(shipping_cents?)
            .filter(|total| *total <= 1_000_000_000);
        if proposed_comparison.is_some() {
            proposed_basis = "item_plus_shipping";
        }
    }
    if financing && total_price_cents.is_none() {
        exclusion_reasons.push("financing_without_full_total".to_string());
    }
    if condition == "used" {
        exclusion_reasons.push("used_or_second_hand".to_string());
    }
    if pack_mismatch {
        exclusion_reasons.push("pack_mismatch".to_string());
    }
    if availability == "out-of-stock" {
        exclusion_reasons.push("out_of_stock".to_string());
    }
    if proposed_comparison.is_none() {
        exclusion_reasons.push("unknown_comparison_total".to_string());
    }
    let comparison_eligible = exclusion_reasons.is_empty();
    let comparison_price_cents = comparison_eligible.then_some(proposed_comparison).flatten();
    let price_basis = if comparison_eligible {
        proposed_basis
    } else {
        "not_comparable"
    };
    Some(SearchResult {
        search_query: None,
        selected_product_title: None,
        selected_product_brand: None,
        selected_product_id: None,
        title: title.to_string(),
        price_cents: item_price_cents,
        price_aud: money_string(item_price_cents),
        item_price_cents,
        item_price_aud: money_string(item_price_cents),
        shipping_cents,
        shipping_aud: shipping_cents.map(money_string),
        estimated_tax_cents,
        estimated_tax_aud: estimated_tax_cents.map(money_string),
        total_price_cents,
        total_price_aud: total_price_cents.map(money_string),
        comparison_price_cents,
        comparison_price_aud: comparison_price_cents.map(money_string),
        price_basis: price_basis.to_string(),
        original_price_text: original_price_text.to_string(),
        currency_basis: currency_basis.to_string(),
        currency: "AUD".to_string(),
        gst_basis: "unknown".to_string(),
        pack_size,
        condition,
        availability,
        financing,
        comparison_eligible,
        exclusion_reasons,
        seller: seller.to_string(),
        source_domain,
        url,
        retrieved_at: retrieved_at.to_string(),
    })
}

fn canonical_offer_url(value: &str) -> String {
    let Ok(mut parsed) = Url::parse(value) else {
        return value.to_string();
    };
    let mut retained = parsed
        .query_pairs()
        .filter(|(key, _)| {
            let lower = key.to_ascii_lowercase();
            !lower.starts_with("utm_")
                && !matches!(
                    lower.as_str(),
                    "dclid" | "fbclid" | "gclid" | "msclkid" | "_ga"
                )
        })
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    retained.sort();
    {
        let mut query = parsed.query_pairs_mut();
        query.clear();
        query.extend_pairs(retained.iter().map(|(key, value)| (key, value)));
    }
    if retained.is_empty() {
        parsed.set_query(None);
    }
    parsed.set_fragment(None);
    parsed.to_string()
}

fn offer_dedupe_key(offer: &SearchResult) -> Result<String, String> {
    let evidence_price_basis = if offer.total_price_cents.is_some() {
        "provider_total"
    } else if !offer.financing
        && offer.shipping_cents.is_some()
        && matches!(offer.estimated_tax_cents, None | Some(0))
        && offer
            .shipping_cents
            .and_then(|shipping| offer.item_price_cents.checked_add(shipping))
            .is_some_and(|total| total <= 1_000_000_000)
    {
        "item_plus_shipping"
    } else {
        "not_comparable"
    };
    serde_json::to_string(&json!([
        offer.source_domain.as_str(),
        canonical_offer_url(&offer.url),
        offer
            .title
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase(),
        offer.pack_size.as_deref(),
        offer.condition.as_str(),
        offer.item_price_cents,
        offer.shipping_cents,
        offer.estimated_tax_cents,
        offer.total_price_cents,
        evidence_price_basis,
    ]))
    .map_err(|_| "The provider offer could not be deduplicated.".to_string())
}

fn parse_immersive_offers(
    payload: &Value,
    query: &str,
    candidate: Option<&ProductCandidate>,
) -> Result<SearchOutcome, String> {
    let candidate =
        candidate.ok_or_else(|| "The selected candidate was unavailable.".to_string())?;
    validate_offer_response_parameters(payload, &candidate.token)?;
    let product = payload
        .get("product_results")
        .and_then(Value::as_object)
        .ok_or_else(|| "The immersive product result was invalid.".to_string())?;
    let stores = checked_provider_array(product, "stores")?;
    let next_page_token = product.get("stores_next_page_token");
    if next_page_token.is_some()
        && bounded_provider_text(next_page_token, MAX_CANDIDATE_TOKEN_BYTES).is_none()
    {
        return Err("The stores continuation token was invalid.".to_string());
    }
    let metadata = provider_metadata(payload, next_page_token.is_some())?;
    let retrieved_at = metadata.observed_at.clone().unwrap_or_else(now_text);
    let title = bounded_provider_text(product.get("title"), 1_000)
        .map(str::to_string)
        .or_else(|| Some(candidate.title.clone()))
        .ok_or_else(|| "The immersive product title was invalid.".to_string())?;
    let selected_product = SelectedProduct {
        title,
        brand: bounded_provider_text(product.get("brand"), 256)
            .map(str::to_string)
            .or_else(|| candidate.brand.clone()),
        product_id: candidate.product_id.clone(),
    };
    let mut results: Vec<SearchResult> = Vec::new();
    let mut exact_offers: HashMap<String, usize> = HashMap::new();
    for store in stores {
        let Some(mut offer) = normalise_offer(store, Some(candidate), &retrieved_at) else {
            continue;
        };
        offer.search_query = Some(query.to_string());
        offer.selected_product_title = Some(selected_product.title.clone());
        offer.selected_product_brand = selected_product.brand.clone();
        offer.selected_product_id = selected_product.product_id.clone();
        let key = offer_dedupe_key(&offer)?;
        if let Some(index) = exact_offers.get(&key).copied() {
            if results[index].comparison_eligible && !offer.comparison_eligible {
                results[index] = offer;
            }
        } else {
            exact_offers.insert(key, results.len());
            results.push(offer);
        }
    }
    let mut seen_domains = HashSet::new();
    let source_domains = results
        .iter()
        .filter(|result| seen_domains.insert(result.source_domain.clone()))
        .map(|result| result.source_domain.clone())
        .collect::<Vec<_>>();
    let comparable_offers = results
        .iter()
        .filter(|result| result.comparison_eligible)
        .count();
    let no_comparable = comparable_offers == 0;
    let detail = provider_detail(
        &metadata,
        if results.is_empty() {
            "No direct merchant offers matching the supported contract were returned. This does not establish that no merchant offers exist."
        } else if no_comparable {
            "Direct merchant offers were found, but none had an eligible comparison total. This bounded result is not exhaustive."
        } else {
            "This comparison covers only the returned direct merchant offers. It is not exhaustive."
        },
    );
    Ok(SearchOutcome {
        state: if no_comparable {
            "no_comparable_offers"
        } else {
            "ok"
        }
        .to_string(),
        query: query.to_string(),
        query_kind: query_kind(query),
        provider: PROVIDER_ID.to_string(),
        candidates: Vec::new(),
        selected_product: Some(selected_product),
        band: search_band(&results),
        retrieved_at: Some(retrieved_at),
        cached: Some(false),
        detail: Some(detail),
        coverage: Some(SearchCoverage {
            provider_queried: PROVIDER_ID.to_string(),
            sources_with_price: source_domains.len(),
            source_domains,
            priced_results: comparable_offers,
            provider_candidates: 0,
            parsed_offers: results.len(),
            comparable_offers,
            excluded_offers: results.len().saturating_sub(comparable_offers),
        }),
        results,
    })
}

fn remember_search_candidates(
    state: &AppState,
    query: &str,
    candidates: &[ProductCandidate],
) -> Result<(), String> {
    remember_search_candidates_at(state, query, candidates, Instant::now())
}

fn remember_search_candidates_at(
    state: &AppState,
    query: &str,
    candidates: &[ProductCandidate],
    issued_at: Instant,
) -> Result<(), String> {
    if candidates.len() > MAX_PROVIDER_ITEMS {
        return Err("Too many provider candidates were returned.".to_string());
    }
    let mut store = safe_lock(&state.search_candidates)?;
    store.entries.retain(|_, remembered| {
        issued_at.saturating_duration_since(remembered.issued_at) <= SEARCH_CANDIDATE_TTL
            && remembered.query != query
    });
    for candidate in candidates {
        store.entries.remove(&candidate.token);
    }
    while store.entries.len().saturating_add(candidates.len()) > MAX_REMEMBERED_CANDIDATES {
        let Some(token) = store
            .entries
            .iter()
            .min_by_key(|(_, remembered)| remembered.sequence)
            .map(|(token, _)| token.clone())
        else {
            break;
        };
        store.entries.remove(&token);
    }
    for candidate in candidates {
        let sequence = store.next_sequence;
        store.next_sequence = store
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| "The candidate sequence was exhausted.".to_string())?;
        store.entries.insert(
            candidate.token.clone(),
            RememberedCandidate {
                query: query.to_string(),
                candidate: candidate.clone(),
                issued_at,
                sequence,
            },
        );
    }
    Ok(())
}

fn remembered_search_candidate(
    state: &AppState,
    query: &str,
    token: &str,
) -> Result<Option<ProductCandidate>, String> {
    remembered_search_candidate_at(state, query, token, Instant::now())
}

fn remembered_search_candidate_at(
    state: &AppState,
    query: &str,
    token: &str,
    now: Instant,
) -> Result<Option<ProductCandidate>, String> {
    let mut store = safe_lock(&state.search_candidates)?;
    store.entries.retain(|_, remembered| {
        now.saturating_duration_since(remembered.issued_at) <= SEARCH_CANDIDATE_TTL
    });
    Ok(store
        .entries
        .get(token)
        .filter(|remembered| remembered.query == query)
        .map(|remembered| remembered.candidate.clone()))
}

fn clear_search_candidates(state: &AppState) {
    if let Ok(mut store) = state.search_candidates.lock() {
        store.entries.clear();
    }
}

fn require_remembered_search_candidate(
    state: &AppState,
    query: &str,
    token: &str,
) -> Result<ProductCandidate, String> {
    remembered_search_candidate(state, query, token)?.ok_or_else(|| "selection_expired".to_string())
}

#[tauri::command]
async fn search_competitors(
    state: State<'_, AppState>,
    query: String,
    candidate_token: Option<String>,
) -> Result<SearchOutcome, String> {
    let query = normalise_search_query(&query);
    if query.is_empty() {
        return Ok(empty_search(
            "invalid_query",
            &query,
            PROVIDER_ID,
            "Enter a product identifier or search term.",
        ));
    }
    if query.len() > MAX_SEARCH_QUERY_BYTES || query.chars().any(char::is_control) {
        return Ok(empty_search(
            "invalid_query",
            &query,
            PROVIDER_ID,
            "The search query is outside the supported range.",
        ));
    }
    let candidate_token = candidate_token.filter(|token| !token.is_empty());
    if candidate_token.as_deref().is_some_and(|token| {
        validate_text(token, "Candidate token", MAX_CANDIDATE_TOKEN_BYTES, false).is_err()
    }) {
        return Ok(empty_search(
            "invalid_query",
            &query,
            PROVIDER_ID,
            "The candidate token is outside the supported range.",
        ));
    }
    let selected_candidate = match candidate_token.as_deref() {
        Some(token) => match require_remembered_search_candidate(&state, &query, token) {
            Ok(candidate) => Some(candidate),
            Err(error) if error == "selection_expired" => {
                return Ok(empty_search(
                    "selection_expired",
                    &query,
                    PROVIDER_ID,
                    "The selected product is no longer trusted for this query. Run discovery again and reselect it.",
                ))
            }
            Err(error) => return Err(error),
        },
        None => None,
    };
    let location = match configured_provider_location() {
        Ok(location) => location,
        Err(_) => {
            return Ok(empty_search(
                "provider_error",
                &query,
                PROVIDER_ID,
                "The configured provider location is invalid.",
            ))
        }
    };
    let (credential, _search_lease) = match authorise_provider_search(&state) {
        Ok(value) => value,
        Err(error) if error == "not_configured" => {
            return Ok(empty_search(
                "not_configured",
                &query,
                PROVIDER_ID,
                "Paid calls require an enabled budget and a protected provider credential.",
            ))
        }
        Err(error) if error == "rate_limited" => {
            return Ok(empty_search(
                "rate_limited",
                &query,
                PROVIDER_ID,
                "The local provider call limit has been reached.",
            ))
        }
        Err(error) if error == "quota_exhausted" => {
            return Ok(empty_search(
                "quota_exhausted",
                &query,
                PROVIDER_ID,
                "The local provider cost ceiling has been reached.",
            ))
        }
        Err(error) => return Err(error),
    };
    let parameters =
        provider_request_parameters(&query, candidate_token.as_deref(), &credential, &location)?;
    let client = reqwest::Client::builder()
        .redirect(redirect::Policy::none())
        .https_only(true)
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .user_agent(format!("SWL-Pricing-Desktop/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "The native search client could not be initialised.".to_string())?;
    let endpoint = allowlisted_provider_url(PROVIDER_ENDPOINT)?;
    let response = match client
        .get(endpoint)
        .header(reqwest::header::ACCEPT, "application/json")
        .query(&parameters)
        .send()
        .await
    {
        Ok(value) => value,
        Err(error) if error.is_timeout() => {
            return Ok(empty_search(
                "timeout",
                &query,
                PROVIDER_ID,
                "The provider request timed out.",
            ))
        }
        Err(_) => {
            return Ok(empty_search(
                "offline",
                &query,
                PROVIDER_ID,
                "The provider could not be reached.",
            ))
        }
    };
    if response.status().is_redirection() {
        return Ok(empty_search(
            "provider_error",
            &query,
            PROVIDER_ID,
            "The provider returned a redirect, which was rejected.",
        ));
    }
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        return Ok(empty_search(
            "rate_limited",
            &query,
            PROVIDER_ID,
            "The provider rate limit has been reached.",
        ));
    }
    if matches!(
        response.status(),
        StatusCode::PAYMENT_REQUIRED | StatusCode::FORBIDDEN
    ) {
        return Ok(empty_search(
            "quota_exhausted",
            &query,
            PROVIDER_ID,
            "The provider quota is unavailable.",
        ));
    }
    if !response.status().is_success() {
        return Ok(empty_search(
            "provider_error",
            &query,
            PROVIDER_ID,
            "The provider returned an error.",
        ));
    }
    if response.url().scheme() != "https"
        || response.url().host_str() != Some(PROVIDER_HOST)
        || response.url().port_or_known_default() != Some(443)
        || response.url().path() != "/search.json"
    {
        return Ok(empty_search(
            "provider_error",
            &query,
            PROVIDER_ID,
            "The provider response escaped the approved endpoint.",
        ));
    }
    let content_type_is_json = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"));
    if !content_type_is_json {
        return Ok(empty_search(
            "provider_error",
            &query,
            PROVIDER_ID,
            "The provider response was not JSON.",
        ));
    }
    if let Some(declared_length) = response.headers().get(reqwest::header::CONTENT_LENGTH) {
        let valid_length = declared_length
            .to_str()
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|length| *length <= MAX_PROVIDER_RESPONSE_BYTES as u64);
        if valid_length.is_none() {
            return Ok(empty_search(
                "provider_error",
                &query,
                PROVIDER_ID,
                "The provider response declared an invalid or excessive size.",
            ));
        }
    }
    let mut response = response;
    let mut body = Vec::new();
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => {
                return Ok(empty_search(
                    "provider_error",
                    &query,
                    PROVIDER_ID,
                    "The provider response could not be read.",
                ))
            }
        };
        if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_RESPONSE_BYTES {
            return Ok(empty_search(
                "provider_error",
                &query,
                PROVIDER_ID,
                "The provider response exceeded the safe size limit.",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let payload: Value = match serde_json::from_slice(&body) {
        Ok(payload) => payload,
        Err(_) => {
            return Ok(empty_search(
                "provider_error",
                &query,
                PROVIDER_ID,
                "The provider response was invalid.",
            ))
        }
    };
    if let Some(state) = provider_payload_error_state(&payload) {
        let detail = if state == "quota_exhausted" {
            "The provider quota is unavailable."
        } else {
            "The provider returned an error."
        };
        return Ok(empty_search(state, &query, PROVIDER_ID, detail));
    }
    let outcome = match candidate_token.as_deref() {
        Some(_) => parse_immersive_offers(&payload, &query, selected_candidate.as_ref()),
        None => parse_shopping_discovery(&payload, &query, &location),
    };
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(_) => {
            return Ok(empty_search(
                "provider_error",
                &query,
                PROVIDER_ID,
                "The provider response did not match the supported contract.",
            ))
        }
    };
    if candidate_token.is_none() {
        remember_search_candidates(&state, &query, &outcome.candidates)?;
    }
    Ok(outcome)
}

fn sanitise_filename(requested: &str) -> String {
    let base = requested
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .trim();
    let mut cleaned: String = base
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
            value if (value as u32) < 0x20 => '_',
            value => value,
        })
        .collect();
    while cleaned.ends_with('.') || cleaned.ends_with(' ') {
        cleaned.pop();
    }
    let mut utf16_units = 0;
    cleaned = cleaned
        .chars()
        .take_while(|character| {
            let width = character.len_utf16();
            if utf16_units + width > 180 {
                false
            } else {
                utf16_units += width;
                true
            }
        })
        .collect();
    let stem = cleaned.split('.').next().unwrap_or_default().to_uppercase();
    if cleaned.is_empty() || WINDOWS_RESERVED.contains(&stem.as_str()) {
        return format!("swl-output-{cleaned}");
    }
    cleaned
}

fn validate_export_filename(filename: &str) -> Result<(), String> {
    validate_dated_filename(filename, &["xlsx", "txt"])
}

fn validate_configuration_export_filename(filename: &str) -> Result<(), String> {
    validate_dated_filename(filename, &["json"])
}

fn validate_dated_filename(filename: &str, allowed_extensions: &[&str]) -> Result<(), String> {
    validate_text(filename, "Output filename", 720, false)?;
    if filename != sanitise_filename(filename)
        || filename.contains(['/', '\\'])
        || filename == "."
        || filename == ".."
    {
        return Err("The output filename is not a safe Windows basename.".to_string());
    }
    let prefix = filename.as_bytes();
    if prefix.len() < 10
        || !prefix[..8].iter().all(u8::is_ascii_digit)
        || prefix.get(8) != Some(&b'-')
    {
        return Err("The output filename must use the YYYYMMDD- prefix.".to_string());
    }
    let year = filename[0..4].parse::<u32>().unwrap_or_default();
    let month = filename[4..6].parse::<u32>().unwrap_or_default();
    let day = filename[6..8].parse::<u32>().unwrap_or_default();
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let maximum_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if year < 2000 || day == 0 || day > maximum_day {
        return Err("The output filename date prefix is invalid.".to_string());
    }
    let extension = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !allowed_extensions.contains(&extension.as_str()) {
        return Err("The output file extension is not supported.".to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn reject_windows_device_path(path: &Path) -> Result<(), String> {
    let raw = path.as_os_str().to_string_lossy();
    if raw.starts_with("\\\\") || raw.starts_with("//") {
        return Err("UNC, device and verbatim output paths are not permitted.".to_string());
    }
    #[cfg(windows)]
    {
        use std::path::Prefix;
        match path.components().next() {
            Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)) => {}
            _ => return Err("UNC, device and verbatim output paths are not permitted.".to_string()),
        }
    }
    Ok(())
}

fn reject_link_components(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::Prefix(_) | Component::RootDir) {
            continue;
        }
        let metadata = fs::symlink_metadata(&current)
            .map_err(|_| "The selected path could not be verified.".to_string())?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err("Links, junctions and reparse points are not permitted.".to_string());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn has_trusted_windows_disk_prefix(path: &Path) -> bool {
    use std::path::Prefix;
    matches!(
        path.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
    )
}

fn revalidate_trusted_output_directory(path: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    if !has_trusted_windows_disk_prefix(path) {
        return Err("UNC, device and verbatim output paths are not permitted.".to_string());
    }
    #[cfg(not(windows))]
    reject_windows_device_path(path)?;
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("The selected output folder is invalid.".to_string());
    }
    reject_link_components(path)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "The selected output folder could not be verified.".to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err("The selected output path is not a safe folder.".to_string());
    }
    Ok(path.to_path_buf())
}

fn validate_output_directory(path: &Path) -> Result<PathBuf, String> {
    reject_windows_device_path(path)?;
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("The selected output folder is invalid.".to_string());
    }
    reject_link_components(path)?;
    let canonical = fs::canonicalize(path)
        .map_err(|_| "The selected output folder could not be resolved.".to_string())?;
    // Rust canonicalises an ordinary Windows drive path to a trusted
    // VerbatimDisk representation. Keep the untrusted boundary above strict,
    // then revalidate only that private canonical result for later grants.
    revalidate_trusted_output_directory(&canonical)
}

#[cfg(windows)]
fn directory_identity_from_lease(lease: &DirectoryLease) -> Result<DirectoryIdentity, String> {
    #[repr(C)]
    struct FileIdInfo {
        volume_serial_number: u64,
        file_id: [u8; 16],
    }

    #[link(name = "Kernel32")]
    extern "system" {
        #[link_name = "GetFileInformationByHandleEx"]
        fn get_file_information_by_handle_ex(
            handle: *mut std::ffi::c_void,
            information_class: i32,
            information: *mut std::ffi::c_void,
            information_size: u32,
        ) -> i32;
    }

    // FILE_INFO_BY_HANDLE_CLASS::FileIdInfo. This class is supported by the
    // Windows 10/11 target and returns the full 128-bit identifier required
    // for NTFS and ReFS-safe handle identity comparisons.
    const FILE_ID_INFO_CLASS: i32 = 18;
    let mut information = std::mem::MaybeUninit::<FileIdInfo>::zeroed();
    // SAFETY: the lease owns a valid directory handle for this call and the
    // output points to correctly sized, writable FILE_ID_INFO storage. The
    // result is checked before the structure is read.
    let succeeded = unsafe {
        get_file_information_by_handle_ex(
            lease.handle as *mut std::ffi::c_void,
            FILE_ID_INFO_CLASS,
            information.as_mut_ptr().cast(),
            std::mem::size_of::<FileIdInfo>() as u32,
        )
    };
    if succeeded == 0 {
        return Err("The selected output folder identity could not be read.".to_string());
    }
    // SAFETY: GetFileInformationByHandleEx returned success and initialised the
    // complete fixed-size output structure.
    let information = unsafe { information.assume_init() };
    Ok(DirectoryIdentity::Windows {
        volume: information.volume_serial_number,
        file_id: information.file_id,
    })
}

fn directory_identity(path: &Path) -> Result<DirectoryIdentity, String> {
    #[cfg(windows)]
    {
        let lease = open_directory_lease(path)?;
        directory_identity_from_lease(&lease)
    }
    #[cfg(unix)]
    {
        let metadata = fs::metadata(path)
            .map_err(|_| "The selected output folder identity could not be read.".to_string())?;
        use std::os::unix::fs::MetadataExt;
        Ok(DirectoryIdentity::Unix {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
}

#[cfg(windows)]
fn open_directory_lease(path: &Path) -> Result<DirectoryLease, String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    extern "system" {
        #[link_name = "CreateFileW"]
        fn create_file_w(
            name: *const u16,
            desired_access: u32,
            share_mode: u32,
            security: *mut std::ffi::c_void,
            creation: u32,
            flags: u32,
            template: *mut std::ffi::c_void,
        ) -> *mut std::ffi::c_void;
    }
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: the path is null-terminated. Deliberately omitting
    // FILE_SHARE_DELETE prevents rename/substitution for the grant lifetime.
    let handle = unsafe {
        create_file_w(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle as isize == -1 {
        return Err("The selected output folder could not be bound safely.".to_string());
    }
    Ok(DirectoryLease {
        handle: handle as usize,
    })
}

#[cfg(not(windows))]
fn open_directory_lease(_path: &Path) -> Result<DirectoryLease, String> {
    Ok(DirectoryLease {})
}

impl OutputGrant {
    fn new(directory: PathBuf) -> Result<Self, String> {
        let directory = validate_output_directory(&directory)?;
        let lease = Arc::new(open_directory_lease(&directory)?);
        #[cfg(windows)]
        let identity = directory_identity_from_lease(lease.as_ref())?;
        #[cfg(not(windows))]
        let identity = directory_identity(&directory)?;
        if directory_identity(&directory)? != identity {
            return Err("The selected output folder changed while it was bound.".to_string());
        }
        Ok(Self {
            directory,
            identity,
            _lease: lease,
            created_at: Instant::now(),
        })
    }
}

fn validate_output_grant(grant: &OutputGrant) -> Result<PathBuf, String> {
    if grant.created_at.elapsed() > TOKEN_TTL {
        return Err("The destination grant has expired.".to_string());
    }
    let directory = revalidate_trusted_output_directory(&grant.directory)?;
    if directory_identity(&directory)? != grant.identity {
        return Err("The selected output folder changed after approval.".to_string());
    }
    Ok(directory)
}

fn is_task_export_temporary_name(name: &str) -> bool {
    let Some(uuid) = name
        .strip_prefix(".swl-export-")
        .or_else(|| name.strip_prefix(".swl-configuration-"))
        .and_then(|value| value.strip_suffix(".tmp"))
    else {
        return false;
    };
    Uuid::parse_str(uuid).is_ok_and(|parsed| parsed.hyphenated().to_string() == uuid)
}

fn cleanup_stale_export_temps(directory: &Path) -> Result<usize, String> {
    let directory = revalidate_trusted_output_directory(directory)?;
    let mut removed = 0;
    let mut inspected = 0;
    let entries = fs::read_dir(&directory)
        .map_err(|_| "The selected output folder could not be inspected.".to_string())?;
    for entry in entries {
        inspected += 1;
        if inspected > 10_000 {
            return Err(
                "The selected output folder contains too many entries to inspect safely."
                    .to_string(),
            );
        }
        let entry =
            entry.map_err(|_| "The selected output folder could not be inspected.".to_string())?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !is_task_export_temporary_name(&name) {
            continue;
        }
        let path = entry.path();
        if path.parent() != Some(directory.as_path()) {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "A temporary output could not be verified.".to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            continue;
        }
        let stale = metadata
            .modified()
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age > TOKEN_TTL);
        if stale {
            fs::remove_file(&path)
                .map_err(|_| "A stale temporary output could not be removed.".to_string())?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn xml_local_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

fn spreadsheet_cell_position(value: &[u8]) -> Option<(usize, usize)> {
    let value = value.strip_prefix(b"$").unwrap_or(value);
    let mut column = 0_usize;
    let mut letters = 0_usize;
    while let Some(byte) = value.get(letters).copied() {
        if !byte.is_ascii_alphabetic() {
            break;
        }
        column = column
            .checked_mul(26)?
            .checked_add(usize::from(byte.to_ascii_uppercase() - b'A') + 1)?;
        letters += 1;
    }
    let row = value
        .get(letters..)?
        .strip_prefix(b"$")
        .unwrap_or(&value[letters..]);
    if letters == 0 || row.is_empty() || !row.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some((column, std::str::from_utf8(row).ok()?.parse().ok()?))
}

fn validate_spreadsheet_reference(value: &[u8]) -> Result<(), String> {
    for cell in value.split(|byte| *byte == b':') {
        let (column, row) = spreadsheet_cell_position(cell)
            .ok_or_else(|| "The workbook contains an invalid cell reference.".to_string())?;
        if column == 0
            || column > MAX_XLSX_COLUMNS_PER_SHEET
            || row == 0
            || row > MAX_XLSX_ROWS_PER_SHEET
        {
            return Err("The workbook exceeds the supported row or column limit.".to_string());
        }
    }
    Ok(())
}

fn validate_worksheet_xml<R: io::BufRead>(reader: R) -> Result<(), String> {
    let mut reader = XmlReader::from_reader(reader);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut row_elements = 0_usize;
    let mut cells_in_row = 0_usize;
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) | Ok(Event::Empty(event)) => {
                let name = event.name();
                match xml_local_name(name.as_ref()) {
                    b"dimension" => {
                        for attribute in event.attributes() {
                            let attribute = attribute.map_err(|_| {
                                "The workbook worksheet metadata is invalid.".to_string()
                            })?;
                            if xml_local_name(attribute.key.as_ref()) == b"ref" {
                                validate_spreadsheet_reference(attribute.value.as_ref())?;
                            }
                        }
                    }
                    b"row" => {
                        row_elements += 1;
                        cells_in_row = 0;
                        if row_elements > MAX_XLSX_ROWS_PER_SHEET {
                            return Err("The workbook exceeds the supported row limit.".to_string());
                        }
                        for attribute in event.attributes() {
                            let attribute = attribute.map_err(|_| {
                                "The workbook worksheet metadata is invalid.".to_string()
                            })?;
                            if xml_local_name(attribute.key.as_ref()) == b"r" {
                                let row = std::str::from_utf8(attribute.value.as_ref())
                                    .ok()
                                    .and_then(|value| value.parse::<usize>().ok())
                                    .ok_or_else(|| {
                                        "The workbook contains an invalid row reference."
                                            .to_string()
                                    })?;
                                if row == 0 || row > MAX_XLSX_ROWS_PER_SHEET {
                                    return Err(
                                        "The workbook exceeds the supported row limit.".to_string()
                                    );
                                }
                            }
                        }
                    }
                    b"c" => {
                        cells_in_row += 1;
                        if cells_in_row > MAX_XLSX_COLUMNS_PER_SHEET {
                            return Err(
                                "The workbook exceeds the supported column limit.".to_string()
                            );
                        }
                        for attribute in event.attributes() {
                            let attribute = attribute.map_err(|_| {
                                "The workbook worksheet metadata is invalid.".to_string()
                            })?;
                            if xml_local_name(attribute.key.as_ref()) == b"r" {
                                validate_spreadsheet_reference(attribute.value.as_ref())?;
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => return Ok(()),
            Ok(_) => {}
            Err(_) => return Err("The workbook worksheet XML is invalid.".to_string()),
        }
        buffer.clear();
    }
}

fn validate_xlsx_container<R: Read + Seek>(reader: R) -> Result<(), String> {
    let mut archive = ZipArchive::new(reader)
        .map_err(|_| "The workbook is not a valid XLSX container.".to_string())?;
    if archive.is_empty() || archive.len() > MAX_XLSX_ENTRIES {
        return Err("The workbook ZIP entry count is outside the supported range.".to_string());
    }
    let mut names = HashSet::new();
    let mut worksheets = Vec::new();
    let mut expanded_total = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| "The workbook ZIP directory is invalid.".to_string())?;
        if entry.encrypted() {
            return Err("Password-protected workbooks are not supported.".to_string());
        }
        let name = entry.name().to_string();
        if name.is_empty()
            || name.len() > 1_024
            || name.contains('\\')
            || entry.enclosed_name().is_none()
            || !names.insert(name.clone())
        {
            return Err("The workbook contains an unsafe or duplicate ZIP entry.".to_string());
        }
        if entry.is_dir() {
            continue;
        }
        if !matches!(
            entry.compression(),
            CompressionMethod::Stored | CompressionMethod::Deflated
        ) {
            return Err("The workbook uses an unsupported ZIP compression method.".to_string());
        }
        let declared = entry.size();
        let compressed = entry.compressed_size();
        expanded_total = expanded_total.checked_add(declared).ok_or_else(|| {
            "The workbook expanded size is outside the supported range.".to_string()
        })?;
        if declared > MAX_XLSX_ENTRY_EXPANDED_BYTES
            || expanded_total > MAX_XLSX_EXPANDED_BYTES
            || (declared > 1024 * 1024
                && (compressed == 0 || declared > compressed.saturating_mul(100)))
        {
            return Err("The workbook expanded size is outside the supported range.".to_string());
        }
        let mut actual = 0_u64;
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let read = entry
                .read(&mut buffer)
                .map_err(|_| "The workbook ZIP content is corrupt.".to_string())?;
            if read == 0 {
                break;
            }
            actual = actual.checked_add(read as u64).ok_or_else(|| {
                "The workbook expanded size is outside the supported range.".to_string()
            })?;
            if actual > MAX_XLSX_ENTRY_EXPANDED_BYTES || actual > declared {
                return Err(
                    "The workbook expanded size is outside the supported range.".to_string()
                );
            }
        }
        if actual != declared {
            return Err("The workbook ZIP entry length did not match its metadata.".to_string());
        }
        if name.starts_with("xl/worksheets/") && name.ends_with(".xml") {
            worksheets.push(name);
        }
    }
    if !names.contains("[Content_Types].xml")
        || !names.contains("xl/workbook.xml")
        || worksheets.is_empty()
        || worksheets.len() > MAX_XLSX_WORKSHEETS
    {
        return Err("The workbook package structure is invalid.".to_string());
    }
    for worksheet in worksheets {
        let entry = archive
            .by_name(&worksheet)
            .map_err(|_| "The workbook worksheet could not be opened.".to_string())?;
        validate_worksheet_xml(BufReader::new(entry))?;
    }
    Ok(())
}

fn validate_export_contents(path: &Path, filename: &str) -> Result<(), String> {
    let extension = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "xlsx" => {
            let file = File::open(path)
                .map_err(|_| "The workbook output could not be verified.".to_string())?;
            validate_xlsx_container(file)?;
        }
        "txt" => {
            let bytes =
                fs::read(path).map_err(|_| "The text output could not be verified.".to_string())?;
            std::str::from_utf8(&bytes)
                .map_err(|_| "The text output is not valid UTF-8.".to_string())?;
        }
        _ => return Err("The output file extension is not supported.".to_string()),
    }
    Ok(())
}

fn validate_input_role(role: &str, extension: &str, length: u64) -> Result<(), String> {
    let valid_extension = match role {
        "supplier" | "servicem8" => matches!(extension, "csv" | "xlsx"),
        "configuration" => extension == "json",
        _ => return Err("The input file role is invalid.".to_string()),
    };
    if !valid_extension {
        return Err("The selected input file type is not supported for this role.".to_string());
    }
    let maximum = if role == "configuration" {
        MAX_IMPORT_BYTES as u64
    } else {
        MAX_BUSINESS_INPUT_BYTES
    };
    if length == 0 || length > maximum {
        return Err("The selected input file size is outside the supported range.".to_string());
    }
    Ok(())
}

fn validate_csv_dimensions(bytes: &[u8]) -> Result<(), String> {
    #[derive(Clone, Copy)]
    enum State {
        FieldStart,
        Unquoted,
        Quoted,
        AfterQuote,
    }

    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    if bytes.is_empty() {
        return Err("The CSV input is empty.".to_string());
    }
    let mut state = State::FieldStart;
    let mut columns = 1_usize;
    let mut records = 0_usize;
    let mut record_has_bytes = false;
    let mut index = 0_usize;
    let finish_record = |columns: usize, records: &mut usize| -> Result<(), String> {
        if columns > MAX_XLSX_COLUMNS_PER_SHEET {
            return Err("The CSV input exceeds the supported column limit.".to_string());
        }
        *records += 1;
        if *records > MAX_XLSX_ROWS_PER_SHEET {
            return Err("The CSV input exceeds 50,000 data rows.".to_string());
        }
        Ok(())
    };
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == 0 || (byte < 0x20 && !matches!(byte, b'\r' | b'\n' | b'\t')) || byte == 0x7f {
            return Err("The CSV input contains an unsupported control character.".to_string());
        }
        match state {
            State::FieldStart => match byte {
                b'"' => {
                    state = State::Quoted;
                    record_has_bytes = true;
                }
                b',' => {
                    columns += 1;
                    record_has_bytes = true;
                }
                b'\r' | b'\n' => {
                    finish_record(columns, &mut records)?;
                    columns = 1;
                    record_has_bytes = false;
                    if byte == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
                        index += 1;
                    }
                }
                _ => {
                    state = State::Unquoted;
                    record_has_bytes = true;
                }
            },
            State::Unquoted => match byte {
                b'"' => return Err("The CSV input contains an invalid quote.".to_string()),
                b',' => {
                    columns += 1;
                    state = State::FieldStart;
                }
                b'\r' | b'\n' => {
                    finish_record(columns, &mut records)?;
                    columns = 1;
                    state = State::FieldStart;
                    record_has_bytes = false;
                    if byte == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
                        index += 1;
                    }
                }
                _ => {}
            },
            State::Quoted => {
                if byte == b'"' {
                    state = State::AfterQuote;
                }
            }
            State::AfterQuote => match byte {
                b'"' => state = State::Quoted,
                b',' => {
                    columns += 1;
                    state = State::FieldStart;
                }
                b'\r' | b'\n' => {
                    finish_record(columns, &mut records)?;
                    columns = 1;
                    state = State::FieldStart;
                    record_has_bytes = false;
                    if byte == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
                        index += 1;
                    }
                }
                _ => return Err("The CSV input contains text after a closing quote.".to_string()),
            },
        }
        if columns > MAX_XLSX_COLUMNS_PER_SHEET {
            return Err("The CSV input exceeds the supported column limit.".to_string());
        }
        index += 1;
    }
    if matches!(state, State::Quoted) {
        return Err("The CSV input contains an unterminated quoted field.".to_string());
    }
    if record_has_bytes || columns > 1 || !matches!(state, State::FieldStart) {
        finish_record(columns, &mut records)?;
    }
    if records == 0 {
        return Err("The CSV input does not contain a header row.".to_string());
    }
    Ok(())
}

fn validate_open_input_file(file: &mut File, extension: &str, length: u64) -> Result<(), String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "The selected input file could not be verified.".to_string())?;
    match extension {
        "xlsx" => {
            validate_xlsx_container(&mut *file)?;
        }
        "csv" | "json" => {
            let mut bytes = Vec::with_capacity(length as usize);
            file.read_to_end(&mut bytes)
                .map_err(|_| "The selected text input could not be verified.".to_string())?;
            std::str::from_utf8(&bytes)
                .map_err(|_| "The selected text input is not valid UTF-8.".to_string())?;
            if extension == "csv" {
                validate_csv_dimensions(&bytes)?;
            }
        }
        _ => return Err("The selected input file type is not supported.".to_string()),
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "The selected input file could not be prepared.".to_string())?;
    Ok(())
}

#[tauri::command]
async fn choose_input_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    role: String,
) -> Result<Option<InputGrantSummary>, String> {
    let selected = app.dialog().file().blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| "The selected input file could not be resolved.".to_string())?;
    reject_windows_device_path(&path)?;
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("The selected input file path is invalid.".to_string());
    }
    reject_link_components(&path)?;
    let canonical = fs::canonicalize(path)
        .map_err(|_| "The selected input file could not be resolved.".to_string())?;
    let path_metadata = fs::symlink_metadata(&canonical)
        .map_err(|_| "The selected input file could not be verified.".to_string())?;
    if !path_metadata.is_file()
        || path_metadata.file_type().is_symlink()
        || is_reparse_point(&path_metadata)
    {
        return Err("The selected input is not a safe regular file.".to_string());
    }
    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let display_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "The selected input filename is invalid.".to_string())?
        .to_string();
    validate_text(&display_name, "Input filename", 720, false)?;
    let mut file = OpenOptions::new()
        .read(true)
        .open(&canonical)
        .map_err(|_| "The selected input file could not be opened.".to_string())?;
    let handle_metadata = file
        .metadata()
        .map_err(|_| "The selected input file could not be verified.".to_string())?;
    if !handle_metadata.is_file()
        || is_reparse_point(&handle_metadata)
        || handle_metadata.len() != path_metadata.len()
    {
        return Err("The selected input file changed while it was being opened.".to_string());
    }
    validate_input_role(&role, &extension, handle_metadata.len())?;
    validate_open_input_file(&mut file, &extension, handle_metadata.len())?;
    let grant_id = Uuid::new_v4().to_string();
    let summary = InputGrantSummary {
        grant_id: grant_id.clone(),
        display_name: display_name.clone(),
        length: handle_metadata.len(),
        extension: extension.clone(),
    };
    let mut input_grants = safe_lock(&state.input_grants)?;
    prune_expired_and_require_capacity(
        &mut input_grants,
        MAX_INPUT_GRANTS,
        |grant| grant.created_at,
        "native input grants",
    )?;
    let aggregate = input_grants
        .values()
        .try_fold(handle_metadata.len(), |sum, grant| {
            sum.checked_add(grant.length)
        });
    if aggregate.is_none_or(|total| total > MAX_AGGREGATE_INPUT_BYTES) {
        return Err("The active native input grants exceed the aggregate size limit.".to_string());
    }
    input_grants.insert(
        grant_id,
        InputGrant {
            file,
            length: handle_metadata.len(),
            created_at: Instant::now(),
        },
    );
    Ok(Some(summary))
}

fn read_input_chunk_inner(
    state: &AppState,
    grant_id: String,
    offset: u64,
    length: usize,
) -> Result<String, String> {
    validate_identifier(&grant_id, "Input grant")?;
    if length == 0 || length > MAX_EXPORT_CHUNK_BYTES {
        return Err("The input chunk size is outside the supported range.".to_string());
    }
    let mut grants = safe_lock(&state.input_grants)?;
    let expired = grants
        .get(&grant_id)
        .ok_or_else(|| "The input grant is missing or invalid.".to_string())?;
    if expired.created_at.elapsed() > TOKEN_TTL {
        grants.remove(&grant_id);
        return Err("The input grant has expired.".to_string());
    }
    let grant = grants
        .get_mut(&grant_id)
        .ok_or_else(|| "The input grant is missing or invalid.".to_string())?;
    let end = offset
        .checked_add(length as u64)
        .ok_or_else(|| "The input chunk range is invalid.".to_string())?;
    if offset >= grant.length || end > grant.length {
        return Err("The input chunk range is invalid.".to_string());
    }
    grant
        .file
        .seek(SeekFrom::Start(offset))
        .map_err(|_| "The input file could not be read.".to_string())?;
    let mut bytes = vec![0_u8; length];
    grant
        .file
        .read_exact(&mut bytes)
        .map_err(|_| "The input file could not be read.".to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
fn read_input_chunk(
    state: State<'_, AppState>,
    grant_id: String,
    offset: u64,
    length: usize,
) -> Result<String, String> {
    read_input_chunk_inner(&state, grant_id, offset, length)
}

#[tauri::command]
fn release_input_grant(state: State<'_, AppState>, grant_id: String) -> Result<(), String> {
    validate_identifier(&grant_id, "Input grant")?;
    safe_lock(&state.input_grants)?.remove(&grant_id);
    Ok(())
}

#[tauri::command]
async fn choose_output_destination(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<DestinationGrant>, String> {
    let selected = app.dialog().file().blocking_pick_folder();
    let Some(folder) = selected else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|_| "The selected output folder could not be resolved.".to_string())?;
    let grant = OutputGrant::new(path)?;
    let canonical = grant.directory.clone();
    cleanup_stale_export_temps(&canonical)?;
    let display_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Selected folder")
        .to_string();
    let grant_id = Uuid::new_v4().to_string();
    let mut output_grants = safe_lock(&state.output_grants)?;
    prune_expired_and_require_capacity(
        &mut output_grants,
        MAX_OUTPUT_GRANTS,
        |grant| grant.created_at,
        "native output grants",
    )?;
    output_grants.insert(grant_id.clone(), grant);
    Ok(Some(DestinationGrant {
        grant_id,
        display_name,
    }))
}

fn export_configuration_to_folder_inner(
    state: &AppState,
    grant_id: String,
    filename: String,
) -> Result<String, String> {
    validate_identifier(&grant_id, "Destination grant")?;
    validate_configuration_export_filename(&filename)?;
    let grant = safe_lock(&state.output_grants)?
        .get(&grant_id)
        .cloned()
        .ok_or_else(|| "The destination grant is missing or invalid.".to_string())?;
    let directory = validate_output_grant(&grant)?;
    let destination = directory.join(&filename);
    if destination.parent() != Some(directory.as_path()) || destination.exists() {
        return Err("A file with this name already exists. No file was overwritten.".to_string());
    }
    let connection = open_connection(&state.database_path)?;
    let envelope = configuration_from_database(&connection)?;
    let bytes = serde_json::to_vec(&envelope)
        .map_err(|_| "The configuration export could not be encoded.".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_IMPORT_BYTES {
        return Err("The configuration export size is outside the supported range.".to_string());
    }
    if !verify_configuration_checksum(&envelope) {
        return Err("The configuration export checksum could not be verified.".to_string());
    }
    let temporary = directory.join(format!(".swl-configuration-{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "The temporary configuration export could not be created.".to_string())?;
        if validate_output_grant(&grant)? != directory {
            return Err("The selected output folder changed during export.".to_string());
        }
        file.write_all(&bytes)
            .map_err(|_| "The configuration export could not be written.".to_string())?;
        file.flush()
            .map_err(|_| "The configuration export could not be flushed.".to_string())?;
        file.sync_all()
            .map_err(|_| "The configuration export could not be synchronised.".to_string())?;
        if file
            .metadata()
            .map_err(|_| "The configuration export could not be verified.".to_string())?
            .len()
            != bytes.len() as u64
        {
            return Err("The configuration export length did not match.".to_string());
        }
        drop(file);
        commit_temporary_no_replace(&temporary, &destination).map_err(|_| {
            "The configuration export could not be committed without overwriting.".to_string()
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(filename)
}

#[tauri::command]
fn export_configuration_to_folder(
    state: State<'_, AppState>,
    grant_id: String,
    filename: String,
) -> Result<String, String> {
    export_configuration_to_folder_inner(&state, grant_id, filename)
}

fn prune_expired_export_batches(state: &AppState) -> Result<(), String> {
    let expired_sessions = {
        let mut batches = safe_lock(&state.export_batches)?;
        let expired = batches
            .iter()
            .filter(|(_, batch)| batch.created_at.elapsed() > TOKEN_TTL)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let mut sessions = Vec::new();
        for id in expired {
            if let Some(batch) = batches.remove(&id) {
                sessions.extend(
                    batch
                        .files
                        .values()
                        .filter_map(|file| file.session_id.clone()),
                );
            }
        }
        sessions
    };
    if !expired_sessions.is_empty() {
        let mut sessions = safe_lock(&state.export_sessions)?;
        for id in expired_sessions {
            sessions.remove(&id);
        }
    }
    Ok(())
}

fn reserve_export_batch_inner(
    state: &AppState,
    grant_id: String,
    files: Vec<ExportBatchFileRequest>,
) -> Result<ExportBatchReservation, String> {
    validate_identifier(&grant_id, "Destination grant")?;
    if files.len() != 5 {
        return Err("Exactly five operational outputs must be reserved together.".to_string());
    }
    let grant = safe_lock(&state.output_grants)?
        .get(&grant_id)
        .cloned()
        .ok_or_else(|| "The destination grant is missing or invalid.".to_string())?;
    let directory = validate_output_grant(&grant)?;
    let mut total = 0_u64;
    let mut reserved = BTreeMap::new();
    for request in files {
        validate_export_filename(&request.filename)?;
        if request.length == 0 || request.length > MAX_EXPORT_BYTES {
            return Err("An output file size is outside the supported range.".to_string());
        }
        if request.sha256.len() != 64
            || !request
                .sha256
                .bytes()
                .all(|value| value.is_ascii_hexdigit())
        {
            return Err("An output file checksum is invalid.".to_string());
        }
        total = total
            .checked_add(request.length)
            .ok_or_else(|| "The export batch size is outside the supported range.".to_string())?;
        if total > MAX_AGGREGATE_EXPORT_BYTES {
            return Err("The export batch exceeds the aggregate size limit.".to_string());
        }
        let destination = directory.join(&request.filename);
        if destination.parent() != Some(directory.as_path()) || destination.exists() {
            return Err(
                "At least one output filename already exists. No output was created.".to_string(),
            );
        }
        if reserved
            .insert(
                request.filename,
                ExportBatchFile {
                    length: request.length,
                    sha256: request.sha256.to_ascii_lowercase(),
                    session_id: None,
                    ready_temporary: None,
                },
            )
            .is_some()
        {
            return Err("The export batch contains duplicate filenames.".to_string());
        }
    }
    if validate_output_grant(&grant)? != directory {
        return Err("The selected output folder changed during reservation.".to_string());
    }
    prune_expired_export_batches(state)?;
    let batch_id = Uuid::new_v4().to_string();
    let mut batches = safe_lock(&state.export_batches)?;
    if batches.len() >= MAX_EXPORT_BATCHES {
        return Err("Too many native export batches are active.".to_string());
    }
    batches.insert(
        batch_id.clone(),
        ExportBatch {
            grant_id,
            files: reserved,
            created_at: Instant::now(),
        },
    );
    Ok(ExportBatchReservation { batch_id })
}

#[tauri::command]
fn reserve_export_batch(
    state: State<'_, AppState>,
    grant_id: String,
    files: Vec<ExportBatchFileRequest>,
) -> Result<ExportBatchReservation, String> {
    reserve_export_batch_inner(&state, grant_id, files)
}

fn begin_export_file_inner(
    state: &AppState,
    grant_id: String,
    filename: String,
    length: u64,
    sha256: String,
) -> Result<BeginExportResult, String> {
    validate_identifier(&grant_id, "Destination grant")?;
    validate_export_filename(&filename)?;
    if length == 0 || length > MAX_EXPORT_BYTES {
        return Err("The output file size is outside the supported range.".to_string());
    }
    if sha256.len() != 64
        || !sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("The output file checksum is invalid.".to_string());
    }
    let grant = safe_lock(&state.output_grants)?
        .get(&grant_id)
        .cloned()
        .ok_or_else(|| "The destination grant is missing or invalid.".to_string())?;
    let directory = validate_output_grant(&grant)?;
    let destination = directory.join(&filename);
    if destination.parent() != Some(directory.as_path()) || destination.exists() {
        return Err("A file with this name already exists. No file was overwritten.".to_string());
    }
    let temporary = directory.join(format!(".swl-export-{}.tmp", Uuid::new_v4()));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "The temporary output file could not be created.".to_string())?;
    let grant_unchanged = validate_output_grant(&grant)
        .is_ok_and(|validated_directory| validated_directory == directory);
    if !grant_unchanged {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err("The selected output folder changed during export.".to_string());
    }
    let session_id = Uuid::new_v4().to_string();
    let mut export_sessions = match safe_lock(&state.export_sessions) {
        Ok(value) => value,
        Err(error) => {
            drop(file);
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    };
    if let Err(error) = prune_expired_and_require_capacity(
        &mut export_sessions,
        MAX_EXPORT_SESSIONS,
        |session| session.created_at,
        "native export sessions",
    ) {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    let aggregate = export_sessions.values().try_fold(length, |sum, session| {
        sum.checked_add(session.expected_length)
    });
    if aggregate.is_none_or(|total| total > MAX_AGGREGATE_EXPORT_BYTES) {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err("The active native exports exceed the aggregate size limit.".to_string());
    }
    export_sessions.insert(
        session_id.clone(),
        ExportSession {
            #[cfg(test)]
            grant_id,
            #[cfg(test)]
            destination,
            temporary,
            filename,
            expected_length: length,
            expected_sha256: sha256.to_ascii_lowercase(),
            written: 0,
            hasher: Sha256::new(),
            file: Some(file),
            created_at: Instant::now(),
        },
    );
    Ok(BeginExportResult {
        session_id,
        conflict: false,
    })
}

fn begin_export_file_for_batch_inner(
    state: &AppState,
    batch_id: String,
    grant_id: String,
    filename: String,
    length: u64,
    sha256: String,
) -> Result<BeginExportResult, String> {
    validate_identifier(&batch_id, "Export batch")?;
    prune_expired_export_batches(state)?;
    let mut batches = safe_lock(&state.export_batches)?;
    let batch = batches
        .get_mut(&batch_id)
        .ok_or_else(|| "The export batch is missing or has expired.".to_string())?;
    if batch.grant_id != grant_id {
        return Err("The destination grant does not match the export batch.".to_string());
    }
    let file = batch
        .files
        .get_mut(&filename)
        .ok_or_else(|| "The output file was not reserved in this batch.".to_string())?;
    if file.length != length
        || file.sha256 != sha256.to_ascii_lowercase()
        || file.session_id.is_some()
        || file.ready_temporary.is_some()
    {
        return Err("The output file does not match its unused batch reservation.".to_string());
    }
    let result = begin_export_file_inner(state, grant_id, filename, length, sha256)?;
    file.session_id = Some(result.session_id.clone());
    Ok(result)
}

#[tauri::command]
fn begin_export_file(
    state: State<'_, AppState>,
    batch_id: String,
    grant_id: String,
    filename: String,
    length: u64,
    sha256: String,
) -> Result<BeginExportResult, String> {
    begin_export_file_for_batch_inner(&state, batch_id, grant_id, filename, length, sha256)
}

fn append_export_chunk_inner(
    state: &AppState,
    session_id: String,
    offset: u64,
    base64_data: String,
) -> Result<u64, String> {
    validate_identifier(&session_id, "Export session")?;
    if base64_data.len() > (MAX_EXPORT_CHUNK_BYTES * 4 / 3) + 8 {
        return Err("The export chunk is too large.".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|_| "The export chunk encoding is invalid.".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_EXPORT_CHUNK_BYTES {
        return Err("The export chunk size is outside the supported range.".to_string());
    }
    append_export_bytes_with(state, session_id, offset, &bytes, |file, value| {
        file.write_all(value)
    })
}

fn append_export_bytes_with<F>(
    state: &AppState,
    session_id: String,
    offset: u64,
    bytes: &[u8],
    write: F,
) -> Result<u64, String>
where
    F: FnOnce(&mut File, &[u8]) -> io::Result<()>,
{
    let mut sessions = safe_lock(&state.export_sessions)?;
    let mut session = sessions
        .remove(&session_id)
        .ok_or_else(|| "The export session is missing or has already ended.".to_string())?;
    if session.created_at.elapsed() > TOKEN_TTL {
        drop(session.file.take());
        let _ = fs::remove_file(&session.temporary);
        return Err("The export session has expired.".to_string());
    }
    if offset != session.written
        || session.written.saturating_add(bytes.len() as u64) > session.expected_length
    {
        drop(session.file.take());
        let _ = fs::remove_file(&session.temporary);
        return Err("The export chunk offset or length is invalid.".to_string());
    }
    let Some(file) = session.file.as_mut() else {
        let _ = fs::remove_file(&session.temporary);
        return Err("The export session file is unavailable.".to_string());
    };
    if write(file, bytes).is_err() {
        drop(session.file.take());
        let _ = fs::remove_file(&session.temporary);
        return Err("The output file could not be written.".to_string());
    }
    session.hasher.update(bytes);
    session.written += bytes.len() as u64;
    let written = session.written;
    sessions.insert(session_id, session);
    Ok(written)
}

#[tauri::command]
fn append_export_chunk(
    state: State<'_, AppState>,
    session_id: String,
    offset: u64,
    base64_data: String,
) -> Result<u64, String> {
    append_export_chunk_inner(&state, session_id, offset, base64_data)
}

fn prepare_export_session(session: &mut ExportSession) -> Result<(), String> {
    if session.created_at.elapsed() > TOKEN_TTL {
        return Err("The export session has expired.".to_string());
    }
    if session.written != session.expected_length {
        return Err("The output file is incomplete.".to_string());
    }
    let file = session
        .file
        .as_mut()
        .ok_or_else(|| "The export session file is unavailable.".to_string())?;
    file.flush()
        .map_err(|_| "The output file could not be flushed.".to_string())?;
    file.sync_all()
        .map_err(|_| "The output file could not be synchronised.".to_string())?;
    if file
        .metadata()
        .map_err(|_| "The output file could not be verified.".to_string())?
        .len()
        != session.expected_length
    {
        return Err("The output file length did not match.".to_string());
    }
    let actual = format!("{:x}", session.hasher.clone().finalize());
    if actual != session.expected_sha256 {
        return Err("The output file checksum did not match.".to_string());
    }
    drop(session.file.take());
    validate_export_contents(&session.temporary, &session.filename)
}

#[cfg(test)]
fn commit_export_file_inner(state: &AppState, session_id: String) -> Result<String, String> {
    validate_identifier(&session_id, "Export session")?;
    let mut session = safe_lock(&state.export_sessions)?
        .remove(&session_id)
        .ok_or_else(|| "The export session is missing or has already ended.".to_string())?;
    let finish = (|| -> Result<String, String> {
        prepare_export_session(&mut session)?;
        let grant = safe_lock(&state.output_grants)?
            .get(&session.grant_id)
            .cloned()
            .ok_or_else(|| "The destination grant is no longer valid.".to_string())?;
        let directory = validate_output_grant(&grant)?;
        if session.destination.parent() != Some(directory.as_path()) || session.destination.exists()
        {
            return Err(
                "A file with this name already exists. No file was overwritten.".to_string(),
            );
        }
        commit_temporary_no_replace(&session.temporary, &session.destination).map_err(|_| {
            "The output file could not be committed without overwriting.".to_string()
        })?;
        Ok(session.filename.clone())
    })();
    if finish.is_err() {
        drop(session.file.take());
        let _ = fs::remove_file(&session.temporary);
    }
    finish
}

fn prepare_export_file_for_batch_inner(
    state: &AppState,
    session_id: String,
) -> Result<String, String> {
    validate_identifier(&session_id, "Export session")?;
    prune_expired_export_batches(state)?;
    let mut batches = safe_lock(&state.export_batches)?;
    let location = batches.iter().find_map(|(batch_id, batch)| {
        batch.files.iter().find_map(|(filename, file)| {
            (file.session_id.as_deref() == Some(session_id.as_str()))
                .then(|| (batch_id.clone(), filename.clone()))
        })
    });
    let (batch_id, filename) = location
        .ok_or_else(|| "The export session is not bound to an active batch.".to_string())?;
    let mut sessions = safe_lock(&state.export_sessions)?;
    let mut session = sessions
        .remove(&session_id)
        .ok_or_else(|| "The export session is missing or has already ended.".to_string())?;
    let prepared = prepare_export_session(&mut session);
    if let Err(error) = prepared {
        if let Some(batch) = batches.remove(&batch_id) {
            for other in batch
                .files
                .values()
                .filter_map(|file| file.session_id.as_ref())
            {
                if other != &session_id {
                    sessions.remove(other);
                }
            }
        }
        return Err(error);
    }
    let temporary = std::mem::take(&mut session.temporary);
    let batch = batches
        .get_mut(&batch_id)
        .ok_or_else(|| "The export batch ended before the file was prepared.".to_string())?;
    let file = batch
        .files
        .get_mut(&filename)
        .ok_or_else(|| "The export batch file reservation is missing.".to_string())?;
    file.session_id = None;
    file.ready_temporary = Some(temporary);
    Ok(filename)
}

fn abort_export_batch_inner(state: &AppState, batch_id: String) -> Result<(), String> {
    validate_identifier(&batch_id, "Export batch")?;
    let batch = safe_lock(&state.export_batches)?.remove(&batch_id);
    if let Some(batch) = batch {
        let mut sessions = safe_lock(&state.export_sessions)?;
        for session_id in batch
            .files
            .values()
            .filter_map(|file| file.session_id.as_ref())
        {
            sessions.remove(session_id);
        }
    }
    Ok(())
}

fn commit_export_batch_with<F>(
    state: &AppState,
    batch_id: String,
    mut commit: F,
) -> Result<Vec<String>, String>
where
    F: FnMut(&Path, &Path) -> Result<(), String>,
{
    validate_identifier(&batch_id, "Export batch")?;
    prune_expired_export_batches(state)?;
    let mut batch = {
        let mut batches = safe_lock(&state.export_batches)?;
        let batch = batches
            .get(&batch_id)
            .ok_or_else(|| "The export batch is missing or has expired.".to_string())?;
        if batch
            .files
            .values()
            .any(|file| file.session_id.is_some() || file.ready_temporary.is_none())
        {
            return Err("All five export files must be prepared before batch commit.".to_string());
        }
        batches
            .remove(&batch_id)
            .ok_or_else(|| "The export batch is missing or has expired.".to_string())?
    };
    let grant = safe_lock(&state.output_grants)?
        .get(&batch.grant_id)
        .cloned()
        .ok_or_else(|| "The destination grant is no longer valid.".to_string())?;
    let directory = validate_output_grant(&grant)?;
    let mut files = Vec::with_capacity(batch.files.len());
    for (filename, file) in &batch.files {
        let destination = directory.join(filename);
        if destination.parent() != Some(directory.as_path()) || destination.exists() {
            return Err(
                "At least one output filename now exists. No task output was committed."
                    .to_string(),
            );
        }
        files.push((
            filename.clone(),
            file.ready_temporary
                .clone()
                .ok_or_else(|| "An export batch temporary file is missing.".to_string())?,
            destination,
        ));
    }
    let mut committed = Vec::new();
    for (_, temporary, destination) in &files {
        if validate_output_grant(&grant).is_err() || commit(temporary, destination).is_err() {
            let mut rollback_failed = false;
            for committed_destination in &committed {
                if fs::remove_file(committed_destination).is_err() {
                    rollback_failed = true;
                }
            }
            if rollback_failed {
                return Err(
                    "The export batch failed and a task-created output could not be rolled back."
                        .to_string(),
                );
            }
            return Err("The export batch failed; no task output was retained.".to_string());
        }
        committed.push(destination.clone());
    }
    for file in batch.files.values_mut() {
        file.ready_temporary = None;
    }
    Ok(files.into_iter().map(|(name, _, _)| name).collect())
}

fn commit_export_batch_inner(state: &AppState, batch_id: String) -> Result<Vec<String>, String> {
    commit_export_batch_with(state, batch_id, commit_temporary_no_replace)
}

#[tauri::command]
fn commit_export_batch(
    state: State<'_, AppState>,
    batch_id: String,
) -> Result<Vec<String>, String> {
    commit_export_batch_inner(&state, batch_id)
}

#[tauri::command]
fn abort_export_batch(state: State<'_, AppState>, batch_id: String) -> Result<(), String> {
    abort_export_batch_inner(&state, batch_id)
}

// MoveFileExW without MOVEFILE_REPLACE_EXISTING is Windows' atomic same-volume
// no-replace primitive. WRITE_THROUGH makes the directory-entry update durable
// before success is reported. There is no exists-then-rename race here.
#[cfg(windows)]
fn commit_temporary_no_replace(temporary: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    extern "system" {
        #[link_name = "MoveFileExW"]
        fn move_file_ex_w(existing: *const u16, destination: *const u16, flags: u32) -> i32;
    }

    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    let existing = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both UTF-16 buffers are null-terminated and remain alive for the
    // synchronous call. No replace flag is supplied.
    let moved = unsafe {
        move_file_ex_w(
            existing.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err("The temporary file could not be atomically committed.".to_string());
    }
    Ok(())
}

// POSIX rename replaces an existing destination, so host-side tests use an
// atomic no-replace link followed by removal of only the task-created name.
// A cleanup failure is rolled back to keep the result unambiguous.
#[cfg(not(windows))]
fn commit_temporary_no_replace(temporary: &Path, destination: &Path) -> Result<(), String> {
    fs::hard_link(temporary, destination)
        .map_err(|_| "The destination could not be created without overwriting.".to_string())?;
    if fs::remove_file(temporary).is_err() {
        let _ = fs::remove_file(destination);
        return Err("The temporary file could not be finalised safely.".to_string());
    }
    Ok(())
}

#[tauri::command]
fn commit_export_file(state: State<'_, AppState>, session_id: String) -> Result<String, String> {
    prepare_export_file_for_batch_inner(&state, session_id)
}

#[cfg(test)]
fn abort_export_file_inner(state: &AppState, session_id: String) -> Result<(), String> {
    validate_identifier(&session_id, "Export session")?;
    if let Some(mut session) = safe_lock(&state.export_sessions)?.remove(&session_id) {
        // Windows cannot unlink a file while this session still holds it open.
        drop(session.file.take());
        fs::remove_file(&session.temporary)
            .map_err(|_| "The temporary output file could not be removed.".to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn abort_export_file(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    validate_identifier(&session_id, "Export session")?;
    let batch_id = safe_lock(&state.export_batches)?
        .iter()
        .find_map(|(batch_id, batch)| {
            batch
                .files
                .values()
                .any(|file| file.session_id.as_deref() == Some(session_id.as_str()))
                .then(|| batch_id.clone())
        })
        .ok_or_else(|| "The export session is not bound to an active batch.".to_string())?;
    abort_export_batch_inner(&state, batch_id)
}

fn validate_source_url(value: &str) -> Result<Url, String> {
    if value.len() > 2_048 || value.chars().any(char::is_control) {
        return Err("The source URL is outside the supported range.".to_string());
    }
    let url = Url::parse(value).map_err(|_| "The source URL is invalid.".to_string())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only credential-free HTTPS source URLs may be opened.".to_string());
    }
    Ok(url)
}

#[cfg(windows)]
fn open_url_with_shell(value: &str) -> Result<(), String> {
    use std::ffi::c_void;

    #[link(name = "Shell32")]
    extern "system" {
        #[link_name = "ShellExecuteW"]
        fn shell_execute_w(
            window: *mut c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show_command: i32,
        ) -> *mut c_void;
    }
    let operation: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
    let file: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: both strings are null-terminated and remain alive for the
    // synchronous ShellExecuteW call. No command-line parameters are supplied.
    let result = unsafe {
        shell_execute_w(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    } as isize;
    if result <= 32 {
        return Err("The verified source could not be opened.".to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_url_with_shell(_value: &str) -> Result<(), String> {
    Err("Verified source links are opened only by the Windows application.".to_string())
}

#[tauri::command]
fn open_verified_source(url: String) -> Result<(), String> {
    let parsed = validate_source_url(&url)?;
    open_url_with_shell(parsed.as_str())
}

pub fn run() {
    tauri::Builder::default()
        // Single-instance must be registered first so no second process can
        // initialise another SQLite writer for the same application data.
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _working_directory| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
        ))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            fs::create_dir_all(&data_dir)?;
            let database_path = data_dir.join(DATABASE_FILENAME);
            recover_interrupted_restore(&database_path, &data_dir).map_err(io::Error::other)?;
            cleanup_stale_export_temps(&data_dir).map_err(io::Error::other)?;
            apply_migrations(&database_path, &data_dir).map_err(io::Error::other)?;
            app.manage(AppState::new(data_dir, platform_credential_store()));
            // The configured title deliberately remains non-final until the
            // database and command state are ready. Native acceptance can then
            // observe readiness without opening SQLite during a migration.
            let main_window = app
                .get_webview_window("main")
                .ok_or_else(|| io::Error::other("The main application window is unavailable."))?;
            main_window
                .set_title(APPLICATION_READY_TITLE)
                .map_err(io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_health,
            list_catalogue_items,
            publish_approved_changes,
            list_approvals,
            list_price_history,
            list_competitor_references,
            attach_competitor_reference,
            list_sources,
            replace_sources,
            list_mapping_profiles,
            save_mapping_profile,
            delete_mapping_profile,
            list_aliases,
            save_alias,
            delete_alias,
            load_settings,
            save_settings,
            list_brands,
            save_brand,
            list_suppliers,
            save_supplier,
            list_supplier_offers,
            save_supplier_offer,
            list_offer_selections,
            select_product_offer,
            update_product_metadata,
            list_settings_audit,
            list_sync_runs,
            save_sync_run,
            list_sync_checkpoints,
            append_sync_checkpoint,
            list_sync_item_outcomes,
            append_sync_item_outcome,
            export_configuration,
            preview_configuration_import,
            apply_configuration_import,
            configuration_migration_status,
            create_backup,
            list_backups,
            preview_restore,
            restore_backup,
            preview_reset,
            reset_application_data,
            provider_status,
            set_provider_paid_calls,
            search_competitors,
            configure_provider_credential,
            validate_provider_credential,
            replace_provider_credential,
            remove_provider_credential,
            choose_input_file,
            read_input_chunk,
            release_input_grant,
            choose_output_destination,
            export_configuration_to_folder,
            reserve_export_batch,
            begin_export_file,
            append_export_chunk,
            commit_export_file,
            abort_export_file,
            commit_export_batch,
            abort_export_batch,
            open_verified_source,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the SWL desktop application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_targets_are_isolated_by_exact_build_profile() {
        assert_eq!(
            credential_target_for_build_settings(None),
            PRODUCTION_CREDENTIAL_TARGET
        );
        assert_eq!(
            credential_target_for_build_settings(Some("true")),
            PRODUCTION_CREDENTIAL_TARGET
        );
        assert_eq!(
            credential_target_for_build_settings(Some("1")),
            LOCAL_TEST_CREDENTIAL_TARGET
        );
        assert_ne!(PRODUCTION_CREDENTIAL_TARGET, LOCAL_TEST_CREDENTIAL_TARGET);
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("swl-native-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }

        fn database(&self) -> PathBuf {
            self.0.join(DATABASE_FILENAME)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[derive(Default)]
    struct MemoryCredentialStore(Mutex<Option<String>>);

    impl CredentialStore for MemoryCredentialStore {
        fn set(&self, secret: &str) -> Result<(), String> {
            *safe_lock(&self.0)? = Some(secret.to_string());
            Ok(())
        }

        fn get(&self) -> Result<Option<String>, String> {
            Ok(safe_lock(&self.0)?.clone())
        }

        fn remove(&self) -> Result<(), String> {
            *safe_lock(&self.0)? = None;
            Ok(())
        }
    }

    #[derive(Default)]
    struct FailingRemoveCredentialStore(Mutex<Option<String>>);

    impl CredentialStore for FailingRemoveCredentialStore {
        fn set(&self, secret: &str) -> Result<(), String> {
            *safe_lock(&self.0)? = Some(secret.to_string());
            Ok(())
        }

        fn get(&self) -> Result<Option<String>, String> {
            Ok(safe_lock(&self.0)?.clone())
        }

        fn remove(&self) -> Result<(), String> {
            Err("synthetic credential removal failure".to_string())
        }
    }

    fn migrated_database() -> TestDirectory {
        let directory = TestDirectory::new();
        apply_migrations(&directory.database(), &directory.0).expect("apply migrations");
        directory
    }

    #[test]
    fn backup_hashing_fits_a_small_windows_startup_stack() {
        let directory = TestDirectory::new();
        let path = directory.0.join("synthetic-hash-input.bin");
        let bytes = b"synthetic bounded backup hash input";
        fs::write(&path, bytes).expect("write hash input");
        let expected = sha256_bytes(bytes);
        let actual = std::thread::Builder::new()
            .name("swl-small-stack-hash".to_string())
            .stack_size(256 * 1024)
            .spawn(move || sha256_file(&path))
            .expect("spawn small-stack hash thread")
            .join()
            .expect("small-stack hash thread")
            .expect("hash file");
        assert_eq!(actual, expected);
    }

    fn take_reset_preview(state: &AppState) -> PendingReset {
        let preview = preview_reset_inner(state).expect("preview reset");
        safe_lock(&state.pending_resets)
            .expect("lock reset previews")
            .remove(&preview.reset_token)
            .expect("pending reset")
    }

    fn sample_catalogue_item() -> CatalogueItem {
        CatalogueItem {
            id: "item-001".to_string(),
            item_number: "001234".to_string(),
            description: "Synthetic test lock".to_string(),
            cost_cents: 10_000,
            sell_price_cents: 13_000,
            gst_basis: "unknown".to_string(),
            sell_price_gst_basis: "unknown".to_string(),
            item_kind: "physical-product".to_string(),
            brand_id: None,
            markup_override_percent: None,
            xero_reference: None,
            servicem8_reference: None,
            barcode: None,
            selected_offer_id: None,
            updated_at: "2026-08-09T00:00:00Z".to_string(),
        }
    }

    fn verified_supplier_publication(
        item_id: &str,
        item_number: &str,
        cost_cents: i64,
        cost_gst_basis: &str,
        sell_price_cents: i64,
        sell_price_gst_basis: &str,
    ) -> PublishApprovedChange {
        let supplier_id = format!("supplier-{item_id}");
        let offer_id = format!("offer-{item_id}");
        let mut item = sample_catalogue_item();
        item.id = item_id.to_string();
        item.item_number = item_number.to_string();
        item.cost_cents = cost_cents;
        item.gst_basis = cost_gst_basis.to_string();
        item.sell_price_cents = sell_price_cents;
        item.sell_price_gst_basis = sell_price_gst_basis.to_string();
        item.selected_offer_id = Some(offer_id.clone());
        PublishApprovedChange {
            item,
            approved_by: "operator".to_string(),
            reason: "Verified supplier publication".to_string(),
            pricing_provenance: Some(PricingProvenance {
                selected_offer_id: Some(offer_id),
                supplier_id: Some(supplier_id),
                supplier_name: Some(format!("Supplier {item_id}")),
                supplier_sku: Some(item_number.to_string()),
                cost_gst_basis: cost_gst_basis.to_string(),
                currency: "AUD".to_string(),
                markup_percent: "30".to_string(),
                markup_source: "global".to_string(),
                markup_source_id: None,
                brand_id: None,
                item_kind: "physical-product".to_string(),
                sell_price_gst_basis: sell_price_gst_basis.to_string(),
                explanation: "Client-facing verified pricing detail".to_string(),
                rule_version: "pricing-rule-v1".to_string(),
            }),
        }
    }

    fn sample_live_competitor_evidence() -> CompetitorEvidence {
        CompetitorEvidence::Live(Box::new(LiveCompetitorEvidence {
            search_query: None,
            selected_product_title: None,
            selected_product_brand: None,
            selected_product_id: None,
            title: "Synthetic keyed-alike lock".to_string(),
            price_cents: 12_345,
            price_aud: "123.45".to_string(),
            item_price_cents: 12_345,
            item_price_aud: "123.45".to_string(),
            shipping_cents: Some(0),
            shipping_aud: Some("0.00".to_string()),
            estimated_tax_cents: None,
            estimated_tax_aud: None,
            total_price_cents: Some(12_345),
            total_price_aud: Some("123.45".to_string()),
            comparison_price_cents: Some(12_345),
            comparison_price_aud: Some("123.45".to_string()),
            price_basis: "provider_total".to_string(),
            original_price_text: "A$123.45".to_string(),
            currency_basis: "explicit-aud".to_string(),
            currency: "AUD".to_string(),
            gst_basis: "unknown".to_string(),
            pack_size: Some("each".to_string()),
            condition: "new".to_string(),
            availability: "in-stock".to_string(),
            financing: false,
            comparison_eligible: true,
            exclusion_reasons: Vec::new(),
            seller: "Synthetic competitor".to_string(),
            source_domain: "example.invalid".to_string(),
            url: "https://example.invalid/products/synthetic-lock".to_string(),
            retrieved_at: "2026-08-09T00:00:00Z".to_string(),
        }))
    }

    fn sample_manual_competitor_evidence() -> CompetitorEvidence {
        CompetitorEvidence::Manual(Box::new(ManualCompetitorEvidence {
            sku: "000123".to_string(),
            source_name: "Synthetic manual source".to_string(),
            approved_source: true,
            observed_at: "2026-08-09T00:00:00Z".to_string(),
            price: "123.45".to_string(),
            currency: "AUD".to_string(),
            gst_basis: "inc-gst".to_string(),
            shipping: "0.00".to_string(),
            stock_status: "in-stock".to_string(),
            condition: "new".to_string(),
            pack_compatible: true,
            product_only: true,
            match_confidence: 1.0,
            review_state: "accepted".to_string(),
            ambiguous_match: Some(false),
            url: Some("https://manual.example.invalid/products/000123".to_string()),
            pack_size: Some("each".to_string()),
        }))
    }

    fn synthetic_xlsx_with_sheet(sheet_xml: &str) -> Vec<u8> {
        use std::io::Cursor;
        use zip::{write::SimpleFileOptions, ZipWriter};

        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, contents) in [
            ("[Content_Types].xml", "<Types/>"),
            ("xl/workbook.xml", "<workbook/>"),
            ("xl/worksheets/sheet1.xml", sheet_xml),
        ] {
            writer.start_file(name, options).unwrap();
            writer.write_all(contents.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn synthetic_xlsx() -> Vec<u8> {
        synthetic_xlsx_with_sheet(
            r#"<worksheet><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1"/><c r="B1"/></row><row r="2"><c r="A2"/></row></sheetData></worksheet>"#,
        )
    }

    fn synthetic_export_batch() -> Vec<(ExportBatchFileRequest, Vec<u8>)> {
        let workbook = synthetic_xlsx();
        [
            ("20260809-SWL-Import-Candidate.xlsx", workbook.clone()),
            ("20260809-SWL-Change-Report.xlsx", workbook.clone()),
            ("20260809-SWL-Exceptions.xlsx", workbook.clone()),
            ("20260809-SWL-Rollback.xlsx", workbook),
            (
                "20260809-SWL-Audit-Summary.txt",
                b"Synthetic audit summary\n".to_vec(),
            ),
        ]
        .into_iter()
        .map(|(filename, bytes)| {
            (
                ExportBatchFileRequest {
                    filename: filename.to_string(),
                    length: bytes.len() as u64,
                    sha256: sha256_bytes(&bytes),
                },
                bytes,
            )
        })
        .collect()
    }

    fn insert_test_output_grant(state: &AppState, directory: &Path) -> String {
        let grant_id = Uuid::new_v4().to_string();
        safe_lock(&state.output_grants).unwrap().insert(
            grant_id.clone(),
            OutputGrant::new(directory.to_path_buf()).unwrap(),
        );
        grant_id
    }

    fn task_export_temporary_count(directory: &Path) -> usize {
        fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(is_task_export_temporary_name)
            })
            .count()
    }

    fn write_reserved_export_batch(
        state: &AppState,
        grant_id: &str,
        batch_id: &str,
        files: &[(ExportBatchFileRequest, Vec<u8>)],
    ) {
        for (request, bytes) in files {
            let session = begin_export_file_for_batch_inner(
                state,
                batch_id.to_string(),
                grant_id.to_string(),
                request.filename.clone(),
                request.length,
                request.sha256.clone(),
            )
            .unwrap();
            append_export_chunk_inner(
                state,
                session.session_id.clone(),
                0,
                base64::engine::general_purpose::STANDARD.encode(bytes),
            )
            .unwrap();
            assert_eq!(
                prepare_export_file_for_batch_inner(state, session.session_id).unwrap(),
                request.filename
            );
        }
    }

    fn synthetic_xlsx_zip_bomb() -> Vec<u8> {
        use std::io::Cursor;
        use zip::{write::SimpleFileOptions, ZipWriter};

        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, contents) in [
            ("[Content_Types].xml", "<Types/>"),
            ("xl/workbook.xml", "<workbook/>"),
            (
                "xl/worksheets/sheet1.xml",
                "<worksheet><sheetData><row r=\"1\"><c r=\"A1\"/></row></sheetData></worksheet>",
            ),
        ] {
            writer.start_file(name, stored).unwrap();
            writer.write_all(contents.as_bytes()).unwrap();
        }
        let compressed =
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        writer
            .start_file("xl/sharedStrings.xml", compressed)
            .unwrap();
        writer.write_all(&vec![b'x'; 2 * 1024 * 1024]).unwrap();
        writer.finish().unwrap().into_inner()
    }

    fn sample_configuration_envelope() -> ConfigurationEnvelope {
        let mut envelope = ConfigurationEnvelope {
            schema_version: CONFIGURATION_SCHEMA_VERSION,
            application: APPLICATION_ID.to_string(),
            exported_at: "2026-08-09T00:00:00Z".to_string(),
            counts: ConfigurationCounts {
                profiles: 0,
                aliases: 0,
                settings: 1,
            },
            data: ConfigurationData {
                profiles: Vec::new(),
                aliases: Vec::new(),
                settings: json!({
                    "markupPercent": "30",
                    "taxHandling": "not-configured",
                    "theme": "light",
                    "glassTint": "clear"
                }),
            },
            sha256: String::new(),
        };
        envelope.sha256 = configuration_payload_sha256(&envelope).unwrap();
        envelope
    }

    fn serialise_configuration_envelope(envelope: &ConfigurationEnvelope) -> String {
        serde_json::to_string(envelope).expect("serialise synthetic configuration")
    }

    fn insert_sample_catalogue(connection: &Connection) {
        let item = sample_catalogue_item();
        let snapshot = ProductMetadataVersionSnapshot {
            product_id: item.id.clone(),
            item_kind: item.item_kind.clone(),
            brand_id: item.brand_id.clone(),
            markup_override_hundredths: None,
            xero_reference: item.xero_reference.clone(),
            servicem8_reference: item.servicem8_reference.clone(),
            barcode_gtin: item.barcode.clone(),
            updated_at: item.updated_at.clone(),
        };
        let snapshot_json = validate_json(
            &serde_json::to_value(&snapshot).unwrap(),
            "Synthetic product metadata audit snapshot",
        )
        .unwrap();
        connection
            .execute(
                "INSERT INTO catalogue_items(id,item_number,description,cost_cents,sell_price_cents,gst_basis,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![item.id,item.item_number,item.description,item.cost_cents,item.sell_price_cents,item.gst_basis,item.updated_at],
            )
            .expect("insert synthetic catalogue item");
        connection
            .execute(
                "INSERT INTO product_metadata_versions(product_id,version,snapshot_json,changed_at) VALUES(?1,1,?2,?3)",
                params![snapshot.product_id, snapshot_json, snapshot.updated_at],
            )
            .expect("insert synthetic product metadata audit version");
    }

    fn mark_provider_validated(connection: &Connection) {
        connection
            .execute(
                "UPDATE provider_state SET last_validated_at='2026-08-09T00:00:00Z' WHERE provider=?1",
                params![PROVIDER_ID],
            )
            .unwrap();
    }

    fn enable_test_provider_budget(state: &AppState, connection: &Connection) -> ProviderStatus {
        mark_provider_validated(connection);
        set_provider_paid_calls_inner(state, connection, true, Some(100), Some(25)).unwrap()
    }

    fn stage_restore_journal(
        directory: &TestDirectory,
        target: &BackupSummary,
    ) -> (RestoreJournal, PathBuf, PathBuf) {
        let manifest = verify_backup(&directory.0, &target.id).unwrap();
        let (source, _) = backup_paths(&directory.0, &target.id).unwrap();
        let temporary_filename = format!(".swl-restore-{}.sqlite3", Uuid::new_v4());
        let rollback_filename = format!(".swl-rollback-{}.sqlite3", Uuid::new_v4());
        let temporary = directory.0.join(&temporary_filename);
        let rollback = directory.0.join(&rollback_filename);
        sqlite_backup(&source, &temporary).unwrap();
        sqlite_backup(&directory.database(), &rollback).unwrap();
        let rollback_connection = open_readonly_connection(&rollback).unwrap();
        let rollback_schema_version = schema_version_or_zero(&rollback_connection).unwrap();
        let rollback_record_counts =
            record_counts_for_version(&rollback_connection, rollback_schema_version).unwrap();
        drop(rollback_connection);
        let journal = RestoreJournal {
            version: 1,
            backup_id: target.id.clone(),
            temporary_filename,
            rollback_filename,
            target_schema_version: manifest.summary.schema_version,
            target_record_counts: manifest.summary.record_counts,
            rollback_schema_version,
            rollback_record_counts,
            rollback_sha256: sha256_file(&rollback).unwrap(),
            created_at: now_text(),
        };
        write_json_atomically(&directory.0.join(RESTORE_JOURNAL_FILENAME), &journal).unwrap();
        (journal, temporary, rollback)
    }

    fn create_partial_shell_database(path: &Path, cost_cents: i64) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE schema_metadata(version INTEGER NOT NULL);
                 INSERT INTO schema_metadata(version) VALUES(1);
                 CREATE TABLE catalogue_items(
                   id TEXT PRIMARY KEY,item_number TEXT NOT NULL UNIQUE,description TEXT NOT NULL,
                   cost_cents INTEGER NOT NULL CHECK(cost_cents >= 0),sell_price_cents INTEGER NOT NULL CHECK(sell_price_cents >= 0),
                   gst_basis TEXT NOT NULL CHECK(gst_basis IN ('inc-gst','ex-gst','unknown')),updated_at TEXT NOT NULL);
                 CREATE TABLE approvals(
                   id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES catalogue_items(id) ON DELETE RESTRICT,
                   approved_by TEXT NOT NULL,proposed_sell_cents INTEGER NOT NULL CHECK(proposed_sell_cents >= 0),
                   reason TEXT NOT NULL,approved_at TEXT NOT NULL);
                 CREATE TABLE price_history(
                   id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES catalogue_items(id) ON DELETE RESTRICT,
                   cost_cents INTEGER NOT NULL CHECK(cost_cents >= 0),sell_price_cents INTEGER NOT NULL CHECK(sell_price_cents >= 0),
                   approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE RESTRICT,recorded_at TEXT NOT NULL);
                 CREATE TRIGGER price_history_no_update BEFORE UPDATE ON price_history BEGIN SELECT RAISE(ABORT,'append-only'); END;
                 CREATE TRIGGER price_history_no_delete BEFORE DELETE ON price_history BEGIN SELECT RAISE(ABORT,'append-only'); END;
                 CREATE TABLE competitor_references(
                   id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES catalogue_items(id) ON DELETE RESTRICT,
                   observation_json TEXT NOT NULL,attached_at TEXT NOT NULL);
                 CREATE TABLE source_registry(id TEXT PRIMARY KEY,state_json TEXT NOT NULL,updated_at TEXT NOT NULL);
                 CREATE TABLE mapping_profiles(id TEXT PRIMARY KEY,profile_json TEXT NOT NULL,updated_at TEXT NOT NULL);
                 CREATE TABLE approved_aliases(supplier_code TEXT PRIMARY KEY,item_number TEXT NOT NULL,approved_at TEXT NOT NULL);
                 CREATE TABLE settings(id TEXT PRIMARY KEY CHECK(id='settings'),settings_json TEXT NOT NULL,updated_at TEXT NOT NULL);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO catalogue_items(id,item_number,description,cost_cents,sell_price_cents,gst_basis,updated_at)
                 VALUES('item-legacy','000042','Synthetic legacy lock',?1,910000000,'unknown','2026-08-09T00:00:00Z')",
                params![cost_cents],
            )
            .unwrap();
        connection
            .execute_batch(
                r#"INSERT INTO approvals(id,item_id,approved_by,proposed_sell_cents,reason,approved_at)
                   VALUES('approval-legacy','item-legacy','synthetic-operator',910000000,'Synthetic legacy approval','2026-08-09T00:00:00Z');
                 INSERT INTO price_history(id,item_id,cost_cents,sell_price_cents,approval_id,recorded_at)
                   VALUES('history-legacy','item-legacy',700000000,910000000,'approval-legacy','2026-08-09T00:00:00Z');
                 INSERT INTO competitor_references(id,item_id,observation_json,attached_at)
                   VALUES('reference-legacy','item-legacy','{"title":"Synthetic legacy evidence","priceCents":12345,"priceAud":"123.45","currency":"AUD","gstBasis":"unknown","packSize":null,"seller":"Synthetic seller","sourceDomain":"example.invalid","url":"https://example.invalid/item","retrievedAt":"2026-08-09T00:00:00Z"}','2026-08-09T00:00:00Z');"#,
            )
            .unwrap();
    }

    fn create_exact_legacy_wal_lifecycle(path: &Path) {
        let mut former_application = Connection::open(path).unwrap();
        former_application
            .execute_batch(
                "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
            )
            .unwrap();
        assert_eq!(
            former_application
                .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "wal"
        );
        assert_eq!(
            former_application
                .query_row("PRAGMA synchronous", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        let transaction = former_application.transaction().unwrap();
        transaction
            .execute_batch(
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
                 CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY CHECK(id='settings'), settings_json TEXT NOT NULL, updated_at TEXT NOT NULL);",
            )
            .unwrap();
        transaction.commit().unwrap();
        drop(former_application);

        let mut acceptance_seed = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )
        .unwrap();
        acceptance_seed
            .execute_batch(
                "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=0;",
            )
            .unwrap();
        acceptance_seed
            .set_db_config(
                rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
                true,
            )
            .unwrap();
        let transaction = acceptance_seed.transaction().unwrap();
        transaction
            .execute(
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
            )
            .unwrap();
        transaction
            .execute(
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
            )
            .unwrap();
        transaction
            .execute(
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
            )
            .unwrap();
        transaction.commit().unwrap();
        assert_exact_legacy_rows(&acceptance_seed);
        drop(acceptance_seed);
    }

    fn assert_exact_legacy_rows(connection: &Connection) {
        assert_eq!(
            connection
                .query_row(
                    "SELECT item_number,description,cost_cents,sell_price_cents,gst_basis,updated_at
                     FROM catalogue_items WHERE id='item-legacy'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                        ))
                    },
                )
                .unwrap(),
            (
                "000042".to_string(),
                "Synthetic legacy acceptance item".to_string(),
                10_000,
                13_000,
                "unknown".to_string(),
                "2026-08-09T00:00:00Z".to_string(),
            )
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT item_id,approved_by,proposed_sell_cents,reason,approved_at
                     FROM approvals WHERE id='approval-legacy'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    },
                )
                .unwrap(),
            (
                "item-legacy".to_string(),
                "synthetic-operator".to_string(),
                13_000,
                "Synthetic legacy acceptance approval".to_string(),
                "2026-08-09T00:00:00Z".to_string(),
            )
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT item_id,cost_cents,sell_price_cents,approval_id,recorded_at
                     FROM price_history WHERE id='history-legacy'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    },
                )
                .unwrap(),
            (
                "item-legacy".to_string(),
                10_000,
                13_000,
                "approval-legacy".to_string(),
                "2026-08-09T00:00:00Z".to_string(),
            )
        );
        let counts =
            record_counts_for_version(connection, schema_version_or_zero(connection).unwrap())
                .unwrap();
        assert_eq!(counts.catalogue_items, 1);
        assert_eq!(counts.approvals, 1);
        assert_eq!(counts.price_history, 1);
        assert_eq!(counts.competitor_references, 0);
        assert_eq!(counts.sources, 0);
        assert_eq!(counts.profiles, 0);
        assert_eq!(counts.aliases, 0);
        assert_eq!(counts.settings, 0);
    }

    #[test]
    fn migrations_are_ordered_idempotent_and_integral() {
        let directory = migrated_database();
        apply_migrations(&directory.database(), &directory.0).expect("idempotent migration");
        let connection = open_connection(&directory.database()).expect("open database");
        let versions = connection
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .expect("prepare migration query")
            .query_map([], |row| row.get::<_, i64>(0))
            .expect("query migrations")
            .collect::<Result<Vec<_>, _>>()
            .expect("read migrations");
        assert_eq!(versions, vec![1, 2, 3, 4, 5, 6]);
        assert_eq!(schema_version(&connection).unwrap(), CURRENT_SCHEMA_VERSION);
        assert_integrity(&connection).unwrap();
    }

    #[test]
    fn exact_schema3_migrates_once_with_legacy_offer_and_settings_preserved() {
        let directory = TestDirectory::new();
        let mut connection = open_connection_create(&directory.database()).unwrap();
        for (version, name, sql) in &MIGRATIONS[..3] {
            let transaction = connection.transaction().unwrap();
            transaction.execute_batch(sql).unwrap();
            transaction.execute("INSERT INTO schema_migrations(version,name,sha256,applied_at) VALUES(?1,?2,?3,'2026-08-09T00:00:00Z')",params![version,name,sha256_bytes(sql.as_bytes())]).unwrap();
            transaction.commit().unwrap();
        }
        connection.execute("INSERT INTO catalogue_items(id,item_number,description,cost_cents,sell_price_cents,gst_basis,updated_at) VALUES('schema3-item','S3-001','Schema 3 item',11000,13000,'inc-gst','2026-08-09T00:00:00Z')",[]).unwrap();
        connection.execute("INSERT INTO approvals(id,item_id,approved_by,proposed_sell_cents,reason,approved_at) VALUES('schema3-approval','schema3-item','operator',13000,'Schema 3 approval','2026-08-09T00:00:00Z')",[]).unwrap();
        connection.execute("INSERT INTO price_history(id,item_id,cost_cents,sell_price_cents,approval_id,recorded_at) VALUES('schema3-history','schema3-item',10000,13000,'schema3-approval','2026-08-09T00:00:00Z')",[]).unwrap();
        connection.execute("INSERT INTO settings(id,settings_json,updated_at) VALUES('settings','{\"markupPercent\":\"30\",\"taxHandling\":\"prices-inc-gst\",\"theme\":\"system\"}','2026-08-09T00:00:00Z')",[]).unwrap();
        drop(connection);
        apply_migrations(&directory.database(), &directory.0).unwrap();
        let connection = open_connection(&directory.database()).unwrap();
        assert_eq!(schema_version(&connection).unwrap(), CURRENT_SCHEMA_VERSION);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM product_supplier_offers WHERE id='legacy-offer-schema3-item' AND supplier_sku='S3-001' AND normalized_supplier_sku='s3-001' AND currency='AUD'",[],|row|row.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(
            connection
                .query_row(
                    "SELECT offer_id FROM product_offer_selections WHERE product_id='schema3-item'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "legacy-offer-schema3-item"
        );
        let settings: String = connection
            .query_row("SELECT settings_json FROM settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&settings).unwrap()["glassTint"],
            "clear"
        );
        let history = query_price_history(&connection, Some("schema3-item")).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].applied_markup_hundredths, None);
        assert_eq!(history[0].currency, None);
        assert_eq!(history[0].item_kind_snapshot, None);
        assert_eq!(history[0].pricing_rule_version, "legacy-unresolved");
        let history_json = serde_json::to_value(&history[0]).unwrap();
        assert!(history_json["appliedMarkupHundredths"].is_null());
        assert!(history_json["currency"].is_null());
        assert!(history_json["itemKind"].is_null());
        assert_eq!(
            record_counts(&connection).unwrap().supplier_offer_versions,
            1
        );
        assert_eq!(
            record_counts(&connection).unwrap().offer_selection_versions,
            1
        );
        let counts = record_counts(&connection).unwrap();
        assert_eq!(counts.supplier_versions, 1);
        assert_eq!(counts.brand_versions, 0);
        assert_eq!(counts.product_metadata_versions, 1);
        let supplier_snapshot: String = connection
            .query_row(
                "SELECT snapshot_json FROM supplier_versions WHERE supplier_id='legacy-supplier' AND version=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let supplier_snapshot: SupplierRecord = serde_json::from_str(&supplier_snapshot).unwrap();
        assert_eq!(supplier_snapshot.name, "Legacy catalogue supplier");
        assert!(supplier_snapshot.active);
        let product_snapshot: String = connection
            .query_row(
                "SELECT snapshot_json FROM product_metadata_versions WHERE product_id='schema3-item' AND version=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let product_snapshot: ProductMetadataVersionSnapshot =
            serde_json::from_str(&product_snapshot).unwrap();
        assert_eq!(product_snapshot.item_kind, "physical-product");
        assert_eq!(product_snapshot.markup_override_hundredths, None);
        apply_migrations(&directory.database(), &directory.0).unwrap();
        assert_eq!(
            record_counts(&connection).unwrap().product_supplier_offers,
            1
        );
        assert_integrity(&connection).unwrap();
    }

    #[test]
    fn schema5_merges_safe_brand_collisions_and_rolls_back_conflicting_facts() {
        fn schema4_database(directory: &TestDirectory, conflicting: bool) {
            let mut connection = open_connection_create(&directory.database()).unwrap();
            for (version, name, sql) in &MIGRATIONS[..4] {
                let transaction = connection.transaction().unwrap();
                transaction.execute_batch(sql).unwrap();
                transaction.execute("INSERT INTO schema_migrations(version,name,sha256,applied_at) VALUES(?1,?2,?3,'2026-08-09T00:00:00Z')",params![version,name,sha256_bytes(sql.as_bytes())]).unwrap();
                transaction.commit().unwrap();
            }
            connection.execute("INSERT INTO brands(id,name,markup_hundredths,updated_at) VALUES('brand-a',' Acme  Lock ',3500,'2026-08-09T00:00:00Z')",[]).unwrap();
            connection.execute("INSERT INTO brands(id,name,markup_hundredths,updated_at) VALUES('brand-b','acme lock',?1,'2026-08-09T00:00:00Z')",params![if conflicting { 4000 } else { 3500 }]).unwrap();
            connection.execute("INSERT INTO catalogue_items(id,item_number,description,cost_cents,sell_price_cents,gst_basis,sell_price_gst_basis,item_kind,brand_id,updated_at) VALUES('brand-item','BRAND-ITEM','Brand collision item',10000,13000,'ex-gst','ex-gst','physical-product','brand-b','2026-08-09T00:00:00Z')",[]).unwrap();
        }

        let safe = TestDirectory::new();
        schema4_database(&safe, false);
        apply_migrations(&safe.database(), &safe.0).unwrap();
        let connection = open_connection(&safe.database()).unwrap();
        assert_eq!(schema_version(&connection).unwrap(), CURRENT_SCHEMA_VERSION);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM brands", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT brand_id FROM catalogue_items WHERE id='brand-item'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "brand-a"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT name || '|' || canonical_key FROM brands WHERE id='brand-a'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "Acme Lock|acme lock"
        );
        let seeded_counts = record_counts(&connection).unwrap();
        assert_eq!(seeded_counts.supplier_versions, 0);
        assert_eq!(seeded_counts.brand_versions, 1);
        assert_eq!(seeded_counts.product_metadata_versions, 1);
        validate_current_database(&connection).unwrap();
        apply_migrations(&safe.database(), &safe.0).unwrap();
        assert_eq!(record_counts(&connection).unwrap(), seeded_counts);

        let conflicting = TestDirectory::new();
        schema4_database(&conflicting, true);
        assert!(apply_migrations(&conflicting.database(), &conflicting.0).is_err());
        let restored = open_connection(&conflicting.database()).unwrap();
        assert_eq!(schema_version(&restored).unwrap(), 4);
        assert_eq!(
            restored
                .query_row("SELECT COUNT(*) FROM brands", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert!(!table_exists(&restored, "supplier_offer_versions").unwrap());
    }

    #[test]
    fn schema6_validation_failure_restores_the_exact_schema5_database() {
        let directory = TestDirectory::new();
        let mut connection = open_connection_create(&directory.database()).unwrap();
        for (version, name, sql) in &MIGRATIONS[..5] {
            let transaction = connection.transaction().unwrap();
            transaction.execute_batch(sql).unwrap();
            if *version == 5 {
                prepare_schema5_canonical_keys(&transaction).unwrap();
            }
            transaction
                .execute(
                    "INSERT INTO schema_migrations(version,name,sha256,applied_at) VALUES(?1,?2,?3,'2026-08-09T00:00:00Z')",
                    params![version, name, sha256_bytes(sql.as_bytes())],
                )
                .unwrap();
            transaction.commit().unwrap();
        }
        connection
            .execute(
                "INSERT INTO suppliers(id,name,active,external_reference,updated_at)
                 VALUES('supplier-invalid-seed','Supplier Invalid Seed',1,'SUP-INVALID','not-a-timestamp')",
                [],
            )
            .unwrap();
        drop(connection);

        assert!(apply_migrations(&directory.database(), &directory.0).is_err());
        let restored = open_readonly_connection(&directory.database()).unwrap();
        assert_eq!(schema_version(&restored).unwrap(), 5);
        assert!(!table_exists(&restored, "supplier_versions").unwrap());
        assert!(!table_exists(&restored, "brand_versions").unwrap());
        assert!(!table_exists(&restored, "product_metadata_versions").unwrap());
        assert_eq!(
            restored
                .query_row(
                    "SELECT name || '|' || active || '|' || external_reference || '|' || updated_at
                     FROM suppliers WHERE id='supplier-invalid-seed'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "Supplier Invalid Seed|1|SUP-INVALID|not-a-timestamp"
        );
        assert_integrity(&restored).unwrap();
    }

    #[test]
    fn current_database_validation_rejects_missing_guards_and_semantic_corruption() {
        let directory = migrated_database();
        let connection = open_connection(&directory.database()).unwrap();
        connection
            .execute_batch("DROP TRIGGER approvals_no_update;")
            .unwrap();
        assert!(validate_current_database(&connection).is_err());
        drop(connection);
        assert!(apply_migrations(&directory.database(), &directory.0).is_err());

        let semantic = migrated_database();
        let connection = open_connection(&semantic.database()).unwrap();
        insert_sample_catalogue(&connection);
        connection
            .execute(
                "INSERT INTO competitor_references(id,item_id,observation_json,attached_at)
                 VALUES('bad-reference','item-001','{}','2026-08-09T00:00:00Z')",
                [],
            )
            .unwrap();
        assert!(validate_current_database(&connection).is_err());
        drop(connection);
        assert!(create_verified_backup_at(&semantic.database(), &semantic.0, "manual").is_err());
        assert_eq!(
            fs::read_dir(semantic.0.join(BACKUP_DIRECTORY))
                .unwrap()
                .filter_map(Result::ok)
                .count(),
            0,
            "a rejected semantic backup must not leave an orphan database or manifest"
        );

        let timestamp = migrated_database();
        let connection = open_connection(&timestamp.database()).unwrap();
        insert_sample_catalogue(&connection);
        connection
            .execute(
                "UPDATE catalogue_items SET updated_at='not-a-timestamp' WHERE id='item-001'",
                [],
            )
            .unwrap();
        assert!(validate_current_database(&connection).is_err());
    }

    #[test]
    fn text_validation_rejects_c0_and_del_controls() {
        assert!(validate_text("safe text", "Text", 32, false).is_ok());
        assert!(validate_text("line one\nline two", "Text", 64, false).is_err());
        assert!(validate_text("unsafe\u{7f}text", "Text", 64, false).is_err());
        assert!(validate_text("unsafe\u{1f}text", "Text", 64, false).is_err());
    }

    #[test]
    fn fresh_install_creates_database_only_through_verified_migrations() {
        let directory = TestDirectory::new();
        let database = directory.database();
        assert!(!database.exists());
        assert!(open_connection(&database).is_err());
        assert!(
            !database.exists(),
            "ordinary opens must never create a database"
        );
        apply_migrations(&database, &directory.0).unwrap();
        assert!(database.exists());
        let connection = open_connection(&database).unwrap();
        assert_eq!(schema_version(&connection).unwrap(), CURRENT_SCHEMA_VERSION);
        assert_integrity(&connection).unwrap();
    }

    #[test]
    fn former_partial_shell_schema_is_rebuilt_with_constraints_and_rows() {
        let directory = TestDirectory::new();
        create_partial_shell_database(&directory.database(), 700_000_000);
        apply_migrations(&directory.database(), &directory.0).unwrap();
        let connection = open_connection(&directory.database()).unwrap();
        assert_eq!(schema_version(&connection).unwrap(), CURRENT_SCHEMA_VERSION);
        let counts = record_counts(&connection).unwrap();
        assert_eq!(counts.catalogue_items, 1);
        assert_eq!(counts.approvals, 1);
        assert_eq!(counts.price_history, 1);
        assert_eq!(counts.competitor_references, 1);
        assert!(connection
            .execute(
                "INSERT INTO catalogue_items(id,item_number,description,cost_cents,sell_price_cents,gst_basis,updated_at)
                 VALUES('too-large','000043','Invalid',1000000001,1300000000,'unknown','2026-08-09T00:00:00Z')",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE approvals SET reason='must remain append-only' WHERE id='approval-legacy'",
                [],
            )
            .is_err());
        assert_integrity(&connection).unwrap();
    }

    #[test]
    fn exact_legacy_wal_lifecycle_is_backed_up_and_migrated_without_losing_seeded_rows() {
        let directory = TestDirectory::new();
        let database = directory.database();
        create_exact_legacy_wal_lifecycle(&database);

        let wal = PathBuf::from(format!("{}-wal", database.to_string_lossy()));
        assert!(
            wal.metadata().is_ok_and(|metadata| metadata.len() > 32),
            "the committed legacy rows must remain in a retained WAL"
        );
        let main_only = directory.0.join("main-only.sqlite3");
        fs::copy(&database, &main_only).unwrap();
        let main_only_connection = open_readonly_connection(&main_only).unwrap();
        assert_eq!(
            table_count(&main_only_connection, "catalogue_items").unwrap(),
            0,
            "the main file alone must not contain the seeded WAL rows"
        );
        drop(main_only_connection);

        apply_migrations(&database, &directory.0).unwrap();
        let migrated = open_connection(&database).unwrap();
        assert_eq!(schema_version(&migrated).unwrap(), CURRENT_SCHEMA_VERSION);
        assert_exact_legacy_rows(&migrated);
        assert_integrity(&migrated).unwrap();
        drop(migrated);

        let manifests = fs::read_dir(directory.0.join(BACKUP_DIRECTORY))
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
            .filter(|name| name.ends_with(".manifest.json"))
            .collect::<Vec<_>>();
        assert_eq!(manifests.len(), 1);
        let backup_id = manifests[0].strip_suffix(".manifest.json").unwrap();
        let backup = verify_backup(&directory.0, backup_id).unwrap();
        assert_eq!(backup.reason, "migration");
        assert_eq!(backup.summary.schema_version, 1);
        assert_eq!(backup.summary.record_counts.catalogue_items, 1);
        assert_eq!(backup.summary.record_counts.approvals, 1);
        assert_eq!(backup.summary.record_counts.price_history, 1);
        let (backup_database, _) = backup_paths(&directory.0, backup_id).unwrap();
        let backed_up = open_readonly_connection(&backup_database).unwrap();
        assert_exact_legacy_rows(&backed_up);
        assert_integrity(&backed_up).unwrap();
    }

    #[test]
    fn invalid_former_schema_rows_restore_the_verified_pre_migration_database() {
        let directory = TestDirectory::new();
        create_partial_shell_database(&directory.database(), 1_000_000_001);
        assert!(apply_migrations(&directory.database(), &directory.0).is_err());
        let connection = open_readonly_connection(&directory.database()).unwrap();
        assert!(!table_exists(&connection, "schema_migrations").unwrap());
        let cost: i64 = connection
            .query_row(
                "SELECT cost_cents FROM catalogue_items WHERE id='item-legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cost, 1_000_000_001);
        assert!(fs::read_dir(directory.0.join(BACKUP_DIRECTORY))
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".manifest.json")));
    }

    #[test]
    fn malformed_legacy_json_and_timestamps_fail_closed_with_verified_rollback() {
        for corruption in [
            "UPDATE competitor_references SET observation_json='{}'",
            "INSERT INTO source_registry(id,state_json,updated_at) VALUES('source-1','{}','2026-08-09T00:00:00Z')",
            "INSERT INTO mapping_profiles(id,profile_json,updated_at) VALUES('profile-1','{}','2026-08-09T00:00:00Z')",
            "INSERT INTO settings(id,settings_json,updated_at) VALUES('settings','{}','2026-08-09T00:00:00Z')",
            "UPDATE catalogue_items SET updated_at='not-a-timestamp'",
        ] {
            let directory = TestDirectory::new();
            create_partial_shell_database(&directory.database(), 700_000_000);
            let connection = Connection::open(directory.database()).unwrap();
            connection.execute_batch(corruption).unwrap();
            drop(connection);
            let migration_error=apply_migrations(&directory.database(), &directory.0).unwrap_err();
            let restored = open_readonly_connection(&directory.database()).unwrap();
            assert!(!table_exists(&restored, "schema_migrations").unwrap(), "rollback failed for {corruption}: {migration_error}");
            assert_integrity(&restored).unwrap();
        }
    }

    #[test]
    fn legacy_database_is_backed_up_before_any_migration_mutation_and_restored_on_failure() {
        let directory = TestDirectory::new();
        let legacy = Connection::open(directory.database()).unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE legacy_rows(id TEXT PRIMARY KEY,value TEXT NOT NULL);
                 INSERT INTO legacy_rows(id,value) VALUES('001','synthetic legacy value');",
            )
            .unwrap();
        let schema_before: String = legacy
            .query_row(
                "SELECT group_concat(sql,';') FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(legacy);

        const FAILING_MIGRATIONS: &[(i64, &str, &str)] =
            &[(1, "synthetic-failure", "THIS IS NOT SQL")];
        assert!(
            apply_migrations_with(&directory.database(), &directory.0, FAILING_MIGRATIONS,)
                .is_err()
        );

        let restored = open_readonly_connection(&directory.database()).unwrap();
        let schema_after: String = restored
            .query_row(
                "SELECT group_concat(sql,';') FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(schema_after, schema_before);
        assert!(!table_exists(&restored, "schema_migrations").unwrap());
        let value: String = restored
            .query_row("SELECT value FROM legacy_rows WHERE id='001'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(value, "synthetic legacy value");
        drop(restored);

        let backup = list_backups_inner(&AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        ))
        .unwrap()
        .into_iter()
        .find(|summary| summary.schema_version == 0)
        .expect("pre-migration legacy backup");
        let manifest = verify_backup(&directory.0, &backup.id).unwrap();
        assert_eq!(manifest.reason, "migration");
    }

    #[test]
    fn rejects_unknown_future_migration() {
        let directory = migrated_database();
        let connection = open_connection(&directory.database()).unwrap();
        connection
            .execute(
                "INSERT INTO schema_migrations(version,name,sha256,applied_at) VALUES(99,'future','x','now')",
                [],
            )
            .unwrap();
        drop(connection);
        assert!(apply_migrations(&directory.database(), &directory.0)
            .unwrap_err()
            .contains("unsupported"));
    }

    #[test]
    fn rejects_migration_name_or_checksum_drift() {
        let directory = migrated_database();
        let connection = open_connection(&directory.database()).unwrap();
        connection
            .execute(
                "UPDATE schema_migrations SET name='tampered' WHERE version=1",
                [],
            )
            .unwrap();
        drop(connection);
        assert!(apply_migrations(&directory.database(), &directory.0)
            .unwrap_err()
            .contains("failed verification"));
    }

    #[test]
    fn foreign_keys_and_append_only_triggers_are_enforced() {
        let directory = migrated_database();
        let connection = open_connection(&directory.database()).unwrap();
        assert!(connection
            .execute("INSERT INTO approvals(id,item_id,approved_by,proposed_sell_cents,reason,approved_at) VALUES('a','missing','operator',100,'test','now')", [])
            .is_err());
        insert_sample_catalogue(&connection);
        connection
            .execute("INSERT INTO approvals(id,item_id,approved_by,proposed_sell_cents,reason,approved_at) VALUES('a','item-001','operator',13000,'test','now')", [])
            .unwrap();
        connection
            .execute("INSERT INTO price_history(id,item_id,cost_cents,sell_price_cents,approval_id,recorded_at) VALUES('h','item-001',10000,13000,'a','now')", [])
            .unwrap();
        assert!(connection
            .execute("UPDATE approvals SET reason='changed' WHERE id='a'", [])
            .is_err());
        assert!(connection
            .execute("DELETE FROM price_history WHERE id='h'", [])
            .is_err());
    }

    #[test]
    fn markup_floor_matches_core_and_server_half_up_edges() {
        assert_eq!(minimum_sell_cents(0).unwrap(), 0);
        assert_eq!(minimum_sell_cents(1).unwrap(), 1);
        assert_eq!(minimum_sell_cents(5).unwrap(), 7);
        assert_eq!(minimum_sell_cents(100).unwrap(), 130);
        assert_eq!(minimum_sell_cents(101).unwrap(), 131);
        assert_eq!(minimum_sell_cents(999).unwrap(), 1_299);
        assert!(minimum_sell_cents(-1).is_err());
    }

    #[test]
    fn settings_markup_is_exact_and_never_below_thirty_percent() {
        assert_eq!(parse_markup_hundredths("30").unwrap(), 3_000);
        assert_eq!(parse_markup_hundredths("30.01").unwrap(), 3_001);
        assert_eq!(parse_markup_hundredths("999.99").unwrap(), 99_999);
        for invalid in ["29.99", "30.001", "1e2", "-30", "1000", "NaN"] {
            assert!(parse_markup_hundredths(invalid).is_err(), "{invalid}");
        }
        assert!(validate_settings(&json!({
            "markupPercent": "30",
            "taxHandling": "not-configured",
            "theme": "light",
            "glassTint": "clear",
            "providerSecret": "must-never-be-stored"
        }))
        .is_err());
        assert!(validate_timestamp("2026-08-09T12:34:56Z").is_ok());
        assert!(validate_timestamp("2026-08-09T12:34:56.789Z").is_ok());
        assert!(validate_timestamp("2026-02-30T12:34:56Z").is_err());
        assert!(validate_timestamp("2026-08-09T25:00:00Z").is_err());
        assert!(validate_settings(&json!({
            "markupPercent":"30","taxHandling":"prices-inc-gst","theme":"system","glassTint":"tinted"
        })).is_ok());
        assert!(validate_settings(&json!({
            "markupPercent":"30","taxHandling":"prices-inc-gst","theme":"system"
        }))
        .is_err());
        assert_eq!(parse_markup_override_hundredths("0").unwrap(), 0);
        assert_eq!(parse_markup_override_hundredths("12.34").unwrap(), 1_234);
        assert_eq!(parse_markup_override_hundredths("999.99").unwrap(), 99_999);
    }

    #[test]
    fn schema4_offer_constraints_reject_cross_product_and_multiple_preferred_sources() {
        let directory = migrated_database();
        let connection = open_connection(&directory.database()).unwrap();
        let first = sample_catalogue_item();
        insert_sample_catalogue(&connection);
        let mut second = first.clone();
        second.id = "item-002".to_string();
        second.item_number = "001235".to_string();
        connection.execute("INSERT INTO catalogue_items(id,item_number,description,cost_cents,sell_price_cents,gst_basis,sell_price_gst_basis,item_kind,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![second.id,second.item_number,second.description,second.cost_cents,second.sell_price_cents,second.gst_basis,second.sell_price_gst_basis,second.item_kind,second.updated_at]).unwrap();
        connection.execute("INSERT INTO suppliers(id,name,active,updated_at) VALUES('supplier-1','Supplier One',1,'2026-08-09T00:00:00Z')",[]).unwrap();
        connection.execute("INSERT INTO product_supplier_offers(id,product_id,supplier_id,supplier_sku,normalized_supplier_sku,cost_cents,gst_basis,currency,active,is_preferred,provenance_type,observed_at) VALUES('offer-1','item-001','supplier-1','SKU-1','sku-1',10000,'ex-gst','AUD',1,1,'manual','2026-08-09T00:00:00Z')",[]).unwrap();
        assert!(connection.execute("INSERT INTO product_supplier_offers(id,product_id,supplier_id,supplier_sku,normalized_supplier_sku,cost_cents,gst_basis,currency,active,is_preferred,provenance_type,observed_at) VALUES('offer-2','item-001','supplier-1','SKU-2','sku-2',9900,'ex-gst','AUD',1,1,'manual','2026-08-09T00:00:00Z')",[]).is_err());
        assert!(connection.execute("INSERT INTO product_offer_selections(product_id,offer_id,selected_by,reason,selected_at) VALUES('item-002','offer-1','operator','wrong owner','2026-08-09T00:00:00Z')",[]).is_err());
        connection.execute("INSERT INTO product_offer_selections(product_id,offer_id,selected_by,reason,selected_at) VALUES('item-001','offer-1','operator','approved source','2026-08-09T00:00:00Z')",[]).unwrap();
        assert_integrity(&connection).unwrap();
    }

    #[test]
    fn gst_inclusive_cost_and_sell_are_compared_on_ex_gst_basis() {
        let directory = migrated_database();
        let mut connection = open_connection(&directory.database()).unwrap();
        let valid = verified_supplier_publication(
            "gst-valid",
            "GST-VALID",
            11_000,
            "inc-gst",
            13_000,
            "ex-gst",
        );
        assert!(publish_approved_changes_inner(&mut connection, &[valid]).is_ok());
        let invalid = verified_supplier_publication(
            "gst-invalid",
            "GST-INVALID",
            10_000,
            "ex-gst",
            14_299,
            "inc-gst",
        );
        assert!(publish_approved_changes_inner(&mut connection, &[invalid]).is_err());
    }

    #[test]
    fn publication_requires_complete_pricing_provenance_for_every_item() {
        let directory = migrated_database();
        let mut connection = open_connection(&directory.database()).unwrap();
        let mut missing = verified_supplier_publication(
            "missing-provenance",
            "MISSING-PROV",
            10_000,
            "ex-gst",
            13_000,
            "ex-gst",
        );
        missing.pricing_provenance = None;
        let before = record_counts(&connection).unwrap();
        assert_eq!(
            publish_approved_changes_inner(&mut connection, &[missing]).unwrap_err(),
            "Verified pricing provenance is required for every publication."
        );
        assert_eq!(record_counts(&connection).unwrap(), before);

        let accepted = verified_supplier_publication(
            "existing-provenance",
            "EXISTING-PROV",
            10_000,
            "ex-gst",
            13_000,
            "ex-gst",
        );
        publish_approved_changes_inner(&mut connection, std::slice::from_ref(&accepted)).unwrap();
        let after_accepted = record_counts(&connection).unwrap();
        let mut missing_existing = accepted;
        missing_existing.pricing_provenance = None;
        assert!(publish_approved_changes_inner(&mut connection, &[missing_existing]).is_err());
        assert_eq!(record_counts(&connection).unwrap(), after_accepted);
    }

    #[test]
    fn publication_requires_the_exact_server_recomputed_sell_price() {
        let directory = migrated_database();
        let mut connection = open_connection(&directory.database()).unwrap();

        let global = verified_supplier_publication(
            "exact-global",
            "EXACT-GLOBAL",
            10_000,
            "ex-gst",
            13_000,
            "ex-gst",
        );
        publish_approved_changes_inner(&mut connection, &[global]).unwrap();

        connection.execute("INSERT INTO brands(id,name,markup_hundredths,updated_at,canonical_key) VALUES('brand-exact','Brand Exact',3500,'2026-08-09T00:00:00Z','brand exact')",[]).unwrap();
        let mut brand = verified_supplier_publication(
            "exact-brand",
            "EXACT-BRAND",
            10_000,
            "ex-gst",
            13_500,
            "ex-gst",
        );
        brand.item.brand_id = Some("brand-exact".to_string());
        let brand_provenance = brand.pricing_provenance.as_mut().unwrap();
        brand_provenance.brand_id = Some("brand-exact".to_string());
        brand_provenance.markup_percent = "35".to_string();
        brand_provenance.markup_source = "brand".to_string();
        brand_provenance.markup_source_id = Some("brand-exact".to_string());
        publish_approved_changes_inner(&mut connection, &[brand]).unwrap();

        let mut product = verified_supplier_publication(
            "exact-product",
            "EXACT-PRODUCT",
            10_000,
            "ex-gst",
            14_000,
            "ex-gst",
        );
        product.item.brand_id = Some("brand-exact".to_string());
        product.item.markup_override_percent = Some("40".to_string());
        let product_provenance = product.pricing_provenance.as_mut().unwrap();
        product_provenance.brand_id = Some("brand-exact".to_string());
        product_provenance.markup_percent = "40".to_string();
        product_provenance.markup_source = "product".to_string();
        product_provenance.markup_source_id = Some("exact-product".to_string());
        publish_approved_changes_inner(&mut connection, &[product]).unwrap();

        assert_eq!(
            expected_sell_cents(10_005, "inc-gst", 3_000, "ex-gst").unwrap(),
            11_824
        );
        let rounded = verified_supplier_publication(
            "exact-rounding",
            "EXACT-ROUNDING",
            10_005,
            "inc-gst",
            11_824,
            "ex-gst",
        );
        publish_approved_changes_inner(&mut connection, &[rounded]).unwrap();

        let above_floor_but_wrong = verified_supplier_publication(
            "exact-wrong",
            "EXACT-WRONG",
            10_000,
            "ex-gst",
            14_000,
            "ex-gst",
        );
        let before = record_counts(&connection).unwrap();
        assert_eq!(
            publish_approved_changes_inner(&mut connection, &[above_floor_but_wrong]).unwrap_err(),
            "The sell price does not equal the verified selected-offer price calculation."
        );
        assert_eq!(record_counts(&connection).unwrap(), before);
    }

    #[test]
    fn publication_rejects_a_selected_offer_owned_by_an_inactive_supplier() {
        let directory = migrated_database();
        let mut connection = open_connection(&directory.database()).unwrap();
        let accepted = verified_supplier_publication(
            "inactive-supplier",
            "INACTIVE-SUPPLIER",
            10_000,
            "ex-gst",
            13_000,
            "ex-gst",
        );
        publish_approved_changes_inner(&mut connection, std::slice::from_ref(&accepted)).unwrap();
        connection
            .execute(
                "UPDATE suppliers SET active=0 WHERE id='supplier-inactive-supplier'",
                [],
            )
            .unwrap();
        let mut retry = accepted;
        retry.item.updated_at = "2026-08-09T00:00:00.001Z".to_string();
        let before = record_counts(&connection).unwrap();
        assert_eq!(
            publish_approved_changes_inner(&mut connection, &[retry]).unwrap_err(),
            "An active selected supplier offer is required for publication."
        );
        assert_eq!(record_counts(&connection).unwrap(), before);
    }

    #[test]
    fn approved_publication_requires_a_strictly_newer_timestamp_and_rolls_back() {
        let directory = migrated_database();
        let mut connection = open_connection(&directory.database()).unwrap();
        let mut initial = verified_supplier_publication(
            "publication-time",
            "PUBLICATION-TIME",
            10_000,
            "ex-gst",
            13_000,
            "ex-gst",
        );
        initial.item.updated_at = "2026-08-09T00:00:00.001Z".to_string();
        publish_approved_changes_inner(&mut connection, std::slice::from_ref(&initial)).unwrap();

        let before = record_counts(&connection).unwrap();
        let before_digest = logical_database_digest(&connection).unwrap();
        let mut equal = initial.clone();
        equal.item.description = "Equal timestamp must not overwrite".to_string();
        equal.reason = "Equal timestamp retry".to_string();
        assert_eq!(
            publish_approved_changes_inner(&mut connection, std::slice::from_ref(&equal))
                .unwrap_err(),
            "The approved catalogue publication is stale; reload the latest product."
        );
        assert_eq!(record_counts(&connection).unwrap(), before);
        assert_eq!(logical_database_digest(&connection).unwrap(), before_digest);

        let mut older = initial.clone();
        older.item.updated_at = "2026-08-09T00:00:00Z".to_string();
        older.item.description = "Older timestamp must not overwrite".to_string();
        assert_eq!(
            publish_approved_changes_inner(&mut connection, &[older]).unwrap_err(),
            "The approved catalogue publication is stale; reload the latest product."
        );
        assert_eq!(record_counts(&connection).unwrap(), before);
        assert_eq!(logical_database_digest(&connection).unwrap(), before_digest);

        let batch_new = verified_supplier_publication(
            "publication-batch-new",
            "PUBLICATION-BATCH-NEW",
            10_000,
            "ex-gst",
            13_000,
            "ex-gst",
        );
        assert_eq!(
            publish_approved_changes_inner(&mut connection, &[batch_new, equal]).unwrap_err(),
            "The approved catalogue publication is stale; reload the latest product."
        );
        assert_eq!(record_counts(&connection).unwrap(), before);
        assert_eq!(logical_database_digest(&connection).unwrap(), before_digest);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM catalogue_items WHERE id='publication-batch-new'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );

        let mut newer = initial;
        newer.item.updated_at = "2026-08-09T00:00:00.002Z".to_string();
        newer.item.description = "Strictly newer publication".to_string();
        newer.reason = "Strictly newer timestamp".to_string();
        publish_approved_changes_inner(&mut connection, &[newer]).unwrap();
        let mut expected = before;
        expected.approvals += 1;
        expected.price_history += 1;
        expected.product_metadata_versions += 1;
        assert_eq!(record_counts(&connection).unwrap(), expected);
        assert_eq!(
            connection
                .query_row(
                    "SELECT description || '|' || updated_at FROM catalogue_items WHERE id='publication-time'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "Strictly newer publication|2026-08-09T00:00:00.002Z"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT changed_at FROM product_metadata_versions WHERE product_id='publication-time' AND version=2",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "2026-08-09T00:00:00.002Z"
        );
        validate_current_database(&connection).unwrap();
    }

    #[test]
    fn supplier_offer_mutations_are_stale_safe_audited_and_collision_rejecting() {
        let directory = migrated_database();
        let mut connection = open_connection(&directory.database()).unwrap();
        insert_sample_catalogue(&connection);
        connection.execute("INSERT INTO suppliers(id,name,active,updated_at) VALUES('supplier-audit','Supplier Audit',1,'2026-08-09T00:00:00Z')",[]).unwrap();
        let offer = SupplierOfferRecord {
            id: "offer-audit".to_string(),
            product_id: "item-001".to_string(),
            supplier_id: "supplier-audit".to_string(),
            supplier_sku: " SKU  Audit ".to_string(),
            cost_cents: 10_000,
            gst_basis: "ex-gst".to_string(),
            currency: "AUD".to_string(),
            active: true,
            is_preferred: true,
            valid_from: None,
            valid_until: None,
            provenance_type: "manual".to_string(),
            provenance_reference: None,
            observed_at: "2026-08-09T00:00:00Z".to_string(),
        };
        let stored = save_supplier_offer_inner(&mut connection, offer.clone()).unwrap();
        assert_eq!(stored.supplier_sku, "SKU Audit");
        assert_eq!(
            record_counts(&connection).unwrap().supplier_offer_versions,
            1
        );

        let mut stale = stored.clone();
        stale.cost_cents = 10_001;
        assert_eq!(
            save_supplier_offer_inner(&mut connection, stale).unwrap_err(),
            "The supplier offer update is stale; reload the latest offer."
        );
        assert_eq!(
            query_supplier_offer(&connection, "offer-audit")
                .unwrap()
                .cost_cents,
            10_000
        );
        assert_eq!(
            record_counts(&connection).unwrap().supplier_offer_versions,
            1
        );

        let mut newer = stored;
        newer.cost_cents = 10_001;
        newer.observed_at = "2026-08-09T00:00:00.001Z".to_string();
        save_supplier_offer_inner(&mut connection, newer).unwrap();
        assert_eq!(
            record_counts(&connection).unwrap().supplier_offer_versions,
            2
        );
        assert!(connection.execute("UPDATE supplier_offer_versions SET snapshot_json='{}' WHERE offer_id='offer-audit' AND version=1",[]).is_err());

        let mut duplicate_sku = offer.clone();
        duplicate_sku.id = "offer-duplicate-sku".to_string();
        duplicate_sku.supplier_sku = "sku audit".to_string();
        duplicate_sku.is_preferred = false;
        duplicate_sku.observed_at = "2026-08-09T00:00:01Z".to_string();
        assert!(save_supplier_offer_inner(&mut connection, duplicate_sku).is_err());

        let mut preferred_collision = offer;
        preferred_collision.id = "offer-preferred-collision".to_string();
        preferred_collision.supplier_sku = "OTHER-SKU".to_string();
        preferred_collision.observed_at = "2026-08-09T00:00:01Z".to_string();
        assert!(save_supplier_offer_inner(&mut connection, preferred_collision).is_err());
        assert_eq!(
            connection.query_row("SELECT COUNT(*) FROM product_supplier_offers WHERE product_id='item-001' AND is_preferred=1",[],|row|row.get::<_,i64>(0)).unwrap(),
            1
        );
        assert_eq!(
            record_counts(&connection).unwrap().supplier_offer_versions,
            2
        );
    }

    #[test]
    fn offer_selection_overwrites_are_stale_safe_atomic_and_audited() {
        let directory = migrated_database();
        let mut connection = open_connection(&directory.database()).unwrap();
        insert_sample_catalogue(&connection);
        connection.execute("INSERT INTO suppliers(id,name,active,updated_at) VALUES('supplier-selection','Supplier Selection',1,'2026-08-09T00:00:00Z')",[]).unwrap();
        for (id, sku) in [
            ("offer-select-a", "SELECT-A"),
            ("offer-select-b", "SELECT-B"),
        ] {
            save_supplier_offer_inner(
                &mut connection,
                SupplierOfferRecord {
                    id: id.to_string(),
                    product_id: "item-001".to_string(),
                    supplier_id: "supplier-selection".to_string(),
                    supplier_sku: sku.to_string(),
                    cost_cents: 10_000,
                    gst_basis: "ex-gst".to_string(),
                    currency: "AUD".to_string(),
                    active: true,
                    is_preferred: false,
                    valid_from: None,
                    valid_until: None,
                    provenance_type: "manual".to_string(),
                    provenance_reference: None,
                    observed_at: "2026-08-09T00:00:00Z".to_string(),
                },
            )
            .unwrap();
        }
        let first = OfferSelectionRecord {
            product_id: "item-001".to_string(),
            offer_id: "offer-select-a".to_string(),
            selected_by: "operator".to_string(),
            reason: "First selection".to_string(),
            selected_at: "2026-08-09T00:00:01Z".to_string(),
        };
        select_product_offer_inner(&mut connection, first.clone()).unwrap();
        assert_eq!(
            record_counts(&connection).unwrap().offer_selection_versions,
            1
        );
        let before = record_counts(&connection).unwrap();
        let mut stale = first;
        stale.offer_id = "offer-select-b".to_string();
        assert!(select_product_offer_inner(&mut connection, stale).is_err());
        assert_eq!(record_counts(&connection).unwrap(), before);
        assert_eq!(
            connection
                .query_row(
                    "SELECT offer_id FROM product_offer_selections WHERE product_id='item-001'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "offer-select-a"
        );

        let second = OfferSelectionRecord {
            product_id: "item-001".to_string(),
            offer_id: "offer-select-b".to_string(),
            selected_by: "operator".to_string(),
            reason: "Newer selection".to_string(),
            selected_at: "2026-08-09T00:00:02Z".to_string(),
        };
        select_product_offer_inner(&mut connection, second).unwrap();
        assert_eq!(
            record_counts(&connection).unwrap().offer_selection_versions,
            2
        );
        assert!(connection
            .execute(
                "DELETE FROM offer_selection_versions WHERE product_id='item-001' AND version=1",
                []
            )
            .is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT offer_id FROM product_offer_selections WHERE product_id='item-001'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "offer-select-b"
        );
    }

    #[test]
    fn brand_identity_is_canonical_and_case_whitespace_unique() {
        let directory = migrated_database();
        let mut connection = open_connection(&directory.database()).unwrap();
        let first = save_brand_inner(
            &mut connection,
            BrandRecord {
                id: "brand-a".to_string(),
                name: "  Acme   Lock  ".to_string(),
                markup_hundredths: Some(3_500),
                updated_at: "2026-08-09T00:00:00Z".to_string(),
            },
        )
        .unwrap();
        assert_eq!(first.name, "Acme Lock");
        assert!(save_brand_inner(
            &mut connection,
            BrandRecord {
                id: "brand-b".to_string(),
                name: "acme lock".to_string(),
                markup_hundredths: Some(3_500),
                updated_at: "2026-08-09T00:00:01Z".to_string(),
            },
        )
        .is_err());
        assert_eq!(
            connection
                .query_row(
                    "SELECT canonical_key FROM brands WHERE id='brand-a'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "acme lock"
        );
    }

    #[test]
    fn supplier_mutations_are_stale_safe_complete_and_append_only() {
        let directory = migrated_database();
        let mut connection = open_connection(&directory.database()).unwrap();
        let initial = SupplierRecord {
            id: "supplier-versioned".to_string(),
            name: "Supplier Versioned".to_string(),
            active: true,
            external_reference: Some("SUP-001".to_string()),
            updated_at: "2026-08-09T00:00:00Z".to_string(),
        };
        save_supplier_inner(&mut connection, initial.clone()).unwrap();
        assert_eq!(record_counts(&connection).unwrap().supplier_versions, 1);
        let first_json: String = connection
            .query_row(
                "SELECT snapshot_json FROM supplier_versions WHERE supplier_id=?1 AND version=1",
                params![initial.id],
                |row| row.get(0),
            )
            .unwrap();
        let first_value: Value = serde_json::from_str(&first_json).unwrap();
        assert_eq!(
            first_value
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<HashSet<_>>(),
            ["id", "name", "active", "externalReference", "updatedAt"]
                .into_iter()
                .map(str::to_string)
                .collect::<HashSet<_>>()
        );
        assert_eq!(
            serde_json::from_value::<SupplierRecord>(first_value).unwrap(),
            initial
        );

        let deactivated = SupplierRecord {
            id: "supplier-versioned".to_string(),
            name: "Supplier Versioned Updated".to_string(),
            active: false,
            external_reference: Some("SUP-002".to_string()),
            updated_at: "2026-08-09T00:00:00.001Z".to_string(),
        };
        save_supplier_inner(&mut connection, deactivated.clone()).unwrap();
        assert_eq!(record_counts(&connection).unwrap().supplier_versions, 2);

        let mut stale_reactivation = initial.clone();
        stale_reactivation.updated_at = deactivated.updated_at.clone();
        assert_eq!(
            save_supplier_inner(&mut connection, stale_reactivation).unwrap_err(),
            "The supplier update is stale; reload the latest supplier."
        );
        assert_eq!(record_counts(&connection).unwrap().supplier_versions, 2);

        let reactivated = SupplierRecord {
            active: true,
            updated_at: "2026-08-09T00:00:00.002Z".to_string(),
            ..deactivated.clone()
        };
        save_supplier_inner(&mut connection, reactivated.clone()).unwrap();
        let stale_deactivation = SupplierRecord {
            active: false,
            updated_at: deactivated.updated_at.clone(),
            ..reactivated.clone()
        };
        assert_eq!(
            save_supplier_inner(&mut connection, stale_deactivation).unwrap_err(),
            "The supplier update is stale; reload the latest supplier."
        );
        assert_eq!(record_counts(&connection).unwrap().supplier_versions, 3);
        let current: SupplierRecord = connection
            .query_row(
                "SELECT id,name,active,external_reference,updated_at FROM suppliers WHERE id=?1",
                params![reactivated.id],
                |row| {
                    Ok(SupplierRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        active: row.get(2)?,
                        external_reference: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .unwrap();
        assert_eq!(current, reactivated);
        assert!(connection
            .execute(
                "UPDATE supplier_versions SET snapshot_json='{}' WHERE supplier_id='supplier-versioned' AND version=1",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM supplier_versions WHERE supplier_id='supplier-versioned' AND version=1",
                [],
            )
            .is_err());
        validate_current_database(&connection).unwrap();
    }

    #[test]
    fn brand_and_product_pricing_inputs_are_stale_safe_and_audited() {
        let directory = migrated_database();
        let mut connection = open_connection(&directory.database()).unwrap();
        let brand = save_brand_inner(
            &mut connection,
            BrandRecord {
                id: "brand-versioned".to_string(),
                name: "  Versioned   Brand ".to_string(),
                markup_hundredths: Some(0),
                updated_at: "2026-08-09T00:00:00Z".to_string(),
            },
        )
        .unwrap();
        assert_eq!(brand.name, "Versioned Brand");
        let updated_brand = BrandRecord {
            markup_hundredths: Some(99_999),
            updated_at: "2026-08-09T00:00:00.001Z".to_string(),
            ..brand.clone()
        };
        save_brand_inner(&mut connection, updated_brand.clone()).unwrap();
        let stale_brand = BrandRecord {
            markup_hundredths: Some(3_000),
            ..updated_brand.clone()
        };
        assert_eq!(
            save_brand_inner(&mut connection, stale_brand).unwrap_err(),
            "The brand update is stale; reload the latest brand."
        );
        assert_eq!(record_counts(&connection).unwrap().brand_versions, 2);
        let latest_brand_json: String = connection
            .query_row(
                "SELECT snapshot_json FROM brand_versions WHERE brand_id=?1 ORDER BY version DESC LIMIT 1",
                params![updated_brand.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<BrandRecord>(&latest_brand_json).unwrap(),
            updated_brand
        );

        insert_sample_catalogue(&connection);
        let update = ProductMetadataUpdate {
            product_id: "item-001".to_string(),
            item_kind: "service".to_string(),
            brand_id: Some("brand-versioned".to_string()),
            markup_override_percent: Some("0".to_string()),
            xero_reference: Some("XERO-001".to_string()),
            servicem8_reference: Some("SM8-001".to_string()),
            barcode: Some("09312345678907".to_string()),
            updated_at: "2026-08-09T00:00:00.001Z".to_string(),
        };
        update_product_metadata_inner(&mut connection, update.clone()).unwrap();
        assert_eq!(
            record_counts(&connection)
                .unwrap()
                .product_metadata_versions,
            2
        );
        let latest = query_product_metadata_snapshot(&connection, "item-001").unwrap();
        assert_eq!(latest.item_kind, "service");
        assert_eq!(latest.brand_id.as_deref(), Some("brand-versioned"));
        assert_eq!(latest.markup_override_hundredths, Some(0));
        assert_eq!(latest.xero_reference.as_deref(), Some("XERO-001"));
        assert_eq!(latest.servicem8_reference.as_deref(), Some("SM8-001"));
        assert_eq!(latest.barcode_gtin.as_deref(), Some("09312345678907"));

        let stale_product = ProductMetadataUpdate {
            item_kind: "labour".to_string(),
            markup_override_percent: Some("30".to_string()),
            ..update.clone()
        };
        assert_eq!(
            update_product_metadata_inner(&mut connection, stale_product).unwrap_err(),
            "The product metadata update is stale; reload the latest product."
        );
        assert_eq!(
            query_product_metadata_snapshot(&connection, "item-001").unwrap(),
            latest
        );
        assert_eq!(
            record_counts(&connection)
                .unwrap()
                .product_metadata_versions,
            2
        );

        let invalid_brand = ProductMetadataUpdate {
            brand_id: Some("missing-brand".to_string()),
            updated_at: "2026-08-09T00:00:00.002Z".to_string(),
            ..update
        };
        assert!(update_product_metadata_inner(&mut connection, invalid_brand).is_err());
        assert_eq!(
            query_product_metadata_snapshot(&connection, "item-001").unwrap(),
            latest
        );
        assert_eq!(
            record_counts(&connection)
                .unwrap()
                .product_metadata_versions,
            2
        );
        assert!(connection
            .execute(
                "UPDATE brand_versions SET snapshot_json='{}' WHERE brand_id='brand-versioned' AND version=1",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM brand_versions WHERE brand_id='brand-versioned' AND version=1",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "UPDATE product_metadata_versions SET snapshot_json='{}' WHERE product_id='item-001' AND version=1",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "DELETE FROM product_metadata_versions WHERE product_id='item-001' AND version=1",
                [],
            )
            .is_err());
        validate_current_database(&connection).unwrap();
    }

    #[test]
    fn new_supplier_offer_publication_is_atomic_and_provenance_verified() {
        let directory = migrated_database();
        let mut connection = open_connection(&directory.database()).unwrap();
        let provenance = PricingProvenance {
            selected_offer_id: Some("offer-new".to_string()),
            supplier_id: Some("supplier-new".to_string()),
            supplier_name: Some("Supplier New".to_string()),
            supplier_sku: Some("SUP-NEW-001".to_string()),
            cost_gst_basis: "ex-gst".to_string(),
            currency: "AUD".to_string(),
            markup_percent: "30".to_string(),
            markup_source: "global".to_string(),
            markup_source_id: None,
            brand_id: None,
            item_kind: "physical-product".to_string(),
            sell_price_gst_basis: "ex-gst".to_string(),
            explanation: "Client explanation with operator-facing detail that is not trusted as a structural fact."
                .to_string(),
            rule_version: "pricing-rule-v1".to_string(),
        };
        let payload = json!({
            "item": {
                "id": "item-new",
                "itemNumber": "NEW-001",
                "description": "Synthetic test lock",
                "costCents": 10000,
                "sellPriceCents": 13000,
                "gstBasis": "ex-gst",
                "sellPriceGstBasis": "ex-gst",
                "itemKind": "physical-product",
                "brandId": null,
                "markupOverridePercent": null,
                "xeroReference": null,
                "servicem8Reference": null,
                "barcodeGtin": "09312345678907",
                "selectedOfferId": "offer-new",
                "updatedAt": "2026-08-09T00:00:00Z"
            },
            "approvedBy": "operator",
            "reason": "Initial supplier-file publication",
            "pricingProvenance": serde_json::to_value(&provenance).unwrap()
        });
        let change: PublishApprovedChange = serde_json::from_value(payload).unwrap();
        let published = publish_approved_changes_inner(&mut connection, &[change]).unwrap();
        assert_eq!(
            published[0].price_history.supplier_name_snapshot.as_deref(),
            Some("Supplier New")
        );
        assert_eq!(
            record_counts(&connection).unwrap().product_supplier_offers,
            1
        );
        assert_eq!(
            record_counts(&connection).unwrap().product_offer_selections,
            1
        );
        assert_eq!(record_counts(&connection).unwrap().supplier_versions, 1);
        assert_eq!(
            record_counts(&connection)
                .unwrap()
                .product_metadata_versions,
            1
        );
        assert_eq!(
            published[0].price_history.pricing_explanation,
            "Selected supplier offer with global markup applied to GST-exclusive cost"
        );
        assert_eq!(
            published[0].price_history.pricing_rule_version,
            "pricing-rule-v1"
        );

        let mut item = published[0].item.clone();
        item.updated_at = "2026-08-09T00:00:01Z".to_string();
        let mut stale_claims = Vec::new();
        let mut changed_offer = provenance.clone();
        changed_offer.selected_offer_id = Some("offer-stale".to_string());
        stale_claims.push(changed_offer);
        let mut changed_markup = provenance.clone();
        changed_markup.markup_percent = "31".to_string();
        stale_claims.push(changed_markup);
        let mut changed_gst = provenance.clone();
        changed_gst.cost_gst_basis = "inc-gst".to_string();
        stale_claims.push(changed_gst);
        let mut changed_kind = provenance;
        changed_kind.item_kind = "service".to_string();
        stale_claims.push(changed_kind);
        for stale in stale_claims {
            assert!(publish_approved_changes_inner(
                &mut connection,
                &[PublishApprovedChange {
                    item: item.clone(),
                    approved_by: "operator".to_string(),
                    reason: "Stale provenance".to_string(),
                    pricing_provenance: Some(stale)
                }]
            )
            .is_err());
        }
        assert_eq!(record_counts(&connection).unwrap().approvals, 1);
    }

    #[test]
    fn ipc_json_shapes_match_the_typescript_contract() {
        let mut item = sample_catalogue_item();
        item.barcode = Some("09312345678907".to_string());
        let item_json = serde_json::to_value(&item).unwrap();
        assert_eq!(item_json["barcodeGtin"], "09312345678907");
        assert!(item_json.get("barcode").is_none());

        let metadata = ProductMetadataUpdate {
            product_id: item.id.clone(),
            item_kind: item.item_kind.clone(),
            brand_id: None,
            markup_override_percent: Some("0".to_string()),
            xero_reference: None,
            servicem8_reference: None,
            barcode: item.barcode.clone(),
            updated_at: item.updated_at.clone(),
        };
        let metadata_json = serde_json::to_value(&metadata).unwrap();
        assert_eq!(metadata_json["barcodeGtin"], "09312345678907");
        assert!(metadata_json.get("barcode").is_none());

        let history = PriceHistoryRecord {
            id: "history-contract".to_string(),
            item_id: item.id.clone(),
            cost: "100.00".to_string(),
            sell_price: "130.00".to_string(),
            cost_cents: 10_000,
            sell_price_cents: 13_000,
            approval_id: "approval-contract".to_string(),
            selected_offer_id: Some("offer-contract".to_string()),
            cost_basis_cents: 10_000,
            markup_source_type: "global".to_string(),
            markup_source_id: None,
            applied_markup_hundredths: None,
            supplier_id_snapshot: Some("supplier-contract".to_string()),
            supplier_name_snapshot: Some("Supplier Contract".to_string()),
            supplier_sku_snapshot: Some("SUP-001".to_string()),
            cost_gst_basis: "unknown".to_string(),
            sell_price_gst_basis: "unknown".to_string(),
            currency: Some("AUD".to_string()),
            brand_id_snapshot: None,
            item_kind_snapshot: Some("physical-product".to_string()),
            pricing_explanation: "Server-derived explanation".to_string(),
            pricing_rule_version: "pricing-rule-v1".to_string(),
            provenance_state: "resolved".to_string(),
            recorded_at: "2026-08-09T00:00:00Z".to_string(),
        };
        let history_json = serde_json::to_value(&history).unwrap();
        for key in [
            "supplierId",
            "supplierName",
            "supplierSku",
            "brandId",
            "itemKind",
            "ruleVersion",
            "sellPriceGstBasis",
        ] {
            assert!(history_json.get(key).is_some(), "missing {key}");
        }
        for key in [
            "supplierIdSnapshot",
            "supplierNameSnapshot",
            "supplierSkuSnapshot",
            "brandIdSnapshot",
            "itemKindSnapshot",
            "pricingRuleVersion",
        ] {
            assert!(history_json.get(key).is_none(), "unexpected {key}");
        }
        assert!(history_json["appliedMarkupHundredths"].is_null());

        let outcome = SyncItemOutcomeRecord {
            id: "outcome-contract".to_string(),
            run_id: "run-contract".to_string(),
            item_id: Some(item.id),
            external_id: None,
            action: "compare".to_string(),
            status: "succeeded".to_string(),
            message: "Matched".to_string(),
            idempotency_key: "run-contract:item-001".to_string(),
            attempt_count: 1,
            retryable: false,
            error_class: None,
            reconciliation: "matched".to_string(),
            recorded_at: "2026-08-09T00:00:00Z".to_string(),
        };
        let outcome_json = serde_json::to_value(&outcome).unwrap();
        assert_eq!(outcome_json["reconciliation"], "matched");
        assert!(outcome_json.get("reconciliationResult").is_none());
    }

    #[test]
    fn offer_validity_order_uses_parsed_utc_timestamps() {
        let mut offer = SupplierOfferRecord {
            id: "offer-time".to_string(),
            product_id: "item-001".to_string(),
            supplier_id: "supplier-time".to_string(),
            supplier_sku: "TIME-001".to_string(),
            cost_cents: 10_000,
            gst_basis: "unknown".to_string(),
            currency: "AUD".to_string(),
            active: true,
            is_preferred: false,
            valid_from: Some("2026-08-09T00:00:00Z".to_string()),
            valid_until: Some("2026-08-09T00:00:00.001Z".to_string()),
            provenance_type: "manual".to_string(),
            provenance_reference: None,
            observed_at: "2026-08-09T00:00:00Z".to_string(),
        };
        assert!(validate_offer(&offer).is_ok());
        offer.valid_from = Some("2026-08-09T00:00:00.001Z".to_string());
        offer.valid_until = Some("2026-08-09T00:00:00Z".to_string());
        assert_eq!(
            validate_offer(&offer).unwrap_err(),
            "Offer validity dates are inconsistent."
        );
    }

    #[test]
    fn catalogue_money_changes_require_one_atomic_approval_publication() {
        let directory = migrated_database();
        let mut connection = open_connection(&directory.database()).unwrap();
        insert_sample_catalogue(&connection);

        let mut changed = sample_catalogue_item();
        changed.cost_cents += 1;
        assert!(update_catalogue_metadata(&mut connection, &[changed]).is_err());
        let mut changed_gst = sample_catalogue_item();
        changed_gst.gst_basis = "inc-gst".to_string();
        assert!(update_catalogue_metadata(&mut connection, &[changed_gst]).is_err());
        let stored: (i64, i64) = connection
            .query_row(
                "SELECT cost_cents,sell_price_cents FROM catalogue_items WHERE id='item-001'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored, (10_000, 13_000));

        let mut new_item = sample_catalogue_item();
        new_item.id = "item-002".to_string();
        new_item.item_number = "000002".to_string();
        assert!(update_catalogue_metadata(&mut connection, &[new_item.clone()]).is_err());

        let approved = verified_supplier_publication(
            &new_item.id,
            &new_item.item_number,
            new_item.cost_cents,
            "ex-gst",
            new_item.sell_price_cents,
            "ex-gst",
        );
        let published = publish_approved_changes_inner(&mut connection, &[approved]).unwrap();
        assert_eq!(published.len(), 1);
        assert_eq!(record_counts(&connection).unwrap().catalogue_items, 2);
        assert_eq!(record_counts(&connection).unwrap().approvals, 1);
        assert_eq!(record_counts(&connection).unwrap().price_history, 1);

        let below_floor =
            verified_supplier_publication("item-003", "000003", 10_000, "ex-gst", 12_999, "ex-gst");
        let before = record_counts(&connection).unwrap();
        assert!(publish_approved_changes_inner(&mut connection, &[below_floor],).is_err());
        assert_eq!(record_counts(&connection).unwrap(), before);
    }

    #[test]
    fn writable_ipc_dtos_reject_unknown_fields_before_database_mutation() {
        let directory = migrated_database();
        let connection = open_connection(&directory.database()).unwrap();
        insert_sample_catalogue(&connection);
        let source = SourceRecord {
            id: "manual-source".to_string(),
            name: "Synthetic manual source".to_string(),
            access_method: "manual-entry".to_string(),
            automated_access_note: "No automated access".to_string(),
            enabled: true,
        };
        connection
            .execute(
                "INSERT INTO source_registry(id,state_json,updated_at) VALUES(?1,?2,?3)",
                params![
                    source.id.clone(),
                    serde_json::to_string(&source).unwrap(),
                    "2026-08-09T00:00:00Z"
                ],
            )
            .unwrap();
        let before = record_counts(&connection).unwrap();
        drop(connection);

        let valid_change = PublishApprovedChange {
            item: sample_catalogue_item(),
            approved_by: "synthetic-operator".to_string(),
            reason: "Synthetic approval".to_string(),
            pricing_provenance: None,
        };
        let mut outer_unknown = serde_json::to_value(&valid_change).unwrap();
        outer_unknown
            .as_object_mut()
            .unwrap()
            .insert("rawSupplierRow".to_string(), json!("must not cross IPC"));
        assert!(serde_json::from_value::<PublishApprovedChange>(outer_unknown).is_err());

        let mut nested_unknown = serde_json::to_value(&valid_change).unwrap();
        nested_unknown
            .get_mut("item")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("privateNote".to_string(), json!("must not cross IPC"));
        assert!(serde_json::from_value::<PublishApprovedChange>(nested_unknown).is_err());

        let mut source_unknown = serde_json::to_value(source).unwrap();
        source_unknown
            .as_object_mut()
            .unwrap()
            .insert("apiKey".to_string(), json!("must not cross IPC"));
        assert!(serde_json::from_value::<SourceRecord>(source_unknown).is_err());

        let connection = open_connection(&directory.database()).unwrap();
        assert_eq!(record_counts(&connection).unwrap(), before);
    }

    #[test]
    fn approved_publication_overwrite_creates_backup_and_appends_evidence() {
        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let first =
            verified_supplier_publication("item-001", "001234", 10_000, "ex-gst", 13_000, "ex-gst");
        publish_approved_changes_at(&state, std::slice::from_ref(&first)).unwrap();
        assert!(list_backups_inner(&state).unwrap().is_empty());
        let mut second = first;
        second.item.updated_at = "2026-08-09T00:00:00.001Z".to_string();
        second.item.sell_price_cents = 14_000;
        second.item.markup_override_percent = Some("40".to_string());
        second.reason = "Synthetic approved price change".to_string();
        let provenance = second.pricing_provenance.as_mut().unwrap();
        provenance.markup_percent = "40".to_string();
        provenance.markup_source = "product".to_string();
        provenance.markup_source_id = Some(second.item.id.clone());
        publish_approved_changes_at(&state, &[second]).unwrap();
        let backups = list_backups_inner(&state).unwrap();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            read_backup_manifest(&state.data_dir, &backups[0].id)
                .unwrap()
                .reason,
            "approved-publication"
        );
        let connection = open_connection(&state.database_path).unwrap();
        assert_eq!(query_approvals(&connection, None).unwrap().len(), 2);
        assert_eq!(query_price_history(&connection, None).unwrap().len(), 2);
    }

    #[test]
    fn overwriting_configuration_records_creates_verified_backups() {
        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let mut profile = MappingProfileRecord {
            id: "profile-001".to_string(),
            name: "Synthetic profile".to_string(),
            version: 1,
            supplier_mapping: BTreeMap::new(),
            supplier_headers: Vec::new(),
            servicem8_mapping: BTreeMap::new(),
            servicem8_headers: Vec::new(),
            created_at: "2026-08-09T00:00:00Z".to_string(),
            updated_at: "2026-08-09T00:00:00Z".to_string(),
        };
        save_mapping_profile_inner(&state, profile.clone()).unwrap();
        profile.name = "Synthetic profile revised".to_string();
        save_mapping_profile_inner(&state, profile).unwrap();

        let mut alias = AliasRecord {
            supplier_code: "0001".to_string(),
            item_number: "001234".to_string(),
            approved_at: "2026-08-09T00:00:00Z".to_string(),
        };
        save_alias_inner(&state, alias.clone()).unwrap();
        alias.item_number = "001235".to_string();
        save_alias_inner(&state, alias).unwrap();

        save_settings_inner(
            &state,
            json!({
                "markupPercent": "30",
                "taxHandling": "not-configured",
                "theme": "light",
                "glassTint": "clear"
            }),
        )
        .unwrap();
        save_settings_inner(
            &state,
            json!({
                "markupPercent": "35",
                "taxHandling": "not-configured",
                "theme": "dark",
                "glassTint": "clear"
            }),
        )
        .unwrap();

        let reasons = list_backups_inner(&state)
            .unwrap()
            .iter()
            .map(|backup| {
                read_backup_manifest(&state.data_dir, &backup.id)
                    .unwrap()
                    .reason
            })
            .collect::<HashSet<_>>();
        assert!(reasons.contains("overwrite-profile"));
        assert!(reasons.contains("overwrite-alias"));
        assert!(reasons.contains("overwrite-settings"));
    }

    #[test]
    fn verified_backup_round_trip_restores_exact_counts() {
        let directory = migrated_database();
        let connection = open_connection(&directory.database()).unwrap();
        insert_sample_catalogue(&connection);
        drop(connection);
        let backup =
            create_verified_backup_at(&directory.database(), &directory.0, "manual").unwrap();
        let connection = open_connection(&directory.database()).unwrap();
        connection
            .execute(
                "INSERT INTO settings(id,settings_json,updated_at) VALUES('settings','{\"markupPercent\":\"30\",\"taxHandling\":\"not-configured\",\"theme\":\"light\",\"glassTint\":\"clear\"}','now')",
                [],
            )
            .unwrap();
        drop(connection);
        restore_backup_files(&directory.database(), &directory.0, &backup.id).unwrap();
        let restored = open_connection(&directory.database()).unwrap();
        assert_eq!(record_counts(&restored).unwrap(), backup.record_counts);
        assert_integrity(&restored).unwrap();
    }

    #[test]
    fn pricing_rule_audit_ledgers_survive_backup_restore_and_reset_cleanly() {
        let directory = migrated_database();
        let mut connection = open_connection(&directory.database()).unwrap();
        save_supplier_inner(
            &mut connection,
            SupplierRecord {
                id: "supplier-recovery".to_string(),
                name: "Supplier Recovery".to_string(),
                active: true,
                external_reference: Some("SUP-RECOVERY".to_string()),
                updated_at: "2026-08-09T00:00:00Z".to_string(),
            },
        )
        .unwrap();
        save_brand_inner(
            &mut connection,
            BrandRecord {
                id: "brand-recovery".to_string(),
                name: "Brand Recovery".to_string(),
                markup_hundredths: Some(3_500),
                updated_at: "2026-08-09T00:00:00Z".to_string(),
            },
        )
        .unwrap();
        insert_sample_catalogue(&connection);
        update_product_metadata_inner(
            &mut connection,
            ProductMetadataUpdate {
                product_id: "item-001".to_string(),
                item_kind: "physical-product".to_string(),
                brand_id: Some("brand-recovery".to_string()),
                markup_override_percent: Some("40".to_string()),
                xero_reference: Some("XERO-RECOVERY".to_string()),
                servicem8_reference: Some("SM8-RECOVERY".to_string()),
                barcode: Some("09312345678907".to_string()),
                updated_at: "2026-08-09T00:00:00.001Z".to_string(),
            },
        )
        .unwrap();
        validate_current_database(&connection).unwrap();
        drop(connection);

        let backup =
            create_verified_backup_at(&directory.database(), &directory.0, "manual").unwrap();
        assert_eq!(backup.record_counts.supplier_versions, 1);
        assert_eq!(backup.record_counts.brand_versions, 1);
        assert_eq!(backup.record_counts.product_metadata_versions, 2);

        let mut connection = open_connection(&directory.database()).unwrap();
        let transaction = connection.transaction().unwrap();
        delete_operational_data(&transaction).unwrap();
        transaction.commit().unwrap();
        assert_eq!(
            record_counts(&connection).unwrap(),
            BackupRecordCounts::default()
        );
        validate_current_database(&connection).unwrap();
        drop(connection);

        restore_backup_files(&directory.database(), &directory.0, &backup.id).unwrap();
        let restored = open_connection(&directory.database()).unwrap();
        assert_eq!(record_counts(&restored).unwrap(), backup.record_counts);
        validate_current_database(&restored).unwrap();
        let latest_product = query_product_metadata_snapshot(&restored, "item-001").unwrap();
        assert_eq!(latest_product.brand_id.as_deref(), Some("brand-recovery"));
        assert_eq!(latest_product.markup_override_hundredths, Some(4_000));
    }

    #[test]
    fn non_monotonic_pricing_rule_audits_block_current_validation_and_backups() {
        let supplier_directory = migrated_database();
        let mut supplier_connection = open_connection(&supplier_directory.database()).unwrap();
        let mut supplier = SupplierRecord {
            id: "supplier-time-tamper".to_string(),
            name: "Supplier Time Tamper".to_string(),
            active: true,
            external_reference: Some("SUP-TIME".to_string()),
            updated_at: "2026-08-09T00:00:00Z".to_string(),
        };
        save_supplier_inner(&mut supplier_connection, supplier.clone()).unwrap();
        supplier.name = "Supplier Time Tamper Revised".to_string();
        supplier.active = false;
        supplier.updated_at = "2026-08-09T00:00:00.001Z".to_string();
        save_supplier_inner(&mut supplier_connection, supplier.clone()).unwrap();
        validate_current_database(&supplier_connection).unwrap();
        let mut tampered_supplier = supplier;
        tampered_supplier.updated_at = "2026-08-09T00:00:00Z".to_string();
        let tampered_supplier_json = validate_json(
            &serde_json::to_value(&tampered_supplier).unwrap(),
            "Synthetic supplier audit tamper",
        )
        .unwrap();
        supplier_connection
            .execute_batch("DROP TRIGGER supplier_versions_no_update;")
            .unwrap();
        supplier_connection
            .execute(
                "UPDATE supplier_versions SET snapshot_json=?1,changed_at=?2 WHERE supplier_id=?3 AND version=2",
                params![tampered_supplier_json,tampered_supplier.updated_at,tampered_supplier.id],
            )
            .unwrap();
        supplier_connection
            .execute(
                "UPDATE suppliers SET updated_at=?1 WHERE id=?2",
                params![tampered_supplier.updated_at, tampered_supplier.id],
            )
            .unwrap();
        supplier_connection
            .execute_batch("CREATE TRIGGER supplier_versions_no_update BEFORE UPDATE ON supplier_versions BEGIN SELECT RAISE(ABORT,'append-only'); END;")
            .unwrap();
        assert_eq!(
            validate_current_database(&supplier_connection).unwrap_err(),
            "Supplier audit versions failed verification."
        );
        drop(supplier_connection);
        assert_eq!(
            create_verified_backup_at(
                &supplier_directory.database(),
                &supplier_directory.0,
                "manual"
            )
            .unwrap_err(),
            "Supplier audit versions failed verification."
        );
        assert_eq!(
            fs::read_dir(supplier_directory.0.join(BACKUP_DIRECTORY))
                .unwrap()
                .filter_map(Result::ok)
                .count(),
            0
        );

        let brand_directory = migrated_database();
        let mut brand_connection = open_connection(&brand_directory.database()).unwrap();
        let mut brand = BrandRecord {
            id: "brand-time-tamper".to_string(),
            name: "Brand Time Tamper".to_string(),
            markup_hundredths: Some(3_000),
            updated_at: "2026-08-09T00:00:00Z".to_string(),
        };
        save_brand_inner(&mut brand_connection, brand.clone()).unwrap();
        brand.name = "Brand Time Tamper Revised".to_string();
        brand.markup_hundredths = Some(4_000);
        brand.updated_at = "2026-08-09T00:00:00.001Z".to_string();
        let brand = save_brand_inner(&mut brand_connection, brand).unwrap();
        validate_current_database(&brand_connection).unwrap();
        let mut tampered_brand = brand;
        tampered_brand.updated_at = "2026-08-09T00:00:00Z".to_string();
        let tampered_brand_json = validate_json(
            &serde_json::to_value(&tampered_brand).unwrap(),
            "Synthetic brand audit tamper",
        )
        .unwrap();
        brand_connection
            .execute_batch("DROP TRIGGER brand_versions_no_update;")
            .unwrap();
        brand_connection
            .execute(
                "UPDATE brand_versions SET snapshot_json=?1,changed_at=?2 WHERE brand_id=?3 AND version=2",
                params![tampered_brand_json,tampered_brand.updated_at,tampered_brand.id],
            )
            .unwrap();
        brand_connection
            .execute(
                "UPDATE brands SET updated_at=?1 WHERE id=?2",
                params![tampered_brand.updated_at, tampered_brand.id],
            )
            .unwrap();
        brand_connection
            .execute_batch("CREATE TRIGGER brand_versions_no_update BEFORE UPDATE ON brand_versions BEGIN SELECT RAISE(ABORT,'append-only'); END;")
            .unwrap();
        assert_eq!(
            validate_current_database(&brand_connection).unwrap_err(),
            "Brand audit versions failed verification."
        );
        drop(brand_connection);
        assert_eq!(
            create_verified_backup_at(&brand_directory.database(), &brand_directory.0, "manual")
                .unwrap_err(),
            "Brand audit versions failed verification."
        );
        assert_eq!(
            fs::read_dir(brand_directory.0.join(BACKUP_DIRECTORY))
                .unwrap()
                .filter_map(Result::ok)
                .count(),
            0
        );

        let product_directory = migrated_database();
        let mut product_connection = open_connection(&product_directory.database()).unwrap();
        insert_sample_catalogue(&product_connection);
        update_product_metadata_inner(
            &mut product_connection,
            ProductMetadataUpdate {
                product_id: "item-001".to_string(),
                item_kind: "service".to_string(),
                brand_id: None,
                markup_override_percent: Some("40".to_string()),
                xero_reference: Some("XERO-TIME".to_string()),
                servicem8_reference: Some("SM8-TIME".to_string()),
                barcode: Some("09312345678907".to_string()),
                updated_at: "2026-08-09T00:00:00.001Z".to_string(),
            },
        )
        .unwrap();
        validate_current_database(&product_connection).unwrap();
        let mut tampered_product =
            query_product_metadata_snapshot(&product_connection, "item-001").unwrap();
        tampered_product.updated_at = "2026-08-09T00:00:00Z".to_string();
        let tampered_product_json = validate_json(
            &serde_json::to_value(&tampered_product).unwrap(),
            "Synthetic product metadata audit tamper",
        )
        .unwrap();
        product_connection
            .execute_batch("DROP TRIGGER product_metadata_versions_no_update;")
            .unwrap();
        product_connection
            .execute(
                "UPDATE product_metadata_versions SET snapshot_json=?1,changed_at=?2 WHERE product_id=?3 AND version=2",
                params![tampered_product_json,tampered_product.updated_at,tampered_product.product_id],
            )
            .unwrap();
        product_connection
            .execute(
                "UPDATE catalogue_items SET updated_at=?1 WHERE id=?2",
                params![tampered_product.updated_at, tampered_product.product_id],
            )
            .unwrap();
        product_connection
            .execute_batch("CREATE TRIGGER product_metadata_versions_no_update BEFORE UPDATE ON product_metadata_versions BEGIN SELECT RAISE(ABORT,'append-only'); END;")
            .unwrap();
        assert_eq!(
            validate_current_database(&product_connection).unwrap_err(),
            "Product metadata audit versions failed verification."
        );
        drop(product_connection);
        assert_eq!(
            create_verified_backup_at(
                &product_directory.database(),
                &product_directory.0,
                "manual"
            )
            .unwrap_err(),
            "Product metadata audit versions failed verification."
        );
        assert_eq!(
            fs::read_dir(product_directory.0.join(BACKUP_DIRECTORY))
                .unwrap()
                .filter_map(Result::ok)
                .count(),
            0
        );
    }

    #[test]
    fn startup_recovery_rolls_back_a_restore_interrupted_before_activation() {
        let directory = migrated_database();
        let target =
            create_verified_backup_at(&directory.database(), &directory.0, "manual").unwrap();
        let connection = open_connection(&directory.database()).unwrap();
        insert_sample_catalogue(&connection);
        drop(connection);
        let (journal, temporary, rollback) = stage_restore_journal(&directory, &target);
        assert!(temporary.exists());
        assert!(rollback.exists());

        recover_interrupted_restore(&directory.database(), &directory.0).unwrap();
        let live = open_connection(&directory.database()).unwrap();
        assert_eq!(
            record_counts(&live).unwrap(),
            journal.rollback_record_counts
        );
        assert_eq!(record_counts(&live).unwrap().catalogue_items, 1);
        assert!(!directory.0.join(RESTORE_JOURNAL_FILENAME).exists());
        assert!(!temporary.exists());
        assert!(!rollback.exists());
    }

    #[test]
    fn startup_recovery_finishes_a_restore_interrupted_after_atomic_activation() {
        let directory = migrated_database();
        let target =
            create_verified_backup_at(&directory.database(), &directory.0, "manual").unwrap();
        let connection = open_connection(&directory.database()).unwrap();
        insert_sample_catalogue(&connection);
        drop(connection);
        let (journal, temporary, rollback) = stage_restore_journal(&directory, &target);
        remove_sqlite_sidecars(&directory.database());
        atomic_replace_database(&temporary, &directory.database()).unwrap();

        recover_interrupted_restore(&directory.database(), &directory.0).unwrap();
        let live = open_connection(&directory.database()).unwrap();
        assert_eq!(record_counts(&live).unwrap(), journal.target_record_counts);
        assert_eq!(record_counts(&live).unwrap().catalogue_items, 0);
        assert!(!directory.0.join(RESTORE_JOURNAL_FILENAME).exists());
        assert!(!rollback.exists());
    }

    #[test]
    fn backup_manifest_detects_database_tampering() {
        let directory = migrated_database();
        let backup =
            create_verified_backup_at(&directory.database(), &directory.0, "manual").unwrap();
        let (database_backup, _) = backup_paths(&directory.0, &backup.id).unwrap();
        OpenOptions::new()
            .append(true)
            .open(database_backup)
            .unwrap()
            .write_all(b"tamper")
            .unwrap();
        assert!(verify_backup(&directory.0, &backup.id)
            .unwrap_err()
            .contains("checksum"));
    }

    #[test]
    fn backup_identifiers_are_generated_only_and_confined() {
        for invalid in [
            "../escape",
            "20260809-SWL-Backup-../../escape",
            "20260230-SWL-Backup-00000000-0000-0000-0000-000000000000",
            "20260809-SWL-Backup-00000000-0000-0000-0000-000000000000/extra",
            "20260809-swl-backup-00000000-0000-0000-0000-000000000000",
        ] {
            assert!(backup_paths(Path::new("/synthetic/app-data"), invalid).is_err());
        }
        let valid = "20260809-SWL-Backup-00000000-0000-0000-0000-000000000000";
        let paths = backup_paths(Path::new("/synthetic/app-data"), valid).unwrap();
        assert_eq!(
            paths.0.parent(),
            Some(Path::new("/synthetic/app-data/backups"))
        );
        assert_eq!(
            paths.1.parent(),
            Some(Path::new("/synthetic/app-data/backups"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn backup_manifest_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;

        let directory = migrated_database();
        let backup =
            create_verified_backup_at(&directory.database(), &directory.0, "manual").unwrap();
        let (_, manifest_path) = backup_paths(&directory.0, &backup.id).unwrap();
        let displaced = directory.0.join("manifest-real.json");
        fs::rename(&manifest_path, &displaced).unwrap();
        symlink(&displaced, &manifest_path).unwrap();
        assert!(verify_backup(&directory.0, &backup.id).is_err());
    }

    #[test]
    fn failed_restore_validation_leaves_live_database_usable() {
        let directory = migrated_database();
        let connection = open_connection(&directory.database()).unwrap();
        insert_sample_catalogue(&connection);
        drop(connection);
        let backup =
            create_verified_backup_at(&directory.database(), &directory.0, "manual").unwrap();
        let (database_backup, _) = backup_paths(&directory.0, &backup.id).unwrap();
        OpenOptions::new()
            .append(true)
            .open(database_backup)
            .unwrap()
            .write_all(b"tamper")
            .unwrap();
        assert!(restore_backup_files(&directory.database(), &directory.0, &backup.id).is_err());
        let live = open_connection(&directory.database()).unwrap();
        assert_eq!(record_counts(&live).unwrap().catalogue_items, 1);
        assert_integrity(&live).unwrap();
    }

    #[test]
    fn failed_post_restore_migration_recovers_the_pre_restore_database() {
        let directory = migrated_database();
        let selected =
            create_verified_backup_at(&directory.database(), &directory.0, "manual").unwrap();
        let connection = open_connection(&directory.database()).unwrap();
        insert_sample_catalogue(&connection);
        drop(connection);

        let error = restore_with_postcheck(
            &directory.database(),
            &directory.0,
            &selected.id,
            |_database, _data_dir| Err("synthetic post-restore migration failure".to_string()),
        )
        .unwrap_err();
        assert!(error.contains("before restore was recovered"));
        let live = open_connection(&directory.database()).unwrap();
        assert_eq!(record_counts(&live).unwrap().catalogue_items, 1);
        assert_integrity(&live).unwrap();
    }

    #[test]
    fn restore_never_reenables_paid_provider_calls_from_backup() {
        let directory = migrated_database();
        let store = Arc::new(MemoryCredentialStore::default());
        store.set("synthetic-secret-123").unwrap();
        let state = AppState::new(directory.0.clone(), store.clone());
        let connection = open_connection(&state.database_path).unwrap();
        enable_test_provider_budget(&state, &connection);
        drop(connection);
        let selected =
            create_verified_backup_at(&state.database_path, &state.data_dir, "manual").unwrap();
        store.remove().unwrap();

        restore_with_postcheck(
            &state.database_path,
            &state.data_dir,
            &selected.id,
            apply_migrations_and_reset_provider_policy,
        )
        .unwrap();
        let restored = open_connection(&state.database_path).unwrap();
        let status = provider_status_inner(&state, &restored).unwrap();
        assert!(!status.paid_calls_enabled);
        assert!(status.last_validated_at.is_none());
        assert!(!status.credential_configured);
    }

    #[test]
    fn reset_deletes_only_documented_operational_tables_and_recreates_guards() {
        let directory = migrated_database();
        let mut connection = open_connection(&directory.database()).unwrap();
        insert_sample_catalogue(&connection);
        let transaction = connection.transaction().unwrap();
        delete_operational_data(&transaction).unwrap();
        transaction.commit().unwrap();
        assert_eq!(
            record_counts(&connection).unwrap(),
            BackupRecordCounts::default()
        );
        let trigger_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN (
                   'approvals_no_delete','price_history_no_delete','settings_audit_no_delete',
                   'sync_item_outcomes_no_delete','supplier_offer_versions_no_delete',
                   'offer_selection_versions_no_delete','supplier_versions_no_delete',
                   'brand_versions_no_delete','product_metadata_versions_no_delete')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(trigger_count, 9);
        let provider_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM provider_state", [], |row| row.get(0))
            .unwrap();
        assert_eq!(provider_count, 1);
    }

    #[test]
    fn reset_removes_provider_state_and_credential_after_verified_database_reset() {
        let directory = migrated_database();
        let store = Arc::new(MemoryCredentialStore::default());
        store.set("synthetic-secret-123").unwrap();
        let state = AppState::new(directory.0.clone(), store.clone());
        let connection = open_connection(&state.database_path).unwrap();
        insert_sample_catalogue(&connection);
        enable_test_provider_budget(&state, &connection);
        drop(connection);
        let pending = take_reset_preview(&state);

        reset_application_data_inner(&state, pending).unwrap();
        let connection = open_connection(&state.database_path).unwrap();
        assert_eq!(
            record_counts(&connection).unwrap(),
            BackupRecordCounts::default()
        );
        let status = provider_status_inner(&state, &connection).unwrap();
        assert!(!status.paid_calls_enabled);
        assert!(!status.credential_configured);
    }

    #[test]
    fn failed_credential_removal_restores_database_from_before_reset() {
        let directory = migrated_database();
        let store = Arc::new(FailingRemoveCredentialStore::default());
        store.set("synthetic-secret-123").unwrap();
        let state = AppState::new(directory.0.clone(), store);
        let connection = open_connection(&state.database_path).unwrap();
        insert_sample_catalogue(&connection);
        enable_test_provider_budget(&state, &connection);
        drop(connection);
        let pending = take_reset_preview(&state);

        assert!(reset_application_data_inner(&state, pending).is_err());
        let connection = open_connection(&state.database_path).unwrap();
        assert_eq!(record_counts(&connection).unwrap().catalogue_items, 1);
        let status = provider_status_inner(&state, &connection).unwrap();
        assert!(status.paid_calls_enabled);
        assert!(status.credential_configured);
    }

    #[test]
    fn malformed_and_bad_checksum_configuration_are_rejected() {
        let data = ConfigurationData {
            profiles: Vec::new(),
            aliases: Vec::new(),
            settings: json!({
                "markupPercent": "30",
                "taxHandling": "not-configured",
                "theme": "light",
                "glassTint": "clear"
            }),
        };
        let mut envelope = ConfigurationEnvelope {
            schema_version: 1,
            application: APPLICATION_ID.to_string(),
            exported_at: "2026-08-09T00:00:00Z".to_string(),
            counts: ConfigurationCounts {
                profiles: 0,
                aliases: 0,
                settings: 1,
            },
            data,
            sha256: String::new(),
        };
        envelope.sha256 = configuration_payload_sha256(&envelope).unwrap();
        assert!(verify_configuration_checksum(&envelope));
        let mut tampered = envelope.clone();
        tampered.data.settings["markupPercent"] = json!("31");
        assert!(!verify_configuration_checksum(&tampered));
        assert!(serde_json::from_str::<ConfigurationEnvelope>("not-json").is_err());
    }

    #[test]
    fn pretty_reordered_and_legacy_browser_configuration_payloads_have_semantic_checksums() {
        let envelope = sample_configuration_envelope();
        let reordered = format!(
            "{{\n  \"sha256\": {},\n  \"data\": {},\n  \"counts\": {},\n  \"exportedAt\": {},\n  \"application\": {},\n  \"schemaVersion\": {}\n}}",
            serde_json::to_string(&envelope.sha256).unwrap(),
            serde_json::to_string_pretty(&envelope.data).unwrap(),
            serde_json::to_string_pretty(&envelope.counts).unwrap(),
            serde_json::to_string(&envelope.exported_at).unwrap(),
            serde_json::to_string(&envelope.application).unwrap(),
            envelope.schema_version,
        );
        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let preview = preview_configuration_import_inner(&state, reordered).unwrap();
        assert!(preview.valid);
        let pending = safe_lock(&state.pending_imports)
            .unwrap()
            .remove(&preview.preview_token)
            .unwrap();
        assert_eq!(
            apply_configuration_import_inner(&state, pending).unwrap(),
            envelope.counts
        );

        let mut legacy = sample_configuration_envelope();
        legacy.sha256 = legacy_configuration_payload_sha256(&legacy).unwrap();
        assert!(verify_configuration_checksum(&legacy));
        let legacy_directory = migrated_database();
        let legacy_state = AppState::new(
            legacy_directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let legacy_preview = preview_configuration_import_inner(
            &legacy_state,
            serde_json::to_string_pretty(&legacy).unwrap(),
        )
        .unwrap();
        assert!(legacy_preview.valid);
    }

    #[test]
    fn conflicting_configuration_import_leaves_live_data_unchanged() {
        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let connection = open_connection(&state.database_path).unwrap();
        connection
            .execute(
                "INSERT INTO settings(id,settings_json,updated_at) VALUES('settings',?1,'now')",
                params![r#"{"markupPercent":"35","taxHandling":"not-configured","theme":"dark","glassTint":"clear"}"#],
            )
            .unwrap();
        let envelope = sample_configuration_envelope();
        let serialised = serialise_configuration_envelope(&envelope);
        let conflicts = configuration_conflicts(&connection, &envelope).unwrap();
        assert_eq!(conflicts.settings, 1);
        let before = record_counts(&connection).unwrap();
        let before_settings: String = connection
            .query_row(
                "SELECT settings_json FROM settings WHERE id='settings'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(connection);
        let preview = preview_configuration_import_inner(&state, serialised).unwrap();
        assert!(!preview.valid);
        assert_eq!(preview.conflicts.settings, 1);
        assert_eq!(preview.validation_messages.len(), 1);
        let pending = PendingImport {
            source_id: configuration_source_sha256(&envelope).unwrap(),
            content_sha256: envelope.sha256.clone(),
            envelope,
            conflicts,
            created_at: Instant::now(),
        };
        assert!(apply_configuration_import_inner(&state, pending).is_err());
        let connection = open_connection(&state.database_path).unwrap();
        assert_eq!(record_counts(&connection).unwrap(), before);
        let after_settings: String = connection
            .query_row(
                "SELECT settings_json FROM settings WHERE id='settings'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(after_settings, before_settings);
    }

    #[test]
    fn exact_configuration_reimport_is_valid_idempotent_and_no_mutation() {
        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let envelope = sample_configuration_envelope();
        let serialised = serialise_configuration_envelope(&envelope);
        let first_preview = preview_configuration_import_inner(&state, serialised.clone()).unwrap();
        assert!(first_preview.valid);
        let first_pending = safe_lock(&state.pending_imports)
            .unwrap()
            .remove(&first_preview.preview_token)
            .unwrap();
        apply_configuration_import_inner(&state, first_pending).unwrap();

        let connection = open_connection(&state.database_path).unwrap();
        let before_counts = record_counts(&connection).unwrap();
        let before_settings: String = connection
            .query_row(
                "SELECT settings_json FROM settings WHERE id='settings'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(connection);
        let backups_before = list_backups_inner(&state).unwrap().len();
        let second_preview = preview_configuration_import_inner(&state, serialised).unwrap();
        assert!(second_preview.valid);
        assert!(!second_preview.conflicts.any());
        assert_eq!(second_preview.validation_messages.len(), 1);
        let second_pending = safe_lock(&state.pending_imports)
            .unwrap()
            .remove(&second_preview.preview_token)
            .unwrap();
        assert_eq!(
            apply_configuration_import_inner(&state, second_pending).unwrap(),
            envelope.counts
        );
        let connection = open_connection(&state.database_path).unwrap();
        assert_eq!(record_counts(&connection).unwrap(), before_counts);
        let after_settings: String = connection
            .query_row(
                "SELECT settings_json FROM settings WHERE id='settings'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(after_settings, before_settings);
        assert_eq!(list_backups_inner(&state).unwrap().len(), backups_before);
    }

    #[test]
    fn migration_status_is_bound_to_the_exact_stable_legacy_source() {
        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let envelope_a = sample_configuration_envelope();
        let preview_a = preview_configuration_import_inner(
            &state,
            serialise_configuration_envelope(&envelope_a),
        )
        .unwrap();
        let pending_a = safe_lock(&state.pending_imports)
            .unwrap()
            .remove(&preview_a.preview_token)
            .unwrap();
        apply_configuration_import_inner(&state, pending_a).unwrap();

        let connection = open_connection(&state.database_path).unwrap();
        let ledger: (String, String) = connection
            .query_row(
                "SELECT source_id,content_sha256 FROM configuration_imports",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(ledger.0, configuration_source_sha256(&envelope_a).unwrap());
        assert_eq!(ledger.1, envelope_a.sha256);
        drop(connection);

        let mut regenerated_a = envelope_a.clone();
        regenerated_a.exported_at = "2026-08-09T01:00:00Z".to_string();
        regenerated_a.sha256 = configuration_payload_sha256(&regenerated_a).unwrap();
        assert_ne!(regenerated_a.sha256, envelope_a.sha256);
        let same_status = configuration_migration_status_inner(
            &state,
            Some(serialise_configuration_envelope(&regenerated_a)),
        )
        .unwrap();
        assert!(same_status.already_imported);

        let mut envelope_b = regenerated_a;
        envelope_b.exported_at = "2026-08-09T02:00:00Z".to_string();
        envelope_b.data.aliases.push(AliasRecord {
            supplier_code: "legacy-supplier-002".to_string(),
            item_number: "000002".to_string(),
            approved_at: "2026-08-09T00:00:00Z".to_string(),
        });
        envelope_b.counts.aliases = 1;
        envelope_b.sha256 = configuration_payload_sha256(&envelope_b).unwrap();
        let distinct_status = configuration_migration_status_inner(
            &state,
            Some(serialise_configuration_envelope(&envelope_b)),
        )
        .unwrap();
        assert!(distinct_status.legacy_configuration_found);
        assert!(!distinct_status.already_imported);
        assert_eq!(distinct_status.counts.aliases, 1);

        let distinct_preview = preview_configuration_import_inner(
            &state,
            serialise_configuration_envelope(&envelope_b),
        )
        .unwrap();
        assert!(!distinct_preview.preview_token.is_empty());
        assert_eq!(distinct_preview.conflicts.settings, 1);
    }

    #[test]
    fn reset_preview_drives_the_shared_exact_confirmation_phrase() {
        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let preview = preview_reset_inner(&state).unwrap();
        assert_eq!(preview.confirmation_phrase, "ERASE SWL LOCAL DATA");
        assert!(preview
            .scope
            .iter()
            .any(|item| item.contains("provider state")));
        assert!(validate_reset_confirmation(&preview.confirmation_phrase).is_ok());
        assert!(validate_reset_confirmation("DELETE SWL APPLICATION DATA").is_err());
    }

    #[test]
    fn reset_preview_rejects_same_count_record_or_credential_substitution() {
        let directory = migrated_database();
        let store = Arc::new(MemoryCredentialStore::default());
        store.set("synthetic-secret-123").unwrap();
        let state = AppState::new(directory.0.clone(), store.clone());
        let connection = open_connection(&state.database_path).unwrap();
        insert_sample_catalogue(&connection);
        drop(connection);

        let record_pending = take_reset_preview(&state);
        let backups_before = list_backups_inner(&state).unwrap().len();
        let connection = open_connection(&state.database_path).unwrap();
        connection
            .execute(
                "UPDATE catalogue_items SET description='Synthetic substituted description' WHERE id='item-001'",
                [],
            )
            .unwrap();
        drop(connection);
        assert!(reset_application_data_inner(&state, record_pending).is_err());
        assert_eq!(list_backups_inner(&state).unwrap().len(), backups_before);
        let connection = open_connection(&state.database_path).unwrap();
        assert_eq!(record_counts(&connection).unwrap().catalogue_items, 1);
        drop(connection);

        let credential_pending = take_reset_preview(&state);
        store.set("synthetic-replacement-456").unwrap();
        assert!(reset_application_data_inner(&state, credential_pending).is_err());
        let connection = open_connection(&state.database_path).unwrap();
        assert_eq!(record_counts(&connection).unwrap().catalogue_items, 1);
    }

    #[test]
    fn shopping_discovery_returns_only_token_bearing_product_clusters() {
        let payload = json!({
            "search_metadata": {
                "status": "Success",
                "created_at": "2026-08-10 23:00:00 UTC",
                "processed_at": "2026-08-10 23:00:02 UTC"
            },
            "search_parameters": {
                "engine": "google_shopping",
                "location": "Geelong, Victoria, Australia"
            },
            "shopping_results": [{
                "position": 1,
                "title": "Lockwood 001 Double Cylinder Deadlatch",
                "product_id": "product-main",
                "product_link": "https://www.google.com.au/shopping/product/product-main?gl=au",
                "immersive_product_page_token": "token-main",
                "multiple_sources": true,
                "price": "A$129.00",
                "extracted_price": 129.0
            }],
            "inline_shopping_results": [{
                "position": 2,
                "block_position": "top",
                "title": "Inline merchant advertisement",
                "price": "$135.50",
                "extracted_price": 135.5,
                "link": "https://inline-merchant.example.test/products/lock"
            }],
            "categorized_shopping_results": [{
                "title": "Related locks",
                "shopping_results": [{
                    "position": 3,
                    "title": "Used Lockwood 001 Double Cylinder Deadlatch",
                    "product_id": "product-used",
                    "product_link": "https://www.google.com.au/shopping/product/product-used?gl=au",
                    "immersive_product_page_token": "token-used",
                    "price": "$80.00",
                    "extracted_price": 80.0,
                    "second_hand_condition": "Used"
                }, {
                    "position": 4,
                    "title": "Duplicate Lockwood cluster",
                    "product_id": "product-main",
                    "product_link": "https://www.google.com.au/shopping/product/product-main?gl=au",
                    "immersive_product_page_token": "token-main",
                    "price": "$129.00",
                    "extracted_price": 129.0
                }]
            }]
        });

        let outcome =
            parse_shopping_discovery(&payload, "Lockwood 001", "Geelong, Victoria, Australia")
                .unwrap();
        assert_eq!(outcome.state, "selection_required");
        assert!(outcome.results.is_empty());
        assert!(outcome.band.is_none());
        assert_eq!(
            outcome.retrieved_at.as_deref(),
            Some("2026-08-10T23:00:02Z")
        );
        assert_eq!(outcome.candidates.len(), 2);
        assert_eq!(outcome.candidates[0].token, "token-main");
        assert_eq!(outcome.candidates[0].price_cents, Some(12_900));
        assert_eq!(outcome.candidates[1].condition, "used");
        let coverage = outcome.coverage.unwrap();
        assert_eq!(coverage.provider_candidates, 2);
        assert_eq!(coverage.parsed_offers, 0);
        assert_eq!(coverage.comparable_offers, 0);
    }

    #[test]
    fn provider_parameters_are_localised_and_stage_specific() {
        let discovery = provider_request_parameters(
            "LW4570",
            None,
            "synthetic-key",
            "Geelong, Victoria, Australia",
        )
        .unwrap()
        .into_iter()
        .collect::<HashMap<_, _>>();
        assert_eq!(
            discovery.get("engine").map(String::as_str),
            Some("google_shopping")
        );
        assert_eq!(discovery.get("q").map(String::as_str), Some("\"LW4570\""));
        assert_eq!(
            discovery.get("google_domain").map(String::as_str),
            Some("google.com.au")
        );
        assert_eq!(discovery.get("gl").map(String::as_str), Some("au"));
        assert_eq!(discovery.get("hl").map(String::as_str), Some("en"));
        assert_eq!(discovery.get("device").map(String::as_str), Some("desktop"));
        assert_eq!(
            discovery.get("location").map(String::as_str),
            Some("Geelong, Victoria, Australia")
        );
        assert!(!discovery.contains_key("num"));

        let immersive = provider_request_parameters(
            "LW4570",
            Some("token-main"),
            "synthetic-key",
            "Geelong, Victoria, Australia",
        )
        .unwrap()
        .into_iter()
        .collect::<HashMap<_, _>>();
        assert_eq!(
            immersive.get("engine").map(String::as_str),
            Some("google_immersive_product")
        );
        assert_eq!(
            immersive.get("page_token").map(String::as_str),
            Some("token-main")
        );
        assert_eq!(
            immersive.get("more_stores").map(String::as_str),
            Some("true")
        );
        assert!(!immersive.contains_key("q"));
        assert!(!immersive.contains_key("num"));
    }

    #[test]
    fn provider_response_parameters_bind_stage_localisation_and_selection() {
        assert!(validate_discovery_response_parameters(
            &json!({
                "search_parameters": {
                    "engine": "google_shopping",
                    "google_domain": "google.com.au",
                    "gl": "au",
                    "hl": "en",
                    "device": "desktop",
                    "location": "Geelong, Victoria, Australia",
                    "q": "Synthetic lock"
                }
            }),
            "Geelong, Victoria, Australia",
            "synthetic lock",
        )
        .is_ok());
        assert!(validate_discovery_response_parameters(
            &json!({
                "search_parameters": { "engine": "google_shopping", "gl": "us" }
            }),
            "Geelong, Victoria, Australia",
            "synthetic lock",
        )
        .is_err());
        assert!(validate_discovery_response_parameters(
            &json!({
                "search_parameters": { "engine": "google_immersive_product" }
            }),
            "Geelong, Victoria, Australia",
            "synthetic lock",
        )
        .is_err());
        assert!(validate_discovery_response_parameters(
            &json!({
                "search_parameters": {
                    "engine": "google_shopping",
                    "q": "different lock"
                }
            }),
            "Geelong, Victoria, Australia",
            "synthetic lock",
        )
        .is_err());
        assert!(validate_offer_response_parameters(
            &json!({
                "search_parameters": {
                    "engine": "google_immersive_product",
                    "page_token": "token-main"
                }
            }),
            "token-main",
        )
        .is_ok());
        assert!(validate_offer_response_parameters(
            &json!({
                "search_parameters": {
                    "engine": "google_immersive_product",
                    "page_token": "token-other"
                }
            }),
            "token-main",
        )
        .is_err());
        assert!(validate_offer_response_parameters(
            &json!({
                "search_parameters": {
                    "engine": "google_shopping",
                    "page_token": "token-main"
                }
            }),
            "token-main",
        )
        .is_err());
    }

    #[test]
    fn merchant_offer_links_reject_provider_intermediaries_and_strip_fragments() {
        assert!(direct_merchant_url("https://www.google.com./shopping/product/1").is_none());
        assert!(direct_merchant_url("https://serpapi.com/search.json").is_none());
        assert!(direct_merchant_url("https://click.googleadservices.com/pagead/aclk").is_none());
        let (url, domain) =
            direct_merchant_url("https://Merchant.Example.Test/product?id=1#tracking").unwrap();
        assert_eq!(domain, "merchant.example.test");
        assert_eq!(url, "https://merchant.example.test/product?id=1");
    }

    #[test]
    fn candidate_tokens_are_bound_to_the_normalised_discovery_query() {
        let directory = TestDirectory::new();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let candidate = ProductCandidate {
            token: "token-main".to_string(),
            title: "Lockwood 001 Double Cylinder Deadlatch".to_string(),
            brand: Some("Lockwood".to_string()),
            product_id: Some("product-main".to_string()),
            product_url: "https://www.google.com.au/shopping/product/product-main?gl=au"
                .to_string(),
            displayed_price: Some("A$129.00".to_string()),
            price_cents: Some(12_900),
            multiple_sources: true,
            pack_size: Some("pack of 2".to_string()),
            condition: "new".to_string(),
            position: 1,
        };
        let query = normalise_search_query("  Lockwood   001  ");
        remember_search_candidates(&state, &query, std::slice::from_ref(&candidate)).unwrap();
        assert_eq!(query, "Lockwood 001");
        assert_eq!(
            remembered_search_candidate(&state, "Lockwood 001", "token-main").unwrap(),
            Some(candidate)
        );
        assert_eq!(
            require_remembered_search_candidate(&state, "Lockwood 002", "token-main").unwrap_err(),
            "selection_expired"
        );
        assert_eq!(
            require_remembered_search_candidate(&state, "Lockwood 001", "untrusted-token")
                .unwrap_err(),
            "selection_expired"
        );
        remember_search_candidates(&state, "Lockwood 001", &[]).unwrap();
        assert_eq!(
            require_remembered_search_candidate(&state, "Lockwood 001", "token-main").unwrap_err(),
            "selection_expired"
        );
    }

    #[test]
    fn remembered_candidates_expire_and_fifo_eviction_is_deterministic() {
        let directory = TestDirectory::new();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let candidate = |token: String, position: i64| ProductCandidate {
            token,
            title: "Synthetic lock".to_string(),
            brand: None,
            product_id: None,
            product_url: "https://www.google.com.au/shopping/product/synthetic".to_string(),
            displayed_price: None,
            price_cents: None,
            multiple_sources: false,
            pack_size: None,
            condition: "unknown".to_string(),
            position,
        };
        let issued_at = Instant::now();
        let expiring = candidate("expiring-token".to_string(), 1);
        remember_search_candidates_at(
            &state,
            "expiring query",
            std::slice::from_ref(&expiring),
            issued_at,
        )
        .unwrap();
        assert_eq!(
            remembered_search_candidate_at(
                &state,
                "expiring query",
                "expiring-token",
                issued_at + SEARCH_CANDIDATE_TTL,
            )
            .unwrap(),
            Some(expiring)
        );
        assert_eq!(
            remembered_search_candidate_at(
                &state,
                "expiring query",
                "expiring-token",
                issued_at + SEARCH_CANDIDATE_TTL + Duration::from_secs(1),
            )
            .unwrap(),
            None
        );

        for batch in 0..5 {
            let candidates = (0..100)
                .map(|index| {
                    let number = batch * 100 + index;
                    candidate(format!("token-{number:03}"), index)
                })
                .collect::<Vec<_>>();
            remember_search_candidates_at(
                &state,
                &format!("query-{batch}"),
                &candidates,
                issued_at,
            )
            .unwrap();
        }
        remember_search_candidates_at(
            &state,
            "query-new",
            &[candidate("token-new".to_string(), 1)],
            issued_at,
        )
        .unwrap();
        assert_eq!(
            remembered_search_candidate_at(&state, "query-0", "token-000", issued_at).unwrap(),
            None
        );
        assert!(
            remembered_search_candidate_at(&state, "query-0", "token-001", issued_at)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn trusted_candidate_pack_and_condition_exclude_incompatible_offers() {
        let selected = ProductCandidate {
            token: "token-pack".to_string(),
            title: "Synthetic lock pack of 2".to_string(),
            brand: None,
            product_id: Some("product-pack".to_string()),
            product_url: "https://www.google.com.au/shopping/product/product-pack".to_string(),
            displayed_price: Some("A$80.00".to_string()),
            price_cents: Some(8_000),
            multiple_sources: true,
            pack_size: Some("pack of 2".to_string()),
            condition: "used".to_string(),
            position: 1,
        };
        let offer = json!({
            "name": "Merchant",
            "link": "https://merchant.example.test/product",
            "title": "Synthetic lock pack of 3",
            "details_and_offers": ["In stock", "Free delivery"],
            "price": "A$75.00",
            "extracted_price": 75.0,
            "shipping": "Free",
            "shipping_extracted": 0.0,
            "total": "A$75.00",
            "extracted_total": 75.0
        });
        let result = normalise_offer(&offer, Some(&selected), "2026-08-10T23:00:00Z").unwrap();
        assert!(!result.comparison_eligible);
        assert_eq!(result.comparison_price_cents, None);
        assert_eq!(result.price_basis, "not_comparable");
        assert_eq!(
            result.exclusion_reasons,
            vec![
                "used_or_second_hand".to_string(),
                "pack_mismatch".to_string()
            ]
        );
    }

    #[test]
    fn explicit_offer_pack_is_excluded_when_selected_pack_is_unstated() {
        let selected = ProductCandidate {
            token: "token-unit".to_string(),
            title: "Synthetic lock".to_string(),
            brand: None,
            product_id: None,
            product_url: "https://www.google.com.au/shopping/product/synthetic".to_string(),
            displayed_price: Some("A$75.00".to_string()),
            price_cents: Some(7_500),
            multiple_sources: false,
            pack_size: None,
            condition: "new".to_string(),
            position: 1,
        };
        let offer = json!({
            "name": "Merchant",
            "link": "https://merchant.example.test/product",
            "title": "Synthetic lock 2 Pack",
            "details_and_offers": ["In stock", "Free delivery"],
            "price": "A$75.00",
            "extracted_price": 75.0,
            "shipping": "Free",
            "shipping_extracted": 0.0,
            "total": "A$75.00",
            "extracted_total": 75.0
        });
        let result = normalise_offer(&offer, Some(&selected), "2026-08-10T23:00:00Z").unwrap();
        assert!(!result.comparison_eligible);
        assert_eq!(result.comparison_price_cents, None);
        assert_eq!(result.exclusion_reasons, vec!["pack_mismatch".to_string()]);
    }

    #[test]
    fn conflicting_numeric_and_displayed_components_drop_the_offer() {
        let base = json!({
            "name": "Merchant",
            "link": "https://merchant.example.test/product",
            "title": "Synthetic lock",
            "details_and_offers": ["In stock"],
            "price": "A$100.00",
            "extracted_price": 100.0,
            "shipping": "+ A$10.00",
            "shipping_extracted": 10.0,
            "estimated_tax": "+ A$10.00",
            "extracted_estimated_tax": 10.0,
            "total": "A$120.00",
            "extracted_total": 120.0
        });
        for key in [
            "extracted_price",
            "shipping_extracted",
            "extracted_estimated_tax",
            "extracted_total",
        ] {
            let mut conflicting = base.clone();
            conflicting[key] = json!(1.0);
            assert!(normalise_offer(&conflicting, None, "2026-08-10T23:00:00Z").is_none());
        }
    }

    #[test]
    fn immersive_stores_preserve_components_and_band_only_comparable_totals() {
        let selected = ProductCandidate {
            token: "token-main".to_string(),
            title: "Lockwood 001 Double Cylinder Deadlatch".to_string(),
            brand: None,
            product_id: Some("product-main".to_string()),
            product_url: "https://www.google.com.au/shopping/product/product-main?gl=au"
                .to_string(),
            displayed_price: Some("A$129.00".to_string()),
            price_cents: Some(12_900),
            multiple_sources: true,
            pack_size: None,
            condition: "unknown".to_string(),
            position: 1,
        };
        let payload = json!({
            "search_metadata": {
                "status": "Success",
                "created_at": "2026-08-10 23:05:00 UTC",
                "processed_at": "2026-08-10 23:05:03 UTC"
            },
            "search_parameters": {
                "engine": "google_immersive_product",
                "page_token": "token-main"
            },
            "product_results": {
                "title": "Lockwood 001 Double Cylinder Deadlatch",
                "brand": "Lockwood",
                "stores": [{
                    "name": "Merchant One",
                    "link": "https://merchant-one.example.test/products/lockwood-001",
                    "title": "Lockwood 001 Double Cylinder Deadlatch",
                    "details_and_offers": ["In stock online"],
                    "price": "A$100.00",
                    "extracted_price": 100.0,
                    "estimated_tax": "+ A$10.00",
                    "extracted_estimated_tax": 10.0,
                    "shipping": "+ A$10.00",
                    "shipping_extracted": 10.0,
                    "total": "A$120.00",
                    "extracted_total": 120.0
                }, {
                    "name": "Merchant One",
                    "link": "https://merchant-one.example.test/products/lockwood-001?utm_source=shopping&gclid=synthetic",
                    "title": "Lockwood 001 Double Cylinder Deadlatch",
                    "details_and_offers": ["In stock online"],
                    "price": "A$100.00",
                    "extracted_price": 100.0,
                    "estimated_tax": "+ A$10.00",
                    "extracted_estimated_tax": 10.0,
                    "shipping": "+ A$10.00",
                    "shipping_extracted": 10.0,
                    "total": "A$120.00",
                    "extracted_total": 120.0
                }, {
                    "name": "Merchant Two",
                    "link": "https://merchant-two.example.test/products/lockwood-001",
                    "title": "Lockwood 001 Double Cylinder Deadlatch",
                    "details_and_offers": ["In stock", "Free delivery"],
                    "price": "$105.00",
                    "extracted_price": 105.0,
                    "shipping": "Free",
                    "shipping_extracted": 0.0
                }, {
                    "name": "Finance Merchant",
                    "link": "https://finance.example.test/products/lockwood-001",
                    "title": "Lockwood 001 Double Cylinder Deadlatch, 12 monthly payments",
                    "details_and_offers": ["In stock", "Free delivery"],
                    "price": "$10.00",
                    "extracted_price": 10.0,
                    "monthly_payment_duration": 12,
                    "installments_description": "12 monthly payments",
                    "shipping": "Free",
                    "shipping_extracted": 0.0
                }, {
                    "name": "Used Merchant",
                    "link": "https://used.example.test/products/lockwood-001",
                    "title": "Used Lockwood 001 Double Cylinder Deadlatch",
                    "details_and_offers": ["In stock", "Free delivery"],
                    "price": "$70.00",
                    "extracted_price": 70.0,
                    "shipping": "Free",
                    "shipping_extracted": 0.0,
                    "total": "$70.00",
                    "extracted_total": 70.0
                }, {
                    "name": "Unknown Delivery Merchant",
                    "link": "https://unknown.example.test/products/lockwood-001",
                    "title": "Lockwood 001 Double Cylinder Deadlatch",
                    "price": "$99.00",
                    "extracted_price": 99.0
                }, {
                    "name": "Google cluster",
                    "link": "https://www.google.com/shopping/product/product-main",
                    "title": "Lockwood 001 Double Cylinder Deadlatch",
                    "price": "$90.00",
                    "extracted_price": 90.0,
                    "shipping": "Free",
                    "shipping_extracted": 0.0,
                    "total": "$90.00",
                    "extracted_total": 90.0
                }],
                "stores_next_page_token": "synthetic-next-page"
            }
        });

        let outcome = parse_immersive_offers(&payload, "Lockwood 001", Some(&selected)).unwrap();
        assert_eq!(outcome.state, "ok");
        assert!(outcome.candidates.is_empty());
        assert_eq!(outcome.results.len(), 5);
        assert_eq!(
            outcome.selected_product.unwrap().product_id.as_deref(),
            Some("product-main")
        );
        assert_eq!(outcome.results[0].item_price_cents, 10_000);
        assert_eq!(outcome.results[0].shipping_cents, Some(1_000));
        assert_eq!(outcome.results[0].estimated_tax_cents, Some(1_000));
        assert_eq!(outcome.results[0].total_price_cents, Some(12_000));
        assert_eq!(outcome.results[0].comparison_price_cents, Some(12_000));
        assert_eq!(
            outcome.results[0].search_query.as_deref(),
            Some("Lockwood 001")
        );
        assert_eq!(
            outcome.results[0].selected_product_title.as_deref(),
            Some("Lockwood 001 Double Cylinder Deadlatch")
        );
        assert_eq!(
            outcome.results[0].selected_product_brand.as_deref(),
            Some("Lockwood")
        );
        assert_eq!(
            outcome.results[0].selected_product_id.as_deref(),
            Some("product-main")
        );
        assert_eq!(outcome.results[1].price_basis, "item_plus_shipping");
        assert_eq!(outcome.results[1].comparison_price_cents, Some(10_500));
        assert_eq!(
            outcome.results[2].exclusion_reasons,
            vec![
                "financing_without_full_total".to_string(),
                "unknown_comparison_total".to_string()
            ]
        );
        assert_eq!(
            outcome.results[3].exclusion_reasons,
            vec!["used_or_second_hand".to_string()]
        );
        assert_eq!(
            outcome.results[4].exclusion_reasons,
            vec!["unknown_comparison_total".to_string()]
        );
        let band = outcome.band.unwrap();
        assert_eq!(band.lowest_cents, 10_500);
        assert_eq!(band.median_cents, 11_250);
        assert_eq!(band.highest_cents, 12_000);
        assert_eq!(band.priced_results, 2);
        let coverage = outcome.coverage.unwrap();
        assert_eq!(coverage.parsed_offers, 5);
        assert_eq!(coverage.comparable_offers, 2);
        assert_eq!(coverage.excluded_offers, 3);
        assert!(outcome.detail.unwrap().contains("not exhaustive"));
    }

    #[test]
    fn immersive_stage_reports_no_comparable_offers_without_a_band() {
        let selected = ProductCandidate {
            token: "token-no-total".to_string(),
            title: "Synthetic lock".to_string(),
            brand: None,
            product_id: None,
            product_url: "https://www.google.com.au/shopping/product/synthetic".to_string(),
            displayed_price: Some("A$99.00".to_string()),
            price_cents: Some(9_900),
            multiple_sources: false,
            pack_size: None,
            condition: "new".to_string(),
            position: 1,
        };
        let payload = json!({
            "search_metadata": {
                "status": "Success",
                "processed_at": "2026-08-10 23:10:00 UTC"
            },
            "search_parameters": {
                "engine": "google_immersive_product",
                "page_token": "token-no-total",
                "no_cache": true
            },
            "product_results": {
                "title": "Synthetic lock",
                "stores": [{
                    "name": "Merchant",
                    "link": "https://merchant.example.test/synthetic-lock",
                    "title": "Synthetic lock",
                    "price": "A$99.00",
                    "extracted_price": 99.0
                }]
            }
        });
        let outcome = parse_immersive_offers(&payload, "Synthetic lock", Some(&selected)).unwrap();
        assert_eq!(outcome.state, "no_comparable_offers");
        assert!(outcome.band.is_none());
        assert_eq!(outcome.results.len(), 1);
        assert_eq!(
            outcome.results[0].exclusion_reasons,
            vec!["unknown_comparison_total".to_string()]
        );
        let coverage = outcome.coverage.unwrap();
        assert_eq!(coverage.parsed_offers, 1);
        assert_eq!(coverage.comparable_offers, 0);
        assert_eq!(coverage.excluded_offers, 1);
        assert!(!outcome.detail.unwrap().contains("provider cache"));
    }

    #[test]
    fn immersive_stage_distinguishes_zero_parsed_offers_from_excluded_offers() {
        let selected = ProductCandidate {
            token: "token-empty".to_string(),
            title: "Synthetic lock".to_string(),
            brand: None,
            product_id: None,
            product_url: "https://www.google.com.au/shopping/product/synthetic".to_string(),
            displayed_price: None,
            price_cents: None,
            multiple_sources: false,
            pack_size: None,
            condition: "new".to_string(),
            position: 1,
        };
        let payload = json!({
            "search_metadata": {
                "status": "Success",
                "processed_at": "2026-08-10 23:10:00 UTC"
            },
            "search_parameters": {
                "engine": "google_immersive_product",
                "page_token": "token-empty"
            },
            "product_results": {
                "title": "Synthetic lock",
                "stores": []
            }
        });
        let outcome = parse_immersive_offers(&payload, "Synthetic lock", Some(&selected)).unwrap();
        assert_eq!(outcome.state, "no_comparable_offers");
        assert!(outcome.results.is_empty());
        assert!(outcome.band.is_none());
        assert_eq!(outcome.coverage.unwrap().parsed_offers, 0);
        let detail = outcome.detail.unwrap();
        assert!(detail.contains("No direct merchant offers"));
        assert!(!detail.contains("offers were found"));
    }

    #[test]
    fn provider_json_errors_map_to_distinct_sanitised_states() {
        assert_eq!(
            provider_payload_error_state(&json!({
                "error": "Your account has run out of searches for this month."
            })),
            Some("quota_exhausted")
        );
        assert_eq!(
            provider_payload_error_state(&json!({
                "error": "Invalid API key supplied: synthetic-value-must-not-escape"
            })),
            Some("provider_error")
        );
        assert_eq!(provider_payload_error_state(&json!({"status": "ok"})), None);
    }

    #[test]
    fn provider_price_parser_is_decimal_safe_and_half_up() {
        assert_eq!(parse_aud_cents("AUD $1,234.56"), Some(123_456));
        assert_eq!(parse_aud_cents("1.235"), Some(124));
        assert_eq!(parse_aud_cents("1.234"), Some(123));
        assert_eq!(parse_aud_cents("10000000.00"), Some(1_000_000_000));
        assert_eq!(parse_aud_cents("10000000.01"), None);
        assert_eq!(parse_aud_cents("999999999999999.99"), None);
        assert_eq!(parse_aud_cents("-1.00"), None);

        let first = SearchResult {
            search_query: None,
            selected_product_title: None,
            selected_product_brand: None,
            selected_product_id: None,
            title: "Synthetic high A".to_string(),
            price_cents: 999_999_999,
            price_aud: "9999999.99".to_string(),
            item_price_cents: 999_999_999,
            item_price_aud: "9999999.99".to_string(),
            shipping_cents: Some(0),
            shipping_aud: Some("0.00".to_string()),
            estimated_tax_cents: None,
            estimated_tax_aud: None,
            total_price_cents: Some(999_999_999),
            total_price_aud: Some("9999999.99".to_string()),
            comparison_price_cents: Some(999_999_999),
            comparison_price_aud: Some("9999999.99".to_string()),
            price_basis: "provider_total".to_string(),
            original_price_text: "A$9999999.99".to_string(),
            currency_basis: "explicit-aud".to_string(),
            currency: "AUD".to_string(),
            gst_basis: "unknown".to_string(),
            pack_size: None,
            condition: "new".to_string(),
            availability: "in-stock".to_string(),
            financing: false,
            comparison_eligible: true,
            exclusion_reasons: Vec::new(),
            seller: "Fixture".to_string(),
            source_domain: "fixture.invalid".to_string(),
            url: "https://fixture.invalid/a".to_string(),
            retrieved_at: "2026-08-09T00:00:00Z".to_string(),
        };
        let second = SearchResult {
            title: "Synthetic high B".to_string(),
            price_cents: 1_000_000_000,
            price_aud: "10000000.00".to_string(),
            item_price_cents: 1_000_000_000,
            item_price_aud: "10000000.00".to_string(),
            total_price_cents: Some(1_000_000_000),
            total_price_aud: Some("10000000.00".to_string()),
            comparison_price_cents: Some(1_000_000_000),
            comparison_price_aud: Some("10000000.00".to_string()),
            original_price_text: "A$10000000.00".to_string(),
            url: "https://fixture.invalid/b".to_string(),
            ..first.clone()
        };
        let results = vec![first, second];
        let band = search_band(&results).unwrap();
        assert_eq!(band.median_cents, 1_000_000_000);
    }

    #[test]
    fn credential_lifecycle_never_uses_the_database() {
        let directory = migrated_database();
        let store = MemoryCredentialStore::default();
        let secret = "synthetic-secret-123";
        store.set(secret).unwrap();
        assert_eq!(store.get().unwrap().as_deref(), Some(secret));
        let database = fs::read(directory.database()).unwrap();
        assert!(!database
            .windows(secret.len())
            .any(|window| window == secret.as_bytes()));
        store.remove().unwrap();
        assert!(store.get().unwrap().is_none());
    }

    #[test]
    fn paid_provider_calls_are_disabled_until_explicitly_enabled() {
        let directory = migrated_database();
        let store = Arc::new(MemoryCredentialStore::default());
        let state = AppState::new(directory.0.clone(), store.clone());
        let candidate = ProductCandidate {
            token: "policy-token".to_string(),
            title: "Synthetic lock".to_string(),
            brand: None,
            product_id: None,
            product_url: "https://www.google.com.au/shopping/product/synthetic".to_string(),
            displayed_price: None,
            price_cents: None,
            multiple_sources: false,
            pack_size: None,
            condition: "unknown".to_string(),
            position: 1,
        };
        let mut connection = open_connection(&state.database_path).unwrap();
        let initial = provider_status_inner(&state, &connection).unwrap();
        assert!(!initial.paid_calls_enabled);
        assert_eq!(initial.cost_ceiling_aud, "0.00");
        assert!(
            set_provider_paid_calls_inner(&state, &connection, true, Some(100), Some(25)).is_err()
        );
        store.set("synthetic-secret-123").unwrap();
        let configured = provider_status_inner(&state, &connection).unwrap();
        assert!(!configured.paid_calls_enabled);
        assert!(
            set_provider_paid_calls_inner(&state, &connection, true, Some(100), Some(25)).is_err()
        );
        mark_provider_validated(&connection);
        assert!(set_provider_paid_calls_inner(&state, &connection, true, None, None).is_err());
        assert!(
            set_provider_paid_calls_inner(&state, &connection, true, Some(0), Some(1)).is_err()
        );
        remember_search_candidates(&state, "Synthetic lock", std::slice::from_ref(&candidate))
            .unwrap();
        let enabled =
            set_provider_paid_calls_inner(&state, &connection, true, Some(100), Some(25)).unwrap();
        assert!(enabled.paid_calls_enabled);
        assert!(
            remembered_search_candidate(&state, "Synthetic lock", &candidate.token,)
                .unwrap()
                .is_none()
        );
        assert_eq!(enabled.cost_ceiling_cents, 100);
        assert_eq!(enabled.cost_per_call_cents, 25);
        for expected in [25, 50, 75, 100] {
            reserve_provider_call(&connection).unwrap();
            assert_eq!(
                provider_status_inner(&state, &connection)
                    .unwrap()
                    .spent_cents,
                expected
            );
        }
        assert_eq!(
            reserve_provider_call(&connection).unwrap_err(),
            "quota_exhausted"
        );
        let exhausted = provider_status_inner(&state, &connection).unwrap();
        assert_eq!(exhausted.state, "quota_exhausted");
        assert!(exhausted.paid_calls_enabled);
        remember_search_candidates(&state, "Synthetic lock", std::slice::from_ref(&candidate))
            .unwrap();
        let replaced =
            store_credential(&state, "replacement-secret-456".to_string(), true).unwrap();
        assert!(!replaced.paid_calls_enabled);
        assert!(replaced.last_validated_at.is_none());
        assert_eq!(replaced.cost_ceiling_cents, 0);
        assert_eq!(replaced.cost_per_call_cents, 0);
        assert_eq!(replaced.spent_cents, 0);
        assert_eq!(
            store.get().unwrap().as_deref(),
            Some("replacement-secret-456")
        );
        assert!(
            remembered_search_candidate(&state, "Synthetic lock", &candidate.token,)
                .unwrap()
                .is_none()
        );
        enable_test_provider_budget(&state, &connection);
        remember_search_candidates(&state, "Synthetic lock", std::slice::from_ref(&candidate))
            .unwrap();
        let removed = remove_provider_credential_inner(&state, &mut connection).unwrap();
        assert!(!removed.paid_calls_enabled);
        assert!(!removed.credential_configured);
        assert_eq!(removed.cost_ceiling_cents, 0);
        assert_eq!(removed.spent_cents, 0);
        assert!(
            remembered_search_candidate(&state, "Synthetic lock", &candidate.token,)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn in_flight_paid_search_blocks_reset_restore_import_and_credential_removal() {
        use std::sync::mpsc;
        use std::thread;

        let directory = migrated_database();
        let store = Arc::new(MemoryCredentialStore::default());
        store.set("synthetic-secret-123").unwrap();
        let state = Arc::new(AppState::new(directory.0.clone(), store.clone()));
        let connection = open_connection(&state.database_path).unwrap();
        insert_sample_catalogue(&connection);
        enable_test_provider_budget(&state, &connection);
        drop(connection);

        let backup =
            create_verified_backup_at(&state.database_path, &state.data_dir, "manual").unwrap();
        let restore_preview = preview_restore_inner(&state, Some(backup.id.clone())).unwrap();
        let reset_preview = preview_reset_inner(&state).unwrap();
        let import_preview = preview_configuration_import_inner(
            &state,
            serialise_configuration_envelope(&sample_configuration_envelope()),
        )
        .unwrap();

        let (ready_sender, ready_receiver) = mpsc::sync_channel(0);
        let (release_sender, release_receiver) = mpsc::sync_channel(0);
        let search_state = Arc::clone(&state);
        let search = thread::spawn(move || {
            let (_credential, lease) =
                authorise_provider_search(&search_state).expect("authorise paid search");
            ready_sender.send(()).unwrap();
            release_receiver.recv().unwrap();
            drop(lease);
        });
        ready_receiver.recv().unwrap();

        assert_eq!(state.in_flight_provider_searches.load(Ordering::Acquire), 1);
        let reset_error = reset_application_data_at(
            &state,
            reset_preview.reset_token.clone(),
            RESET_CONFIRMATION.to_string(),
        )
        .unwrap_err();
        assert!(reset_error.contains("search is in progress"));
        assert!(safe_lock(&state.pending_resets)
            .unwrap()
            .contains_key(&reset_preview.reset_token));

        let restore_error =
            restore_backup_at(&state, restore_preview.preview_token.clone()).unwrap_err();
        assert!(restore_error.contains("search is in progress"));
        assert!(safe_lock(&state.pending_restores)
            .unwrap()
            .contains_key(&restore_preview.preview_token));

        let import_error =
            apply_configuration_import_at(&state, import_preview.preview_token.clone())
                .unwrap_err();
        assert!(import_error.contains("search is in progress"));
        assert!(safe_lock(&state.pending_imports)
            .unwrap()
            .contains_key(&import_preview.preview_token));

        let credential_error = remove_provider_credential_at(&state).unwrap_err();
        assert!(credential_error.contains("search is in progress"));
        assert_eq!(
            store.get().unwrap().as_deref(),
            Some("synthetic-secret-123")
        );
        let connection = open_connection(&state.database_path).unwrap();
        assert_eq!(record_counts(&connection).unwrap().catalogue_items, 1);
        assert_eq!(
            provider_status_inner(&state, &connection)
                .unwrap()
                .spent_cents,
            25
        );
        drop(connection);

        release_sender.send(()).unwrap();
        search.join().unwrap();
        assert_eq!(state.in_flight_provider_searches.load(Ordering::Acquire), 0);

        let restored = restore_backup_at(&state, restore_preview.preview_token).unwrap();
        assert_eq!(restored.id, backup.id);
        assert_eq!(
            apply_configuration_import_at(&state, import_preview.preview_token)
                .unwrap()
                .settings,
            1
        );
        let connection = open_connection(&state.database_path).unwrap();
        assert_eq!(record_counts(&connection).unwrap().catalogue_items, 1);
        let provider = provider_status_inner(&state, &connection).unwrap();
        assert!(!provider.paid_calls_enabled);
        assert_eq!(provider.spent_cents, 0);
    }

    #[test]
    fn filenames_are_unicode_safe_and_reject_unsafe_or_reserved_names() {
        let unicode = format!("{}-report.xlsx", "lock-🔐".repeat(100));
        assert!(sanitise_filename(&unicode).encode_utf16().count() <= 180);
        assert!(validate_export_filename("20260809-SWL-Import.xlsx").is_ok());
        assert!(validate_export_filename("20260809-Audit.txt").is_ok());
        assert!(validate_export_filename("../escape.xlsx").is_err());
        assert!(validate_export_filename("CON.xlsx").is_err());
        assert!(validate_export_filename("report.exe").is_err());
        assert!(validate_export_filename("20260230-Invalid.xlsx").is_err());
        assert!(validate_export_filename("20260809-Configuration.json").is_err());
        assert!(validate_configuration_export_filename("20260809-Configuration.json").is_ok());
    }

    #[test]
    fn configuration_export_is_json_only_native_atomic_and_schema_validated() {
        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let grant_id = Uuid::new_v4().to_string();
        safe_lock(&state.output_grants).unwrap().insert(
            grant_id.clone(),
            OutputGrant::new(directory.0.clone()).unwrap(),
        );
        let filename = "20260809-SWL-Configuration.json";
        assert_eq!(
            export_configuration_to_folder_inner(&state, grant_id.clone(), filename.to_string(),)
                .unwrap(),
            filename
        );
        let serialised = fs::read_to_string(directory.0.join(filename)).unwrap();
        let envelope: ConfigurationEnvelope = serde_json::from_str(&serialised).unwrap();
        validate_configuration_envelope(&envelope).unwrap();
        assert!(verify_configuration_checksum(&envelope));
        assert!(
            export_configuration_to_folder_inner(&state, grant_id, filename.to_string(),).is_err()
        );
    }

    #[test]
    fn tokenised_export_rejects_offsets_conflicts_and_checksum_mismatch() {
        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let grant_id = Uuid::new_v4().to_string();
        safe_lock(&state.output_grants).unwrap().insert(
            grant_id.clone(),
            OutputGrant::new(directory.0.clone()).unwrap(),
        );
        let bytes = synthetic_xlsx();
        let checksum = sha256_bytes(&bytes);

        let wrong_offset = begin_export_file_inner(
            &state,
            grant_id.clone(),
            "20260809-Test-Offset.xlsx".to_string(),
            bytes.len() as u64,
            checksum.clone(),
        )
        .unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        assert!(
            append_export_chunk_inner(&state, wrong_offset.session_id, 1, encoded.clone(),)
                .is_err()
        );

        let bad_hash = begin_export_file_inner(
            &state,
            grant_id.clone(),
            "20260809-Test-Hash.xlsx".to_string(),
            bytes.len() as u64,
            "0".repeat(64),
        )
        .unwrap();
        append_export_chunk_inner(&state, bad_hash.session_id.clone(), 0, encoded.clone()).unwrap();
        assert!(commit_export_file_inner(&state, bad_hash.session_id).is_err());

        let conflict_name = "20260809-Test-Conflict.xlsx";
        let conflict = begin_export_file_inner(
            &state,
            grant_id.clone(),
            conflict_name.to_string(),
            bytes.len() as u64,
            checksum.clone(),
        )
        .unwrap();
        append_export_chunk_inner(&state, conflict.session_id.clone(), 0, encoded.clone()).unwrap();
        fs::write(directory.0.join(conflict_name), b"existing").unwrap();
        assert!(commit_export_file_inner(&state, conflict.session_id).is_err());
        assert_eq!(
            fs::read(directory.0.join(conflict_name)).unwrap(),
            b"existing"
        );

        let abort = begin_export_file_inner(
            &state,
            grant_id.clone(),
            "20260809-Test-Abort.xlsx".to_string(),
            bytes.len() as u64,
            checksum.clone(),
        )
        .unwrap();
        let abort_temporary = safe_lock(&state.export_sessions)
            .unwrap()
            .get(&abort.session_id)
            .unwrap()
            .temporary
            .clone();
        assert!(abort_temporary.exists());
        abort_export_file_inner(&state, abort.session_id).unwrap();
        assert!(!abort_temporary.exists());

        let success_name = "20260809-Test-Success.xlsx";
        let success = begin_export_file_inner(
            &state,
            grant_id,
            success_name.to_string(),
            bytes.len() as u64,
            checksum,
        )
        .unwrap();
        append_export_chunk_inner(&state, success.session_id.clone(), 0, encoded).unwrap();
        assert_eq!(
            commit_export_file_inner(&state, success.session_id).unwrap(),
            success_name
        );
        assert_eq!(fs::read(directory.0.join(success_name)).unwrap(), bytes);

        let invalid = b"not an XLSX container";
        let invalid_name = "20260809-Test-Invalid.xlsx";
        let invalid_session = begin_export_file_inner(
            &state,
            Uuid::new_v4().to_string(),
            invalid_name.to_string(),
            invalid.len() as u64,
            sha256_bytes(invalid),
        );
        assert!(
            invalid_session.is_err(),
            "an unknown grant must be rejected"
        );

        let second_grant = Uuid::new_v4().to_string();
        safe_lock(&state.output_grants).unwrap().insert(
            second_grant.clone(),
            OutputGrant::new(directory.0.clone()).unwrap(),
        );
        let invalid_session = begin_export_file_inner(
            &state,
            second_grant,
            invalid_name.to_string(),
            invalid.len() as u64,
            sha256_bytes(invalid),
        )
        .unwrap();
        append_export_chunk_inner(
            &state,
            invalid_session.session_id.clone(),
            0,
            base64::engine::general_purpose::STANDARD.encode(invalid),
        )
        .unwrap();
        assert!(commit_export_file_inner(&state, invalid_session.session_id).is_err());
        assert!(!directory.0.join(invalid_name).exists());
    }

    #[test]
    fn export_batch_reservation_rejects_any_conflict_before_creating_outputs() {
        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let grant_id = insert_test_output_grant(&state, &directory.0);
        let files = synthetic_export_batch();
        let conflict = &files[2].0.filename;
        fs::write(
            directory.0.join(conflict),
            b"operator-owned existing output",
        )
        .unwrap();

        assert!(reserve_export_batch_inner(
            &state,
            grant_id,
            files.iter().map(|(request, _)| request.clone()).collect(),
        )
        .is_err());
        assert!(safe_lock(&state.export_batches).unwrap().is_empty());
        assert!(safe_lock(&state.export_sessions).unwrap().is_empty());
        for (request, _) in &files {
            if request.filename == *conflict {
                assert_eq!(
                    fs::read(directory.0.join(&request.filename)).unwrap(),
                    b"operator-owned existing output"
                );
            } else {
                assert!(!directory.0.join(&request.filename).exists());
            }
        }
        assert_eq!(task_export_temporary_count(&directory.0), 0);
    }

    #[test]
    fn export_batch_late_conflict_rolls_back_all_task_outputs_and_temporaries() {
        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let grant_id = insert_test_output_grant(&state, &directory.0);
        let files = synthetic_export_batch();
        let reservation = reserve_export_batch_inner(
            &state,
            grant_id.clone(),
            files.iter().map(|(request, _)| request.clone()).collect(),
        )
        .unwrap();
        write_reserved_export_batch(&state, &grant_id, &reservation.batch_id, &files);
        assert_eq!(task_export_temporary_count(&directory.0), 5);

        let conflict = &files[3].0.filename;
        fs::write(
            directory.0.join(conflict),
            b"output created after reservation",
        )
        .unwrap();
        assert!(commit_export_batch_inner(&state, reservation.batch_id.clone()).is_err());
        assert!(!safe_lock(&state.export_batches)
            .unwrap()
            .contains_key(&reservation.batch_id));
        for (request, _) in &files {
            if request.filename == *conflict {
                assert_eq!(
                    fs::read(directory.0.join(&request.filename)).unwrap(),
                    b"output created after reservation"
                );
            } else {
                assert!(!directory.0.join(&request.filename).exists());
            }
        }
        assert_eq!(task_export_temporary_count(&directory.0), 0);
    }

    #[test]
    fn export_batch_mid_commit_failure_rolls_back_outputs_and_cleans_temporaries() {
        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let grant_id = insert_test_output_grant(&state, &directory.0);
        let files = synthetic_export_batch();
        let reservation = reserve_export_batch_inner(
            &state,
            grant_id.clone(),
            files.iter().map(|(request, _)| request.clone()).collect(),
        )
        .unwrap();
        write_reserved_export_batch(&state, &grant_id, &reservation.batch_id, &files);

        let mut commits = 0_usize;
        assert!(commit_export_batch_with(
            &state,
            reservation.batch_id,
            |temporary, destination| {
                commits += 1;
                if commits == 3 {
                    return Err("synthetic commit failure".to_string());
                }
                commit_temporary_no_replace(temporary, destination)
            },
        )
        .is_err());
        assert_eq!(commits, 3);
        for (request, _) in &files {
            assert!(!directory.0.join(&request.filename).exists());
        }
        assert_eq!(task_export_temporary_count(&directory.0), 0);
        assert!(safe_lock(&state.export_sessions).unwrap().is_empty());
        assert!(safe_lock(&state.export_batches).unwrap().is_empty());
    }

    #[test]
    fn export_batch_commits_exactly_five_prepared_outputs() {
        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let grant_id = insert_test_output_grant(&state, &directory.0);
        let files = synthetic_export_batch();
        let reservation = reserve_export_batch_inner(
            &state,
            grant_id.clone(),
            files.iter().map(|(request, _)| request.clone()).collect(),
        )
        .unwrap();
        write_reserved_export_batch(&state, &grant_id, &reservation.batch_id, &files);

        let committed = commit_export_batch_inner(&state, reservation.batch_id).unwrap();
        assert_eq!(committed.len(), 5);
        for (request, expected) in &files {
            assert!(committed.contains(&request.filename));
            assert_eq!(
                fs::read(directory.0.join(&request.filename)).unwrap(),
                *expected
            );
        }
        assert_eq!(task_export_temporary_count(&directory.0), 0);
        assert!(safe_lock(&state.export_sessions).unwrap().is_empty());
        assert!(safe_lock(&state.export_batches).unwrap().is_empty());
    }

    #[test]
    fn atomic_commit_never_replaces_a_destination_that_wins_the_race() {
        let directory = TestDirectory::new();
        let temporary = directory.0.join(".swl-race.tmp");
        let destination = directory.0.join("20260809-Race.txt");
        fs::write(&temporary, b"new task-created content").unwrap();
        fs::write(&destination, b"pre-existing operator content").unwrap();
        assert!(commit_temporary_no_replace(&temporary, &destination).is_err());
        assert_eq!(
            fs::read(&destination).unwrap(),
            b"pre-existing operator content"
        );
        assert_eq!(fs::read(&temporary).unwrap(), b"new task-created content");
    }

    #[test]
    fn destination_validation_rejects_symlinks() {
        let directory = TestDirectory::new();
        let canonical = validate_output_directory(&directory.0).unwrap();
        assert!(revalidate_trusted_output_directory(&canonical).is_ok());
        #[cfg(windows)]
        {
            use std::path::Prefix;
            assert!(matches!(
                canonical.components().next(),
                Some(Component::Prefix(prefix))
                    if matches!(prefix.kind(), Prefix::VerbatimDisk(_))
            ));
            assert!(validate_output_directory(&canonical).is_err());
            let grant = OutputGrant::new(directory.0.clone()).unwrap();
            assert_eq!(validate_output_grant(&grant).unwrap(), canonical);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = directory.0.with_extension("link");
            symlink(&directory.0, &link).unwrap();
            assert!(validate_output_directory(&link).is_err());
            let _ = fs::remove_file(link);
        }
    }

    #[test]
    fn output_grant_detects_or_prevents_directory_substitution() {
        let root = TestDirectory::new();
        let selected = root.0.join("selected");
        let displaced = root.0.join("displaced");
        fs::create_dir(&selected).unwrap();
        let grant = OutputGrant::new(selected.clone()).unwrap();
        match fs::rename(&selected, &displaced) {
            Ok(()) => {
                fs::create_dir(&selected).unwrap();
                assert!(validate_output_grant(&grant).is_err());
            }
            Err(_) => {
                // On Windows the directory handle intentionally omits
                // FILE_SHARE_DELETE, so rename/substitution is prevented.
                assert_eq!(validate_output_grant(&grant).unwrap(), grant.directory);
            }
        }
    }

    #[test]
    fn export_session_limits_revoke_the_rejected_session_and_temporary() {
        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let grant_id = Uuid::new_v4().to_string();
        safe_lock(&state.output_grants).unwrap().insert(
            grant_id.clone(),
            OutputGrant::new(directory.0.clone()).unwrap(),
        );
        for index in 0..MAX_EXPORT_SESSIONS {
            begin_export_file_inner(
                &state,
                grant_id.clone(),
                format!("20260809-Synthetic-{index}.txt"),
                1,
                sha256_bytes(b"x"),
            )
            .unwrap();
        }
        let before = fs::read_dir(&directory.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(is_task_export_temporary_name)
            })
            .count();
        assert_eq!(before, MAX_EXPORT_SESSIONS);
        assert!(begin_export_file_inner(
            &state,
            grant_id,
            "20260809-Synthetic-Rejected.txt".to_string(),
            1,
            sha256_bytes(b"x"),
        )
        .is_err());
        let after = fs::read_dir(&directory.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(is_task_export_temporary_name)
            })
            .count();
        assert_eq!(after, before);
        assert_eq!(
            safe_lock(&state.export_sessions).unwrap().len(),
            MAX_EXPORT_SESSIONS
        );
    }

    #[test]
    fn partial_or_disk_full_write_revokes_session_and_cleans_temporary() {
        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let grant_id = Uuid::new_v4().to_string();
        safe_lock(&state.output_grants).unwrap().insert(
            grant_id.clone(),
            OutputGrant::new(directory.0.clone()).unwrap(),
        );
        let bytes = b"synthetic output";
        let filename = "20260809-Synthetic-Partial.txt";
        let session = begin_export_file_inner(
            &state,
            grant_id,
            filename.to_string(),
            bytes.len() as u64,
            sha256_bytes(bytes),
        )
        .unwrap();
        let temporary = safe_lock(&state.export_sessions)
            .unwrap()
            .get(&session.session_id)
            .unwrap()
            .temporary
            .clone();
        let error = append_export_bytes_with(
            &state,
            session.session_id.clone(),
            0,
            bytes,
            |file, value| {
                file.write_all(&value[..4])?;
                Err(io::Error::new(
                    io::ErrorKind::StorageFull,
                    "synthetic disk full",
                ))
            },
        )
        .unwrap_err();
        assert_eq!(error, "The output file could not be written.");
        assert!(!safe_lock(&state.export_sessions)
            .unwrap()
            .contains_key(&session.session_id));
        assert!(!temporary.exists());
        assert!(!directory.0.join(filename).exists());
    }

    #[test]
    fn windows_database_replace_flags_do_not_use_ignore_merge_errors() {
        let backend = include_str!("backend.rs");
        assert!(backend.contains("const REPLACEFILE_FLAGS: u32 = 0;"));
        assert!(!backend.contains(concat!("const WRITE_", "THROUGH: u32 = 0x0000_0002;")));
        assert!(backend.contains("const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;"));
    }

    #[test]
    fn destination_validation_rejects_windows_unc_device_and_verbatim_paths() {
        for path in [
            r"\\server\share\exports",
            r"\\?\C:\exports",
            r"\\.\GLOBALROOT\Device\HarddiskVolumeShadowCopy1",
        ] {
            assert!(
                reject_windows_device_path(Path::new(path)).is_err(),
                "{path}"
            );
        }
        #[cfg(windows)]
        {
            assert!(has_trusted_windows_disk_prefix(Path::new(r"C:\exports")));
            assert!(has_trusted_windows_disk_prefix(Path::new(
                r"\\?\C:\exports"
            )));
            for path in [
                r"\\server\share\exports",
                r"\\?\UNC\server\share\exports",
                r"\\.\GLOBALROOT\Device\HarddiskVolumeShadowCopy1",
            ] {
                assert!(!has_trusted_windows_disk_prefix(Path::new(path)), "{path}");
            }
        }
    }

    #[test]
    fn export_content_validation_enforces_xlsx_zip_dimensions_and_utf8_text() {
        let directory = TestDirectory::new();
        let xlsx = directory.0.join("book.xlsx");
        fs::write(&xlsx, synthetic_xlsx()).unwrap();
        assert!(validate_export_contents(&xlsx, "20260809-Book.xlsx").is_ok());
        fs::write(&xlsx, b"not-a-zip").unwrap();
        assert!(validate_export_contents(&xlsx, "20260809-Book.xlsx").is_err());
        fs::write(
            &xlsx,
            synthetic_xlsx_with_sheet(
                r#"<worksheet><dimension ref="A1:CW2"/><sheetData/></worksheet>"#,
            ),
        )
        .unwrap();
        assert!(validate_export_contents(&xlsx, "20260809-Book.xlsx").is_err());
        fs::write(
            &xlsx,
            synthetic_xlsx_with_sheet(
                r#"<worksheet><dimension ref="A1:A50002"/><sheetData/></worksheet>"#,
            ),
        )
        .unwrap();
        assert!(validate_export_contents(&xlsx, "20260809-Book.xlsx").is_err());
        fs::write(&xlsx, synthetic_xlsx_zip_bomb()).unwrap();
        assert!(validate_export_contents(&xlsx, "20260809-Book.xlsx").is_err());

        let text = directory.0.join("audit.txt");
        fs::write(&text, b"safe synthetic text").unwrap();
        assert!(validate_export_contents(&text, "20260809-Audit.txt").is_ok());
        fs::write(&text, [0xff, 0xfe]).unwrap();
        assert!(validate_export_contents(&text, "20260809-Audit.txt").is_err());
    }

    #[test]
    fn native_input_grants_are_role_scoped_bounded_and_memory_only() {
        assert!(validate_input_role("supplier", "csv", MAX_BUSINESS_INPUT_BYTES).is_ok());
        assert!(validate_input_role("servicem8", "xlsx", 1).is_ok());
        assert!(validate_input_role("configuration", "json", MAX_IMPORT_BYTES as u64).is_ok());
        assert!(validate_input_role("configuration", "csv", 1).is_err());
        assert!(validate_input_role("supplier", "json", 1).is_err());
        assert!(validate_input_role("supplier", "csv", MAX_BUSINESS_INPUT_BYTES + 1).is_err());

        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let path = directory.0.join("synthetic.csv");
        fs::write(&path, b"item,cost\n001,10.00\n").unwrap();
        let mut file = OpenOptions::new().read(true).open(&path).unwrap();
        let length = file.metadata().unwrap().len();
        validate_open_input_file(&mut file, "csv", length).unwrap();
        let grant_id = Uuid::new_v4().to_string();
        safe_lock(&state.input_grants).unwrap().insert(
            grant_id.clone(),
            InputGrant {
                file,
                length,
                created_at: Instant::now(),
            },
        );
        let first = read_input_chunk_inner(&state, grant_id.clone(), 0, 4).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(first)
                .unwrap(),
            b"item"
        );
        assert!(read_input_chunk_inner(&state, grant_id, length, 1).is_err());
        let database = fs::read(directory.database()).unwrap();
        assert!(!database
            .windows(b"item,cost\n001,10.00\n".len())
            .any(|window| window == b"item,cost\n001,10.00\n"));
    }

    #[test]
    fn csv_dimensions_count_quoted_newlines_and_escaped_quotes_as_one_record() {
        let csv = concat!(
            "item,description,notes\r\n",
            "001,\"Lock, keyed alike\",\"First line\r\nSecond \"\"quoted\"\" line\"\r\n",
            "002,Deadbolt,Plain text\r\n"
        );
        validate_csv_dimensions(csv.as_bytes()).unwrap();
        assert!(validate_csv_dimensions(b"item,description\n001,\"unterminated\n").is_err());
        assert!(validate_csv_dimensions(b"item,description\n001,\"closed\"trailing\n").is_err());
    }

    #[test]
    fn csv_dimensions_accept_exact_row_and_column_limits() {
        let header = (0..MAX_XLSX_COLUMNS_PER_SHEET)
            .map(|index| format!("column-{index}"))
            .collect::<Vec<_>>()
            .join(",");
        let mut csv = String::with_capacity(header.len() + (50_000 * 2));
        csv.push_str(&header);
        csv.push('\n');
        for _ in 0..50_000 {
            csv.push_str("x\n");
        }
        validate_csv_dimensions(csv.as_bytes()).unwrap();
    }

    #[test]
    fn csv_dimensions_reject_over_limit_rows_and_columns() {
        let too_many_columns = (0..=MAX_XLSX_COLUMNS_PER_SHEET)
            .map(|index| format!("column-{index}"))
            .collect::<Vec<_>>()
            .join(",");
        assert!(validate_csv_dimensions(too_many_columns.as_bytes()).is_err());

        let mut too_many_rows = String::from("item\n");
        for _ in 0..50_001 {
            too_many_rows.push_str("x\n");
        }
        assert!(validate_csv_dimensions(too_many_rows.as_bytes()).is_err());
    }

    #[test]
    fn source_links_require_credential_free_https() {
        assert!(validate_source_url("https://example.com/product/1").is_ok());
        assert!(validate_source_url("http://example.com/product/1").is_err());
        assert!(validate_source_url("https://user:secret@example.com/").is_err());
        assert!(validate_source_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn competitor_evidence_is_typed_bounded_and_credential_free() {
        assert!(validate_competitor_evidence(&sample_live_competitor_evidence()).is_ok());
        assert!(validate_competitor_evidence(&sample_manual_competitor_evidence()).is_ok());
        let current_live = sample_live_competitor_evidence();
        let round_trip = serde_json::from_value::<CompetitorEvidence>(
            serde_json::to_value(&current_live).unwrap(),
        )
        .unwrap();
        assert_eq!(round_trip, current_live);

        let mut contextual = sample_live_competitor_evidence();
        let CompetitorEvidence::Live(value) = &mut contextual else {
            unreachable!();
        };
        value.search_query = Some("Lockwood 001".to_string());
        value.selected_product_title = Some("Lockwood 001 Deadlatch".to_string());
        value.selected_product_brand = Some("Lockwood".to_string());
        value.selected_product_id = Some("product-main".to_string());
        assert!(validate_competitor_evidence(&contextual).is_ok());
        let contextual_json = serde_json::to_value(&contextual).unwrap();
        assert_eq!(
            contextual_json.get("searchQuery"),
            Some(&json!("Lockwood 001"))
        );
        assert_eq!(
            contextual_json.get("selectedProductTitle"),
            Some(&json!("Lockwood 001 Deadlatch"))
        );

        let mut partial_context = sample_live_competitor_evidence();
        let CompetitorEvidence::Live(value) = &mut partial_context else {
            unreachable!();
        };
        value.selected_product_id = Some("product-main".to_string());
        assert!(validate_competitor_evidence(&partial_context).is_err());

        let mut inconsistent_price = sample_live_competitor_evidence();
        let CompetitorEvidence::Live(value) = &mut inconsistent_price else {
            unreachable!();
        };
        value.price_aud = "123.46".to_string();
        assert!(validate_competitor_evidence(&inconsistent_price).is_err());

        let mut credential_url = sample_manual_competitor_evidence();
        let CompetitorEvidence::Manual(value) = &mut credential_url else {
            unreachable!();
        };
        value.url = Some("https://operator:secret@example.invalid/product".to_string());
        assert!(validate_competitor_evidence(&credential_url).is_err());

        let mut oversized = sample_live_competitor_evidence();
        let CompetitorEvidence::Live(value) = &mut oversized else {
            unreachable!();
        };
        value.title = "x".repeat(1_001);
        assert!(validate_competitor_evidence(&oversized).is_err());
    }

    #[test]
    fn legacy_live_references_upgrade_to_explicitly_non_comparable_evidence() {
        let legacy = json!({
            "title": "Synthetic legacy evidence",
            "priceCents": 12345,
            "priceAud": "123.45",
            "currency": "AUD",
            "gstBasis": "unknown",
            "packSize": null,
            "seller": "Synthetic seller",
            "sourceDomain": "example.invalid",
            "url": "https://example.invalid/item",
            "retrievedAt": "2026-08-09T00:00:00Z"
        });
        let evidence = serde_json::from_value::<CompetitorEvidence>(legacy).unwrap();
        let CompetitorEvidence::Live(evidence) = evidence else {
            panic!("legacy live evidence must retain its type");
        };
        assert_eq!(evidence.item_price_cents, 12_345);
        assert_eq!(evidence.shipping_cents, None);
        assert_eq!(evidence.total_price_cents, None);
        assert!(!evidence.comparison_eligible);
        assert_eq!(evidence.price_basis, "not_comparable");
        assert_eq!(
            evidence.exclusion_reasons,
            vec![
                "unknown_comparison_total".to_string(),
                "unverified_product_identity".to_string()
            ]
        );
        assert!(validate_live_competitor_evidence(&evidence).is_ok());
        let upgraded = serde_json::to_value(&evidence).unwrap();
        assert_eq!(upgraded.get("itemPriceCents"), Some(&json!(12_345)));
        assert_eq!(upgraded.get("comparisonEligible"), Some(&json!(false)));
    }

    #[test]
    fn rejected_competitor_evidence_cannot_mutate_reference_counts() {
        let directory = migrated_database();
        let connection = open_connection(&directory.database()).unwrap();
        insert_sample_catalogue(&connection);
        drop(connection);
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );

        attach_competitor_reference_inner(
            &state,
            "item-001".to_string(),
            sample_live_competitor_evidence(),
        )
        .unwrap();
        attach_competitor_reference_inner(
            &state,
            "item-001".to_string(),
            sample_manual_competitor_evidence(),
        )
        .unwrap();
        let count_references = || {
            let connection = open_connection(&directory.database()).unwrap();
            table_count(&connection, "competitor_references").unwrap()
        };
        assert_eq!(count_references(), 2);

        for forbidden in ["supplierCost", "rawImportedRow", "apiKey"] {
            let mut value = serde_json::to_value(sample_live_competitor_evidence()).unwrap();
            value
                .as_object_mut()
                .unwrap()
                .insert(forbidden.to_string(), json!("sensitive synthetic value"));
            assert!(serde_json::from_value::<CompetitorEvidence>(value).is_err());
            assert_eq!(count_references(), 2);
        }

        let mut invalid_url = sample_manual_competitor_evidence();
        let CompetitorEvidence::Manual(value) = &mut invalid_url else {
            unreachable!();
        };
        value.url = Some("https://user:password@example.invalid/product".to_string());
        assert!(
            attach_competitor_reference_inner(&state, "item-001".to_string(), invalid_url).is_err()
        );
        assert_eq!(count_references(), 2);
    }

    #[test]
    fn provider_allowlist_rejects_redirect_escape_targets() {
        assert!(allowlisted_provider_url(PROVIDER_ENDPOINT).is_ok());
        assert!(allowlisted_provider_url(PROVIDER_ACCOUNT_ENDPOINT).is_ok());
        assert!(allowlisted_provider_url("https://serpapi.com.evil.invalid/search.json").is_err());
        assert!(allowlisted_provider_url("http://serpapi.com/search.json").is_err());
        assert!(allowlisted_provider_url("https://user@serpapi.com/search.json").is_err());
        assert!(allowlisted_provider_url("https://user:secret@serpapi.com/search.json").is_err());
        assert!(allowlisted_provider_url("https://serpapi.com:444/search.json").is_err());
        assert!(allowlisted_provider_url("https://serpapi.com/unreviewed.json").is_err());
        assert!(allowlisted_provider_url("https://serpapi.com/account.json?extra=1").is_err());
    }

    #[test]
    fn provider_account_validation_accepts_only_active_recognised_accounts() {
        assert!(validate_provider_account_payload(
            br#"{"account_id":"synthetic-account","account_status":"Active","api_key":"must-be-ignored"}"#,
        )
        .is_ok());
        assert!(validate_provider_account_payload(
            br#"{"account_id":"synthetic-account","account_status":"Suspended"}"#,
        )
        .is_err());
        assert!(validate_provider_account_payload(br#"{"account_status":"Active"}"#).is_err());
    }

    #[test]
    fn capability_contains_only_explicit_swl_groups() {
        let capability = include_str!("../capabilities/default.json");
        let permissions = include_str!("../permissions/swl.toml");
        let config = include_str!("../tauri.conf.json");
        let backend = include_str!("backend.rs");
        assert!(!capability.contains("dialog:default"));
        assert!(!capability.contains("shell:"));
        assert!(!capability.contains("process:"));
        assert!(!capability.contains("fs:"));
        assert!(!capability.contains("http:"));
        for group in [
            "allow-swl-read",
            "allow-swl-write",
            "allow-swl-recovery",
            "allow-swl-search",
            "allow-swl-files",
        ] {
            assert!(capability.contains(group));
            assert!(permissions.contains(group));
        }
        assert!(!capability.contains("core:default"));
        assert!(!permissions.contains(concat!("\"append_", "approval\"")));
        assert!(!permissions.contains(concat!("\"append_price_", "history\"")));
        assert!(!backend.contains(concat!("std::", "process")));
        assert!(!backend.contains(concat!("Command", "::new")));
        assert!(config.contains("default-src 'none'"));
        assert!(config.contains("connect-src ipc: http://ipc.localhost"));
        assert!(config.contains("\"title\": \"SWL Pricing Initialising\""));
        let title_signal = concat!(".set_", "title(APPLICATION_READY_TITLE)");
        assert!(backend.contains(title_signal));
        let migration_ready = backend
            .find("apply_migrations(&database_path, &data_dir)")
            .expect("native migration setup");
        let state_ready = backend
            .find("app.manage(AppState::new(data_dir, platform_credential_store()))")
            .expect("native state setup");
        let title_ready = backend
            .find(title_signal)
            .expect("native title readiness signal");
        assert!(migration_ready < state_ready && state_ready < title_ready);
        assert!(!config.contains("unsafe-eval"));
        assert!(!config.contains("connect-src *"));
        for command in [
            "choose_input_file",
            "read_input_chunk",
            "release_input_grant",
        ] {
            assert!(permissions.contains(command));
        }
    }

    #[test]
    fn command_manifest_covers_registered_commands() {
        let build = include_str!("../build.rs");
        for forbidden in [
            concat!("shell_", "info"),
            concat!("append_", "approval"),
            concat!("append_price_", "history"),
            concat!("upsert_catalogue_", "items"),
        ] {
            assert!(!build.contains(forbidden));
        }
        for command in [
            "desktop_health",
            "publish_approved_changes",
            "preview_configuration_import",
            "restore_backup",
            "reset_application_data",
            "set_provider_paid_calls",
            "search_competitors",
            "reserve_export_batch",
            "begin_export_file",
            "commit_export_file",
            "commit_export_batch",
            "abort_export_batch",
            "export_configuration_to_folder",
            "choose_input_file",
        ] {
            assert!(build.contains(command));
        }
    }

    #[test]
    fn untrusted_frontend_cannot_read_a_path_without_a_native_grant() {
        let directory = migrated_database();
        let state = AppState::new(
            directory.0.clone(),
            Arc::new(MemoryCredentialStore::default()),
        );
        let requested = directory.0.join("unrelated-home-file.txt");
        fs::write(&requested, b"must not cross IPC").unwrap();
        let error = read_input_chunk_inner(&state, "not-a-grant".to_string(), 0, 1).unwrap_err();
        assert!(error.contains("grant"));
        assert!(!error.contains(&requested.to_string_lossy().to_string()));
    }
}
