//! Source lineage intent lives in the existing binding metadata, not a task store.
use super::*;
use kcoder_engine::integrations::core::NativeChildAdmissionRequest;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct ChildSourceIntent {
    run: BackgroundRunKey,
    parent_attempt: TurnAttemptIdentity,
    identity: TurnAttemptIdentity,
    input_hash: String,
    fingerprint: String,
    root_owner_epoch: String,
    accepted: bool,
}
impl ChildSourceIntent {
    fn capture(
        request: &NativeChildAdmissionRequest<'_>,
        root_owner_epoch: String,
    ) -> Result<Self> {
        let value = Self {
            run: request.run().clone(),
            parent_attempt: request
                .parent_execution()
                .attempt()
                .context("TASK_CAPABILITY_SCOPE_ORIGINAL_PARENT_ATTEMPT_REQUIRED")?
                .clone(),
            identity: request.identity().clone(),
            input_hash: request.input_hash().into(),
            fingerprint: request.fingerprint().into(),
            root_owner_epoch,
            accepted: false,
        };
        value.validate(&digest(&value.run)?)?;
        Ok(value)
    }
    pub(super) fn validate(&self, key: &str) -> Result<()> {
        ensure!(
            digest(&self.run)? == key
                && self.parent_attempt.thread_id == self.run.parent_session_id,
            "TASK_CAPABILITY_SCOPE_CHILD_INTENT_CHANGED"
        );
        uuid::Uuid::parse_str(&self.run.run_id)
            .context("TASK_CAPABILITY_SCOPE_NATIVE_RUN_REQUIRED")?;
        self.parent_attempt.validate().map_err(anyhow::Error::msg)?;
        self.identity.validate().map_err(anyhow::Error::msg)?;
        for value in [&self.input_hash, &self.fingerprint, &self.root_owner_epoch] {
            ensure!(
                value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()),
                "TASK_CAPABILITY_SCOPE_CHILD_INTENT_INVALID"
            );
        }
        Ok(())
    }
}
impl NativeTaskCapabilityScopeBinding {
    /// A stable original run fixes child State/session/TI before the one native
    /// Accepted write. Already-attempting or accepted never restarts a child.
    pub(crate) fn prepare_native_child(
        &self,
        context: &NativeIntegrationContext,
        request: &NativeChildAdmissionRequest<'_>,
        root_owner_epoch: String,
    ) -> Result<()> {
        let key = self.task_key()?;
        let child_key = digest(request.run())?;
        let intent = ChildSourceIntent::capture(request, root_owner_epoch)?;
        let directory = self.store.directory(context)?;
        let _lease = binding_lease(
            &directory,
            &self.store.lock_identity,
            PrivateLeaseMode::Exclusive,
        )?;
        let mut record =
            read_record(&directory, &key)?.context("TASK_CAPABILITY_SCOPE_BINDING_REQUIRED")?;
        ensure!(
            record.accepted == self.accepted.data,
            "TASK_CAPABILITY_SCOPE_BINDING_ACCEPTED_CHANGED"
        );
        if let Some(original) = record.children.get(&child_key) {
            ensure!(
                original.run == intent.run
                    && original.parent_attempt == intent.parent_attempt
                    && original.identity == intent.identity
                    && original.input_hash == intent.input_hash
                    && original.fingerprint == intent.fingerprint
                    && original.root_owner_epoch == intent.root_owner_epoch,
                "TASK_CAPABILITY_SCOPE_CHILD_ORIGINAL_OWNER_CHANGED"
            );
            anyhow::bail!("TASK_CAPABILITY_SCOPE_CHILD_ALREADY_ATTEMPTING_RECONCILE_ORIGINAL");
        }
        ensure!(
            record.children.len() < 128,
            "TASK_CAPABILITY_SCOPE_CHILD_RETENTION_CAPACITY"
        );
        // An older writer must refuse this internal record instead of dropping
        // critical child birth evidence while rewriting a legacy v1 snapshot.
        record.version = record.version.max(2);
        record.children.insert(child_key.clone(), intent.clone());
        if write_record(&directory, &key, &record).is_err() {
            let current = read_record(&directory, &key)?
                .context("TASK_CAPABILITY_SCOPE_CHILD_INTENT_OUTCOME_UNKNOWN")?;
            ensure!(
                current.children.get(&child_key) == Some(&intent),
                "TASK_CAPABILITY_SCOPE_CHILD_INTENT_OUTCOME_UNKNOWN"
            );
        }
        Ok(())
    }
    pub(crate) fn accept_native_child(
        &self,
        context: &NativeIntegrationContext,
        request: &NativeChildAdmissionRequest<'_>,
        root_owner_epoch: String,
    ) -> Result<()> {
        let key = self.task_key()?;
        let child_key = digest(request.run())?;
        let mut expected = ChildSourceIntent::capture(request, root_owner_epoch)?;
        let directory = self.store.directory(context)?;
        let _lease = binding_lease(
            &directory,
            &self.store.lock_identity,
            PrivateLeaseMode::Exclusive,
        )?;
        let mut record =
            read_record(&directory, &key)?.context("TASK_CAPABILITY_SCOPE_BINDING_REQUIRED")?;
        ensure!(
            record.accepted == self.accepted.data,
            "TASK_CAPABILITY_SCOPE_BINDING_ACCEPTED_CHANGED"
        );
        let current = record
            .children
            .get(&child_key)
            .context("TASK_CAPABILITY_SCOPE_CHILD_ORIGINAL_INTENT_REQUIRED")?;
        if current.accepted {
            expected.accepted = true;
        }
        ensure!(
            current == &expected,
            "TASK_CAPABILITY_SCOPE_CHILD_ORIGINAL_OWNER_CHANGED"
        );
        expected.accepted = true;
        record.children.insert(child_key.clone(), expected.clone());
        if write_record(&directory, &key, &record).is_err() {
            let current = read_record(&directory, &key)?
                .context("TASK_CAPABILITY_SCOPE_CHILD_ACCEPTANCE_OUTCOME_UNKNOWN")?;
            ensure!(
                current.children.get(&child_key) == Some(&expected),
                "TASK_CAPABILITY_SCOPE_CHILD_ACCEPTANCE_OUTCOME_UNKNOWN"
            );
        }
        Ok(())
    }
}
