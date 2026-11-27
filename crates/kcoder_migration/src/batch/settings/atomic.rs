//! Native receipts, not matching JSON, establish ownership of a configuration/key publication.
use super::*;
use crate::store::CredentialTargets;
use kcoder_config::imported_credentials::CredentialGroupOutcome as Outcome;

pub(crate) struct AtomicSettings<'a> {
    pub id: &'a str,
    pub provider: &'a ProviderTarget,
    pub mcp: &'a McpTarget,
    pub keys: &'a CredentialTargets<'a>,
    pub plans: &'a [AtomicCredential],
}
impl SettingsGroupPlan {
    pub(crate) fn publish_atomic(
        &self,
        context: &AtomicSettings<'_>,
        cancelled: bool,
        blocked: bool,
    ) -> Result<ProviderPublication> {
        self.check(context.provider, context.mcp)?;
        ensure!(
            context.keys.target.directory_identity()? == context.provider.directory_identity()?,
            "migration_wrong_target"
        );
        let references = context
            .plans
            .iter()
            .map(|plan| plan.reference().clone())
            .collect::<Vec<_>>();
        if let Some(receipt) = context.keys.target.group_receipt(context.id)? {
            ensure!(
                self.steps[0].before().strip_prefix("sha256-")
                    == Some(receipt.before_revision.as_str())
                    && self.steps.last().unwrap().after().strip_prefix("sha256-")
                        == Some(receipt.after_revision.as_str()),
                "migration_credential_group_receipt_conflict"
            );
            ensure!(
                receipt.references == references,
                "migration_credential_group_receipt_conflict"
            );
            ensure!(
                receipt.outcome == Outcome::Committed,
                "migration_credential_group_aborted_replan_required"
            );
            context
                .keys
                .target
                .verify_group(context.id, context.keys.backend)?;
            return Ok(self.atomic_publication());
        }
        ensure!(!cancelled, "migration_cancelled_unsettled_publication");
        ensure!(!blocked, "migration_source_changed");
        context.keys.target.publish_group(
            context.id,
            &references,
            context.keys.backend,
            |current, occupied| {
                ensure!(
                    revision(current) == self.steps[0].before(),
                    "migration_target_changed"
                );
                for step in &self.steps {
                    match step {
                        SettingsStep::Provider(plan) => {
                            ensure!(
                                context
                                    .plans
                                    .iter()
                                    .any(|key| key.provider_named(plan.target_name()))
                                    || !occupied.contains(plan.target_name()),
                                "migration_existing_credentials_require_confirmation"
                            );
                        }
                        SettingsStep::Mcp(plan) if plan.enabled() => {
                            if let Some(AtomicCredential::Mcp(key)) = context
                                .plans
                                .iter()
                                .find(|key| key.item_id() == plan.item().preview.id)
                            {
                                key.validate_activation()?;
                            } else {
                                kcoder_mcp_policy::validate_references(plan.config()).map_err(
                                    |_| anyhow::anyhow!("migration_mcp_credentials_required"),
                                )?;
                            }
                        }
                        _ => {}
                    }
                    step.insert(current)?;
                }
                Ok(())
            },
        )?;
        Ok(self.atomic_publication())
    }

    pub(crate) fn undo_atomic(&self, context: &AtomicSettings<'_>) -> Result<()> {
        self.check(context.provider, context.mcp)?;
        ensure!(
            context.keys.target.directory_identity()? == context.provider.directory_identity()?,
            "migration_wrong_target"
        );
        if let Some(receipt) = context.keys.target.group_receipt(context.id)? {
            ensure!(
                self.steps[0].before().strip_prefix("sha256-")
                    == Some(receipt.before_revision.as_str())
                    && self.steps.last().unwrap().after().strip_prefix("sha256-")
                        == Some(receipt.after_revision.as_str()),
                "migration_credential_group_receipt_conflict"
            );
            ensure!(
                receipt.references
                    == context
                        .plans
                        .iter()
                        .map(|plan| plan.reference().clone())
                        .collect::<Vec<_>>(),
                "migration_credential_group_receipt_conflict"
            );
            if receipt.outcome == Outcome::Committed {
                let names = self
                    .steps
                    .iter()
                    .filter_map(|step| match step {
                        SettingsStep::Provider(plan) => Some(plan.target_name()),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                context
                    .provider
                    .template_dependencies()
                    .with_unreferenced_providers(&names, || {
                        context.keys.target.undo_group(
                            context.id,
                            context.keys.backend,
                            |current| {
                                ensure!(
                                    revision(current) == self.steps.last().unwrap().after(),
                                    "migration_target_changed"
                                );
                                for step in self.steps.iter().rev() {
                                    step.remove(current)?;
                                }
                                Ok(())
                            },
                        )
                    })?;
            }
        }
        Ok(())
    }

    fn atomic_publication(&self) -> ProviderPublication {
        let target_id = match &self.steps[0] {
            SettingsStep::Provider(plan) => plan.target_id.clone(),
            SettingsStep::Mcp(plan) => plan.target_id.clone(),
        };
        ProviderPublication {
            target_id,
            target_revision: self.steps.last().unwrap().after().into(),
            ownership_confirmed: true,
        }
    }
}
