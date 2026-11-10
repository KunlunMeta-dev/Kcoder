//! Native-selected project registry bindings. A source project path remains data throughout.
use super::{
    ProjectReadCancellation, ProjectReadLimits, ProjectRecord, parse_claude_registry,
    read_codex_registry,
};
use crate::{MigrationInventory, NormalizedItem};
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::migration::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Layout {
    ClaudeProjectRegistryJsonV1,
    CodexSqliteProjectsV1,
}
impl Layout {
    fn kind(self) -> MigrationSourceKind {
        match self {
            Self::ClaudeProjectRegistryJsonV1 => MigrationSourceKind::ClaudeCode,
            Self::CodexSqliteProjectsV1 => MigrationSourceKind::Codex,
        }
    }
    fn revision(self) -> &'static str {
        match self {
            Self::ClaudeProjectRegistryJsonV1 => "claude-project-registry/json/1",
            Self::CodexSqliteProjectsV1 => "codex-project-registry/sqlite/1",
        }
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    version: u32,
    directory: PathBuf,
    directory_identity: String,
    layout: Layout,
    identity_sha256: String,
    input_sha256: String,
    projection_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    selected_root: Option<crate::selected_source_root::SelectedRootBinding>,
}
#[derive(Clone)]
pub struct ProjectRegistryCapture {
    binding: Binding,
    records: Vec<ProjectRecord>,
}
fn hash(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn read(
    directory: &PrivateDirectory,
    layout: Layout,
    cancel: &ProjectReadCancellation,
) -> Result<(Vec<ProjectRecord>, String, String)> {
    match layout {
        Layout::CodexSqliteProjectsV1 => {
            let snapshot = read_codex_registry(
                directory,
                OsStr::new("state_5.sqlite"),
                cancel,
                ProjectReadLimits::default(),
            )?;
            Ok((
                snapshot.projects,
                snapshot.proof.source_identity_sha256,
                snapshot.proof.input_digest,
            ))
        }
        Layout::ClaudeProjectRegistryJsonV1 => {
            let started = Instant::now();
            let snapshot = directory.read_source_document_snapshot(
                OsStr::new(".claude.json"),
                8 * 1024 * 1024,
                || !cancel.is_cancelled() && started.elapsed() < Duration::from_secs(1),
            )?;
            let projects = parse_claude_registry(snapshot.bytes(), ProjectReadLimits::default())?;
            ensure!(
                projects.actual_sha256 == snapshot.sha256,
                "migration_project_source_changed"
            );
            Ok((projects.projects, snapshot.identity_sha256, snapshot.sha256))
        }
    }
}
impl ProjectRegistryCapture {
    /// The Native caller explicitly authorizes this product directory. No environment override
    /// or project path in the source can cause a second directory to be opened.
    pub fn capture_codex_product_directory(
        directory: &Path,
        cancel: &ProjectReadCancellation,
    ) -> Result<Self> {
        Self::capture(directory, Layout::CodexSqliteProjectsV1, cancel)
    }
    /// This is an explicitly authorized home-level registry directory. Selecting .claude alone
    /// does not implicitly authorize its parent or the sibling .claude.json file.
    pub fn capture_claude_registry_directory(
        directory: &Path,
        cancel: &ProjectReadCancellation,
    ) -> Result<Self> {
        Self::capture(directory, Layout::ClaudeProjectRegistryJsonV1, cancel)
    }
    fn capture(path: &Path, layout: Layout, cancel: &ProjectReadCancellation) -> Result<Self> {
        ensure!(path.is_absolute(), "migration_project_unsafe_source");
        let directory = PrivateDirectory::open_existing(path)?;
        directory.verify_trusted_config_directory()?;
        let directory_identity = directory.directory_identity()?;
        let path = path.canonicalize()?;
        ensure!(
            PrivateDirectory::open_existing(&path)?.directory_identity()? == directory_identity,
            "migration_project_source_changed"
        );
        let (records, identity_sha256, input_sha256) = read(&directory, layout, cancel)?;
        let binding = Binding {
            version: 1,
            directory: path,
            directory_identity,
            layout,
            identity_sha256,
            input_sha256,
            projection_sha256: hash(&records)?,
            selected_root: None,
        };
        Ok(Self { binding, records })
    }
    pub(crate) fn with_selected_root(
        mut self,
        root: Option<crate::selected_source_root::SelectedRootBinding>,
    ) -> Result<Self> {
        if let Some(root) = &root {
            root.verify(&self.binding.directory, self.source())?;
        }
        self.binding.selected_root = root;
        Ok(self)
    }
    pub fn format_revision(&self) -> &str {
        self.binding.layout.revision()
    }
    pub fn source(&self) -> MigrationSourceKind {
        self.binding.layout.kind()
    }
    pub fn records(&self) -> &[ProjectRecord] {
        &self.records
    }
    pub fn validate(&self, cancel: &ProjectReadCancellation) -> Result<()> {
        self.binding.verify(cancel).map(|_| ())
    }
    pub fn selected(
        &self,
        project_id: &str,
        cancel: &ProjectReadCancellation,
    ) -> Result<ProjectBatchSource> {
        self.validate(cancel)?;
        let record = self
            .records
            .iter()
            .find(|record| record.id == project_id)
            .ok_or_else(|| anyhow::anyhow!("migration_project_selection_unknown"))?
            .clone();
        ProjectBatchSource::new(self.binding.clone(), record)
    }
}
impl Binding {
    fn verify_selected(
        &self,
        record: &ProjectRecord,
        cancel: &ProjectReadCancellation,
    ) -> Result<()> {
        if let Some(root) = &self.selected_root {
            root.verify(&self.directory, self.layout.kind())?;
        }
        ensure!(
            self.version == 1,
            "migration_project_source_binding_unsupported"
        );
        let directory = PrivateDirectory::open_existing(&self.directory)?;
        ensure!(
            directory.directory_identity()? == self.directory_identity,
            "migration_project_source_changed"
        );
        if self.layout == Layout::CodexSqliteProjectsV1 {
            let snapshot = super::sqlite::read_codex_project(
                &directory,
                OsStr::new("state_5.sqlite"),
                &record.id,
                cancel,
                ProjectReadLimits::default(),
            )?;
            ensure!(
                snapshot.proof.source_identity_sha256 == self.identity_sha256
                    && snapshot.projects == [record.clone()],
                "migration_project_source_changed"
            );
        } else {
            let records = self.verify(cancel)?;
            ensure!(
                records.iter().any(|current| current == record),
                "migration_project_source_changed"
            );
        }
        Ok(())
    }
    fn verify(&self, cancel: &ProjectReadCancellation) -> Result<Vec<ProjectRecord>> {
        if let Some(root) = &self.selected_root {
            root.verify(&self.directory, self.layout.kind())?;
        }
        ensure!(
            self.version == 1,
            "migration_project_source_binding_unsupported"
        );
        let directory = PrivateDirectory::open_existing(&self.directory)?;
        directory.verify_trusted_config_directory()?;
        ensure!(
            directory.directory_identity()? == self.directory_identity,
            "migration_project_source_changed"
        );
        let (projects, identity, input_sha256) = read(&directory, self.layout, cancel)?;
        ensure!(
            identity == self.identity_sha256
                && input_sha256 == self.input_sha256
                && hash(&projects)? == self.projection_sha256,
            "migration_project_source_changed"
        );
        Ok(projects)
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
enum ProjectBinding {
    Physical(Box<Binding>),
    Received(Box<crate::source_transfer::ReceivedProjectInventoryBinding>),
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectBatchSource {
    binding: ProjectBinding,
    record: ProjectRecord,
    fingerprint: String,
}
impl std::fmt::Debug for ProjectBatchSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProjectBatchSource")
            .field("source", &self.source())
            .finish_non_exhaustive()
    }
}
impl ProjectBatchSource {
    pub(crate) fn received(
        binding: crate::source_transfer::ReceivedProjectInventoryBinding,
        record: ProjectRecord,
    ) -> Result<Self> {
        binding.validate(&record, &Default::default())?;
        let binding = ProjectBinding::Received(Box::new(binding));
        let fingerprint = hash(&(&binding, &record))?;
        Ok(Self {
            binding,
            record,
            fingerprint,
        })
    }
    pub fn verify_profile(&self, profile: &Path) -> Result<()> {
        match &self.binding {
            ProjectBinding::Physical(_) => Ok(()),
            ProjectBinding::Received(binding) => binding.verify_profile(profile),
        }
    }
    fn new(binding: Binding, record: ProjectRecord) -> Result<Self> {
        let fingerprint = hash(&(&binding, &record))?;
        Ok(Self {
            binding: ProjectBinding::Physical(Box::new(binding)),
            record,
            fingerprint,
        })
    }
    pub fn source(&self) -> MigrationSourceKind {
        match &self.binding {
            ProjectBinding::Physical(binding) => binding.layout.kind(),
            ProjectBinding::Received(binding) => binding.source(),
        }
    }
    pub fn record(&self) -> &ProjectRecord {
        &self.record
    }
    pub fn format_revision(&self) -> &str {
        match &self.binding {
            ProjectBinding::Physical(binding) => binding.layout.revision(),
            ProjectBinding::Received(binding) => binding.format_revision(),
        }
    }
    pub fn identity(&self) -> &str {
        &self.fingerprint
    }
    pub fn logical_identity(&self) -> String {
        let binding = match &self.binding {
            ProjectBinding::Physical(binding) => binding,
            ProjectBinding::Received(binding) => return binding.logical_identity(),
        };
        let mut digest = Sha256::new();
        digest.update(b"project-source/1");
        for value in [
            binding.layout.revision(),
            &binding.directory_identity,
            &self.record.id,
        ] {
            digest.update((value.len() as u64).to_le_bytes());
            digest.update(value.as_bytes());
        }
        format!("{:x}", digest.finalize())
    }
    pub fn source_root_id(&self, index: usize) -> Result<String> {
        ensure!(
            index < self.record.roots.len(),
            "migration_project_invalid_mapping"
        );
        Ok(format!(
            "root-{}",
            hash(&(&self.fingerprint, index, &self.record.roots[index]))?
        ))
    }
    pub fn validate(&self, cancel: &ProjectReadCancellation) -> Result<()> {
        ensure!(
            self.fingerprint == hash(&(&self.binding, &self.record))?,
            "migration_project_source_changed"
        );
        match &self.binding {
            ProjectBinding::Physical(binding) => binding.verify_selected(&self.record, cancel),
            ProjectBinding::Received(binding) => binding.validate(&self.record, cancel),
        }
    }
    pub fn inventory(&self) -> Result<MigrationInventory> {
        self.validate(&ProjectReadCancellation::default())?;
        Ok(MigrationInventory {
            source: self.source(),
            adapter_revision: "project-association/1".into(),
            issues: Vec::new(),
            items: vec![NormalizedItem {
                preview: MigrationItemPreview {
                    id: "selected-project".into(),
                    category: MigrationCategory::Project,
                    source_name: if self.record.name.is_empty() {
                        self.record.id.clone()
                    } else {
                        self.record.name.clone()
                    },
                    status: MigrationItemStatus::Discovered,
                    selected_by_default: true,
                    issues: Vec::new(),
                },
                provider: None,
                mcp: None,
                asset: None,
                template: None,
            }],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_rehashed_stored_selection_cannot_claim_rows_absent_from_its_original_registry() {
        let root = tempfile::tempdir().unwrap();
        let directory = PrivateDirectory::open_existing(root.path()).unwrap();
        directory
            .atomic_replace(
                OsStr::new(".claude.json"),
                br#"{"projects":{"/source-not-opened/original":{}}}"#,
            )
            .unwrap();
        let capture = ProjectRegistryCapture::capture_claude_registry_directory(
            root.path(),
            &ProjectReadCancellation::default(),
        )
        .unwrap();
        let mut source = capture
            .selected(
                &capture.records()[0].id,
                &ProjectReadCancellation::default(),
            )
            .unwrap();
        source.record.name = "Detached name".into();
        source.fingerprint = hash(&(&source.binding, &source.record)).unwrap();
        assert!(
            source
                .validate(&ProjectReadCancellation::default())
                .is_err()
        );
    }
}

#[cfg(test)]
mod transport_compatibility_tests {
    use super::*;
    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct LegacyPhysicalSource {
        binding: Binding,
        record: ProjectRecord,
        fingerprint: String,
    }
    #[test]
    fn old_physical_sources_keep_identical_bytes_and_hashes_without_a_new_discriminator() {
        let root = tempfile::tempdir().unwrap();
        let dir = PrivateDirectory::open_existing(root.path()).unwrap();
        dir.atomic_replace(
            OsStr::new(".claude.json"),
            b"{\"projects\":{\"/foreign/not-opened\":{}}}",
        )
        .unwrap();
        let capture = ProjectRegistryCapture::capture_claude_registry_directory(
            root.path(),
            &Default::default(),
        )
        .unwrap();
        let source = capture
            .selected(&capture.records()[0].id, &Default::default())
            .unwrap();
        let bytes = serde_json::to_vec(&source).unwrap();
        let old: LegacyPhysicalSource = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(old.fingerprint, hash(&(&old.binding, &old.record)).unwrap());
        assert_eq!(serde_json::to_vec(&old).unwrap(), bytes);
        let restored: ProjectBatchSource =
            serde_json::from_slice(&serde_json::to_vec(&old).unwrap()).unwrap();
        restored.validate(&Default::default()).unwrap();
    }
    #[test]
    fn an_original_host_cancellation_probe_stays_live_after_cloning() {
        let original = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let read = original.clone();
        let cancel = ProjectReadCancellation::with_probe(move || {
            read.load(std::sync::atomic::Ordering::Acquire)
        });
        let cloned = cancel.clone();
        assert!(!cancel.is_cancelled());
        original.store(true, std::sync::atomic::Ordering::Release);
        assert!(cloned.is_cancelled());
        let root = tempfile::tempdir().unwrap();
        let dir = PrivateDirectory::open_existing(root.path()).unwrap();
        dir.atomic_replace(
            OsStr::new(".claude.json"),
            b"{\"projects\":{\"/never-opened\":{}}}",
        )
        .unwrap();
        assert!(
            ProjectRegistryCapture::capture_claude_registry_directory(root.path(), &cloned)
                .is_err()
        );
    }
}
