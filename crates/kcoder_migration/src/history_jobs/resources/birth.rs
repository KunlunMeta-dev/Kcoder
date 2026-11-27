//! A quota intent is durable before its first accounting-group mutation or payload allocation.
use super::super::*;
use kcoder_state::external_history::lifecycle::resource_budget::{
    ResourceBudgetRecipe, ResourceBudgetReference,
};
use kcoder_types::migration_resource::MigrationResourceLimits;

const MAX_BIRTH_BYTES: u64 = 8192;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(in crate::history_jobs) enum HistoryBudgetStorage {
    Managed,
    Legacy,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::history_jobs) struct HistoryResourceBinding {
    pub reference: ResourceBudgetReference,
    pub owner: String,
    pub members: Vec<String>,
    pub member: String,
    pub initial_limits: MigrationResourceLimits,
    pub birth_sha256: String,
    pub storage: HistoryBudgetStorage,
    pub upgrade_sequence: Option<u64>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum BirthOutcome {
    Pending,
    Bound { reference: ResourceBudgetReference },
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BudgetBirth {
    pub(super) version: u32,
    pub(super) owner: String,
    pub(super) job_id: String,
    pub(super) source_identity: String,
    pub(super) resource_owner: String,
    pub(super) members: Vec<String>,
    pub(super) member: String,
    pub(super) upgrade_sequence: Option<u64>,
    pub(super) initial_limits: MigrationResourceLimits,
    pub(super) storage: HistoryBudgetStorage,
    pub(super) outcome: BirthOutcome,
}

fn name(job_id: &str) -> String {
    format!("{job_id}.resource.birth")
}
fn digest(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

impl HistoryJobStore {
    pub(super) fn resource_birth(&self, job_id: &str) -> Result<Option<BudgetBirth>> {
        let Some(bytes) = self.read_optional(&name(job_id), MAX_BIRTH_BYTES)? else {
            return Ok(None);
        };
        let birth: BudgetBirth = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("history_resource_birth_unknown"))?;
        ensure!(
            birth.version == 1
                && birth.owner == self.owner
                && birth.job_id == job_id
                && birth.source_identity.len() == 64
                && birth
                    .source_identity
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                && birth.initial_limits.is_supported(),
            "history_resource_birth_unknown"
        );
        Ok(Some(birth))
    }

    pub(in crate::history_jobs) fn has_resource_birth(&self, job_id: &str) -> Result<bool> {
        Ok(self.resource_birth(job_id)?.is_some())
    }

    fn save_resource_birth(&self, birth: &BudgetBirth) -> Result<()> {
        let bytes = serde_json::to_vec(birth)?;
        ensure!(
            bytes.len() as u64 <= MAX_BIRTH_BYTES,
            "history_resource_metadata_budget_exceeded"
        );
        self.directory
            .atomic_replace(OsStr::new(&name(&birth.job_id)), &bytes)
    }

    /// The caller retains the original job catalog/execution lease. No source is refreshed here.
    pub(in crate::history_jobs) fn birth_standalone_resource_budget(
        &self,
        job_id: &str,
        source_identity: &str,
        requested: Option<MigrationResourceLimits>,
        storage: HistoryBudgetStorage,
    ) -> Result<HistoryResourceBinding> {
        valid_id(job_id)?;
        ensure!(
            source_identity.len() == 64
                && source_identity
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "history_resource_invalid_binding"
        );
        self.birth_resource_budget(job_id, source_identity, requested, storage, None, None)
    }

    fn birth_resource_budget(
        &self,
        job_id: &str,
        source_identity: &str,
        requested: Option<MigrationResourceLimits>,
        storage: HistoryBudgetStorage,
        inherited: Option<(&ResourceBudgetRecipe, &str)>,
        upgrade_sequence: Option<u64>,
    ) -> Result<HistoryResourceBinding> {
        let existing = self.resource_birth(job_id)?;
        let fresh = existing.is_none();
        let mut birth = match existing {
            Some(birth) => {
                ensure!(
                    birth.source_identity == source_identity
                        && birth.storage == storage
                        && birth.upgrade_sequence == upgrade_sequence,
                    "history_job_request_conflict"
                );
                if let Some(requested) = requested {
                    ensure!(
                        birth.initial_limits == requested,
                        "history_resource_initial_limits_changed"
                    );
                }
                birth
            }
            None => {
                let mut births = 0;
                self.directory
                    .visit_entry_names_bounded(MAX_JOB_ENTRIES, |entry| {
                        if entry
                            .to_str()
                            .is_some_and(|entry| entry.ends_with(".resource.birth"))
                        {
                            births += 1;
                        }
                        Ok(())
                    })?;
                ensure!(
                    births < MAX_JOBS,
                    "history_resource_metadata_budget_exceeded"
                );
                let limits = inherited
                    .map(|(recipe, _)| recipe.initial_limits.clone())
                    .or(requested)
                    .unwrap_or_default();
                ensure!(limits.is_supported(), "history_resource_invalid_limits");
                let birth = BudgetBirth {
                    version: 1,
                    owner: self.owner.clone(),
                    job_id: job_id.into(),
                    source_identity: source_identity.into(),
                    resource_owner: inherited
                        .map_or(job_id, |(recipe, _)| recipe.owner.as_str())
                        .into(),
                    members: inherited
                        .map_or_else(|| vec![job_id.into()], |(recipe, _)| recipe.members.clone()),
                    member: inherited.map_or(job_id, |(_, member)| member).into(),
                    upgrade_sequence,
                    initial_limits: limits,
                    storage,
                    outcome: inherited.map_or(BirthOutcome::Pending, |(recipe, _)| {
                        BirthOutcome::Bound {
                            reference: recipe.reference.clone(),
                        }
                    }),
                };
                self.save_resource_birth(&birth)?;
                birth
            }
        };
        let reference = match &birth.outcome {
            BirthOutcome::Bound { reference } => {
                let observed = self.archives.recorded_resource_budget_for_plan(
                    &birth.resource_owner,
                    birth.members.clone(),
                    birth.initial_limits.clone(),
                )?;
                ensure!(
                    observed.as_ref() == Some(reference),
                    "history_resource_ledger_missing"
                );
                reference.clone()
            }
            BirthOutcome::Pending => {
                // An existing pending intent is reconciled, never treated as an unused UUID.
                // Missing original evidence remains unknown rather than recreating an empty group.
                let reference = if fresh {
                    if upgrade_sequence.is_some() {
                        self.archives.adopt_existing_resource_budget(
                            &birth.resource_owner,
                            birth.members.clone(),
                            birth.initial_limits.clone(),
                        )?
                    } else {
                        self.archives.prepare_resource_budget(
                            &birth.resource_owner,
                            birth.members.clone(),
                            birth.initial_limits.clone(),
                        )?
                    }
                } else {
                    self.archives
                        .recorded_resource_budget_for_plan(
                            &birth.resource_owner,
                            birth.members.clone(),
                            birth.initial_limits.clone(),
                        )?
                        .context("history_resource_preparation_unknown")?
                };
                birth.outcome = BirthOutcome::Bound {
                    reference: reference.clone(),
                };
                self.save_resource_birth(&birth)?;
                reference
            }
        };
        Ok(HistoryResourceBinding {
            reference,
            owner: birth.resource_owner.clone(),
            members: birth.members.clone(),
            member: birth.member.clone(),
            initial_limits: birth.initial_limits.clone(),
            birth_sha256: digest(&birth)?,
            storage,
            upgrade_sequence: birth.upgrade_sequence,
        })
    }

    pub(in crate::history_jobs) fn upgrade_job_resource_budget(&self, job: &mut Job) -> Result<()> {
        self.upgrade_job_resource_budget_with_limits(job, None)
    }

    pub(in crate::history_jobs) fn upgrade_job_resource_budget_with_limits(
        &self,
        job: &mut Job,
        requested: Option<MigrationResourceLimits>,
    ) -> Result<()> {
        if job.resource_budget.is_some() {
            return self.require_resource_budget_for_write(job);
        }
        ensure!(job.version <= 3, "history_resource_birth_unknown");
        let storage = if job.managed() {
            HistoryBudgetStorage::Managed
        } else {
            HistoryBudgetStorage::Legacy
        };
        let source = job.resource_source_identity()?;
        let pending = self.resource_birth(&job.view.job_id)?;
        let binding = if let Some(pending) = pending {
            self.birth_resource_budget(
                &job.view.job_id,
                &source,
                requested,
                storage,
                None,
                pending.upgrade_sequence,
            )?
        } else if let Some(recipe) = self.known_legacy_resource_budget(job)? {
            // A reuse alias inherits the physical creator's already-born allocation.
            if let Some(requested) = &requested {
                ensure!(
                    *requested == recipe.initial_limits,
                    "history_resource_initial_limits_changed"
                );
            }
            self.birth_resource_budget(
                &job.view.job_id,
                &source,
                requested,
                storage,
                Some((&recipe, &recipe.member)),
                Some(job.view.sequence),
            )?
        } else {
            ensure!(
                self.original_resource_parent(job)?.is_none(),
                "history_resource_parent_required"
            );
            self.birth_resource_budget(
                &job.view.job_id,
                &source,
                requested,
                storage,
                None,
                Some(job.view.sequence),
            )?
        };
        job.resource_budget = Some(binding);
        job.version = 4;
        self.save(job)
    }

    pub(in crate::history_jobs) fn verify_standalone_resource_budget(
        &self,
        job_id: &str,
        source_identity: &str,
        binding: &HistoryResourceBinding,
    ) -> Result<()> {
        let birth = self
            .resource_birth(job_id)?
            .context("history_resource_birth_unknown")?;
        ensure!(
            birth.source_identity == source_identity
                && birth.initial_limits == binding.initial_limits
                && birth.storage == binding.storage
                && birth.resource_owner == binding.owner
                && birth.members == binding.members
                && birth.member == binding.member
                && birth.upgrade_sequence == binding.upgrade_sequence
                && birth.members.contains(&birth.member)
                && birth.outcome
                    == BirthOutcome::Bound {
                        reference: binding.reference.clone(),
                    }
                && digest(&birth)? == binding.birth_sha256,
            "history_resource_binding_changed"
        );
        ensure!(
            self.archives.recorded_resource_budget_for_plan(
                &binding.owner,
                binding.members.clone(),
                birth.initial_limits,
            )? == Some(binding.reference.clone()),
            "history_resource_ledger_missing"
        );
        Ok(())
    }
}
