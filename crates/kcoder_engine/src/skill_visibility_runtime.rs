//! Per-client skill visibility follows the actual tool policy without editing durable history.
use super::*;

pub(super) fn skill_name_matches(left: &str, right: &str) -> bool {
    left == right || left.rsplit(':').next() == right.rsplit(':').next()
}

fn office_skill_without_host_entrypoint(text: &str) -> Option<String> {
    let leading = text.len() - text.trim_start().len();
    let invocation = &text[leading..];
    let invocation = invocation.strip_prefix("<skill_content name=\"")?;
    let (_, body) = invocation.split_once("\">\n")?;
    let note = body.strip_prefix("<skill_runtime_context>")?;
    if !note.starts_with("本次会话的 KCoder CLI 入口是 `") {
        return None;
    }
    let note_end =
        note.find("</skill_runtime_context>\n\n")? + "</skill_runtime_context>\n\n".len();
    let prefix_end = text.len() - body.len();
    Some(format!("{}{}", &text[..prefix_end], &note[note_end..]))
}

impl QueryEngine {
    pub(super) fn blocked_skill_names_for_request(&self) -> Vec<String> {
        let model_tools = recover_read_lock(&self.settings, "settings")
            .model_capabilities
            .tools;
        let available = if model_tools {
            self.active_tool_registry()
                .all()
                .into_iter()
                .filter(|tool| tool.is_model_visible())
                .map(|tool| tool.name())
                .collect::<HashSet<_>>()
        } else {
            HashSet::new()
        };
        let mut blocked = Vec::new();
        if self.is_luna_mode_active() || self.office_tool_policy_active() {
            blocked.push(SPEC_WORKFLOW_SKILL_NAME.to_owned());
        }
        if !self.inline_widgets_enabled() || !available.contains("show_widget") {
            blocked.push("kworker-visualization".to_owned());
        }
        let registry = recover_read_lock(&self.skill_registry, "skill_registry");
        blocked.extend(
            registry
                .iter_all()
                .filter(|skill| {
                    skill
                        .requires_tools
                        .iter()
                        .any(|tool| !available.contains(tool))
                })
                .map(|skill| skill.name.clone()),
        );
        blocked.sort();
        blocked.dedup();
        blocked
    }

    /// This only shrinks visibility; registry trust and activation guards still apply.
    pub fn skill_available_in_current_request(&self, name: &str) -> bool {
        !self
            .blocked_skill_names_for_request()
            .iter()
            .any(|blocked| skill_name_matches(blocked, name))
    }

    /// Project restored names without mutating the active list shared by other clients.
    pub fn effective_active_skill_names(&self) -> Vec<String> {
        let blocked = self.blocked_skill_names_for_request();
        recover_read_lock(&self.active_skills, "active_skills")
            .iter()
            .filter(|name| !blocked.iter().any(|item| skill_name_matches(item, name)))
            .cloned()
            .collect()
    }

