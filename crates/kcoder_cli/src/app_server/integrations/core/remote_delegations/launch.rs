//! Private Native launch provenance. Environment/JSON locators only select original facts; they grant nothing.
use crate::{NativeOperations, budget_host::NativeBudgetService};
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PrivateDirectory,
    integrations::remotes::{NativeRemoteReceiverPolicy, RemoteIntegrationSettings},
};
use kcoder_native_scope::{
    NativeDomain, NativeDomainGuard, NativeIdentity, NativeIntegrationContext,
};
use kcoder_state::{
    integrations::core::{
        budgets::*,
        remote_delegations::{
            NativeRemoteDelegationStore, NativeRemoteObservation, NativeRemoteStage,
        },
    },
    turn_attempt_store::TurnAttemptStore,
};
use kcoder_types::{TurnAttemptStatus, integrations::core::*};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const NATIVE_REMOTE_LAUNCH_ENV: &str = "KCODER_NATIVE_REMOTE_ORIGINAL_V1";
pub use crate::launch_record::{
    NativeRemoteLaunchRecord, NativeRemoteSourceFacts, NativeRemoteSourceGoalFacts,
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteLaunchLocator {
    source_scope: IntegrationScope,
    source_profile: PathBuf,
    source_workspace: PathBuf,
    operation: String,
}
impl NativeRemoteLaunchLocator {
    pub fn from_current_native(
        context: &NativeIntegrationContext,
        workspace: &Path,
        operation: &str,
    ) -> Result<String> {
        context.verify()?;
        ensure!(
            workspace.is_absolute()
                && PrivateDirectory::open_existing(workspace)?.directory_identity()?
                    == context.workspace_directory_identity()?,
            "REMOTE_NATIVE_WORKSPACE_MISMATCH"
        );
        ensure!(
            !operation.is_empty() && operation.len() <= 256,
            "REMOTE_OPERATION_REQUIRED"
        );
        let value = Self {
            source_scope: context.scope().clone(),
            source_profile: context.profile_path()?.to_owned(),
            source_workspace: workspace.to_owned(),
            operation: operation.into(),
        };
        Ok(serde_json::to_string(&value)?)
    }
}
/// Actual held original journal plus revalidated native source facts. This is
/// constructed from private original receipts, never a deserialized grant.
pub struct NativeRemoteIncomingLaunch {
    value: NativeRemoteLaunchRecord,
    source: NativeIntegrationContext,
    source_guard: NativeDomainGuard,
    source_store: NativeRemoteDelegationStore,
    source_budget: NativeBudgetService,
    source_principal: NativeBudgetPrincipal,
    source_parent: NativeBudgetTaskParent,
    receiver_policy: NativeRemoteReceiverPolicy,
}

/// Startup defaults may inspect the original session dispatch, but this value
/// cannot be used as the prompt/Accepted witness needed by a receiver executor.
pub struct NativeRemoteSessionStartup {
    incoming: NativeRemoteIncomingLaunch,
}
impl NativeRemoteSessionStartup {
    pub fn observe(raw: &str, receiver: &NativeIntegrationContext) -> Result<Self> {
        Ok(Self {
            incoming: NativeRemoteIncomingLaunch::observe_for_stage(
                raw,
                receiver,
                IncomingSourceStage::SessionStartup,
            )?,
        })
    }
    pub fn verify(&self) -> Result<()> {
        self.incoming
            .check_source_for_stage(IncomingSourceStage::SessionStartup)
    }
    pub fn program_sha256(&self) -> Result<&str> {
        self.verify()?;
        self.incoming.value.receiver_identity["programSha256"]
            .as_str()
            .context("REMOTE_OFFICE_NATIVE_INSTALLATION_REQUIRED")
    }
    pub fn program_identity(&self) -> Result<&str> {
        self.verify()?;
        self.incoming
            .value
            .receiver_program_identity
            .as_deref()
            .context("REMOTE_OFFICE_NATIVE_INSTALLATION_REQUIRED")
    }
}
#[derive(Clone, Copy)]
enum IncomingSourceStage {
    SessionStartup,
    PromptExecution,
}
impl NativeRemoteIncomingLaunch {
    pub fn value(&self) -> &NativeRemoteLaunchRecord {
        &self.value
    }

    pub fn source(&self) -> &NativeIntegrationContext {
        &self.source
    }

    pub fn source_store(&self) -> &NativeRemoteDelegationStore {
        &self.source_store
    }

    pub fn source_budget(&self) -> &NativeBudgetService {
        &self.source_budget
    }

    pub fn source_principal(&self) -> &NativeBudgetPrincipal {
        &self.source_principal
    }

    pub fn source_parent(&self) -> &NativeBudgetTaskParent {
        &self.source_parent
    }

    pub fn receiver_policy(&self) -> &NativeRemoteReceiverPolicy {
        &self.receiver_policy
    }

    pub fn observe(raw: &str, receiver: &NativeIntegrationContext) -> Result<Self> {
        Self::observe_for_stage(raw, receiver, IncomingSourceStage::PromptExecution)
    }
    fn observe_for_stage(
        raw: &str,
        receiver: &NativeIntegrationContext,
        stage: IncomingSourceStage,
    ) -> Result<Self> {
        ensure!(
            !raw.is_empty() && raw.len() <= 16 * 1024,
            "REMOTE_NATIVE_LAUNCH_LOCATOR_INVALID"
        );
        let locator: NativeRemoteLaunchLocator = serde_json::from_str(raw)
            .map_err(|_| anyhow::anyhow!("REMOTE_NATIVE_LAUNCH_LOCATOR_INVALID"))?;
        locator.source_scope.validate()?;
        ensure!(
            locator.source_scope.organization_id.is_none()
                && locator.source_profile.is_absolute()
                && locator.source_workspace.is_absolute(),
            "REMOTE_NATIVE_SOURCE_INVALID"
        );
        let profile = PrivateDirectory::open_existing(&locator.source_profile)?;
        profile.verify_private_directory()?;
        // No environment locator may initialize an identity or a missing journal.
        let mut global = locator.source_scope.clone();
        global.workspace_id = IntegrationNullable::Null;
        ensure!(
            NativeIdentity::observe(&profile, &global)?.is_some(),
            "REMOTE_NATIVE_SOURCE_IDENTITY_REQUIRED"
        );
        let source_guard = NativeDomainGuard::observe(
            &profile,
            &locator.source_scope,
            NativeDomain::RemoteDelegations,
        )?
        .context("REMOTE_ORIGINAL_JOURNAL_REQUIRED")?;
        let source_store = NativeRemoteDelegationStore::open_in(
            &source_guard.directory(&profile)?,
            OsStr::new("data"),
            &locator.source_scope,
        )?
        .context("REMOTE_ORIGINAL_JOURNAL_REQUIRED")?;
        let snapshot = source_store
            .read_native_launch(&locator.operation)?
            .context("REMOTE_ORIGINAL_NATIVE_LAUNCH_REQUIRED")?;
        let value: NativeRemoteLaunchRecord = serde_json::from_slice(snapshot.bytes())
            .map_err(|_| anyhow::anyhow!("REMOTE_ORIGINAL_NATIVE_LAUNCH_INVALID"))?;
        ensure!(
            value.version == 1
                && value.operation == locator.operation
                && value.source.scope == locator.source_scope
                && value.source.profile == locator.source_profile
                && value.source.workspace == locator.source_workspace,
            "REMOTE_ORIGINAL_NATIVE_LAUNCH_CHANGED"
        );
        let source = NativeIntegrationContext::capture(
            &locator.source_profile,
            &locator.source_workspace,
            "original-remote-native-source",
            &locator.source_scope.target_revision,
        )?;
        source.validate_scope(&locator.source_scope)?;
        receiver.validate_scope(&value.receiver_scope)?;
        let receiver_settings = receiver.profile()?.read_source_document_snapshot(
            OsStr::new("settings.json"),
            8 * 1024 * 1024,
            || receiver.verify().is_ok(),
        )?;
        ensure!(
            receiver_settings.sha256 == value.receiver_settings_sha256,
            "REMOTE_RECEIVER_CONFIGURATION_CHANGED"
        );
        RemoteIntegrationSettings::validate_native_receiver(receiver_settings.bytes())?;
        let receiver_policy = RemoteIntegrationSettings::admit_native_sender(
            receiver_settings.bytes(),
            &source.scope().account_id,
        )?;
        let remaining = value
            .deadline_utc_ms
            .checked_sub(now()?)
            .context("REMOTE_NATIVE_DEADLINE_EXPIRED")?;
        ensure!(
            remaining > 0
                && remaining <= u64::from(receiver_policy.maximum_duration_seconds) * 1000,
            "REMOTE_RECEIVER_NATIVE_DURATION_BOUND"
        );
        let source_budget = NativeBudgetService::load(&source)?
            .context("REMOTE_ORIGINAL_NATIVE_BUDGET_REQUIRED")?;
        let source_principal = NativeBudgetPrincipal::from_native_facts(
            source.scope().account_id.clone(),
            None,
            source.scope().workspace_id.as_ref().cloned(),
            None,
        )?;
        let binding = super::ordinary_source::task_binding(
            source.scope(),
            &value.source.original_root_operation,
            &value.source.attempt,
            value.source.original_root_acceptance.as_ref(),
            &value.source.accepted_receipt_sha256,
        )?;
        let source_parent = source_budget
            .accounting_store()
            .original_active_task_slot(&source_principal, &binding)?
            .context("REMOTE_ORIGINAL_TASK_SLOT_REQUIRED")?;
        ensure!(
            source_parent.receipt().reservation_id == value.source.original_parent_reservation,
            "REMOTE_ORIGINAL_TASK_SLOT_CHANGED"
        );
        let result = Self {
            value,
            source,
            source_guard,
            source_store,
            source_budget,
            source_principal,
            source_parent,
            receiver_policy,
        };
        result.check_source_for_stage(stage)?;
        Ok(result)
    }
    pub fn check_source(&self) -> Result<()> {
        self.check_source_for_stage(IncomingSourceStage::PromptExecution)
    }
    fn check_source_for_stage(&self, stage: IncomingSourceStage) -> Result<()> {
        self.source.verify()?;
        ensure!(
            now()? < self.value.deadline_utc_ms,
            "REMOTE_NATIVE_DEADLINE_EXPIRED"
        );
        let directory = self.source_guard.directory(self.source.profile()?)?;
        let data = directory.open_child(OsStr::new("data"), false)?;
        ensure!(
            data.directory_identity()? == self.source_store.storage_directory_identity()?,
            "REMOTE_ORIGINAL_JOURNAL_CHANGED"
        );
        let launch = self
            .source_store
            .read_native_launch(&self.value.operation)?
            .context("REMOTE_ORIGINAL_NATIVE_LAUNCH_REQUIRED")?;
        ensure!(
            digest_bytes(launch.bytes()) == digest_bytes(&serde_json::to_vec(&self.value)?),
            "REMOTE_ORIGINAL_NATIVE_LAUNCH_CHANGED"
        );
        let observed = self
            .source_store
            .read(&self.value.operation)?
            .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
        ensure!(
            observed.recipient_identity == self.value.receiver_identity,
            "REMOTE_ORIGINAL_NATIVE_LAUNCH_CHANGED"
        );
        require_original_source_stage(&observed, stage)?;
        let original = NativeOperations::load(&self.source)?
            .context("REMOTE_ORIGINAL_OPERATION_MISSING")?
            .read(&self.source, &self.value.operation)?
            .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
        ensure!(
            original.port == "P-REMOTE" && original.method == "delegate",
            "REMOTE_ORIGINAL_OPERATION_NOT_ACTIVE"
        );
        ensure!(
            !matches!(
                original.phase,
                IntegrationOperationPhase::CancelRequested | IntegrationOperationPhase::Cancelled
            ),
            "REMOTE_ORIGINAL_CANCEL_REQUESTED"
        );
        ensure!(
            original.phase == IntegrationOperationPhase::Executing,
            "REMOTE_ORIGINAL_OPERATION_NOT_ACTIVE"
        );
        let settings = self.source.profile()?.read_source_document_snapshot(
            OsStr::new("settings.json"),
            8 * 1024 * 1024,
            || self.source.verify().is_ok(),
        )?;
        ensure!(
            settings.sha256 == self.value.source.profile_settings_sha256,
            "REMOTE_NATIVE_SOURCE_CONFIGURATION_CHANGED"
        );
        let facts = &self.value.source;
        let root = PrivateDirectory::open_existing(&facts.history_root)?;
        root.verify_private_directory()?;
        let session = root.open_child(OsStr::new(&facts.attempt.thread_id), false)?;
        let attempts = session.open_child(OsStr::new("turn-attempts"), false)?;
        ensure!(
            root.directory_identity()? == facts.history_root_identity
                && session.directory_identity()? == facts.session_identity
                && attempts.directory_identity()? == facts.attempts_identity,
            "REMOTE_NATIVE_SOURCE_HISTORY_CHANGED"
        );
        let task = TurnAttemptStore::open_existing(
            &facts.history_root.join(&facts.attempt.thread_id),
            &facts.attempt.thread_id,
        )?
        .context("REMOTE_ORIGINAL_TASK_MISSING")?;
        let accepted = task
            .load(&facts.attempt)?
            .context("REMOTE_ORIGINAL_TASK_MISSING")?;
        accepted.validate()?;
        let mut original_accepted = accepted.clone();
        original_accepted.status = TurnAttemptStatus::Accepted;
        original_accepted.completion = None;
        ensure!(
            digest(&original_accepted)? == facts.accepted_receipt_sha256,
            "REMOTE_ORIGINAL_TASK_CHANGED"
        );
        ensure!(
            accepted.status != TurnAttemptStatus::Interrupted,
            "REMOTE_ORIGINAL_TASK_INTERRUPTED"
        );
        if let Some(goal) = &facts.goal {
            let parent = PrivateDirectory::open_existing(
                goal.state_path
                    .parent()
                    .context("REMOTE_GOAL_STATE_REQUIRED")?,
            )?;
            parent.verify_private_directory()?;
            ensure!(
                parent.directory_identity()? == goal.directory_identity,
                "REMOTE_GOAL_STATE_OWNER_CHANGED"
            );
            let snapshot = parent.read_source_document_snapshot(
                goal.state_path
                    .file_name()
                    .context("REMOTE_GOAL_STATE_REQUIRED")?,
                8 * 1024 * 1024,
                || self.source.verify().is_ok(),
            )?;
            kcoder_state::Goal::verify_native_budget_snapshot(
                snapshot.bytes(),
                &goal.id,
                goal.generation,
                &facts.original_parent_reservation,
                &self
                    .source_budget
                    .accounting_store()
                    .storage_directory_identity()?,
                &accepted,
            )?;
        }
        ensure!(
            accepted.status == TurnAttemptStatus::Accepted && accepted.completion.is_none(),
            "REMOTE_ORIGINAL_TASK_NOT_ACTIVE"
        );
        if let Some(acceptance) = &facts.original_root_acceptance {
            let root_receipt = NativeOperations::load(&self.source)?
                .context("REMOTE_ORIGINAL_RUNTIME_MISSING")?
                .read(&self.source, &facts.original_root_operation)?
                .context("REMOTE_ORIGINAL_RUNTIME_MISSING")?;
            self.source.validate_scope(&root_receipt.scope)?;
            ensure!(
                root_receipt.port == "P-RUNTIME"
                    && root_receipt.method == "acceptTask"
                    && root_receipt.phase == IntegrationOperationPhase::Accepted
                    && root_receipt.runtime_acceptance.as_ref() == Some(acceptance)
                    && acceptance.thread_id == facts.attempt.thread_id
                    && acceptance.turn_id.as_ref() == Some(&facts.attempt.turn_id)
                    && acceptance.task_id.is_none(),
                "REMOTE_ORIGINAL_RUNTIME_OWNER_MISMATCH"
            );
        } else {
            ensure!(
                facts.original_root_operation
                    == super::ordinary_source::root_operation(self.source.scope(), &facts.attempt)?,
                "REMOTE_ORIGINAL_ACCEPTED_SOURCE_CHANGED"
            );
            super::ordinary_source::verify(
                &self.source,
                &facts.profile_settings_sha256,
                accepted.accepted_at_ms,
            )?;
        }
        let reopened = PrivateDirectory::open_existing(&facts.history_root)?;
        let reopened_session = reopened.open_child(OsStr::new(&facts.attempt.thread_id), false)?;
        ensure!(
            reopened.directory_identity()? == facts.history_root_identity
                && reopened_session.directory_identity()? == facts.session_identity
                && reopened_session
                    .open_child(OsStr::new("turn-attempts"), false)?
                    .directory_identity()?
                    == facts.attempts_identity,
            "REMOTE_NATIVE_SOURCE_HISTORY_CHANGED"
        );
        self.source_budget.verify(&self.source)?;
        self.source_budget
            .accounting_store()
            .verify_original_task_slot(&self.source_parent)?;
        Ok(())
    }
}
fn require_original_source_stage(
    observed: &NativeRemoteObservation,
    stage: IncomingSourceStage,
) -> Result<()> {
    use kcoder_state::integrations::core::remote_delegations::NativeRemoteStageState;
    match stage {
        IncomingSourceStage::SessionStartup => ensure!(
            observed.stages.get(&NativeRemoteStage::Session)
                == Some(&NativeRemoteStageState::Dispatched)
                && !observed.stages.contains_key(&NativeRemoteStage::Prompt)
                && observed.receiver.is_none(),
            "REMOTE_ORIGINAL_SESSION_DISPATCH_REQUIRED"
        ),
        IncomingSourceStage::PromptExecution => ensure!(
            observed.stages.get(&NativeRemoteStage::Prompt)
                == Some(&NativeRemoteStageState::Dispatched),
            "REMOTE_ORIGINAL_PROMPT_DISPATCH_REQUIRED"
        ),
    }
    Ok(())
}
pub fn now() -> Result<u64> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}
pub use crate::digest;
use crate::digest_bytes;

