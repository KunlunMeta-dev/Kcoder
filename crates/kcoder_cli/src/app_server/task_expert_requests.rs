//! Next-turn expert selection is a mutation of the original leased task only.
use super::*;
use kcoder_app_protocol::{ThreadExpertParams, ThreadExpertResult, ThreadExpertTurn};
use sha2::{Digest, Sha256};

pub(super) fn verify_task_access(
    state: &ConnectionState,
    origin: &QueryEngine,
    thread: &str,
) -> Result<Vec<std::fs::File>> {
    ensure_task_client(state)?;
    // Event subscription only needs the persisted access facts; replaying a
    // live body on every frame would race its commits and cost O(history).
    thread_metadata::access::persisted_task_access(origin, thread).map(|(locks, _)| locks)
}

fn ensure_task_client(state: &ConnectionState) -> Result<()> {
    ensure!(
        state.initialized
            && !state.input_ended.is_cancelled()
            && !state.native_source_dispatch
            && state.native_source_accepted.is_none()
            && state.native_runtime_thread_initializer.is_none(),
        "AGENT_TASK_CLIENT_REQUIRED"
    );
    Ok(())
}

pub(super) async fn dispatch(
    id: Value,
    params: Value,
    origin: &QueryEngine,
    manager: &mut ThreadManager,
    state: &ConnectionState,
    outbound: &mpsc::Sender<Value>,
) -> Result<()> {
    let parsed = kcoder_app_rpc_codec::decode::<ThreadExpertParams>(params);
    let result = async {
        let params = parsed?;
        params.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            state.agent_turn_configuration_v1,
            "AGENT_TURN_CONFIGURATION_UNSUPPORTED"
        );
        ensure_task_client(state)?;
        let Some(engine) = manager.engine(&params.thread_id) else {
            // An evicted or never-resumed task is read from its persisted
            // sidecar without starting an Engine. A change still needs the
            // resident owner; this rejection precedes any mutation.
            ensure!(params.change.is_none(), "AGENT_ORIGINAL_TASK_UNAVAILABLE");
            let (_access, metadata) =
                thread_metadata::access::persisted_task_access(origin, &params.thread_id)?;
            let turns = expert_turns(origin, &params)?;
            return Ok(ThreadExpertResult {
                revision: metadata.agent_configuration_revision(),
                expert: metadata.agent_definition().cloned(),
                thread_id: params.thread_id,
                turns,
            });
        };
        // The resident engine and its lease are the authority for the live
        // history; a read or change during a running turn (including
        // compaction) must not depend on replaying a body that is committing.
        ensure_active_thread(&engine, manager.lease(&params.thread_id), &params.thread_id)?;
        let _access =
            thread_metadata::access::resident_task_access(origin, &engine, &params.thread_id)?;
        if let Some(change) = &params.change {
            let binding = integrations::agent_tasks::selection(&engine, change.expert.as_ref())?;
            engine
                .state
                .select_agent_definition(change.expected_revision, binding)?;
        }
        let (revision, expert) = engine.state.agent_configuration();
        let turns = expert_turns(&engine, &params)?;
        Ok(ThreadExpertResult {
            thread_id: params.thread_id,
            revision,
            expert,
            turns,
        })
    }
    .await;
    match result {
        Ok(result) => {
            send(
                outbound,
                success_response(id, serde_json::to_value(result)?),
            )
            .await
        }
        Err(error) => {
            let message = error.to_string();
            let kind = failure_code(&message);
            // Only a bounded code is logged; messages may carry paths or IDs.
            tracing::warn!(reason = kind, "thread/expert request failed");
            let mut response = error_response(id, -32087, &message);
            response["error"]["data"] = json!({ "kind": kind });
            send(outbound, response).await
        }
    }
}

fn expert_turns(
    storage: &QueryEngine,
    params: &ThreadExpertParams,
) -> Result<Vec<ThreadExpertTurn>> {
    let mut turns = Vec::new();
    if params.include_turns.unwrap_or(true)
        && let Some(store) = kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing(
            &storage.session_storage_dir_for(&params.thread_id),
            &params.thread_id,
        )?
    {
        let mut records = store.list()?;
        records.sort_by_key(|record| record.accepted_at_ms);
        for record in records.into_iter().rev().take(100) {
            if let Some(snapshot) = store.load_agent_snapshot(&record.identity)? {
                let effective_definition_sha256 = snapshot
                    .effective_definition
                    .as_ref()
                    .map(|definition| {
                        serde_json::to_vec(definition)
                            .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
                    })
                    .transpose()?;
                turns.push(ThreadExpertTurn {
                    identity: record.identity,
                    selection_revision: snapshot.selection_revision,
                    expert: snapshot.binding,
                    personalization_revision: snapshot.personalization_revision,
                    effective_definition_sha256,
                });
            }
        }
    }
    Ok(turns)
}

/// Reduce a failure to a stable code for diagnostics.
fn failure_code(message: &str) -> &str {
    let code = message
        .split(|c: char| !(c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
        .next()
        .unwrap_or_default();
    if (3..=80).contains(&code.len()) && code.starts_with(|c: char| c.is_ascii_uppercase()) {
        return code;
    }
    [
        ("history source changed", "HISTORY_SOURCE_CHANGED"),
        (
            "history commit is in progress",
            "HISTORY_COMMIT_IN_PROGRESS",
        ),
        ("persisted thread not found", "PERSISTED_THREAD_NOT_FOUND"),
        (
            "thread/start or thread/resume is required",
            "THREAD_NOT_RESIDENT",
        ),
        ("threadId does not match", "THREAD_MISMATCH"),
    ]
    .into_iter()
    .find_map(|(phrase, code)| message.contains(phrase).then_some(code))
    .unwrap_or("OTHER")
}

#[cfg(test)]
mod tests {
    use super::failure_code;

    #[test]
    fn diagnostics_keep_only_a_bounded_failure_code() {
        assert_eq!(
            failure_code("CHAT_TASK_LIFECYCLE_BUSY"),
            "CHAT_TASK_LIFECYCLE_BUSY"
        );
        assert_eq!(
            failure_code("persisted thread not found: secret-thread"),
            "PERSISTED_THREAD_NOT_FOUND"
        );
        assert_eq!(failure_code("failed to open /home/user/.config/x"), "OTHER");
    }
}
