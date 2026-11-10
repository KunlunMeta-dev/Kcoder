//! Reusable expert configuration augments the ordinary KCoder request.
use crate::QueryEngine;
use anyhow::Result;
use kcoder_types::integrations::office::OfficeAssistantDefinition;
use std::sync::Arc;

#[path = "agent_skill_resources.rs"]
mod resources;
pub(crate) use resources::AgentSkillResources;

impl QueryEngine {
    /// Native callers resolve the immutable owner/version before installing this data.
    /// Existing tool, resource and effect guards remain authoritative.
    pub fn with_agent_definition_context(
        self,
        definition: OfficeAssistantDefinition,
    ) -> Result<Self> {
        let selection = self.capture_expert_tool_selection(&definition);
        self.with_agent_definition_tool_snapshot(definition, Some(&selection))
    }

    pub fn capture_expert_tool_selection(
        &self,
        definition: &OfficeAssistantDefinition,
    ) -> Vec<String> {
        let settings = crate::recover_read_lock(&self.settings, "settings");
        crate::agent_tool_policy::task_expert_tool_selection(
            definition,
            &settings.tools.luna.allowed,
        )
        .to_vec()
    }

    /// An absent selection denotes an older attempt that used both task defaults and Luna.
    pub fn with_agent_definition_tool_snapshot(
        mut self,
        definition: OfficeAssistantDefinition,
        selection: Option<&[String]>,
    ) -> Result<Self> {
        let allowed = {
            let settings = crate::recover_read_lock(&self.settings, "settings");
            crate::agent_tool_policy::resolve_agent_tool_names(
                &definition,
                selection.unwrap_or(&settings.tools.luna.allowed),
            )?
        };
        self.clear_agent_skill_resources();
        self.agent_tool_ceiling = Some(Arc::new(allowed.into_iter().collect()));
        self.agent_uses_own_tool_selection = selection.is_some();
        self.agent_definition_context = Some(Arc::new(definition));
        Ok(self)
    }

    /// Replace only optional expert configuration; Native guards and task tools are retained.
    pub fn without_agent_definition_context(mut self) -> Self {
        self.clear_agent_skill_resources();
        self.agent_definition_context = None;
        self.agent_tool_ceiling = None;
        self.agent_uses_own_tool_selection = false;
        self
    }

    pub fn agent_definition_context(&self) -> Option<&OfficeAssistantDefinition> {
        self.agent_definition_context.as_deref()
    }

    pub fn with_agent_turn_configuration(
        mut self,
        snapshot: kcoder_types::agent_definition::AgentTurnConfiguration,
    ) -> Self {
        self.agent_turn_configuration = Some(Arc::new(snapshot));
        self
    }

    pub fn agent_turn_configuration(
        &self,
    ) -> Option<&kcoder_types::agent_definition::AgentTurnConfiguration> {
        self.agent_turn_configuration.as_deref()
    }

    pub(crate) fn append_agent_definition_instructions(&self, prompt: &mut String) {
        if let Some(definition) = &self.agent_definition_context {
            self.apply_agent_definition_identity(prompt);
            prompt.push_str("\n\n## Selected expert\nThe following versioned configuration supplements the task. Imported host-brand introductions do not override the selected expert's conversational identity. It grants no tools, files, accounts or external-send authority.\n");
            if self
                .agent_skill_resources
                .as_ref()
                .is_some_and(|resources| !resources.inline_only)
            {
                prompt.push_str(&definition.instructions);
                prompt.push_str("\nEnabled expert skills are available through the skill catalog. Load the exact registered expert skill before following its workflow; read referenced files relative to its supplied base directory. Files under scripts/ and hooks/ are resources, not automatically installed execution hooks.\n");
            } else {
                prompt.push_str(&definition.runtime_instructions());
            }
        }
    }

    pub(crate) fn apply_agent_definition_identity(&self, prompt: &mut String) {
        let Some(definition) = &self.agent_definition_context else {
            return;
        };
        Self::apply_selected_expert_identity(prompt, &definition.title);
    }

