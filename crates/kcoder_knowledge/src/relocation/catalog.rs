//! Full I/O is restricted to this explicit, stopped-owner evidence boundary.
use crate::{KnowledgeCatalog, integrations::knowledge::CatalogReadLimits};
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory, SqliteSourcePart, SqliteSourceReadLease,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, ffi::OsStr, io::Read, time::Duration};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
pub enum KnowledgeRelocationKind {
    Wiki,
    Publications,
}
impl KnowledgeRelocationKind {
    fn names(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Wiki => (
                "state.sqlite",
                "state.objects",
                super::super::profile_scope::RECORD,
            ),
            Self::Publications => ("catalog.sqlite", "catalog.objects", "catalog-binding.json"),
        }
    }
}

#[derive(Clone, Copy)]
pub struct KnowledgeRelocationLimits {
    pub entries: usize,
    pub bytes: u64,
    pub elapsed: Duration,
}
impl Default for KnowledgeRelocationLimits {
    fn default() -> Self {
        Self {
            entries: 1_000_000,
            bytes: 1024 * 1024 * 1024 * 1024,
            elapsed: Duration::from_secs(300),
        }
    }
}

/// Large object inventories are streamed into this small summary. They never
/// become a nested member of the global migration receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeCatalogRelocationSnapshot {
    pub directory_identity: String,
    pub database_identity: PortableLeaseIdentity,
    pub objects_identity: String,
    pub content_sha256: String,
    pub entries: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeCatalogRelocationPreview {
    pub entries: u64,
    pub bytes: u64,
}

/// Metadata and bounded schema checks only. Full content verification belongs
/// to the stopped snapshot, never to a directory-selection preview.
pub fn knowledge_catalog_relocation_preview(
    directory: &PrivateDirectory,
    kind: KnowledgeRelocationKind,
    limits: KnowledgeRelocationLimits,
) -> Result<KnowledgeCatalogRelocationPreview> {
    let observed = observe_catalog(directory, kind, limits, false, None)?;
    Ok(KnowledgeCatalogRelocationPreview {
        entries: observed.inventory.entries,
        bytes: observed.inventory.bytes,
    })
}
impl KnowledgeCatalogRelocationSnapshot {
    pub fn same_content(&self, other: &Self) -> bool {
        self.content_sha256 == other.content_sha256
            && self.entries == other.entries
            && self.bytes == other.bytes
    }
}

/// Observe every known leaf without following a link, changing SQLite state,
/// repairing a schema, clearing a lease, or settling an unknown model call.
pub fn knowledge_catalog_relocation_snapshot(
    directory: &PrivateDirectory,
    kind: KnowledgeRelocationKind,
    limits: KnowledgeRelocationLimits,
) -> Result<KnowledgeCatalogRelocationSnapshot> {
    let source = acquire_source(directory, kind, limits)?;
    knowledge_catalog_relocation_snapshot_from_source(directory, kind, limits, &source)
}

/// The source-prepared owner keeps this exact lease alive across the copy.
pub fn knowledge_catalog_relocation_snapshot_from_source(
    directory: &PrivateDirectory,
    kind: KnowledgeRelocationKind,
    limits: KnowledgeRelocationLimits,
    source: &SqliteSourceReadLease,
) -> Result<KnowledgeCatalogRelocationSnapshot> {
    let observed = observe_catalog(directory, kind, limits, true, Some(source))?;
    Ok(KnowledgeCatalogRelocationSnapshot {
        directory_identity: observed.directory_identity,
        database_identity: observed.database_identity,
        objects_identity: observed.objects_identity,
        content_sha256: super::digest(&serde_json::to_vec(&observed.inventory.records)?),
        entries: observed.inventory.entries,
        bytes: observed.inventory.bytes,
    })
}

pub(super) fn acquire_source(
    directory: &PrivateDirectory,
    kind: KnowledgeRelocationKind,
    limits: KnowledgeRelocationLimits,
) -> Result<SqliteSourceReadLease> {
    directory
        .try_sqlite_source_read_lease(OsStr::new(kind.names().0), limits.bytes)?
        .context("KNOWLEDGE_RELOCATION_BUSY")
}

struct ObservedCatalog {
    directory_identity: String,
    database_identity: PortableLeaseIdentity,
    objects_identity: String,
    inventory: Inventory,
}

