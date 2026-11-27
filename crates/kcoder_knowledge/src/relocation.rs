//! Offline Wiki continuity; this owner never copies projects or starts a worker.
use crate::{
    personal_profile_scope,
    profile_scope::{self, ProfileAddress, ProfileScopeRecord, missing, valid_operation},
};
use anyhow::{Context, Result, ensure};
use kcoder_config::{PrivateDirectory, SqliteSourceReadLease, profile_identity::ProfileIdentity};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    io::Read,
    path::{Path, PathBuf},
};

mod catalog;
pub use catalog::{
    KnowledgeCatalogRelocationPreview, KnowledgeCatalogRelocationSnapshot, KnowledgeRelocationKind,
    KnowledgeRelocationLimits, knowledge_catalog_relocation_preview,
    knowledge_catalog_relocation_snapshot, knowledge_catalog_relocation_snapshot_from_source,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiRelocationSnapshot {
    profile_identity: String,
    logical_profile_seed: String,
    principal: String,
    prior_record_sha256: Option<String>,
    source_profiles: Vec<ProfileAddress>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    credential_files: BTreeMap<PathBuf, PathBuf>,
    credentials_sha256: String,
    pub catalog: KnowledgeCatalogRelocationSnapshot,
}

pub struct WikiRelocation {
    profile_path: PathBuf,
    profile: PrivateDirectory,
    logical: ProfileIdentity,
    directory: PrivateDirectory,
    limits: KnowledgeRelocationLimits,
}

/// Holds SQLite's original writer exclusion until target owner checks finish.
pub struct PreparedWikiRelocation<'a> {
    owner: &'a WikiRelocation,
    source: SqliteSourceReadLease,
}
impl PreparedWikiRelocation<'_> {
    pub fn relocation_snapshot(&self) -> Result<WikiRelocationSnapshot> {
        self.owner.snapshot_from_source(&self.source)
    }
    pub fn relocate(
        self,
        final_target_profile: &Path,
        operation_id: &str,
        expected: &WikiRelocationSnapshot,
    ) -> Result<()> {
        self.owner.relocation_target(
            final_target_profile,
            operation_id,
            expected,
            true,
            &self.source,
        )
    }
}
impl WikiRelocation {
    /// Absence is distinct from a partial, old-schema, or unsupported catalog.
    /// The coordinator must independently confirm all writers have stopped.
    pub fn observe(profile_path: &Path, limits: KnowledgeRelocationLimits) -> Result<Option<Self>> {
        let profile_path = profile_path.canonicalize()?;
        let profile = PrivateDirectory::open_existing(&profile_path)?;
        let logical = ProfileIdentity::observe(&profile)?;
        let directory = match profile.open_child(OsStr::new("knowledge"), false) {
            Ok(directory) => directory,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let result = Self {
            profile_path,
            profile,
            logical,
            directory,
            limits,
        };
        result.verify_profile()?;
        Ok(Some(result))
    }

    pub fn preview_relocation(&self) -> Result<KnowledgeCatalogRelocationPreview> {
        self.verify_profile()?;
        personal_profile_scope(&self.profile_path)?;
        let prior = profile_scope::read_record(&self.directory)?;
        let (sources, references) = prior
            .map(|(record, _)| (record.source_profiles, record.credential_files))
            .unwrap_or_default();
        worker_credential_references(
            &self.directory,
            &self.profile_path,
            &sources,
            &references,
            &self.profile,
            false,
        )?;
        knowledge_catalog_relocation_preview(
            &self.directory,
            KnowledgeRelocationKind::Wiki,
            self.limits,
        )
    }

    pub fn relocation_snapshot(&self) -> Result<WikiRelocationSnapshot> {
        let source =
            catalog::acquire_source(&self.directory, KnowledgeRelocationKind::Wiki, self.limits)?;
        self.snapshot_from_source(&source)
    }

    /// Call after confirmed shutdown and retain this object while freezing and
    /// copying. No DB, WAL, SHM or job state is initialized or changed.
    pub fn prepare_relocation(&self) -> Result<PreparedWikiRelocation<'_>> {
        self.verify_profile()?;
        let source =
            catalog::acquire_source(&self.directory, KnowledgeRelocationKind::Wiki, self.limits)?;
        Ok(PreparedWikiRelocation {
            owner: self,
            source,
        })
    }

