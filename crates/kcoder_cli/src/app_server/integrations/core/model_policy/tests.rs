use super::*;
use crate::app_server::integrations::office::native_host::NativeOfficePorts;
use crate::app_server::thread_runtime::test_support::test_runtime;
use kcoder_app_protocol::integrations::ModelPoliciesMethod;
use kcoder_config::Settings;
use serde_json::json;

pub(super) struct Fixture {
    _temp: tempfile::TempDir,
    pub(super) profile: std::path::PathBuf,
    pub(super) workspace: std::path::PathBuf,
    pub(super) context: NativeIntegrationContext,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = kcoder_config::PrivateDirectory::open_existing(temp.path()).unwrap();
        root.create_private_child(std::ffi::OsStr::new("profile"))
            .unwrap();
        root.create_private_child(std::ffi::OsStr::new("workspace"))
            .unwrap();
        let profile = temp.path().join("profile");
        let workspace = temp.path().join("workspace");
        let context = NativeIntegrationContext::capture(
            &profile,
            &workspace,
            "model-policy-owned-connection",
            "config-1",
        )
        .unwrap();
        Self {
            _temp: temp,
            profile,
            workspace,
            context,
        }
    }
    fn request(&self, operation: &str) -> IntegrationRequest {
        IntegrationRequest {
            contract_version: IntegrationContractVersion::ParallelV1,
            request_id: format!("request-{operation}"),
            scope: self.context.scope().clone(),
            operation_id: Some(operation.into()),
            expected_revision: None,
            timeout_ms: INTEGRATION_MAX_WAIT_MS,
            cancellation_ref: None,
            payload: Default::default(),
        }
    }
}

pub(super) fn setup() -> (Fixture, QueryEngine) {
    let fixture = Fixture::new();
    let mut settings:Settings=serde_json::from_value(json!({"active_provider":"Current","model":"manual","providers":{
        "Current":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":"http://127.0.0.1:9/v1","default_model":"manual","context_window_tokens":8192,"max_output_tokens":64,"output_headroom_tokens":64},
        "Chosen":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":"http://127.0.0.1:9/v1","default_model":"approved","context_window_tokens":8192,"max_output_tokens":64,"output_headroom_tokens":64}
    },"integrations":{"core":{"modelPolicies":[{"id":"business","candidates":[{"provider":"Chosen","model":"approved"}]}]}}})).unwrap();
    settings
        .apply_discovered_model("Current", "manual")
        .unwrap();
    fixture
        .context
        .profile()
        .unwrap()
        .atomic_replace(
            std::ffi::OsStr::new("settings.json"),
            &serde_json::to_vec(&settings).unwrap(),
        )
        .unwrap();
    let runtime = test_runtime(
        "native-policy-model",
        &fixture.workspace.join("model-history.jsonl"),
    );
    let engine = runtime
        .engine()
        .with_settings_persistence_path(fixture.profile.join("settings.json"));
    *engine.settings.write().unwrap() = settings;
    (fixture, engine)
}
pub(super) fn read_request(fixture: &Fixture) -> IntegrationRequest {
    let mut request = fixture.request("model-catalog-only");
    request.operation_id = None;
    request.payload.clear();
    request
}
fn selection_request(fixture: &Fixture, engine: &QueryEngine) -> IntegrationRequest {
    let version = engine
        .settings
        .read()
        .unwrap()
        .integrations
        .core
        .model_policies[0]
        .version()
        .unwrap();
    let mut request = read_request(fixture);
    request.payload = serde_json::to_value(IntegrationModelResolutionRequest {
        selection: IntegrationModelSelectionIntent::AutoPolicy {
            id: "business".into(),
            version,
        },
        requirements: IntegrationModelRequirements {
            input_tokens: Some(100),
            tools: true,
            ..Default::default()
        },
    })
    .unwrap()
    .as_object()
    .unwrap()
    .clone();
    request
}

