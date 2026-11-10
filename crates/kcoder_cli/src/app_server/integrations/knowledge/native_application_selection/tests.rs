//! Actual public caller/lifecycle checks; no permissive policy or fabricated MCP origin.
use super::*;
use serde_json::json;
struct NeverModel;
impl kcoder_api::Provider for NeverModel {
    fn name(&self) -> &'static str {
        "forbidden-application-source-model"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        panic!("source selection cannot call a model")
    }
}
struct Fixture {
    scope: crate::app_server::integrations::core::runtime_driver::test_support::Fixture,
    engine: QueryEngine,
    factory: AppServerEngineFactory,
    state: ConnectionState,
}
impl Fixture {
    fn new() -> Result<Self> {
        let scope =
            crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
        let mut settings = kcoder_config::Settings {
            credential_store: kcoder_config::CredentialStoreMode::File,
            ..Default::default()
        };
        settings.integrations.connectivity.enabled = true;
        settings.integrations.knowledge.business_automation_enabled = true;
        let factory = AppServerEngineFactory::new(
            Arc::new(NeverModel),
            kcoder_tools::ToolRegistry::new(),
            kcoder_permissions::PermissionEngine::from_settings(&settings),
            settings,
            kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
            kcoder_skills::SkillRegistry::empty(),
            kcoder_plugins::EffectivePluginSnapshot::default(),
            scope.workspace.clone(),
            None,
            true,
            kcoder_engine::WorkspaceRuntimeServices::new(
                &scope.workspace,
                "application-source-denials",
            ),
            Some(scope.profile.join("settings.json")),
            scope.profile.join("short-ids"),
        );
        let engine = factory.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
        let mut native = scope.context.recapture_for_owned_service()?;
        native.refresh_configuration_revision(
            engine.active_model_configuration_summary()?.revision,
        )?;
        let state = ConnectionState {
            initialized: true,
            integration_automation_v1: true,
            integration_context: Some(native),
            ..Default::default()
        };
        Ok(Self {
            scope,
            engine,
            factory,
            state,
        })
    }
    fn request(&self) -> IntegrationRequest {
        IntegrationRequest { contract_version: IntegrationContractVersion::ParallelV1, request_id: "exact-resource-selection".into(), scope: self.state.integration_context.as_ref().unwrap().scope().clone(),
            operation_id: Some("original-resource-read-consent".into()), expected_revision: None, timeout_ms: 30_000, cancellation_ref: None,
            payload: json!({"source":{"sourceRef":{"id":"source-reference","revision":"1"},"accountRef":null},"resourceUri":"mailbox://fixture/original","readConsentRef":"explicit-read-consent"}).as_object().unwrap().clone() }
    }
    fn unchanged_domains(&self) -> Result<()> {
        let native = self.state.integration_context.as_ref().unwrap();
        for domain in [
            crate::app_server::integrations::core::NativeDomain::Automation,
            crate::app_server::integrations::core::NativeDomain::Operations,
        ] {
            assert!(
                crate::app_server::integrations::core::NativeDomainGuard::observe(
                    native.profile()?,
                    native.scope(),
                    domain
                )?
                .is_none()
            );
        }
        assert!(!self.scope.profile.join("connectivity").exists());
        Ok(())
    }
}
#[test]
fn actual_public_selection_has_no_ambient_registered_source_or_read_authority() -> Result<()> {
    let f = Fixture::new()?;
    let control = NativeApplicationSelectionControl::from_public_control(
        &f.state,
        &f.engine,
        &f.factory,
        f.request(),
    )?;
    assert!(control.prepare().is_err());
    f.unchanged_domains()
}
#[test]
fn private_callback_disabled_capability_and_ended_owner_cannot_select_a_resource() -> Result<()> {
    for mode in 0..3 {
        let mut f = Fixture::new()?;
        match mode {
            0 => f.state.native_source_dispatch = true,
            1 => f.state.integration_automation_v1 = false,
            _ => f.state.input_ended.cancel(),
        }
        assert!(
            NativeApplicationSelectionControl::from_public_control(
                &f.state,
                &f.engine,
                &f.factory,
                f.request()
            )
            .is_err()
        );
        f.unchanged_domains()?;
    }
    Ok(())
}
#[test]
fn read_consent_is_explicit_and_unknown_json_fields_cannot_grant_it() -> Result<()> {
    let f = Fixture::new()?;
    for key in ["approved", "allow", "readConsentRef"] {
        let mut request = f.request();
        if key == "readConsentRef" {
            request.payload.remove(key);
        } else {
            request.payload.insert(key.into(), json!(true));
        }
        assert!(
            NativeApplicationSelectionControl::from_public_control(
                &f.state, &f.engine, &f.factory, request
            )
            .is_err()
        );
    }
    f.unchanged_domains()
}
#[test]
fn retained_control_cannot_prepare_after_its_actual_public_connection_ends() -> Result<()> {
    let f = Fixture::new()?;
    let control = NativeApplicationSelectionControl::from_public_control(
        &f.state,
        &f.engine,
        &f.factory,
        f.request(),
    )?;
    f.state.input_ended.cancel();
    assert!(control.prepare().is_err());
    f.unchanged_domains()
}