    /// Saved runtime instructions may be ineligible for a different client. Keep the
    /// stored transcript intact and detach only the affected request messages.
    pub(super) fn project_skill_messages(&self, messages: &mut kcoder_types::SharedMessages) {
        let blocked = self.blocked_skill_names_for_request();
        let office = self.office_tool_policy_active();
        let resource_contexts = recover_read_lock(&self.skill_registry, "skill_registry")
            .iter_all()
            .map(|skill| (skill.name.clone(), skill.resource_context()))
            .collect::<HashMap<_, _>>();
        let expert_names = recover_read_lock(&self.skill_registry, "skill_registry")
            .names()
            .into_iter()
            .filter(|name| name.starts_with("expert:"))
            .collect::<HashSet<_>>();
        let expert_history = messages.iter().any(|message| match message {
            Message::User {
                content,
                origin: kcoder_types::MessageOrigin::Runtime,
            } => content.iter().any(|block| {
                matches!(block, ContentBlock::Text { text }
                    if text.trim_start().starts_with("<skill_content name=\"expert:"))
            }),
            _ => false,
        });
        let legacy_skill_context = messages.iter().any(|message| match message {
            Message::User { content, origin: kcoder_types::MessageOrigin::Runtime } => content.iter().any(|block|
                matches!(block, ContentBlock::Text { text } if text.trim_start().starts_with("<skill_content name=\"")
                    && !text.contains("<skill_resource_context>"))),
            _ => false,
        });
        if blocked.is_empty() && !office && !expert_history && !legacy_skill_context {
            return;
        }
        let changes = messages
            .iter()
            .enumerate()
            .filter_map(|(index, message)| {
                let Message::User {
                    content,
                    origin: kcoder_types::MessageOrigin::Runtime,
                    ..
                } = message
                else {
                    return None;
                };
                let is_blocked = |block: &ContentBlock| match block {
                    ContentBlock::Text { text } => text
                        .trim_start()
                        .strip_prefix("<skill_content name=\"")
                        .and_then(|value| value.split_once('"'))
                        .is_some_and(|(name, _)| {
                            (name.starts_with("expert:") && !expert_names.contains(name))
                                || blocked.iter().any(|item| skill_name_matches(item, name))
                        }),
                    _ => false,
                };
                let has_blocked = content.iter().any(is_blocked);
                let mut projected = message.clone();
                let mut changed = has_blocked;
                if let Message::User { content, .. } = &mut projected {
                    content.retain(|block| !is_blocked(block));
                    if office {
                        for block in content.iter_mut() {
                            if let ContentBlock::Text { text } = block
                                && let Some(without_note) =
                                    office_skill_without_host_entrypoint(text)
                            {
                                *text = without_note;
                                changed = true;
                            }
                        }
                    }
                    for block in content.iter_mut() {
                        if let ContentBlock::Text { text } = block
                            && !text.contains("<skill_resource_context>")
                            && let Some((name, _)) = text
                                .trim_start()
                                .strip_prefix("<skill_content name=\"")
                                .and_then(|value| value.split_once('"'))
                            && let Some(resources) = resource_contexts.get(name)
                            && let Some(end) = text.rfind("</skill_content>")
                        {
                            text.insert_str(end, &format!("\n{resources}\n"));
                            changed = true;
                        }
                    }
                }
                changed.then_some((index, projected))
            })
            .collect::<Vec<_>>();
        for (index, projected) in changes.into_iter().rev() {
            if matches!(&projected, Message::User { content, .. } if content.is_empty()) {
                messages.remove_range(index..index + 1);
            } else if let Some(message) = messages.get_mut(index) {
                *message = projected;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{
        engine_builder::TestEngineBuilder, providers::RequestRecordingProvider,
    };
    use futures::StreamExt;
    use kcoder_tools::{DiscoverSkillsTool, SkillTool, Tool, ToolContext, ToolError, ToolOutput};
    use kcoder_types::{ClientPresentationV1, MessagesRequest, StudioWorkMode};
    use std::sync::Mutex;

    #[derive(Debug)]
    struct WidgetTool;
    #[async_trait::async_trait]
    impl Tool for WidgetTool {
        fn name(&self) -> String {
            "show_widget".into()
        }
        fn description(&self) -> String {
            "Inline visibility probe".into()
        }
        fn input_schema(&self) -> Value {
            serde_json::json!({"type":"object"})
        }
        async fn call(&self, _: Value, _: &ToolContext) -> Result<ToolOutput, ToolError> {
            Ok(ToolOutput::text("ok"))
        }
    }

    fn fixture(root: &Path) -> (QueryEngine, Arc<Mutex<Vec<MessagesRequest>>>) {
        for name in ["kworker-visualization", "ordinary", "using-specs"] {
            let dir = root.join(".kcoder/skills").join(name);
            std::fs::create_dir_all(&dir).unwrap();
            let requires = if name == "kworker-visualization" {
                "metadata:\n  kcoder:\n    requires_tools: [show_widget]\npaths: ['**/*.svg']\n"
            } else {
                ""
            };
            std::fs::write(dir.join("SKILL.md"), format!(
                "---\nname: {name}\ndescription: Visualization fixture {name}\n{requires}---\nBODY_{name}"
            )).unwrap();
        }
        let requests = Arc::new(Mutex::new(Vec::new()));
        let engine = TestEngineBuilder::new(root)
            .provider(Arc::new(RequestRecordingProvider {
                requests: Arc::clone(&requests),
            }))
            .tool_registry(
                ToolRegistry::new()
                    .register(SkillTool)
                    .register(DiscoverSkillsTool),
            )
            .build_with_profile_directory();
        (engine, requests)
    }

    fn office(engine: QueryEngine) -> QueryEngine {
        engine
            .with_client_presentation(Some(ClientPresentationV1 {
                version: 1,
                studio_work_mode: Some(StudioWorkMode::Kworker),
                inline_widgets: true,
                isolated_widgets: false,
            }))
            .with_inline_widget_tool(WidgetTool)
    }

    async fn request(
        engine: &QueryEngine,
        requests: &Arc<Mutex<Vec<MessagesRequest>>>,
    ) -> MessagesRequest {
        engine
            .state
            .add_message(Message::user_text("Review this fixture"));
        let _ = engine
            .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
            .collect::<Vec<_>>()
            .await;
        requests.lock().unwrap().last().unwrap().clone()
    }

    #[tokio::test]
    async fn restored_skill_resources_are_projected_without_rewriting_history_or_user_text() {
        let root = tempfile::tempdir().unwrap();
        let (engine, _) = fixture(root.path());
        let legacy = "<skill_content name=\"ordinary\">\nOLD_ARGUMENTS_KEPT\n</skill_content>";
        engine.state.add_message(Message::runtime_text(legacy));
        engine.state.add_message(Message::user_text(legacy));
        let original = engine.state.messages();
        let mut projected = kcoder_types::SharedMessages::from(original.clone());
        engine.project_skill_messages(&mut projected);
        let encoded = serde_json::to_string(&projected).unwrap();
        assert_eq!(encoded.matches("Skill base directory:").count(), 1);
        assert!(encoded.contains("ordinary/SKILL.md") || encoded.contains("ordinary\\\\SKILL.md"));
        assert_eq!(encoded.matches("OLD_ARGUMENTS_KEPT").count(), 2);
        assert_eq!(engine.state.messages(), original);
        let first = projected.clone();
        engine.project_skill_messages(&mut projected);
        assert_eq!(projected, first);
    }

    #[tokio::test]
    async fn cli_catalog_discovery_explicit_and_path_activation_hide_studio_skill() {
        let root = tempfile::tempdir().unwrap();
        let (engine, requests) = fixture(root.path());
        assert!(
            !engine
                .client_skill_catalog()
                .iter()
                .any(|skill| skill.name == "kworker-visualization")
        );
        assert!(!engine.activate_skill_if_available("kworker-visualization"));
        engine.activate_matching_skills(&["example.svg".into()]);
        assert!(engine.active_skills.read().unwrap().is_empty());
        let (discovered, _, _, _) = engine
            .execute_tool(
                "discover",
                "DiscoverSkills",
                serde_json::json!({"description":"Visualization fixture"}),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await
            .unwrap();
        assert!(
            !serde_json::to_string(&discovered.content)
                .unwrap()
                .contains("kworker-visualization")
        );
        let (activated, _, _, _) = engine
            .execute_tool(
                "activate",
                "skill",
                serde_json::json!({"skill":"kworker-visualization"}),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await
            .unwrap();
        assert!(activated.is_error);
        let actual = request(&engine, &requests).await;
        assert!(
            !actual
                .system
                .unwrap_or_default()
                .contains("kworker-visualization")
        );
        assert!(
            !serde_json::to_string(&actual.messages)
                .unwrap()
                .contains("BODY_kworker-visualization")
        );
    }

    #[tokio::test]
    async fn capable_office_loads_skill_but_cli_restore_projects_only_runtime_content() {
        let root = tempfile::tempdir().unwrap();
        let (resident, requests) = fixture(root.path());
        resident
            .state
            .set_studio_work_mode_before_first_message(StudioWorkMode::Kworker)
            .unwrap();
        let studio = office(resident.clone());
        assert!(
            studio
                .client_skill_catalog()
                .iter()
                .any(|skill| skill.name == "kworker-visualization")
        );
        assert!(!studio.skill_available_in_current_request("using-specs"));
        studio.activate_matching_skills(&["example.svg".into()]);
        assert_eq!(
            studio.effective_active_skill_names(),
            ["kworker-visualization"]
        );
        let actual = request(&studio, &requests).await;
        assert!(
            actual
                .system
                .unwrap_or_default()
                .contains("kworker-visualization")
        );
        assert!(
            serde_json::to_string(&actual.messages)
                .unwrap()
                .contains("BODY_kworker-visualization")
        );
        resident
            .state
            .add_message(Message::runtime_text("Keep unrelated runtime context"));
        resident.state.add_message(Message::user_text(
            "<skill_content name=\"kworker-visualization\">USER_COPY</skill_content>",
        ));
        let stored = resident.state.messages();
        assert!(resident.effective_active_skill_names().is_empty());
        let restored = request(&resident, &requests).await;
        let projected = serde_json::to_string(&restored.messages).unwrap();
        assert!(!projected.contains("BODY_kworker-visualization"));
        assert!(projected.contains("Keep unrelated runtime context"));
        assert!(projected.contains("USER_COPY"));
        // Durable history and the other client's shared active list remain untouched.
        assert_eq!(
            &resident.state.messages()[..stored.len()],
            stored.as_slice()
        );
        assert_eq!(
            studio.effective_active_skill_names(),
            ["kworker-visualization"]
        );
        assert_eq!(
            studio.active_skills.read().unwrap().as_slice(),
            ["kworker-visualization"]
        );
    }

    #[test]
    fn disabled_profile_model_and_subagent_guards_compose_with_spec_policy() {
        let root = tempfile::tempdir().unwrap();
        let (resident, _) = fixture(root.path());
        let studio = office(resident.clone());
        assert!(studio.skill_available_in_current_request("kworker-visualization"));
        assert!(studio.skill_available_in_current_request("ordinary"));
        assert!(!studio.skill_available_in_current_request("using-specs"));
        assert!(resident.skill_available_in_current_request("using-specs"));
        let child = studio
            .clone()
            .with_subagent_system_prompt(Some("Read-only child".into()));
        assert!(!child.skill_available_in_current_request("kworker-visualization"));
        let mut disabled = studio.client_presentation_snapshot().unwrap();
        disabled.inline_widgets = false;
        let disabled = studio.clone().with_client_presentation(Some(disabled));
        assert!(!disabled.skill_available_in_current_request("kworker-visualization"));
        studio.settings.write().unwrap().model_capabilities.tools = false;
        assert!(!studio.skill_available_in_current_request("kworker-visualization"));
        assert!(studio.skill_available_in_current_request("ordinary"));
        studio.settings.write().unwrap().model_capabilities.tools = true;
        studio.settings.write().unwrap().tools.profile = kcoder_config::ToolProfile::None;
        // Actual profiles are applied when composing the target's registry.
        let no_tools = studio.with_turn_tools(ToolRegistry::new());
        assert!(!no_tools.skill_available_in_current_request("kworker-visualization"));
    }
}
