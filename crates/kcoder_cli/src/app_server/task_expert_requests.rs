//! Next-turn expert selection is a mutation of the original leased task only.
use super::*;
use kcoder_app_protocol::{ThreadExpertParams, ThreadExpertResult, ThreadExpertTurn};
use sha2::{Digest, Sha256};

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
        let engine = manager
            .engine(&params.thread_id)
            .context("AGENT_ORIGINAL_TASK_UNAVAILABLE")?;
        let _access = integrations::connectivity::task_ui::verify_expert_control(
            state,
            &engine,
            &params.thread_id,
        )?;
        ensure!(
            manager
                .lease(&params.thread_id)
                .is_some_and(|lease| lease.matches_target(&engine.session_lease_target())),
            "AGENT_ORIGINAL_TASK_LEASE_CHANGED"
        );
        if let Some(change) = &params.change {
            let binding = integrations::agent_tasks::selection(&engine, change.expert.as_ref())?;
            engine
                .state
                .select_agent_definition(change.expected_revision, binding)?;
        }
        let (revision, expert) = engine.state.agent_configuration();
        let mut turns = Vec::new();
        if let Some(store) = kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing(
            &engine.session_storage_dir_for(&params.thread_id),
            &params.thread_id,
        )? {
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
        Err(error) => send(outbound, error_response(id, -32087, &error.to_string())).await,
    }
}
