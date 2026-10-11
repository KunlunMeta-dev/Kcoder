//! Incremental, non-executing workflow-library authoring.
use crate::{ToolContext, ToolError};
#[path = "workflow/authoring_help.rs"]
mod authoring_help;
use std::path::PathBuf;

/// Validate roles with the same parser used by the actual agent executor.
pub fn validate_workflow_agent_types(
    definition: &kcoder_types::workflow::WorkflowDefinition,
) -> Result<(), ToolError> {
    for node in &definition.nodes {
        if node.kind == kcoder_types::workflow::WorkflowNodeKind::Loop
            && node
                .config
                .r#loop
                .as_ref()
                .is_some_and(|value| value.body.is_some())
        {
            continue;
        }
        if !matches!(
            node.kind,
            kcoder_types::workflow::WorkflowNodeKind::Agent
                | kcoder_types::workflow::WorkflowNodeKind::Loop
        ) {
            continue;
        }
        if crate::AgentKind::from_alias(&node.agent_type).is_none() {
            return Err(ToolError::InvalidInput(format!(
                "workflow_invalid: node {} has unsupported agentType {}",
                node.id, node.agent_type
            )));
        }
    }
    Ok(())
}

/// Static inspection is restricted to the host's currently available direct-call contracts.
/// Bound values remain runtime checks; unknown tools are reported, never guessed or executed.
pub fn validate_workflow_tool_contracts(
    definition: &kcoder_types::workflow::WorkflowDefinition,
    mut contract: impl FnMut(&str) -> Option<kcoder_types::ToolDefinition>,
) -> Result<kcoder_workflow::store::ToolContractVerification, ToolError> {
    let mut checks = kcoder_workflow::store::ToolContractVerification::default();
    for node in &definition.nodes {
        let Some(tool) = &node.config.tool else {
            continue;
        };
        let Some(contract) = contract(&tool.name) else {
            checks.unknown_nodes.push(node.id.clone());
            continue;
        };
        if tool.bindings.is_empty() {
            kcoder_workflow::graph::validate_data(&contract.input_schema, &tool.arguments)
                .map_err(|e| {
                    ToolError::InvalidInput(format!(
                        "node {}/config/tool/arguments: {e:#}",
                        node.id
                    ))
                })?;
        } else {
            checks.runtime_bound_nodes.push(node.id.clone());
            let properties = contract
                .input_schema
                .get("properties")
                .and_then(Value::as_object);
            if contract.input_schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                for name in tool.bindings.keys() {
                    let declared = properties
                        .is_some_and(|properties| properties.contains_key(name))
                        || contract
                            .input_schema
                            .get("patternProperties")
                            .and_then(Value::as_object)
                            .is_some_and(|patterns| {
                                patterns.keys().any(|pattern| {
                                    regex::Regex::new(pattern)
                                        .is_ok_and(|pattern| pattern.is_match(name))
                                })
                            });
                    if !declared {
                        return Err(ToolError::InvalidInput(format!(
                            "node {}/config/tool/bindings/{}: field is not declared by the target tool contract",
                            node.id, name
                        )));
                    }
                }
            }
            // Validate concrete literals where their schema is independent; references and
            // dependent/composite requirements are deliberately deferred to actual binding.
            for (name, value) in tool.arguments.as_object().into_iter().flatten() {
                if tool.bindings.contains_key(name) {
                    continue;
                }
                if let Some(schema) = properties.and_then(|properties| properties.get(name)) {
                    let encoded = serde_json::to_string(schema)
                        .map_err(|e| ToolError::Execution(e.to_string()))?;
                    if !encoded.contains("\"$ref\"") && !encoded.contains("\"$dynamicRef\"") {
                        kcoder_workflow::graph::validate_data(schema, value).map_err(|e| {
                            ToolError::InvalidInput(format!(
                                "node {}/config/tool/arguments/{}: {e:#}",
                                node.id, name
                            ))
                        })?;
                    }
                } else if contract.input_schema.get("additionalProperties")
                    == Some(&Value::Bool(false))
                    && !contract
                        .input_schema
                        .get("patternProperties")
                        .is_some_and(Value::is_object)
                {
                    return Err(ToolError::InvalidInput(format!(
                        "node {}/config/tool/arguments/{}: field is not declared by the target tool contract",
                        node.id, name
                    )));
                }
            }
        }
        checks.known_nodes.push(node.id.clone());
    }
    Ok(checks)
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
    Help,
    PreviewRunArchive,
    ArchiveRuns,
    ReadArchivedRun,
    Capacity,
    MigrateStorage,
    RollbackStorage,
    Verification,
    VersionReferences,
    ArchiveVersion,
    ReadHistory,
    List,
    Update,
    Clone,
    Versions,
    Export,
    Import,
    Create,
    UpsertNode,
    PatchNodes,
    RemoveNode,
    Read,
    Save,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
