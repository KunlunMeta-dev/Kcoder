use super::*;
use kcoder_app_protocol::{ThreadMessage, TurnCompletedParams, TurnStatus};

impl NativeRuntimeDriver {
    /// Root supplies references from B's owner-validated manifest. This stores
    /// observations only; it does not authorize reads, exports or delivery.
    pub fn observe_artifact_refs(
        &mut self,
        context: &NativeIntegrationContext,
        operation: &str,
        references: Vec<IntegrationEntityRef>,
    ) -> Result<()> {
        self.check(context)?;
        let mut binding = self
            .storage
            .bindings
            .get(operation)?
            .context("RUNTIME_BINDING_MISSING")?;
        ensure!(
            binding.acceptance.is_some(),
            "RUNTIME_ACCEPTANCE_UNCONFIRMED"
        );
        binding.artifact_refs = references;
        let revision = binding.revision;
        self.storage.bindings.save(binding, Some(revision))?;
        Ok(())
    }
    /// Root supplies its actual pending interaction receipts. Public caller
    /// payloads cannot manufacture a question, approval or its revision here.
    pub fn observe_interactions(
        &mut self,
        context: &NativeIntegrationContext,
        operation: &str,
        interactions: Vec<IntegrationPendingInteraction>,
    ) -> Result<()> {
        self.check(context)?;
        ensure!(
            interactions.len() <= 32
                && interactions
                    .iter()
                    .all(|value| !value.interaction_id.is_empty()
                        && value.interaction_id.len() <= 256
                        && !value.revision.is_empty()
                        && value.revision.len() <= 256
                        && value.prompt.len() <= 16 * 1024),
            "RUNTIME_INTERACTION_LIMIT"
        );
        let mut binding = self
            .storage
            .bindings
            .get(operation)?
            .context("RUNTIME_BINDING_MISSING")?;
        ensure!(
            binding.acceptance.is_some(),
            "RUNTIME_ACCEPTANCE_UNCONFIRMED"
        );
        if matches!(
            binding.task_state,
            IntegrationTaskState::Completed
                | IntegrationTaskState::Failed
                | IntegrationTaskState::Cancelled
        ) {
            ensure!(
                interactions.is_empty(),
                "RUNTIME_TERMINAL_INTERACTION_REJECTED"
            );
        } else if !interactions.is_empty() {
            binding.task_state = IntegrationTaskState::WaitingForUser
        } else if binding.task_state == IntegrationTaskState::WaitingForUser {
            binding.task_state = IntegrationTaskState::Running
        }
        binding.pending_interactions = interactions;
        let revision = binding.revision;
        self.storage.bindings.save(binding, Some(revision))?;
        Ok(())
    }
    /// The owning pump uses this locator to select the matching active source.
    /// It grants no access to the operation or its output.
    pub fn tracked_turn_operation(&self, event: &TurnCompletedParams) -> Result<Option<&str>> {
        ensure!(
            event.context.thread_id == event.turn.thread_id
                && event.context.turn_id.as_deref() == Some(event.turn.id.as_str()),
            "RUNTIME_EVENT_IDENTITY_MISMATCH"
        );
        let key = (event.turn.thread_id.clone(), event.turn.id.clone());
        Ok(self.tracked.get(&key).map(String::as_str))
    }