#[cfg(test)]
mod startup_stage_tests {
    use super::*;
    use kcoder_state::integrations::core::remote_delegations::NativeRemotePlan;
    use serde_json::json;

    #[test]
    fn original_session_defaults_cannot_substitute_for_prompt_dispatch() {
        let temp = tempfile::tempdir().unwrap();
        let directory = PrivateDirectory::open_existing(temp.path())
            .unwrap()
            .create_private_child(OsStr::new("owned-startup-profile"))
            .unwrap();
        let scope = IntegrationScope {
            account_id: "actual-startup-account".into(),
            target_id: "actual-startup-target".into(),
            workspace_id: IntegrationNullable::Value("actual-startup-workspace".into()),
            identity_generation: "actual-startup-generation".into(),
            target_revision: "actual-startup-revision".into(),
            organization_id: None,
        };
        let store =
            NativeRemoteDelegationStore::create_in(&directory, OsStr::new("journal"), &scope)
                .unwrap();
        let operation = "original-session-startup";
        store
            .begin(&NativeRemotePlan {
                operation_id: operation.into(),
                scope: scope.clone(),
                public_intent: json!({"prompt":"Frozen original intent"}),
                recipient_revision: "original-receiver-revision".into(),
                recipient_identity: json!({"receiver":"original-native"}),
            })
            .unwrap();
        let read = || store.read(operation).unwrap().unwrap();
        assert!(
            require_original_source_stage(&read(), IncomingSourceStage::SessionStartup).is_err()
        );
        assert!(
            require_original_source_stage(&read(), IncomingSourceStage::PromptExecution).is_err()
        );
        for stage in [NativeRemoteStage::Spawn, NativeRemoteStage::Initialize] {
            let dispatch = store
                .before_dispatch(operation, &scope, stage, &json!({"owned":true}))
                .unwrap();
            store.receive(&dispatch, &json!({"owned":true})).unwrap();
        }
        let session = store
            .before_dispatch(
                operation,
                &scope,
                NativeRemoteStage::Session,
                &json!({"cwd":"owned-workspace"}),
            )
            .unwrap();
        assert!(
            require_original_source_stage(&read(), IncomingSourceStage::SessionStartup).is_ok()
        );
        assert!(
            require_original_source_stage(&read(), IncomingSourceStage::PromptExecution).is_err()
        );
        store
            .receive(&session, &json!({"sessionId":"original-session"}))
            .unwrap();
        assert!(
            require_original_source_stage(&read(), IncomingSourceStage::SessionStartup).is_err()
        );
        let prompt = store
            .before_dispatch(
                operation,
                &scope,
                NativeRemoteStage::Prompt,
                &json!({"sessionId":"original-session"}),
            )
            .unwrap();
        assert!(
            require_original_source_stage(&read(), IncomingSourceStage::PromptExecution).is_ok()
        );
        assert!(
            require_original_source_stage(&read(), IncomingSourceStage::SessionStartup).is_err()
        );
        store.unknown(&prompt).unwrap();
        assert!(
            require_original_source_stage(&read(), IncomingSourceStage::PromptExecution).is_err()
        );
        assert!(
            require_original_source_stage(&read(), IncomingSourceStage::SessionStartup).is_err()
        );
    }
}
