//! Private parent claims are durable authority; a second batch does not inherit undo ownership.
use super::*;
use crate::{MigrationInventory, NormalizedItem};
use kcoder_types::migration::*;
pub const PLUGIN_ADAPTER_REVISION: &str = "local-plugin/1";
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginBatchConsumer {
    profile: String,
    migrations: String,
    batch_job_id: String,
    action_id: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginPlanReference {
    operation_id: String,
    profile: String,
    job_owner: String,
    package_owner: String,
    package: PluginPackageRevision,
    target_id: String,
    planned_sequence: u64,
    adapter: String,
    consumer: PluginBatchConsumer,
}
impl std::fmt::Debug for PluginPlanReference {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginPlanReference")
            .field("operation_id", &self.operation_id)
            .finish_non_exhaustive()
    }
}
impl PluginPlanReference {
    pub(crate) fn belongs_to(&self, job_id: &str, action_id: &str) -> bool {
        self.consumer.batch_job_id == job_id && self.consumer.action_id == action_id
    }
    pub(crate) fn receipt_fingerprint(&self) -> Result<String> {
        hash(&("plugin-batch-receipt/1", self))
    }
    pub(super) fn batch_job_id(&self) -> &str {
        &self.consumer.batch_job_id
    }
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }
    pub fn sequence(&self) -> u64 {
        self.planned_sequence
    }
    pub fn target_id(&self) -> &str {
        &self.target_id
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginBatchSource {
    profile_root: PathBuf,
    profile: String,
    operation_id: String,
    job_owner: String,
    package_owner: String,
    package: PluginPackageRevision,
    initial_sequence: u64,
    source: MigrationSourceKind,
    name: String,
    scope: String,
    target: String,
    adapter: String,
    logical: String,
}
impl std::fmt::Debug for PluginBatchSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginBatchSource")
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}
fn consumer_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}
impl PluginBatchConsumer {
    fn validate(&self, store: &PluginMigrationStore) -> Result<()> {
        ensure!(
            self.profile == store.profile,
            "plugin_migration_consumer_changed"
        );
        let dir = PrivateDirectory::open_existing(&store.root)?
            .open_child(OsStr::new("migrations"), false)?;
        dir.verify_private_directory()?;
        ensure!(
            dir.directory_identity()? == self.migrations
                && self
                    .batch_job_id
                    .strip_prefix("mig-")
                    .is_some_and(|id| id.len() == 32 && uuid::Uuid::parse_str(id).is_ok())
                && consumer_id(&self.action_id),
            "plugin_migration_consumer_changed"
        );
        let file =
            dir.open_regular_file_snapshot(OsStr::new(&format!("{}.json", self.batch_job_id)))?;
        ensure!(
            file.metadata()?.len() <= 16 * 1024 * 1024,
            "plugin_migration_invalid_consumer"
        );
        // Stream a narrow header while the parent may hold its existing journal lock.
        // Unknown native journal fields are deliberately skipped, not reinterpreted as source data.
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Parent {
            schema_version: u32,
            job_id: String,
            batch: Option<Batch>,
        }
        #[derive(Deserialize)]
        struct Batch {}
        let parent: Parent = serde_json::from_reader(file.take(16 * 1024 * 1024 + 1))
            .map_err(|_| anyhow::anyhow!("plugin_migration_invalid_consumer"))?;
        ensure!(
            parent.schema_version == 1
                && parent.job_id == self.batch_job_id
                && parent.batch.is_some(),
            "plugin_migration_invalid_consumer"
        );
        Ok(())
    }
}
impl PluginBatchSource {
    pub(crate) fn logical_identity(&self) -> &str {
        &self.logical
    }
    pub(crate) fn target_id(&self, target_name: &str) -> Result<String> {
        let current = self.target.parse::<PluginId>()?;
        Ok(format!("{target_name}@{}", current.marketplace_name())
            .parse::<PluginId>()?
            .to_string())
    }
    pub(crate) fn semantic_fingerprint(&self, target_name: &str) -> Result<String> {
        hash(&(
            "plugin-reuse/1",
            &self.package,
            self.target_id(target_name)?,
            &self.adapter,
        ))
    }
    pub(crate) fn verify_batch_parent(&self, parent: &PrivateDirectory) -> Result<()> {
        let profile = PrivateDirectory::open_existing(&self.profile_root)?;
        ensure!(
            profile.directory_identity()? == self.profile,
            "plugin_migration_profile_changed"
        );
        let expected = profile.open_child(OsStr::new("migrations"), false)?;
        parent.verify_private_directory()?;
        ensure!(
            expected.directory_identity()? == parent.directory_identity()?,
            "plugin_migration_consumer_changed"
        );
        self.validate()
    }
    pub(crate) fn open_batch_store(
        &self,
        parent: &PrivateDirectory,
    ) -> Result<PluginMigrationStore> {
        self.verify_batch_parent(parent)?;
        PluginMigrationStore::open_existing(&self.profile_root)?
            .context("plugin_migration_store_missing")
    }
    pub fn source(&self) -> MigrationSourceKind {
        self.source
    }
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }
    pub fn proposed_name(&self) -> Result<String> {
        Ok(self.target.parse::<PluginId>()?.plugin_name().to_string())
    }
    pub fn bytes(&self) -> u64 {
        self.package.bytes
    }
    pub fn files(&self) -> usize {
        self.package.files
    }
    pub fn identity(&self) -> Result<String> {
        hash(&(
            PLUGIN_ADAPTER_REVISION,
            &self.profile,
            &self.operation_id,
            &self.job_owner,
            &self.package_owner,
            &self.package,
        ))
    }
    pub fn validate_profile(&self, profile: &Path) -> Result<()> {
        let profile = PrivateDirectory::open_existing(profile)?;
        ensure!(
            profile.directory_identity()? == self.profile,
            "plugin_migration_profile_changed"
        );
        self.validate()
    }
    pub fn validate(&self) -> Result<()> {
        let store = PluginMigrationStore::open_existing(&self.profile_root)?
            .context("plugin_migration_store_missing")?;
        let (_, job) = store.load(&self.operation_id)?;
        self.matches(&store, &job)
    }
    fn matches(&self, store: &PluginMigrationStore, job: &Job) -> Result<()> {
        ensure!(
            self.adapter == PLUGIN_ADAPTER_REVISION
                && self.profile == store.profile
                && self.job_owner == job.owner
                && self.scope == job.scope
                && store.scope_ready(job)
                && job.package.as_ref() == Some(&self.package)
                && job.package_owner.as_ref() == Some(&self.package_owner)
                && self.logical == logical_identity(job)?,
            "plugin_migration_source_changed"
        );
        store.package(job)?;
        Ok(())
    }
    pub fn inventory(&self) -> Result<MigrationInventory> {
        let store = PluginMigrationStore::open_existing(&self.profile_root)?
            .context("plugin_migration_store_missing")?;
        let (_, job) = store.load(&self.operation_id)?;
        self.matches(&store, &job)?;
        let issues = if job.readiness.is_empty() {
            vec![]
        } else {
            vec![MigrationIssue {
                code: MigrationIssueCode::MissingDependency,
                severity: MigrationIssueSeverity::Blocking,
                phase: MigrationIssuePhase::Activation,
                field: Some("plugin_runtime".into()),
            }]
        };
        Ok(MigrationInventory {
            source: self.source,
            adapter_revision: PLUGIN_ADAPTER_REVISION.into(),
            issues: vec![],
            items: vec![NormalizedItem {
                preview: MigrationItemPreview {
                    id: "selected-plugin".into(),
                    category: MigrationCategory::Plugin,
                    source_name: self.name.clone(),
                    status: MigrationItemStatus::Discovered,
                    selected_by_default: true,
                    issues,
                },
                provider: None,
                mcp: None,
                asset: None,
                template: None,
            }],
        })
    }
}
impl PluginMigrationStore {
    pub fn batch_source(&self, id: &str, sequence: u64) -> Result<PluginBatchSource> {
        self.batch_source_owned(id, sequence, None)
    }
    pub(crate) fn batch_source_for_received(
        &self,
        id: &str,
        sequence: u64,
        preview: &str,
    ) -> Result<PluginBatchSource> {
        self.batch_source_owned(id, sequence, Some(preview))
    }
    fn batch_source_owned(
        &self,
        id: &str,
        sequence: u64,
        preview: Option<&str>,
    ) -> Result<PluginBatchSource> {
        let (_, job) = self.load(id)?;
        self.authorize_received_capture(&job, preview)?;
        ensure!(
            job.sequence == sequence
                && job.stage == PluginMigrationStage::Ready
                && !job.imported
                && job.pending.is_empty()
                && self.scope_ready(&job),
            "plugin_migration_plan_not_ready"
        );
        self.package(&job)?;
        let logical = logical_identity(&job)?;
        Ok(PluginBatchSource {
            profile_root: self.root.clone(),
            profile: self.profile.clone(),
            operation_id: id.into(),
            job_owner: job.owner,
            package_owner: job
                .package_owner
                .context("plugin_migration_plan_not_ready")?,
            package: job.package.context("plugin_migration_plan_not_ready")?,
            initial_sequence: sequence,
            source: job.source,
            name: job.name,
            scope: job.scope,
            target: job.target.context("plugin_migration_plan_not_ready")?,
            adapter: PLUGIN_ADAPTER_REVISION.into(),
            logical,
        })
    }
    /// The host passes only its internally generated parent job/action identity, never RPC fields.
    pub fn batch_consumer(
        &self,
        batch_job_id: &str,
        action_id: &str,
    ) -> Result<PluginBatchConsumer> {
        ensure!(
            batch_job_id
                .strip_prefix("mig-")
                .is_some_and(|id| id.len() == 32 && uuid::Uuid::parse_str(id).is_ok())
                && consumer_id(action_id),
            "plugin_migration_invalid_consumer"
        );
        let dir = PrivateDirectory::open_existing(&self.root)?
            .open_child(OsStr::new("migrations"), false)?;
        dir.verify_private_directory()?;
        let consumer = PluginBatchConsumer {
            profile: self.profile.clone(),
            migrations: dir.directory_identity()?,
            batch_job_id: batch_job_id.into(),
            action_id: action_id.into(),
        };
        consumer.validate(self)?;
        Ok(consumer)
    }
    pub fn pin_for_batch(
        &self,
        source: &PluginBatchSource,
        consumer: &PluginBatchConsumer,
        target_name: &str,
    ) -> Result<PluginPlanReference> {
        consumer.validate(self)?;
        let (dir, mut job) = self.load(&source.operation_id)?;
        let _writer = Self::locked(&dir, &job)?;
        if let Some(received) = job
            .binding
            .as_ref()
            .and_then(|binding| binding.received.as_ref())
        {
            ensure!(
                received.preview_job_id() == consumer.batch_job_id,
                "plugin_migration_claimed_by_another_owner"
            );
        }
        source.matches(self, &job)?;
        ensure!(
            !control::read_control(&dir, &job)?.requested,
            "plugin_migration_cancelled"
        );
        let current = job
            .target
            .as_ref()
            .context("plugin_migration_plan_not_ready")?
            .parse::<PluginId>()?;
        let target = format!("{target_name}@{}", current.marketplace_name())
            .parse::<PluginId>()?
            .to_string();
        if let Some(reference) = &job.claim {
            ensure!(
                reference.consumer == *consumer && reference.target_id == target,
                "plugin_migration_claimed_by_another_owner"
            );
            self.validate_reference(&job, reference)?;
            return Ok(reference.clone());
        }
        ensure!(
            job.sequence == source.initial_sequence
                && job.stage == PluginMigrationStage::Ready
                && !job.imported
                && job.pending.is_empty(),
            "plugin_migration_plan_not_ready"
        );
        increment(&mut job)?;
        job.target = Some(target.clone());
        let reference = PluginPlanReference {
            operation_id: job.operation_id.clone(),
            profile: self.profile.clone(),
            job_owner: job.owner.clone(),
            package_owner: source.package_owner.clone(),
            package: source.package.clone(),
            target_id: target,
            planned_sequence: job.sequence,
            adapter: PLUGIN_ADAPTER_REVISION.into(),
            consumer: consumer.clone(),
        };
        job.claim = Some(reference.clone());
        save(&dir, &job)?;
        Ok(reference)
    }
    fn validate_reference(&self, job: &Job, reference: &PluginPlanReference) -> Result<()> {
        reference.consumer.validate(self)?;
        ensure!(
            reference.profile == self.profile
                && reference.operation_id == job.operation_id
                && reference.job_owner == job.owner
                && reference.adapter == PLUGIN_ADAPTER_REVISION
                && job.package.as_ref() == Some(&reference.package)
                && job.package_owner.as_ref() == Some(&reference.package_owner)
                && job.target.as_ref() == Some(&reference.target_id)
                && job.claim.as_ref() == Some(reference)
                && job.sequence >= reference.planned_sequence,
            "plugin_migration_reference_changed"
        );
        self.package(job)?;
        Ok(())
    }
    pub(super) fn authorize_consumer(
        &self,
        job: &Job,
        consumer: Option<&PluginBatchConsumer>,
    ) -> Result<()> {
        match (&job.claim, consumer) {
            (None, None)
                if job
                    .binding
                    .as_ref()
                    .is_some_and(|binding| binding.received.is_some()) =>
            {
                anyhow::bail!("plugin_migration_claimed_by_another_owner")
            }
            (None, None) => Ok(()),
            (Some(reference), Some(expected)) if reference.consumer == *expected => {
                self.validate_reference(job, reference)
            }
            _ => Err(anyhow::anyhow!("plugin_migration_claimed_by_another_owner")),
        }
    }
    pub fn read_reference(&self, reference: &PluginPlanReference) -> Result<PluginMigrationView> {
        let (_, job) = self.load(&reference.operation_id)?;
        self.validate_reference(&job, reference)?;
        self.read(&reference.operation_id, &PluginCancellationToken::default())
    }
    pub(crate) fn observe_reference_for_batch(
        &self,
        reference: &PluginPlanReference,
    ) -> Result<Option<bool>> {
        let (_, job) = self.load(&reference.operation_id)?;
        self.validate_reference(&job, reference)?;
        let state = migration::observe_installation(
            &self.root.join("plugin_store"),
            &reference.target_id.parse::<PluginId>()?,
            &operation(&reference.operation_id)?.simple().to_string(),
            &reference.package.sha256,
            &PluginCancellationToken::default(),
        )?;
        if state != Some(Native::Installed) {
            return Ok(None);
        }
        ProfileSettingsFile::new(PrivateDirectory::open_existing(&self.root)?)?.inspect_locked(
            |document| {
                let settings: kcoder_config::PluginsSettings = document
                    .get("plugins")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|_| anyhow::anyhow!("plugin_migration_invalid_target_policy"))?
                    .unwrap_or_default();
                Ok(Some(
                    settings
                        .installed
                        .get(&reference.target_id)
                        .and_then(|policy| policy.enabled)
                        .unwrap_or(false),
                ))
            },
        )
    }
    pub fn apply_reference(
        &self,
        reference: &PluginPlanReference,
        cancel: &PluginCancellationToken,
    ) -> Result<PluginMigrationView> {
        let (_, job) = self.load(&reference.operation_id)?;
        self.validate_reference(&job, reference)?;
        self.apply_owned(
            &reference.operation_id,
            job.sequence,
            Some(&reference.consumer),
            cancel,
        )
    }
    pub fn undo_reference(
        &self,
        reference: &PluginPlanReference,
        cancel: &PluginCancellationToken,
    ) -> Result<PluginMigrationView> {
        let (_, job) = self.load(&reference.operation_id)?;
        self.validate_reference(&job, reference)?;
        self.undo_owned(
            &reference.operation_id,
            job.sequence,
            Some(&reference.consumer),
            cancel,
        )
    }
}

fn logical_identity(job: &Job) -> Result<String> {
    if let Some(received) = job
        .binding
        .as_ref()
        .and_then(|binding| binding.received.as_ref())
    {
        return hash(&(
            "plugin-received-logical/1",
            &job.profile,
            received.logical_identity()?,
            job.target_project
                .as_ref()
                .map(|project| project.identity()),
        ));
    }

    if let Some(project) = &job.target_project {
        let source = job
            .binding
            .as_ref()
            .context("plugin_migration_source_missing")?;
        return hash(&(
            "plugin-logical-project/1",
            &job.profile,
            source.kind,
            &source.identity,
            &source.source_id,
            &source.source_scope,
            source.project.as_ref().map(|project| project.identity()),
            project.identity(),
        ));
    }
    let source = job
        .binding
        .as_ref()
        .context("plugin_migration_source_missing")?;
    hash(&(
        "plugin-logical-source/1",
        &job.profile,
        &source.identity,
        source.kind,
        &source.source_id,
        &source.source_scope,
    ))
}