enum ResponseDetail {
    Full,
    Changes,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Input {
    action: Action,
    /// Exact run IDs selected for preview_run_archive/archive_runs; never choose history automatically.
    run_ids: Option<Vec<String>>,
    /// Content token returned by preview_run_archive for the exact selected IDs.
    preview_token: Option<String>,
    /// Required true only after explicit user confirmation of the selected history archive.
    confirm: Option<bool>,
    /// ID for read_archived_run.
    run_id: Option<String>,
    /// Optional on-demand help selector; does not execute this node.
    node_kind: Option<kcoder_types::workflow::WorkflowNodeKind>,
    /// For tool help, inspect only the actual currently registered safe target contract.
    tool_name: Option<String>,
    /// For mutations, changes returns metadata and only affected nodes; full (default) returns the entire definition. Read/export always return the complete definition.
    response_detail: Option<ResponseDetail>,
    id: Option<String>,
    title: Option<String>,
    #[serde(default)]
    description: String,
    #[schemars(range(min = 1))]
    expected_revision: Option<u64>,
    node: Option<WorkflowNode>,
    /// Lossless JSON text alternative to node, for providers that rewrite nested argument types.
    node_json: Option<String>,
    /// Lossless JSON text alternative to nodes; must encode an array of partial node objects.
    nodes_json: Option<String>,
    /// Lossless JSON text alternative to input_schema; numbers/booleans/arrays remain native JSON types.
    input_schema_json: Option<String>,
    /// Lossless JSON text alternative to definition for import.
    definition_json: Option<String>,
    /// Partial node fields for patch_nodes. Omit nodes/nodes_json for a deletion-only patch. Omitted fields and config keys are preserved.
    #[schemars(with = "Option<Vec<WorkflowNode>>")]
    nodes: Option<Vec<Value>>,
    /// IDs to delete in the same patch; nodes is optional for deletion-only edits. Rewire remaining dependents explicitly. Clearing all nodes leaves an unpublished empty draft.
    #[serde(default)]
    remove_node_ids: Vec<String>,
    definition: Option<WorkflowDefinition>,
    node_id: Option<String>,
    offset: Option<usize>,
    #[schemars(range(min = 1, max = 32))]
    limit: Option<usize>,
    /// Workflow input JSON Schema object or boolean, not a JSON-encoded string. Omit/null clears it on update.
    input_schema: Option<Value>,
    #[schemars(range(min = 1))]
    version: Option<u64>,
}
impl Input {
    fn decode_json_fields(&mut self) -> Result<(), ToolError> {
        fn decode<T: serde::de::DeserializeOwned>(
            value: &mut Option<T>,
            text: Option<String>,
            field: &str,
        ) -> Result<(), ToolError> {
            if let Some(text) = text {
                if value.is_some() {
                    return Err(ToolError::InvalidInput(format!(
                        "{field} and {field}_json are mutually exclusive"
                    )));
                }
                if text.len() > 128 * 1024 {
                    return Err(ToolError::InvalidInput(format!(
                        "{field}_json exceeds 128 KiB"
                    )));
                }
                *value =
                    Some(serde_json::from_str(&text).map_err(|error| {
                        ToolError::InvalidInput(format!("{field}_json: {error}"))
                    })?);
            }
            Ok(())
        }
        decode(&mut self.node, self.node_json.take(), "node")?;
        decode(&mut self.nodes, self.nodes_json.take(), "nodes")?;
        decode(
            &mut self.definition,
            self.definition_json.take(),
            "definition",
        )?;
        decode(
            &mut self.input_schema,
            self.input_schema_json.take(),
            "input_schema",
        )?;
        if self.input_schema.as_ref().is_some_and(Value::is_null) {
            self.input_schema = None;
        }
        Ok(())
    }
}

#[async_trait]
impl Tool for WorkflowDraftTool {
    fn name(&self) -> String {
        "WorkflowDraft".into()
    }
    fn description(&self) -> String {
        r#"Author persistent workflows without executing them. Read existing drafts before edits; keep the ID and unrelated data. Bound conversations default id to their own draft and may inspect other definitions only by explicit saved version. Mutations require current expected_revision; use returned revision, and reload after conflicts or an unconfirmed commit before retrying. upsert_node replaces the whole node. update replaces title, description and input_schema (omitted/null clears schema). patch_nodes atomically merges supplied node fields/config keys, preserving omitted fields and other nodes; each supplied config value replaces that value. runIf:null clears the guard, dependsOn:[] clears dependencies. Deletion-only patches omit nodes/nodes_json and use remove_node_ids; rewire dependents explicitly. Failed mutations change nothing. save validates a nonempty graph and creates an immutable version; corrections need a new version. Canvas layout uses separate CAS and does not advance content revision.

Preserve numbers, booleans, nested arrays, defaults and Unicode exactly. Prefer node_json, nodes_json, input_schema_json or definition_json for complex nested values, especially with providers known to rewrite structured parameters; supply correctly encoded JSON text, never both alternatives. Structured fields must preserve actual types: no scalar stringification or dropped defaults. Whitespace/minifying cannot fix wrong types. Correct JSON encoding supports ordinary quotes, backslashes, regex and newlines; do not rewrite code or remove typed defaults to bypass errors. acceptanceCriteria is a flat string array. Recommend response_detail=changes for mutations (affected nodes, removed IDs and revision); legacy full is still default, read/export always return complete definitions.

Authoring checks graph/dependencies, schemas/defaults, pointers, pure code syntax and declared contracts without running agents, tools, services or desktop effects. Confirm actual target tool contracts before publication; unknown contracts remain unverified. Agent defaults retain maxTurns=60. Data is /input and /nodes/<direct dependency>; config.inputBindings appear as top-level bindings, with no implicit /output wrapper. Merge results have dependency-ID keys. Only /iteration/index, /iteration/item and /iteration/output exist in Loop; until runs after each iteration, and greater_than excludes equality. Use runIf guards to gate branches. Subworkflows pin immutable definitionId/version. Configured resultCheck receives input,nodes,bindings,result and must return true; assert actual values/types/counts/identity and inspect written artifacts. Missing data or workflowError must never automatically pass. Completed means execution ended; configured checks cover only checked nodes.

After saving, state exactly what static checks passed and ask whether actual verification is wanted. Generation/saving alone does not authorize execution. An existing request to generate and test authorizes testing within that scope without another confirmation. Authorized tests must check realistic inputs, branch non-execution, loop early-exit/equality/limit, and actual results/artifacts; repair failures in a new saved version and retest. Keep execution-unverified status until evidence satisfies the criteria. Resume completed effects; inspect unknown outcomes and never blindly replay them. Never publish credentials or sensitive verification inputs in public definitions/reports; use private run inputs and publish fingerprints/opaque references. interactionModified evidence belongs to that adjusted run and does not prove untouched saved-definition reuse. migrate_storage/rollback_storage/archive_version require an explicit storage or history request; never run them for ordinary authoring/polling. version_references shows fixed/live/unknown blockers before explicit archive_version. Archive removes publication but retains exact private historical snapshot (read_history), never recycles version IDs; legacy downgrade preflight may refuse unrepresentable version counts without deleting data.

Only after an explicit history management request use preview_run_archive with selected run_ids, present capacity/blockers/retained recovery artifacts, and wait for explicit confirmation before archive_runs with the exact run_ids, preview_token, and confirm=true. Never select or archive history to work around quota without user consent. read_archived_run reads retained observations; artifacts/checkpoints/verification and immutable saved-version references remain intact. Stale preview requires a new preview and confirmation; recoveryPending means archival committed and publication needs recovery, so query the same token without replaying other actions. Use action=verification with id/version for exact version evidence, action=capacity for distinct count/byte budgets, and action=help (optional node_kind, or node_kind=tool + tool_name) for focused node schema/examples and actual safe target contracts and authoring guidance on demand; help does not advertise target tools as available. list/versions discover definitions/releases; clone/import create new draft IDs, export is portable. Handle these requests in conversation. After input errors inspect the schema/error, isolate one field, and preserve requested semantics."#.into()
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
        let mut schema = crate::clean_schema(schemars::schema_for!(Input));
        schema["properties"]["title"]["description"] = json!(
            "Required for create and update. On update, preserve the current title when only changing other fields."
        );
        schema["properties"]["id"]["description"] = json!(
            "Workflow draft ID. In a bound design conversation, omitted id uses its bound draft. Explicit other IDs cannot mutate/read other drafts; read an immutable saved workflow by explicit id and version. Outside bound design conversations, id is required except for create/import/list/help/capacity/migrate_storage/rollback_storage."
        );
        schema["properties"]["expected_revision"]["description"] = json!(
            "Required for update, upsert_node, patch_nodes, remove_node, and save. Read the draft first and use its current revision."
        );
        schema["properties"]["input_schema"] = json!({"type":["object","boolean","null"],"description":"Workflow input JSON Schema, e.g. {\"type\":\"object\",\"properties\":{\"market\":{\"type\":\"string\",\"default\":\"CN\"}}}. Send the object directly, never a JSON string. Omit/null clears the contract on update. Input-node prompts do not validate inputs or apply defaults."});
        schema
    }
    fn is_concurrency_safe(&self, _: &Value) -> bool {
        false
    }
    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        static WORKERS: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
            std::sync::OnceLock::new();
        let workers = WORKERS
            .get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(4)))
            .clone();
        let permit = tokio::select! {
            biased;
            _ = ctx.cancelled() => return Err(ToolError::Aborted),
            result = workers.acquire_owned() => result.map_err(|_| ToolError::Execution("workflow service is unavailable".into()))?,
        };
        let context = ctx.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            WorkflowDraftTool.execute(input, &context)
        })
        .await
        .map_err(|_| ToolError::Execution("workflow operation failed".into()))?
    }
}

