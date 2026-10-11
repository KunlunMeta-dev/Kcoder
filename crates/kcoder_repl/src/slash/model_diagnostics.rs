//! Presentation of the Engine's sanitized model configuration projections.
use kcoder_engine::QueryEngine;
use kcoder_types::{ModelConfigurationBoundary, ModelConfigurationSummary};

pub(super) fn request_output_limits(summary: &ModelConfigurationSummary) -> String {
    if summary.request_output_limits.is_empty() {
        return "not reported by this protocol".into();
    }
    summary
        .request_output_limits
        .iter()
        .map(|(field, value)| {
            let value = value
                .map(|value| format!("{value} tokens"))
                .unwrap_or_else(|| "provider default / non-numeric override".into());
            let source = if summary.request_override_fields.contains(field) {
                "extra_body"
            } else {
                "configured max output"
            };
            format!("{field}={value} ({source})")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn sourced(summary: &ModelConfigurationSummary, field: &str, value: String) -> String {
    let source = summary
        .sources
        .get(field)
        .filter(|sources| !sources.is_empty())
        .map(|sources| sources.iter().cloned().collect::<Vec<_>>().join(", "))
        .unwrap_or_else(|| "not reported".into());
    format!("{value} [source: {source}]")
}

fn tokens(value: Option<usize>) -> String {
    value
        .map(|value| format!("{value} tokens"))
        .unwrap_or_else(|| "not reported".into())
}

pub(super) fn summary_lines(summary: &ModelConfigurationSummary) -> Vec<String> {
    let boundary = match summary.boundary {
        ModelConfigurationBoundary::SessionSnapshot => {
            "Current session snapshot (accepted turn configuration is frozen)"
        }
        ModelConfigurationBoundary::NextTurn => "Next turn (resolved configuration)",
    };
    let mut lines = vec![boundary.into()];
    let fields = [
        (
            "Provider",
            "provider",
            summary
                .provider_id
                .clone()
                .unwrap_or_else(|| "injected provider".into()),
        ),
        ("Model", "model", summary.model_id.clone()),
        (
            "API format",
            "api_format",
            summary
                .api_format
                .clone()
                .unwrap_or_else(|| "not reported".into()),
        ),
        (
            "Chat protocol",
            "chat_protocol",
            summary.chat_protocol.clone(),
        ),
        (
            "Context window",
            "context_window_tokens",
            tokens(summary.context_window_tokens),
        ),
        (
            "Configured max output",
            "max_output_tokens",
            tokens(summary.max_output_tokens.map(|value| value as usize)),
        ),
        (
            "Request output limits",
            "extra_body",
            request_output_limits(summary),
        ),
        (
            "Output headroom",
            "output_headroom_tokens",
            tokens(summary.output_headroom_tokens),
        ),
        (
            "Reasoning effort",
            "reasoning_effort",
            summary
                .reasoning_effort
                .clone()
                .unwrap_or_else(|| "default".into()),
        ),
        (
            "Reasoning policy",
            "reasoning_policy",
            summary
                .reasoning_policy
                .as_ref()
                .map(|policy| {
                    serde_json::to_string(policy).unwrap_or_else(|_| "not reported".into())
                })
                .unwrap_or_else(|| "not configured".into()),
        ),
        (
            "Capabilities",
            "capabilities",
            format!(
                "text={} tools={} vision={} reasoning={} structured_output={}",
                summary.text,
                summary.tools,
                summary.vision,
                summary.reasoning,
                summary.structured_output
            ),
        ),
    ];
    for (label, field, value) in fields {
        lines.push(format!("{label}: {}", sourced(summary, field, value)));
    }
    if let Some(tools) = &summary.tool_set {
        lines.push(format!(
            "Tool profile: {}",
            sourced(
                summary,
                "tools.profile",
                tools
                    .profile
                    .clone()
                    .unwrap_or_else(|| "not recorded".into())
            )
        ));
        lines.push(format!("Tool registry scope: {:?}", tools.registry_scope));
        lines.push(format!(
            "Registered tools: {}; request-exposed tools: {}",
            tools
                .registered_tool_count
                .map(|count| count.to_string())
                .unwrap_or_else(|| "not recorded".into()),
            tools
                .exposed_tool_count
                .map(|count| count.to_string())
                .unwrap_or_else(|| "not recorded".into())
        ));
    } else {
        lines.push("Tool registry configuration: not recorded".into());
    }
    lines.push(format!(
        "Request overrides: {}",
        if summary.request_override_fields.is_empty() {
            "none".into()
        } else {
            summary.request_override_fields.join(", ")
        }
    ));
    lines.push(format!("Configuration revision: {}", summary.revision));
    // Keep the boundary identifiable when a compact viewport is scrolled to the end.
    lines.push(format!(
        "Boundary: {}",
        match summary.boundary {
            ModelConfigurationBoundary::SessionSnapshot => "Current session snapshot",
            ModelConfigurationBoundary::NextTurn => "Next turn",
        }
    ));
    lines
}

/// Reading diagnostics never activates a catalog choice or reloads the active snapshot.
pub(super) fn model_configuration_lines(engine: &QueryEngine) -> Vec<String> {
    let active = match engine.active_model_configuration_summary() {
        Ok(summary) => summary,
        Err(_) => return vec!["Current model configuration: unavailable".into()],
    };
    let mut lines = summary_lines(&active);
    lines.push(String::new());
    // Use the same source-aware projection as the explicit next-turn resolver.
    // Errors may contain private paths or transport details, so only report availability.
    match engine.current_configured_model_profiles() {
        Ok(profiles) => {
            let next = profiles
                .into_iter()
                .find(|profile| {
                    Some(profile.profile_name.as_str()) == active.provider_id.as_deref()
                        && profile.model == active.model_id
                })
                .and_then(|profile| profile.configuration);
            match next {
                Some(next) => lines.extend(summary_lines(&next)),
                None => lines.push("Next turn: current model is absent from the configured catalog; configuration not reported".into()),
            }
        }
        Err(_) => lines.push(
            "Next turn: configuration unavailable; current session snapshot is retained".into(),
        ),
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_config::{ApiFormat, Settings};

    struct EmptyProvider;
    impl kcoder_api::Provider for EmptyProvider {
        fn name(&self) -> &'static str {
            "fixture"
        }
        fn stream_messages(
            &self,
            _request: kcoder_types::MessagesRequest,
        ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
            panic!("diagnostics must not call the model")
        }
    }
    struct ConfigurationSource {
        settings: Settings,
        fail: bool,
    }
    impl kcoder_engine::ClientModelConfiguration for ConfigurationSource {
        fn settings(&self, _selection: &str) -> anyhow::Result<Settings> {
            Ok(self.settings.clone())
        }
        fn provider(
            &self,
            _settings: &Settings,
        ) -> anyhow::Result<std::sync::Arc<dyn kcoder_api::Provider>> {
            Ok(std::sync::Arc::new(EmptyProvider))
        }
        fn catalog_settings(&self) -> anyhow::Result<Option<Settings>> {
            if self.fail {
                anyhow::bail!("private-api-key private-path");
            }
            Ok(Some(self.settings.clone()))
        }
        fn settings_with_sources(
            &self,
            _selection: &str,
        ) -> anyhow::Result<(
            Settings,
            std::collections::BTreeMap<String, std::collections::BTreeSet<String>>,
        )> {
            Ok((
                self.settings.clone(),
                [("extra_body".into(), ["local".into()].into())].into(),
            ))
        }
    }
    fn test_engine(
        cwd: &std::path::Path,
        settings: Settings,
        source: ConfigurationSource,
    ) -> QueryEngine {
        QueryEngine::new(
            std::sync::Arc::new(EmptyProvider),
            kcoder_state::AppState::new(cwd),
            kcoder_tools::ToolRegistry::new(),
            kcoder_permissions::PermissionEngine::from_settings(&settings),
            settings,
            kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
            kcoder_skills::SkillRegistry::load(cwd).unwrap(),
            std::sync::Arc::new(kcoder_tools::DenyAllUserQuestioner),
            cwd.to_path_buf(),
        )
        .with_client_model_configuration(std::sync::Arc::new(source))
    }

    #[test]
    fn model_diagnostics_use_source_aware_next_turn_without_changing_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let mut settings = Settings {
            max_tokens: Some(65_536),
            api_format: Some(ApiFormat::OpenaiChatCompletions),
            ..Settings::default()
        };
        settings
            .provider_extra_body
            .insert("max_tokens".into(), 8192.into());
        let mut next = settings.clone();
        next.provider_extra_body
            .insert("max_tokens".into(), 4096.into());
        let engine = test_engine(
            tmp.path(),
            settings,
            ConfigurationSource {
                settings: next,
                fail: false,
            },
        );
        let before = engine.active_model_configuration_summary().unwrap();
        let rendered = model_configuration_lines(&engine).join("\n");
        assert!(rendered.contains("max_tokens=8192 tokens (extra_body)"));
        assert!(rendered.contains("max_tokens=4096 tokens (extra_body)"));
        assert!(rendered.contains("[source: local]"));
        assert!(rendered.contains("[source: session_snapshot]"));
        assert_eq!(engine.active_model_configuration_summary().unwrap(), before);
    }

    #[test]
    fn model_diagnostics_hide_catalog_errors_and_retain_active_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let settings = Settings::default();
        let engine = test_engine(
            tmp.path(),
            settings.clone(),
            ConfigurationSource {
                settings,
                fail: true,
            },
        );
        let rendered = model_configuration_lines(&engine).join("\n");
        assert!(
            rendered.contains("configuration unavailable; current session snapshot is retained")
        );
        assert!(!rendered.contains("private-api-key"));
        assert!(!rendered.contains("private-path"));
    }

    #[test]
    fn model_diagnostics_show_request_override_instead_of_root_limit() {
        let mut settings = Settings {
            max_tokens: Some(65_536),
            api_format: Some(ApiFormat::OpenaiChatCompletions),
            ..Settings::default()
        };
        settings
            .provider_extra_body
            .insert("max_tokens".into(), 8192.into());
        settings
            .provider_extra_body
            .insert("secret_payload".into(), "do-not-render".into());
        settings.base_url = Some("https://user:do-not-render@example.com/private".into());
        let mut summary = kcoder_engine::model_configuration_summary(
            &settings,
            ModelConfigurationBoundary::SessionSnapshot,
        )
        .unwrap();
        summary
            .sources
            .insert("max_output_tokens".into(), ["cli".into()].into());
        summary
            .sources
            .insert("extra_body".into(), ["local".into()].into());
        let rendered = summary_lines(&summary).join("\n");
        assert!(rendered.contains("max_tokens=8192 tokens (extra_body)"));
        assert!(rendered.contains("65536 tokens [source: cli]"));
        assert!(rendered.contains("[source: local]"));
        assert!(rendered.contains("accepted turn configuration is frozen"));
        assert!(!rendered.contains("secret_payload"));
        assert!(!rendered.contains("do-not-render"));
        assert!(!rendered.contains("example.com"));
        summary.boundary = ModelConfigurationBoundary::NextTurn;
        assert!(summary_lines(&summary)[0].contains("Next turn"));
    }

    #[test]
    fn model_diagnostics_preserve_multiple_and_non_numeric_request_limits() {
        let mut settings = Settings {
            max_tokens: Some(65_536),
            api_format: Some(ApiFormat::OpenaiResponses),
            ..Settings::default()
        };
        settings
            .provider_extra_body
            .insert("max_output_tokens".into(), serde_json::Value::Null);
        settings
            .provider_extra_body
            .insert("max_completion_tokens".into(), 4096.into());
        let summary = kcoder_engine::model_configuration_summary(
            &settings,
            ModelConfigurationBoundary::NextTurn,
        )
        .unwrap();
        let limits = request_output_limits(&summary);
        assert!(limits.contains("max_completion_tokens=4096 tokens (extra_body)"));
        assert!(
            limits
                .contains("max_output_tokens=provider default / non-numeric override (extra_body)")
        );
        assert!(!limits.contains("65536"));
    }
}
