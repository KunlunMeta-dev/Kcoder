//! Memory database versions are independent of settings, State and releases.
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, Transaction, TransactionBehavior};

const SCHEMA_VERSION: i64 = 1;
const BASELINE: &str = include_str!("v0000_to_v0001.sql");
const SEARCH_INDEXES: &str = include_str!("repair_search_indexes.sql");

pub(crate) fn validate_version(connection: &Connection) -> Result<i64> {
    let version =
        connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))?;
    ensure!(
        (0..=SCHEMA_VERSION).contains(&version),
        "unsupported memory schema version {version}; maximum is {SCHEMA_VERSION}"
    );
    Ok(version)
}

pub(crate) fn upgrade(connection: &Connection) -> Result<()> {
    validate_version(connection)?;
    let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    if validate_version(&transaction)? == 0 {
        // Released databases without a marker are the v0 baseline, including
        // the older shape without the two visibility columns.
        transaction
            .execute_batch(BASELINE)
            .context("initialize memory schema")?;
        for table in ["memory_observations", "memory_summaries"] {
            let present = transaction
                .prepare(&format!("PRAGMA table_info({table})"))?
                .query_map([], |row| row.get::<_, String>("name"))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .iter()
                .any(|name| name == "hidden_at_epoch");
            if !present {
                transaction.execute_batch(&format!(
                    "ALTER TABLE {table} ADD COLUMN hidden_at_epoch INTEGER"
                ))?;
            }
        }
        transaction.pragma_update(None, "user_version", 1)?;
    }
    // This is existing startup recovery of a derived search index, not another
    // authoritative schema upgrade. It also restores missing indexed rows.
    transaction
        .execute_batch(SEARCH_INDEXES)
        .context("restore memory search indexes")?;
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests;
