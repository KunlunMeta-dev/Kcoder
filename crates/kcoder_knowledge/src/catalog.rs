use anyhow::{Context, Result, bail, ensure};
pub use kcoder_types::knowledge::KnowledgeLibrary as Library;
use rusqlite::{Connection, OptionalExtension, params};
use std::{path::Path, time::Duration};

pub(crate) use crate::migrations::SCHEMA_VERSION;

/// Host-only identity. Deliberately not deserializable from model or RPC input.
#[derive(Debug, Clone)]
pub struct KnowledgeScope {
    pub(crate) principal: String,
    pub(crate) target: String,
}

impl KnowledgeScope {
    pub fn from_authenticated_host(principal: &str, target: &str) -> Result<Self> {
        ensure!(
            !principal.trim().is_empty(),
            "knowledge principal is required"
        );
        ensure!(!target.trim().is_empty(), "knowledge target is required");
        ensure!(
            principal.len() <= 512 && target.len() <= 512,
            "knowledge scope is too large"
        );
        Ok(Self {
            principal: principal.into(),
            target: target.into(),
        })
    }
}

/// Catalog changes are transactional. Files and jobs will use the same owner scope.
pub struct KnowledgeCatalog {
    pub(crate) connection: Connection,
    pub(crate) objects: crate::objects::ObjectStore,
}

impl KnowledgeCatalog {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path).context("open knowledge catalog")?;
        connection.busy_timeout(Duration::from_secs(5))?;
        let current: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        ensure!(
            current <= SCHEMA_VERSION,
            "unsupported future knowledge schema version {current}"
        );
        let objects = crate::objects::ObjectStore::open(path.with_extension("objects"))?;
        Self::initialize_owned_connection(connection, objects)
    }

    /// Reuse schema initialization on an already authenticated, handle-owned connection.
    /// Call only from an explicitly authorized writer, never an observation path.
    pub(crate) fn initialize_owned_connection(
        mut connection: Connection,
        objects: crate::objects::ObjectStore,
    ) -> Result<Self> {
        connection.busy_timeout(Duration::from_secs(5))?;
        let current: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        ensure!(
            current <= SCHEMA_VERSION,
            "unsupported future knowledge schema version {current}"
        );
        if current == SCHEMA_VERSION {
            return Ok(Self {
                connection,
                objects,
            });
        }

        crate::migrations::upgrade(&mut connection)?;
        Ok(Self {
            connection,
            objects,
        })
    }

    /// Retrying an acknowledged-or-lost create cannot create a second Wiki.
    /// Reusing a key with a different payload is an explicit conflict.
    pub fn create(
        &mut self,
        scope: &KnowledgeScope,
        request_key: &str,
        name: &str,
        purpose: &str,
    ) -> Result<Library> {
        ensure!(
            !request_key.trim().is_empty() && request_key.len() <= 128,
            "invalid request key"
        );
        let name = name.trim();
        ensure!(
            !name.is_empty() && name.chars().count() <= 120,
            "invalid library name"
        );
        ensure!(purpose.len() <= 32 * 1024, "library purpose is too large");
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing = transaction.query_row(
            "SELECT id,name,purpose,archived,metadata_revision FROM libraries WHERE principal=?1 AND target=?2 AND request_key=?3",
            params![scope.principal, scope.target, request_key], read_library,
        ).optional()?;
        if let Some(existing) = existing {
            ensure!(
                existing.name == name && existing.purpose == purpose,
                "idempotency conflict"
            );
            return Ok(existing);
        }
        let library = Library {
            revision: 1,
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            purpose: purpose.into(),
            archived: false,
        };
        transaction.execute(
            "INSERT INTO libraries(id,principal,target,name,purpose,request_key) VALUES(?1,?2,?3,?4,?5,?6)",
            params![library.id, scope.principal, scope.target, library.name, library.purpose, request_key],
        )?;
        transaction.commit()?;
        Ok(library)
    }

    pub fn read(&self, scope: &KnowledgeScope, id: &str) -> Result<Library> {
        let library = self.connection.query_row(
            "SELECT id,name,purpose,archived,metadata_revision FROM libraries WHERE principal=?1 AND target=?2 AND id=?3",
            params![scope.principal, scope.target, id], read_library,
        ).optional()?;
        match library {
            Some(library) => Ok(library),
            None => bail!("knowledge library not found"),
        }
    }

    pub fn list(
        &self,
        scope: &KnowledgeScope,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<Library>> {
        ensure!(
            (1..=100).contains(&limit),
            "library page limit must be 1..100"
        );
        let mut statement = self.connection.prepare(
            "SELECT id,name,purpose,archived,metadata_revision FROM libraries WHERE principal=?1 AND target=?2 AND id>?3 ORDER BY id LIMIT ?4"
        )?;
        Ok(statement
            .query_map(
                params![
                    scope.principal,
                    scope.target,
                    after_id.unwrap_or(""),
                    limit as i64
                ],
                read_library,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

pub(super) fn read_library(row: &rusqlite::Row<'_>) -> rusqlite::Result<Library> {
    Ok(Library {
        revision: row.get::<_, i64>(4)? as u64,
        id: row.get(0)?,
        name: row.get(1)?,
        purpose: row.get(2)?,
        archived: row.get(3)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_and_target_are_checked_even_for_guessed_ids() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let mut catalog = KnowledgeCatalog::open(&dir.path().join("state.sqlite"))?;
        let alice = KnowledgeScope::from_authenticated_host("alice", "server")?;
        let bob = KnowledgeScope::from_authenticated_host("bob", "server")?;
        let other_target = KnowledgeScope::from_authenticated_host("alice", "local")?;
        let library = catalog.create(&alice, "request-1", "研发资料", "保留证据")?;
        for denied in [&bob, &other_target] {
            assert!(catalog.list(denied, None, 100)?.is_empty());
            assert_eq!(
                catalog.read(denied, &library.id).unwrap_err().to_string(),
                catalog.read(denied, "missing").unwrap_err().to_string()
            );
        }
        assert_eq!(catalog.read(&alice, &library.id)?, library);
        Ok(())
    }

    #[test]
    fn create_retry_survives_reopen_and_does_not_accept_changed_payload() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("state.sqlite");
        let scope = KnowledgeScope::from_authenticated_host("alice", "server")?;
        let mut first = KnowledgeCatalog::open(&path)?;
        let library = first.create(&scope, "request", "Wiki", "purpose")?;
        drop(first);
        let mut second = KnowledgeCatalog::open(&path)?;
        assert_eq!(
            second.create(&scope, "request", "Wiki", "purpose")?,
            library
        );
        assert!(
            second
                .create(&scope, "request", "Changed", "purpose")
                .is_err()
        );
        assert_eq!(second.list(&scope, None, 100)?.len(), 1);
        assert!(second.list(&scope, Some(&library.id), 100)?.is_empty());
        assert!(second.list(&scope, None, 0).is_err());
        Ok(())
    }

    #[test]
    fn future_schema_is_rejected_without_downgrade() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("state.sqlite");
        Connection::open(&path)?.execute_batch("PRAGMA user_version=99")?;
        assert!(KnowledgeCatalog::open(&path).is_err());
        let version: i64 =
            Connection::open(path)?.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        assert_eq!(version, 99);
        Ok(())
    }
}
