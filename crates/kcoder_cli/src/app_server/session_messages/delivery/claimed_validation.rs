//! Bounded original-ID reads before a Provider; no delivery, claim or execution is replayed.
use super::*;

#[derive(Debug)]
struct TargetReadBusy;
impl std::fmt::Display for TargetReadBusy {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str("peer_delivery_target_busy")
    }
}
impl std::error::Error for TargetReadBusy {}

pub(crate) fn is_temporary_read_contention(error: &anyhow::Error) -> bool {
    error.is::<TargetReadBusy>() || PeerMessageCall::is_temporary_claim_validation(error)
}

pub(super) fn verify_target(
    state: &AppState,
    owner: &AppStateLifecycleIdentity,
    history: &std::path::Path,
    lease: &NativeSessionLeaseWitness,
    call: Option<&PeerMessageCall>,
) -> Result<()> {
    if let Some(call) = call {
        call.verify_current_owner()?;
        ensure!(
            state.shares_state_with(call.state()) && owner.same_lifecycle(call.owner()),
            "peer_delivery_target_changed"
        );
    }
    match state.try_check_lifecycle_history_matches(owner, history)? {
        Some(true) => {}
        Some(false) => anyhow::bail!("peer_delivery_target_changed"),
        None => return Err(anyhow::Error::new(TargetReadBusy)),
    }
    lease.verify_target(history)
}

/// Closed diagnostic only. The public code stays the fail-closed fallback; this
/// names which fresh target fact failed so logs can separate lease/target loss
/// from a stale native permit. It never classifies an error as retryable.
pub(super) fn claimed_read_reason(error: &anyhow::Error) -> &'static str {
    const TARGET: &[&str] = &[
        "peer_delivery_target_changed",
        "SESSION_NATIVE_OWNER_CLOSED",
        "SESSION_NATIVE_OWNER_CHANGED",
        "SESSION_NATIVE_OWNER_UNAVAILABLE",
        "peer_provider_start_original_record_unavailable",
    ];
    for cause in error.chain() {
        let message = cause.to_string();
        if let Some(code) = TARGET.iter().find(|code| **code == message) {
            return code;
        }
    }
    PeerMessageCall::claim_validation_reason(error)
}

pub(super) fn public_read_error(error: &anyhow::Error, fallback: &str) -> String {
    if is_temporary_read_contention(error) {
        return "peer_provider_start_original_read_busy".into();
    }
    if error
        .chain()
        .any(|cause| cause.to_string() == "peer_provider_start_original_record_unavailable")
    {
        return "peer_provider_start_original_record_unavailable".into();
    }
    match PeerMessageCall::claim_validation_reason(error) {
        "PEER_HISTORY_RECORD_MISMATCH" | "PEER_WAKE_PROVIDER_ORIGINAL_MESSAGE_CHANGED" => {
            "peer_provider_start_original_message_changed".into()
        }
        "PEER_WAKE_PROVIDER_CANCELLED" => "peer_provider_start_cancelled".into(),
        _ => fallback.into(),
    }
}

impl DestinationPeerMessageDriver {
    pub(super) async fn read_claimed_original(
        &self,
        call: &PeerMessageCall,
        message_id: &str,
    ) -> std::result::Result<CrossSessionMessageRecord, String> {
        for attempt in 0..3 {
            if call.is_cancelled() {
                return Err("peer_provider_start_cancelled".into());
            }
            let state = self.state.clone();
            let owner = self.owner.clone();
            let path = self.history_path.clone();
            let lease = self.lease.clone();
            let store = self.store.clone();
            let read_call = call.clone();
            let id = message_id.to_owned();
            let active = Arc::new(std::sync::atomic::AtomicBool::new(true));
            let worker_active = active.clone();
            let _owner = IdleSettlementOwner(active);
            let mut worker =
                tokio::task::spawn_blocking(move || -> Result<CrossSessionMessageRecord> {
                    ensure!(
                        worker_active.load(std::sync::atomic::Ordering::Acquire),
                        "PEER_WAKE_PROVIDER_CANCELLED"
                    );
                    verify_target(&state, &owner, &path, &lease, Some(&read_call))?;
                    read_call.verify_claimed_peer_start()?;
                    let record = store
                        .get_record_by_message_id(&id)
                        .context("peer_provider_start_original_record_unavailable")?
                        .context("peer_provider_start_original_record_unavailable")?;
                    read_call.verify_claimed_start_record(&record)?;
                    verify_target(&state, &owner, &path, &lease, Some(&read_call))?;
                    ensure!(
                        worker_active.load(std::sync::atomic::Ordering::Acquire),
                        "PEER_WAKE_PROVIDER_CANCELLED"
                    );
                    Ok(record)
                });
            let observed = tokio::select! {biased;
                _=call.cancelled()=>{ _owner.0.store(false,std::sync::atomic::Ordering::Release);let _=worker.await;return Err("peer_provider_start_cancelled".into()); }
                result=&mut worker=>result.map_err(|_|"peer_provider_start_original_record_unavailable".to_owned())?,
            };
            match observed {
                Ok(record) => return Ok(record),
                Err(error) if is_temporary_read_contention(&error) && attempt < 2 => {
                    tokio::select! {biased;_=call.cancelled()=>return Err("peer_provider_start_cancelled".into()),_=tokio::time::sleep(Duration::from_millis(2))=>{}}
                }
                Err(error) => {
                    tracing::warn!(
                        stage = "peer_original_claim_read",
                        reason = claimed_read_reason(&error)
                    );
                    return Err(public_read_error(
                        &error,
                        "peer_provider_start_original_permit_not_current",
                    ));
                }
            }
        }
        unreachable!()
    }
}

pub(super) fn verify_bound_target(
    state: &AppState,
    owner: &AppStateLifecycleIdentity,
    history: &std::path::Path,
    lease: &NativeSessionLeaseWitness,
) -> Result<()> {
    verify_target(state, owner, history, lease, None)
}

#[cfg(test)]
mod tests;
