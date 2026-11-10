//! Explicit native upgrades bind existing operations without granting collection authority.
use super::*;

#[derive(Clone)]
pub struct ResourceBudgetRecipe {
    pub reference: ResourceBudgetReference,
    pub member: String,
    pub owner: String,
    pub members: Vec<String>,
    pub initial_limits: MigrationResourceLimits,
}

impl Group {
    fn recipe(&self, member: &str) -> ResourceBudgetRecipe {
        ResourceBudgetRecipe {
            reference: self.reference().clone(),
            member: member.into(),
            owner: self.reference().owner.clone(),
            members: self.member_ids().to_vec(),
            initial_limits: self.baseline_limits().clone(),
        }
    }
}

impl crate::external_history::ExternalHistoryStore {
    /// Resolve only an already-born immutable member, before its archive is allocated.
    pub fn recorded_member_resource_budget(
        &self,
        operation: &str,
    ) -> Result<Option<ResourceBudgetRecipe>> {
        operation_id(operation)?;
        let Some(catalog) = Catalog::open_readonly(&self.directory)? else {
            return Ok(None);
        };
        Ok(catalog
            .document
            .resource_groups
            .values()
            .find(|group| group.contains_member(operation))
            .map(|group| group.recipe(operation)))
    }

    /// Observe the physical allocation's original charging recipe, including reuse aliases.
    pub fn recorded_archive_resource_budget(
        &self,
        operation: &str,
    ) -> Result<Option<ResourceBudgetRecipe>> {
        operation_id(operation)?;
        let Some(catalog) = Catalog::open_readonly(&self.directory)? else {
            return Ok(None);
        };
        let Some(request) = catalog.document.requests.get(&hash(&operation)?) else {
            return Ok(None);
        };
        let archive = catalog
            .document
            .archives
            .get(&request.archive)
            .context("external_history_lifecycle_changed")?;
        let Some((id, _, _)) = catalog.resource_owner_for_archive(archive)? else {
            return Ok(None);
        };
        Ok(Some(
            catalog.document.resource_groups[&id].recipe(&archive.creator),
        ))
    }

    /// The native domain retains the original owning execution authority and frozen member set.
    /// Existing bytes stay in their original archive; this never grants deletion eligibility.
    pub fn adopt_existing_resource_budget(
        &self,
        owner: &str,
        members: Vec<String>,
        limits: MigrationResourceLimits,
    ) -> Result<ResourceBudgetReference> {
        let mut catalog =
            Catalog::open(&self.directory, true)?.context("history_resource_ledger_missing")?;
        let group = Group::new(&catalog.scope(), owner, members, limits)?;
        let reference = group.reference().clone();
        if let Some(existing) = catalog.document.resource_groups.get(&reference.group) {
            existing.require(&reference)?;
            return Ok(reference);
        }
        ensure!(
            !catalog
                .document
                .resource_groups
                .values()
                .any(|existing| existing.overlaps_members(&group)),
            "history_resource_member_already_bound"
        );
        ensure!(
            catalog.document.resource_groups.len() < MAX_ARCHIVES,
            "history_resource_metadata_budget_exceeded"
        );
        for request in catalog
            .document
            .requests
            .values()
            .filter(|request| group.contains_member(&request.operation))
        {
            let archive = catalog
                .document
                .archives
                .get(&request.archive)
                .context("external_history_lifecycle_changed")?;
            if !group.contains_member(&archive.creator) {
                // A reuse alias can own new derived writes; it never reassigns raw allocation.
                catalog.resource_owner_for_archive(archive)?;
                continue;
            }
            ensure!(
                archive.resource_budget.is_none(),
                "history_resource_ledger_missing"
            );
        }
        for archive in catalog
            .document
            .archives
            .values_mut()
            .filter(|archive| group.contains_member(&archive.creator))
        {
            ensure!(
                archive.resource_budget.is_none(),
                "history_resource_ledger_missing"
            );
            archive.resource_budget = Some(reference.clone());
        }
        catalog
            .document
            .resource_groups
            .insert(reference.group.clone(), group);
        catalog.save()?;
        Ok(reference)
    }
}
