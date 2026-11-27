//! Durable ownership for explicitly selected, compatible local plugin packages.
use super::discovery::{PluginMigrationCandidate, Source};
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use kcoder_config::{PrivateDirectory, ProfileSettingsFile};
use kcoder_plugins::{
    InstallLimits, PluginCancellationToken, PluginId, PluginStore,
    migration::{self, PluginMigrationNativeState as Native, PluginPackageRevision},
};
use kcoder_types::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
mod capture;
mod control;
mod received;
mod reference;
pub use reference::{
    PLUGIN_ADAPTER_REVISION, PluginBatchConsumer, PluginBatchSource, PluginPlanReference,
};
const DIRECTORY: &str = "plugin-migrations-v1";
const MAX_JOBS: usize = 4096;
const MAX_META: u64 = 64 * 1024;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginMigrationStage {
    Prepared,
    Capturing,
    Pending,
    Ready,
    Applying,
    Imported,
    Undoing,
    Undone,
    Cancelled,
    OutcomeUnknown,
}
/// Public Native projection. Source paths, raw manifests and source settings stay private.
pub struct PluginMigrationView {
    pub operation_id: String,
    pub sequence: u64,
    pub stage: PluginMigrationStage,
    pub source: MigrationSourceKind,
    pub name: String,
    pub installed_version: Option<String>,
    pub scope: String,
    pub source_enabled: Option<bool>,
    pub target_id: Option<String>,
    pub capabilities: Vec<String>,
    pub readiness: Vec<String>,
    pub pending: Vec<String>,
    pub imported: bool,
    pub cancel_requested: bool,
    pub cancel_revision: u64,
    pub package_files: Option<u32>,
    pub package_bytes: Option<u64>,
    pub batch_job_id: Option<String>,
    pub failure_code: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    version: u8,
    owner: String,
    profile: String,
    operation_id: String,
    sequence: u64,
    stage: PluginMigrationStage,
    candidate: String,
    source: MigrationSourceKind,
    name: String,
    installed_version: Option<String>,
    scope: String,
    source_enabled: Option<bool>,
    binding: Option<Source>,
    target: Option<String>,
    package: Option<PluginPackageRevision>,
    package_owner: Option<String>,
    capabilities: Vec<String>,
    pending: Vec<String>,
    readiness: Vec<String>,
    imported: bool,
    #[serde(default)]
    writer_identity: Option<kcoder_config::PortableLeaseIdentity>,
    #[serde(default)]
    control_identity: Option<kcoder_config::PortableLeaseIdentity>,
    #[serde(default)]
    package_relative: Option<String>,
    #[serde(default)]
    intended: Option<PluginPackageRevision>,
    #[serde(default)]
    attempts: u8,
    #[serde(default)]
    reservation: u64,
    #[serde(default)]
    claim: Option<PluginPlanReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target_project: Option<Box<kcoder_plugins::PluginProjectBinding>>,
    #[serde(default)]
    failure_code: Option<String>,
}
pub struct PluginMigrationStore {
    root: PathBuf,
    directory: PrivateDirectory,
    owner: String,
    profile: String,
}
fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
    })
}
fn operation(value: &str) -> Result<uuid::Uuid> {
    let id = uuid::Uuid::parse_str(value)
        .map_err(|_| anyhow::anyhow!("plugin_migration_invalid_operation"))?;
    ensure!(
        id.to_string() == value,
        "plugin_migration_invalid_operation"
    );
    Ok(id)
}
fn hash(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn cancelled(cancel: &PluginCancellationToken) -> Result<()> {
    ensure!(!cancel.is_cancelled(), "plugin_migration_cancelled");
    Ok(())
}
fn increment(job: &mut Job) -> Result<()> {
    job.sequence = job
        .sequence
        .checked_add(1)
        .context("plugin_migration_sequence_exhausted")?;
    Ok(())
}
fn read_job(dir: &PrivateDirectory) -> Result<Job> {
    let file = dir.open_regular_file_snapshot(OsStr::new("job.json"))?;
    ensure!(
        file.metadata()?.len() <= MAX_META,
        "plugin_migration_metadata_budget_exceeded"
    );
    let mut bytes = Vec::new();
    file.take(MAX_META + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_META,
        "plugin_migration_metadata_budget_exceeded"
    );
    serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("plugin_migration_invalid_job"))
}
fn save(dir: &PrivateDirectory, job: &Job) -> Result<()> {
    let bytes = serde_json::to_vec(job)?;
    ensure!(
        bytes.len() as u64 <= MAX_META,
        "plugin_migration_metadata_budget_exceeded"
    );
    dir.atomic_replace(OsStr::new("job.json"), &bytes)
}
fn view(job: Job) -> PluginMigrationView {
    PluginMigrationView {
        operation_id: job.operation_id,
        sequence: job.sequence,
        stage: job.stage,
        source: job.source,
        name: job.name,
        installed_version: job.installed_version,
        scope: job.scope,
        source_enabled: job.source_enabled,
        target_id: job.target,
        capabilities: job.capabilities,
        readiness: job.readiness,
        pending: job.pending,
        imported: job.imported,
        failure_code: job.failure_code,
        batch_job_id: job
            .claim
            .as_ref()
            .map(|reference| reference.batch_job_id().to_string())
            .or_else(|| {
                job.binding
                    .as_ref()
                    .and_then(|binding| binding.received.as_ref())
                    .map(|received| received.preview_job_id().to_owned())
            }),
        cancel_requested: false,
        cancel_revision: 0,
        package_files: job
            .package
            .as_ref()
            .and_then(|package| u32::try_from(package.files).ok()),
        package_bytes: job.package.as_ref().map(|package| package.bytes),
    }
}
impl PluginMigrationStore {
    pub fn open(profile: &Path) -> Result<Self> {
        Self::open_inner(profile, true)?.context("plugin_migration_store_missing")
    }
    pub fn open_existing(profile: &Path) -> Result<Option<Self>> {
        Self::open_inner(profile, false)
    }
    fn open_inner(profile: &Path, create: bool) -> Result<Option<Self>> {
        let base = PrivateDirectory::open_existing(profile)?;
        base.verify_private_directory()?;
        let owner = base.directory_identity()?;
        let directory = match base.open_child(OsStr::new(DIRECTORY), create) {
            Ok(dir) => dir,
            Err(error) if !create && missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        let profile = profile.canonicalize()?;
        ensure!(
            PrivateDirectory::open_existing(&profile)?.directory_identity()? == owner,
            "plugin_migration_profile_changed"
        );
        Ok(Some(Self {
            root: profile,
            owner: directory.directory_identity()?,
            profile: owner,
            directory,
        }))
    }
    fn verify(&self) -> Result<()> {
        ensure!(
            PrivateDirectory::open_existing(&self.root)?.directory_identity()? == self.profile
                && PrivateDirectory::open_existing(&self.root.join(DIRECTORY))?
                    .directory_identity()?
                    == self.owner,
            "plugin_migration_profile_changed"
        );
        Ok(())
    }
    fn load(&self, id: &str) -> Result<(PrivateDirectory, Job)> {
        operation(id)?;
        self.verify()?;
        let dir = self.directory.open_child(OsStr::new(id), false)?;
        dir.verify_private_directory()?;
        let job = read_job(&dir)?;
        ensure!(
            job.version == 1
                && job.operation_id == id
                && job.profile == self.profile
                && job.owner == dir.directory_identity()?,
            "plugin_migration_owner_changed"
        );
        Ok((dir, job))
    }
    fn lock(dir: &PrivateDirectory) -> Result<File> {
        let file = dir.open_single_link_regular_file(OsStr::new("writer.lock"))?;
        FileExt::try_lock_exclusive(&file).map_err(|_| anyhow::anyhow!("plugin_migration_busy"))?;
        Ok(file)
    }
    fn observe(&self, job: &mut Job, cancel: &PluginCancellationToken) -> Result<()> {
        let (Some(target), Some(revision)) = (&job.target, &job.package) else {
            return Ok(());
        };
        let target = target.parse::<PluginId>()?;
        let native = migration::observe_installation_receipt(
            &self.root.join("plugin_store"),
            &target,
            &operation(&job.operation_id)?.simple().to_string(),
            &revision.sha256,
            cancel,
        )?;
        match native {
            Some(Native::Installed) => {
                job.imported = true;
                job.stage = PluginMigrationStage::Imported;
            }
            Some(Native::Retired) => {
                job.imported = true;
                job.stage = PluginMigrationStage::Undone;
            }
            Some(Native::Retiring) => {
                job.imported = true;
                job.stage = PluginMigrationStage::OutcomeUnknown;
            }
            Some(Native::Changed | Native::Missing)
                if !job.pending.iter().any(|s| s == "plugin_target_changed") =>
            {
                job.pending.push("plugin_target_changed".into())
            }
            _ => {}
        }
        Ok(())
    }
    pub fn read(&self, id: &str, cancel: &PluginCancellationToken) -> Result<PluginMigrationView> {
        let (dir, mut job) = self.load(id)?;
        if let Err(error) = self.observe(&mut job, cancel) {
            // An active owner is still settling its publication; do not infer a terminal outcome.
            if error.to_string() != "plugin_migration_busy" || !self.running(id)? {
                return Err(error);
            }
        }
        self.project(&dir, job)
    }
    fn configuration<T>(
        &self,
        job: &Job,
        check: impl FnOnce(&kcoder_config::PluginsSettings) -> Result<T>,
    ) -> Result<T> {
        self.verify_target_project(job)?;
        let settings = ProfileSettingsFile::new(PrivateDirectory::open_existing(&self.root)?)?;
        settings.inspect_locked(|settings| {
            let id = job
                .target
                .as_ref()
                .context("plugin_migration_plan_not_ready")?;
            let plugins: kcoder_config::PluginsSettings = settings
                .get("plugins")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|_| anyhow::anyhow!("plugin_migration_invalid_target_policy"))?
                .unwrap_or_default();
            ensure!(
                !plugins.installed.contains_key(id),
                "plugin_migration_user_policy_changed"
            );
            ensure!(
                plugins.installation.allow_local,
                "plugin_migration_local_install_disabled"
            );
            ensure!(
                if job.source == MigrationSourceKind::ClaudeCode {
                    plugins.compatibility.claude
                } else {
                    plugins.compatibility.codex
                },
                "plugin_migration_format_disabled"
            );
            check(&plugins)
        })
    }
    /// Read-only facts remain available in another view, but a workspace-bound operation
    /// may mutate only through its original actual workspace authority.
    pub fn verify_workspace(&self, id: &str, workspace: Option<&Path>) -> Result<()> {
        let (_, job) = self.load(id)?;
        if let Some(project) = &job.target_project {
            project.verify_for_profile(&self.root)?;
            let workspace = workspace.context("plugin_project_mapping_required")?;
            let actual = kcoder_plugins::PluginProjectBinding::capture(&self.root, workspace)?;
            ensure!(actual == **project, "plugin_project_workspace_mismatch");
        }
        Ok(())
    }
    fn scope_ready(&self, job: &Job) -> bool {
        job.scope == "user"
            || (matches!(job.scope.as_str(), "project" | "local")
                && job.target_project.is_some()
                && job
                    .binding
                    .as_ref()
                    .is_some_and(|source| source.project.is_some() || source.received.is_some()))
    }
    fn verify_target_project(&self, job: &Job) -> Result<()> {
        if let Some(received) = job
            .binding
            .as_ref()
            .and_then(|source| source.received.as_ref())
        {
            received.verify_mapping(&self.root, job.target_project.as_deref())?;
        }
        if let Some(project) = &job.target_project {
            project.verify_for_profile(&self.root)?;
        }
        ensure!(
            self.scope_ready(job),
            "plugin_migration_pending_resolution_required"
        );
        Ok(())
    }
    fn native_store(&self, settings: &kcoder_config::PluginsSettings) -> Result<PluginStore> {
        let limits = InstallLimits::default();
        let configured = &settings.installation;
        Ok(
            PluginStore::open_for_migration(&self.root.join("plugin_store"))?
                .with_limits(InstallLimits {
                    max_files: configured.max_files.min(limits.max_files),
                    max_total_bytes: configured.max_total_bytes.min(limits.max_total_bytes),
                    max_file_bytes: configured.max_file_bytes.min(limits.max_file_bytes),
                    ..limits
                })
                .with_operation_timeout(std::time::Duration::from_millis(
                    configured.timeout_ms.min(120_000),
                )),
        )
    }
    fn package(&self, job: &Job) -> Result<PathBuf> {
        ensure!(
            job.package_relative
                .as_deref()
                .is_none_or(|name| matches!(name, "package-1" | "package-2")),
            "plugin_migration_package_changed"
        );
        let path = self
            .root
            .join(DIRECTORY)
            .join(&job.operation_id)
            .join(job.package_relative.as_deref().unwrap_or("package"));
        let dir = PrivateDirectory::open_existing(&path)?;
        ensure!(
            Some(dir.directory_identity()?).as_ref() == job.package_owner.as_ref(),
            "plugin_migration_package_changed"
        );
        Ok(path)
    }
    pub fn apply(
        &self,
        id: &str,
        sequence: u64,
        cancel: &PluginCancellationToken,
    ) -> Result<PluginMigrationView> {
        self.apply_owned(id, sequence, None, cancel)
    }
    fn apply_owned(
        &self,
        id: &str,
        sequence: u64,
        consumer: Option<&PluginBatchConsumer>,
        cancel: &PluginCancellationToken,
    ) -> Result<PluginMigrationView> {
        let (dir, mut job) = self.load(id)?;
        let _writer = Self::locked(&dir, &job)?;
        self.authorize_consumer(&job, consumer)?;
        ensure!(job.sequence == sequence, "plugin_migration_stale_sequence");
        self.observe(&mut job, cancel)?;
        if matches!(
            job.stage,
            PluginMigrationStage::Imported | PluginMigrationStage::Undone
        ) {
            save(&dir, &job)?;
            return self.project(&dir, job);
        }
        ensure!(
            matches!(
                job.stage,
                PluginMigrationStage::Ready
                    | PluginMigrationStage::Applying
                    | PluginMigrationStage::OutcomeUnknown
            ) && job.pending.is_empty(),
            "plugin_migration_plan_not_ready"
        );
        let owned = self.controlled(&job, cancel)?;
        let cancel = &owned;
        cancelled(cancel)?;
        increment(&mut job)?;
        job.stage = PluginMigrationStage::Applying;
        job.failure_code = None;
        save(&dir, &job)?;
        let result = (|| -> Result<kcoder_plugins::InstalledPluginRecord> {
            let source = job
                .binding
                .as_ref()
                .context("plugin_migration_source_missing")?
                .verify()?;
            let revision = job
                .package
                .as_ref()
                .context("plugin_migration_plan_not_ready")?
                .clone();
            let package = self.package(&job)?;
            let original = job
                .binding
                .as_ref()
                .context("plugin_migration_source_missing")?;
            ensure!(
                (original.received.is_some()
                    || migration::package_revision(&source, InstallLimits::default(), cancel)?
                        == revision)
                    && migration::package_revision(&package, InstallLimits::default(), cancel)?
                        == revision,
                "plugin_migration_source_changed"
            );
            self.configuration(&job, |settings| {
                let native = self.native_store(settings)?;
                let target = job.target.as_ref().unwrap().parse()?;
                let operation = operation(id)?.simple().to_string();
                if let Some(project) = &job.target_project {
                    native.install_migration_snapshot_for_project(
                        &package,
                        target,
                        &operation,
                        &revision.sha256,
                        project,
                        cancel,
                    )
                } else {
                    native.install_migration_snapshot(
                        &package,
                        target,
                        &operation,
                        &revision.sha256,
                        cancel,
                    )
                }
            })
        })();
        match result {
            Ok(_) => {
                job.imported = true;
                job.stage = PluginMigrationStage::Imported;
                save(&dir, &job)?;
                self.project(&dir, job)
            }
            Err(error) => {
                job.stage = PluginMigrationStage::OutcomeUnknown;
                job.failure_code = Some(super::errors::error_code(&error).into());
                save(&dir, &job)?;
                Err(error)
            }
        }
    }
    pub fn undo(
        &self,
        id: &str,
        sequence: u64,
        cancel: &PluginCancellationToken,
    ) -> Result<PluginMigrationView> {
        self.undo_owned(id, sequence, None, cancel)
    }
    fn undo_owned(
        &self,
        id: &str,
        sequence: u64,
        consumer: Option<&PluginBatchConsumer>,
        cancel: &PluginCancellationToken,
    ) -> Result<PluginMigrationView> {
        let (dir, mut job) = self.load(id)?;
        let _writer = Self::locked(&dir, &job)?;
        self.authorize_consumer(&job, consumer)?;
        ensure!(job.sequence == sequence, "plugin_migration_stale_sequence");
        self.observe(&mut job, cancel)?;
        if job.stage == PluginMigrationStage::Undone {
            save(&dir, &job)?;
            return self.project(&dir, job);
        }
        ensure!(
            job.imported && job.pending.is_empty(),
            "plugin_migration_undo_not_owned"
        );
        let owned = self.controlled(&job, cancel)?;
        let cancel = &owned;
        cancelled(cancel)?;
        increment(&mut job)?;
        job.stage = PluginMigrationStage::Undoing;
        job.failure_code = None;
        save(&dir, &job)?;
        let result = self.configuration(&job, |settings| {
            self.native_store(settings)?.uninstall_migration_owned(
                &job.target
                    .as_ref()
                    .context("plugin_migration_plan_not_ready")?
                    .parse()?,
                &operation(id)?.simple().to_string(),
                &job.package
                    .as_ref()
                    .context("plugin_migration_plan_not_ready")?
                    .sha256,
                cancel,
            )
        });
        match result {
            Ok(_) => {
                job.stage = PluginMigrationStage::Undone;
                save(&dir, &job)?;
                self.project(&dir, job)
            }
            Err(error) => {
                job.stage = PluginMigrationStage::OutcomeUnknown;
                job.failure_code = Some(super::errors::error_code(&error).into());
                save(&dir, &job)?;
                Err(error)
            }
        }
    }
}
