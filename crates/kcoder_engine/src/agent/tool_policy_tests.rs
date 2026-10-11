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
fn bound_general_question_surface_adds_only_parent_question_tool() {
    let parent = kcoder_tools::default_registry();
    let old = filter_tools_for_agent_kind_in_mode(&parent, AgentKind::General, true, false);
    let hosted = filter_tools_for_agent_kind_with_bound_questions(
        &parent,
        AgentKind::General,
        true,
        false,
        true,
    );
    let old_names = old.names().into_iter().collect::<HashSet<_>>();
    let new_names = hosted.names().into_iter().collect::<HashSet<_>>();
    assert_eq!(
        new_names
            .difference(&old_names)
            .cloned()
            .collect::<Vec<_>>(),
        vec!["AskUserQuestion".to_string()]
    );
    assert!(old_names.is_subset(&new_names));
    assert!(hosted.get("Config").is_none());
    assert!(hosted.get("TaskStop").is_none());
    assert!(hosted.get("Workflow").is_none());
    let plugin = filter_tools_by_owned_names(&hosted, &HashSet::from(["read".to_string()]));
    assert_eq!(plugin.names(), vec!["read".to_string()]);
}

#[test]
fn unbound_and_specialized_or_arrangement_roles_remain_noninteractive() {
    let parent = kcoder_tools::default_registry();
    let unbound = filter_tools_for_agent_kind_with_bound_questions(
        &parent,
        AgentKind::General,
        true,
        false,
        false,
    );
    assert!(unbound.get("AskUserQuestion").is_none());
    for kind in [
        AgentKind::Explore,
        AgentKind::Plan,
        AgentKind::Review,
        AgentKind::Implementer,
        AgentKind::Verifier,
        AgentKind::ToolAgent,
    ] {
        let actual =
            filter_tools_for_agent_kind_with_bound_questions(&parent, kind, true, false, true);
        assert!(actual.get("AskUserQuestion").is_none(), "{kind:?}");
        assert_eq!(
            actual.names(),
            filter_tools_for_agent_kind_in_mode(&parent, kind, true, false).names()
        );
    }
    assert!(
        filter_tools_for_agent_kind_with_bound_questions(
            &parent,
            AgentKind::General,
            true,
            true,
            true
        )
        .get("AskUserQuestion")
        .is_none()
    );
}

#[test]
fn parent_hidden_question_profile_is_never_restored_by_host_capability() {
    let parent = kcoder_tools::default_registry().filtered_to_names(&["read".to_string()]);
    let actual = filter_tools_for_agent_kind_with_bound_questions(
        &parent,
        AgentKind::General,
        true,
        false,
        true,
    );
    assert_eq!(actual.names(), vec!["read".to_string()]);
}