    fn snapshot_from_source(
        &self,
        source: &SqliteSourceReadLease,
    ) -> Result<WikiRelocationSnapshot> {
        self.verify_profile()?;
        source.verify()?;
        let principal = personal_profile_scope(&self.profile_path)?.principal;
        let prior = profile_scope::read_record(&self.directory)?;
        let prior_record_sha256 = prior.as_ref().map(|(_, bytes)| digest(bytes));
        // Freeze the legacy principal roots once. Later moves retain them;
        // only actual immutable worker credential references need address routing.
        let source_profiles = match &prior {
            Some((record, _)) => record.source_profiles.clone(),
            None => vec![ProfileAddress {
                path: self.profile_path.clone(),
                identity: self.profile.directory_identity()?,
            }],
        };
        let references = prior
            .as_ref()
            .map(|(record, _)| record.credential_files.clone())
            .unwrap_or_default();
        let (credentials_sha256, credential_files) = worker_credential_references(
            &self.directory,
            &self.profile_path,
            &source_profiles,
            &references,
            &self.profile,
            true,
        )?;
        let catalog = knowledge_catalog_relocation_snapshot_from_source(
            &self.directory,
            KnowledgeRelocationKind::Wiki,
            self.limits,
            source,
        )?;
        self.verify_profile()?;
        source.verify()?;
        Ok(WikiRelocationSnapshot {
            profile_identity: self.profile.directory_identity()?,
            logical_profile_seed: self.logical.logical_seed().into(),
            principal,
            prior_record_sha256,
            source_profiles,
            credential_files,
            credentials_sha256,
            catalog,
        })
    }

    pub fn relocate(
        &self,
        final_target_profile: &Path,
        operation_id: &str,
        expected: &WikiRelocationSnapshot,
    ) -> Result<()> {
        self.prepare_relocation()?
            .relocate(final_target_profile, operation_id, expected)
    }

    pub fn verify_relocation(
        &self,
        final_target_profile: &Path,
        operation_id: &str,
        expected: &WikiRelocationSnapshot,
    ) -> Result<()> {
        let prepared = self.prepare_relocation()?;
        self.relocation_target(
            final_target_profile,
            operation_id,
            expected,
            false,
            &prepared.source,
        )
    }

    fn verify_profile(&self) -> Result<()> {
        self.logical.verify(&self.profile)?;
        ensure!(
            PrivateDirectory::open_existing(&self.profile_path)?.directory_identity()?
                == self.profile.directory_identity()?
                && self
                    .profile
                    .open_child(OsStr::new("knowledge"), false)?
                    .directory_identity()?
                    == self.directory.directory_identity()?,
            "KNOWLEDGE_RELOCATION_SOURCE_CHANGED"
        );
        Ok(())
    }

