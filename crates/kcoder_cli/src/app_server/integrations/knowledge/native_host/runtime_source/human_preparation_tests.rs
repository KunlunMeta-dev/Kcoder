//! A fixed Human decision uses the original source budget without adding tools.
use super::*;

#[tokio::test]
async fn fixed_human_definition_keeps_original_native_tool_ceiling_and_lifetime() -> Result<()> {
    let mut fixture = Fixture::new()?;
    let calls = Arc::new(AtomicUsize::new(0));
    fixture.engine = actual_engine(&fixture, calls.clone())?;
    fixture.native.refresh_configuration_revision(
        fixture
            .engine
            .active_model_configuration_summary()?
            .revision,
    )?;
    let library =
        kcoder_workflow::store::WorkflowStore::new(fixture.profile.join("workflow-library"));
    let definition = library.create(
        "Explicit bounded decision",
        "No new tool or source permissions",
    )?;
    let definition = library.upsert_node(&definition.id, definition.revision,
        serde_json::from_value(json!({"id":"decision","title":"Decision","kind":"human","config":{"human":{"prompt":"Approve the bounded calculation?","responseSchema":{"type":"boolean"},"timeoutMs":60_000}}}))?)?;
    let definition = library.save(&definition.id, definition.revision)?;
    let draft = AutomationSubscriptionDraft {
        id: "real-runtime-subscription".into(),
        title: "Original Human source".into(),
        workflow_id: definition.id,
        workflow_version: 1,
        model_selection: None,
        inputs: json!({}),
        schedule: Some(kcoder_types::CronSchedule::Every { every_seconds: 60 }),
        event_source: None,
        maximum_tokens: 1000,
        period_budget: None,
        maximum_runtime_seconds: 2,
        delivery: AutomationDestination::Studio,
    };
    let (host, request) = fixture.run_draft(draft).await?;
    let prepared = prepare_native_automation_runtime(
        &fixture.native,
        &fixture.engine,
        host,
        &request,
        None,
        &CancellationToken::new(),
    )?;
    prepared
        .authority
        .verify_admission(&fixture.native, &request, &prepared.task)?;
    assert_eq!(prepared.authority.workflow_timeout_seconds(), Some(2));
    assert_eq!(
        prepared.task.configuration.allowed_tools,
        Some(vec!["Workflow".into(), "AutomationSourceRead".into()])
    );
    assert_eq!(
        prepared.task.configuration.external_send,
        crate::app_server::integrations::core::runtime_driver::RuntimeExternalSend::Deny
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(
        !fixture.profile.join("workflow-runs").exists(),
        "Preparing a decision must not execute it"
    );
    Ok(())
}
