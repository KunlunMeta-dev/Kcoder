//! Single-owner batch coordination publishes independent assets at recoverable boundaries.
use super::*;
use crate::batch::execution::{BatchExecution, BatchRunEvent, BatchRunMode};
use crate::{
    assets::{AssetPlan, AssetTarget},
    batch::{
        BatchAction, BatchActionKind, BatchItemSource, BatchResolution, BatchSource, BatchState,
        settings::SettingsGroupPlan,
    },
    mcp::McpTarget,
};
use anyhow::Context;

pub struct BatchTargets<'a> {
    pub provider: &'a ProviderTarget,
    pub mcp: &'a McpTarget,
    pub assets: &'a AssetTarget,
    pub credentials: Option<super::CredentialTargets<'a>>,
    pub history: Option<&'a crate::history_jobs::HistoryJobStore>,
}
mod activity;
mod control;
pub(super) mod creation;
mod history;
mod history_parallel;
mod instructions;
mod plugins;
mod projects;
mod resources;
#[cfg(test)]
thread_local! {static FAIL_AFTER_PUBLICATION:std::cell::Cell<bool>=const {std::cell::Cell::new(false)};}
#[cfg(test)]
thread_local! {pub(super) static FAIL_AFTER_TEMPLATE_PUBLICATION:std::cell::Cell<bool>=const {std::cell::Cell::new(false)};}

