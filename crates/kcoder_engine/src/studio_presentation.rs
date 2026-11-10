//! Turn-local presentation policy. Durable labels alone never enable office tools.
use super::*;
use kcoder_types::{ClientPresentationV1, StudioWorkMode};

impl QueryEngine {
    /// The app-server validates negotiation and thread binding before calling this.
    /// A value field prevents a Studio turn from changing resident, CLI, or child engines.
    pub fn with_client_presentation(mut self, presentation: Option<ClientPresentationV1>) -> Self {
        self.client_presentation = presentation;
        self
    }

    pub fn effective_studio_work_mode(&self) -> StudioWorkMode {
        if self.state.session_mode() != kcoder_state::SessionMode::Default
            || self.subagent_system_prompt.is_some()
            || self.is_arrangement_mode_active()
        {
            return StudioWorkMode::Kcoder;
        }
        self.client_presentation
            .as_ref()
            .filter(|value| value.version == 1)
            .and_then(|value| value.studio_work_mode)
            .unwrap_or_default()
    }

    pub fn client_presentation_snapshot(&self) -> Option<ClientPresentationV1> {
        self.client_presentation.clone()
    }

    pub fn inline_widgets_enabled(&self) -> bool {
        self.client_presentation
            .as_ref()
            .is_some_and(|value| value.version == 1 && value.inline_widgets)
            && self.effective_studio_work_mode() == StudioWorkMode::Kworker
    }

    pub fn isolated_widgets_enabled(&self) -> bool {
        self.inline_widgets_enabled()
            && self
                .client_presentation
                .as_ref()
                .is_some_and(|value| value.isolated_widgets)
    }

    /// Add only the host's inline presentation tool, after ordinary profile and deny rules.
    /// Neither a capability declaration nor a custom Luna list can restore a denied tool.
    pub fn with_inline_widget_tool<T: kcoder_tools::Tool + 'static>(self, tool: T) -> Self {
        if tool.name() != "show_widget" || !self.inline_widgets_enabled() {
            return self;
        }
        let settings = recover_read_lock(&self.settings, "settings");
        if !settings.model_capabilities.tools
            || matches!(
                settings.tools.profile,
                kcoder_config::ToolProfile::Nano | kcoder_config::ToolProfile::None
            )
        {
            drop(settings);
            return self;
        }
        let tools = self
            .tools
            .clone()
            .register(tool)
            .filtered_out_by_patterns(&settings.tools.disabled);
        drop(settings);
        self.with_turn_tools(tools)
    }

    pub fn native_core_workflow_office_child_allowed(&self) -> bool {
        self.native_office_projection
            .as_ref()
            .is_some_and(|authority| {
                authority
                    .native_core_workflow_child(&self.state)
                    .is_some_and(|capability| capability.verify_current(&self.state))
            })
    }
    pub(super) fn office_tool_policy_active(&self) -> bool {
        self.effective_studio_work_mode() == StudioWorkMode::Kworker
            || self.native_core_workflow_office_child_allowed()
    }
    pub(crate) fn with_native_core_workflow_office_child_from(
        mut self,
        parent: &QueryEngine,
    ) -> Result<Self> {
        if let Some(authority) = parent.native_office_projection.as_ref() {
            let capability = authority.native_core_workflow_child(&self.state);
            #[cfg(test)]
            eprintln!(
                "native Core Workflow Office child capability: available={} actualAttempt={}",
                capability.is_some(),
                self.state.current_history_attempt_identity().is_some()
            );
            let Some(capability) = capability else {
                return Ok(self);
            };
            let tools = self.restrict_to_native_tool_ceiling(capability.tools(&self.state)?);
            self = self
                .with_native_readonly_settings_source_from(parent)?
                .with_turn_tools(tools)
                .with_native_office_projection_authority(authority.clone())?;
        }
        Ok(self)
    }
}

/// Same pure shrinking operation for Luna and KWorker; never adds omitted tools.
pub(super) fn shrink_to_luna_allowlist(registry: ToolRegistry, allowed: &[String]) -> ToolRegistry {
    registry.filtered_to_names(allowed)
}

/// Extend only with agent tools already registered by the ordinary host profile.
pub(super) const KWORKER_AGENT_TOOLS: &[&str] = kcoder_config::KWORKER_DEFAULT_AGENT_TOOLS;

pub(super) const KWORKER_WORKFLOW_TOOLS: &[&str] = kcoder_config::KWORKER_DEFAULT_WORKFLOW_TOOLS;

/// Shell tools KWorker keeps among its built-in business tools.
///
/// KWorker is the Studio office mode on Windows, so its shell must not depend on the
/// *resolved* Luna allowlist: a list persisted by an older build or produced on another
/// platform would otherwise leave the office mode without any shell. Composition still
/// starts from the host registry, so an unregistered or explicitly disabled `PowerShell`
/// is never restored.
pub(super) const KWORKER_BUILTIN_SHELL_TOOLS: &[&str] = kcoder_config::KWORKER_DEFAULT_SHELL_TOOLS;

