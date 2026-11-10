//! Read target policy without creating a session, running hooks, or searching.
use super::*;
use kcoder_app_protocol::{WebSearchStatusReadParams, WebSearchStatusReadResult};
use kcoder_tools::ToolContext;
use tokio_util::sync::CancellationToken;

pub struct SearchDiagnosticBinding {
    pub status: WebSearchStatusReadResult,
    pub context: ToolContext,
    pub runtime: Arc<kcoder_tools::web_search::WebSearchRuntime>,
    pub permitted: bool,
}

impl AppServerEngineFactory {
    fn web_diagnostic_settings(&self) -> Result<Settings> {
        match &self.configuration {
            Some(configuration) => configuration.public_runtime_settings(),
            None => Ok(self.base_settings.clone()),
        }
    }
    pub fn web_search_diagnostic(
        &self,
        host: &QueryEngine,
        resident: Option<&QueryEngine>,
        params: &WebSearchStatusReadParams,
        target: &str,
        cancel: CancellationToken,
        for_probe: bool,
    ) -> Result<SearchDiagnosticBinding> {
        let factory_settings = self.web_diagnostic_settings()?;
        let mut settings = match resident {
            Some(engine) => engine
                .settings
                .read()
                .map_err(|_| anyhow::anyhow!("SEARCH_SETTINGS_UNAVAILABLE"))?
                .clone(),
            None => factory_settings.clone(),
        };
        let bound_session_policy = diagnostic_policy_key(&settings)?;
        let selection = self.studio_tool_selections(None)?;
        let visible = |name: &str| match resident {
            Some(engine) => engine.tools.get(name).is_some(),
            None => {
                selection.tools.iter().any(|tool| {
                    tool.name == name
                        && tool.available
                        && tool.supported_modes.contains(&params.mode)
                }) && selection.modes.iter().any(|mode| {
                    mode.mode == params.mode && mode.allowed_tools.iter().any(|tool| tool == name)
                })
            }
        };
        let origin = resident.unwrap_or(host);
        let mut context = origin.web_search_context(cancel);
        if resident.is_some() {
            settings.web = context
                .effective_web_settings()
                .map_err(|_| anyhow::anyhow!("SEARCH_SETTINGS_UNAVAILABLE"))?;
        }
        let runtime = origin.web_search_runtime();
        let legacy = std::env::var("KCODER_WEB_SEARCH_PROVIDER").ok();
        let snapshot = runtime.snapshot(&settings.web, legacy.as_deref())?;
        let revision = super::super::hex_sha256(&serde_json::to_vec(&(
            &snapshot.revision,
            &settings.web,
            &selection.revision,
            &params.mode,
            &params.thread_id,
            visible("WebSearch"),
            visible("WebFetch"),
        ))?);
        if resident.is_none() {
            context =
                context.with_runtime_settings(Arc::new(std::sync::RwLock::new(settings.clone())));
        }
        let tool = origin
            .tools
            .get("WebSearch")
            .or_else(|| self.tools.get("WebSearch"))
            .or_else(|| {
                for_probe.then(|| {
                    Arc::new(kcoder_tools::web_search::WebSearchTool::default())
                        as Arc<dyn kcoder_tools::Tool>
                })
            });
        let mut permissions = match resident {
            Some(engine) => engine
                .permissions
                .read()
                .map_err(|_| anyhow::anyhow!("SEARCH_PERMISSION_UNAVAILABLE"))?
                .clone(),
            None => self.base_permissions.clone(),
        };
        permissions.refresh_persisted_settings(&settings);
        let permitted = for_probe
            && permits_visible_search(&permissions, visible("WebSearch"), tool.as_deref());
        if for_probe {
            let factory = self.clone();
            let bound_factory_policy = diagnostic_policy_key(&factory_settings)?;
            let resident_settings = resident.map(|engine| engine.settings.clone());
            let resident_permissions = resident.map(|engine| engine.permissions.clone());
            let bound_visible = visible("WebSearch");
            let mode = params.mode;
            let tool = tool.clone();
            context = context.with_web_dispatch_check(Arc::new(move || {
                let denied = || {
                    kcoder_tools::ToolError::Execution(
                        "Search diagnostic policy changed or no longer permits this request".into(),
                    )
                };
                let fresh = factory.web_diagnostic_settings().map_err(|_| denied())?;
                if diagnostic_policy_key(&fresh).map_err(|_| denied())? != bound_factory_policy {
                    return Err(denied());
                }
                let current_visible = if let Some(settings) = &resident_settings {
                    let settings = settings.read().map_err(|_| denied())?;
                    if diagnostic_policy_key(&settings).map_err(|_| denied())?
                        != bound_session_policy
                    {
                        return Err(denied());
                    }
                    bound_visible
                } else {
                    let catalog = factory.studio_tool_selections(None).map_err(|_| denied())?;
                    catalog.tools.iter().any(|entry| {
                        entry.name == "WebSearch"
                            && entry.available
                            && entry.supported_modes.contains(&mode)
                    }) && catalog.modes.iter().any(|entry| {
                        entry.mode == mode
                            && entry.allowed_tools.iter().any(|tool| tool == "WebSearch")
                    })
                };
                let permissions = if let Some(permissions) = &resident_permissions {
                    permissions.read().map_err(|_| denied())?.clone()
                } else {
                    let mut permissions = factory.base_permissions.clone();
                    permissions.refresh_persisted_settings(&fresh);
                    permissions
                };
                if !permits_visible_search(&permissions, current_visible, tool.as_deref()) {
                    return Err(denied());
                }
                Ok(())
            }));
        }
        Ok(SearchDiagnosticBinding {
            status: WebSearchStatusReadResult {
                target_id: target.into(),
                revision,
                mode: resident.map_or(params.mode, |engine| engine.state.studio_work_mode()),
                thread_id: params.thread_id.clone(),
                web_search_visible: visible("WebSearch"),
                web_fetch_visible: visible("WebFetch"),
                automatic: snapshot.automatic,
                candidates: snapshot.candidates,
                observations: snapshot
                    .observations
                    .into_iter()
                    .map(
                        |observation| kcoder_app_protocol::WebSearchSourceObservation {
                            provider: observation.provider,
                            component: if observation.provider
                                == kcoder_types::web_search::WebSearchProvider::Searxng
                                && !kcoder_mcp::web_search::bundled_search_component_available()
                            {
                                kcoder_app_protocol::WebSearchComponentState::Unavailable
                            } else {
                                kcoder_app_protocol::WebSearchComponentState::Unknown
                            },
                            status: observation.status,
                            observed_at: observation.observed_at,
                            error: observation.error,
                        },
                    )
                    .collect(),
            },
            context,
            runtime,
            permitted,
        })
    }
}