impl MigrationStore {
    pub fn asset_snapshot(&self, job_id: &str, item_id: &str) -> Result<Option<String>> {
        let job = self.read(job_id)?;
        if let Some(plan) = job
            .asset_plans
            .iter()
            .find(|plan| plan.item().preview.id == item_id)
        {
            return plan.original_text().map(Some);
        }
        if let Some(batch) = &job.batch {
            for action in &batch.actions {
                if action.item_ids.iter().any(|id| id == item_id)
                    && let BatchActionKind::Reuse { proof } = &action.action
                {
                    let previous = self.load(&proof.job_id)?;
                    if let Some(plan) = previous.asset_plans.iter().find(|plan| {
                        plan.id() == proof.action_id && plan.item().preview.id == proof.item_id
                    }) {
                        return plan.original_text().map(Some);
                    }
                    if let Some(previous_batch) = &previous.batch
                        && let Some(plan_id) = previous_batch.actions.iter().find_map(|action| {
                            if action.action_id == proof.action_id
                                && action.item_ids.contains(&proof.item_id)
                            {
                                match &action.action {
                                    BatchActionKind::Asset { plan_id, .. } => Some(plan_id),
                                    _ => None,
                                }
                            } else {
                                None
                            }
                        })
                    {
                        return self
                            .load_batch_asset(&previous.job_id, plan_id)?
                            .original_text()
                            .map(Some);
                    }
                    return Err(anyhow::anyhow!("migration_invalid_journal"));
                }
                if action.item_ids.iter().any(|id| id == item_id)
                    && let BatchActionKind::Asset { plan_id, .. } = &action.action
                {
                    return self
                        .load_batch_asset(job_id, plan_id)?
                        .original_text()
                        .map(Some);
                }
            }
        }
        Ok(None)
    }
    pub fn create_batch_scan(&self, inputs: Vec<BatchSource>) -> Result<MigrationJob> {
        self.create_batch_scan_with_resource_limits(inputs, Default::default())
    }
    pub fn create_batch_scan_with_resource_limits(
        &self,
        inputs: Vec<BatchSource>,
        limits: kcoder_types::migration_resource::MigrationResourceLimits,
    ) -> Result<MigrationJob> {
        let job = self.freeze_batch_scan_with_resource_limits(
            &format!("mig-{}", uuid::Uuid::new_v4().simple()),
            &format!("src-{}", uuid::Uuid::new_v4().simple()),
            inputs,
            limits,
            &mut |_| true,
        )?;
        let _lock = self.write_lock()?;
        self.save(&job)?;
        Ok(job)
    }
    pub(super) fn freeze_batch_scan(
        &self,
        job_id: &str,
        source_id: &str,
        inputs: Vec<BatchSource>,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<MigrationJob> {
        self.freeze_batch_scan_with_resource_limits(
            job_id,
            source_id,
            inputs,
            Default::default(),
            check,
        )
    }
    pub(super) fn freeze_batch_scan_with_resource_limits(
        &self,
        job_id: &str,
        source_id: &str,
        inputs: Vec<BatchSource>,
        limits: kcoder_types::migration_resource::MigrationResourceLimits,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<MigrationJob> {
        ensure!(limits.is_supported(), "migration_invalid_resource_limits");
        ensure!(
            !inputs.is_empty() && inputs.len() <= 64,
            "migration_batch_budget_exceeded"
        );
        let mut history_bytes = 0u64;
        let mut plugin_bytes = 0u64;
        for source in &inputs {
            if let BatchSource::TransferredConfiguration(source) = source {
                source.verify_batch_parent(&self.directory)?;
            }
            if let BatchSource::Assets(source) = source {
                source.verify_batch_parent(&self.directory)?;
            }
            if let BatchSource::History(source) = source {
                source.selection().verify_batch_parent(&self.directory)?;
                history_bytes = history_bytes
                    .checked_add(source.bytes())
                    .ok_or_else(|| anyhow::anyhow!("migration_history_batch_budget_exceeded"))?;
            }
            if let BatchSource::Plugin(source) = source {
                source.verify_batch_parent(&self.directory)?;
                plugin_bytes = plugin_bytes
                    .checked_add(source.bytes())
                    .context("migration_plugin_batch_budget_exceeded")?;
            }
        }
        ensure!(
            plugin_bytes <= 4 * 1024 * 1024 * 1024,
            "migration_plugin_batch_budget_exceeded"
        );
        ensure!(
            history_bytes <= limits.max_total_bytes,
            "migration_history_batch_budget_exceeded"
        );
        let kind = inputs[0].kind();
        let mut sources = Vec::new();
        let mut item_sources = Vec::new();
        let mut items = Vec::new();
        for input in inputs {
            if let BatchSource::Project(source) = &input {
                source.verify_profile(&self.profile)?;
            }
            ensure!(input.kind() == kind, "migration_batch_source_mismatch");
            if sources.contains(&input) {
                continue;
            }
            ensure!(check(items.len() as u64), "source_transfer_cancelled");
            let (input, inventory) = match input {
                BatchSource::Assets(binding) => {
                    let (binding, inventory) = if binding.is_scoped_instruction() {
                        binding.freeze_in_job(
                            &self.plan_directory(job_id, true)?,
                            &self.profile,
                            job_id,
                            &mut *check,
                        )?
                    } else {
                        binding.freeze_checked(&mut *check)?
                    };
                    (BatchSource::Assets(binding), inventory)
                }
                other => {
                    let inventory = other.inventory()?;
                    (other, inventory)
                }
            };
            for mut item in inventory.items {
                item.preview.id = format!("item-{}", uuid::Uuid::new_v4().simple());
                item.preview.issues.extend(inventory.issues.iter().cloned());
                if item
                    .preview
                    .issues
                    .iter()
                    .any(|issue| issue.blocks_import())
                {
                    item.preview.selected_by_default = false;
                    item.preview.status = ItemStatus::RequiresAction;
                }
                item_sources.push(BatchItemSource {
                    item_id: item.preview.id.clone(),
                    source_index: sources.len(),
                });
                items.push(item);
            }
            sources.push(input);
            ensure!(items.len() <= 1024, "migration_inventory_budget_exceeded");
        }
        Self::new_scan(
            job_id,
            source_id,
            MigrationInventory {
                source: kind,
                adapter_revision: "migration-batch/v1".into(),
                items,
                issues: Vec::new(),
            },
            None,
            None,
            Some(BatchState {
                execution_control: None,
                creation: None,
                resource_limits: Some(limits),
                atomic_credentials: false,
                sources,
                item_sources,
                plan_id: None,
                actions: Vec::new(),
                request_kinds: Default::default(),
                credential_plan_ids: Vec::new(),
                received: None,
                local_project: None,
            }),
        )
    }

    pub fn prepare_batch(
        &self,
        job_id: &str,
        expected_sequence: u64,
        resolutions: &[BatchResolution],
        targets: &BatchTargets<'_>,
    ) -> Result<MigrationJob> {
        self.prepare_batch_with_policy(
            job_id,
            expected_sequence,
            resolutions,
            targets,
            &crate::batch::BatchPlanPolicy::default(),
        )
    }
    pub fn prepare_batch_with_policy(
        &self,
        job_id: &str,
        expected_sequence: u64,
        resolutions: &[BatchResolution],
        targets: &BatchTargets<'_>,
        policy: &crate::batch::BatchPlanPolicy,
    ) -> Result<MigrationJob> {
        ensure!(
            !resolutions.is_empty() && resolutions.len() <= 1024,
            "migration_batch_budget_exceeded"
        );
        let mut staged = Vec::new();
        let mut history_references = Vec::new();
        let result = self.update(job_id, expected_sequence, |job| {
            self.ensure_no_pending_received_preparation(job)?;
            ensure!(
                job.sequence == expected_sequence,
                "migration_revision_conflict"
            );
            ensure!(
                job.status == JobStatus::Ready,
                "migration_invalid_transition"
            );
            let mut batch = job
                .batch
                .clone()
                .ok_or_else(|| anyhow::anyhow!("migration_not_a_batch"))?;
            ensure!(batch.plan_id.is_none(), "migration_plan_already_exists");
            self.verify_project_targets(job, targets)?;
            let mut selected = BTreeSet::new();
            let reusable = if policy.reuse_existing {
                self.reuse_candidates()?
            } else {
                Vec::new()
            };
            let mut settings = Vec::new();
            let mut amendments = Vec::new();
            let mut names = BTreeSet::new();
            let mut contexts = Vec::new();
            let mut templates = Vec::new();
            let mut context_bytes = 0usize;
            for resolution in resolutions {
                ensure!(
                    selected.insert(resolution.item_id().to_owned()),
                    "migration_duplicate_selection"
                );
                let item = job
                    .inventory
                    .items
                    .iter_mut()
                    .find(|item| item.preview.id == resolution.item_id())
                    .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
                let source = batch.source_for(&item.preview.id)?;
                ensure!(source.unchanged(item), "migration_source_changed");
                if let BatchSource::Configuration(binding) = source
                    && let Some(project) = binding.project_root()
                    && let Some(candidate) = item.mcp.as_mut()
                {
                    candidate.config.policy.workspace =
                        Some(project.to_string_lossy().into_owned());
                }
                if policy.reuse_existing
                    && let Some(mut proof) =
                        self.find_reuse(&job.job_id, source, item, resolution, targets, &reusable)?
                {
                    match resolution {
                        BatchResolution::Provider(value) => {
                            *item = crate::providers::resolve(item, value)?.0
                        }
                        BatchResolution::Mcp(value) => {
                            *item = self.resolved_mcp_reuse(item, value, &proof)?
                        }
                        _ => {}
                    }
                    item.preview.status = ItemStatus::Staged;
                    if matches!(resolution, BatchResolution::Mcp(_))
                        && policy
                            .mcp_credentials
                            .iter()
                            .any(|choice| choice.item_id == item.preview.id)
                    {
                        amendments.push(self.mcp_reuse_amendment(item, &proof)?);
                        continue;
                    }
                    let action_id = format!("reuse-{}", uuid::Uuid::new_v4().simple());
                    self.pin_history_reuse(&job.job_id, &action_id, &mut proof, targets)?;
                    if proof.history_reference.is_some() {
                        history_references.push((action_id.clone(), proof.clone()));
                    }
                    batch.actions.push(BatchAction {
                        action_id,
                        item_ids: vec![item.preview.id.clone()],
                        action: BatchActionKind::Reuse { proof },
                        status: ItemStatus::Staged,
                        error: None,
                    });
                    continue;
                }
                match resolution {
                    BatchResolution::Project(value) => {
                        let BatchSource::Project(source) = source else {
                            anyhow::bail!("migration_invalid_batch_resolution")
                        };
                        let action_id = format!("project-{}", uuid::Uuid::new_v4().simple());
                        let plan = crate::project_migration::plan::ProjectAssociationPlan::prepare(
                            &self.profile,
                            &job.job_id,
                            &action_id,
                            source,
                            value.selection.clone(),
                            &Default::default(),
                        )?;
                        ensure!(
                            names.insert(format!(
                                "project:{}:{}",
                                source.logical_identity(),
                                plan.target_name()
                            )),
                            "migration_target_conflict"
                        );
                        batch.actions.push(BatchAction {
                            action_id,
                            item_ids: vec![item.preview.id.clone()],
                            action: BatchActionKind::Project {
                                plan: Box::new(plan),
                            },
                            status: ItemStatus::Staged,
                            error: None,
                        });
                        item.preview.status = ItemStatus::Staged;
                    }
                    BatchResolution::Plugin(value) => {
                        let BatchSource::Plugin(source) = source else {
                            anyhow::bail!("migration_invalid_batch_resolution")
                        };
                        source.verify_batch_parent(&self.directory)?;
                        let target = source.target_id(&value.target_name)?;
                        ensure!(
                            names.insert(format!("plugin:{target}")),
                            "migration_target_conflict"
                        );
                        batch.actions.push(BatchAction {
                            action_id: format!("plugin-{}", uuid::Uuid::new_v4().simple()),
                            item_ids: vec![item.preview.id.clone()],
                            action: BatchActionKind::Plugin {
                                plan: Box::new(crate::batch::plugins::PluginBatchAction {
                                    target_name: value.target_name.clone(),
                                    reference: None,
                                }),
                            },
                            status: ItemStatus::Staged,
                            error: None,
                        });
                        item.preview.status = ItemStatus::Staged;
                    }
                    BatchResolution::History(_) => {
                        targets
                            .history
                            .context("migration_history_target_required")?
                            .verify_batch_parent(&self.directory)?;
                        let BatchSource::History(binding) = source else {
                            anyhow::bail!("migration_invalid_batch_resolution")
                        };
                        binding.validate()?;
                        let child = uuid::Uuid::new_v4().to_string();
                        batch.actions.push(BatchAction {
                            action_id: child.clone(),
                            item_ids: vec![item.preview.id.clone()],
                            action: BatchActionKind::History {
                                plan: crate::batch::history::HistoryBatchAction {
                                    history_job_id: child,
                                    source_fingerprint: binding.identity().into(),
                                    normalization_revision: binding.revision().into(),
                                },
                            },
                            status: ItemStatus::Staged,
                            error: None,
                        });
                        item.preview.status = ItemStatus::Staged;
                    }
                    BatchResolution::Template(value) => templates.push(value.clone()),
                    BatchResolution::Asset(value) => {
                        let BatchSource::Assets(binding) = source else {
                            anyhow::bail!("migration_invalid_batch_resolution")
                        };
                        let class = if value.agent_adaptation.is_some()
                            || matches!(
                                item.preview.category,
                                kcoder_types::migration::MigrationCategory::Skill
                                    | kcoder_types::migration::MigrationCategory::Command
                            ) {
                            "skill"
                        } else if item.preview.category
                            == kcoder_types::migration::MigrationCategory::Agent
                        {
                            "pending-agent"
                        } else if item.preview.category
                            == kcoder_types::migration::MigrationCategory::Hook
                        {
                            "pending-hook"
                        } else {
                            "context"
                        };
                        ensure!(
                            class != "skill"
                                || !policy.reserved_skills.contains(&value.target_name),
                            "migration_target_conflict"
                        );
                        let scope = crate::assets::resolved_scope(item, binding, value)?;
                        ensure!(
                            names.insert(format!(
                                "{class}:{}:{}",
                                serde_json::to_string(&scope)?,
                                value.target_name
                            )),
                            "migration_target_conflict"
                        );
                        let mut plan = targets.assets.prepare(item, binding, value)?;
                        plan.bind_memory_job(job_id)?;
                        if let Some(record) = plan.context_record() {
                            context_bytes += record.content.len();
                            ensure!(
                                contexts.len() < 128 && context_bytes <= 16 * 1024 * 1024,
                                "migration_context_capacity_or_conflict"
                            );
                            contexts.push(record.clone());
                        }
                        staged.push(plan.id().to_owned());
                        self.save_batch_asset(job_id, &plan)?;
                        *item = plan.item().clone();
                        batch.actions.push(BatchAction {
                            action_id: plan.id().into(),
                            item_ids: vec![item.preview.id.clone()],
                            action: BatchActionKind::Asset {
                                plan_id: plan.id().into(),
                                target_name: plan.name().into(),
                                enabled: plan.enabled(),
                                project_scoped: plan.project_scoped(),
                                native_reference: plan.native_reference(),
                            },
                            status: ItemStatus::Staged,
                            error: None,
                        });
                    }
                    BatchResolution::Provider(_) | BatchResolution::Mcp(_) => {
                        if let BatchResolution::Mcp(value) = resolution {
                            ensure!(
                                !policy
                                    .reserved_mcp
                                    .contains(&kcoder_mcp_policy::mcp_tool_name(
                                        &value.target_name,
                                        "migration_namespace_probe"
                                    )),
                                "migration_target_conflict"
                            );
                        }
                        match source {
                            BatchSource::Configuration(binding) => {
                                if let (Some(project), Some(candidate)) =
                                    (batch.project_target(), item.mcp.as_mut())
                                {
                                    candidate.config.policy.workspace =
                                        Some(project.root().to_string_lossy().into_owned());
                                } else if let Some(project) = binding.project_root()
                                    && let Some(candidate) = item.mcp.as_mut()
                                {
                                    candidate.config.policy.workspace =
                                        Some(project.to_string_lossy().into_owned());
                                }
                            }
                            BatchSource::TransferredConfiguration(binding) => {
                                let project = batch.project_target();
                                binding.validate_settings_scope(project)?;
                                ensure!(
                                    targets.provider.project_binding() == project
                                        && targets.mcp.project_binding() == project,
                                    "migration_wrong_target"
                                );
                                if let (Some(project), Some(candidate)) =
                                    (project, item.mcp.as_mut())
                                {
                                    candidate.config.policy.workspace =
                                        Some(project.root().to_string_lossy().into_owned());
                                }
                            }
                            _ => anyhow::bail!("migration_invalid_batch_resolution"),
                        }
                        settings.push((item.clone(), resolution.clone()));
                    }
                }
            }
            targets.assets.check_context_additions(&contexts)?;
            if !settings.is_empty() || !amendments.is_empty() {
                let private_ids = policy
                    .mcp_credentials
                    .iter()
                    .map(|choice| choice.item_id.as_str())
                    .collect();
                let group = SettingsGroupPlan::prepare_with_private(
                    targets.provider,
                    targets.mcp,
                    &settings,
                    &private_ids,
                    &amendments,
                )?;
                let item_ids = group
                    .steps
                    .iter()
                    .map(|step| step.item().preview.id.clone())
                    .collect::<Vec<_>>();
                for step in &group.steps {
                    if let Some(item) = job
                        .inventory
                        .items
                        .iter_mut()
                        .find(|item| item.preview.id == step.item().preview.id)
                    {
                        *item = step.item().clone();
                    }
                }
                batch.actions.insert(
                    0,
                    BatchAction {
                        action_id: format!("group-{}", uuid::Uuid::new_v4().simple()),
                        item_ids,
                        action: BatchActionKind::Settings { plan: group },
                        status: ItemStatus::Staged,
                        error: None,
                    },
                );
            }
            self.prepare_batch_templates(
                job,
                &mut batch,
                &templates,
                targets,
                policy.reuse_existing,
                &reusable,
            )?;
            self.prepare_batch_credentials(job, &mut batch, policy, targets)?;
            self.prepare_batch_mcp_credentials(job, &mut batch, policy, targets)?;
            for key in &mut job.credential_plans {
                key.atomic_group_id = batch
                    .actions
                    .iter()
                    .find(|action| {
                        action.item_ids.contains(&key.item_id)
                            && matches!(action.action, BatchActionKind::Settings { .. })
                    })
                    .map(|action| action.action_id.clone());
            }
            batch.atomic_credentials = job
                .credential_plans
                .iter()
                .any(|key| key.atomic_group_id.is_some())
                || job
                    .mcp_credential_plans
                    .iter()
                    .any(|key| key.atomic_group_id.is_some());
            job.selected_item_ids = resolutions
                .iter()
                .map(|resolution| resolution.item_id().into())
                .collect();
            batch.plan_id = Some(format!("plan-{}", uuid::Uuid::new_v4().simple()));
            job.batch = Some(batch);
            Ok(true)
        });
        if result.is_err() {
            let _ = self.cleanup_batch_staging(job_id, &staged);
            let _ = self.cleanup_history_reuse_staging(job_id, &history_references, targets);
        }
        result
    }

    fn cleanup_batch_staging(&self, job_id: &str, staged: &[String]) -> Result<()> {
        if staged.is_empty() {
            return Ok(());
        }
        let _lock = self.write_lock()?;
        let job = self.load(job_id)?;
        let referenced = job
            .batch
            .as_ref()
            .map(|batch| {
                batch
                    .actions
                    .iter()
                    .filter_map(|action| match &action.action {
                        BatchActionKind::Asset { plan_id, .. } => Some(plan_id.as_str()),
                        _ => None,
                    })
                    .collect::<BTreeSet<_>>()
            })
            .unwrap_or_default();
        let directory = self.plan_directory(job_id, false)?;
        for id in staged {
            if !referenced.contains(id.as_str()) {
                directory.remove_regular_file(OsStr::new(&asset_file(id)?))?;
            }
        }
        Ok(())
    }

    pub fn run_batch(
        &self,
        job_id: &str,
        plan_id: &str,
        request_id: &str,
        expected_sequence: u64,
        rollback: bool,
        targets: &BatchTargets<'_>,
    ) -> Result<MigrationJob> {
        self.run_batch_controlled(
            BatchExecution {
                job_id,
                plan_id,
                request_id,
                expected_sequence,
                mode: if rollback {
                    BatchRunMode::Rollback
                } else {
                    BatchRunMode::Apply
                },
            },
            targets,
            &mut |_| true,
        )
    }
    pub fn resume_batch(
        &self,
        job_id: &str,
        plan_id: &str,
        request_id: &str,
        expected_sequence: u64,
        targets: &BatchTargets<'_>,
    ) -> Result<MigrationJob> {
        self.run_batch_controlled(
            BatchExecution {
                job_id,
                plan_id,
                request_id,
                expected_sequence,
                mode: BatchRunMode::Resume,
            },
            targets,
            &mut |_| true,
        )
    }
    pub fn run_batch_controlled(
        &self,
        execution: BatchExecution<'_>,
        targets: &BatchTargets<'_>,
        check: &mut dyn FnMut(BatchRunEvent<'_>) -> bool,
    ) -> Result<MigrationJob> {
        let BatchExecution {
            job_id,
            plan_id,
            request_id,
            expected_sequence,
            mode,
        } = execution;
        let rollback = mode == BatchRunMode::Rollback;
        let resuming = mode == BatchRunMode::Resume;
        ensure!(
            opaque_reference(request_id),
            "migration_invalid_request_reference"
        );
        job_file(job_id)?;
        let runner = self.batch_control_runner(job_id)?;
        {
            let _lock = self.batch_write_lock()?;
            let mut job = self.load(job_id)?;
            self.ensure_no_pending_received_preparation(&job)?;
            self.verify_project_targets(&job, targets)?;
            let credentials_pending = Self::batch_credentials_pending(&job, false);
            ensure!(
                !rollback
                    || job
                        .mcp_credential_plans
                        .iter()
                        .all(|key| key.atomic_group_id.is_some()
                            || key.phase == crate::credentials::CredentialPhase::Undone),
                "migration_mcp_private_values_depend_on_import"
            );
            if job
                .batch
                .as_ref()
                .is_some_and(|batch| !batch.credential_plan_ids.is_empty())
            {
                let credential_targets = targets
                    .credentials
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("migration_credential_target_required"))?;
                ensure!(
                    job.credential_plans
                        .iter()
                        .filter(|plan| job
                            .batch
                            .as_ref()
                            .unwrap()
                            .credential_plan_ids
                            .contains(&plan.plan_id))
                        .all(|plan| plan.policy == credential_targets.policy)
                        && job
                            .mcp_credential_plans
                            .iter()
                            .filter(|plan| job
                                .batch
                                .as_ref()
                                .unwrap()
                                .credential_plan_ids
                                .contains(&plan.plan_id))
                            .all(|plan| plan.policy == credential_targets.policy),
                    "migration_credential_storage_policy_changed"
                );
            }
            let batch = job
                .batch
                .as_mut()
                .ok_or_else(|| anyhow::anyhow!("migration_not_a_batch"))?;
            ensure!(
                batch.plan_id.as_deref() == Some(plan_id),
                "migration_unknown_plan"
            );
            ensure!(
                !rollback
                    || !batch.actions.iter().any(|action| {
                        if !matches!(
                            action.status,
                            ItemStatus::Committing | ItemStatus::CommitUnknown
                        ) || matches!(action.action, BatchActionKind::Template { .. })
                        {
                            return false;
                        }
                        if batch.atomic_credentials
                            && (job.credential_plans.iter().any(|key| {
                                key.atomic_group_id.as_deref() == Some(&action.action_id)
                            }) || job.mcp_credential_plans.iter().any(|key| {
                                key.atomic_group_id.as_deref() == Some(&action.action_id)
                            }))
                        {
                            return false;
                        }
                        !job.receipts
                            .iter()
                            .any(|receipt| receipt.operation_id == action.action_id)
                    }),
                "migration_unconfirmed_outcomes_require_reconciliation"
            );
            let kind = if rollback {
                "rollback"
            } else if resuming {
                "resume"
            } else {
                "apply"
            };
            if let Some(previous) = batch.request_kinds.get(request_id) {
                ensure!(previous == kind, "migration_request_conflict");
            }
            let known = batch.request_kinds.contains_key(request_id);
            // A finished request with definite failures is still a finished request. A lost
            // reply must not silently retry failed actions; an explicit new request may do so.
            if known
                && !rollback
                && !credentials_pending
                && job.status == JobStatus::CompletedWithIssues
                && batch.actions.iter().all(|action| {
                    !matches!(
                        action.status,
                        ItemStatus::Committing | ItemStatus::CommitUnknown
                    )
                })
            {
                return Ok(job);
            }
            if rollback && job.status == JobStatus::RolledBack
                || !rollback
                    && !credentials_pending
                    && (job.status == JobStatus::Completed
                        || job.status == JobStatus::CompletedWithIssues
                            && batch.actions.iter().all(|action| {
                                matches!(action.status, ItemStatus::Committed | ItemStatus::Skipped)
                            }))
            {
                return Ok(job);
            }
            if resuming
                && known
                && matches!(
                    job.status,
                    JobStatus::Cancelled | JobStatus::CancelRequested
                )
            {
                return Ok(job);
            }
            ensure!(
                known || job.sequence == expected_sequence,
                "migration_revision_conflict"
            );
            ensure!(
                if rollback {
                    matches!(
                        job.status,
                        JobStatus::Completed
                            | JobStatus::CompletedWithIssues
                            | JobStatus::Cancelled
                            | JobStatus::RollingBack
                            | JobStatus::RollbackConflict
                    ) || (batch.atomic_credentials
                        || batch.actions.iter().any(|action| {
                            matches!(action.action, BatchActionKind::Template { .. })
                        }))
                        && matches!(job.status, JobStatus::Applying | JobStatus::CancelRequested)
                } else {
                    (resuming && job.status == JobStatus::Cancelled)
                        || matches!(
                            job.status,
                            JobStatus::Ready
                                | JobStatus::Applying
                                | JobStatus::CompletedWithIssues
                                | JobStatus::CancelRequested
                        )
                },
                "migration_invalid_transition"
            );
            ensure!(
                batch.execution_request_count() < 256 || known,
                "migration_batch_budget_exceeded"
            );
            batch.request_kinds.insert(request_id.into(), kind.into());
            if rollback {
                job.status = JobStatus::RollingBack;
            } else if job.status != JobStatus::CancelRequested || resuming && !known {
                job.status = JobStatus::Applying;
            }
            bump(&mut job)?;
            self.admit_batch_control(&mut job, plan_id, request_id, mode, &runner, &_lock)?;
            self.save(&job)?;
        }
        if rollback {
            self.undo_templates_first(job_id, targets)?;
            self.run_batch_credentials(job_id, true, targets)?;
        }
        let count = self.read(job_id)?.batch.as_ref().unwrap().actions.len();
        let mut parallel_until = 0;
        for offset in 0..count {
            if offset < parallel_until {
                continue;
            }
            if !rollback {
                let current = self.read(job_id)?;
                let actions = &current.batch.as_ref().unwrap().actions;
                let end = actions[offset..]
                    .iter()
                    .take_while(|action| matches!(action.action, BatchActionKind::History { .. }))
                    .count()
                    + offset;
                if end > offset + 1 && current.status == JobStatus::Applying {
                    self.run_parallel_history(job_id, offset..end, targets, resuming, check)?;
                    parallel_until = end;
                    continue;
                }
            }
            let index = if rollback { count - 1 - offset } else { offset };
            let (job, action) = {
                let _lock = self.batch_write_lock()?;
                let mut job = self.load(job_id)?;
                #[cfg(test)]
                tests::record_cancelled_action_load(job.status == JobStatus::CancelRequested);
                if !rollback && job.status == JobStatus::Cancelled {
                    break;
                }
                let action = job.batch.as_ref().unwrap().actions[index].clone();
                if rollback && matches!(action.action, BatchActionKind::Template { .. }) {
                    continue;
                }
                if if rollback {
                    action.status == ItemStatus::RolledBack
                        || !Self::is_atomic_action(&job, &action)
                            && !matches!(action.action, BatchActionKind::Template { .. })
                            && !job
                                .receipts
                                .iter()
                                .any(|receipt| receipt.operation_id == action.action_id)
                } else {
                    matches!(action.status, ItemStatus::Committed | ItemStatus::Skipped)
                } {
                    continue;
                }
                if !rollback
                    && job.status == JobStatus::CancelRequested
                    && !matches!(
                        action.status,
                        ItemStatus::Committing | ItemStatus::CommitUnknown
                    )
                {
                    if !job.batch.as_ref().unwrap().actions[index + 1..]
                        .iter()
                        .any(|pending| {
                            matches!(
                                pending.status,
                                ItemStatus::Committing | ItemStatus::CommitUnknown
                            )
                        })
                    {
                        break;
                    }
                    continue;
                }
                let blocked = action.item_ids.iter().any(|id| {
                    job.inventory
                        .items
                        .iter()
                        .find(|item| &item.preview.id == id)
                        .is_none_or(|item| {
                            job.batch
                                .as_ref()
                                .unwrap()
                                .source_for(id)
                                .map_or(true, |source| !source.unchanged(item))
                        })
                });
                if !rollback
                    && blocked
                    && !matches!(
                        action.status,
                        ItemStatus::Committing | ItemStatus::CommitUnknown
                    )
                {
                    set_action(
                        &mut job,
                        index,
                        ItemStatus::Failed,
                        Some("migration_source_changed".into()),
                    );
                    bump(&mut job)?;
                    self.save(&job)?;
                    continue;
                }
                set_action(
                    &mut job,
                    index,
                    if rollback {
                        action.status
                    } else {
                        ItemStatus::Committing
                    },
                    None,
                );
                bump(&mut job)?;
                self.save(&job)?;
                (job, action)
            };
            ensure!(
                check(BatchRunEvent::Action {
                    action_id: &action.action_id,
                    index: offset,
                    total: count
                }),
                "migration_batch_worker_stopped"
            );
            let outcome = if rollback {
                self.undo_batch_action_controlled(&job, &action, targets, check)
                    .map(|_| None)
            } else {
                self.publish_batch_action(&job, &action, targets, resuming, check)
                    .map(Some)
            };
            #[cfg(test)]
            if !rollback
                && (matches!(action.action, BatchActionKind::Template { .. })
                    || matches!(&action.action, BatchActionKind::Reuse { proof } if proof.dependency_action_id.is_some()))
                && outcome.is_ok()
                && FAIL_AFTER_TEMPLATE_PUBLICATION.with(|fail| fail.replace(false))
            {
                anyhow::bail!("migration_injected_lost_template_receipt");
            }
            #[cfg(test)]
            if outcome.is_ok() && FAIL_AFTER_PUBLICATION.with(|fail| fail.replace(false)) {
                anyhow::bail!("migration_injected_lost_batch_receipt");
            }
            let _lock = self.batch_write_lock()?;
            let mut current = self.load(job_id)?;
            match outcome {
                Ok(receipt) => {
                    if let Some(receipt) = receipt {
                        current.receipts.push(receipt);
                    }
                    if !rollback {
                        self.record_history_diagnostics(&mut current, &action, targets)?;
                    }
                    set_action(
                        &mut current,
                        index,
                        if rollback {
                            ItemStatus::RolledBack
                        } else if matches!(action.action, BatchActionKind::Reuse { .. }) {
                            ItemStatus::Skipped
                        } else {
                            ItemStatus::Committed
                        },
                        None,
                    );
                }
                Err(error) => {
                    let code = safe_code(&error);
                    set_action(
                        &mut current,
                        index,
                        if rollback
                            && (Self::atomic_conflict(&code)
                                || matches!(
                                    code.as_str(),
                                    "migration_target_changed"
                                        | "migration_rollback_ownership_unknown"
                                        | "migration_wrong_target"
                                        | "migration_result_referenced"
                                        | "migration_history_rollback_requires_retirement"
                                        | "migration_history_retirement_retained"
                                        | "migration_provider_credentials_depend_on_import"
                                        | "migration_plugin_target_changed"
                                        | "migration_plugin_user_policy_changed"
                                        | "migration_plugin_in_use"
                                        | "migration_plugin_output_missing"
                                        | "migration_plugin_reference_changed"
                                ))
                        {
                            ItemStatus::RollbackConflict
                        } else if !rollback
                            && (matches!(action.action, BatchActionKind::Reuse { .. })
                                || matches!(
                                    code.as_str(),
                                    "migration_history_resource_admission_failed"
                                        | "migration_atomic_staging_pending"
                                        | "migration_atomic_staging_cancelled"
                                        | "migration_credential_group_aborted_replan_required"
                                ))
                        {
                            ItemStatus::Failed
                        } else {
                            ItemStatus::CommitUnknown
                        },
                        Some(code),
                    );
                }
            }
            bump(&mut current)?;
            self.save(&current)?;
        }
        ensure!(
            check(BatchRunEvent::Checkpoint),
            "migration_batch_worker_stopped"
        );
        if !rollback {
            self.run_batch_credentials(job_id, false, targets)?;
        }
        let _lock = self.batch_write_lock()?;
        let mut job = self.load(job_id)?;
        let actions = &job.batch.as_ref().unwrap().actions;
        let credentials_pending = Self::batch_credentials_pending(&job, rollback);
        job.status = if rollback {
            if actions
                .iter()
                .any(|action| action.status == ItemStatus::CommitUnknown)
                || credentials_pending && Self::batch_credentials_unknown(&job)
            {
                JobStatus::RollingBack
            } else if actions
                .iter()
                .any(|action| action.status == ItemStatus::RollbackConflict)
                || credentials_pending
            {
                JobStatus::RollbackConflict
            } else {
                JobStatus::RolledBack
            }
        } else if matches!(
            job.status,
            JobStatus::Cancelled | JobStatus::CancelRequested
        ) {
            JobStatus::Cancelled
        } else if actions
            .iter()
            .any(|action| !matches!(action.status, ItemStatus::Committed | ItemStatus::Skipped))
            || credentials_pending
            || job.inventory.items.iter().any(|item| {
                job.selected_item_ids.contains(&item.preview.id)
                    && item.preview.issues.iter().any(|issue| {
                        issue.severity == kcoder_types::migration::MigrationIssueSeverity::Blocking
                            || item.preview.category
                                == kcoder_types::migration::MigrationCategory::History
                                && issue.severity
                                    == kcoder_types::migration::MigrationIssueSeverity::Warning
                    })
            })
        {
            JobStatus::CompletedWithIssues
        } else {
            JobStatus::Completed
        };
        bump(&mut job)?;
        self.save(&job)?;
        Ok(job)
    }

    fn publish_batch_action(
        &self,
        job: &MigrationJob,
        action: &BatchAction,
        targets: &BatchTargets<'_>,
        resuming: bool,
        check: &mut dyn FnMut(BatchRunEvent<'_>) -> bool,
    ) -> Result<ItemCommitReceipt> {
        let batch = job.batch.as_ref().unwrap();
        let blocked = action.item_ids.iter().any(|id| {
            job.inventory
                .items
                .iter()
                .find(|item| &item.preview.id == id)
                .is_none_or(|item| {
                    batch
                        .source_for(id)
                        .map_or(true, |source| !source.unchanged(item))
                })
        });
        let cancelled = job.status == JobStatus::CancelRequested;
        let publication = if Self::is_atomic_action(job, action) {
            self.publish_atomic_action(job, action, targets, blocked)?
        } else {
            match &action.action {
                BatchActionKind::Project { plan } => {
                    self.publish_project_batch_action(job, action, plan, check)?
                }
                BatchActionKind::Plugin { plan } => {
                    self.publish_plugin_batch_action(job, action, plan, check)?
                }
                BatchActionKind::History { plan } => {
                    self.publish_history_batch_action(job, action, plan, targets, resuming, check)?
                }
                BatchActionKind::Reuse { proof } => {
                    // A persisted reference intent already protects its origin. Reconciliation
                    // only observes that origin; it never copies or republishes source content.
                    let reconciling = matches!(
                        action.status,
                        ItemStatus::Committing | ItemStatus::CommitUnknown
                    );
                    ensure!(!cancelled || reconciling, "migration_cancelled_reference");
                    ensure!(!blocked || reconciling, "migration_source_changed");
                    if let Some(dependency) = &proof.dependency_action_id {
                        ensure!(
                            batch
                                .actions
                                .iter()
                                .any(|action| &action.action_id == dependency
                                    && matches!(
                                        action.status,
                                        ItemStatus::Committed | ItemStatus::Skipped
                                    )),
                            "migration_template_dependency_pending"
                        );
                    }
                    self.verify_history_reuse(&job.job_id, &action.action_id, proof, targets)?;
                    self.observe_reuse(proof, targets)?;
                    crate::providers::ProviderPublication {
                        target_id: format!("reuse-{}", proof.job_id),
                        target_revision: proof.fingerprint.clone(),
                        ownership_confirmed: false,
                    }
                }
                BatchActionKind::Settings { plan } => plan.publish(
                    targets.provider,
                    targets.mcp,
                    cancelled,
                    blocked,
                    matches!(
                        action.status,
                        ItemStatus::Committing | ItemStatus::CommitUnknown
                    ),
                )?,
                BatchActionKind::Asset { plan_id, .. } => targets.assets.publish(
                    &self.load_batch_asset(&job.job_id, plan_id)?,
                    cancelled,
                    blocked,
                )?,
                BatchActionKind::Template { plan } => {
                    ensure!(
                        batch.actions.iter().any(|dependency| dependency.action_id
                            == plan.provider.action_id
                            && matches!(
                                dependency.status,
                                ItemStatus::Committed | ItemStatus::Skipped
                            )),
                        "migration_template_dependency_pending"
                    );
                    targets.provider.templates()?.publish(
                        plan,
                        cancelled,
                        blocked,
                        matches!(
                            action.status,
                            ItemStatus::Committing | ItemStatus::CommitUnknown
                        ),
                    )?
                }
            }
        };
        Ok(ItemCommitReceipt {
            item_id: action.item_ids[0].clone(),
            operation_id: action.action_id.clone(),
            target_id: publication.target_id,
            target_revision: publication.target_revision,
            ownership_confirmed: publication.ownership_confirmed,
        })
    }
    pub(super) fn undo_batch_action(
        &self,
        job: &MigrationJob,
        action: &BatchAction,
        targets: &BatchTargets<'_>,
    ) -> Result<()> {
        self.undo_batch_action_controlled(job, action, targets, &mut |_| true)
    }
    fn undo_batch_action_controlled(
        &self,
        job: &MigrationJob,
        action: &BatchAction,
        targets: &BatchTargets<'_>,
        check: &mut dyn FnMut(BatchRunEvent<'_>) -> bool,
    ) -> Result<()> {
        if Self::is_atomic_action(job, action) {
            return self.undo_atomic_action(job, action, targets);
        }
        if let BatchActionKind::Reuse { proof } = &action.action {
            return self.release_history_reuse(&job.job_id, &action.action_id, proof, targets);
        }
        {
            let _lock = self.write_lock()?;
            self.require_unreferenced(&job.job_id, &action.action_id)?;
        }
        if let BatchActionKind::History { plan } = &action.action {
            return self.undo_history_batch_action(job, action, plan, targets, check);
        }
        if let BatchActionKind::Template { plan } = &action.action {
            return targets.provider.templates()?.rollback(plan);
        }
        let receipt = job
            .receipts
            .iter()
            .find(|receipt| receipt.operation_id == action.action_id)
            .ok_or_else(|| anyhow::anyhow!("migration_commit_receipt_required"))?;
        let native = matches!(
            action.action,
            BatchActionKind::Asset {
                native_reference: true,
                ..
            }
        );
        ensure!(
            receipt.ownership_confirmed || native,
            "migration_rollback_ownership_unknown"
        );
        match &action.action {
            BatchActionKind::Project { plan } => self.undo_project_batch_action(plan, receipt),
            BatchActionKind::Plugin { plan } => {
                self.undo_plugin_batch_action(job, action, plan, check)
            }
            BatchActionKind::History { .. } => {
                anyhow::bail!("migration_history_rollback_requires_retirement")
            }
            BatchActionKind::Template { plan } => targets.provider.templates()?.rollback(plan),
            BatchActionKind::Reuse { .. } => Ok(()),
            BatchActionKind::Settings { plan } => plan.rollback(targets.provider, targets.mcp),
            BatchActionKind::Asset { plan_id, .. } => targets
                .assets
                .rollback(&self.load_batch_asset(&job.job_id, plan_id)?),
        }
    }
    fn plan_directory(&self, job_id: &str, create: bool) -> Result<PrivateDirectory> {
        job_file(job_id)?;
        let name = format!("{job_id}.plans");
        let directory = match self.directory.open_child(OsStr::new(&name), false) {
            Ok(directory) => directory,
            Err(error)
                if create
                    && error.chain().any(|error| {
                        error
                            .downcast_ref::<std::io::Error>()
                            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                    }) =>
            {
                self.directory.create_private_child(OsStr::new(&name))?
            }
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        Ok(directory)
    }
    fn save_batch_asset(&self, job_id: &str, plan: &AssetPlan) -> Result<()> {
        let bytes = serde_json::to_vec(plan)?;
        ensure!(
            bytes.len() as u64 <= MAX_JOURNAL_BYTES,
            "migration_asset_budget_exceeded"
        );
        self.plan_directory(job_id, true)?
            .atomic_replace(OsStr::new(&asset_file(plan.id())?), &bytes)
    }
    pub(super) fn load_batch_asset(&self, job_id: &str, plan_id: &str) -> Result<AssetPlan> {
        let file = self
            .plan_directory(job_id, false)?
            .open_single_link_regular_file(OsStr::new(&asset_file(plan_id)?))?;
        ensure!(
            file.metadata()?.len() <= MAX_JOURNAL_BYTES,
            "migration_asset_budget_exceeded"
        );
        let mut bytes = Vec::new();
        file.take(MAX_JOURNAL_BYTES + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= MAX_JOURNAL_BYTES,
            "migration_asset_budget_exceeded"
        );
        let plan: AssetPlan = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("migration_invalid_journal"))?;
        ensure!(plan.id() == plan_id, "migration_plan_changed");
        Ok(plan)
    }
}
fn asset_file(id: &str) -> Result<String> {
    ensure!(
        id.len() == 37
            && id.starts_with("plan-")
            && id[5..].bytes().all(|byte| byte.is_ascii_hexdigit()),
        "migration_invalid_plan_reference"
    );
    Ok(format!("{id}.json"))
}
pub(super) fn set_action(
    job: &mut MigrationJob,
    index: usize,
    status: ItemStatus,
    error: Option<String>,
) {
    let action = &mut job.batch.as_mut().unwrap().actions[index];
    action.status = status;
    action.error = error;
    for item in &mut job.inventory.items {
        if action.item_ids.contains(&item.preview.id) {
            item.preview.status = status;
        }
    }
}
pub(super) fn bump(job: &mut MigrationJob) -> Result<()> {
    job.sequence = job
        .sequence
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("migration_sequence_exhausted"))?;
    Ok(())
}
pub(super) fn safe_code(error: &anyhow::Error) -> String {
    let code = error.to_string();
    if code.starts_with("migration_")
        && code.len() < 128
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        code
    } else {
        "migration_operation_unconfirmed".into()
    }
}

#[cfg(test)]
mod tests;
