//! Delivery confirmation records for one business work item.
//!
//! A recorded confirmation is an observation from the original channel owner. It
//! never proves that the action was correct, and an unknown future state or a
//! level below the frozen minimum cannot satisfy completion.

use super::*;
use kcoder_types::continuous_work::{WorkConfirmationLevel, WorkDelivery, WorkDeliveryState};

fn delivery_key(work: &WorkScope, work_id: &str) -> Result<String> {
    let identity = WorkIdentity {
        scope: work.clone(),
        work_id: work_id.into(),
    };
    identity.validate_shape().map_err(anyhow::Error::msg)?;
    work_key(&identity)
}

fn validate_delivery(delivery: &WorkDelivery) -> Result<()> {
    ensure!(
        atom(&delivery.delivery_id),
        "CONTINUOUS_WORK_DELIVERY_UNKNOWN"
    );
    ensure!(
        delivery.state.is_known() && delivery.minimum_confirmation.is_known(),
        "CONTINUOUS_WORK_DELIVERY_STATE_UNKNOWN"
    );
    if delivery.state == WorkDeliveryState::Confirmed {
        let minimum = delivery.minimum_confirmation.confirmation_rank();
        let observed = delivery
            .observed_confirmation
            .as_ref()
            .and_then(WorkConfirmationLevel::confirmation_rank);
        ensure!(
            minimum.is_some() && observed.is_some_and(|rank| rank >= minimum.unwrap_or(u8::MAX)),
            "CONTINUOUS_WORK_DELIVERY_CONFIRMATION_TOO_WEAK"
        );
    }
    Ok(())
}

impl ContinuousWorkStore {
    /// Record one observed delivery state for the exact accepted requirement.
    /// The frozen minimum confirmation cannot be lowered by the caller.
    pub fn record_delivery(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        delivery: WorkDelivery,
    ) -> Result<WorkDelivery> {
        actual_scope.validate_shape().map_err(anyhow::Error::msg)?;
        validate_delivery(&delivery)?;
        let key = delivery_key(actual_scope, work_id)?;
        self.update(|data| {
            let stored = data
                .works
                .get_mut(&key)
                .context("CONTINUOUS_WORK_NOT_FOUND")?;
            let requirement = stored
                .accepted_deliveries
                .iter()
                .find(|requirement| requirement.delivery_id == delivery.delivery_id)
                .cloned()
                .context("CONTINUOUS_WORK_DELIVERY_UNKNOWN")?;
            ensure!(
                requirement.minimum_confirmation == delivery.minimum_confirmation,
                "CONTINUOUS_WORK_DELIVERY_SNAPSHOT_REQUIRED"
            );
            stored
                .deliveries
                .insert(delivery.delivery_id.clone(), delivery.clone());
            Ok((delivery, true))
        })
    }

    /// Observed delivery states in accepted-requirement order.
    pub fn delivery_states(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
    ) -> Result<Vec<WorkDelivery>> {
        actual_scope.validate_shape().map_err(anyhow::Error::msg)?;
        let key = delivery_key(actual_scope, work_id)?;
        self.read(|data| {
            let stored = data.works.get(&key).context("CONTINUOUS_WORK_NOT_FOUND")?;
            let mut values = Vec::with_capacity(stored.deliveries.len());
            for requirement in &stored.accepted_deliveries {
                if let Some(delivery) = stored.deliveries.get(&requirement.delivery_id) {
                    values.push(delivery.clone());
                }
            }
            Ok(values)
        })
    }
}

/// Every accepted requirement must have a confirmed delivery at or above its
/// frozen minimum. A missing record stays pending; it is never assumed.
pub(super) fn required_deliveries_confirmed(stored: &StoredWork) -> Result<()> {
    for requirement in &stored.accepted_deliveries {
        let delivery = stored
            .deliveries
            .get(&requirement.delivery_id)
            .context("CONTINUOUS_WORK_DELIVERY_PENDING")?;
        ensure!(
            delivery.state == WorkDeliveryState::Confirmed,
            "CONTINUOUS_WORK_DELIVERY_PENDING"
        );
        let minimum = requirement
            .minimum_confirmation
            .confirmation_rank()
            .context("CONTINUOUS_WORK_DELIVERY_STATE_UNKNOWN")?;
        let observed = delivery
            .observed_confirmation
            .as_ref()
            .and_then(WorkConfirmationLevel::confirmation_rank)
            .context("CONTINUOUS_WORK_DELIVERY_CONFIRMATION_TOO_WEAK")?;
        ensure!(
            observed >= minimum,
            "CONTINUOUS_WORK_DELIVERY_CONFIRMATION_TOO_WEAK"
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "deliveries.test.rs"]
mod tests;
