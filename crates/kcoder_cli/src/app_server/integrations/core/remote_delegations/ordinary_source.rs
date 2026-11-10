//! Bind an ordinary real Accepted turn to its explicit finite outbound ceiling in the original ledger.
use crate::{budget_host::NativeBudgetService, digest, launch};
use anyhow::{Context, Result, ensure};
use kcoder_config::integrations::remotes::{NativeRemoteOutboundPolicy, RemoteIntegrationSettings};
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_state::{integrations::core::budgets::*, turn_attempt_store::TurnAttemptRecord};
use kcoder_types::{TurnAttemptIdentity, integrations::core::*};
use std::ffi::OsStr;

pub struct OrdinarySourceBudget {
    pub root: String,
    pub settings_sha256: String,
    pub service: NativeBudgetService,
    pub principal: NativeBudgetPrincipal,
    pub parent: NativeBudgetTaskParent,
}
pub fn root_operation(scope: &IntegrationScope, attempt: &TurnAttemptIdentity) -> Result<String> {
    Ok(format!(
        "remote-source-{}",
        digest(&(IntegrationOwner::from(scope), attempt))?
    ))
}
pub fn task_binding(
    scope: &IntegrationScope,
    root: &str,
    attempt: &TurnAttemptIdentity,
    runtime: Option<&IntegrationRuntimeAcceptance>,
    accepted_sha256: &str,
) -> Result<NativeBudgetTaskBinding> {
    let (receipt, sha) = if let Some(runtime) = runtime {
        (
            format!("runtime-accept-{root}"),
            digest(&(IntegrationOwner::from(scope), root, runtime))?,
        )
    } else {
        ensure!(
            root == root_operation(scope, attempt)?,
            "REMOTE_ORIGINAL_ACCEPTED_SOURCE_CHANGED"
        );
        (
            format!("native-turn-accept-{}", digest(attempt)?),
            digest(&(
                IntegrationOwner::from(scope),
                root,
                attempt,
                accepted_sha256,
            ))?,
        )
    };
    NativeBudgetTaskBinding::from_authoritative_receipt(
        root.into(),
        IntegrationEntityRef {
            kind: IntegrationEntityKind::Turn,
            id: attempt.turn_id.clone(),
            revision: None,
        },
        receipt,
        sha,
    )
}
fn snapshot(native: &NativeIntegrationContext) -> Result<(String, NativeRemoteOutboundPolicy)> {
    let file = native.profile()?.read_source_document_snapshot(
        OsStr::new("settings.json"),
        8 * 1024 * 1024,
        || native.verify().is_ok(),
    )?;
    let remotes = RemoteIntegrationSettings::from_native_profile_snapshot(file.bytes())?;
    ensure!(
        remotes.enabled && remotes.outbound.enabled,
        "REMOTE_ACCEPTED_SOURCE_OUTBOUND_POLICY_REQUIRED"
    );
    Ok((file.sha256, remotes.outbound))
}
pub fn deadline_ms(
    native: &NativeIntegrationContext,
    expected: &str,
    accepted_at_ms: u64,
) -> Result<u64> {
    let (sha, policy) = snapshot(native)?;
    ensure!(sha == expected, "REMOTE_ACCEPTED_SOURCE_POLICY_CHANGED");
    let end = accepted_at_ms
        .checked_add(u64::from(policy.maximum_duration_seconds) * 1000)
        .context("REMOTE_ACCEPTED_SOURCE_DEADLINE_INVALID")?;
    ensure!(
        launch::now()? < end,
        "REMOTE_ACCEPTED_SOURCE_DEADLINE_EXPIRED"
    );
    Ok(end)
}
pub fn verify(
    native: &NativeIntegrationContext,
    expected: &str,
    accepted_at_ms: u64,
) -> Result<()> {
    deadline_ms(native, expected, accepted_at_ms).map(|_| ())
}
/// Called only after the actual ordinary Engine final dispatch receipt and
/// authoritative Accepted turn have been checked. No P-RUNTIME task is created.
pub fn capture(
    native: &NativeIntegrationContext,
    accepted: &TurnAttemptRecord,
) -> Result<OrdinarySourceBudget> {
    capture_original(
        native,
        accepted,
        root_operation(native.scope(), &accepted.identity)?,
        None,
    )
}
/// Reuse the actual already-admitted P-RUNTIME operation, never create or relabel it.
pub fn capture_for_runtime(
    native: &NativeIntegrationContext,
    accepted: &TurnAttemptRecord,
    root: &str,
    acceptance: &IntegrationRuntimeAcceptance,
) -> Result<OrdinarySourceBudget> {
    ensure!(
        acceptance.thread_id == accepted.identity.thread_id
            && acceptance.turn_id.as_ref() == Some(&accepted.identity.turn_id)
            && acceptance.task_id.is_none()
            && acceptance.state == IntegrationTaskState::Running,
        "REMOTE_ORIGINAL_RUNTIME_OWNER_MISMATCH"
    );
    capture_original(native, accepted, root.to_owned(), Some(acceptance))
}
pub fn existing_source_policy(
    native: &NativeIntegrationContext,
    root: &str,
    receipt: &BudgetReservationReceipt,
) -> Result<Option<String>> {
    let Some(reference) = receipt.policy_refs.iter().find(|reference| {
        reference.id == "native-remote-accepted-turn"
            && reference.scope == BudgetScope::Task(root.into())
    }) else {
        return Ok(None);
    };
    let (sha, _) = snapshot(native)?;
    ensure!(
        reference.revision == sha,
        "REMOTE_ACCEPTED_SOURCE_POLICY_CHANGED"
    );
    Ok(Some(sha))
}
fn capture_original(
    native: &NativeIntegrationContext,
    accepted: &TurnAttemptRecord,
    root: String,
    runtime: Option<&IntegrationRuntimeAcceptance>,
) -> Result<OrdinarySourceBudget> {
    let (settings_sha256, policy) = snapshot(native)?;
    verify(native, &settings_sha256, accepted.accepted_at_ms)?;
    let principal = NativeBudgetPrincipal::from_native_facts(
        native.scope().account_id.clone(),
        None,
        native.scope().workspace_id.as_ref().cloned(),
        None,
    )?;
    let service = NativeBudgetService::initialize(native, &root)?;
    let store = service.accounting_store();
    let definition = NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
        id: "native-remote-accepted-turn".into(),
        version: 1,
        revision: settings_sha256.clone(),
        scope: BudgetScope::Task(root.clone()),
        window: BudgetWindow {
            id: format!("accepted-{}", digest(&accepted.identity)?),
            starts_at_ms: accepted.accepted_at_ms,
            ends_at_ms: accepted
                .accepted_at_ms
                .checked_add(u64::from(policy.maximum_duration_seconds) * 1000)
                .context("REMOTE_ACCEPTED_SOURCE_DEADLINE_INVALID")?,
        },
        limits: BudgetLimits {
            tokens: Some(policy.maximum_total_tokens),
            model_calls: Some(u64::from(policy.maximum_model_calls)),
            run_millis: Some(u64::from(policy.maximum_duration_seconds) * 1000),
            concurrent_tasks: Some(1),
            concurrent_calls: Some(1),
            ..Default::default()
        },
        currency: None,
    })?;
    let mut policies = store.current_applicable_policies(&principal, &root, launch::now()?)?;
    let mut present = false;
    for current in &policies {
        let observed = store
            .observe_policy(current)?
            .context("REMOTE_ACCEPTED_SOURCE_POLICY_CHANGED")?;
        if observed.policy.id == "native-remote-accepted-turn"
            && observed.policy.scope == BudgetScope::Task(root.clone())
        {
            ensure!(
                observed.policy.revision == settings_sha256,
                "REMOTE_ACCEPTED_SOURCE_POLICY_CHANGED"
            );
            present = true;
        }
    }
    if !present {
        policies.push(definition);
    }
    let binding = task_binding(
        native.scope(),
        &root,
        &accepted.identity,
        runtime,
        &digest(accepted)?,
    )?;
    store.reserve(
        &NativeBudgetRequest {
            reservation_id: format!("remote-source-slot-{}", digest(&root)?),
            operation_id: root.clone(),
            principal: principal.clone(),
            unit: BudgetUnit::TaskSlot,
            task: BudgetTaskLink {
                root_operation_id: root.clone(),
                root_task: Some(IntegrationEntityRef {
                    kind: IntegrationEntityKind::Turn,
                    id: accepted.identity.turn_id.clone(),
                    revision: None,
                }),
                actor: BudgetActor::Main,
                actor_attempt_id: accepted.identity.attempt_id.clone(),
                parent_reservation_id: None,
            },
            estimate: BudgetCharge::zero(),
        },
        &policies,
        launch::now()?,
    )?;
    let parent = store
        .original_active_task_slot(&principal, &binding)?
        .context("REMOTE_ORIGINAL_TASK_SLOT_REQUIRED")?;
    verify(native, &settings_sha256, accepted.accepted_at_ms)?;
    Ok(OrdinarySourceBudget {
        root,
        settings_sha256,
        service,
        principal,
        parent,
    })
}
