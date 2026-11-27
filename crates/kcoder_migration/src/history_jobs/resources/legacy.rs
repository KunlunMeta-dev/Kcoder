//! Legacy readers can inherit an already-proven original group without creating any metadata.
use super::super::*;
use kcoder_state::external_history::lifecycle::resource_budget::ResourceBudgetRecipe;

impl HistoryJobStore {
    pub(super) fn known_legacy_resource_budget(
        &self,
        job: &Job,
    ) -> Result<Option<ResourceBudgetRecipe>> {
        ensure!(
            !self.has_resource_birth(&job.view.job_id)?,
            "history_resource_preparation_unknown"
        );
        if let Some(parent) = self.original_resource_parent(job)? {
            let recipe = self.recorded_batch_resource_budget(&parent.owner, parent.members)?;
            if let Some(mut recipe) = recipe {
                if let Some(initial) = parent.initial_limits {
                    ensure!(
                        initial == recipe.initial_limits,
                        "history_resource_binding_changed"
                    );
                }
                recipe.member = job.view.job_id.clone();
                return Ok(Some(recipe));
            }
            ensure!(
                parent.initial_limits.is_none(),
                "history_resource_ledger_missing"
            );
            ensure!(
                !self.has_parent_resource_intent(&parent.owner)?,
                "history_resource_parent_preparation_unknown"
            );
            return Ok(None);
        }
        let recipe = self
            .archives
            .recorded_member_resource_budget(&job.view.job_id)?;
        if let Some(recipe) = &recipe {
            ensure!(
                recipe.owner == job.view.job_id && recipe.members == [job.view.job_id.clone()],
                "history_resource_parent_unknown"
            );
        }
        Ok(recipe)
    }
}
