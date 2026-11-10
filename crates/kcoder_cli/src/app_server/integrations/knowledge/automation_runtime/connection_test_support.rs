//! Real resident, original admission journal and JavaScript workflow for controlled event-source tests.
use super::*;
use crate::app_server::integrations::core::runtime_driver::{
    NativeRuntimeCommand, NativeRuntimeDriver, RuntimeSubmission,
};
use crate::app_server::{
    BackgroundEventPump, BackgroundFollowupScheduler, BackgroundFollowupState,
    BackgroundProjectionState, InteractionReceipts, ResidentTurnState, SessionLease, ThreadManager,
    ThreadRuntime,
};
use std::sync::atomic::AtomicU64;
use tokio::time::{Duration, timeout};

pub(crate) async fn execute_code(
    native: &NativeIntegrationContext,
    engine: &QueryEngine,
    host: Arc<NativeKnowledgeHost>,
    request: &IntegrationRequest,
) -> Result<IntegrationRuntimeTask> {
    let history = native
        .profile_path()?
        .join(format!("event-history-{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&history);
    let projection = Arc::new(tokio::sync::Mutex::new(BackgroundProjectionState::default()));
    let followups = Arc::new(BackgroundFollowupState::default());
    let (tx, _rx) = tokio::sync::mpsc::channel(64);
    let turn = ResidentTurnState::new(
        tx.clone(),
        kcoder_config::PermissionMode::Ask,
        Arc::new(AtomicU64::new(2_000_000)),
        Arc::new(Mutex::new(InteractionReceipts::default())),
    );
    let pump = BackgroundEventPump::spawn(engine, projection.clone(), followups.clone(), tx);
    let runtime = ThreadRuntime::new(
        engine.clone(),
        SessionLease::acquire(&history)?,
        projection,
        followups,
        (pump, BackgroundFollowupScheduler::disabled_for_test()),
        turn,
    );
    let mut manager = ThreadManager::default();
    ensure!(
        manager.insert(runtime).is_ok(),
        "event resident already owned"
    );
    let result = async {
        let prepared = super::prepare_native_automation_runtime_for_resident(
            native,
            &manager,
            &engine.session_id(),
            host,
            request,
            None,
            &CancellationToken::new(),
        )?;
        prepared
            .authority
            .verify_admission(native, request, &prepared.task)?;
        let operation = request
            .operation_id
            .as_deref()
            .context("event operation missing")?;
        let mut driver = NativeRuntimeDriver::initialize(native, operation)?;
        ensure!(
            matches!(
                driver.accept_task(native, request, prepared.task)?,
                RuntimeSubmission::Queued
            ),
            "event not accepted"
        );
        let NativeRuntimeCommand::Configure { ticket, .. } = driver
            .next_command(native)?
            .context("event configure missing")?
        else {
            anyhow::bail!("event wrong configure");
        };
        driver.configure_command(
            native,
            &ticket,
            &mut manager,
            Some(prepared.authority.installer()),
        )?;
        let NativeRuntimeCommand::StartWorkflow {
            ticket, thread_id, ..
        } = driver
            .next_command(native)?
            .context("event workflow missing")?
        else {
            anyhow::bail!("event wrong workflow");
        };
        let actor = manager
            .engine(&thread_id)
            .context("event resident missing")?;
        let job = driver.prepare_workflow_launch(
            native,
            &ticket,
            actor.clone(),
            Some(prepared.authority.clone()),
        )?;
        driver.observe_workflow_launch(native, &ticket, job.run().await)?;
        let task = timeout(Duration::from_secs(10), async {
            loop {
                driver.refresh_workflow(native, operation)?;
                let task = driver.read_task(native, operation)?;
                if matches!(
                    task.state,
                    IntegrationTaskState::Completed
                        | IntegrationTaskState::Failed
                        | IntegrationTaskState::Cancelled
                ) {
                    break Ok::<_, anyhow::Error>(task);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await??;
        ensure!(
            task.state == IntegrationTaskState::Completed,
            "actual event workflow failed: {:?}",
            task.state
        );
        driver.observe_workflow_output(native, operation, &actor)?;
        let task = driver.read_task(native, operation)?;
        prepared.authority.observe_task(native, request, &task)?;
        ensure!(
            task.output
                .as_deref()
                .is_some_and(|output| output.contains("verified") && output.contains("true")),
            "actual event Code output missing"
        );
        ensure!(
            prepared
                .authority
                .observed_native_model_calls_for_test()?
                .is_empty(),
            "actual event Code unexpectedly used a model"
        );
        Ok(task)
    }
    .await;
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
    result
}
