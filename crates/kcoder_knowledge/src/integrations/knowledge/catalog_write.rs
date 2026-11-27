//! Authorized publication metadata writes through one owned namespace, not path reopening.
use crate::KnowledgeCatalog;
use anyhow::{Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease,
};
use rusqlite::{Connection, OpenFlags, config::DbConfig, limits::Limit};
use std::{ffi::OsStr, path::Path, time::Duration};
mod vfs;

/// The native host must hold its namespace's original exclusive owner lock until close.
/// No generic source database or caller-supplied path is accepted by this writer.
pub struct OwnedKnowledgeCatalog {
    catalog: Option<KnowledgeCatalog>,
    registration: vfs::Lease,
    _namespace_lease: VerifiedPrivateLease,
}
impl OwnedKnowledgeCatalog {
    pub fn with_catalog<T>(
        mut self,
        write: impl FnOnce(&mut KnowledgeCatalog) -> Result<T>,
    ) -> Result<T> {
        let result = write(self.catalog.as_mut().expect("catalog is owned"));
        let catalog = self.catalog.take().expect("catalog is owned");
        let closed = catalog.connection.close();
        self.registration.verify()?;
        ensure!(closed.is_ok(), "KNOWLEDGE_NATIVE_WRITE_UNCONFIRMED");
        result
    }
}
impl KnowledgeCatalog {
    pub fn open_native_owned(
        directory: &PrivateDirectory,
        database_identity: &PortableLeaseIdentity,
        lock_identity: &PortableLeaseIdentity,
        objects_root: &Path,
        initialize: bool,
    ) -> Result<OwnedKnowledgeCatalog> {
        let namespace_lease = directory
            .try_existing_portable_lock(
                OsStr::new("catalog.lock"),
                lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_NATIVE_STORE_BUSY"))?;
        let registration = vfs::acquire(directory, database_identity)?;
        let connection = Connection::open_with_flags_and_vfs(
            "catalog.sqlite",
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            registration.name(),
        )?;
        connection.busy_timeout(Duration::ZERO)?;
        connection.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)?;
        connection.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, false)?;
        connection.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_VIEW, false)?;
        connection.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
        connection.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)?;
        connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, 8 * 1024 * 1024);
        connection.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 64 * 1024);
        connection.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0);
        connection.execute_batch(
            "PRAGMA temp_store=MEMORY; PRAGMA synchronous=FULL; PRAGMA mmap_size=0;",
        )?;
        let objects = crate::objects::ObjectStore::open_existing(objects_root.to_path_buf())?;
        let catalog = if initialize {
            KnowledgeCatalog::initialize_owned_connection(connection, objects)?
        } else {
            let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
            ensure!(
                version == crate::catalog::SCHEMA_VERSION,
                "KNOWLEDGE_NATIVE_SCHEMA_UNAVAILABLE"
            );
            KnowledgeCatalog {
                connection,
                objects,
            }
        };
        registration.verify()?;
        Ok(OwnedKnowledgeCatalog {
            catalog: Some(catalog),
            registration,
            _namespace_lease: namespace_lease,
        })
    }
}

#[cfg(test)]
mod tests;