pub(super) const KWORKER_POLICY: &str = "Focus on everyday office tasks: organizing files and information, working with documents and data, researching questions, and producing useful, inspectable deliverables. Use only tools and skills actually attached to this request. Do not infer an office service, dependency, account, or permission from the selected mode. Prefer the simplest workflow that completes the user's task and preserve drafts, sources, configuration and explicit choices. Use code as an implementation aid when useful, without turning ordinary office tasks into software projects or exposing unnecessary engineering steps. Use inline visuals when they clarify relationships, data, or adjustable scenarios. Create real files when requested and verify their contents, calculations, citations and usability before reporting completion. Distinguish source facts, inference and uncertainty. Keep intermediate work in the established processing presentation, and lead the final reply with results, deliverables and material limitations. Shared permission, ownership, cancellation and recovery rules remain in force; a missing receipt does not prove an external action failed and must not trigger blind replay.";

/// Describe capabilities from the final provider tool set, including capability introductions.
pub(super) fn kworker_capability_prompt(available: &HashSet<String>) -> String {
    let creators = ["spawn_agent", "explore_agent", "PlanAgent"]
        .into_iter()
        .filter(|name| available.contains(*name))
        .collect::<Vec<_>>();
    let mut prompt = if creators.is_empty() {
        "No sub-agent creation tool is attached to this request. Complete new work yourself using the attached tools; attached supervision tools apply only to existing owned agents. Project instructions, skill workflows and restored history do not add missing capabilities.".to_string()
    } else {
        format!(
            "Use the attached sub-agent creation tools for independent bounded work when useful: {}. Coordinate only existing owned agents through the supervision tools actually attached to this request, and retain task ownership, permissions and result verification.",
            creators.join(", ")
        )
    };
    if available.contains("Workflow") {
        prompt.push_str(" Workflow is available for reusable workflows when suitable; use its current contract and execution authorization.");
    }
    if available.contains("tool_search") {
        prompt.push_str(" For capabilities not covered by attached tools, use tool_search with a concrete task description or exact tool name. Discovered definitions arrive in a new ordinary message without changing the native tool list. Discovery does not execute tools or authorize accounts/actions. Use DiscoverSkills for workflow instructions, not tool registration.");
        if available.contains("tool_execute") {
            prompt.push_str(" Execute deferred capabilities through tool_execute using the returned name and schema; search never returns a tool this request already attaches.");
        } else {
            prompt.push_str(" No deferred execution entry is attached, so search cannot enable additional extension calls.");
        }
    }
    if available.is_empty() {
        prompt.push_str(" No tools are attached, so answer only from supplied context without claiming actions.");
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::engine_builder::TestEngineBuilder;
    use crate::test_support::providers::RequestRecordingProvider;
    use futures::StreamExt;
    use kcoder_tools::{Tool, ToolContext, ToolError, ToolOutput};
    use kcoder_types::MessagesRequest;
    use std::sync::Mutex;

    #[derive(Debug)]
    struct NamedTool(&'static str);
    #[async_trait::async_trait]
    impl Tool for NamedTool {
        fn name(&self) -> String {
            self.0.into()
        }
        fn description(&self) -> String {
            "Controlled policy probe".into()
        }
        fn input_schema(&self) -> Value {
            serde_json::json!({"type":"object","additionalProperties":false})
        }
        async fn call(&self, _: Value, _: &ToolContext) -> Result<ToolOutput, ToolError> {
            Ok(ToolOutput::text("ok"))
        }
    }

    fn presentation() -> Option<ClientPresentationV1> {
        Some(ClientPresentationV1 {
            version: 1,
            studio_work_mode: Some(StudioWorkMode::Kworker),
            inline_widgets: true,
            isolated_widgets: false,
        })
    }

    #[tokio::test]
    async fn office_turn_shrinks_tools_without_changing_resident_luna_or_cli_history() {
        let root = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        settings.tools.luna.allowed = vec!["read".into()];
        let engine = TestEngineBuilder::new(root.path())
            .settings(settings)
            .tool_registry(
                ToolRegistry::new()
                    .register(NamedTool("read"))
                    .register(NamedTool("write")),
            )
            .build_with_profile_directory();
        engine
            .state
            .set_studio_work_mode_before_first_message(StudioWorkMode::Kworker)
            .unwrap();
        let office = engine
            .clone()
            .with_client_presentation(presentation())
            .with_inline_widget_tool(NamedTool("show_widget"));
        assert!(!office.is_luna_mode_active());
        assert!(!engine.is_luna_mode_active());
        assert_eq!(engine.effective_studio_work_mode(), StudioWorkMode::Kcoder);
        assert_eq!(office.effective_studio_work_mode(), StudioWorkMode::Kworker);
        assert!(engine.active_tool_registry().get("write").is_some());
        assert!(engine.active_tool_registry().get("show_widget").is_none());
        assert!(office.active_tool_registry().get("write").is_none());
        let catalog = office.effective_tool_catalog().await;
        let names = catalog
            .into_iter()
            .map(|tool| tool.name)
            .collect::<HashSet<_>>();
        let definitions = office
            .tool_definitions_for_model()
            .await
            .into_iter()
            .map(|tool| tool.name)
            .collect::<HashSet<_>>();
        assert_eq!(names, definitions);
        assert_eq!(
            names,
            HashSet::from([
                "read".into(),
                "show_widget".into(),
                "tool_search".into(),
                "tool_execute".into()
            ])
        );
        let denied = office
            .execute_tool(
                "probe",
                "write",
                serde_json::json!({}),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await;
        assert!(denied.is_err() || denied.unwrap().0.is_error);
    }

    #[tokio::test]
    async fn office_workflow_extension_respects_registry_and_explicit_disabled_tools() {
        let root = tempfile::tempdir().unwrap();
        for disabled in [Vec::new(), vec!["Workflow*".to_string()]] {
            let mut settings = Settings::default();
            settings.tools.luna.allowed = vec!["read".into()];
            settings.tools.disabled = disabled.clone();
            let engine = TestEngineBuilder::new(root.path())
                .settings(settings)
                .tool_registry(kcoder_tools::default_registry())
                .build_with_profile_directory()
                .with_client_presentation(presentation());
            for &name in KWORKER_WORKFLOW_TOOLS {
                assert_eq!(
                    engine.active_tool_registry().get(name).is_some(),
                    disabled.is_empty()
                );
                assert_eq!(
                    engine
                        .effective_tool_catalog()
                        .await
                        .iter()
                        .any(|tool| tool.name == name),
                    disabled.is_empty()
                );
                if !disabled.is_empty() {
                    let (result, decision, _, _) = engine
                        .execute_tool(
                            "disabled-workflow",
                            name,
                            serde_json::json!({}),
                            &kcoder_permissions::AutoAllowPrompt,
                        )
                        .await
                        .unwrap();
                    assert!(result.is_error);
                    assert!(matches!(decision, PermissionDecision::Deny));
                }
            }
        }
        let limited = TestEngineBuilder::new(root.path())
            .tool_registry(ToolRegistry::new().register(NamedTool("read")))
            .build_with_profile_directory()
            .with_client_presentation(presentation());
        for name in KWORKER_WORKFLOW_TOOLS.iter().chain(KWORKER_AGENT_TOOLS) {
            assert!(limited.active_tool_registry().get(name).is_none());
        }
    }

    async fn office_draft_action(engine: &QueryEngine, input: Value) -> Value {
        let (output, decision, _, _) = engine
            .execute_tool(
                "office-draft",
                "WorkflowDraft",
                input,
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await
            .unwrap();
        assert!(!matches!(decision, PermissionDecision::Deny));
        assert!(!output.is_error, "{output:?}");
        let text = output
            .content
            .iter()
            .find_map(|block| match block {
                ContentBlock::Text { text } => Some(text),
                _ => None,
            })
            .unwrap();
        serde_json::from_str(text).unwrap()
    }

    #[tokio::test]
    async fn office_request_can_author_save_export_import_and_clone_workflows_without_execution() {
        let root = tempfile::tempdir().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let mut settings = Settings::default();
        settings.tools.luna.allowed = vec!["read".into()];
        let engine = TestEngineBuilder::new(root.path())
            .settings(settings)
            .provider(Arc::new(RequestRecordingProvider {
                requests: Arc::clone(&requests),
            }))
            .tool_registry(kcoder_tools::default_registry())
            .build_with_profile_directory()
            .with_client_presentation(presentation());
        let request = record_request(&engine, &requests).await;
        for &name in KWORKER_WORKFLOW_TOOLS {
            assert!(request.tools.iter().any(|tool| tool.name == name), "{name}");
            assert!(
                engine
                    .effective_tool_catalog()
                    .await
                    .iter()
                    .any(|tool| tool.name == name)
            );
        }
        assert!(
            !request
                .system
                .as_deref()
                .unwrap()
                .to_ascii_lowercase()
                .contains("kcoder")
        );
        assert_agent_guidance(&request);
        assert!(
            engine
                .blocked_skill_names_for_request()
                .contains(&SPEC_WORKFLOW_SKILL_NAME.to_string())
        );
        let created = office_draft_action(
            &engine,
            serde_json::json!({"action":"create","title":"Office reusable task"}),
        )
        .await;
        let id = created["id"].as_str().unwrap();
        let edited = office_draft_action(&engine, serde_json::json!({"action":"upsert_node","id":id,"expected_revision":created["revision"],"node":{"id":"work","title":"Review","prompt":"Review supplied office data"}})).await;
        let patched = office_draft_action(&engine, serde_json::json!({"action":"patch_nodes","id":id,"expected_revision":edited["revision"],"nodes":[{"id":"work","prompt":"Summarize supplied office data"}]})).await;
        let saved = office_draft_action(
            &engine,
            serde_json::json!({"action":"save","id":id,"expected_revision":patched["revision"]}),
        )
        .await;
        assert_eq!(saved["savedVersion"], 1);
        let exported = office_draft_action(
            &engine,
            serde_json::json!({"action":"export","id":id,"version":1}),
        )
        .await;
        assert_eq!(
            exported["nodes"][0]["prompt"],
            "Summarize supplied office data"
        );
        let imported = office_draft_action(
            &engine,
            serde_json::json!({"action":"import","definition":exported}),
        )
        .await;
        let cloned = office_draft_action(
            &engine,
            serde_json::json!({"action":"clone","id":id,"version":1}),
        )
        .await;
        assert_ne!(imported["id"], created["id"]);
        assert_ne!(cloned["id"], created["id"]);
        let historical = office_draft_action(
            &engine,
            serde_json::json!({"action":"read","id":id,"version":1}),
        )
        .await;
        assert_eq!(historical["nodes"], saved["nodes"]);
        let listed = office_draft_action(&engine, serde_json::json!({"action":"list"})).await;
        assert!(listed.to_string().contains(id));
        assert_eq!(
            requests.lock().unwrap().len(),
            1,
            "Authoring must not execute Agent nodes or request another model"
        );
    }

    #[test]
    fn presentation_never_restores_disabled_nano_none_or_text_only_tools() {
        let root = tempfile::tempdir().unwrap();
        for profile in [
            kcoder_config::ToolProfile::Full,
            kcoder_config::ToolProfile::Nano,
            kcoder_config::ToolProfile::None,
        ] {
            let mut settings = Settings::default();
            settings.tools.profile = profile;
            if profile == kcoder_config::ToolProfile::Full {
                settings.tools.disabled = vec!["show_*".into()];
            }
            let engine = TestEngineBuilder::new(root.path())
                .settings(settings)
                .build_with_profile_directory()
                .with_client_presentation(presentation())
                .with_inline_widget_tool(NamedTool("show_widget"));
            assert!(engine.active_tool_registry().get("show_widget").is_none());
        }
        let mut settings = Settings::default();
        settings.model_capabilities.tools = false;
        let engine = TestEngineBuilder::new(root.path())
            .settings(settings)
            .build_with_profile_directory()
            .with_client_presentation(presentation())
            .with_inline_widget_tool(NamedTool("show_widget"));
        assert!(engine.tools.get("show_widget").is_none());
    }

    #[test]
    fn special_sessions_and_child_roles_cannot_inherit_presentation_tools() {
        let root = tempfile::tempdir().unwrap();
        let engine = TestEngineBuilder::new(root.path())
            .build_with_profile_directory()
            .with_client_presentation(presentation())
            .with_inline_widget_tool(NamedTool("show_widget"));
        assert!(engine.active_tool_registry().get("show_widget").is_some());
        let child = engine
            .clone()
            .with_subagent_system_prompt(Some("Read-only analysis role".into()));
        assert_eq!(child.effective_studio_work_mode(), StudioWorkMode::Kcoder);
        assert!(child.active_tool_registry().get("show_widget").is_none());
        let legacy = engine.clone().with_client_presentation(None);
        assert!(legacy.active_tool_registry().get("show_widget").is_none());
        engine
            .state
            .enter_workflow_draft_before_first_message()
            .unwrap();
        assert_eq!(engine.effective_studio_work_mode(), StudioWorkMode::Kcoder);
        assert!(!engine.inline_widgets_enabled());
        assert!(engine.active_tool_registry().get("show_widget").is_none());
    }

    #[test]
    fn office_prompt_has_independent_identity_and_company_without_entrypoint_guidance() {
        let root = tempfile::tempdir().unwrap();
        let names = HashSet::from(["bash".into(), "read".into()]);
        let office = crate::prompt_runtime::build_system_prompt_for_work_mode(
            root.path(),
            "test-model",
            false,
            false,
            false,
            &names,
            StudioWorkMode::Kworker,
        );
        let coding = crate::prompt_runtime::build_system_prompt(
            root.path(),
            "test-model",
            false,
            false,
            false,
            &names,
        );
        assert!(office.contains("You are KWorker, developed by"));
        assert!(!office.contains("You are KCoder"));
        assert!(!office.contains("mode of KCoder Studio"));
        assert!(office.contains(KWORKER_POLICY));
        assert!(!coding.contains(KWORKER_POLICY));
        assert!(!office.contains("the project's or task's own test suites"));
        assert!(coding.contains("the project's or task's own test suites"));
        assert!(!office.contains("You are a CLI"));
    }

    async fn record_request(
        engine: &QueryEngine,
        requests: &Arc<Mutex<Vec<MessagesRequest>>>,
    ) -> MessagesRequest {
        crate::test_support::engine_builder::initialize_owned_native_profile(engine).unwrap();
        engine
            .state
            .add_message(Message::user_text("Describe your current capabilities."));
        engine
            .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
            .collect::<Vec<_>>()
            .await;
        requests.lock().unwrap().last().unwrap().clone()
    }

    fn assert_no_delegation_guidance(request: &MessagesRequest) {
        let system = request.system.as_deref().unwrap();
        assert!(system.contains("No sub-agent creation tool is attached"));
        for instruction in [
            "Delegation is available in this request",
            "Delegate independent bounded subtasks",
            "When background sub-agents produce evidence",
            "At most 4 sub-agents may run at once",
        ] {
            assert!(!system.contains(instruction), "{instruction}");
        }
        assert!(
            !request
                .tools
                .iter()
                .any(|tool| KWORKER_AGENT_TOOLS.contains(&tool.name.as_str())
                    || tool.name == "PlanAgent")
        );
    }

    fn assert_agent_guidance(request: &MessagesRequest) {
        let system = request.system.as_deref().unwrap();
        assert!(system.contains("Delegation is available in this request"));
        assert!(!system.contains("No sub-agent creation tool is attached"));
        for &name in KWORKER_AGENT_TOOLS {
            assert!(request.tools.iter().any(|tool| tool.name == name), "{name}");
        }
        assert!(!request.tools.iter().any(|tool| tool.name == "PlanAgent"));
    }

    #[tokio::test]
    async fn office_provider_request_preserves_complete_widget_description() {
        let root = tempfile::tempdir().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let tool = kcoder_tools::ShowWidgetTool::preview();
        let expected = tool.description();
        let engine = TestEngineBuilder::new(root.path())
            .provider(Arc::new(RequestRecordingProvider {
                requests: Arc::clone(&requests),
            }))
            .tool_registry(kcoder_tools::default_registry())
            .build_with_profile_directory()
            .with_client_presentation(presentation())
            .with_inline_widget_tool(tool);
        let request = record_request(&engine, &requests).await;
        // Luna defaults now include REPL, AskUserQuestion and WebBrowser.
        assert_eq!(request.tools.len(), 26);
        let definition = request
            .tools
            .iter()
            .find(|definition| definition.name == "show_widget")
            .unwrap();
        assert_eq!(definition.description.as_bytes(), expected.as_bytes());
        assert!(
            definition
                .description
                .starts_with("Render or read an inline visualization")
        );
        assert!(
            definition
                .description
                .contains("After an interrupted/unknown render call, READ")
        );
        assert!(
            definition
                .description
                .contains("add `lookup_attempt_id` only when its actual value is known")
        );
        assert!(
            definition
                .description
                .contains("no copyable placeholder-ID JSON is provided")
        );
        assert!(
            !definition
                .description
                .contains("\"lookup_attempt_id\":\"ACTUAL_ATTEMPT_ID\"")
        );
        assert!(
            definition
                .description
                .ends_with("This host supports managed mode only; isolated_html is unavailable.")
        );
        let transport: Value = serde_json::to_value(&request.tools).unwrap();
        let transmitted = transport
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "show_widget")
            .unwrap();
        assert_eq!(
            transmitted["description"].as_str().unwrap().as_bytes(),
            expected.as_bytes()
        );
    }

    #[tokio::test]
    async fn office_provider_request_has_independent_identity_and_keeps_project_history_intact() {
        let root = tempfile::tempdir().unwrap();
        let project = "PROJECT_GUIDE: delegate work to multiple agents when useful.";
        std::fs::write(root.path().join("AGENTS.md"), project).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let engine = TestEngineBuilder::new(root.path())
            .provider(Arc::new(RequestRecordingProvider {
                requests: Arc::clone(&requests),
            }))
            .tool_registry(kcoder_tools::default_registry())
            .build_with_profile_directory()
            .with_client_presentation(presentation());
        // Restored runtime skill instructions remain durable, but their request projection is filtered.
        let stale_skill = "<skill_content name=\"using-specs\">STALE_SKILL_DELEGATION: use spawn_agent.</skill_content>";
        engine.state.add_message(Message::runtime_text(stale_skill));
        engine.state.add_message(Message::assistant_text(
            "Earlier I offered parallel sub-agents.",
        ));
        let request = record_request(&engine, &requests).await;
        let system = request.system.as_deref().unwrap();
        assert!(system.starts_with("You are KWorker, developed by KunlunMeta"));
        assert!(!system.contains("You are KCoder"));
        assert!(!system.contains("mode of KCoder Studio"));
        assert!(system.contains("Workflow is available for reusable workflows"));
        assert!(!system.contains("executable entry point"));
        assert!(!system.contains("do not mix profile-specific entry points"));
        assert_agent_guidance(&request);
        let body = serde_json::to_string(&request.messages).unwrap();
        assert!(
            body.contains(project),
            "User project instructions must not be rewritten"
        );
        assert!(!body.contains("STALE_SKILL_DELEGATION"));
        assert!(body.contains("Earlier I offered parallel sub-agents"));
        assert!(
            serde_json::to_string(&engine.state.messages())
                .unwrap()
                .contains("STALE_SKILL_DELEGATION")
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("AGENTS.md")).unwrap(),
            project
        );
    }

    #[tokio::test]
    async fn office_provider_catalog_and_execution_extend_agents_with_custom_luna_lists() {
        let root = tempfile::tempdir().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let engine = TestEngineBuilder::new(root.path())
            .provider(Arc::new(RequestRecordingProvider {
                requests: Arc::clone(&requests),
            }))
            .tool_registry(kcoder_tools::default_registry())
            .build_with_profile_directory()
            .with_client_presentation(presentation());
        assert_agent_guidance(&record_request(&engine, &requests).await);
        engine.settings.write().unwrap().tools.luna.allowed =
            ["read", "Workflow", "TodoWrite", "TaskOutput", "TaskStop"]
                .into_iter()
                .map(str::to_string)
                .collect();
        let custom = record_request(&engine, &requests).await;
        assert_agent_guidance(&custom);
        let catalog = engine.effective_tool_catalog().await;
        let mut probes = engine.tools.clone().filtered_out_by_patterns(
            &KWORKER_AGENT_TOOLS
                .iter()
                .map(|name| (*name).to_string())
                .collect::<Vec<_>>(),
        );
        for &name in KWORKER_AGENT_TOOLS {
            assert!(engine.active_tool_registry().get(name).is_some(), "{name}");
            assert!(catalog.iter().any(|tool| tool.name == name), "{name}");
            probes = probes.register(NamedTool(name));
        }
        for name in ["Workflow", "TodoWrite", "TaskOutput", "TaskStop"] {
            assert!(custom.tools.iter().any(|tool| tool.name == name), "{name}");
            assert!(catalog.iter().any(|tool| tool.name == name), "{name}");
        }
        // Controlled tools prove the ordinary execution gate accepts each canonical name,
        // without spawning real model work; the provider/catalog above use real definitions.
        let engine = engine.with_turn_tools(probes);
        for &name in KWORKER_AGENT_TOOLS {
            let (result, permission, _, _) = engine
                .execute_tool(
                    "agent-probe",
                    name,
                    serde_json::json!({}),
                    &kcoder_permissions::AutoAllowPrompt,
                )
                .await
                .unwrap();
            assert!(!result.is_error, "{name}");
            assert!(!matches!(permission, PermissionDecision::Deny), "{name}");
            assert_eq!(result.content, ToolOutput::text("ok").content);
        }
        for &name in KWORKER_AGENT_TOOLS {
            engine.settings.write().unwrap().tools.disabled = vec![name.into()];
            assert!(engine.active_tool_registry().get(name).is_none());
            assert!(
                !engine
                    .effective_tool_catalog()
                    .await
                    .iter()
                    .any(|tool| tool.name == name)
            );
            let (result, permission, _, _) = engine
                .execute_tool(
                    "disabled-agent",
                    name,
                    serde_json::json!({}),
                    &kcoder_permissions::AutoAllowPrompt,
                )
                .await
                .unwrap();
            assert!(result.is_error);
            assert!(matches!(permission, PermissionDecision::Deny));
        }
        engine.settings.write().unwrap().tools.disabled =
            vec!["spawn_agent".into(), "explore_agent".into()];
        let supervision_only = record_request(&engine, &requests).await;
        let system = supervision_only.system.as_deref().unwrap();
        assert!(system.contains("No sub-agent creation tool is attached"));
        assert!(!system.contains("Delegation is available in this request"));
        assert!(!supervision_only.tools.iter().any(|tool| {
            ["spawn_agent", "explore_agent", "PlanAgent"].contains(&tool.name.as_str())
        }));
        for name in ["SendMessage", "wait", "close_agent"] {
            assert!(supervision_only.tools.iter().any(|tool| tool.name == name));
        }
        engine.settings.write().unwrap().tools.disabled.clear();
        engine.settings.write().unwrap().model_capabilities.tools = false;
        let none = record_request(&engine, &requests).await;
        assert!(none.tools.is_empty());
        assert_no_delegation_guidance(&none);
        assert!(
            !none
                .system
                .as_deref()
                .unwrap()
                .contains("Workflow is available")
        );
    }

    #[tokio::test]
    async fn cli_provider_request_keeps_kcoder_identity_and_full_tools_even_for_office_history() {
        let root = tempfile::tempdir().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let engine = TestEngineBuilder::new(root.path())
            .provider(Arc::new(RequestRecordingProvider {
                requests: Arc::clone(&requests),
            }))
            .tool_registry(kcoder_tools::default_registry())
            .build_with_profile_directory();
        engine
            .state
            .set_studio_work_mode_before_first_message(StudioWorkMode::Kworker)
            .unwrap();
        let request = record_request(&engine, &requests).await;
        let system = request.system.as_deref().unwrap();
        assert!(system.starts_with("You are KCoder, developed by KunlunMeta"));
        assert!(!system.contains("You are KWorker"));
        assert!(system.contains("Delegate independent bounded subtasks"));
        assert!(request.tools.iter().any(|tool| tool.name == "spawn_agent"));
        let catalog = engine.effective_tool_catalog().await;
        for name in [
            "spawn_agent",
            "explore_agent",
            "SendMessage",
            "wait",
            "close_agent",
        ] {
            assert!(request.tools.iter().any(|tool| tool.name == name), "{name}");
            assert!(catalog.iter().any(|tool| tool.name == name), "{name}");
        }
        assert!(!system.contains("No sub-agent delegation tool is attached"));
        assert!(system.contains("The active KCoder executable entry point is"));
        assert!(system.contains("process lifecycle is scoped to the current KCoder session"));
        assert!(system.contains("when a user request concerns KCoder configuration"));
        assert!(system.contains("The exact active model identifier for this request is"));
    }

    fn assert_kworker_model_introduction(request: &MessagesRequest, expected_model: &str) {
        assert_eq!(request.model, expected_model);
        let system = request.system.as_deref().unwrap();
        let mut parts = system.split("\n\n");
        assert_eq!(
            parts.next().unwrap(),
            "You are KWorker, developed by KunlunMeta Artificial Intelligence Technology (Shanghai) Co., Ltd. (昆仑元人工智能技术（上海）有限公司)."
        );
        let model_identity = parts.next().unwrap();
        assert_eq!(
            model_identity,
            format!(
                "The model currently in use is {}. Introduce yourself naturally and briefly in the user's language.",
                serde_json::to_string(expected_model).unwrap()
            )
        );
        for removed in [
            "KCoder's model",
            "Do not say that you run inside KCoder",
            "Provider IDs can name proxies or routing services",
            "Correct introduction templates are",
            "executable entry point",
            "do not mix profile-specific entry points",
        ] {
            assert!(!system.contains(removed), "{removed}");
        }
        assert!(!model_identity.contains("KCoder"));
        assert!(!model_identity.contains("Do not"));
        assert!(!system.to_ascii_lowercase().contains("kcoder"));
    }

    #[tokio::test]
    async fn office_system_is_unbranded_with_shipped_office_skill_context_and_side_question() {
        let root = tempfile::Builder::new()
            .prefix("office-workspace-")
            .tempdir()
            .unwrap();
        let shipped = std::path::PathBuf::from(
            std::env::var_os("KCODER_WORKSPACE_ROOT").expect("current workspace root"),
        )
        .join("crates/kcoder_engine")
        .join("../../skills");
        let skills = ["docx", "pdf", "pptx", "xlsx", "kworker-visualization"];
        for name in skills {
            let directory = root.path().join(".kcoder/skills").join(name);
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::copy(
                shipped.join(name).join("SKILL.md"),
                directory.join("SKILL.md"),
            )
            .unwrap();
        }
        let settings_skill = root.path().join(".kcoder/skills/kcoder-settings");
        std::fs::create_dir_all(&settings_skill).unwrap();
        std::fs::copy(
            std::path::PathBuf::from(
                std::env::var_os("KCODER_WORKSPACE_ROOT").expect("current workspace root"),
            )
            .join("crates/kcoder_engine")
            .join("../kcoder_skills/src/assets/builtin/kcoder-settings/SKILL.md"),
            settings_skill.join("SKILL.md"),
        )
        .unwrap();
        let described_brand = root.path().join(".kcoder/skills/configuration-helper");
        std::fs::create_dir_all(&described_brand).unwrap();
        std::fs::write(described_brand.join("SKILL.md"), "---\nname: configuration-helper\ndescription: Configure KCODER user settings\n---\nUser-authored configuration instructions.\n").unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let engine = TestEngineBuilder::new(root.path())
            .provider(Arc::new(RequestRecordingProvider {
                requests: Arc::clone(&requests),
            }))
            .tool_registry(kcoder_tools::default_registry())
            .build_with_profile_directory()
            .with_client_presentation(presentation())
            .with_inline_widget_tool(kcoder_tools::ShowWidgetTool::preview());
        for name in skills {
            assert!(engine.activate_skill_if_available(name), "{name}");
            // Cargo test binaries do not have the packaged CLI basename. Restore a
            // host-generated prefix fixture while retaining the actual shipped body.
            let prompt = engine
                .skill_registry
                .read()
                .unwrap()
                .get_active(name)
                .unwrap()
                .invocation_text(&[]);
            let marker = format!("<skill_content name=\"{name}\">\n");
            let host_note = "<skill_runtime_context>本次会话的 KCoder CLI 入口是 `kcoder`。技能正文中的 `kcoder` 只是通用占位符；执行 CLI 命令时必须替换为 `kcoder`，不要混用其他 profile 的入口。</skill_runtime_context>\n\n";
            engine
                .state
                .add_message(Message::runtime_text(prompt.replacen(
                    &marker,
                    &format!("{marker}{host_note}"),
                    1,
                )));
        }
        assert!(engine.skill_available_in_current_request("kcoder-settings"));
        assert!(engine.skill_available_in_current_request("configuration-helper"));
        let request = record_request(&engine, &requests).await;
        let system = request.system.as_deref().unwrap();
        assert!(!system.to_ascii_lowercase().contains("kcoder"));
        assert!(system.contains("process lifecycle is scoped to the current session"));
        assert!(system.contains("when a user request concerns application or user configuration"));
        for name in skills {
            assert!(system.contains(&format!("\"name\":\"{name}\"")), "{name}");
        }
        assert!(
            request
                .tools
                .iter()
                .any(|tool| ["bash", "PowerShell"].contains(&tool.name.as_str()))
        );
        assert!(
            request
                .tools
                .iter()
                .any(|tool| tool.name == "DiscoverSkills")
        );
        assert!(
            serde_json::to_string(&request.messages)
                .unwrap()
                .contains("data-kcoder-chart"),
            "Technical markup must retain its real contract"
        );
        for name in skills {
            let marker = format!("<skill_content name=\"{name}\">");
            let text = request
                .messages
                .iter()
                .find_map(|message| match message {
                    Message::User {
                        content,
                        origin: kcoder_types::MessageOrigin::Runtime,
                        ..
                    } => content.iter().find_map(|block| match block {
                        ContentBlock::Text { text } if text.starts_with(&marker) => Some(text),
                        _ => None,
                    }),
                    _ => None,
                })
                .unwrap();
            assert!(!text.contains("<skill_runtime_context>"), "{name}");
            assert!(text.contains(&format!("# Skill: {name}")), "{name}");
        }
        assert!(
            serde_json::to_string(&engine.state.messages())
                .unwrap()
                .contains("<skill_runtime_context>"),
            "Only the request projection may omit the host wrapper"
        );
        let (discovered, _, _, _) = engine
            .execute_tool(
                "discover-settings",
                "DiscoverSkills",
                serde_json::json!({"description":"kcoder configuration settings", "limit":20}),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await
            .unwrap();
        assert!(!discovered.is_error);
        let discovery = serde_json::to_string(&discovered.content).unwrap();
        assert!(discovery.contains("kcoder-settings"));
        assert!(discovery.contains("configuration-helper"));
        let (activated, _, _, _) = engine
            .execute_tool(
                "activate-settings",
                "skill",
                serde_json::json!({"skill":"kcoder-settings"}),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await
            .unwrap();
        assert!(!activated.is_error, "{activated:?}");
        assert!(
            serde_json::to_string(&activated.user_context)
                .unwrap()
                .contains("kcoder config")
        );
        let activated_request = record_request(&engine, &requests).await;
        assert!(
            !activated_request
                .system
                .as_deref()
                .unwrap()
                .to_ascii_lowercase()
                .contains("kcoder")
        );
        let activated_messages = serde_json::to_string(&activated_request.messages).unwrap();
        assert!(activated_messages.contains("kcoder config"));
        assert!(!activated_messages.contains("<skill_runtime_context>"));
        engine
            .run_side_question("介绍一下你自己", CancellationToken::new())
            .await
            .unwrap();
        let side = requests.lock().unwrap().last().unwrap().clone();
        assert!(
            !side
                .system
                .as_deref()
                .unwrap()
                .to_ascii_lowercase()
                .contains("kcoder")
        );
        assert!(side.tools.is_empty());
        let full = record_request(&engine.clone().with_client_presentation(None), &requests).await;
        assert!(
            serde_json::to_string(&full.messages)
                .unwrap()
                .contains("<skill_runtime_context>")
        );
        assert!(
            full.system
                .as_deref()
                .unwrap()
                .contains("\"name\":\"kcoder-settings\"")
        );
        assert!(
            full.system
                .as_deref()
                .unwrap()
                .contains("Configure KCODER user settings")
        );
    }

    #[tokio::test]
    async fn office_model_introduction_is_short_positive_and_uses_current_request_model() {
        let root = tempfile::tempdir().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let engine = TestEngineBuilder::new(root.path())
            .provider(Arc::new(RequestRecordingProvider {
                requests: Arc::clone(&requests),
            }))
            .tool_registry(kcoder_tools::default_registry())
            .build_with_profile_directory()
            .with_client_presentation(presentation());
        for model in [
            "MiniMax-M3.1-Flash-Preview",
            "ProxyAlias/CaseSensitiveModelV2",
        ] {
            engine.settings.write().unwrap().model = model.into();
            let request = record_request(&engine, &requests).await;
            assert_kworker_model_introduction(&request, model);
            // Luna defaults now include REPL, AskUserQuestion and WebBrowser.
            assert_eq!(request.tools.len(), 25);
            engine
                .run_side_question("介绍一下你自己和当前模型", CancellationToken::new())
                .await
                .unwrap();
            let side = requests.lock().unwrap().last().unwrap().clone();
            assert_kworker_model_introduction(&side, model);
            assert!(side.tools.is_empty());
        }
    }

    #[tokio::test]
    async fn office_side_question_provider_request_keeps_identity_without_tools_or_stale_skills() {
        let root = tempfile::tempdir().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let engine = TestEngineBuilder::new(root.path())
            .provider(Arc::new(RequestRecordingProvider {
                requests: Arc::clone(&requests),
            }))
            .tool_registry(kcoder_tools::default_registry())
            .build_with_profile_directory()
            .with_client_presentation(presentation());
        engine.state.add_message(Message::runtime_text(
            "<skill_content name=\"using-specs\">STALE_SIDE_DELEGATION use spawn_agent</skill_content>",
        ));
        engine
            .run_side_question("Who are you and what can you do?", CancellationToken::new())
            .await
            .unwrap();
        let request = requests.lock().unwrap().last().unwrap().clone();
        let system = request.system.as_deref().unwrap();
        assert!(system.starts_with("You are KWorker, developed by KunlunMeta"));
        assert!(!system.contains("You are KCoder"));
        assert!(request.tools.is_empty());
        assert_no_delegation_guidance(&request);
        assert!(
            !serde_json::to_string(&request.messages)
                .unwrap()
                .contains("STALE_SIDE_DELEGATION")
        );
        assert!(
            serde_json::to_string(&engine.state.messages())
                .unwrap()
                .contains("STALE_SIDE_DELEGATION")
        );
    }
}
