//! Incremental, non-executing workflow-library authoring.
use crate::{ToolContext, ToolError};
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
        "Author a persistent workflow without executing it. Generation quality is part of authoring, not an optional later step. Derive concrete acceptance criteria from the user request, trace each required output back to its inputs/dependencies, declare typed contracts at data boundaries, review both branch outcomes and loop stopping boundaries, and provide representative valid/invalid input examples with expected results. Correct known contradictions or unsupported assumptions before saving. During generation, proactively check node schemas, dependency graph, available tool contracts, input/output types, branching guards, feasible loop thresholds and meaningful result checks; use static checks or isolated pure computations without starting the workflow or invoking agents, external services or side effects. After generation/saving, report what was checked and proactively ask whether the user wants actual execution verification. Run validation only after an explicit request; generation or saving alone is not execution consent. An initial request to generate AND test already authorizes testing within that scope; do not ask again. When authorized, run realistic inputs, inspect results/artifacts against acceptance criteria, fix failures, publish corrected versions and retest until the criteria pass or a real blocker requires user input. Report saved but execution-unverified when no run was tested, including untested agent/service assumptions; claim ready for reuse only when end-to-end evidence satisfies acceptance criteria. Never equate schema validity or successful saving with runtime verification. create accepts input_schema or preferably input_schema_json and validates/stores it atomically; invalid contracts reject creation. Read back the returned inputSchema before claiming inputs are protected. Use Code/Transform for arithmetic, filtering, deduplication and passthrough; Tool for deterministic file I/O; Agent only for judgment or language work. For future Tool nodes on an execution target providing read, configure that node with arguments.format=raw for whole machine-readable text; omit offset, limit and pages (numbered mode supports ranges). This defines a future node; it does not call read in this authoring session. Agents whose outputs feed data nodes must declare outputSchema. Merge outputs have one level of dependency-ID keys. Validate required field types; do not hide missing data with empty defaults or boolean coercion. Build multiline command text from lines joined by a real newline, avoiding double-escaped strings. Declare required data in config.inputBindings (name to /input or /nodes/<direct dependency>/field), then use top-level bindings.name, not input.bindings. allowedWritePaths are literal authorized paths relative to the execution workspace, not interpolation templates. There is no implicit /output wrapper. Add config.resultCheck {source,timeoutMs} to verify important results; its pure JavaScript receives input,nodes,bindings,result and must return true. Read back written artifacts through a Tool node and compare them before final Output. Schema-valid JSON alone is not evidence of a correct result. A resultCheck must assert required values, types, lengths and ID correspondence; missing preview entries or workflowError cannot automatically count as success. An intentional negative test must assert the exact expected failure and that unintended effects did not occur. Valid JSON that violates outputSchema is not repaired by a model. If a provider corrupts nested numeric/boolean/array arguments, use node_json, nodes_json, input_schema_json or definition_json containing valid JSON text instead of the corresponding object field; never supply both. These text alternatives are parsed losslessly and receive identical validation/permissions. Native structured fields remain valid; JSON text preserves ordinary code strings, quotes, backslashes, regular expressions and newlines when correctly JSON-escaped. Never rewrite code to remove quotes or regexes. Use JSON.stringify on a node object when an available execution tool can construct JSON, rather than manually counting nested escapes. acceptanceCriteria is a flat string array, never string[][]. Use response_detail=changes for incremental mutations to return only affected nodes plus revision and metadata; read/export always return the full definition. Omitted id in a bound design conversation selects its own draft; use JSON-text alternatives consistently after observing transport corruption. JSON whitespace does not change types: minifying or changing line breaks is not a fix for object/array confusion. Keep payloads small and change only understood fields. Preserve requested sort, limit, comparisons and typed defaults; do not remove them to bypass type errors. list discovers saved definitions across conversations (offset/limit pagination, at most 32 items). Create a draft, then upsert each node in a separate call so progress is visible. Use returned revision as expected_revision on each mutation. read without version returns the current draft; read with version returns that immutable saved version including its input schema. Bound design conversations may read other saved workflows by explicit version to verify subworkflow inputs, but cannot read or modify their drafts. Read after revision conflicts. After repeated input errors, inspect the schema/error and isolate one field or a minimal configuration; do not keep guessing paths or changing several unknowns together. patch_nodes is for known, atomic multi-node edits, not a cure for an unknown parameter shape. Avoid throwaway probe nodes/revisions when static inspection or an isolated minimal test suffices. upsert_node replaces the whole node; preserve unchanged fields when editing an existing node. Concurrent canvas position changes are preserved and do not advance content revision. save validates and publishes an immutable version; it never runs agents. Agent outputSchema validates one response; for Loop it validates each iteration response, NEVER an array of all iterations unless each iteration itself returns an array. Loop until is checked AFTER each iteration against the full context. Only /iteration/index (zero-based), /iteration/item and /iteration/output exist. For a score on a 0–1 scale, an example stop condition is {op:\"greater_than\",pointer:\"/iteration/output/score\",value:0.8}; choose the threshold from the actual formula/range, not by copying this example. NEVER use /iteration/score or /score. Verify an early-exit case with count below maxIterations and exitReason=condition_met, an equality boundary (greater_than does not accept equality), and a non-triggering case (repeat: iteration_limit; for_each: collection_exhausted). Configure outputSchema with score as a required number; without outputSchema agent output remains text, even when it looks like JSON. Missing/non-numeric numeric operands fail explicitly; use exists with all to guard optional fields. Loop downstream output is {iterations:[responses],count,exitReason}. Optional config.loop.body {definitionId,version,arguments,bindings} runs a saved subgraph per iteration; bindings may use /iteration/item or /iteration/index. Child results retain their outputs array. Optional config.failurePolicy {maxAttempts:1,delayMs:0,continueOnError:false} supports at most 3 attempts and 60000ms delay. Automatic retries require pure nodes or runtime-verified read-only tools; never agents, subworkflows or interactive nodes. With continueOnError, ordinary failure yields {workflowError:{nodeId,message}} for explicit downstream recovery guards; cancellation, resource quotas and result/schema check failures still stop execution. Merge downstream output is an object keyed by completed dependency IDs; e.g. /nodes/join/reviewed/route, not /nodes/join/route. Input data is /input; only direct dependency outputs are exposed under /nodes. Condition produces a boolean at /nodes/<id> for direct dependents. Copying that boolean into an output field does not gate execution: declare the dependency and a runIf guard on the branch node. Transform nodes use config.transform {sourcePointer,steps}; up to 16 steps support map {fields: output-name to item-relative JSON pointer}, filter {condition: predicate evaluated with input=current item and original nodes}, sort {pointer,descending}, deduplicate {pointer?}, limit {count}. Source and filter pointers use /input or direct /nodes; map/sort/deduplicate pointers are relative to each item. Wait nodes use config.wait with exactly one of delayMs (0–86400000) or untilUnixMs. Human nodes use config.human {prompt,responseSchema,timeoutMs}; event nodes use config.event {name,payloadSchema,timeoutMs}. They persist deadlines and wait without LLM calls; users respond in the execution canvas, authenticated clients use workflow/runs/respond for events. timeoutMs is 1–86400000, default 1800000. Raise the overall workflow timeout for long waits. Subworkflow nodes use kind subworkflow and config.subworkflow {definitionId,version,arguments,bindings}; arguments is a JSON object of named inputs, never a positional array, and bindings override its keys. Discover existing definitions, inspect their node count, agent/network cost and interaction requirements, then pin an explicit saved version. For a simple test prefer a one-Code-node child; simple-looking inputs do not make a heavy child workflow lightweight. bindings uses the same top-level argument to JSON-pointer mapping as tool nodes. Nested graphs share concurrency/execution budgets, permit at most 8 levels and reject version cycles. Returns the child graph result {workflowId,version,outputs,skipped}. Do not guess a future tool name or its parameter keys: confirm the target contract before publication; standard file read uses file_path, not path. Unknown contracts are blockers to verify, not errors to hide with continueOnError. Tool nodes use kind tool and config.tool {name,arguments,bindings}; arguments is a JSON object, bindings maps top-level argument names to /input or direct /nodes JSON pointers. Calls use host permissions without an LLM; orchestration and configuration tools are excluded. Completed effects are reused on resume; unknown outcomes must not be replayed. Optional outputSchema validates {content,isError}. Code nodes use kind code and config.code {source,timeoutMs}: source is a synchronous JavaScript function body receiving input and nodes (direct dependencies only); return JSON data. No model, filesystem, network, shell or agent access; timeoutMs is 1–10000, default 1000, source at most 64 KiB. Optional outputSchema validates the returned JSON. Rich nodes use typed kind/config/runIf fields; condition and loop predicates are declarative, never code. input_schema must be a JSON Schema object or boolean, never a JSON-encoded string; {} and {type:object} are valid. Input nodes only read data and do not execute their prompt or enforce defaults. Put defaults in input_schema properties. dependsOn belongs inside node, not tool-call top level. Output selects data through config.pointer; use a separate Template node for formatting. config.template is text with absolute JSON Pointers inside {{...}}, e.g. Hello {{/input/name}}. A bare /input/name is literal text, not interpolation. update fully replaces title, description and input_schema (omit schema to clear it). versions lists immutable releases; clone creates a new draft from an existing id and optional version. export returns portable definition JSON; import accepts definition JSON and creates a new unpublished draft with a new ID. Handle create, edit, rename, save, copy, import and export requests directly in conversation; do not send users to forms or require them to write JSON. Node dependencies reference IDs in the same draft. For complex edits, patch_nodes atomically upserts nodes and deletes remove_node_ids, validates the resulting graph, and increments revision once. For deletion-only edits omit nodes/nodes_json. Removing every node leaves an empty draft; saved versions remain immutable. An empty draft may be rebuilt but cannot be saved or run. Unmentioned nodes AND omitted fields remain unchanged; config merges keys, each supplied config value replaces that value. Use runIf:null to explicitly clear a guard and dependsOn:[] to clear dependencies. Rewire deleted dependencies explicitly. Do not resend unrelated fields. Failed patches change nothing. Read the current draft before editing an existing workflow; keep its ID and preserve unrelated fields. For ordered exclusive routing prefer kind switch with config.switch {cases:[{label,condition}],default}; its output is the first matching label, or default when none match. Branch runIf.equals is that label string (condition guards still use booleans). Labels must be unique including default. Use independent condition nodes instead for multi-select routing. Build multi-way routes with one condition per case (exclusive predicates when only one route should run), runIf on each branch entry, nested conditions for sub-branches, and mergePolicy any to join alternatives after they settle; all joins require every dependency. Conditions support all/any/not predicates. Default routes must negate the union of cases. Independent branches run concurrently within execution limits. For a simple unattended smoke test, prefer a minimal deterministic graph and test observable behavior rather than counting node types. Keep human/event out of its required output path unless an explicitly authorized response driver is provided; test interaction round-trips separately. Test true/false routes and skipped-node non-execution. A published version is immutable: read the draft, patch known corrections, then save a new version; never claim savedVersion 1 was repaired in place.".into()
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
            "Workflow draft ID. In a bound design conversation, omitted id uses its bound draft. Explicit other IDs cannot mutate/read other drafts; read an immutable saved workflow by explicit id and version. Outside bound design conversations, id is required except for create/import/list."
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
            if input.id.is_none() && !matches!(input.action, Action::List) {
                input.id = Some(bound.clone());
            }
            if !matches!(input.action, Action::List)
                && !(matches!(input.action, Action::Read) && input.version.is_some())
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
            Action::PatchNodes => {
                let nodes = match input.nodes {
                    Some(nodes) => nodes,
                    None if !input.remove_node_ids.is_empty() => Vec::new(),
                    None => return Err(ToolError::InvalidInput("patch_nodes requires nodes/nodes_json or nonempty remove_node_ids".into())),
                };
                store.patch_fields(id()?, revision()?, nodes, input.remove_node_ids)
            },
            Action::UpsertNode => store.upsert_node(
                id()?,
                revision()?,
                input.node.clone().ok_or_else(|| missing("node"))?,
            ),
        }
        .map_err(|error| ToolError::Execution(error.to_string()))?;
        if matches!(input.response_detail, Some(ResponseDetail::Changes))
            && !matches!(input.action, Action::Read | Action::Export)
        {
            let nodes = result
                .nodes
                .iter()
                .filter(|node| changed_ids.contains(&node.id))
                .collect::<Vec<_>>();
            return Ok(ToolOutput::text(json!({"id":result.id,"title":result.title,"revision":result.revision,
                "status":result.status,"savedVersion":result.saved_version,"nodeCount":result.nodes.len(),
                "inputSchema":result.input_schema,"nodes":nodes,"removedNodeIds":removed_ids}).to_string()));
        }
        Ok(ToolOutput::text(serde_json::to_string(&result).map_err(
            |error| ToolError::Execution(error.to_string()),
        )?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
