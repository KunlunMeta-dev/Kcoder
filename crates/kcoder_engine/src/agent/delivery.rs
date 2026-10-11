//! Agent delivery; state ownership is retained by the agent facade.

use super::*;

impl QueryEngine {
    /// Apply reliable messages at complete provider/tool boundaries in a forked child.
    ///
    /// Each message first leases the queue head and records a transcript anchor, then
    /// writes the user message to an atomic checkpoint, and only then acknowledges it.
    /// The caller may issue the next provider request only after this function succeeds.
    pub(crate) async fn apply_pending_subagent_deliveries_at_safe_boundary(
        &self,
    ) -> anyhow::Result<Vec<AppliedSubagentSteer>> {
        let Some(control) = self.subagent_runtime_control.as_ref() else {
            return Ok(Vec::new());
        };
        let Some(task) = control.parent_state.task(&control.agent_id) else {
            // Internal forks, MoA runs, and some tests do not create resumable tasks and therefore have no reliable queue.
            return Ok(Vec::new());
        };
        if !matches!(
            task.status,
            kcoder_state::TaskStatus::Pending | kcoder_state::TaskStatus::Running
        ) || !task.accepting_subagent_messages
        {
            return Ok(Vec::new());
        }
        if !unmatched_tool_use_ids(&self.state.messages()).is_empty() {
            anyhow::bail!(
                "refusing to apply a sub-agent delivery inside an incomplete tool protocol"
            );
        }

        let lease_timeout_seconds = task.delivery_lease_timeout_seconds.clamp(30, 3600);
        let max_attempts = task.delivery_max_attempts.clamp(1, 64);
        let mut applied = Vec::new();

        for _ in 0..MAX_LIVE_SUBAGENT_DELIVERIES_PER_BOUNDARY {
            if !control
                .parent_state
                .task(&control.agent_id)
                .is_some_and(|task| {
                    matches!(
                        task.status,
                        kcoder_state::TaskStatus::Pending | kcoder_state::TaskStatus::Running
                    ) && task.accepting_subagent_messages
                })
            {
                break;
            }
            let claim = match control.parent_state.claim_next_subagent_delivery(
                &control.agent_id,
                lease_timeout_seconds,
                max_attempts,
            )? {
                AgentDeliveryClaimOutcome::Claimed(claim) => claim,
                AgentDeliveryClaimOutcome::Empty
                | AgentDeliveryClaimOutcome::Busy { .. }
                | AgentDeliveryClaimOutcome::Blocked { .. } => break,
            };

            let before_messages = self.state.messages();
            let mut messages = before_messages.clone();
            let reconcile = (|| -> Result<(), AgentError> {
                let body_sha256 = format!("{:x}", Sha256::digest(claim.body.as_bytes()));
                let anchor = if let Some(anchor) = claim.transcript_anchor.clone() {
                    if anchor.body_sha256 != body_sha256 {
                        return Err(AgentError::Execution(format!(
                            "delivery {} body changed after it was leased",
                            claim.message_id
                        )));
                    }
                    anchor
                } else {
                    let anchor = kcoder_state::TranscriptDeliveryAnchor {
                        baseline_message_count: messages.len(),
                        baseline_sha256: transcript_messages_sha256(&messages)?,
                        body_sha256,
                    };
                    let prepared = control
                        .parent_state
                        .prepare_subagent_delivery(
                            &control.agent_id,
                            &claim.message_id,
                            &claim.lease_id,
                            anchor.clone(),
                        )
                        .map_err(|error| AgentError::Execution(error.to_string()))?;
                    if !prepared {
                        return Err(AgentError::Execution(format!(
                            "delivery {} disappeared before transcript preparation",
                            claim.message_id
                        )));
                    }
                    anchor
                };

                if messages.len() < anchor.baseline_message_count {
                    return Err(AgentError::Execution(format!(
                        "delivery {} transcript is shorter than its persisted baseline",
                        claim.message_id
                    )));
                }
                let baseline = &messages[..anchor.baseline_message_count];
                if transcript_messages_sha256(baseline)? != anchor.baseline_sha256 {
                    return Err(AgentError::Execution(format!(
                        "delivery {} transcript baseline changed; refusing duplicate insertion",
                        claim.message_id
                    )));
                }
                if messages.len() == anchor.baseline_message_count {
                    messages.push(Message::user_text(claim.body.clone()));
                } else if !is_exact_delivery_message(
                    &messages[anchor.baseline_message_count],
                    &claim.body,
                ) {
                    return Err(AgentError::Execution(format!(
                        "delivery {} transcript anchor points to a different message",
                        claim.message_id
                    )));
                }
                Ok(())
            })();

            if let Err(error) = reconcile {
                let _ = control.parent_state.fail_subagent_delivery(
                    &control.agent_id,
                    &claim.message_id,
                    &claim.lease_id,
                    max_attempts,
                    &error.to_string(),
                );
                return Err(anyhow::Error::new(error));
            }

            self.state.set_messages(messages);
            if let Err(error) = control
                .checkpoint_writer
                .write(&control.transcript_path, &self.state.messages())
                .await
            {
                self.state.set_messages(before_messages);
                let _ = control.parent_state.fail_subagent_delivery(
                    &control.agent_id,
                    &claim.message_id,
                    &claim.lease_id,
                    max_attempts,
                    &error.to_string(),
                );
                return Err(error);
            }
            let acknowledged = if let Some(expected) = control.expected_background_run.as_ref() {
                control.parent_state.ack_subagent_delivery_for_run(
                    &control.agent_id,
                    &claim.message_id,
                    &claim.lease_id,
                    expected,
                )?
            } else {
                control.parent_state.ack_subagent_delivery(
                    &control.agent_id,
                    &claim.message_id,
                    &claim.lease_id,
                )?
            };
            if !acknowledged {
                anyhow::bail!(
                    "delivery {} disappeared after its transcript checkpoint was committed",
                    claim.message_id
                );
            }
            let queue_depth = control
                .parent_state
                .task(&control.agent_id)
                .map(|task| task.message_queue.len())
                .unwrap_or_default();
            applied.push(AppliedSubagentSteer {
                agent_id: control.agent_id.clone(),
                message_id: claim.message_id.clone(),
                queue_depth,
                message_index: claim
                    .transcript_anchor
                    .as_ref()
                    .map(|anchor| anchor.baseline_message_count)
                    .unwrap_or(before_messages.len()),
                text: claim.body,
                client_message_id: control
                    .parent_state
                    .task(&control.agent_id)
                    .and_then(|task| {
                        task.command_receipts
                            .into_iter()
                            .find(|receipt| receipt.message_id == claim.message_id)
                            .map(|receipt| receipt.client_message_id)
                    }),
            });
        }

        Ok(applied)
    }
}
