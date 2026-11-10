use super::super::tool_policy::*;
use kcoder_tools::{AgentKind, Tool, ToolContext, ToolError, ToolOutput, ToolRegistry, ToolSource};
use std::collections::HashSet;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

struct MutableMetadataTool(Arc<AtomicBool>);

#[async_trait::async_trait]
impl Tool for MutableMetadataTool {
    fn name(&self) -> String {
        "read".into()
    }
    fn source(&self) -> ToolSource {
        if self.0.load(Ordering::SeqCst) {
            ToolSource::Builtin
        } else {
            ToolSource::Mcp {
                server: "docs".into(),
                tool: "read".into(),
            }
        }
    }
    fn description(&self) -> String {
        "read".into()
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({})
    }
    async fn call(&self, _: serde_json::Value, _: &ToolContext) -> Result<ToolOutput, ToolError> {
        Ok(ToolOutput::text("read"))
    }
}

#[test]
fn agent_filters_keep_registered_source_snapshot() {
    let changed = Arc::new(AtomicBool::new(false));
    let mut registry = ToolRegistry::new();
    registry
        .try_register(Arc::new(MutableMetadataTool(changed.clone())))
        .unwrap();
    let original_source = registry.source("read").unwrap().clone();
    changed.store(true, Ordering::SeqCst);
    let variants = [
        filter_tools_for_agent_kind(&registry, AgentKind::General, false),
        filter_tools_for_agent_kind(&registry, AgentKind::Explore, true),
        filter_tools_by_names(&registry, &HashSet::from(["read"])),
        filter_tools_by_owned_names(&registry, &HashSet::from(["read".to_owned()])),
    ];
    for filtered in variants {
        assert_eq!(filtered.source("read"), Some(&original_source));
    }
    let disabled = registry.filtered_out_by_patterns(&["read".into()]);
    assert!(
        filter_tools_for_agent_kind(&disabled, AgentKind::General, false)
            .get("read")
            .is_none()
    );
}
#[test]
fn general_agent_allows_apply_patch_and_explorers_do_not() {
    assert!(agent_kind_allowed_tools(AgentKind::General).contains("apply_patch"));
    assert!(!agent_kind_allowed_tools(AgentKind::Explore).contains("apply_patch"));
}

#[test]
fn unbound_questions_never_change_execution_grants() {
    let saved = vec!["read".into(), "AskUserQuestion".into(), "bash".into()];
    assert!(is_unbound_question_projection(
        &saved,
        &["bash".into(), "read".into()]
    ));
    assert!(!is_unbound_question_projection(&saved, &["read".into()]));
    assert!(!is_unbound_question_projection(
        &saved,
        &["bash".into(), "read".into(), "write".into()]
    ));
    assert!(!is_unbound_question_projection(
        &["read".into()],
        &["read".into()]
    ));
    assert!(!is_unbound_question_projection(
        &["read".into()],
        &["read".into(), "AskUserQuestion".into()]
    ));
}

#[test]
fn every_subagent_role_remains_noninteractive_in_all_execution_modes() {
    let parent = kcoder_tools::default_registry();
    assert!(parent.get("AskUserQuestion").is_some());
    for kind in [
        AgentKind::General,
        AgentKind::Explore,
        AgentKind::Plan,
        AgentKind::Review,
        AgentKind::Implementer,
        AgentKind::Verifier,
        AgentKind::ToolAgent,
    ] {
        for is_async in [false, true] {
            for arrangement in [false, true] {
                let actual =
                    filter_tools_for_agent_kind_in_mode(&parent, kind, is_async, arrangement);
                assert!(
                    actual.get("AskUserQuestion").is_none(),
                    "{kind:?}, async={is_async}, arrangement={arrangement}"
                );
                assert!(actual.get("ask_user_question").is_none());
                assert!(actual.get("read").is_some());
            }
        }
    }
    assert!(parent.get("AskUserQuestion").is_some());
}

#[test]
fn role_filter_retains_only_registered_readonly_wiki_and_never_adds_management() {
    let registry = ToolRegistry::new()
        .register(kcoder_tools::wiki::WikiTool)
        .register(kcoder_tools::wiki_manage::WikiManageTool);
    for kind in [
        AgentKind::General,
        AgentKind::Explore,
        AgentKind::Plan,
        AgentKind::Review,
        AgentKind::Verifier,
        AgentKind::ToolAgent,
    ] {
        for arrangement in [false, true] {
            let tools = filter_tools_for_agent_kind_in_mode(&registry, kind, true, arrangement);
            assert!(tools.get("Wiki").is_some());
            assert!(tools.get("WikiManage").is_none());
            assert!(
                filter_tools_for_agent_kind_in_mode(&ToolRegistry::new(), kind, true, arrangement)
                    .names()
                    .is_empty()
            );
            let disabled = registry.filtered_out_by_patterns(&["Wiki".into()]);
            assert!(
                filter_tools_for_agent_kind_in_mode(&disabled, kind, true, arrangement)
                    .get("Wiki")
                    .is_none()
            );
        }
    }
}
