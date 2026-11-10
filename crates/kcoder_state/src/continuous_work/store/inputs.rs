//! Rejection and unknown-outcome states for accepted inputs.
//!
//! A rejected input stays in the record: it is not deleted, not re-queued and it
//! never advances the applied watermark. An input whose outcome could not be
//! observed becomes `NeedsReconciliation` and keeps blocking completion until a
//! host compares it with the original request.

use super::*;
use kcoder_types::continuous_work::WorkInputState;

/// The owning claim offered by the caller. When a claim is active the store
/// refuses an input transition that cannot name it, so one owner cannot cancel or
/// requeue another owner's dispatch.
#[derive(Debug, Clone, Copy)]
pub struct InputAuthority<'a> {
    pub claim_id: &'a str,
    pub owner_epoch: u64,
    pub control_epoch: u64,
}

fn ensure_owner(
    stored: &StoredWork,
    work: &WorkRecord,
    authority: Option<InputAuthority<'_>>,
) -> Result<()> {
    let Some(active) = stored.active_claim.as_deref() else {
        return Ok(());
    };
    let Some(authority) = authority else {
        bail!("CONTINUOUS_WORK_OWNER_CONFLICT");
    };
    let claim = stored
        .claims
        .get(active)
        .context("CONTINUOUS_WORK_CLAIM_NOT_FOUND")?;
    ensure!(
        active == authority.claim_id
            && !claim.released
            && claim.owner_epoch == authority.owner_epoch
            && work.revision.owner_epoch == authority.owner_epoch
            && claim.control_epoch == authority.control_epoch
            && work.revision.control_epoch == authority.control_epoch,
        "CONTINUOUS_WORK_OWNER_CONFLICT"
    );
    Ok(())
}

impl ContinuousWorkStore {
    /// Reject a queued or accepted input that the target will not run. An input
    /// already dispatched into a turn must be settled instead; it cannot be
    /// cancelled here because the model may already have acted on it.
    pub fn reject_input(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        source: &WorkInputSource,
        input_id: &str,
        authority: Option<InputAuthority<'_>>,
    ) -> Result<WorkInputReceipt> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        source.validate()?;
        ensure!(atom(input_id), "CONTINUOUS_WORK_INPUT_INVALID");
        let key = input_key(&identity, source, input_id)?;
        self.update(|data| {
            {
                let stored = data
                    .works
                    .get(&work_key(&identity)?)
                    .context("CONTINUOUS_WORK_NOT_FOUND")?;
                let work = record(stored)?;
                ensure_owner(stored, &work, authority)?;
            }
            let observed = receipt(
                data.inputs
                    .get(&key)
                    .context("CONTINUOUS_WORK_INPUT_NOT_FOUND")?,
            )?;
            // Rejection removes an input from the ordered application chain, so
            // only the last unsettled requirement may be rejected: rejecting a
            // middle one would leave a hole the watermark can never cross.
            if !matches!(observed.state, WorkInputState::Rejected) {
                for candidate in data.inputs.values() {
                    let candidate = receipt(candidate)?;
                    if candidate.work == identity
                        && candidate.sequence > observed.sequence
                        && !matches!(candidate.state, WorkInputState::Rejected)
                    {
                        bail!("CONTINUOUS_WORK_INPUT_REJECT_NOT_TAIL");
                    }
                }
            }
            let input = data
                .inputs
                .get_mut(&key)
                .context("CONTINUOUS_WORK_INPUT_NOT_FOUND")?;
            let mut current = receipt(input)?;
            match current.state {
                WorkInputState::Rejected => return Ok((current, false)),
                WorkInputState::Accepted | WorkInputState::Queued => {}
                WorkInputState::Dispatched | WorkInputState::Applied => {
                    bail!("CONTINUOUS_WORK_INPUT_ALREADY_DISPATCHED")
                }
                _ => bail!("CONTINUOUS_WORK_INPUT_NOT_REJECTABLE"),
            }
            current.state = WorkInputState::Rejected;
            input.receipt = serde_json::to_value(&current)?;
            Ok((current, true))
        })
    }

    /// Return a dispatched input to the queue when the host can prove the turn
    /// never reached the provider. Only a bare dispatch may be requeued: an
    /// applied, rejected or unconfirmed input keeps its recorded outcome so a
    /// transient dispatch failure cannot erase it.
    pub fn requeue_input(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        source: &WorkInputSource,
        input_id: &str,
        authority: Option<InputAuthority<'_>>,
    ) -> Result<WorkInputReceipt> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        source.validate()?;
        ensure!(atom(input_id), "CONTINUOUS_WORK_INPUT_INVALID");
        let key = input_key(&identity, source, input_id)?;
        self.update(|data| {
            {
                let stored = data
                    .works
                    .get(&work_key(&identity)?)
                    .context("CONTINUOUS_WORK_NOT_FOUND")?;
                let work = record(stored)?;
                ensure_owner(stored, &work, authority)?;
            }
            let input = data
                .inputs
                .get_mut(&key)
                .context("CONTINUOUS_WORK_INPUT_NOT_FOUND")?;
            let mut current = receipt(input)?;
            match current.state {
                WorkInputState::Queued => return Ok((current, false)),
                WorkInputState::Dispatched => {}
                _ => bail!("CONTINUOUS_WORK_INPUT_NOT_REQUEUEABLE"),
            }
            current.state = WorkInputState::Queued;
            input.receipt = serde_json::to_value(&current)?;
            Ok((current, true))
        })
    }

    /// Mark an input whose delivery into a turn could not be observed. It is not
    /// a rejection and not an application; completion keeps waiting for a host
    /// that compares it with the original request.
    pub fn mark_input_unconfirmed(
        &self,
        actual_scope: &WorkScope,
        work_id: &str,
        source: &WorkInputSource,
        input_id: &str,
        authority: Option<InputAuthority<'_>>,
    ) -> Result<WorkInputReceipt> {
        let identity = WorkIdentity {
            scope: actual_scope.clone(),
            work_id: work_id.into(),
        };
        identity.validate_shape().map_err(anyhow::Error::msg)?;
        source.validate()?;
        ensure!(atom(input_id), "CONTINUOUS_WORK_INPUT_INVALID");
        let key = input_key(&identity, source, input_id)?;
        self.update(|data| {
            {
                let stored = data
                    .works
                    .get(&work_key(&identity)?)
                    .context("CONTINUOUS_WORK_NOT_FOUND")?;
                let work = record(stored)?;
                ensure_owner(stored, &work, authority)?;
            }
            let input = data
                .inputs
                .get_mut(&key)
                .context("CONTINUOUS_WORK_INPUT_NOT_FOUND")?;
            let mut current = receipt(input)?;
            if matches!(
                current.state,
                WorkInputState::Applied
                    | WorkInputState::Rejected
                    | WorkInputState::NeedsReconciliation
            ) {
                return Ok((current, false));
            }
            current.state = WorkInputState::NeedsReconciliation;
            input.receipt = serde_json::to_value(&current)?;
            Ok((current, true))
        })
    }
}

#[cfg(test)]
#[path = "inputs.test.rs"]
mod tests;
