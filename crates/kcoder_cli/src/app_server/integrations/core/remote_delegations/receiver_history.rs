//! Original receiver history witnesses stay private and never authorize execution or replay.
use crate::launch_record::NativeRemoteLaunchRecord;
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_native_scope::{NativeIdentity, NativeIntegrationContext};
use kcoder_state::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
use kcoder_state::{AppState, integrations::core::remote_delegations::NativeRemoteDelegationStore};
use kcoder_types::{
    TurnAttemptIdentity,
    integrations::core::{IntegrationOwner, IntegrationScope},
};
use serde::{Deserialize, Serialize};
use std::{ffi::OsStr, path::PathBuf};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiverHistoryWitness {
    version: u32,
    scope: IntegrationScope,
    profile: PathBuf,
    profile_identity: String,
    history_root: PathBuf,
    history_root_identity: String,
    session_identity: String,
    attempts_identity: String,
    identity: TurnAttemptIdentity,
}
impl ReceiverHistoryWitness {
    pub fn capture(
        native: &NativeIntegrationContext,
        state: &AppState,
        history_root: PathBuf,
        attempt: &TurnAttemptIdentity,
    ) -> Result<Self> {
        ensure!(
            state.current_history_attempt_identity().as_ref() == Some(attempt)
                && state.session_id() == attempt.thread_id,
            "REMOTE_RECEIVER_NATIVE_ATTEMPT_REQUIRED"
        );
        let root = PrivateDirectory::open_existing(&history_root)?;
        root.verify_private_directory()?;
        let session = root.open_child(OsStr::new(&attempt.thread_id), false)?;
        let attempts = session.open_child(OsStr::new("turn-attempts"), false)?;
        let result = Self {
            version: 1,
            scope: native.scope().clone(),
            profile: native.profile_path()?.to_owned(),
            profile_identity: native.profile()?.directory_identity()?,
            history_root,
            history_root_identity: root.directory_identity()?,
            session_identity: session.directory_identity()?,
            attempts_identity: attempts.directory_identity()?,
            identity: attempt.clone(),
        };
        result.open_store()?;
        Ok(result)
    }
    fn open_store(&self) -> Result<TurnAttemptStore> {
        ensure!(
            self.version == 1 && self.profile.is_absolute() && self.history_root.is_absolute(),
            "REMOTE_RECEIVER_PRIVATE_WITNESS_INVALID"
        );
        self.identity.validate().map_err(anyhow::Error::msg)?;
        let profile = PrivateDirectory::open_existing(&self.profile)?;
        profile.verify_private_directory()?;
        ensure!(
            profile.directory_identity()? == self.profile_identity,
            "REMOTE_RECEIVER_NATIVE_OWNER_CHANGED"
        );
        // The owned execution workspace may already have been cleaned. Native
        // historical task evidence remains anchored by the independent profile
        // generation and the retained exact history directories.
        let mut global = self.scope.clone();
        global.workspace_id = kcoder_types::integrations::core::IntegrationNullable::Null;
        let identity = NativeIdentity::observe(&profile, &global)?
            .context("REMOTE_RECEIVER_NATIVE_OWNER_CHANGED")?;
        let snapshot = identity.snapshot(&profile)?;
        ensure!(
            snapshot.enabled && snapshot.generation == self.scope.identity_generation,
            "REMOTE_RECEIVER_NATIVE_OWNER_CHANGED"
        );
        let root = PrivateDirectory::open_existing(&self.history_root)?;
        root.verify_private_directory()?;
        let session = root.open_child(OsStr::new(&self.identity.thread_id), false)?;
        let attempts = session.open_child(OsStr::new("turn-attempts"), false)?;
        ensure!(
            root.directory_identity()? == self.history_root_identity
                && session.directory_identity()? == self.session_identity
                && attempts.directory_identity()? == self.attempts_identity,
            "REMOTE_RECEIVER_NATIVE_HISTORY_CHANGED"
        );
        TurnAttemptStore::open_existing(
            &self.history_root.join(&self.identity.thread_id),
            &self.identity.thread_id,
        )?
        .context("REMOTE_RECEIVER_NATIVE_TASK_MISSING_OUTCOME_UNKNOWN")
    }
}
/// Pure same-operation lookup. Missing witnesses remain unknown, never a new task.
pub fn read_original_receiver(
    native: &NativeIntegrationContext,
    store: &NativeRemoteDelegationStore,
    operation: &str,
) -> Result<Option<TurnAttemptRecord>> {
    native.verify()?;
    let original = store
        .read(operation)?
        .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
    let Some(raw) = store.read_receiver_private_witness(operation)? else {
        return Ok(None);
    };
    let witness: ReceiverHistoryWitness = serde_json::from_value(raw)
        .map_err(|_| anyhow::anyhow!("REMOTE_RECEIVER_PRIVATE_WITNESS_INVALID"))?;
    let launch = store
        .read_native_launch(operation)?
        .context("REMOTE_ORIGINAL_NATIVE_LAUNCH_REQUIRED")?;
    let launch: NativeRemoteLaunchRecord = serde_json::from_slice(launch.bytes())?;
    // Historical facts belong to the same actual native owner. A later model
    // configuration revision does not authorize execution and must not hide
    // this owner's original receiver terminal receipt.
    ensure!(
        IntegrationOwner::from(native.scope()) == IntegrationOwner::from(&launch.source.scope),
        "REMOTE_RECEIVER_NATIVE_OWNER_CHANGED"
    );
    ensure!(
        launch.operation == operation
            && launch.receiver_scope == witness.scope
            && launch.receiver_identity == original.recipient_identity
            && original
                .receiver
                .as_ref()
                .is_some_and(|receipt| receipt.identity == witness.identity),
        "REMOTE_RECEIVER_NATIVE_OWNER_CHANGED"
    );
    let actual = store.read_receiver_task(
        operation,
        &original.recipient_identity,
        &witness.open_store()?,
    )?;
    // Reopen the exact directories after reading to detect concurrent replacement.
    witness.open_store()?;
    native.verify()?;
    Ok(Some(actual))
}
