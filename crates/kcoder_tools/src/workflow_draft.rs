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

use crate::{Tool, ToolOutput, parse_input};
use async_trait::async_trait;
use kcoder_types::workflow::{WorkflowDefinition, WorkflowNode};
use kcoder_workflow::store::WorkflowStore;
use serde::Deserialize;
use serde_json::{Value, json};
#[derive(Debug, Default)]
pub struct WorkflowDraftTool;
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
enum Action {
    List,
    Update,
    Clone,
    Versions,
    Export,
    Import,
    Create,
    UpsertNode,
    RemoveNode,
    Read,
    Save,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Input {
    action: Action,
    id: Option<String>,
    title: Option<String>,
    #[serde(default)]
    description: String,
    #[schemars(range(min = 1))]
    expected_revision: Option<u64>,
    node: Option<WorkflowNode>,
    definition: Option<WorkflowDefinition>,
    node_id: Option<String>,
    offset: Option<usize>,
    #[schemars(range(min = 1, max = 32))]
    limit: Option<usize>,
    input_schema: Option<Value>,
    #[schemars(range(min = 1))]
    version: Option<u64>,
}
#[async_trait]
impl Tool for WorkflowDraftTool {
    fn name(&self) -> String {
        "WorkflowDraft".into()
    }
    fn description(&self) -> String {
        "Author a persistent workflow without executing it. list discovers saved definitions across conversations (offset/limit pagination, at most 32 items). Create a draft, then upsert each node in a separate call so progress is visible. Use returned revision as expected_revision on each mutation. read without version returns the current draft; read with version returns that immutable saved version including its input schema. Read after revision conflicts. upsert_node replaces the whole node; preserve unchanged fields when editing an existing node. save validates and publishes an immutable version; it never runs agents. Rich nodes use typed kind/config/runIf fields; condition and loop predicates are declarative, never code. update fully replaces title, description and input_schema (omit schema to clear it). versions lists immutable releases; clone creates a new draft from an existing id and optional version. export returns portable definition JSON; import accepts definition JSON and creates a new unpublished draft with a new ID. Handle create, edit, rename, save, copy, import and export requests directly in conversation; do not send users to forms or require them to write JSON. Node dependencies reference IDs in the same draft.".into()
    }
    async fn description_for_model(
        &self,
        _input: Option<&Value>,
        ctx: &crate::ToolDescriptionContext,
    ) -> String {
        let mut description = self.description();
        if ctx.available_tools.contains("Workflow") {
            description
                .push_str(" For requested reuse, list by title, resolve ambiguous matches in conversation, and read the selected saved version before using Workflow with definition_id and version. Derive args from the user request and declared defaults; ask for missing or ambiguous required inputs before execution. Do not invent values or execute merely to discover missing inputs.");
        }
        description
    }
    fn input_schema_is_stable(&self) -> bool {
        true
    }
    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(Input))
    }
    fn is_concurrency_safe(&self, _: &Value) -> bool {
        false
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let input: Input = parse_input(&input)?;
        if let Some(bound) = ctx.state.workflow_definition_id() {
            if matches!(
                input.action,
                Action::Create | Action::Clone | Action::Import
            ) {
                return Err(ToolError::InvalidInput(format!(
                    "This conversation is bound to draft {bound}; read and update it instead of creating another"
                )));
            }
            if !matches!(input.action, Action::List) && input.id.as_deref() != Some(bound.as_str())
            {
                return Err(ToolError::InvalidInput(
                    "This design conversation can only access its bound workflow".into(),
                ));
            }
        }
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
            Action::Versions => {
                let versions=store.versions(id()?).map_err(|error|ToolError::Execution(error.to_string()))?;
                return Ok(ToolOutput::text(serde_json::to_string(&versions).map_err(|error|ToolError::Execution(error.to_string()))?));
            },
            Action::Update => store.update_metadata(id()?,revision()?,input.title.as_deref().ok_or_else(||missing("title"))?,&input.description,input.input_schema.clone()),
            Action::Clone => store.clone_workflow(id()?,input.version,input.title.as_deref()),
            Action::Create => store.create(
                input.title.as_deref().ok_or_else(|| missing("title"))?,
                &input.description,
            ),
            Action::Read => match input.version {
                Some(version) => store.read_saved(id()?, Some(version)),
                None => store.read(id()?),
            },
            Action::Export => store.export(id()?, input.version),
            Action::Import => store.import(input.definition.clone().ok_or_else(|| missing("definition"))?),
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
        assert!(
            tool.call(
                json!({"action":"save","id":created["id"],"expected_revision":created["revision"]}),
                &ctx
            )
            .await
            .is_err()
        );
        let saved = tool
            .call(
                json!({"action":"save","id":created["id"],"expected_revision":edited["revision"]}),
                &ctx,
            )
            .await
            .unwrap();
        let saved: Value = payload(&saved);
        assert_eq!(saved["savedVersion"], 1);
        let listed = payload(
            &tool
                .call(json!({"action":"list","limit":1}), &ctx)
                .await
                .unwrap(),
        );
        assert_eq!(listed["items"][0]["id"], created["id"]);
        assert_eq!(listed["items"][0]["savedVersion"], 1);
        assert!(
            tool.call(json!({"action":"list","limit":0}), &ctx)
                .await
                .is_err()
        );
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
        assert!(
            tool.call(json!({"action":"read","id":created["id"]}), &other)
                .await
                .is_err()
        );
        assert!(!tool.is_concurrency_safe(&json!({"action":"read"})));
        assert!(
            !crate::core_registry()
                .names()
                .contains(&"WorkflowDraft".into())
        );
        assert!(
            crate::default_registry()
                .names()
                .contains(&"WorkflowDraft".into())
        );
    }
    #[tokio::test]
    async fn execution_guidance_requires_the_execution_tool() {
        let mut ctx = crate::ToolDescriptionContext {
            permission_mode: crate::ToolPermissionMode::Ask,
            is_non_interactive: false,
            active_skills: vec![],
            available_tools: Default::default(),
        };
        assert!(
            !WorkflowDraftTool
                .description_for_model(None, &ctx)
                .await
                .contains("definition_id")
        );
        ctx.available_tools.insert("Workflow".into());
        assert!(
            WorkflowDraftTool
                .description_for_model(None, &ctx)
                .await
                .contains("definition_id")
        );
    }

    #[tokio::test]
    async fn bound_design_cannot_create_clone_or_access_other_drafts() {
        let temp = tempfile::tempdir().unwrap();
        let state = kcoder_state::AppState::new(temp.path());
        let ctx = ToolContext::new(state)
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let created = payload(
            &WorkflowDraftTool
                .call(json!({"action":"create","title":"Bound"}), &ctx)
                .await
                .unwrap(),
        );
        ctx.state
            .enter_session_mode_before_first_message(kcoder_state::SessionMode::WorkflowDraft)
            .unwrap();
        ctx.state
            .bind_workflow_definition_before_first_message(created["id"].as_str().unwrap())
            .unwrap();
        for input in [
            json!({"action":"create","title":"Other"}),
            json!({"action":"clone","id":created["id"]}),
            json!({"action":"read","id":"other"}),
        ] {
            assert!(WorkflowDraftTool.call(input, &ctx).await.is_err());
        }
        assert!(
            WorkflowDraftTool
                .call(json!({"action":"read","id":created["id"]}), &ctx)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn conversation_reads_exact_saved_schema_and_imports_as_new_draft() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let tool = WorkflowDraftTool;
        let created = payload(
            &tool
                .call(json!({"action":"create","title":"Slides"}), &ctx)
                .await
                .unwrap(),
        );
        let id = created["id"].as_str().unwrap();
        let node = payload(&tool.call(json!({"action":"upsert_node","id":id,"expected_revision":created["revision"],"node":{"id":"A","title":"Slides","prompt":"Create slides"}}), &ctx).await.unwrap());
        let schema =
            json!({"type":"object","required":["topic"],"properties":{"topic":{"type":"string"}}});
        let updated = payload(&tool.call(json!({"action":"update","id":id,"expected_revision":node["revision"],"title":"Slides v1","input_schema":schema}), &ctx).await.unwrap());
        let saved = payload(
            &tool
                .call(
                    json!({"action":"save","id":id,"expected_revision":updated["revision"]}),
                    &ctx,
                )
                .await
                .unwrap(),
        );
        tool.call(json!({"action":"update","id":id,"expected_revision":saved["revision"],"title":"New draft","input_schema":{"type":"object"}}), &ctx).await.unwrap();
        let historical = payload(
            &tool
                .call(json!({"action":"read","id":id,"version":1}), &ctx)
                .await
                .unwrap(),
        );
        assert_eq!(historical["title"], "Slides v1");
        assert_eq!(historical["inputSchema"], schema);
        assert!(
            tool.call(json!({"action":"read","id":id,"version":999}), &ctx)
                .await
                .is_err()
        );
        let exported = payload(
            &tool
                .call(json!({"action":"export","id":id,"version":1}), &ctx)
                .await
                .unwrap(),
        );
        let imported = payload(
            &tool
                .call(json!({"action":"import","definition":exported}), &ctx)
                .await
                .unwrap(),
        );
        assert_ne!(imported["id"], id);
        assert_eq!(imported["status"], "draft");
        assert_eq!(imported["inputSchema"], schema);
        ctx.state
            .enter_session_mode_before_first_message(kcoder_state::SessionMode::WorkflowDraft)
            .unwrap();
        ctx.state
            .bind_workflow_definition_before_first_message(id)
            .unwrap();
        assert!(
            tool.call(json!({"action":"import","definition":exported}), &ctx)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn missing_authorized_profile_is_not_replaced_by_home() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
        assert!(
            WorkflowDraftTool
                .call(json!({"action":"create","title":"No"}), &ctx)
                .await
                .is_err()
        );
    }
}
