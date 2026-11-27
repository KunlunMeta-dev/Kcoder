use super::*;
use crate::app_server::integrations::core::{
    NativeDomain, NativeDomainGuard, NativeIntegrationContext, runtime_driver::NativeRuntimeDriver,
    runtime_pump::NativeRuntimePump,
};
use kcoder_app_protocol::integrations::knowledge_host::IntegrationKnowledgeMethod;

#[tokio::test]
async fn first_knowledge_request_binds_original_runtime_before_scheduler_can_retire_its_host()
-> Result<()> {
    let temporary = tempfile::tempdir()?;
    let root = kcoder_config::PrivateDirectory::open_existing(temporary.path())?;
    let profile = root.create_private_child(std::ffi::OsStr::new("profile"))?;
    root.create_private_child(std::ffi::OsStr::new("workspace"))?;
    profile.atomic_replace(std::ffi::OsStr::new("settings.json"), b"{}")?;
    let profile_path = temporary.path().join("profile");
    let workspace = temporary.path().join("workspace");
    let engine = crate::app_server::tests::catalog_list_test_engine(&workspace)
        .with_settings_persistence_path(profile_path.join("settings.json"));
    {
        let mut settings = engine.settings.write().unwrap();
        settings.training_mode = false;
        settings.integrations.knowledge.publications_enabled = true;
        settings.integrations.knowledge.business_automation_enabled = true;
    }
    let native = NativeIntegrationContext::capture(
        &profile_path,
        &workspace,
        "native-cold-knowledge-binding-test",
        &engine.active_model_configuration_summary()?.revision,
    )?;
    let request = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "first-read-before-tick".into(),
        scope: native.scope().clone(),
        operation_id: None,
        expected_revision: None,
        timeout_ms: 10_000,
        cancellation_ref: None,
        payload: serde_json::Map::new(),
    };
    let (pump, client) = NativeRuntimePump::new();
    let mut state = ConnectionState {
        initialized: true,
        integration_knowledge_v1: true,
        integration_context: Some(native.recapture_for_owned_service()?),
        integration_runtime: Some(client),
        ..Default::default()
    };
    let (outbound, mut received) = tokio::sync::mpsc::channel(8);
    assert!(
        crate::app_server::integration_requests::dispatch_knowledge(
            IntegrationKnowledgeMethod::ListPublications.wire_name(),
            &serde_json::json!(1),
            &serde_json::to_value(request)?,
            &engine,
            &outbound,
            &mut state,
        )
        .await?
    );
    tokio::time::timeout(
        Duration::from_secs(5),
        state.knowledge_rpc_tasks.join_next(),
    )
    .await?
    .context("original knowledge job missing")??;
    let reply = received.recv().await.context("original reply missing")?;
    assert_eq!(reply["result"]["status"], "completed");
    assert_eq!(
        reply["result"]["result"]["page"]["items"],
        serde_json::json!([])
    );
    let original = {
        let mut cache = state.integration_knowledge.lock().await;
        assert!(
            cache.has_native_runtime_binding(),
            "the first public Knowledge job must bind its existing Runtime before creating the shared Host"
        );
        cache.host_for_engine(&native, &engine)?
    };
    assert!(original.runtime_sources_current());
    assert!(NativeAutomationScheduler::default().queue_tick(&engine, &mut state));
    tokio::time::timeout(
        Duration::from_secs(5),
        state.knowledge_rpc_tasks.join_next(),
    )
    .await?
    .context("original scheduler job missing")??;
    let current = state
        .integration_knowledge
        .lock()
        .await
        .host_for_engine(&native, &engine)?;
    assert!(Arc::ptr_eq(&original, &current));
    assert!(original.runtime_sources_current());
    for domain in [
        NativeDomain::Knowledge,
        NativeDomain::Automation,
        NativeDomain::Operations,
    ] {
        assert!(
            NativeDomainGuard::observe(native.profile()?, native.scope(), domain)?.is_none(),
            "a cold readonly request/tick cannot create a domain store"
        );
    }
    assert!(NativeRuntimeDriver::load(&native)?.is_none());
    state.input_ended.cancel();
    pump.close().await;
    Ok(())
}