fn observe_catalog(
    directory: &PrivateDirectory,
    kind: KnowledgeRelocationKind,
    limits: KnowledgeRelocationLimits,
    hash_contents: bool,
    source: Option<&SqliteSourceReadLease>,
) -> Result<ObservedCatalog> {
    ensure!(
        limits.entries > 0 && limits.bytes > 0 && !limits.elapsed.is_zero(),
        "KNOWLEDGE_RELOCATION_INVALID_BUDGET"
    );
    directory.verify_trusted_config_directory()?;
    let (database, objects, control) = kind.names();
    let before = directory.directory_identity()?;
    let source = match source {
        Some(source) => source.clone(),
        None => acquire_source(directory, kind, limits)?,
    };
    source.verify()?;
    let database_identity = source
        .fact(SqliteSourcePart::Database)
        .context("KNOWLEDGE_RELOCATION_DATABASE_MISSING")?
        .identity
        .clone();
    let objects_identity = directory
        .open_child(OsStr::new(objects), false)?
        .directory_identity()?;
    let mut inventory = Inventory {
        records: BTreeMap::new(),
        entries: 0,
        bytes: 0,
        limits,
        started: std::time::Instant::now(),
        hash_contents,
    };
    let mut names = Vec::new();
    directory.visit_entry_names_bounded(65_536, |name| {
        names.push(name.to_os_string());
        Ok(())
    })?;
    names.sort();
    for name in names {
        if name == OsStr::new(control) {
            continue;
        }
        let text = name
            .to_str()
            .context("KNOWLEDGE_RELOCATION_UNSUPPORTED_ENTRY")?;
        let sqlite = text == database
            || ["-wal", "-shm", "-journal"]
                .iter()
                .any(|suffix| text == format!("{database}{suffix}"));
        let allowed = sqlite
            || text == objects
            || matches!(
                (kind, text),
                (
                    KnowledgeRelocationKind::Wiki,
                    "worker-models" | "worker-diagnostic.json"
                ) | (KnowledgeRelocationKind::Publications, "catalog.lock")
            );
        ensure!(allowed, "KNOWLEDGE_RELOCATION_UNSUPPORTED_ENTRY: {text}");
        inventory.visit(directory, &name, text, 0, text == objects, sqlite)?;
    }
    let elapsed = inventory.started.elapsed();
    let reader = KnowledgeCatalog::open_existing_native_directory_from_source(
        directory.duplicate_handle()?,
        OsStr::new(database),
        OsStr::new(objects),
        source.clone(),
        &CancellationToken::new(),
        CatalogReadLimits {
            read_bytes: limits.bytes,
            source_bytes: limits.bytes,
            elapsed: limits.elapsed.saturating_sub(elapsed),
        },
    )?;
    reader.with_catalog(|catalog| {
        if !hash_contents {
            if matches!(kind, KnowledgeRelocationKind::Publications) {
                let version: i64 = catalog.connection.query_row("SELECT version FROM integration_publication_meta", [], |row| row.get(0))?;
                ensure!(version == 1, "KNOWLEDGE_RELOCATION_PUBLICATION_SCHEMA_UNSUPPORTED");
            }
            return Ok(());
        }
        let integrity: String = catalog.connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        ensure!(integrity == "ok", "KNOWLEDGE_RELOCATION_DATABASE_INVALID");
        ensure!(!catalog.connection.prepare("PRAGMA foreign_key_check")?.exists([])?, "KNOWLEDGE_RELOCATION_DATABASE_INVALID");
        // Check historical bodies and originals as well as current revisions.
        let mut statement = catalog.connection.prepare(
            "SELECT library_id,body_hash FROM knowledge_sources UNION SELECT library_id,body_hash FROM knowledge_page_revisions UNION SELECT library_id,raw_hash FROM knowledge_originals UNION SELECT library_id,body_hash FROM knowledge_stage_cache WHERE body_json IS NULL UNION SELECT library_id,original_hash FROM knowledge_image_imports")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let library: String = row.get(0)?;
            let hash: String = row.get(1)?;
            ensure!(inventory.records.contains_key(&format!("{objects}/{library}/{hash}.md")), "KNOWLEDGE_RELOCATION_OBJECT_MISSING");
        }
        let mut inline = catalog.connection.prepare("SELECT body_hash,body_json FROM knowledge_stage_cache WHERE body_json IS NOT NULL")?;
        let mut rows = inline.query([])?;
        while let Some(row) = rows.next()? {
            let hash: String = row.get(0)?;
            let body: String = row.get(1)?;
            ensure!(super::digest(body.as_bytes()) == hash, "KNOWLEDGE_RELOCATION_STAGE_CACHE_INVALID");
        }
        if matches!(kind, KnowledgeRelocationKind::Publications) {
            let version: i64 = catalog.connection.query_row("SELECT version FROM integration_publication_meta", [], |row| row.get(0))?;
            ensure!(version == 1, "KNOWLEDGE_RELOCATION_PUBLICATION_SCHEMA_UNSUPPORTED");
            let mut statement = catalog.connection.prepare("SELECT body_json,body_hash FROM integration_publications")?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let body: String = row.get(0)?;
                let hash: String = row.get(1)?;
                let _: kcoder_types::integrations::knowledge::KnowledgePublication = serde_json::from_str(&body)?;
                ensure!(super::digest(body.as_bytes()) == hash, "KNOWLEDGE_RELOCATION_PUBLICATION_INVALID");
            }
        }
        Ok(())
    })?;
    source.verify()?;
    ensure!(
        directory.directory_identity()? == before
            && directory
                .open_child(OsStr::new(objects), false)?
                .directory_identity()?
                == objects_identity,
        "KNOWLEDGE_RELOCATION_SOURCE_CHANGED"
    );
    Ok(ObservedCatalog {
        directory_identity: before,
        database_identity,
        objects_identity,
        inventory,
    })
}