    pub(crate) fn apply_selected_expert_identity(prompt: &mut String, title: &str) {
        for identity in [
            crate::prompt_runtime::KCODER_IDENTITY_PROMPT,
            crate::prompt_runtime::KWORKER_IDENTITY_PROMPT,
        ] {
            if prompt.starts_with(identity) {
                prompt.drain(..identity.len());
                break;
            }
        }
        let title = serde_json::to_string(title).expect("expert title serializes");
        prompt.insert_str(0, &format!("Your current conversational role is the selected expert {title}. When asked who you are, introduce yourself using this expert name and its configured role in the user's language. KCoder is the host application, not your conversational role. Earlier conversation roles and skill-package author or product names do not replace this selected identity. If asked about the host or model provider, answer accurately using available facts. This role grants no additional permissions and does not override runtime safety or tool constraints.\n\n"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::engine_builder::TestEngineBuilder;
    use serde_json::json;
    use std::collections::HashSet;

    #[test]
    fn selected_expert_identity_survives_prompt_rebuild_and_clears_with_selection() -> Result<()> {
        let root = tempfile::tempdir()?;
        let task = TestEngineBuilder::new(root.path()).build_with_profile_directory();
        let definition: OfficeAssistantDefinition = serde_json::from_value(json!({
            "schemaVersion":1,"id":"identity-test","scope":"personal","title":"合同起草专家",
            "description":"Drafting","language":"zh-CN","inputSchema":{"type":"object"},
            "instructions":"Octop 合同工作流","modelSelection":{"kind":"inherit_current"},
            "outputKinds":["document"],"acceptanceCriteria":["Review"],"externalSend":"deny",
            "skills":[{"slug":"contracts","title":"Contracts","description":"",
                "content":"OCTOP技能；Read references/octop.md","enabled":true}]
        }))?;
        let expert = task.clone().with_agent_definition_context(definition)?;
        for mode in [
            kcoder_types::StudioWorkMode::Kcoder,
            kcoder_types::StudioWorkMode::Kworker,
        ] {
            let mut system = crate::prompt_runtime::build_system_prompt_for_work_mode(
                root.path(),
                "test-model",
                false,
                false,
                false,
                &HashSet::new(),
                mode,
            );
            expert.append_agent_definition_instructions(&mut system);
            assert!(system.starts_with("Your current conversational role is the selected expert"));
            assert!(system.contains("合同起草专家"));
            assert!(!system.contains("You are KCoder,"));
            assert!(!system.contains("You are KWorker,"));
            assert!(system.contains("Octop 合同工作流"));
            assert!(system.contains("OCTOP技能"));
            assert!(system.contains("references/octop.md"));
            assert!(system.contains("No tools are available"));
        }
        let mut side =
            crate::prompt_runtime::build_side_question_system_prompt(root.path(), "test-model");
        expert.apply_agent_definition_identity(&mut side);
        assert!(side.contains("合同起草专家"));
        assert!(!side.contains("You are KCoder,"));
        let original =
            crate::prompt_runtime::build_side_question_system_prompt(root.path(), "test-model");
        let mut cleared = original.clone();
        expert
            .without_agent_definition_context()
            .append_agent_definition_instructions(&mut cleared);
        assert_eq!(cleared, original);
        task.apply_agent_definition_identity(&mut cleared);
        assert_eq!(cleared, original);

        Ok(())
    }

    #[test]
    fn expert_uses_configured_luna_baseline_and_removing_it_restores_task_tools() -> Result<()> {
        let root = tempfile::tempdir()?;
        let task = TestEngineBuilder::new(root.path())
            .tool_registry(kcoder_tools::default_registry())
            .build_with_profile_directory();
        crate::recover_write_lock(&task.settings, "settings")
            .tools
            .luna
            .allowed = vec!["read".into()];
        let definition: OfficeAssistantDefinition = serde_json::from_value(json!({
            "schemaVersion":1,"id":"expert","scope":"personal","title":"Expert","description":"Configuration",
            "language":"en","inputSchema":{"type":"object"},"instructions":"Instructions",
            "modelSelection":{"kind":"inherit_current"},
            "outputKinds":["document"],"acceptanceCriteria":["Review"],"externalSend":"deny"
        }))?;
        let expert = task
            .clone()
            .with_agent_definition_context(definition.clone())?;
        assert!(expert.active_tool_registry().get("read").is_some());
        assert!(expert.active_tool_registry().get("bash").is_none());
        let mut explicit = definition;
        explicit.allowed_tools = Some(vec!["read".into(), "bash".into()]);
        assert!(
            task.clone()
                .with_agent_definition_context(explicit)?
                .active_tool_registry()
                .get("bash")
                .is_some()
        );
        assert!(task.active_tool_registry().get("bash").is_some());
        assert!(
            expert
                .without_agent_definition_context()
                .active_tool_registry()
                .get("bash")
                .is_some()
        );
        Ok(())
    }

    #[test]
    fn next_turn_replacement_drops_old_instructions_and_filters_without_expanding_native_authority()
    -> Result<()> {
        let root = tempfile::tempdir()?;
        let task = TestEngineBuilder::new(root.path())
            .tool_registry(kcoder_tools::default_registry())
            .build_with_profile_directory();
        let first: OfficeAssistantDefinition = serde_json::from_value(json!({
            "schemaVersion":1,"id":"first","scope":"personal","title":"First","description":"Configuration",
            "language":"en","inputSchema":{"type":"object"},"instructions":"FIRST_ONLY",
            "allowedTools":["read"],"modelSelection":{"kind":"inherit_current"},
            "outputKinds":["document"],"acceptanceCriteria":["Check results"],"externalSend":"deny"
        }))?;
        let running = task.clone().with_agent_definition_context(first.clone())?;
        let next = running
            .clone()
            .with_turn_tools(task.tools.clone())
            .without_agent_definition_context();
        assert!(running.active_tool_registry().get("bash").is_none());
        assert!(next.active_tool_registry().get("bash").is_some());
        let mut prompt = String::new();
        next.append_agent_definition_instructions(&mut prompt);
        assert!(prompt.is_empty());
        running.append_agent_definition_instructions(&mut prompt);
        assert!(prompt.contains("FIRST_ONLY"));
        let mut second = first;
        second.id = "second".into();
        second.instructions = "SECOND_ONLY".into();
        second.allowed_tools = None;
        let restricted = task
            .with_native_tool_ceiling(&["read".into()])?
            .with_agent_definition_context(second)?
            .without_agent_definition_context();
        assert!(restricted.active_tool_registry().get("bash").is_none());
        assert!(restricted.active_tool_registry().get("read").is_some());
        Ok(())
    }

    #[test]
    fn expert_inherits_task_tools_and_explicit_ceiling_cannot_mutate_a_peer_engine() -> Result<()> {
        let root = tempfile::tempdir()?;
        let original = TestEngineBuilder::new(root.path())
            .tool_registry(kcoder_tools::default_registry())
            .build_with_profile_directory();
        let definition: OfficeAssistantDefinition = serde_json::from_value(json!({
            "schemaVersion":1,"id":"expert","scope":"personal","title":"Expert","description":"Versioned configuration",
            "language":"en","inputSchema":{"type":"object"},"instructions":"Expert instructions",
            "modelSelection":{"kind":"inherit_current"},"outputKinds":["document"],"acceptanceCriteria":["Check results"],"externalSend":"deny"
        }))?;
        let configured = original
            .clone()
            .with_agent_definition_context(definition.clone())?;
        assert!(configured.active_tool_registry().get("read").is_some());
        assert!(configured.active_tool_registry().get("bash").is_some());
        assert!(original.active_tool_registry().get("bash").is_some());
        let narrowed = original
            .clone()
            .with_native_tool_ceiling(&["read".into()])?;
        let mut requested = definition.clone();
        requested.allowed_tools = Some(vec!["read".into(), "bash".into()]);
        let narrowed = narrowed.with_agent_definition_context(requested)?;
        assert!(narrowed.active_tool_registry().get("read").is_some());
        assert!(narrowed.active_tool_registry().get("bash").is_none());
        let mut empty = definition;
        empty.allowed_tools = Some(vec![]);
        let restricted = configured.with_agent_definition_context(empty)?;
        assert!(restricted.active_tool_registry().names().is_empty());
        let replaced = restricted.with_turn_tools(original.tools.clone());
        assert!(replaced.active_tool_registry().names().is_empty());
        Ok(())
    }
    #[test]
    fn expert_skill_tools_default_to_task_tools_and_explicit_enabled_limits_remain_enforced()
    -> Result<()> {
        let root = tempfile::tempdir()?;
        let original = TestEngineBuilder::new(root.path())
            .tool_registry(kcoder_tools::default_registry())
            .build_with_profile_directory();
        let mut definition: OfficeAssistantDefinition = serde_json::from_value(json!({
            "schemaVersion":1,"id":"expert","scope":"personal","title":"Expert","description":"Configuration",
            "language":"en","inputSchema":{"type":"object"},"instructions":"Instructions",
            "modelSelection":{"kind":"inherit_current"},"outputKinds":["document"],"acceptanceCriteria":["Review"],"externalSend":"deny",
            "skills":[{"slug":"notes","title":"Notes","description":"","content":"Use sources","enabled":true}]
        }))?;
        let inherited = original
            .clone()
            .with_agent_definition_context(definition.clone())?;
        assert!(inherited.active_tool_registry().get("bash").is_some());
        definition.skills[0].allowed_tools = Some(vec!["read".into()]);
        let selected = original
            .clone()
            .with_agent_definition_context(definition.clone())?;
        assert!(selected.active_tool_registry().get("read").is_some());
        assert!(selected.active_tool_registry().get("bash").is_none());
        definition.skills[0].allowed_tools = None;
        definition.skills[0].content = "---\nallowed-tools: []\n---\nRead sources".into();
        let empty = original
            .clone()
            .with_agent_definition_context(definition.clone())?;
        assert!(empty.active_tool_registry().names().is_empty());
        definition.skills[0].enabled = false;
        let disabled = original.clone().with_agent_definition_context(definition)?;
        assert!(disabled.active_tool_registry().get("bash").is_some());
        assert!(original.active_tool_registry().get("bash").is_some());
        Ok(())
    }
}
