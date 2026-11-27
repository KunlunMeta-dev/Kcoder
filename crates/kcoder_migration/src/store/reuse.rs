//! Derived lookup accelerates provenance searches; native receipts and current data remain authoritative.
use super::*;
use crate::{
    assets::{AssetPlan, AssetTarget},
    batch::{BatchActionKind, BatchResolution, BatchSource, ReuseProof, settings::SettingsStep},
    mcp::McpPlan,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
mod history;
mod mcp;
mod plugins;
mod projects;
use mcp::McpOrigin;

const INDEX_FILE: &str = ".reuse-index.json";
const INDEX_BYTES: u64 = 8 * 1024 * 1024;
const INDEX_VERSION: u8 = 6;

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    #[serde(default)]
    version: u8,
    jobs: BTreeMap<String, IndexedJob>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexedJob {
    stamp: String,
    candidates: Vec<ReuseProof>,
    references: Vec<(String, String)>,
}

pub(super) enum Origin {
    Template(Box<crate::templates::TemplatePlan>),
    Provider(Box<ProviderPlan>),
    Mcp(McpOrigin),
    Asset(Box<AssetPlan>),
    History(Box<history::HistoryOrigin>),
    Plugin(Box<plugins::PluginOrigin>),
    Project(Box<projects::ProjectOrigin>),
}
impl Origin {
    fn fingerprint(&self) -> Result<String> {
        match self {
            Self::Template(plan) => plan.semantic_fingerprint(),
            Self::Provider(plan) => digest(&(plan.target_name(), plan.provider())),
            Self::Mcp(plan) => plan.fingerprint(),
            Self::Asset(plan) => plan.semantic_fingerprint(),
            Self::History(plan) => plan.fingerprint(),
            Self::Plugin(plan) => plan.fingerprint(),
            Self::Project(plan) => plan.fingerprint(),
        }
    }
    fn name(&self) -> &str {
        match self {
            Self::Template(plan) => plan.template_id(),
            Self::Provider(plan) => plan.target_name(),
            Self::Mcp(plan) => &plan.config().name,
            Self::Asset(plan) => plan.name(),
            Self::History(plan) => plan.name(),
            Self::Plugin(plan) => plan.name(),
            Self::Project(plan) => plan.name(),
        }
    }
    fn enabled(&self) -> bool {
        match self {
            Self::Provider(_)
            | Self::Template(_)
            | Self::History(_)
            | Self::Plugin(_)
            | Self::Project(_) => false,
            Self::Mcp(plan) => plan.enabled(),
            Self::Asset(plan) => plan.enabled(),
        }
    }
    fn scoped(&self) -> bool {
        match self {
            Self::Provider(_) | Self::Template(_) | Self::History(_) | Self::Plugin(_) => false,
            Self::Project(_) => true,
            Self::Mcp(plan) => plan.config().policy.workspace.is_some(),
            Self::Asset(plan) => plan.project_scoped(),
        }
    }
    fn native_reference(&self) -> bool {
        matches!(self, Self::History(_))
            || matches!(self,Self::Asset(plan) if plan.native_reference())
    }
    fn observe(
        &self,
        targets: &BatchTargets<'_>,
        directory: &PrivateDirectory,
    ) -> Result<Option<bool>> {
        match self {
            Self::Template(plan) => targets.provider.templates()?.observe(plan),
            Self::Provider(plan) => Ok(targets.provider.observe(plan)?.then_some(false)),
            Self::Mcp(plan) => plan.observe(targets),
            Self::Asset(plan) => targets.assets.observe(plan),
            Self::History(plan) => plan.observe(targets, directory),
            Self::Plugin(plan) => plan.observe(directory),
            Self::Project(plan) => plan.observe(directory),
        }
    }
}

fn digest<T: Serialize>(value: &T) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn source_key(source: &BatchSource, item: &crate::NormalizedItem) -> Result<String> {
    if matches!(source, BatchSource::History(_) | BatchSource::Project(_)) {
        // A display title can become available after paging without changing the frozen source.
        return digest(&(
            "history/v1",
            source.logical_identity(),
            item.preview.category,
        ));
    }
    // Template rows share the wire category with Providers; keep their provenance distinct.
    if item.template.is_some() {
        return digest(&(
            "template/v1",
            source.logical_identity(),
            &item.preview.source_name,
        ));
    }
    digest(&(
        source.logical_identity(),
        item.preview.category,
        &item.preview.source_name,
    ))
}

fn action_references(action: &crate::batch::BatchAction) -> Vec<&ReuseProof> {
    match &action.action {
        BatchActionKind::Reuse { proof }
            if matches!(
                action.status,
                ItemStatus::Skipped | ItemStatus::Committing | ItemStatus::CommitUnknown
            ) || proof.history_reference.is_some()
                && action.status != ItemStatus::RolledBack =>
        {
            vec![proof]
        }
        BatchActionKind::Settings { plan } if action.status != ItemStatus::RolledBack => plan
            .steps
            .iter()
            .filter_map(|step| match step {
                SettingsStep::Mcp(plan) => plan.reuse_origin.as_ref(),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

impl MigrationStore {
    fn index_for_reuse(&self) -> Result<Index> {
        let mut index: Index = match self
            .directory
            .open_single_link_regular_file(OsStr::new(INDEX_FILE))
        {
            Ok(file) => {
                ensure!(
                    file.metadata()?.len() <= INDEX_BYTES,
                    "migration_reuse_budget_exceeded"
                );
                let mut bytes = Vec::new();
                file.take(INDEX_BYTES + 1).read_to_end(&mut bytes)?;
                ensure!(
                    bytes.len() as u64 <= INDEX_BYTES,
                    "migration_reuse_budget_exceeded"
                );
                serde_json::from_slice(&bytes).unwrap_or_default()
            }
            Err(error)
                if error.chain().any(|error| {
                    error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                }) =>
            {
                Index::default()
            }
            Err(_) => anyhow::bail!("migration_reuse_index_unavailable"),
        };
        if index.version != INDEX_VERSION {
            index = Index {
                version: INDEX_VERSION,
                ..Index::default()
            };
        }
        ensure!(index.jobs.len() <= 4096, "migration_reuse_budget_exceeded");
        let mut ids = BTreeSet::new();
        self.directory.visit_entry_names_bounded(16384, |name| {
            if let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json"))
                && job_file(id).is_ok()
            {
                ids.insert(id.to_owned());
            }
            Ok(())
        })?;
        ensure!(ids.len() <= 4096, "migration_reuse_budget_exceeded");
        index.jobs.retain(|id, _| ids.contains(id));
        for id in ids {
            let metadata = self.directory.entry_metadata(OsStr::new(&job_file(&id)?))?;
            let stamp = format!(
                "{}:{}",
                metadata.len(),
                metadata
                    .modified()?
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_nanos()
            );
            if index
                .jobs
                .get(&id)
                .is_some_and(|cached| cached.stamp == stamp)
            {
                continue;
            }
            let job = self.load(&id)?;
            let mut candidates = Vec::new();
            let mut references = Vec::new();
            if let Some(batch) = &job.batch {
                for action in &batch.actions {
                    references.extend(
                        action_references(action)
                            .into_iter()
                            .map(|proof| (proof.job_id.clone(), proof.action_id.clone())),
                    );
                    if !matches!(action.action, BatchActionKind::Reuse { .. })
                        && action.status == ItemStatus::Committed
                    {
                        for item_id in &action.item_ids {
                            if let Some(proof) =
                                self.descriptor(&job, &action.action_id, item_id)?
                            {
                                candidates.push(proof);
                            }
                        }
                    }
                }
            } else {
                for receipt in &job.receipts {
                    if let Some(proof) =
                        self.descriptor(&job, &receipt.operation_id, &receipt.item_id)?
                    {
                        candidates.push(proof);
                    }
                }
            }
            index.jobs.insert(
                id,
                IndexedJob {
                    stamp,
                    candidates,
                    references,
                },
            );
            ensure!(
                index
                    .jobs
                    .values()
                    .map(|job| job.candidates.len() + job.references.len())
                    .sum::<usize>()
                    <= 16384,
                "migration_reuse_budget_exceeded"
            );
        }
        let bytes = serde_json::to_vec(&index)?;
        ensure!(
            bytes.len() as u64 <= INDEX_BYTES,
            "migration_reuse_budget_exceeded"
        );
        self.directory
            .atomic_replace(OsStr::new(INDEX_FILE), &bytes)?;
        Ok(index)
    }

    fn descriptor(
        &self,
        job: &MigrationJob,
        action_id: &str,
        item_id: &str,
    ) -> Result<Option<ReuseProof>> {
        let Some(item) = job
            .inventory
            .items
            .iter()
            .find(|item| item.preview.id == item_id)
        else {
            return Ok(None);
        };
        let Some(origin) = self.origin(job, action_id, item_id)? else {
            return Ok(None);
        };
        let source = match &job.batch {
            Some(batch) => batch.source_for(item_id)?.clone(),
            None => {
                if let Some(binding) = &job.source_binding {
                    BatchSource::Configuration(binding.clone())
                } else if let Some(binding) = &job.asset_binding {
                    BatchSource::Assets(binding.clone())
                } else {
                    return Ok(None);
                }
            }
        };
        Ok(Some(ReuseProof {
            history_reference: None,
            history_job_id: match &origin {
                Origin::History(plan) => Some(plan.job_id().into()),
                _ => None,
            },
            dependency_action_id: None,
            job_id: job.job_id.clone(),
            action_id: action_id.into(),
            item_id: item_id.into(),
            source_key: source_key(&source, item)?,
            fingerprint: origin.fingerprint()?,
            target_name: origin.name().into(),
            enabled: origin.enabled(),
            project_scoped: origin.scoped(),
            native_reference: origin.native_reference(),
        }))
    }

    pub(super) fn origin(
        &self,
        job: &MigrationJob,
        action_id: &str,
        item_id: &str,
    ) -> Result<Option<Origin>> {
        if matches!(job.status, JobStatus::RollingBack | JobStatus::RolledBack) {
            return Ok(None);
        }
        let Some(receipt) = job
            .receipts
            .iter()
            .find(|receipt| receipt.operation_id == action_id)
        else {
            return Ok(None);
        };
        let origin = if let Some(batch) = &job.batch {
            let Some(action) = batch.actions.iter().find(|action| {
                action.action_id == action_id
                    && action.item_ids.iter().any(|id| id == item_id)
                    && (action.status == ItemStatus::Committed
                        || action.status == ItemStatus::RollbackConflict
                            && action.error.as_deref() == Some("migration_result_referenced"))
            }) else {
                return Ok(None);
            };
            match &action.action {
                BatchActionKind::Project { plan } => Some(Origin::Project(Box::new(
                    projects::ProjectOrigin::new(&self.profile, &self.directory, plan, receipt)?,
                ))),
                BatchActionKind::Plugin { plan } => {
                    Some(Origin::Plugin(Box::new(plugins::PluginOrigin::new(
                        batch,
                        &job.job_id,
                        action_id,
                        item_id,
                        plan,
                        receipt,
                    )?)))
                }
                BatchActionKind::Asset { plan_id, .. } => Some(Origin::Asset(Box::new(
                    self.load_batch_asset(&job.job_id, plan_id)?,
                ))),
                BatchActionKind::Settings { plan } => plan
                    .steps
                    .iter()
                    .find(|step| step.item().preview.id == item_id)
                    .and_then(|step| match step {
                        SettingsStep::Provider(plan) => Some(Origin::Provider(plan.clone())),
                        SettingsStep::Mcp(plan) => {
                            McpOrigin::new(job, plan.clone()).map(Origin::Mcp)
                        }
                    }),
                BatchActionKind::Template { plan } => Some(Origin::Template(plan.clone())),
                BatchActionKind::Reuse { .. } => None,
                BatchActionKind::History { plan } => Some(Origin::History(Box::new(
                    history::HistoryOrigin::new(batch, item_id, plan, receipt)?,
                ))),
            }
        } else if let Some(plan) = job
            .provider_plans
            .iter()
            .find(|plan| plan.id() == action_id && plan.item().preview.id == item_id)
        {
            Some(Origin::Provider(Box::new(plan.clone())))
        } else if let Some(plan) = job
            .mcp_plans
            .iter()
            .find(|plan| plan.id() == action_id && plan.item().preview.id == item_id)
        {
            McpOrigin::new(job, Box::new(plan.clone())).map(Origin::Mcp)
        } else {
            job.asset_plans
                .iter()
                .find(|plan| plan.id() == action_id && plan.item().preview.id == item_id)
                .map(|plan| Origin::Asset(Box::new(plan.clone())))
        };
        Ok(origin.filter(|origin| receipt.ownership_confirmed || origin.native_reference()))
    }

    pub(super) fn reuse_candidates(&self) -> Result<Vec<ReuseProof>> {
        Ok(self
            .index_for_reuse()?
            .jobs
            .into_values()
            .flat_map(|job| job.candidates)
            .collect())
    }
    pub(super) fn find_reuse(
        &self,
        job_id: &str,
        source: &BatchSource,
        item: &crate::NormalizedItem,
        resolution: &BatchResolution,
        targets: &BatchTargets<'_>,
        candidates: &[ReuseProof],
    ) -> Result<Option<ReuseProof>> {
        if matches!(source, BatchSource::Assets(binding) if !binding.allows_reuse()) {
            return Ok(None);
        }
        let fingerprint = match resolution {
            BatchResolution::Project(value) => {
                let BatchSource::Project(source) = source else {
                    anyhow::bail!("migration_invalid_batch_resolution")
                };
                crate::project_migration::plan::ProjectAssociationPlan::requested_fingerprint(
                    source,
                    &value.selection,
                )?
            }
            BatchResolution::Plugin(value) => {
                let BatchSource::Plugin(source) = source else {
                    anyhow::bail!("migration_invalid_batch_resolution")
                };
                source.semantic_fingerprint(&value.target_name)?
            }
            BatchResolution::Provider(value) => digest(&(
                &value.target_name,
                crate::providers::resolve(item, value)?.1,
            ))?,
            BatchResolution::Mcp(value) => {
                let mut preflight = value.clone();
                preflight.enable_after_import = false;
                let resolved = crate::mcp::resolve(item, &preflight)?;
                digest(&(
                    resolved.mcp.as_ref().unwrap().config.clone(),
                    value.enable_after_import,
                ))?
            }
            BatchResolution::Asset(value) => {
                let BatchSource::Assets(binding) = source else {
                    anyhow::bail!("migration_invalid_batch_resolution")
                };
                AssetTarget::requested_fingerprint(item, binding, value)?
            }
            BatchResolution::History(_) => {
                let BatchSource::History(binding) = source else {
                    anyhow::bail!("migration_invalid_batch_resolution")
                };
                history::requested_fingerprint(binding)?
            }
            BatchResolution::Template(_) => return Ok(None),
        };
        let target_name = match resolution {
            BatchResolution::Project(value) => value.selection.target_name(),
            BatchResolution::Plugin(value) => &value.target_name,
            BatchResolution::Provider(value) => &value.target_name,
            BatchResolution::Mcp(value) => &value.target_name,
            BatchResolution::Asset(value) => &value.target_name,
            BatchResolution::Template(value) => &value.target_name,
            BatchResolution::History(_) => {
                let BatchSource::History(binding) = source else {
                    anyhow::bail!("migration_invalid_batch_resolution")
                };
                binding.identity()
            }
        };
        self.find_matching_reuse(
            job_id,
            source,
            item,
            (target_name, &fingerprint),
            targets,
            candidates,
        )
    }

    pub(super) fn find_template_reuse(
        &self,
        job_id: &str,
        source: &BatchSource,
        item: &crate::NormalizedItem,
        request: (
            &crate::templates::TemplateResolution,
            &crate::templates::ProviderDependency,
        ),
        targets: &BatchTargets<'_>,
        candidates: &[ReuseProof],
    ) -> Result<Option<ReuseProof>> {
        let (resolution, provider) = request;
        let fingerprint =
            crate::templates::TemplateTarget::requested_fingerprint(item, resolution, provider)?;
        self.find_matching_reuse(
            job_id,
            source,
            item,
            (&resolution.target_name, &fingerprint),
            targets,
            candidates,
        )
    }

    fn find_matching_reuse(
        &self,
        job_id: &str,
        source: &BatchSource,
        item: &crate::NormalizedItem,
        expected: (&str, &str),
        targets: &BatchTargets<'_>,
        candidates: &[ReuseProof],
    ) -> Result<Option<ReuseProof>> {
        let (target_name, fingerprint) = expected;
        let key = source_key(source, item)?;
        for candidate in candidates.iter().filter(|proof| {
            proof.job_id != job_id && proof.source_key == key && proof.fingerprint == fingerprint
        }) {
            let previous = self.load(&candidate.job_id)?;
            let Some(verified) =
                self.descriptor(&previous, &candidate.action_id, &candidate.item_id)?
            else {
                continue;
            };
            if verified.source_key != key || verified.fingerprint != fingerprint {
                continue;
            }
            let Some(origin) = self.origin(&previous, &candidate.action_id, &candidate.item_id)?
            else {
                continue;
            };
            let observed = match origin.observe(targets, &self.directory) {
                Ok(observed) => observed,
                Err(error) if error.to_string() == "migration_wrong_target" => continue,
                Err(error) => return Err(error),
            };
            if let Some(enabled) = observed {
                return Ok(Some(ReuseProof {
                    enabled,
                    ..verified
                }));
            }
        }
        for candidate in candidates.iter().filter(|proof| {
            proof.job_id != job_id
                && proof.source_key == key
                && proof.target_name == target_name
                && proof.fingerprint != fingerprint
        }) {
            let previous = self.load(&candidate.job_id)?;
            if let Some(verified) =
                self.descriptor(&previous, &candidate.action_id, &candidate.item_id)?
                && verified.source_key == key
                && verified.target_name == target_name
                && verified.fingerprint != fingerprint
                && let Some(origin) =
                    self.origin(&previous, &candidate.action_id, &candidate.item_id)?
            {
                match origin.observe(targets, &self.directory) {
                    Ok(Some(_)) => anyhow::bail!("migration_source_updated"),
                    Err(error) if error.to_string() == "migration_wrong_target" => {}
                    Err(error) => return Err(error),
                    _ => {}
                }
            }
        }
        Ok(None)
    }

    pub(super) fn observe_reuse(
        &self,
        proof: &ReuseProof,
        targets: &BatchTargets<'_>,
    ) -> Result<bool> {
        let previous = self.load(&proof.job_id)?;
        let verified = self
            .descriptor(&previous, &proof.action_id, &proof.item_id)?
            .ok_or_else(|| anyhow::anyhow!("migration_reuse_target_changed"))?;
        ensure!(
            verified.source_key == proof.source_key
                && verified.fingerprint == proof.fingerprint
                && verified.history_job_id == proof.history_job_id,
            "migration_reuse_target_changed"
        );
        let origin = self
            .origin(&previous, &proof.action_id, &proof.item_id)?
            .ok_or_else(|| anyhow::anyhow!("migration_reuse_target_changed"))?;
        origin
            .observe(targets, &self.directory)?
            .ok_or_else(|| anyhow::anyhow!("migration_reuse_target_changed"))
    }

    pub fn reused_settings(
        &self,
        job_id: &str,
        item_id: &str,
    ) -> Result<(
        Option<kcoder_config::ProviderConfig>,
        Option<kcoder_types::McpServerConfig>,
    )> {
        let job = self.read(job_id)?;
        if let Some(batch) = &job.batch
            && let Some(proof) = batch.actions.iter().find_map(|action| {
                if action.item_ids.iter().any(|id| id == item_id) {
                    match &action.action {
                        BatchActionKind::Reuse { proof } => Some(proof),
                        _ => None,
                    }
                } else {
                    None
                }
            })
        {
            let previous = self.load(&proof.job_id)?;
            return Ok(
                match self.origin(&previous, &proof.action_id, &proof.item_id)? {
                    Some(Origin::Provider(plan)) => (Some(plan.provider().clone()), None),
                    Some(Origin::Mcp(plan)) => (None, Some(plan.config().clone())),
                    _ => (None, None),
                },
            );
        }
        Ok((None, None))
    }

    pub fn template_settings(
        &self,
        job_id: &str,
        item_id: &str,
    ) -> Result<Option<crate::templates::TemplateSettings>> {
        let job = self.read(job_id)?;
        let Some(action) = job.batch.as_ref().and_then(|batch| {
            batch
                .actions
                .iter()
                .find(|action| action.item_ids.iter().any(|id| id == item_id))
        }) else {
            return Ok(None);
        };
        Ok(match &action.action {
            BatchActionKind::Template { plan } => Some(plan.settings()),
            BatchActionKind::Reuse { proof } => {
                let previous = self.load(&proof.job_id)?;
                match self.origin(&previous, &proof.action_id, &proof.item_id)? {
                    Some(Origin::Template(plan)) => Some(plan.settings()),
                    _ => None,
                }
            }
            _ => None,
        })
    }

    pub(super) fn require_unreferenced(&self, job_id: &str, action_id: &str) -> Result<()> {
        // Negative cache entries cannot authorize deletion. Read current reference facts.
        let mut ids = Vec::new();
        self.directory.visit_entry_names_bounded(16384, |name| {
            if let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json"))
                && job_file(id).is_ok()
                && id != job_id
            {
                ids.push(id.to_owned());
            }
            Ok(())
        })?;
        ensure!(ids.len() <= 4096, "migration_reuse_budget_exceeded");
        for id in ids {
            let job = self.load(&id)?;
            if job.batch.as_ref().is_some_and(|batch| {
                batch.actions.iter().any(|action| {
                    action_references(action)
                        .iter()
                        .any(|proof| proof.job_id == job_id && proof.action_id == action_id)
                })
            }) {
                anyhow::bail!("migration_result_referenced");
            }
        }
        Ok(())
    }
}