    /// Consume Root's actual native event channel, never client notifications.
    /// Events for any other thread/turn leave this operation unchanged.
    pub fn observe_turn_completed(
        &mut self,
        context: &NativeIntegrationContext,
        event: &TurnCompletedParams,
    ) -> Result<bool> {
        self.check(context)?;
        let Some(operation) = self.tracked_turn_operation(event)?.map(str::to_owned) else {
            return Ok(false);
        };
        let mut binding = self
            .storage
            .bindings
            .get(&operation)?
            .context("RUNTIME_BINDING_MISSING")?;
        let accepted = binding
            .acceptance
            .as_ref()
            .context("RUNTIME_ACCEPTANCE_UNCONFIRMED")?;
        ensure!(
            accepted.thread_id == event.turn.thread_id
                && accepted.turn_id.as_deref() == Some(event.turn.id.as_str())
                && accepted.task_id.is_none(),
            "RUNTIME_EVENT_IDENTITY_MISMATCH"
        );
        binding.task_state = turn_state(&event.turn.status);
        if let Some(error) = &event.error {
            // The original tracked and accepted thread/turn were checked above.
            let admission_prefix = [
                "NATIVE_RUNTIME_CURRENT_SOURCE_UNAVAILABLE",
                "TASK_CAPABILITY_SCOPE_INITIAL_BINDING_UNAVAILABLE",
                "NATIVE_TASK_ADMISSION_UNAVAILABLE",
            ]
            .into_iter()
            .find(|prefix| error.message.split(':').next() == Some(*prefix));
            let closed_segments = error
                .message
                .split(':')
                .filter(|value| {
                    !value.is_empty()
                        && value.len() <= 96
                        && value.bytes().all(|byte| {
                            byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                        })
                })
                .take(6)
                .map(|value| hash(value.as_bytes()))
                .collect::<Vec<_>>();
            eprintln!(
                "{}",
                serde_json::json!({"event":"native_runtime_owned_turn_error",
                "errorCode":error.code,"errorMessageSha256":hash(error.message.as_bytes()),
                    "admissionPrefix":admission_prefix,"closedSegmentSha256":closed_segments})
            );
            binding.error = Some(safe_error(
                "RUNTIME_NATIVE_TASK_FAILED",
                IntegrationRecovery::ReconcileOriginal,
            ));
        }
        self.settle(binding)?;
        Ok(true)
    }
    /// Supply the ordinary native transcript projection. Only exact original
    /// assistant messages are retained; no latest-message or empty-success guess.
    #[cfg(any(test, feature = "test-oracle"))]
    pub fn observe_transcript(
        &mut self,
        context: &NativeIntegrationContext,
        operation: &str,
        thread_id: &str,
        messages: &[ThreadMessage],
    ) -> Result<()> {
        self.observe_transcript_with_artifacts(context, operation, thread_id, messages, None)
    }