impl WorkflowDraftTool {
    fn execute(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        if let Some(fields) = input.as_object() {
            for field in ["node", "nodes", "definition", "input_schema"] {
                if fields.contains_key(field) && fields.contains_key(&format!("{field}_json")) {
                    return Err(ToolError::InvalidInput(format!(
                        "{field} and {field}_json are mutually exclusive"
                    )));
                }
            }
        }
        let mut input: Input = parse_input(&input)?;
        input.decode_json_fields()?;
        if matches!(input.action, Action::Help) {
            let contract = input.tool_name.as_deref().and_then(|name| {
                ctx.agent_runner
                    .as_ref()
                    .and_then(|runner| runner.workflow_tool_contract(name))
            });
            let kind = input.node_kind.or(input
                .tool_name
                .as_ref()
                .map(|_| kcoder_types::workflow::WorkflowNodeKind::Tool));
            return Ok(ToolOutput::text(
                authoring_help::payload(kind, contract).to_string(),
            ));
        }
        if matches!(
            input.action,
            Action::PreviewRunArchive | Action::ArchiveRuns | Action::ReadArchivedRun
        ) {
            let root = library_root(ctx)?
                .parent()
                .ok_or_else(|| ToolError::Execution("invalid profile root".into()))?
                .join("workflow-runs");
            let store = WorkflowStore::new(library_root(ctx)?);
            let value = match input.action {
                Action::PreviewRunArchive => serde_json::to_value(
                    crate::workflow_runs::archive_preview(
                        &root,
                        &store,
                        input.run_ids.as_deref().unwrap_or(&[]),
                    )
                    .map_err(|e| ToolError::Execution(e.to_string()))?,
                ),
                Action::ArchiveRuns => serde_json::to_value(
                    crate::workflow_runs::archive_runs(
                        &root,
                        &store,
                        input.run_ids.as_deref().unwrap_or(&[]),
                        input.preview_token.as_deref().unwrap_or(""),
                        input.confirm == Some(true),
                    )
                    .map_err(|e| ToolError::Execution(e.to_string()))?,
                ),
                Action::ReadArchivedRun => serde_json::to_value(
                    crate::workflow_runs::read_archived(
                        &root,
                        input
                            .run_id
                            .as_deref()
                            .ok_or_else(|| ToolError::InvalidInput("run_id is required".into()))?,
                    )
                    .map_err(|e| ToolError::Execution(e.to_string()))?,
                ),
                _ => unreachable!(),
            }
            .map_err(|e| ToolError::Execution(e.to_string()))?;
            return Ok(ToolOutput::text(value.to_string()));
        }
        if let Some(bound) = ctx.state.workflow_definition_id() {
            if matches!(
                input.action,
                Action::Create | Action::Clone | Action::Import
            ) {
                return Err(ToolError::InvalidInput(format!(
                    "This conversation is bound to draft {bound}; read and update it instead of creating another"
                )));
            }
            // A missing ID refers to the current design; it must never be
            // mistaken for an attempt to access another conversation's draft.
            if input.id.is_none()
                && !matches!(
                    input.action,
                    Action::List
                        | Action::Capacity
                        | Action::MigrateStorage
                        | Action::RollbackStorage
                )
            {
                input.id = Some(bound.clone());
            }
            let library_action = matches!(
                input.action,
                Action::List | Action::Capacity | Action::MigrateStorage | Action::RollbackStorage
            );
            let saved_version_read = matches!(
                input.action,
                Action::Read
                    | Action::Verification
                    | Action::VersionReferences
                    | Action::ReadHistory
            ) && input.version.is_some();
            if !(library_action || saved_version_read)
                && input.id.as_deref() != Some(bound.as_str())
            {
                return Err(ToolError::InvalidInput(format!(
                    "This design conversation is bound to draft {bound}; supplied id {} does not match. Omit id or use the bound draft ID. To inspect another workflow, use read with an explicit id and saved version",
                    input.id.as_deref().unwrap_or("<missing>")
                )));
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
        let changed_ids = input
            .node
            .as_ref()
            .map(|node| vec![node.id.clone()])
            .unwrap_or_else(|| {
                input
                    .nodes
                    .as_ref()
                    .into_iter()
                    .flatten()
                    .filter_map(|node| node.get("id").and_then(Value::as_str).map(str::to_owned))
                    .collect()
            });
        let removed_ids = if matches!(input.action, Action::RemoveNode) {
            input.node_id.iter().cloned().collect()
        } else {
            input.remove_node_ids.clone()
        };
        let validation_details =
            std::cell::RefCell::new(None::<kcoder_workflow::store::ToolContractVerification>);
        let validate_changes = |definition: &WorkflowDefinition| -> anyhow::Result<()> {
            let mut changed = definition.clone();
            changed.nodes.retain(|node| changed_ids.contains(&node.id));
            let checks = validate_workflow_tool_contracts(&changed, |name| {
                ctx.agent_runner
                    .as_ref()
                    .and_then(|runner| runner.workflow_tool_contract(name))
            })
            .map_err(anyhow::Error::new)?;
            *validation_details.borrow_mut() = Some(checks);
            Ok(())
        };
        let result = match input.action {
            Action::PreviewRunArchive | Action::ArchiveRuns | Action::ReadArchivedRun => unreachable!(),
            Action::VersionReferences | Action::ArchiveVersion => {
                let version=input.version.ok_or_else(||missing("version"))?;
                let profile=ctx.settings_persistence_path.as_deref().and_then(std::path::Path::parent).ok_or_else(||missing("authorized profile"))?;
                let runs=crate::workflow_runs::version_references(profile.join("workflow-runs"),&store,id()?,version).map_err(|e|ToolError::Execution(e.to_string()))?;
                let value=if matches!(input.action,Action::ArchiveVersion) {
                    serde_json::to_value(store.archive_version(id()?,revision()?,version,&runs).map_err(|e|ToolError::Execution(e.to_string()))?)
                } else {serde_json::to_value(store.version_references(id()?,version,&runs).map_err(|e|ToolError::Execution(e.to_string()))?)}.map_err(|e|ToolError::Execution(e.to_string()))?;
                return Ok(ToolOutput::text(value.to_string()));
            },
            Action::ReadHistory=>return Ok(ToolOutput::text(serde_json::to_string(&store.historical_version(id()?,input.version.ok_or_else(||missing("version"))?).map_err(|e|ToolError::Execution(e.to_string()))?).map_err(|e|ToolError::Execution(e.to_string()))?)),
            Action::MigrateStorage => return Ok(ToolOutput::text(serde_json::to_string(&store.migrate_storage().map_err(|e| ToolError::Execution(e.to_string()))?).map_err(|e| ToolError::Execution(e.to_string()))?)),
            Action::RollbackStorage => { store.rollback_storage().map_err(|e| ToolError::Execution(e.to_string()))?; return Ok(ToolOutput::text(json!({"backend":"legacy_json", "rolledBack":true}).to_string())); },
            Action::Capacity => return Ok(ToolOutput::text(serde_json::to_string(&store.capacity().map_err(|e| ToolError::Execution(e.to_string()))?).map_err(|e| ToolError::Execution(e.to_string()))?)),
            Action::Verification => return Ok(ToolOutput::text(serde_json::to_string(&store.verification_page(id()?, input.version.ok_or_else(|| missing("version"))?, input.offset.unwrap_or(0), input.limit.unwrap_or(32)).map_err(|e| ToolError::Execution(e.to_string()))?).map_err(|e| ToolError::Execution(e.to_string()))?)),
            Action::Help => unreachable!("help returns before opening profile storage"),
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
            Action::Create => store.create_with_schema(
                input.title.as_deref().ok_or_else(|| missing("title"))?,
                &input.description,
                input.input_schema.clone(),
            ),
            Action::Read => match input.version {
                Some(version) => store.read_saved(id()?, Some(version)),
                None => store.read(id()?),
            },
            Action::Export => store.export(id()?, input.version),
            Action::Import => store.import(input.definition.clone().ok_or_else(|| missing("definition"))?),
            Action::Save => {
                let draft = store.read(id()?).map_err(|error|ToolError::Execution(error.to_string()))?;
                validate_workflow_agent_types(&draft)?;
                let checks = validate_workflow_tool_contracts(&draft, |name|ctx.agent_runner.as_ref().and_then(|runner|runner.workflow_tool_contract(name)))?;
                store.save_with_tool_contracts(id()?, revision()?,Some(checks))
            }
            Action::RemoveNode => store.remove_node(
                id()?,
                revision()?,
                input.node_id.as_deref().ok_or_else(|| missing("node_id"))?,
            ),
            Action::PatchNodes => {
                let nodes = match input.nodes {
                    Some(nodes) => nodes,
                    None if !input.remove_node_ids.is_empty() => Vec::new(),
                    None => return Err(ToolError::InvalidInput("patch_nodes requires nodes/nodes_json or nonempty remove_node_ids".into())),
                };
                store.patch_fields_validated(id()?, revision()?, nodes, input.remove_node_ids,validate_changes)
            },
            Action::UpsertNode => store.upsert_node_validated(
                id()?,
                revision()?,
                input.node.clone().ok_or_else(|| missing("node"))?,
                validate_changes,
            ),
        }
        .map_err(|error|match error.downcast::<ToolError>() {Ok(error)=>error,Err(error)=>ToolError::Execution(error.to_string())})?;
        if matches!(input.response_detail, Some(ResponseDetail::Changes))
            && !matches!(input.action, Action::Read | Action::Export)
        {
            let nodes = result
                .nodes
                .iter()
                .filter(|node| changed_ids.contains(&node.id))
                .collect::<Vec<_>>();
            let unchanged = input.expected_revision == Some(result.revision);
            let changed_node_ids = if unchanged {
                Vec::new()
            } else {
                changed_ids.clone()
            };
            return Ok(ToolOutput::text(json!({"id":result.id,"title":result.title,"revision":result.revision,
                "status":result.status,"savedVersion":result.saved_version,"nodeCount":result.nodes.len(),
                "inputSchema":result.input_schema,"nodes":nodes,"removedNodeIds":removed_ids,
                "changedNodeIds":changed_node_ids,
                "validation":{"status":if unchanged {"unchanged"}else{"passed"},"scope":if matches!(input.action,Action::Save){"complete_graph"}else{"draft_fields"},"executionVerified":false,"toolContracts":validation_details.borrow().as_ref()},
                "readback":{"action":"read","id":result.id}}).to_string()));
        }
        Ok(ToolOutput::text(serde_json::to_string(&result).map_err(
            |error| ToolError::Execution(error.to_string()),
        )?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn library_lock_wait_keeps_the_tool_runtime_responsive() {
        use fs2::FileExt;
        let root = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(root.path().join("workflow-library"));
        store.create("Owned fixture", "").unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.path().join("workflow-library/library.lock"))
            .unwrap();
        lock.lock_exclusive().unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            fs2::FileExt::unlock(&lock).unwrap();
        });
        let mut context = ToolContext::new(kcoder_state::AppState::new(root.path()));
        context.settings_persistence_path = Some(root.path().join("settings.json"));
        let operation = tokio::spawn(async move {
            WorkflowDraftTool
                .call(json!({"action":"list"}), &context)
                .await
        });
        let started = std::time::Instant::now();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let elapsed = started.elapsed();
        operation.await.unwrap().unwrap();
        release.join().unwrap();
        assert!(
            elapsed < std::time::Duration::from_millis(150),
            "runtime timer waited for the file lock: {elapsed:?}"
        );
    }

    struct StaticContracts;
    #[async_trait]
    impl crate::AgentRunner for StaticContracts {
        fn workflow_tool_contract(&self, name: &str) -> Option<kcoder_types::ToolDefinition> {
            (name == "known").then(||kcoder_types::ToolDefinition{name:name.into(),description:String::new(),input_schema:json!({"type":"object","properties":{"count":{"type":"number"}},"required":["count"],"additionalProperties":false})})
        }
        async fn run_agent(&self, _: String, _: usize) -> Result<String, crate::AgentError> {
            panic!("static authoring must not start agents")
        }
    }
    #[tokio::test]
    async fn known_tool_validation_is_automatic_before_atomic_mutations_and_save() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")))
            .with_agent_runner(std::sync::Arc::new(StaticContracts));
        let tool = WorkflowDraftTool;
        let created = payload(
            &tool
                .call(json!({"action":"create","title":"Known contracts"}), &ctx)
                .await
                .unwrap(),
        );
        let id = created["id"].as_str().unwrap();
        let bad = json!({"action":"upsert_node","id":id,"expected_revision":created["revision"],"node":{"id":"tool","title":"Tool","kind":"tool","config":{"tool":{"name":"known","arguments":{"count":"two"}}}}});
        assert!(matches!(
            tool.call(bad, &ctx).await.unwrap_err(),
            ToolError::InvalidInput(_)
        ));
        let store = WorkflowStore::new(library_root(&ctx).unwrap());
        assert_eq!(
            store.read(id).unwrap().revision,
            created["revision"].as_u64().unwrap()
        );
        assert!(store.read(id).unwrap().nodes.is_empty());
        let added = payload(&tool.call(json!({"action":"upsert_node","id":id,"expected_revision":created["revision"],"node":{"id":"tool","title":"Tool","kind":"tool","config":{"tool":{"name":"known","arguments":{"count":2}}}}}),&ctx).await.unwrap());
        let patch = json!({"action":"patch_nodes","id":id,"expected_revision":added["revision"],"nodes":[{"id":"tool","config":{"tool":{"name":"known","arguments":{"count":false}}}}]});
        assert!(
            tool.call(patch, &ctx)
                .await
                .unwrap_err()
                .to_string()
                .contains("expected number")
        );
        let unchanged = store.read(id).unwrap();
        assert_eq!(unchanged.revision, added["revision"].as_u64().unwrap());
        assert_eq!(
            unchanged.nodes[0].config.tool.as_ref().unwrap().arguments["count"],
            json!(2)
        );
        tool.call(
            json!({"action":"save","id":id,"expected_revision":unchanged.revision}),
            &ctx,
        )
        .await
        .unwrap();
        let checks = store.verification(id, 1).unwrap().static_check.unwrap();
        assert_eq!(checks.tool_contracts, "known_arguments_checked");
        assert_eq!(checks.tool_contract_details.unwrap().known_nodes, ["tool"]);
    }

    #[test]
    fn known_tool_static_checks_preserve_literals_and_report_runtime_bindings_and_unknown_tools() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let mut definition = store.create("Contracts", "").unwrap();
        definition.nodes = serde_json::from_value(json!([
            {"id":"literal","title":"Literal","kind":"tool","config":{"tool":{"name":"known","arguments":{"count":2,"flag":false}}}},
            {"id":"bound","title":"Bound","kind":"tool","config":{"tool":{"name":"known","arguments":{"flag":true},"bindings":{"count":"/input/count"}}}},
            {"id":"unknown","title":"Unknown","kind":"tool","config":{"tool":{"name":"missing","arguments":{}}}}
        ])).unwrap();
        let contract = |name: &str| {
            (name == "known").then(|| kcoder_types::ToolDefinition {
            name: name.into(), description: String::new(),
            input_schema: json!({"type":"object","properties":{"count":{"type":"number"},"flag":{"type":"boolean"}},"required":["count","flag"],"additionalProperties":false}),
        })
        };
        let original = definition.clone();
        let checks = validate_workflow_tool_contracts(&definition, contract).unwrap();
        assert_eq!(checks.known_nodes, ["literal", "bound"]);
        assert_eq!(checks.runtime_bound_nodes, ["bound"]);
        assert_eq!(checks.unknown_nodes, ["unknown"]);
        assert_eq!(definition, original);
        definition.nodes[0].config.tool.as_mut().unwrap().arguments["count"] = json!("2");
        let error = validate_workflow_tool_contracts(&definition, contract)
            .unwrap_err()
            .to_string();
        assert!(error.contains("literal/config/tool/arguments") && error.contains("/count"));
        definition.nodes[0] = original.nodes[0].clone();
        definition.nodes[1]
            .config
            .tool
            .as_mut()
            .unwrap()
            .bindings
            .insert("path".into(), "/input/path".into());
        assert!(
            validate_workflow_tool_contracts(&definition, contract)
                .unwrap_err()
                .to_string()
                .contains("bound/config/tool/bindings/path")
        );
    }