struct Inventory {
    records: BTreeMap<String, (u64, String)>,
    entries: u64,
    bytes: u64,
    limits: KnowledgeRelocationLimits,
    started: std::time::Instant,
    hash_contents: bool,
}
impl Inventory {
    fn check(&self) -> Result<()> {
        ensure!(
            self.entries <= self.limits.entries as u64
                && self.bytes <= self.limits.bytes
                && self.started.elapsed() <= self.limits.elapsed,
            "KNOWLEDGE_RELOCATION_BUDGET_EXCEEDED"
        );
        Ok(())
    }
    fn visit(
        &mut self,
        parent: &PrivateDirectory,
        name: &OsStr,
        relative: &str,
        depth: usize,
        objects: bool,
        sqlite: bool,
    ) -> Result<()> {
        self.entries += 1;
        self.check()?;
        let entry = parent.open_entry_handle(name)?;
        ensure!(
            !entry.metadata().file_type().is_symlink(),
            "KNOWLEDGE_RELOCATION_UNSUPPORTED_LINK"
        );
        if entry.metadata().is_dir() {
            ensure!(depth < 2, "KNOWLEDGE_RELOCATION_UNSUPPORTED_ENTRY");
            if objects && depth == 1 {
                uuid::Uuid::parse_str(name.to_str().context("invalid object library")?)?;
            }
            let directory = entry.open_child_directory()?;
            directory.verify_trusted_config_directory()?;
            let identity = directory.directory_identity()?;
            let mut names = Vec::new();
            directory.visit_entry_names_bounded(65_536, |name| {
                names.push(name.to_os_string());
                Ok(())
            })?;
            names.sort();
            self.records
                .insert(relative.into(), (0, "directory".into()));
            for child in names {
                let child_text = child
                    .to_str()
                    .context("KNOWLEDGE_RELOCATION_UNSUPPORTED_ENTRY")?;
                self.visit(
                    &directory,
                    &child,
                    &format!("{relative}/{child_text}"),
                    depth + 1,
                    objects,
                    false,
                )?;
            }
            ensure!(
                parent.open_child(name, false)?.directory_identity()? == identity,
                "KNOWLEDGE_RELOCATION_SOURCE_CHANGED"
            );
        } else {
            ensure!(
                entry.metadata().is_file(),
                "KNOWLEDGE_RELOCATION_UNSUPPORTED_ENTRY"
            );
            let mut file = parent.open_single_link_regular_file(name)?;
            // SQLite and immutable revision bodies are ordinary business data.
            // The SQLite lease validates its owner/mode; object hashes and trusted
            // held parents validate revision bodies without requiring private ACLs.
            // Credential and control leaves retain their private-file admission.
            let identity = if sqlite || objects {
                PortableLeaseIdentity::from_regular_handle(&file)?
            } else {
                parent.portable_regular_handle_identity(&file)?
            };
            let current_identity = || -> Result<PortableLeaseIdentity> {
                if sqlite || objects {
                    PortableLeaseIdentity::from_regular_handle(
                        &parent.open_single_link_regular_file(name)?,
                    )
                } else {
                    parent.portable_regular_identity(name)
                }
            };
            ensure!(
                entry.identity()? == serde_json::to_string(&identity)?,
                "KNOWLEDGE_RELOCATION_SOURCE_CHANGED"
            );
            let length = file.metadata()?.len();
            self.bytes = self
                .bytes
                .checked_add(length)
                .context("KNOWLEDGE_RELOCATION_BUDGET_EXCEEDED")?;
            self.check()?;
            if !self.hash_contents {
                ensure!(
                    current_identity()? == identity,
                    "KNOWLEDGE_RELOCATION_SOURCE_CHANGED"
                );
                if objects {
                    ensure!(
                        depth == 2
                            && length <= 32 * 1024 * 1024
                            && name
                                .to_str()
                                .and_then(|name| name.strip_suffix(".md"))
                                .is_some_and(crate::profile_scope::sha),
                        "KNOWLEDGE_RELOCATION_OBJECT_INVALID"
                    );
                }
                self.records
                    .insert(relative.into(), (length, String::new()));
                return Ok(());
            }
            let mut hasher = Sha256::new();
            let mut total = 0;
            let mut buffer = [0; 64 * 1024];
            loop {
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                total += count as u64;
                ensure!(total <= length, "KNOWLEDGE_RELOCATION_SOURCE_CHANGED");
                hasher.update(&buffer[..count]);
                self.check()?;
            }
            let hash = format!("{:x}", hasher.finalize());
            ensure!(
                total == length
                    && current_identity()? == identity
                    && file.metadata()?.len() == length,
                "KNOWLEDGE_RELOCATION_SOURCE_CHANGED"
            );
            if objects {
                ensure!(
                    depth == 2
                        && length <= 32 * 1024 * 1024
                        && name == OsStr::new(&format!("{hash}.md")),
                    "KNOWLEDGE_RELOCATION_OBJECT_INVALID"
                );
            }
            self.records.insert(relative.into(), (length, hash));
        }
        Ok(())
    }
}
