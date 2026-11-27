use futures::{Stream, StreamExt};
use kcoder_app_protocol::{SessionModesResult, ThreadSessionMode, TurnExecutionMode};
use kcoder_engine::{EngineEvent, QueryEngine};
use kcoder_permissions::PermissionPrompt;
use std::{pin::Pin, sync::Arc};
use tokio_util::sync::CancellationToken;

struct MoaTurnGuard(QueryEngine);
impl Drop for MoaTurnGuard {
    fn drop(&mut self) {
        self.0.clear_pending_moa_turn();
    }
}

pub fn mode(engine: &QueryEngine) -> ThreadSessionMode {
    match engine.state.session_mode() {
        kcoder_state::SessionMode::Default => ThreadSessionMode::Default,
        kcoder_state::SessionMode::Orchestrate => ThreadSessionMode::Orchestrate,
        kcoder_state::SessionMode::WorkflowDraft => ThreadSessionMode::WorkflowDraft,
    }
}

pub fn set_mode(engine: &QueryEngine, requested: ThreadSessionMode) -> anyhow::Result<()> {
    match requested {
        ThreadSessionMode::Orchestrate => {
            engine.state.enter_orchestrate_before_first_message()?;
        }
        ThreadSessionMode::WorkflowDraft => {
            anyhow::ensure!(
                engine.tools.get("WorkflowDraft").is_some(),
                "Workflow draft generation requires a tool profile with WorkflowDraft enabled"
            );
            engine.state.enter_workflow_draft_before_first_message()?;
        }
        ThreadSessionMode::Default if !engine.state.session_mode().is_default() => {
            anyhow::bail!("Session mode cannot be exited; start a new session")
        }
        _ => {}
    }
    Ok(())
}

pub fn inspect(engine: &QueryEngine) -> SessionModesResult {
    let (moa_plan_planners, moa_plan_error) = match engine.moa_plan_preflight() {
        Ok(preflight) => (preflight.planner_labels, None),
        Err(error) => (Vec::new(), Some(error.to_string())),
    };
    SessionModesResult {
        workflow_definition_id: engine.state.workflow_definition_id(),
        session_mode: mode(engine),
        moa_summary: engine.moa_status_summary(),
        moa_plan_planners,
        moa_plan_error,
        settings_template: None,
    }
}

pub fn stream(
    engine: QueryEngine,
    model_message: kcoder_types::Message,
    prompt: String,
    permissions: Box<dyn PermissionPrompt>,
    mode: TurnExecutionMode,
    cancel: CancellationToken,
) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send>> {
    if engine.state.session_mode() == kcoder_state::SessionMode::WorkflowDraft
        && mode != TurnExecutionMode::Standard
    {
        return Box::pin(futures::stream::once(async {
            EngineEvent::Error("Workflow draft sessions do not run MoA agents".into())
        }));
    }
    if mode != TurnExecutionMode::MoaPlan {
        return Box::pin(async_stream::stream! {
            let _moa_guard = (mode == TurnExecutionMode::Moa).then(|| MoaTurnGuard(engine.clone()));
            if mode == TurnExecutionMode::Moa { engine.enable_moa_for_next_turn(None); }
            let mut stream = engine.submit_message_content_stream_with_prompt(model_message, prompt, permissions.as_ref());
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

pub fn stream_async_question_answer(
    engine: QueryEngine,
    claim: kcoder_types::async_user_questions::AsyncQuestionDeliveryClaim,
    receipt_id: u64,
    permissions: Box<dyn PermissionPrompt>,
) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send>> {
    let Some(steer_session) = engine.begin_turn_steering() else {
        if let Some(owner) = engine.state.try_inspection_lifecycle_identity() {
            let _ = engine.state.mark_async_question_delivery_failed(
                &owner,
                &claim,
                "ordinary turn could not establish its steering session before input admission",
            );
        }
        return Box::pin(futures::stream::once(async {
            EngineEvent::Error(
                "Async answer delivery could not enter the ordinary turn runtime.".into(),
            )
        }));
    };
    Box::pin(async_stream::stream! {
        let mut stream = engine.submit_async_question_answer_stream_with_prompt(
            claim,
            receipt_id,
            permissions.as_ref(),
            steer_session,
        );
        while let Some(event) = stream.next().await {
            yield event;
        }
    })
}

pub fn continue_failed(
    engine: QueryEngine,
    permissions: Box<dyn PermissionPrompt>,
) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send>> {
    Box::pin(async_stream::stream! {
        // The user prompt and completed tool results are already in State. Do not
        // run UserPromptSubmit or append the prompt again on an explicit retry.
        let mut stream = engine.run_turn_stream_with_prompt(permissions.as_ref());
        while let Some(event) = stream.next().await { yield event; }
    })
}
