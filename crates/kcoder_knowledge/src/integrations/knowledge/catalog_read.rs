//! Pure existing-catalog observation through pinned DB/WAL descriptors and private RAM SHM.
use crate::KnowledgeCatalog;
use anyhow::{Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode, SqliteSourcePart,
    VerifiedPrivateLease,
};
use rusqlite::{Connection, OpenFlags, config::DbConfig, limits::Limit};
use serde::Serialize;
use std::{path::Path, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
mod vfs;

pub type CatalogReadCancellation = CancellationToken;
#[derive(Clone, Copy)]
pub struct CatalogReadLimits {
    pub read_bytes: u64,
    pub source_bytes: u64,
    pub elapsed: Duration,
}
impl Default for CatalogReadLimits {
    fn default() -> Self {
        Self {
            read_bytes: 64 * 1024 * 1024,
            source_bytes: 1024 * 1024 * 1024,
            elapsed: Duration::from_secs(2),
        }
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogReadProof {
    pub source_identity_sha256: String,
    pub database_bytes: u64,
    pub wal_bytes: u64,
    pub actual_read_bytes: u64,
    pub actual_reads: u64,
    pub input_digest: String,
    pub elapsed_ms: u64,
    pub source_write_attempts: u64,
}

/// This owns both the Connection and original VFS lease. Its closure API verifies
/// source continuity after closing SQLite, including attempted close-time checkpoint writes.
pub struct ExistingKnowledgeCatalog {
    catalog: Option<KnowledgeCatalog>,
    registration: vfs::Lease,
    _namespace_lease: Option<VerifiedPrivateLease>,
}
impl ExistingKnowledgeCatalog {
    pub fn with_catalog<T>(
        mut self,
        read: impl FnOnce(&mut KnowledgeCatalog) -> Result<T>,
    ) -> Result<(T, CatalogReadProof)> {
        let result = read(
            self.catalog
                .as_mut()
                .expect("catalog is closed only by this owner"),
        );
        let catalog = self.catalog.take().expect("catalog is owned");
        let closed = catalog.connection.close();
        if let Some(code) = self.registration.context.failure() {
            anyhow::bail!(code);
        }
        ensure!(closed.is_ok(), "knowledge_catalog_source_read_failed");
        let proof = self.registration.context.proof()?;
        Ok((result?, proof))
    }
}

impl KnowledgeCatalog {
    /// The authenticated host already holds the original private Wiki directory.
    /// Fixed relative names keep DB/WAL and objects on that same directory FD.
    pub fn open_existing_native_directory(
        directory: PrivateDirectory,
        database: &std::ffi::OsStr,
        objects: &std::ffi::OsStr,
        cancellation: &CatalogReadCancellation,
        limits: CatalogReadLimits,
    ) -> Result<ExistingKnowledgeCatalog> {
        ensure!(
            limits.read_bytes > 0 && limits.source_bytes > 0 && !limits.elapsed.is_zero(),
            "knowledge_catalog_source_invalid_budget"
        );
        directory.verify_private_directory()?;
        let source = directory
            .try_sqlite_source_read_lease(database, limits.source_bytes)?
            .ok_or_else(|| anyhow::anyhow!("knowledge_catalog_source_busy"))?;
        let registration = vfs::acquire(source, cancellation.clone(), limits)?;
        let objects = crate::objects::ObjectStore::open_existing_child(directory, objects)?;
        Self::from_observed_source(registration, objects, None)
    }

    /// The library's actual historical read grant is checked first. Logical removal and
    /// archive remain lifecycle metadata, while an absent exact revision never selects latest.
    pub fn observe_fixed_page_source(
        &self,
        scope: &crate::KnowledgeScope,
        source: &kcoder_types::integrations::knowledge::PublicationSource,
        now_ms: u64,
    ) -> Result<kcoder_types::integrations::knowledge::KnowledgeSourceObservation> {
        use kcoder_types::integrations::knowledge::KnowledgeSourceObservation;
        use rusqlite::OptionalExtension;
        let library = self.read(scope, &source.library_id)?;
        let metadata:Option<(String,String)>=self.connection.query_row(
            "SELECT body_hash,citations_json FROM knowledge_page_revisions WHERE library_id=?1 AND page_id=?2 AND revision_id=?3",
            rusqlite::params![source.library_id,source.page_id,source.page_revision],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        let Some((hash, citations)) = metadata else {
            return Ok(KnowledgeSourceObservation {
                source: source.clone(),
                available: false,
                removed: false,
                archived: library.archived,
                observed_at_ms: now_ms,
            });
        };
        let citations: Vec<kcoder_types::knowledge::KnowledgeCitation> =
            serde_json::from_str(&citations)?;
        let mut removed = false;
        for citation in citations {
            removed |= self
                .source_status(scope, &source.library_id, &citation.source_id)?
                .removed;
        }
        let available = match self.objects.read_bytes(&source.library_id, &hash) {
            Ok(_) => true,
            Err(error)
                if error.chain().any(|cause| {
                    cause
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|cause| cause.kind() == std::io::ErrorKind::NotFound)
                }) =>
            {
                false
            }
            Err(error) => return Err(error),
        };
        Ok(KnowledgeSourceObservation {
            source: source.clone(),
            available,
            removed,
            archived: library.archived,
            observed_at_ms: now_ms,
        })
    }
    /// The native caller must already authorize this actual profile/catalog. Paths are
    /// never RPC capability grants. Missing files, old schemas and hot journals are errors.
    pub fn open_existing_native(
        path: &Path,
        cancellation: &CatalogReadCancellation,
        limits: CatalogReadLimits,
    ) -> Result<ExistingKnowledgeCatalog> {
        ensure!(
            limits.read_bytes > 0 && limits.source_bytes > 0 && !limits.elapsed.is_zero(),
            "knowledge_catalog_source_invalid_budget"
        );
        let parent = PrivateDirectory::open_existing(
            path.parent()
                .ok_or_else(|| anyhow::anyhow!("knowledge_catalog_source_missing"))?,
        )?;
        parent.verify_private_directory()?;
        let name = path
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("knowledge_catalog_source_missing"))?;
        Self::observe_from_directory(
            &parent,
            name,
            &path.with_extension("objects"),
            None,
            None,
            cancellation,
            limits,
        )
    }

    /// Owned publication reads share their writer's original namespace lock and expected DB ID.
    #[allow(clippy::too_many_arguments)]
    pub fn open_existing_native_owned(
        directory: &PrivateDirectory,
        database_identity: &PortableLeaseIdentity,
        lock_identity: &PortableLeaseIdentity,
        objects_root: &Path,
        cancellation: &CatalogReadCancellation,
        limits: CatalogReadLimits,
    ) -> Result<ExistingKnowledgeCatalog> {
        let lease = directory
            .try_existing_portable_lock(
                std::ffi::OsStr::new("catalog.lock"),
                lock_identity,
                PrivateLeaseMode::Shared,
            )?
            .ok_or_else(|| anyhow::anyhow!("knowledge_catalog_source_busy"))?;
        Self::observe_from_directory(
            directory,
            std::ffi::OsStr::new("catalog.sqlite"),
            objects_root,
            Some(database_identity),
            Some(lease),
            cancellation,
            limits,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn observe_from_directory(
        parent: &PrivateDirectory,
        name: &std::ffi::OsStr,
        objects_root: &Path,
        expected: Option<&PortableLeaseIdentity>,
        namespace_lease: Option<VerifiedPrivateLease>,
        cancellation: &CatalogReadCancellation,
        limits: CatalogReadLimits,
    ) -> Result<ExistingKnowledgeCatalog> {
        ensure!(
            limits.read_bytes > 0 && limits.source_bytes > 0 && !limits.elapsed.is_zero(),
            "knowledge_catalog_source_invalid_budget"
        );
        parent.verify_private_directory()?;
        let source = parent
            .try_sqlite_source_read_lease(name, limits.source_bytes)?
            .ok_or_else(|| anyhow::anyhow!("knowledge_catalog_source_busy"))?;
        if let Some(expected) = expected {
            ensure!(
                source
                    .fact(SqliteSourcePart::Database)
                    .is_some_and(|fact| &fact.identity == expected),
                "knowledge_catalog_source_changed"
            );
        }
        let registration = vfs::acquire(source, cancellation.clone(), limits)?;
        let objects = crate::objects::ObjectStore::open_existing(objects_root.to_path_buf())?;
        Self::from_observed_source(registration, objects, namespace_lease)
    }

    fn from_observed_source(
        registration: vfs::Lease,
        objects: crate::objects::ObjectStore,
        namespace_lease: Option<VerifiedPrivateLease>,
    ) -> Result<ExistingKnowledgeCatalog> {
        // Virtual READ_WRITE is needed for SQLite's private in-memory WAL index. The VFS
        // refuses every write/create/delete of actual source DB, WAL and SHM entries.
        let connection = Connection::open_with_flags_and_vfs(
            "catalog.sqlite",
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            registration.name(),
        )?;
        configure(&connection, Arc::clone(&registration.context))?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        ensure!(
            version == crate::catalog::SCHEMA_VERSION,
            "knowledge_catalog_source_schema_unsupported"
        );
        registration.context.proof()?;
        Ok(ExistingKnowledgeCatalog {
            catalog: Some(KnowledgeCatalog {
                connection,
                objects,
            }),
            registration,
            _namespace_lease: namespace_lease,
        })
    }
}
fn configure(connection: &Connection, context: Arc<vfs::Context>) -> Result<()> {
    connection.busy_timeout(Duration::ZERO)?;
    connection.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)?;
    connection.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, false)?;
    connection.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_VIEW, false)?;
    connection.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
    connection.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)?;
    connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, 8 * 1024 * 1024);
    connection.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 64 * 1024);
    connection.set_limit(Limit::SQLITE_LIMIT_COLUMN, 256);
    connection.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0);
    connection.execute_batch("PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-2048; PRAGMA mmap_size=0;")?;
    connection.progress_handler(100, Some(move || context.check(0).is_err()));
    Ok(())
}

#[cfg(test)]
mod tests;
