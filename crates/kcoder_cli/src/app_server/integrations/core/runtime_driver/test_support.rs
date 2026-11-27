//! Shared real native fixture for driver and connection pump regressions.
use super::*;
use crate::app_server::thread_runtime::{ThreadManager, test_support::test_runtime};
use kcoder_app_protocol::UserInput;
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use kcoder_types::{ModelConfigurationBoundary, StudioWorkMode};
use serde_json::json;
use std::path::PathBuf;

pub(crate) struct Fixture {
    _temp: tempfile::TempDir,
    viewer: crate::app_server::ConnectionState,
    pub(crate) profile: PathBuf,
    pub(crate) workspace: PathBuf,
    pub(crate) context: NativeIntegrationContext,
}
impl Fixture {
    pub(crate) fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = PrivateDirectory::open_existing(temp.path()).unwrap();
        root.create_private_child(OsStr::new("profile")).unwrap();
        root.create_private_child(OsStr::new("workspace")).unwrap();
        let profile = temp.path().join("profile");
        let workspace = temp.path().join("workspace");
        let context =
            NativeIntegrationContext::capture(&profile, &workspace, "connection-1", "config-1")
                .unwrap();
        Self {
            _temp: temp,
            viewer: crate::app_server::ConnectionState::default(),
            profile,
            workspace,
            context,
        }
    }
    pub(crate) fn request(&self, operation: &str) -> IntegrationRequest {
        IntegrationRequest { contract_version: IntegrationContractVersion::ParallelV1,
            request_id: format!("request-{operation}"), scope: self.context.scope().clone(), operation_id: Some(operation.into()),
            expected_revision: None, timeout_ms: INTEGRATION_MAX_WAIT_MS, cancellation_ref: None,
            payload: json!({"source":{"kind":"office_assistant","assistantId":"fixed-template","version":1},"message":{"text":"Process original input"}}).as_object().unwrap().clone() }
    }
    pub(crate) fn spec(&self) -> PreparedRuntimeTask {
        let settings = kcoder_config::Settings {
            model: "fixture-model".into(),
            ..crate::test_fixtures::settings_with_default_provider()
        };
        let summary = kcoder_engine::model_configuration_summary(
            &settings,
            ModelConfigurationBoundary::SessionSnapshot,
        )
        .unwrap();
        PreparedRuntimeTask {
            input: vec![UserInput::Text {
                text: "Process original input".into(),
            }],
            studio_work_mode: StudioWorkMode::Kcoder,
            existing_thread_id: None,
            client_presentation: None,
            configuration: RuntimeExecutionConfiguration {
                model: IntegrationModelResolutionResult {
                    selection_kind: IntegrationModelSelectionKind::InheritCurrent,
                    model: summary,
                    policy_ref: IntegrationNullable::Null,
                    budget: IntegrationModelBudget {
                        reservation_state: IntegrationBudgetReservationState::NotReserved,
                        cost_known: false,
                    },
                },
                allowed_tools: Some(vec![]),
                external_send: RuntimeExternalSend::Deny,
                workflow: None,
            },
        }
    }
    pub(crate) fn driver(&self) -> NativeRuntimeDriver {
        NativeRuntimeDriver::initialize(&self.context, "initialize-runtime").unwrap()
    }
}

pub(crate) struct FixtureInstaller;
impl NativeRuntimePolicyInstaller for FixtureInstaller {
    fn install(
        &self,
        context: &NativeIntegrationContext,
        original: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
        engine: QueryEngine,
    ) -> Result<QueryEngine> {
        context.validate_scope(&original.scope)?;
        assert_eq!(original.payload["source"]["kind"], "office_assistant");
        assert_eq!(
            prepared.configuration.external_send,
            RuntimeExternalSend::Deny
        );
        Ok(engine)
    }
}

impl NativeRuntimeAuthority for FixtureInstaller {
    fn verify_admission(
        &self,
        context: &NativeIntegrationContext,
        original: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
    ) -> Result<()> {
        context.validate_scope(&original.scope)?;
        prepared.validate()
    }

    fn installer(&self) -> &dyn NativeRuntimePolicyInstaller {
        self
    }
}

pub(crate) async fn resident(fixture: &Fixture) -> (ThreadManager, QueryEngine) {
    let runtime = test_runtime("native-runtime", &fixture.workspace.join("history.jsonl"));
    let engine = runtime.engine();
    engine
        .state
        .with_history_path(fixture.workspace.join("history.jsonl"));
    engine.settings.write().unwrap().model = "fixture-model".into();
    let mut manager = ThreadManager::default();
    assert!(manager.insert(runtime).is_ok());
    manager
        .followups(&engine.session_id())
        .unwrap()
        .session_activity
        .attach(
            &fixture.viewer,
            &uuid::Uuid::new_v4().to_string(),
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    (manager, engine)
}
pub(crate) async fn shutdown(mut manager: ThreadManager) {
    for runtime in manager.drain() {
        runtime.shutdown().await
    }
}
