use super::AppServerPermissionPrompt;
use futures::{Stream, StreamExt};
use kcoder_app_protocol::{SessionModesResult, ThreadSessionMode, TurnExecutionMode};
use kcoder_engine::{EngineEvent, QueryEngine};
use std::{pin::Pin, sync::Arc};
use tokio_util::sync::CancellationToken;

struct MoaTurnGuard(QueryEngine);
impl Drop for MoaTurnGuard {
    fn drop(&mut self) {
        self.0.clear_pending_moa_turn();
    }
}

pub(super) fn mode(engine: &QueryEngine) -> ThreadSessionMode {
    if engine.state.session_mode().is_orchestrate() {
        ThreadSessionMode::Orchestrate
    } else {
        ThreadSessionMode::Default
    }
}

pub(super) fn set_mode(engine: &QueryEngine, requested: ThreadSessionMode) -> anyhow::Result<()> {
    match requested {
        ThreadSessionMode::Orchestrate => {
            engine.state.enter_orchestrate_before_first_message()?;
        }
        ThreadSessionMode::Default if engine.state.session_mode().is_orchestrate() => {
            anyhow::bail!("Orchestrate mode cannot be exited; start a new session")
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn inspect(engine: &QueryEngine) -> SessionModesResult {
    let (moa_plan_planners, moa_plan_error) = match engine.moa_plan_preflight() {
        Ok(preflight) => (preflight.planner_labels, None),
        Err(error) => (Vec::new(), Some(error.to_string())),
    };
    SessionModesResult {
        session_mode: mode(engine),
        moa_summary: engine.moa_status_summary(),
        moa_plan_planners,
        moa_plan_error,
        settings_template: None,
    }
}

pub(super) fn stream(
    engine: QueryEngine,
    model_message: kcoder_types::Message,
    prompt: String,
    permissions: AppServerPermissionPrompt,
    mode: TurnExecutionMode,
    cancel: CancellationToken,
) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send>> {
    if mode != TurnExecutionMode::MoaPlan {
        return Box::pin(async_stream::stream! {
            let _moa_guard = (mode == TurnExecutionMode::Moa).then(|| MoaTurnGuard(engine.clone()));
            if mode == TurnExecutionMode::Moa { engine.enable_moa_for_next_turn(None); }
            let mut stream = engine.submit_message_content_stream(model_message, prompt, &permissions);
            while let Some(event) = stream.next().await { yield event; }
        });
    }
    Box::pin(async_stream::stream! {
        let (tx, mut rx) = tokio::sync::mpsc::channel(32);
        let progress = Arc::new(move |update: kcoder_engine::MoaPlanProgress| { let _ = tx.try_send(update); });
        let planning = engine.run_moa_plan_with_progress(&prompt, progress);
        tokio::pin!(planning);
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => { yield EngineEvent::StreamAborted { reason: "MoA planning cancelled".into() }; break; }
                Some(progress) = rx.recv() => { yield EngineEvent::SystemNotice(format!("MoA plan ({}/{}): {}", progress.completed, progress.total, progress.message)); }
                result = &mut planning => {
                    match result {
                        Ok(result) => yield EngineEvent::AssistantTextDelta(result.final_markdown),
                        Err(error) => yield EngineEvent::Error(format!("MoA plan failed: {error}")),
                    }
                    break;
                }
            }
        }
    })
}

pub(super) fn continue_failed(
    engine: QueryEngine,
    permissions: AppServerPermissionPrompt,
) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send>> {
    Box::pin(async_stream::stream! {
        // The user prompt and completed tool results are already in State. Do not
        // run UserPromptSubmit or append the prompt again on an explicit retry.
        let mut stream = engine.run_turn_stream(&permissions);
        while let Some(event) = stream.next().await { yield event; }
    })
}
