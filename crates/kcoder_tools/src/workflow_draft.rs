//! Incremental, non-executing workflow-library authoring.
use crate::{ToolContext, ToolError};
use std::path::PathBuf;

/// Validate roles with the same parser used by the actual agent executor.
pub fn validate_workflow_agent_types(
    definition: &kcoder_types::workflow::WorkflowDefinition,
) -> Result<(), ToolError> {
    for node in &definition.nodes {
        if crate::AgentKind::from_alias(&node.agent_type).is_none() {
            return Err(ToolError::InvalidInput(format!(
                "workflow_invalid: node {} has unsupported agentType {}",
                node.id, node.agent_type
            )));
        }
    }
    Ok(())
}

pub(crate) fn library_root(ctx: &ToolContext) -> Result<PathBuf, ToolError> {
    ctx.settings_persistence_path
        .as_deref()
        .and_then(std::path::Path::parent)
        .map(|root| root.join("workflow-library"))
        .ok_or_else(|| {
            ToolError::Execution(
                "Workflow library is unavailable: this session has no authorized profile storage"
                    .into(),
            )
        })
}

use crate::{parse_input, Tool, ToolOutput};
use async_trait::async_trait;
use kcoder_types::workflow::WorkflowNode;
use kcoder_workflow::store::WorkflowStore;
use serde::Deserialize;
use serde_json::{json, Value};
#[derive(Debug, Default)]
pub struct WorkflowDraftTool;
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Action {
    List,
    Create,
    UpsertNode,
    RemoveNode,
    Read,
    Save,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    action: Action,
    id: Option<String>,
    title: Option<String>,
    #[serde(default)]
    description: String,
    expected_revision: Option<u64>,
    node: Option<WorkflowNode>,
    node_id: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
}
#[async_trait]
impl Tool for WorkflowDraftTool {
    fn name(&self) -> String {
        "WorkflowDraft".into()
    }
    fn description(&self) -> String {
        "Author a persistent workflow without executing it. list discovers saved definitions across conversations (offset/limit pagination, at most 32 items). Create a draft, then upsert each node in a separate call so progress is visible. Use returned revision as expected_revision on each mutation. Read to recover from revision conflicts. upsert_node replaces the whole node; preserve unchanged fields when editing an existing node. save validates and publishes an immutable version; it never runs agents. Node dependencies reference IDs in the same draft.".into()
    }
    async fn description_for_model(
        &self,
        _input: Option<&Value>,
        ctx: &crate::ToolDescriptionContext,
    ) -> String {
        let mut description = self.description();
        if ctx.available_tools.contains("Workflow") {
            description
                .push_str(" To execute explicitly use Workflow with definition_id and version.");
        }
        description
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false,"required":["action"],"properties":{
            "action":{"type":"string","enum":["list","create","upsert_node","remove_node","read","save"]},
            "id":{"type":"string"},"title":{"type":"string"},"description":{"type":"string"},
            "offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":32},
            "expected_revision":{"type":"integer","minimum":1},"node_id":{"type":"string"},
            "node":{"type":"object","additionalProperties":false,"required":["id","title","prompt"],"properties":{
                "id":{"type":"string"},"title":{"type":"string"},"prompt":{"type":"string"},
                "agentType":{"type":"string"},"maxTurns":{"type":"integer","minimum":1,"maximum":100},
                "dependsOn":{"type":"array","items":{"type":"string"}},
                "position":{"type":"object","required":["x","y"],"properties":{"x":{"type":"number"},"y":{"type":"number"}}},
                "allowedWritePaths":{"type":"array","items":{"type":"string"}},
                "acceptanceCriteria":{"type":"array","items":{"type":"string"}},
                "expectedArtifacts":{"type":"array","items":{"type":"string"}}
            }}
        }})
    }
    fn is_concurrency_safe(&self, _: &Value) -> bool {
        false
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let input: Input = parse_input(&input)?;
        let store = WorkflowStore::new(library_root(ctx)?);
        let missing = |name| ToolError::InvalidInput(format!("{name} is required for this action"));
        let id = || input.id.as_deref().ok_or_else(|| missing("id"));
        let revision = || {
            input
                .expected_revision
                .ok_or_else(|| missing("expected_revision"))
        };
        let result = match input.action {
            Action::List => {
                let limit = input.limit.unwrap_or(32);
                if !(1..=32).contains(&limit) { return Err(ToolError::InvalidInput("limit must be between 1 and 32".into())); }
                let all = store.list().map_err(|error| ToolError::Execution(error.to_string()))?;
                let total = all.len();
                let offset = input.offset.unwrap_or(0);
                let items = all.into_iter().skip(offset).take(limit).collect::<Vec<_>>();
                let end = offset.saturating_add(items.len());
                return Ok(ToolOutput::text(json!({"items":items,"total":total,"truncated":end<total,"nextOffset":(end<total).then_some(end)}).to_string()));
            }
            Action::Create => store.create(
                input.title.as_deref().ok_or_else(|| missing("title"))?,
                &input.description,
            ),
            Action::Read => store.read(id()?),
            Action::Save => {
                validate_workflow_agent_types(
                    &store
                        .read(id()?)
                        .map_err(|error| ToolError::Execution(error.to_string()))?,
                )?;
                store.save(id()?, revision()?)
            }
            Action::RemoveNode => store.remove_node(
                id()?,
                revision()?,
                input.node_id.as_deref().ok_or_else(|| missing("node_id"))?,
            ),
            Action::UpsertNode => store.upsert_node(
                id()?,
                revision()?,
                input.node.clone().ok_or_else(|| missing("node"))?,
            ),
        }
        .map_err(|error| ToolError::Execution(error.to_string()))?;
        Ok(ToolOutput::text(serde_json::to_string(&result).map_err(
            |error| ToolError::Execution(error.to_string()),
        )?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn payload(output: &ToolOutput) -> Value {
        let kcoder_types::ContentBlock::Text { text } = &output.content[0] else {
            panic!("expected text")
        };
        serde_json::from_str(text).unwrap()
    }
    #[tokio::test]
    async fn draft_authoring_is_revisioned_profile_scoped_and_never_runs_agents() {
        let temp = tempfile::tempdir().unwrap();
        let state = kcoder_state::AppState::new(temp.path());
        let ctx = ToolContext::new(state)
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let tool = WorkflowDraftTool;
        let output = tool
            .call(json!({"action":"create","title":"Review"}), &ctx)
            .await
            .unwrap();
        let created: Value = payload(&output);
        let edited = tool.call(json!({"action":"upsert_node","id":created["id"],"expected_revision":created["revision"],"node":{"id":"review","title":"Review","prompt":"Inspect only"}}), &ctx).await.unwrap();
        let edited: Value = payload(&edited);
        assert!(edited["revision"].as_u64().unwrap() > created["revision"].as_u64().unwrap());
        assert!(tool
            .call(
                json!({"action":"save","id":created["id"],"expected_revision":created["revision"]}),
                &ctx
            )
            .await
            .is_err());
        let saved = tool
            .call(
                json!({"action":"save","id":created["id"],"expected_revision":edited["revision"]}),
                &ctx,
            )
            .await
            .unwrap();
        let saved: Value = payload(&saved);
        assert_eq!(saved["savedVersion"], 1);
        let listed = payload(&tool.call(json!({"action":"list","limit":1}), &ctx).await.unwrap());
        assert_eq!(listed["items"][0]["id"], created["id"]);
        assert_eq!(listed["items"][0]["savedVersion"], 1);
        assert!(tool.call(json!({"action":"list","limit":0}), &ctx).await.is_err());
        let invalid = tool.call(json!({"action":"upsert_node","id":created["id"],"expected_revision":saved["revision"],"node":{"id":"invalid-role","title":"Invalid","prompt":"No execution","agentType":"does_not_exist"}}), &ctx).await.unwrap();
        let invalid = payload(&invalid);
        let error = tool
            .call(
                json!({"action":"save","id":created["id"],"expected_revision":invalid["revision"]}),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("unsupported agentType"));
        assert_eq!(
            WorkflowStore::new(library_root(&ctx).unwrap())
                .read_saved(created["id"].as_str().unwrap(), Some(1))
                .unwrap()
                .nodes
                .len(),
            1
        );

        let other = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("other/settings.json")));
        assert!(tool
            .call(json!({"action":"read","id":created["id"]}), &other)
            .await
            .is_err());
        assert!(!tool.is_concurrency_safe(&json!({"action":"read"})));
        assert!(!crate::core_registry()
            .names()
            .contains(&"WorkflowDraft".into()));
        assert!(crate::default_registry()
            .names()
            .contains(&"WorkflowDraft".into()));
    }
    #[tokio::test]
    async fn execution_guidance_requires_the_execution_tool() {
        let mut ctx = crate::ToolDescriptionContext {
            permission_mode: crate::ToolPermissionMode::Ask,
            is_non_interactive: false,
            active_skills: vec![],
            available_tools: Default::default(),
        };
        assert!(!WorkflowDraftTool
            .description_for_model(None, &ctx)
            .await
            .contains("definition_id"));
        ctx.available_tools.insert("Workflow".into());
        assert!(WorkflowDraftTool
            .description_for_model(None, &ctx)
            .await
            .contains("definition_id"));
    }

    #[tokio::test]
    async fn missing_authorized_profile_is_not_replaced_by_home() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
        assert!(WorkflowDraftTool
            .call(json!({"action":"create","title":"No"}), &ctx)
            .await
            .is_err());
    }
}
