//! An explicit legacy-parent budget intent precedes the first State group mutation.
use super::super::*;
use kcoder_state::external_history::lifecycle::resource_budget::ResourceBudgetReference;
use kcoder_types::migration_resource::MigrationResourceLimits;

const MAX_PARENT_INTENT_BYTES: u64 = 32 * 1024;

#[cfg(test)]
thread_local! {
    static LOSE_NEXT_PARENT_GROUP_REPLY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
mod tests;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ParentIntent {
    pub(super) version: u8,
    pub(super) owner: String,
    pub(super) parent: String,
    pub(super) plan: String,
    pub(super) sequence: u64,
    pub(super) limits: MigrationResourceLimits,
    pub(super) sources: Vec<(String, String, String)>,
    pub(super) reference: Option<ResourceBudgetReference>,
}

impl HistoryJobStore {
    /// The caller retains the original parent runner and every child's execution authority.
    pub(crate) fn prepare_parent_resource_budget(
        &self,
        parent: &str,
        plan: &str,
        sequence: u64,
        mut sources: Vec<(String, String, String)>,
        limits: MigrationResourceLimits,
        allow_new: bool,
    ) -> Result<ResourceBudgetReference> {
        ensure!(
            parent.len() == 36
                && parent.starts_with("mig-")
                && parent[4..].bytes().all(|byte| byte.is_ascii_hexdigit()),
            "history_resource_parent_unknown"
        );
        ensure!(limits.is_supported(), "history_resource_invalid_limits");
        sources.sort();
        ensure!(
            !sources.is_empty()
                && sources.len() <= 64
                && !sources.windows(2).any(|pair| pair[0].0 == pair[1].0),
            "history_resource_invalid_members"
        );
        for (id, fingerprint, revision) in &sources {
            valid_id(id)?;
            ensure!(
                fingerprint.len() == 64
                    && fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
                    && !revision.is_empty()
                    && revision.len() <= 128,
                "history_resource_parent_unknown"
            );
        }
        let name = format!("{parent}.resource-parent.birth");
        let mut intent = ParentIntent {
            version: 1,
            owner: self.owner.clone(),
            parent: parent.into(),
            plan: plan.into(),
            sequence,
            limits,
            sources,
            reference: None,
        };
        let previous = self.read_optional(&name, MAX_PARENT_INTENT_BYTES)?;
        let fresh = previous.is_none();
        if let Some(previous) = previous {
            let saved: ParentIntent = serde_json::from_slice(&previous)
                .map_err(|_| anyhow::anyhow!("history_resource_parent_preparation_unknown"))?;
            let mut original = saved.clone();
            original.reference = None;
            ensure!(original == intent, "history_resource_parent_intent_changed");
            intent = saved;
        } else {
            ensure!(allow_new, "history_resource_parent_preparation_unknown");
            let mut count = 0;
            self.directory
                .visit_entry_names_bounded(MAX_JOB_ENTRIES, |name| {
                    if name
                        .to_str()
                        .is_some_and(|name| name.ends_with(".resource-parent.birth"))
                    {
                        count += 1;
                    }
                    Ok(())
                })?;
            ensure!(
                count < MAX_JOBS,
                "history_resource_metadata_budget_exceeded"
            );
            self.save_parent_resource_intent(&name, &intent)?;
        }
        let members = intent
            .sources
            .iter()
            .map(|source| source.0.clone())
            .collect::<Vec<_>>();
        let observed = self.archives.recorded_resource_budget_for_plan(
            parent,
            members.clone(),
            intent.limits.clone(),
        )?;
        let reference = if let Some(reference) = &intent.reference {
            ensure!(
                observed.as_ref() == Some(reference),
                "history_resource_ledger_missing"
            );
            return Ok(reference.clone());
        } else if let Some(observed) = observed {
            observed
        } else {
            ensure!(fresh, "history_resource_parent_preparation_unknown");
            self.archives
                .adopt_existing_resource_budget(parent, members, intent.limits.clone())?
        };
        #[cfg(test)]
        if LOSE_NEXT_PARENT_GROUP_REPLY.with(|flag| flag.replace(false)) {
            anyhow::bail!("history_resource_parent_preparation_unknown");
        }
        intent.reference = Some(reference.clone());
        self.save_parent_resource_intent(&name, &intent)?;
        Ok(reference)
    }

    pub(super) fn parent_resource_intent(&self, parent: &str) -> Result<Option<ParentIntent>> {
        let Some(bytes) = self.read_optional(
            &format!("{parent}.resource-parent.birth"),
            MAX_PARENT_INTENT_BYTES,
        )?
        else {
            return Ok(None);
        };
        let intent: ParentIntent = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("history_resource_parent_preparation_unknown"))?;
        ensure!(
            intent.version == 1
                && intent.owner == self.owner
                && intent.parent == parent
                && !intent.plan.is_empty()
                && intent.plan.len() <= 128
                && intent.limits.is_supported()
                && !intent.sources.is_empty()
                && intent.sources.len() <= 64
                && !intent.sources.windows(2).any(|pair| pair[0].0 >= pair[1].0),
            "history_resource_parent_preparation_unknown"
        );
        for (id, fingerprint, revision) in &intent.sources {
            valid_id(id)?;
            ensure!(
                fingerprint.len() == 64
                    && fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
                    && !revision.is_empty()
                    && revision.len() <= 128,
                "history_resource_parent_preparation_unknown"
            );
        }
        Ok(Some(intent))
    }

    pub(crate) fn has_parent_resource_intent(&self, parent: &str) -> Result<bool> {
        Ok(self
            .read_optional(
                &format!("{parent}.resource-parent.birth"),
                MAX_PARENT_INTENT_BYTES,
            )?
            .is_some())
    }

    fn save_parent_resource_intent(&self, name: &str, intent: &ParentIntent) -> Result<()> {
        let bytes = serde_json::to_vec(intent)?;
        ensure!(
            bytes.len() as u64 <= MAX_PARENT_INTENT_BYTES,
            "history_resource_metadata_budget_exceeded"
        );
        self.directory.atomic_replace(OsStr::new(name), &bytes)
    }
}