    #[tokio::test]
    async fn node_help_is_small_uses_the_real_contract_and_does_not_guess_unavailable_tools() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_agent_runner(std::sync::Arc::new(StaticContracts));
        let code = payload(
            &WorkflowDraftTool
                .call(json!({"action":"help","node_kind":"code"}), &ctx)
                .await
                .unwrap(),
        );
        assert_eq!(code["kind"], "code");
        assert_eq!(code["executionAuthorized"], false);
        assert!(
            code["nodeSchema"]["properties"]["config"]["properties"]
                .get("loop")
                .is_none()
        );
        assert!(
            code["nodeSchema"]["properties"]["config"]["properties"]
                .get("tool")
                .is_none()
        );
        assert!(
            code["example"]["config"]["code"]["source"]
                .as_str()
                .unwrap()
                .contains("\"Quoted text\"")
        );
        assert!(code["guide"].as_str().unwrap().len() < 1000);
        let known = payload(
            &WorkflowDraftTool
                .call(
                    json!({"action":"help","node_kind":"tool","tool_name":"known"}),
                    &ctx,
                )
                .await
                .unwrap(),
        );
        assert_eq!(known["targetToolAvailable"], true);
        assert_eq!(known["targetToolContract"]["name"], "known");
        assert!(known["example"].is_null());
        let missing = payload(
            &WorkflowDraftTool
                .call(
                    json!({"action":"help","node_kind":"tool","tool_name":"Config"}),
                    &ctx,
                )
                .await
                .unwrap(),
        );
        assert_eq!(missing["targetToolAvailable"], false);
        assert!(missing["targetToolContract"].is_null());
        assert!(!temp.path().join("workflow-library").exists());
    }

    #[tokio::test]
    async fn help_needs_no_profile_and_core_contract_stays_compact() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
        let help = payload(
            &WorkflowDraftTool
                .call(json!({"action":"help"}), &ctx)
                .await
                .unwrap(),
        );
        assert!(help["nodeSchema"].is_object());
        assert!(help["guide"].as_str().unwrap().contains("config.transform"));
        assert!(
            help["targetTools"]
                .as_str()
                .unwrap()
                .contains("Not enumerated")
        );
        let core = WorkflowDraftTool.description();
        assert!(core.len() < 7000);
        for rule in [
            "expected_revision",
            "upsert_node replaces",
            "immutable",
            "unknown outcomes",
            "unknown outcomes",
            "response_detail=changes",
            "maxTurns=60",
            "/iteration/output",
        ] {
            assert!(core.contains(rule), "missing core contract: {rule}");
        }
        assert!(!temp.path().join("workflow-library").exists());
    }

    #[tokio::test]
    async fn structured_nested_schema_types_survive_coercion_and_storage() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let tool = WorkflowDraftTool;
        let created = payload(
            &tool
                .call(json!({"action":"create","title":"Typed"}), &ctx)
                .await
                .unwrap(),
        );
        let contract = json!({"type":"object","properties":{"events":{"type":"array","minItems":1,"items":{"type":"object","properties":{"region":{"type":"string","enum":["北美","欧洲"]},"actors":{"type":"array","minItems":1,"items":{"type":"string"}}}}}}});
        let original = json!({"action":"upsert_node","id":created["id"],"expected_revision":created["revision"],"node":{"id":"collect","title":"Collect","prompt":"Collect","config":{"outputSchema":contract},"acceptanceCriteria":["At least one event"]}});
        let mut input = original.clone();
        crate::coerce_input(&mut input, &tool.input_schema());
        assert_eq!(input, original);
        let stored = payload(&tool.call(input, &ctx).await.unwrap());
        assert_eq!(stored["nodes"][0]["config"]["outputSchema"], contract);
        let mut malformed = original;
        malformed["expected_revision"] = stored["revision"].clone();
        malformed["node"]["config"]["outputSchema"]["properties"]["events"]["minItems"] =
            json!("1");
        crate::coerce_input(&mut malformed, &tool.input_schema());
        assert!(
            tool.call(malformed, &ctx)
                .await
                .unwrap_err()
                .to_string()
                .contains("invalid JSON Schema")
        );
        let read = payload(
            &tool
                .call(json!({"action":"read","id":stored["id"]}), &ctx)
                .await
                .unwrap(),
        );
        assert_eq!(read["revision"], stored["revision"]);
        assert_eq!(read["nodes"][0]["config"]["outputSchema"], contract);
    }
    #[tokio::test]
    async fn bound_draft_defaults_id_and_reports_only_changed_nodes_losslessly() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let tool = WorkflowDraftTool;
        let created = payload(
            &tool
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
        let source = "const pattern = /\\d+/; const html = '<div title=\"中文\">';\nreturn {html, count: 1};";
        let node = json!({"id":"one","kind":"code","title":"Quoted code","config":{"code":{"source":source}},"acceptanceCriteria":["Typed output"]});
        let added = payload(&tool.call(json!({"action":"upsert_node","expected_revision":created["revision"],"node_json":serde_json::to_string(&node).unwrap(),"response_detail":"changes"}), &ctx).await.unwrap());
        assert_eq!(added["id"], created["id"]);
        assert_eq!(added["nodes"][0]["config"]["code"]["source"], source);
        assert_eq!(added["nodes"][0]["maxTurns"], 60);
        assert_eq!(added["changedNodeIds"], json!(["one"]));
        assert_eq!(added["validation"]["executionVerified"], false);
        assert_eq!(added["readback"]["id"], created["id"]);
        let patched = payload(&tool.call(json!({"action":"patch_nodes","expected_revision":added["revision"],"nodes":[{"id":"two","kind":"input","title":"Input","config":{"pointer":"/input"}}],"response_detail":"changes"}), &ctx).await.unwrap());
        assert_eq!(patched["nodeCount"], 2);
        assert_eq!(patched["nodes"].as_array().unwrap().len(), 1);
        assert_eq!(patched["nodes"][0]["id"], "two");
        let read = payload(
            &tool
                .call(json!({"action":"read","response_detail":"changes"}), &ctx)
                .await
                .unwrap(),
        );
        assert_eq!(read["nodes"].as_array().unwrap().len(), 2);
        let wrong = tool
            .call(json!({"action":"read","id":"another"}), &ctx)
            .await
            .unwrap_err()
            .to_string();
        assert!(wrong.contains("supplied id another"));
        let removed = payload(&tool.call(json!({"action":"patch_nodes","expected_revision":patched["revision"],"remove_node_ids":["two"],"response_detail":"changes"}), &ctx).await.unwrap());
        assert_eq!(removed["removedNodeIds"], json!(["two"]));
        assert_eq!(removed["nodeCount"], 1);
    }
    fn payload(output: &ToolOutput) -> Value {
        let kcoder_types::ContentBlock::Text { text } = &output.content[0] else {
            panic!("expected text")
        };
        serde_json::from_str(text).unwrap()
    }
    #[tokio::test]
    async fn workflow_contract_delete_only_patch_clears_draft_but_preserves_release() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let tool = WorkflowDraftTool;
        let created = payload(
            &tool
                .call(json!({"action":"create","title":"Delete only"}), &ctx)
                .await
                .unwrap(),
        );
        let added = payload(&tool.call(json!({"action":"upsert_node","id":created["id"],"expected_revision":created["revision"],"node":{"id":"one","title":"One","prompt":"Example"}}), &ctx).await.unwrap());
        let saved = payload(
            &tool
                .call(
                    json!({"action":"save","id":added["id"],"expected_revision":added["revision"]}),
                    &ctx,
                )
                .await
                .unwrap(),
        );
        let cleared = payload(&tool.call(json!({"action":"patch_nodes","id":saved["id"],"expected_revision":saved["revision"],"remove_node_ids":["one"]}), &ctx).await.unwrap());
        assert_eq!(cleared["nodes"], json!([]));
        assert_eq!(cleared["status"], "draft");
        assert!(
            tool.call(
                json!({"action":"save","id":cleared["id"],"expected_revision":cleared["revision"]}),
                &ctx
            )
            .await
            .is_err()
        );
        let old = payload(
            &tool
                .call(json!({"action":"read","id":saved["id"],"version":1}), &ctx)
                .await
                .unwrap(),
        );
        assert_eq!(old["nodes"], saved["nodes"]);
        assert!(tool.call(json!({"action":"patch_nodes","id":cleared["id"],"expected_revision":cleared["revision"]}), &ctx).await.is_err());
    }

    #[tokio::test]
    async fn sparse_model_patch_does_not_deserialize_omitted_guards_to_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let tool = WorkflowDraftTool;
        let created = payload(
            &tool
                .call(json!({"action":"create","title":"Guard"}), &ctx)
                .await
                .unwrap(),
        );
        let route=payload(&tool.call(json!({"action":"upsert_node","id":created["id"],"expected_revision":created["revision"],"node":{"id":"route","title":"Route","kind":"condition","config":{"condition":{"op":"exists","pointer":"/input"}}}}),&ctx).await.unwrap());
        let branch=payload(&tool.call(json!({"action":"upsert_node","id":route["id"],"expected_revision":route["revision"],"node":{"id":"branch","title":"Branch","prompt":"Original","dependsOn":["route"],"runIf":{"nodeId":"route","equals":true}}}),&ctx).await.unwrap());
        let patched=payload(&tool.call(json!({"action":"patch_nodes","id":branch["id"],"expected_revision":branch["revision"],"nodes":[{"id":"branch","prompt":"Revised"}]}),&ctx).await.unwrap());
        let branch = patched["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == "branch")
            .unwrap();
        assert_eq!(branch["dependsOn"], json!(["route"]));
        assert_eq!(branch["runIf"], json!({"nodeId":"route","equals":true}));
        assert_eq!(branch["title"], "Branch");
    }

    #[tokio::test]
    async fn another_conversation_can_patch_and_publish_without_replacing_identity() {
        let temp = tempfile::tempdir().unwrap();
        let context = || {
            ToolContext::new(kcoder_state::AppState::new(temp.path()))
                .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")))
        };
        let first = context();
        let second = context();
        let tool = WorkflowDraftTool;
        let created = payload(
            &tool
                .call(json!({"action":"create","title":"Existing"}), &first)
                .await
                .unwrap(),
        );
        let initial = payload(&tool.call(json!({"action":"upsert_node","id":created["id"],"expected_revision":created["revision"],"node":{"id":"work","title":"Work","prompt":"Review"}}), &first).await.unwrap());
        let saved = payload(&tool.call(json!({"action":"save","id":initial["id"],"expected_revision":initial["revision"]}), &first).await.unwrap());
        let listed = payload(&tool.call(json!({"action":"list"}), &second).await.unwrap());
        assert_eq!(listed["items"][0]["id"], saved["id"]);
        let read = payload(
            &tool
                .call(json!({"action":"read","id":saved["id"]}), &second)
                .await
                .unwrap(),
        );
        let edited = payload(&tool.call(json!({"action":"patch_nodes","id":read["id"],"expected_revision":read["revision"],"nodes":[
            {"id":"work","title":"Work","prompt":"Review thoroughly"},
            {"id":"audit","title":"Audit","prompt":"Audit independently"},
            {"id":"join","title":"Join","kind":"merge","dependsOn":["work","audit"],"config":{"mergePolicy":"all"}}
        ]}), &second).await.unwrap());
        assert_eq!(edited["id"], saved["id"]);
        assert_eq!(edited["nodes"].as_array().unwrap().len(), 3);
        let published = payload(&tool.call(json!({"action":"save","id":edited["id"],"expected_revision":edited["revision"]}), &second).await.unwrap());
        assert_eq!(published["savedVersion"], 2);
        assert_eq!(
            payload(
                &tool
                    .call(
                        json!({"action":"read","id":saved["id"],"version":1}),
                        &second
                    )
                    .await
                    .unwrap()
            ),
            saved
        );
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
    async fn create_persists_input_contract_and_rejects_malformed_contract_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let tool = WorkflowDraftTool;
        let contract = json!({"type":"object","required":["values"],"properties":{
            "values":{"type":"array","items":{"type":"integer"}},
            "mode":{"type":"string","enum":["sum","product"],"default":"sum"}}});
        for field in ["input_schema", "input_schema_json"] {
            let mut request = json!({"action":"create","title":"Typed creation"});
            request[field] = if field.ends_with("_json") {
                Value::String(contract.to_string())
            } else {
                contract.clone()
            };
            let created = payload(&tool.call(request, &ctx).await.unwrap());
            assert_eq!(created["inputSchema"], contract);
            let store = WorkflowStore::new(library_root(&ctx).unwrap());
            let definition = store.read(created["id"].as_str().unwrap()).unwrap();
            assert_eq!(definition.input_schema.as_ref(), Some(&contract));
            for args in [
                json!({}),
                json!({"values":"not-array"}),
                json!({"values":["not-an-int"]}),
                json!({"values":[1],"mode":"bogus"}),
            ] {
                assert!(kcoder_workflow::graph::prepare_arguments(&definition, &args).is_err());
            }
            assert_eq!(
                kcoder_workflow::graph::prepare_arguments(&definition, &json!({"values":[2,3,4]}))
                    .unwrap()["mode"],
                "sum"
            );
        }
        let store = WorkflowStore::new(library_root(&ctx).unwrap());
        let count = store.list().unwrap().len();
        assert!(tool.call(json!({"action":"create","title":"Invalid","input_schema":{"type":"object","required":{"item":"values"}}}),&ctx).await.is_err());
        assert_eq!(store.list().unwrap().len(), count);
    }

    #[tokio::test]
    async fn lossless_json_fields_preserve_contract_and_node_types_after_coercion() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let tool = WorkflowDraftTool;
        let created = payload(
            &tool
                .call(json!({"action":"create","title":"Lossless"}), &ctx)
                .await
                .unwrap(),
        );
        let id = &created["id"];
        let contract = json!({"type":"object","properties":{"days":{"type":"integer","default":3},"flag":{"type":"boolean","default":true},"items":{"type":"array","default":[1,2]}}});
        let mut request = json!({"action":"update","id":id,"expected_revision":created["revision"],"title":"Lossless","input_schema_json":serde_json::to_string_pretty(&contract).unwrap()});
        crate::coerce_input(&mut request, &tool.input_schema());
        let updated = payload(&tool.call(request, &ctx).await.unwrap());
        assert_eq!(updated["inputSchema"], contract);
        let node = json!({"id":"transform","title":"Typed","kind":"transform","config":{"transform":{"sourcePointer":"/input/items","steps":[{"op":"sort","pointer":"/price","descending":true},{"op":"limit","count":20}]}}});
        let mut request = json!({"action":"upsert_node","id":id,"expected_revision":updated["revision"],"node_json":serde_json::to_string_pretty(&node).unwrap()});
        crate::coerce_input(&mut request, &tool.input_schema());
        let updated = payload(&tool.call(request, &ctx).await.unwrap());
        assert_eq!(updated["nodes"][0]["config"], node["config"]);
        let patched=payload(&tool.call(json!({"action":"patch_nodes","id":id,"expected_revision":updated["revision"],"nodes_json":"[{\"id\":\"transform\",\"title\":\"Renamed\"}]"}),&ctx).await.unwrap());
        assert_eq!(patched["nodes"][0]["title"], "Renamed");
        assert_eq!(patched["nodes"][0]["config"], node["config"]);
        for fields in [
            json!({"input_schema":null,"input_schema_json":"{}"}),
            json!({"input_schema_json":"{broken"}),
        ] {
            let mut request = json!({"action":"update","id":id,"expected_revision":patched["revision"],"title":"Must not save"});
            request
                .as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            assert!(tool.call(request, &ctx).await.is_err());
        }
        let read = payload(
            &tool
                .call(json!({"action":"read","id":id}), &ctx)
                .await
                .unwrap(),
        );
        assert_eq!(read, patched);
        let imported=payload(&tool.call(json!({"action":"import","definition_json":serde_json::to_string(&read).unwrap()}),&ctx).await.unwrap());
        assert_ne!(imported["id"], read["id"]);
        assert_eq!(imported["inputSchema"], contract);
    }

    #[tokio::test]
    async fn bound_design_can_read_saved_child_contract_but_not_its_draft_or_mutations() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let store = WorkflowStore::new(library_root(&ctx).unwrap());
        let parent = store.create("Parent", "").unwrap();
        let child = store.create("Child", "").unwrap();
        let child = store.update_metadata(&child.id,child.revision,"Child","",Some(json!({"type":"object","properties":{"city":{"type":"string"},"days":{"type":"integer","default":3}}}))).unwrap();
        let child = store.upsert_node(&child.id, child.revision, serde_json::from_value(json!({"id":"input","title":"Input","kind":"input","config":{"pointer":"/input"}})).unwrap()).unwrap();
        let child = store.save(&child.id, child.revision).unwrap();
        ctx.state
            .enter_session_mode_before_first_message(kcoder_state::SessionMode::WorkflowDraft)
            .unwrap();
        ctx.state
            .bind_workflow_definition_before_first_message(&parent.id)
            .unwrap();
        let read = payload(
            &WorkflowDraftTool
                .call(json!({"action":"read","id":child.id,"version":1}), &ctx)
                .await
                .unwrap(),
        );
        assert_eq!(read["inputSchema"]["properties"]["days"]["default"], 3);
        for input in [
            json!({"action":"read","id":child.id}),
            json!({"action":"update","id":child.id,"version":1,"title":"Wrong","expected_revision":child.revision}),
            json!({"action":"read","id":child.id,"version":999}),
        ] {
            assert!(WorkflowDraftTool.call(input, &ctx).await.is_err());
        }
        assert_eq!(store.read(&child.id).unwrap().title, "Child");
    }

    #[tokio::test]
    async fn schema_errors_identify_the_field_and_failed_updates_do_not_mutate() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let tool = WorkflowDraftTool;
        let created = payload(
            &tool
                .call(json!({"action":"create","title":"schema"}), &ctx)
                .await
                .unwrap(),
        );
        let id = &created["id"];
        let revision = &created["revision"];
        for (schema, expected) in [
            (json!("{\"type\":\"object\"}"), "JSON-encoded string"),
            (json!({"type":"invalid"}), "/type"),
        ] {
            let error = tool.call(json!({"action":"update","id":id,"expected_revision":revision,"title":"changed","input_schema":schema}), &ctx).await.unwrap_err().to_string();
            assert!(error.contains("input_schema"), "{error}");
            assert!(error.contains(expected), "{error}");
            let current = payload(
                &tool
                    .call(json!({"action":"read","id":id}), &ctx)
                    .await
                    .unwrap(),
            );
            assert_eq!(current["revision"], *revision);
            assert_eq!(current["title"], "schema");
        }
        for schema in [json!({}), json!({"type":"object"})] {
            let current = payload(
                &tool
                    .call(json!({"action":"read","id":id}), &ctx)
                    .await
                    .unwrap(),
            );
            tool.call(json!({"action":"update","id":id,"expected_revision":current["revision"],"title":"schema","input_schema":schema}), &ctx).await.unwrap();
        }
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
