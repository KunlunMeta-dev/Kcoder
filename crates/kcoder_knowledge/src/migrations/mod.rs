//! Released Wiki schema transitions, compiled into the owning writer.
use anyhow::{Result, ensure};
use rusqlite::{Connection, TransactionBehavior};

pub(crate) const SCHEMA_VERSION: i64 = 18;
const STEPS: [&str; SCHEMA_VERSION as usize] = [
    include_str!("v0000_to_v0001.sql"),
    include_str!("v0001_to_v0002.sql"),
    include_str!("v0002_to_v0003.sql"),
    include_str!("v0003_to_v0004.sql"),
    include_str!("v0004_to_v0005.sql"),
    include_str!("v0005_to_v0006.sql"),
    include_str!("v0006_to_v0007.sql"),
    include_str!("v0007_to_v0008.sql"),
    include_str!("v0008_to_v0009.sql"),
    include_str!("v0009_to_v0010.sql"),
    include_str!("v0010_to_v0011.sql"),
    include_str!("v0011_to_v0012.sql"),
    include_str!("v0012_to_v0013.sql"),
    include_str!("v0013_to_v0014.sql"),
    include_str!("v0014_to_v0015.sql"),
    include_str!("v0015_to_v0016.sql"),
    include_str!("v0016_to_v0017.sql"),
    include_str!("v0017_to_v0018.sql"),
];

pub(crate) fn upgrade(connection: &mut Connection) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Recheck under the write lock; another owner may have just upgraded.
    let version: i64 = transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
    ensure!(
        (0..=SCHEMA_VERSION).contains(&version),
        "unsupported future knowledge schema version {version}"
    );
    for (index, sql) in STEPS.iter().enumerate().skip(version as usize) {
        transaction.execute_batch(sql)?;
        transaction.pragma_update(None, "user_version", index as i64 + 1)?;
    }
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests;