#[tokio::test]
async fn real_private_native_context_and_office_port_resolve_explicit_auto_without_activating_or_granting_other_ports()
 {
    let (fixture, engine) = setup();
    let before = engine.active_model_configuration_summary().unwrap();
    let resolver = NativeModelPolicyResolver::capture(&fixture.context, &engine).unwrap();
    let catalog = resolver.read_policies(&read_request(&fixture)).unwrap();
    assert_eq!(catalog.policies[0].reference.id, "business");
    let request = selection_request(&fixture, &engine);
    let port = NativeOfficeModelPorts::capture(&fixture.context, &engine, None).unwrap();
    let reply = port
        .call(
            &fixture.context,
            IntegrationPort::Model,
            "resolveSelection",
            &request,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let IntegrationNullable::Value(value) = reply.result else {
        panic!("actual model result missing")
    };
    let resolved: IntegrationModelResolutionResult =
        serde_json::from_value(serde_json::Value::Object(value)).unwrap();
    assert_eq!(resolved.model.provider_id.as_deref(), Some("Chosen"));
    assert_eq!(resolved.model.model_id, "approved");
    assert_eq!(
        resolved.budget.reservation_state,
        IntegrationBudgetReservationState::NotReserved
    );
    assert_eq!(engine.active_model_configuration_summary().unwrap(), before);
    assert!(
        port.call(
            &fixture.context,
            IntegrationPort::Runtime,
            "acceptTask",
            &request,
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn public_read_has_actual_connection_lifetime_and_a_cancelled_or_foreign_scope_cannot_read() {
    let (fixture, engine) = setup();
    let owner = Arc::new(());
    let cancel = CancellationToken::new();
    let prepared = OwnedModelPolicyRequest::capture(
        &fixture.context,
        &engine,
        read_request(&fixture),
        ModelPoliciesMethod::ReadPolicies,
        Arc::downgrade(&owner),
        cancel.clone(),
    )
    .unwrap();
    drop(owner);
    assert!(prepared.run().await.is_err());
    let owner = Arc::new(());
    let prepared = OwnedModelPolicyRequest::capture(
        &fixture.context,
        &engine,
        read_request(&fixture),
        ModelPoliciesMethod::ReadPolicies,
        Arc::downgrade(&owner),
        cancel.clone(),
    )
    .unwrap();
    cancel.cancel();
    assert!(prepared.run().await.is_err());
    let mut request = selection_request(&fixture, &engine);
    request.scope.target_id = "untrusted-json-target".into();
    assert!(
        NativeModelPolicyResolver::capture(&fixture.context, &engine)
            .unwrap()
            .resolve(&request)
            .is_err()
    );
}

#[tokio::test]
async fn native_runtime_auto_model_gate_preserves_real_install_scope_and_allows_only_output_narrowing()
 {
    let (fixture, mut engine) = setup();
    let request = selection_request(&fixture, &engine);
    let resolver = NativeModelPolicyResolver::capture(&fixture.context, &engine).unwrap();
    let mut resolved = resolver.resolve(&request).unwrap();
    // A real native host applies its resolved model; this step is not authorized by the summary.
    // The production RuntimeDriver still requires its original policy/budget installer first.
    let settings = engine.settings.read().unwrap().clone();
    engine.settings = Arc::new(std::sync::RwLock::new(settings));
    engine
        .refresh_client_model_configuration(Some("Chosen::approved"))
        .unwrap();
    resolved.model = engine.active_model_configuration_summary().unwrap();
    validate_runtime_model(&fixture.context, &engine, &resolved).unwrap();
    engine.settings.write().unwrap().max_tokens = Some(32);
    resolved.model = engine.active_model_configuration_summary().unwrap();
    validate_runtime_model(&fixture.context, &engine, &resolved).unwrap();
    engine.settings.write().unwrap().max_tokens = Some(128);
    resolved.model = engine.active_model_configuration_summary().unwrap();
    assert!(validate_runtime_model(&fixture.context, &engine, &resolved).is_err());
    engine
        .settings
        .write()
        .unwrap()
        .integrations
        .core
        .model_policies[0]
        .enabled = false;
    assert!(validate_runtime_model(&fixture.context, &engine, &resolved).is_err());
}
