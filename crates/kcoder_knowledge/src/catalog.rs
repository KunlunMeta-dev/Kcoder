use anyhow::{Context, Result, bail, ensure};
pub use kcoder_types::knowledge::KnowledgeLibrary as Library;
use rusqlite::{Connection, OptionalExtension, params};
use std::{path::Path, time::Duration};

const SCHEMA_VERSION: i64 = 14;

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
        let mut connection = Connection::open(path).context("open knowledge catalog")?;
        connection.busy_timeout(Duration::from_secs(5))?;
        let current: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        ensure!(
            current <= SCHEMA_VERSION,
            "unsupported future knowledge schema version {current}"
        );
        let objects = crate::objects::ObjectStore::open(path.with_extension("objects"))?;
        if current == SCHEMA_VERSION {
            return Ok(Self {
                connection,
                objects,
            });
        }

        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let version: i64 = transaction.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        ensure!(
            version <= SCHEMA_VERSION,
            "unsupported future knowledge schema version {version}"
        );
        if version == 0 {
            transaction.execute_batch(
                "CREATE TABLE libraries (
                    id TEXT PRIMARY KEY,
                    principal TEXT NOT NULL,
                    target TEXT NOT NULL,
                    name TEXT NOT NULL,
                    purpose TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
                    request_key TEXT NOT NULL,
                    UNIQUE(principal, target, request_key)
                );
                CREATE INDEX libraries_scope ON libraries(principal, target, id);
                PRAGMA user_version = 1;",
            )?;
        }
        if version < 2 {
            transaction.execute_batch(
                "CREATE VIRTUAL TABLE knowledge_fts USING fts5(
                    library_id UNINDEXED, document_id UNINDEXED, revision_id UNINDEXED,
                    display_title UNINDEXED, original_body UNINDEXED,
                    title_terms, body_terms, tokenize='unicode61'
                );
                PRAGMA user_version = 2;",
            )?;
        }
        if version < 3 {
            transaction.execute_batch(include_str!("schema_v3.sql"))?;
        }
        if version < 4 {
            transaction.execute_batch("CREATE TABLE knowledge_defaults(principal TEXT NOT NULL,target TEXT NOT NULL,library_id TEXT NOT NULL,PRIMARY KEY(principal,target)); PRAGMA user_version=4;")?;
        }
        if version < 5 {
            transaction.execute_batch(include_str!("schema_v5.sql"))?;
        }
        if version < 6 {
            transaction.execute_batch("CREATE TABLE knowledge_review_receipts(library_id TEXT NOT NULL,job_id TEXT NOT NULL,token TEXT NOT NULL,commit_key TEXT NOT NULL,payload_hash TEXT NOT NULL,accepted INTEGER NOT NULL,checkpoint_json TEXT NOT NULL,PRIMARY KEY(library_id,job_id,token)); PRAGMA user_version=6;")?;
        }
        if version < 7 {
            transaction.execute_batch(
                "ALTER TABLE knowledge_jobs ADD COLUMN error_detail TEXT; PRAGMA user_version=7;",
            )?;
        }
        if version < 8 {
            transaction.execute_batch(include_str!("schema_v8.sql"))?;
        }
        if version < 9 {
            transaction.execute_batch("ALTER TABLE libraries ADD COLUMN metadata_revision INTEGER NOT NULL DEFAULT 1; PRAGMA user_version=9;")?;
        }
        if version < 10 {
            transaction.execute_batch("ALTER TABLE knowledge_chunks ADD COLUMN page INTEGER; CREATE TABLE knowledge_originals(library_id TEXT NOT NULL, source_id TEXT NOT NULL, revision_id TEXT NOT NULL, raw_hash TEXT NOT NULL, format TEXT NOT NULL, PRIMARY KEY(library_id,source_id,revision_id)); PRAGMA user_version=10;")?;
        }
        if version < 11 {
            transaction.execute_batch("CREATE TABLE knowledge_archive_receipts(principal TEXT NOT NULL,target TEXT NOT NULL,request_key TEXT NOT NULL,payload_hash TEXT NOT NULL,library_id TEXT NOT NULL,PRIMARY KEY(principal,target,request_key)); PRAGMA user_version=11;")?;
        }
        if version < 12 {
            transaction.execute_batch("CREATE TABLE knowledge_source_lifecycle(library_id TEXT NOT NULL,source_id TEXT NOT NULL,current_revision TEXT NOT NULL,removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1)),PRIMARY KEY(library_id,source_id)); INSERT INTO knowledge_source_lifecycle(library_id,source_id,current_revision) SELECT library_id,source_id,revision_id FROM knowledge_sources WHERE rowid IN (SELECT MAX(rowid) FROM knowledge_sources GROUP BY library_id,source_id); PRAGMA user_version=12;")?;
        }
        if version < 13 {
            transaction.execute_batch("CREATE TABLE knowledge_job_budgets(library_id TEXT NOT NULL,job_id TEXT NOT NULL,call_limit INTEGER NOT NULL CHECK(call_limit BETWEEN 1 AND 4096),PRIMARY KEY(library_id,job_id)); CREATE TABLE knowledge_job_calls(library_id TEXT NOT NULL,job_id TEXT NOT NULL,call_id TEXT NOT NULL,lease_token TEXT NOT NULL,completed INTEGER NOT NULL CHECK(completed IN (0,1)),input_tokens INTEGER CHECK(input_tokens>=0),output_tokens INTEGER CHECK(output_tokens>=0),PRIMARY KEY(library_id,job_id,call_id),CHECK((input_tokens IS NULL)=(output_tokens IS NULL))); PRAGMA user_version=13;")?;
        }
        if version < 14 {
            transaction.execute_batch("CREATE TABLE knowledge_stage_cache(library_id TEXT NOT NULL,job_id TEXT NOT NULL,request_hash TEXT NOT NULL,body_hash TEXT NOT NULL,PRIMARY KEY(library_id,job_id,request_hash)); PRAGMA user_version=14;")?;
        }
        transaction.commit()?;
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

fn read_library(row: &rusqlite::Row<'_>) -> rusqlite::Result<Library> {
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
