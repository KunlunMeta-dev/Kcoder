//! Durable admission accounting, scoped by the actual Native profile owner.
use super::*;
use kcoder_types::cross_session_messages::MAX_AGENT_MESSAGE_TEXT_BYTES;

const WINDOW_MS: u64 = 60_000;
const MAX_CHARGES: usize = 256;

/// Captured from current user policy by the host; never accepted from a model.
#[derive(Debug, Clone, Copy)]
pub struct SourcePrepareRatePolicy {
    pub max_messages_per_minute: u32,
    pub max_source_messages_per_minute: u32,
}

impl Default for SourcePrepareRatePolicy {
    fn default() -> Self {
        Self {
            max_messages_per_minute: 32,
            max_source_messages_per_minute: 8,
        }
    }
}

impl SourcePrepareRatePolicy {
    fn validate(self) -> Result<()> {
        ensure!(
            (1..=MAX_CHARGES as u32).contains(&self.max_messages_per_minute)
                && (1..=MAX_CHARGES as u32).contains(&self.max_source_messages_per_minute),
            "peer_router_rate_policy_invalid"
        );
        Ok(())
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct State {
    observed_at_ms: u64,
    charges: Vec<Charge>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Charge {
    operation_id: String,
    source_address: SessionAddressV1,
    admitted_at_ms: u64,
    utf8_bytes: u32,
}

impl State {
    pub(super) fn validate(&self, store: &NativePeerRouterStore) -> Result<()> {
        ensure!(
            self.charges.len() <= MAX_CHARGES,
            "peer_router_rate_state_invalid"
        );
        let mut identities = std::collections::BTreeSet::new();
        for charge in &self.charges {
            charge
                .source_address
                .validate()
                .map_err(anyhow::Error::msg)?;
            ensure!(
                valid_agent_message_id(&charge.operation_id)
                    && identities.insert(&charge.operation_id)
                    && charge.admitted_at_ms <= self.observed_at_ms
                    && (1..=MAX_AGENT_MESSAGE_TEXT_BYTES as u32).contains(&charge.utf8_bytes)
                    && store
                        .identity_from_header(&charge.source_address.workspace_id)?
                        .contains(&charge.source_address),
                "peer_router_rate_state_invalid"
            );
        }
        Ok(())
    }

    /// Old ledgers have no trustworthy admission timestamps or body lengths.
    /// A single persisted conservative window avoids granting a fresh burst on
    /// each restart, without modifying any original operation or its receipt.
    pub(super) fn from_legacy(data: &Data, now_ms: u64) -> Self {
        Self {
            observed_at_ms: now_ms,
            charges: data
                .operations
                .values()
                .map(|operation| Charge {
                    operation_id: operation.operation_id.clone(),
                    source_address: operation.source_address.clone(),
                    admitted_at_ms: now_ms,
                    utf8_bytes: MAX_AGENT_MESSAGE_TEXT_BYTES as u32,
                })
                .collect(),
        }
    }

    /// Build the next state first: a rejected new operation cannot consume an
    /// allowance, prune a previous charge, or move the persisted clock floor.
    pub(super) fn charge(
        &self,
        operation: &PeerRouterOperationV1,
        utf8_bytes: usize,
        policy: SourcePrepareRatePolicy,
        now_ms: u64,
    ) -> Result<Self> {
        policy.validate()?;
        ensure!(
            (1..=MAX_AGENT_MESSAGE_TEXT_BYTES).contains(&utf8_bytes),
            "peer_router_rate_state_invalid"
        );
        let mut next = self.clone();
        // Native wall time is persisted as a floor. A clock rollback, including
        // one across process restarts, cannot manufacture a replenished window.
        let effective_now = now_ms.max(next.observed_at_ms);
        next.charges
            .retain(|charge| effective_now.saturating_sub(charge.admitted_at_ms) < WINDOW_MS);
        let profile_count = next.charges.len() as u64;
        let profile_bytes: u64 = next
            .charges
            .iter()
            .map(|charge| u64::from(charge.utf8_bytes))
            .sum();
        let source_charges = || {
            next.charges
                .iter()
                .filter(|charge| charge.source_address == operation.source_address)
        };
        let source_count = source_charges().count() as u64;
        let source_bytes: u64 = source_charges()
            .map(|charge| u64::from(charge.utf8_bytes))
            .sum();
        let profile_limit = u64::from(policy.max_messages_per_minute);
        let source_limit = u64::from(policy.max_source_messages_per_minute);
        ensure!(
            profile_count < profile_limit
                && profile_bytes + utf8_bytes as u64
                    <= profile_limit * MAX_AGENT_MESSAGE_TEXT_BYTES as u64,
            "peer_router_profile_rate_limited"
        );
        ensure!(
            source_count < source_limit
                && source_bytes + utf8_bytes as u64
                    <= source_limit * MAX_AGENT_MESSAGE_TEXT_BYTES as u64,
            "peer_router_source_rate_limited"
        );
        ensure!(
            next.charges.len() < MAX_CHARGES,
            "peer_router_rate_state_invalid"
        );
        next.observed_at_ms = effective_now;
        next.charges.push(Charge {
            operation_id: operation.operation_id.clone(),
            source_address: operation.source_address.clone(),
            admitted_at_ms: effective_now,
            utf8_bytes: utf8_bytes as u32,
        });
        Ok(next)
    }
}