    fn relocation_target(
        &self,
        target_path: &Path,
        operation_id: &str,
        expected: &WikiRelocationSnapshot,
        publish: bool,
        source: &SqliteSourceReadLease,
    ) -> Result<()> {
        ensure!(
            valid_operation(operation_id),
            "KNOWLEDGE_RELOCATION_INVALID_OPERATION"
        );
        ensure!(
            self.snapshot_from_source(source)? == *expected,
            "KNOWLEDGE_RELOCATION_SOURCE_CHANGED"
        );
        let target_path = target_path.canonicalize()?;
        let profile = PrivateDirectory::open_existing(&target_path)?;
        let logical = self
            .logical
            .verify_relocation(&self.profile, &profile, operation_id)?;
        let directory = profile.open_child(OsStr::new("knowledge"), false)?;
        let target_source =
            catalog::acquire_source(&directory, KnowledgeRelocationKind::Wiki, self.limits)?;
        let target = knowledge_catalog_relocation_snapshot_from_source(
            &directory,
            KnowledgeRelocationKind::Wiki,
            self.limits,
            &target_source,
        )?;
        ensure!(
            target.directory_identity != expected.catalog.directory_identity
                && target.database_identity != expected.catalog.database_identity
                && target.objects_identity != expected.catalog.objects_identity
                && target.same_content(&expected.catalog),
            "KNOWLEDGE_RELOCATION_DATA_CHANGED"
        );
        ensure!(
            worker_credential_references(
                &directory,
                &self.profile_path,
                &expected.source_profiles,
                &expected.credential_files,
                &profile,
                true
            )?
            .0 == expected.credentials_sha256,
            "KNOWLEDGE_RELOCATION_CREDENTIAL_CHANGED"
        );
        let source_record = profile_scope::read_record(&self.directory)?;
        let mut record = source_record
            .as_ref()
            .map(|(record, _)| record.clone())
            .unwrap_or(ProfileScopeRecord {
                version: 2,
                operation_id: operation_id.into(),
                logical_profile_seed: expected.logical_profile_seed.clone(),
                source_profile_identity: expected.profile_identity.clone(),
                source_record_sha256: expected.prior_record_sha256.clone(),
                source_content_sha256: expected.catalog.content_sha256.clone(),
                source_credentials_sha256: expected.credentials_sha256.clone(),
                source_profiles: expected.source_profiles.clone(),
                credential_files: expected.credential_files.clone(),
                profile_identity: profile.directory_identity()?,
                knowledge_identity: directory.directory_identity()?,
                principal: expected.principal.clone(),
            });
        record.version = 2;
        record.credential_files = expected.credential_files.clone();
        let original = profile_scope::read_record(&directory)?;
        let committed = original
            .as_ref()
            .is_some_and(|(current, _)| *current == record);
        ensure!(
            committed || original == source_record,
            "KNOWLEDGE_RELOCATION_CONFLICT"
        );
        ensure!(publish || committed, "KNOWLEDGE_RELOCATION_UNCONFIRMED");
        let original_identity = original
            .as_ref()
            .map(|_| directory.portable_regular_identity(OsStr::new(profile_scope::RECORD)))
            .transpose()?;
        let verify = || -> Result<()> {
            self.verify_profile()?;
            logical.verify(&profile)?;
            ensure!(
                self.snapshot_from_source(source)? == *expected
                    && PrivateDirectory::open_existing(&target_path)?.directory_identity()?
                        == profile.directory_identity()?
                    && profile
                        .open_child(OsStr::new("knowledge"), false)?
                        .directory_identity()?
                        == directory.directory_identity()?
                    && knowledge_catalog_relocation_snapshot_from_source(
                        &directory,
                        KnowledgeRelocationKind::Wiki,
                        self.limits,
                        &target_source
                    )? == target,
                "KNOWLEDGE_RELOCATION_DATA_CHANGED"
            );
            ensure!(
                worker_credential_references(
                    &directory,
                    &self.profile_path,
                    &expected.source_profiles,
                    &expected.credential_files,
                    &profile,
                    true
                )?
                .0 == expected.credentials_sha256,
                "KNOWLEDGE_RELOCATION_CREDENTIAL_CHANGED"
            );
            Ok(())
        };
        if !committed {
            let bytes = serde_json::to_vec(&record)?;
            ensure!(
                bytes.len() <= 64 * 1024,
                "KNOWLEDGE_RELOCATION_CREDENTIAL_REFERENCE_LIMIT"
            );
            directory
                .atomic_publish_from_reader(
                    OsStr::new(profile_scope::RECORD),
                    &mut bytes.as_slice(),
                    original.is_some(),
                    || {
                        self.verify_profile()?;
                        source.verify()?;
                        target_source.verify()?;
                        logical.verify(&profile)?;
                        ensure!(
                            PrivateDirectory::open_existing(&target_path)?.directory_identity()?
                                == profile.directory_identity()?
                                && profile
                                    .open_child(OsStr::new("knowledge"), false)?
                                    .directory_identity()?
                                    == directory.directory_identity()?,
                            "KNOWLEDGE_RELOCATION_DATA_CHANGED"
                        );
                        ensure!(
                            profile_scope::read_record(&directory)? == original
                                && original_identity.as_ref().is_none_or(|identity| directory
                                    .portable_regular_identity(OsStr::new(profile_scope::RECORD))
                                    .is_ok_and(|current| current == *identity)),
                            "KNOWLEDGE_RELOCATION_CONFLICT"
                        );
                        Ok(())
                    },
                )
                .context("KNOWLEDGE_RELOCATION_UNCONFIRMED")?;
        }
        verify()?;
        ensure!(
            profile_scope::read_record(&directory)?.is_some_and(|(current, _)| current == record),
            "KNOWLEDGE_RELOCATION_UNCONFIRMED"
        );
        profile_scope::verify_record(&profile, &logical, &directory, &record)?;
        ensure!(
            personal_profile_scope(&target_path)?.principal == expected.principal,
            "KNOWLEDGE_RELOCATION_UNCONFIRMED"
        );
        Ok(())
    }
}

