//! Explicit quota increases preserve the original owner, reservations and baseline binding.
use super::*;

const MAX_POLICY_CHANGES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourcePolicyReceipt {
    pub request_id: String,
    pub previous_revision: u64,
    pub revision: u64,
    pub limits: MigrationResourceLimits,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourcePolicyObservation {
    pub revision: u64,
    pub limits: MigrationResourceLimits,
}

fn raised(previous: &MigrationResourceLimits, next: &MigrationResourceLimits) -> Result<()> {
    validate_limits(next)?;
    ensure!(
        next.max_total_bytes >= previous.max_total_bytes
            && next.max_payload_files >= previous.max_payload_files
            && next.min_free_bytes == previous.min_free_bytes
            && next.min_free_file_nodes == previous.min_free_file_nodes
            && next != previous,
        "history_resource_policy_not_an_increase"
    );
    Ok(())
}

impl Group {
    pub(in crate::external_history::lifecycle::resource_budget) fn policy_receipt(
        &self,
        request_id: &str,
    ) -> Result<Option<ResourcePolicyReceipt>> {
        operation_id(request_id)?;
        Ok(self
            .policy_changes
            .iter()
            .find(|change| change.request_id == request_id)
            .cloned())
    }

    pub(in crate::external_history::lifecycle::resource_budget) fn effective_limits(
        &self,
    ) -> &MigrationResourceLimits {
        self.policy_changes
            .last()
            .map_or(&self.limits, |change| &change.limits)
    }

    pub(in crate::external_history::lifecycle::resource_budget) fn policy(
        &self,
    ) -> ResourcePolicyObservation {
        ResourcePolicyObservation {
            revision: self.policy_changes.len() as u64,
            limits: self.effective_limits().clone(),
        }
    }

    pub(super) fn validate_policy(&self) -> Result<()> {
        ensure!(
            self.policy_changes.len() <= MAX_POLICY_CHANGES,
            "history_resource_policy_budget_exceeded"
        );
        let mut previous = &self.limits;
        let mut seen = std::collections::BTreeSet::new();
        for (index, change) in self.policy_changes.iter().enumerate() {
            operation_id(&change.request_id)?;
            ensure!(
                change.previous_revision == index as u64
                    && change.revision == index as u64 + 1
                    && seen.insert(&change.request_id),
                "history_resource_policy_changed"
            );
            raised(previous, &change.limits)?;
            previous = &change.limits;
        }
        Ok(())
    }

    pub(in crate::external_history::lifecycle::resource_budget) fn raise_policy(
        &mut self,
        request_id: &str,
        expected_revision: u64,
        limits: MigrationResourceLimits,
    ) -> Result<(ResourcePolicyReceipt, bool)> {
        operation_id(request_id)?;
        if let Some(previous) = self
            .policy_changes
            .iter()
            .find(|c| c.request_id == request_id)
        {
            ensure!(
                previous.previous_revision == expected_revision && previous.limits == limits,
                "history_resource_policy_request_changed"
            );
            return Ok((previous.clone(), false));
        }
        ensure!(
            expected_revision == self.policy_changes.len() as u64,
            "history_resource_policy_revision_changed"
        );
        ensure!(
            self.policy_changes.len() < MAX_POLICY_CHANGES,
            "history_resource_policy_budget_exceeded"
        );
        raised(self.effective_limits(), &limits)?;
        let receipt = ResourcePolicyReceipt {
            request_id: request_id.into(),
            previous_revision: expected_revision,
            revision: expected_revision + 1,
            limits,
        };
        self.policy_changes.push(receipt.clone());
        Ok((receipt, true))
    }
}