fn diagnostic_policy_key(settings: &Settings) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(&(
        &settings.web,
        &settings.permission_mode,
        &settings.allowed_tools,
        &settings.denied_tools,
        &settings.permission_rules,
    ))?)
}

fn permits_visible_search(
    permissions: &kcoder_permissions::PermissionEngine,
    visible: bool,
    registered: Option<&dyn kcoder_tools::Tool>,
) -> bool {
    if !visible {
        return false;
    }
    let input = probe_input_json();
    let decision = match registered {
        Some(tool) => permissions.decide(tool, &input),
        // A newly enabled profile can exceed the immutable bootstrap registry.
        // Visibility already came from the freshly resolved native catalog.
        None => permissions.decide(&kcoder_tools::web_search::WebSearchTool::default(), &input),
    };
    decision == kcoder_permissions::PermissionDecision::Allow
}

#[cfg(test)]
mod tests {
    use super::*;
    struct CountedSource(std::sync::atomic::AtomicUsize);
    #[async_trait::async_trait]
    impl kcoder_tools::web_search::BundledSearchBackend for CountedSource {
        async fn search(
            &self,
            _: &kcoder_tools::web_search::WebSearchInput,
            guard: &kcoder_tools::web_search::SearchDispatchGuard,
        ) -> std::result::Result<
            kcoder_types::web_search::WebSearchPageV1,
            kcoder_tools::web_search::SearchFailure,
        > {
            guard.check(kcoder_types::web_search::WebSearchProvider::Searxng)?;
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(kcoder_types::web_search::WebSearchPageV1::default())
        }
    }
    #[tokio::test]
    async fn diagnostic_dispatch_reloads_target_policy_and_preserves_resident_revocation() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("config");
        std::fs::create_dir(&config).unwrap();
        let path = config.join("settings.json");
        let initial = serde_json::json!({
            "active_provider":"fixture","model":"fixture-model","permission_mode":"auto","history_enabled":false,
            "providers":{"fixture":{"api_format":"openai_chat_completions","endpoint":"http://127.0.0.1:1/v1","default_model":"fixture-model","context_window_tokens":128000,"output_headroom_tokens":8192,"max_output_tokens":8192,"request_timeout_secs":30,"authentication":{"mode":"none"}}},
            "web":{"search":{"providers":[{"id":"searxng-bundled","kind":"searxng","enabled":true}]}}
        });
        std::fs::write(&path, serde_json::to_vec(&initial).unwrap()).unwrap();
        let mut factory =
            super::super::tests::configured_factory(root.path(), &config, &path, None);
        factory.tools = kcoder_tools::default_registry();
        let host = factory
            .create_new_thread(Arc::new(kcoder_tools::user_question::DenyAllUserQuestioner))
            .unwrap();
        // Public status and dispatch checks must not consult an unrelated credential store.
        std::fs::write(
            config.join("credentials.json"),
            "{invalid credential fixture",
        )
        .unwrap();
        let request = WebSearchStatusReadParams {
            mode: kcoder_types::StudioWorkMode::Kcoder,
            thread_id: None,
        };
        for resident in [None, Some(&host)] {
            std::fs::write(&path, serde_json::to_vec(&initial).unwrap()).unwrap();
            let binding = factory
                .web_search_diagnostic(
                    &host,
                    resident,
                    &request,
                    "fixture-target",
                    CancellationToken::new(),
                    true,
                )
                .unwrap();
            assert!(binding.permitted);
            let source = Arc::new(CountedSource(std::sync::atomic::AtomicUsize::new(0)));
            let context = binding
                .context
                .with_bundled_search_backend(Some(source.clone()));
            if resident.is_some() {
                host.permissions
                    .write()
                    .unwrap()
                    .session_denied
                    .push("WebSearch".into());
            } else {
                let mut revoked = initial.clone();
                revoked["web"]["search"]["providers"] = serde_json::json!([]);
                std::fs::write(&path, serde_json::to_vec(&revoked).unwrap()).unwrap();
            }
            let input = serde_json::from_value(super::probe_input_json()).unwrap();
            let response = binding.runtime.probe(input, &context).await.unwrap();
            assert_eq!(
                response.failure,
                Some(kcoder_types::web_search::WebSearchErrorKind::PolicyDenied)
            );
            assert!(response.attempts.is_empty());
            assert_eq!(source.0.load(std::sync::atomic::Ordering::SeqCst), 0);
        }
    }
    #[test]
    fn diagnostic_policy_binding_tracks_revocation_without_binding_unrelated_model_choices() {
        let initial = Settings::default();
        let key = diagnostic_policy_key(&initial).unwrap();
        let mut settings = initial.clone();
        settings.model = "another-model".into();
        assert_eq!(diagnostic_policy_key(&settings).unwrap(), key);
        settings.denied_tools.push("WebSearch".into());
        assert_ne!(diagnostic_policy_key(&settings).unwrap(), key);
        settings = initial;
        settings.web.search.providers.clear();
        assert_ne!(diagnostic_policy_key(&settings).unwrap(), key);
    }
    #[test]
    fn a_newly_enabled_profile_can_probe_without_mutating_bootstrap_tools() {
        let settings = Settings {
            permission_mode: kcoder_config::PermissionMode::Auto,
            ..Settings::default()
        };
        let mut permissions = PermissionEngine::from_settings(&settings);
        assert!(permits_visible_search(&permissions, true, None));
        assert!(!permits_visible_search(&permissions, false, None));
        permissions.session_denied.push("WebSearch".into());
        assert!(!permits_visible_search(&permissions, true, None));
    }
}

/// Exact input shared by status projection and the owned diagnostic probe.
pub fn probe_input_json() -> serde_json::Value {
    serde_json::json!({"query":"KCoder web search connectivity check", "num_results":3})
}