fn worker_credential_references(
    directory: &PrivateDirectory,
    original_profile: &Path,
    sources: &[ProfileAddress],
    references: &BTreeMap<PathBuf, PathBuf>,
    files_profile: &PrivateDirectory,
    hash_contents: bool,
) -> Result<(String, BTreeMap<PathBuf, PathBuf>)> {
    let models = match directory.open_child(OsStr::new("worker-models"), false) {
        Ok(directory) => directory,
        Err(error) if missing(&error) => return Ok((digest(b"{}"), BTreeMap::new())),
        Err(error) => return Err(error),
    };
    let mut files = BTreeMap::new();
    let mut credential_files = BTreeMap::new();
    models.visit_entry_names_bounded(65_536, |name| {
        let filename = name.to_str().context("KNOWLEDGE_WORKER_SNAPSHOT_INVALID")?;
        ensure!(
            filename
                .strip_suffix(".json")
                .is_some_and(profile_scope::sha),
            "KNOWLEDGE_WORKER_SNAPSHOT_INVALID"
        );
        let file = models.open_single_link_regular_file(name)?;
        let mut bytes = Vec::new();
        file.take(512 * 1024 + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 512 * 1024,
            "KNOWLEDGE_WORKER_SNAPSHOT_INVALID"
        );
        let snapshot: serde_json::Value = serde_json::from_slice(&bytes)?;
        if let Some(original) = snapshot
            .pointer("/credential/credential_file")
            .and_then(serde_json::Value::as_str)
            && let Some(relative) = references.get(Path::new(original)).cloned().or(
                profile_scope::relative_credential_path(
                    original_profile,
                    sources,
                    Path::new(original),
                )?,
            )
        {
            let file = profile_scope::open_profile_credential_file(files_profile, &relative)?;
            credential_files.insert(PathBuf::from(original), relative.clone());
            if !hash_contents {
                files.insert(relative, String::new());
                ensure!(files.len() <= 128, "KNOWLEDGE_WORKER_CREDENTIAL_LIMIT");
                return Ok(());
            }
            let mut bytes = Vec::new();
            file.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() <= 8 * 1024 * 1024,
                "KNOWLEDGE_WORKER_CREDENTIAL_TOO_LARGE"
            );
            files.insert(relative, digest(&bytes));
            ensure!(files.len() <= 128, "KNOWLEDGE_WORKER_CREDENTIAL_LIMIT");
        }
        Ok(())
    })?;
    Ok((digest(&serde_json::to_vec(&files)?), credential_files))
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests;
