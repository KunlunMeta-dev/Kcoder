//! Two actual native Workflow tasks share the persisted original subscription window.
use super::*;
async fn execute(
    f: &Fixture,
    host: Arc<NativeKnowledgeHost>,
    request: &IntegrationRequest,
) -> Result<IntegrationRuntimeTask> {
    let mut manager = manager(
        f.engine.clone(),
        &f._root
            .path()
            .join(format!("history-{}.jsonl", f.engine.session_id())),
    )
    .await?;
    let result = async {
        let prepared = prepare_native_automation_runtime_for_resident(
            &f.native,
            &manager,
            &f.engine.session_id(),
            host.clone(),
            request,
            None,
            &CancellationToken::new(),
        )?;
        let mut driver =
            NativeRuntimeDriver::initialize(&f.native, request.operation_id.as_deref().unwrap())?;
        prepared
            .authority
            .verify_admission(&f.native, request, &prepared.task)?;
        ensure!(
            matches!(
                driver.accept_task(&f.native, request, prepared.task.clone())?,
                RuntimeSubmission::Queued
            ),
            "period task not queued"
        );
        let NativeRuntimeCommand::Configure { ticket, .. } = driver
            .next_command(&f.native)?
            .context("configure missing")?
        else {
            anyhow::bail!("wrong configure")
        };
        driver.configure_command(
            &f.native,
            &ticket,
            &mut manager,
            Some(prepared.authority.installer()),
        )?;
        let NativeRuntimeCommand::StartWorkflow {
            ticket, thread_id, ..
        } = driver.next_command(&f.native)?.context("start missing")?
        else {
            anyhow::bail!("wrong start")
        };
        let engine = manager
            .engine(&thread_id)
            .context("actual engine missing")?;
        let job = driver.prepare_workflow_launch(
            &f.native,
            &ticket,
            engine.clone(),
            Some(prepared.authority.clone()),
        )?;
        driver.observe_workflow_launch(&f.native, &ticket, job.run().await)?;
        let operation = request.operation_id.as_deref().unwrap();
        let mut task = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                driver.refresh_workflow(&f.native, operation)?;
                let task = driver.read_task(&f.native, operation)?;
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
        if task.state == IntegrationTaskState::Completed {
            driver.observe_workflow_output(&f.native, operation, &engine)?;
            task = driver.read_task(&f.native, operation)?;
            ensure!(
                task.output.is_some(),
                "actual completed output was not observed"
            );
        }
        prepared.authority.observe_task(&f.native, request, &task)?;
        let operations = crate::app_server::integrations::core::NativeOperations::load(&f.native)?
            .context("native operations missing")?;
        let receipt = operations
            .read(&f.native, operation)?
            .context("native receipt missing")?;
        let acceptance = receipt
            .runtime_acceptance
            .context("native acceptance missing")?;
        let store = host.observe_automation()?.context("automation missing")?;
        let run = request.payload["source"]["runId"].as_str().unwrap();
        store
            .store
            .record_native_acceptance_receipt(run, &acceptance, 1_000_000)?;
        store.store.record_native_status(
            run,
            if task.state == IntegrationTaskState::Completed {
                AutomationRunStatus::Completed
            } else {
                AutomationRunStatus::Failed
            },
            task.output.clone(),
            vec![],
            1_000_001,
        )?;
        Ok(task)
    }
    .await;
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
    result
}
#[tokio::test]
async fn persisted_period_budget_limits_second_actual_native_task_without_reset_or_another_provider_call()
-> Result<()> {
    let period = AutomationPeriodBudget {
        window_seconds: 86400,
        maximum_tokens: 50_000,
        maximum_model_calls: 2,
    };
    let (mut f, host, first, calls) =
        prepared_fixture_with_period_case(50_000, false, false, None).await?;
    let first_task = execute(&f, host.clone(), &first).await?;
    ensure!(
        first_task.state == IntegrationTaskState::Completed,
        "first actual task failed: {:?}",
        first_task.state
    );
    ensure!(
        calls.load(Ordering::SeqCst) == 2,
        "first task did not read its actual source"
    );
    let service = crate::app_server::integrations::core::NativeBudgetService::load(&f.native)?
        .context("original budget missing")?;
    let key = format!(
        "automation-sub-{:x}",
        Sha256::digest(serde_json::to_vec(&(
            IntegrationOwner::from(f.native.scope()),
            "real-runtime-subscription"
        ))?)
    );
    let now = u64::try_from(chrono::Utc::now().timestamp_millis())?;
    let policy=crate::app_server::integrations::knowledge::automation_runtime::budget::period_budget::policy(&key,1,&period,now)?;
    assert!(
        service
            .accounting_store()
            .observe_policy(&policy)?
            .is_none()
    );
    f.engine = actual_engine(&f, calls.clone())?;
    f.native
        .refresh_configuration_revision(f.engine.active_model_configuration_summary()?.revision)?;
    let host = f.host()?;
    let owned = host.observe_automation()?.context("store missing")?;
    let mut sub = owned.store.read_subscription("real-runtime-subscription")?;
    sub.draft.period_budget = Some(period.clone());
    sub.draft.schedule = Some(kcoder_types::CronSchedule::Every { every_seconds: 1 });
    let preview_request = f.request(None, json!({"draft":sub.draft,"consentRef":"preview-only"}));
    let preview = host
        .automation(
            "previewSubscription",
            &preview_request,
            false,
            now,
            &CancellationToken::new(),
        )
        .await;
    ensure!(
        preview.status == IntegrationStatus::Completed,
        "actual period preview rejected"
    );
    let value = serde_json::to_value(&preview.result)?;
    ensure!(
        value["periodBudget"]["chargedTokens"] == 280
            && value["periodBudget"]["chargedModelCalls"] == 2,
        "preview lost original unperiodized consumption: {value}"
    );
    ensure!(
        service
            .accounting_store()
            .observe_policy(&policy)?
            .is_none(),
        "preview installed a policy"
    );
    let mut save = f.request(
        Some("explicit-enable-existing-period"),
        json!({"draft":sub.draft,"consentRef":"native-explicit-existing-budget"}),
    );
    save.expected_revision = Some(sub.revision.to_string());
    let saved = host
        .automation(
            "saveSubscription",
            &save,
            true,
            now,
            &CancellationToken::new(),
        )
        .await;
    ensure!(
        saved.status == IntegrationStatus::Completed,
        "period configuration did not update the original subscription"
    );
    let sub = owned.store.read_subscription("real-runtime-subscription")?;
    ensure!(
        sub.revision == 2 && sub.draft.period_budget.as_ref() == Some(&period),
        "period config was not persisted in the original subscription"
    );
    let policy=crate::app_server::integrations::knowledge::automation_runtime::budget::period_budget::policy(&key,sub.revision,&period,now)?;
    let due = sub.next_fire_at_ms.unwrap();
    let actual_now = u64::try_from(chrono::Utc::now().timestamp_millis())?;
    tokio::time::sleep(Duration::from_millis(
        due.saturating_sub(actual_now).saturating_add(10),
    ))
    .await;
    let run = owned.store.prepare_run(
        &sub.draft.id,
        sub.revision,
        "second-original-trigger",
        json!({"fact":"second persisted trigger"}),
        Some(due + 60_000),
        due,
    )?;
    ensure!(
        owned.store.claim_native_submission(&run.id)?,
        "second submission already claimed"
    );
    let mut second = first.clone();
    second.operation_id = Some(run.native_operation_id.clone());
    second.request_id = "second-actual-native-request".into();
    second.scope = f.native.scope().clone();
    second.payload["source"]["runId"] = json!(run.id);
    second.payload["source"]["subscriptionRevision"] = json!(sub.revision);
    second.payload["source"]["consentRef"] = json!(sub.consent_ref);
    let second_task = execute(&f, host, &second).await?;
    ensure!(
        second_task.state == IntegrationTaskState::Failed,
        "period exhaustion did not stop the actual second task"
    );
    ensure!(
        calls.load(Ordering::SeqCst) == 2,
        "period exhaustion reached another Provider request"
    );
    let after = service.accounting_store().observe_policy(&policy)?.unwrap();
    ensure!(
        after.charged.tokens == 280
            && after.charged.model_calls == 2
            && after.active_tasks == 0
            && after.active_calls == 0,
        "period accounting changed or leaked leases"
    );
    ensure!(
        after.unknown_cost_reservations == 2 && after.charged.cost_micros.is_none(),
        "unknown cost was lost"
    );
    Ok(())
}
