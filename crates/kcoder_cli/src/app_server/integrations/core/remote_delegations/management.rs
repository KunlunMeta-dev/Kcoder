//! Read/reconcile and request cancellation through the original operation; never replay an effect.
use super::*;
use kcoder_tools::integrations::remotes::{RemoteOperationAction, RemoteOperationInput};
use kcoder_types::TurnAttemptStatus;
use serde_json::json;

#[cfg(test)]
pub fn manage_original(
    native: &NativeIntegrationContext,
    input: &RemoteOperationInput,
) -> Result<Value> {
    manage_original_with_guard(native, input, &|| Ok(()))
}
pub fn manage_original_with_guard(
    native: &NativeIntegrationContext,
    input: &RemoteOperationInput,
    current: &dyn Fn() -> Result<()>,
) -> Result<Value> {
    current()?;
    input
        .validate()
        .map_err(|_| anyhow::anyhow!("REMOTE_INVALID_INPUT"))?;
    let Some(observed) = NativeRemoteJournal::read(native, &input.operation_id)? else {
        return Ok(
            json!({"operationId":input.operation_id,"state":"not_found","executionTerminalConfirmed":false,"businessCompleted":false}),
        );
    };
    let operations =
        NativeOperations::load(native)?.context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
    let mut original = operations
        .read(native, &input.operation_id)?
        .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
    ensure!(
        original.port == "P-REMOTE" && original.method == "delegate",
        "REMOTE_OPERATION_KIND_MISMATCH"
    );
    let guard = NativeDomainGuard::observe(
        native.profile()?,
        native.scope(),
        NativeDomain::RemoteDelegations,
    )?
    .context("REMOTE_ORIGINAL_OPERATION_JOURNAL_UNAVAILABLE_OUTCOME_UNKNOWN")?;
    let store = NativeRemoteDelegationStore::open_in(
        &guard.directory(native.profile()?)?,
        OsStr::new("data"),
        native.scope(),
    )?
    .context("REMOTE_JOURNAL_MISSING")?;
    // Endpoint observations are already bound and validated by the original
    // private journal. Project those historical facts directly; they are not
    // local TurnAttemptStore tokens or authority to open another connection.
    let (receiver, terminal) = if let Some(endpoint) = &observed.endpoint_receiver {
        use kcoder_types::integrations::core::NativeRemoteCallOutcomeV1 as Outcome;
        let (status, terminal) = match endpoint.outcome {
            None => ("accepted", false),
            Some(Outcome::Completed) => ("completed", true),
            Some(Outcome::Failed) => ("failed", true),
            Some(Outcome::Interrupted) => ("interrupted", true),
            Some(Outcome::OutcomeUnknown) => ("outcome_unknown", false),
        };
        (
            json!({"state":if status=="outcome_unknown" {"outcome_unknown"} else {"native_endpoint_task_observed"},
                "identity":endpoint.accepted.identity,"status":status}),
            terminal,
        )
    } else {
        match super::receiver_history::read_original_receiver(native, &store, &input.operation_id) {
            Ok(Some(actual)) => {
                let terminal = matches!(
                    actual.status,
                    TurnAttemptStatus::Completed
                        | TurnAttemptStatus::Failed
                        | TurnAttemptStatus::Interrupted
                );
                (
                    json!({"state":"native_task_observed","identity":actual.identity,"status":actual.status,
                "finishedAtMs":actual.completion.as_ref().map(|completion| completion.finished_at_ms)}),
                    terminal,
                )
            }
            Ok(None) => (
                json!({"state":"outcome_unknown","code":"REMOTE_RECEIVER_PRIVATE_WITNESS_UNAVAILABLE"}),
                false,
            ),
            Err(_) => (
                json!({"state":"outcome_unknown","code":"REMOTE_RECEIVER_NATIVE_FACT_UNAVAILABLE"}),
                false,
            ),
        }
    };
    if matches!(input.action, RemoteOperationAction::Cancel)
        && !terminal
        && !original.phase.is_terminal()
        && original.phase != IntegrationOperationPhase::CancelRequested
    {
        ensure!(
            input.expected_revision == Some(original.revision),
            "REMOTE_OPERATION_REVISION_CHANGED"
        );
        current()?;
        original = operations.transition(
            native,
            &original,
            IntegrationOperationPhase::CancelRequested,
            None,
        )?;
    }
    current()?;
    native.verify()?;
    Ok(
        json!({"operationId":input.operation_id,"operationRevision":original.revision,"operationPhase":original.phase,
        "journalRevision":observed.revision,"stages":observed.stages,"receipts":observed.safe_receipts,
        "receiver":receiver,"executionTerminalConfirmed":terminal,"businessCompleted":false,
        "ownerCleanupConfirmed":observed.owner_cleanup.as_ref().is_some_and(|cleanup|cleanup.confirmed)
            || observed.endpoint_cleanup.as_ref().is_some_and(|cleanup|cleanup.confirmed),
        "ownerCleanupState":observed.owner_cleanup.as_ref().map(|cleanup|cleanup.confirmed)
            .or_else(||observed.endpoint_cleanup.as_ref().map(|cleanup|cleanup.confirmed))
            .map(|confirmed|if confirmed {"confirmed"}else{"unconfirmed"}).unwrap_or("not_observed"),
        "endpointCleanup":observed.endpoint_cleanup,
        "cancellationState":if matches!(input.action,RemoteOperationAction::Cancel) && terminal {"already_terminal"} else {"observe_original"},
        "recovery":"observe_original_only"}),
    )
}