    /// Original owner observations become visible together. References remain
    /// metadata and grant neither file access nor a delivery destination.
    pub fn observe_transcript_with_artifacts(
        &mut self,
        context: &NativeIntegrationContext,
        operation: &str,
        thread_id: &str,
        messages: &[ThreadMessage],
        references: Option<Vec<IntegrationEntityRef>>,
    ) -> Result<()> {
        self.check(context)?;
        let mut binding = self
            .storage
            .bindings
            .get(operation)?
            .context("RUNTIME_BINDING_MISSING")?;
        let acceptance = binding
            .acceptance
            .as_ref()
            .context("RUNTIME_ACCEPTANCE_UNCONFIRMED")?;
        ensure!(
            acceptance.thread_id == thread_id && acceptance.task_id.is_none(),
            "RUNTIME_NATIVE_IDENTITY_MISMATCH"
        );
        let turn = acceptance
            .turn_id
            .as_deref()
            .context("RUNTIME_NATIVE_TURN_UNCONFIRMED")?;
        if binding.task_state != IntegrationTaskState::Completed {
            return Ok(());
        }
        let output = messages
            .iter()
            .filter(|message| {
                message.role == "assistant"
                    && message.turn_id.as_deref() == Some(turn)
                    && !message.content.is_empty()
                    && !message.content_truncated
            })
            .map(|message| message.content.as_str())
            .next_back();
        let Some(output) = output else {
            return Ok(());
        };
        ensure!(output.len() <= 128 * 1024, "RUNTIME_OUTPUT_TOO_LARGE");
        if let Some(references) = &references {
            ensure!(
                references.len() <= 128
                    && references.iter().all(|reference| {
                        reference.kind == IntegrationEntityKind::Artifact
                            && !reference.id.is_empty()
                            && reference.id.len() <= 256
                            && !reference.id.chars().any(char::is_control)
                            && reference.revision.as_ref().is_some_and(|revision| {
                                !revision.is_empty()
                                    && revision.len() <= 256
                                    && !revision.chars().any(char::is_control)
                            })
                    })
                    && references
                        .iter()
                        .enumerate()
                        .all(|(index, reference)| { !references[..index].contains(reference) }),
                "RUNTIME_CANONICAL_ARTIFACT_REFS_INVALID"
            );
            ensure!(
                binding.artifact_refs.is_empty() || binding.artifact_refs == *references,
                "RUNTIME_CANONICAL_ARTIFACT_REFS_CHANGED"
            );
        }
        if let Some(previous) = &binding.output {
            ensure!(previous == output, "RUNTIME_CANONICAL_OUTPUT_CHANGED");
            if let Some(references) = &references {
                ensure!(
                    binding.artifact_refs == *references,
                    "RUNTIME_CANONICAL_ARTIFACT_REFS_CHANGED"
                );
            }
            return Ok(());
        }
        binding.output = Some(output.to_owned());
        if let Some(references) = references {
            binding.artifact_refs = references;
        }
        binding.output_observation = None;
        let revision = binding.revision;
        self.storage.bindings.save(binding, Some(revision))?;
        Ok(())
    }
    pub fn settle(&mut self, mut binding: RuntimeBinding) -> Result<()> {
        if let Some(accepted) = binding.acceptance.clone() {
            // Repair interrupted acceptance projection before terminal state.
            binding = self.storage.accept(binding, accepted)?;
        }
        let phase = match binding.task_state {
            IntegrationTaskState::Completed => Some(IntegrationOperationPhase::Completed),
            // Native admission already succeeded. The task's independent Failed
            // fact must not rewrite that acceptance into a pre-admission reject.
            IntegrationTaskState::Failed => Some(IntegrationOperationPhase::Completed),
            IntegrationTaskState::Cancelled => Some(IntegrationOperationPhase::Cancelled),
            IntegrationTaskState::OutcomeUnknown => Some(IntegrationOperationPhase::Unknown),
            _ => None,
        };
        binding.phase = if matches!(
            binding.task_state,
            IntegrationTaskState::Completed
                | IntegrationTaskState::Failed
                | IntegrationTaskState::Cancelled
        ) {
            binding.pending_interactions.clear();
            RuntimePhase::Terminal
        } else if matches!(
            binding.phase,
            RuntimePhase::CancelQueued | RuntimePhase::CancelDispatched
        ) {
            // Observing a still-running task does not erase the original stop
            // intent while its exact native cancellation is queued/in flight.
            binding.phase
        } else {
            RuntimePhase::Accepted
        };
        let revision = binding.revision;
        let binding = self.storage.bindings.save(binding, Some(revision))?;
        if let Some(phase) = phase {
            let current = self
                .storage
                .ledger
                .read(&binding.operation_id)?
                .context("RUNTIME_OPERATION_MISSING")?;
            if !current.phase.is_terminal() {
                // Failure after a cancellation request remains an observed outcome;
                // it is not proof that the cancellation won the race.
                let phase = if current.phase == IntegrationOperationPhase::CancelRequested
                    && phase == IntegrationOperationPhase::Rejected
                {
                    IntegrationOperationPhase::Completed
                } else {
                    phase
                };
                self.storage.transition(
                    &binding.operation_id,
                    phase,
                    None,
                    binding.error.clone(),
                )?;
            }
            if let Some(cancel) = &binding.cancel_operation {
                let receipt = self
                    .storage
                    .ledger
                    .read(cancel)?
                    .context("RUNTIME_OPERATION_MISSING")?;
                if !receipt.phase.is_terminal() {
                    let cancel_phase = if phase == IntegrationOperationPhase::Unknown {
                        IntegrationOperationPhase::Unknown
                    } else {
                        IntegrationOperationPhase::Completed
                    };
                    self.storage.transition(cancel, cancel_phase, None, None)?;
                }
            }
        }
        self.track(&binding)?;
        Ok(())
    }
}
pub(super) fn turn_state(status: &TurnStatus) -> IntegrationTaskState {
    match status {
        TurnStatus::Running => IntegrationTaskState::Running,
        TurnStatus::Completed => IntegrationTaskState::Completed,
        TurnStatus::Interrupted => IntegrationTaskState::Cancelled,
        TurnStatus::Failed => IntegrationTaskState::Failed,
    }
}
