//! Small kind-specific examples and only reachable schema contracts, with no execution.
use crate::clean_schema;
use kcoder_types::workflow::{WorkflowNode, WorkflowNodeKind};
use serde_json::{Value, json};
use std::collections::{BTreeSet, VecDeque};
fn refs(value: &Value, found: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            if let Some(reference) = map
                .get("$ref")
                .and_then(Value::as_str)
                .and_then(|reference| reference.strip_prefix("#/definitions/"))
            {
                found.insert(reference.into());
            }
            for value in map.values() {
                refs(value, found);
            }
        }
        Value::Array(values) => {
            for value in values {
                refs(value, found)
            }
        }
        _ => {}
    }
}
fn schema(kind: WorkflowNodeKind) -> Value {
    let full = clean_schema(schemars::schema_for!(WorkflowNode));
    let mut selected = full.clone();
    selected["properties"]["kind"] = json!({"const":kind});
    let field = &full["properties"]["config"];
    let mut config = field
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|reference| full.pointer(reference.trim_start_matches('#')))
        .unwrap_or(field)
        .clone();
    let allowed = kcoder_workflow::graph::config_field_names(kind);
    if let Some(properties) = config.get_mut("properties").and_then(Value::as_object_mut) {
        properties.retain(|name, _| allowed.contains(&name.as_str()));
    }
    selected["properties"]["config"] = config;
    selected.as_object_mut().unwrap().remove("definitions");
    let mut needed = BTreeSet::new();
    refs(&selected, &mut needed);
    let mut pending: VecDeque<_> = needed.iter().cloned().collect();
    while let Some(name) = pending.pop_front() {
        if let Some(value) = full["definitions"].get(&name) {
            let mut child = BTreeSet::new();
            refs(value, &mut child);
            for name in child {
                if needed.insert(name.clone()) {
                    pending.push_back(name);
                }
            }
        }
    }
    let definitions = needed
        .into_iter()
        .filter_map(|name| {
            full["definitions"]
                .get(&name)
                .cloned()
                .map(|value| (name, value))
        })
        .collect::<serde_json::Map<_, _>>();
    if !definitions.is_empty() {
        selected["definitions"] = Value::Object(definitions);
    }
    selected
}
fn detail(kind: WorkflowNodeKind) -> (&'static str, Option<Value>) {
    use WorkflowNodeKind::*;
    match kind {
        Code => (
            "Pure synchronous function BODY receives input,nodes,bindings. No filesystem/network/agent access. Correct JSON encoding keeps normal quotes, regex and newlines. Pair declared input/output schemas and resultCheck with actual acceptance criteria.",
            Some(
                json!({"id":"compute","title":"Compute","kind":"code","config":{"code":{"source":"const pattern = /\\d+/;\nif (typeof input.text !== 'string') throw new Error('text must be a string');\nreturn {hasDigits: pattern.test(input.text), label: \"Quoted text\"};"},"outputSchema":{"type":"object","required":["hasDigits","label"],"properties":{"hasDigits":{"type":"boolean"},"label":{"type":"string"}}}}}),
            ),
        ),
        Input => (
            "Input only reads data. It does not run a prompt or enforce defaults; define workflow input_schema for contracts/defaults.",
            Some(
                json!({"id":"input","title":"Input","kind":"input","config":{"pointer":"/input"}}),
            ),
        ),
        Output => (
            "Select a pointer from input or a direct dependency. No implicit /output wrapper; use Template separately to format text.",
            Some(
                json!({"id":"output","title":"Output","kind":"output","config":{"pointer":"/input/value"}}),
            ),
        ),
        Template => (
            "Interpolation uses absolute JSON pointers inside {{...}}; bare pointers are literal text.",
            Some(
                json!({"id":"greeting","title":"Greeting","kind":"template","config":{"template":"Hello {{/input/name}}"}}),
            ),
        ),
        Transform => (
            "Source/filter pointers use /input or direct /nodes. map/sort/deduplicate pointers are relative to each item. Steps preserve declared ordering and types.",
            Some(
                json!({"id":"mapped","title":"Map","kind":"transform","config":{"transform":{"sourcePointer":"/input/items","steps":[{"op":"map","fields":{"id":"/id"}}]}}}),
            ),
        ),
        Condition => (
            "Produces a boolean; dependents need dependsOn and runIf to gate a branch. Numeric operands must exist and be numbers; exists+all guards optional data.",
            Some(
                json!({"id":"high","title":"High score","kind":"condition","config":{"condition":{"op":"greater_than","pointer":"/input/score","value":0.8}}}),
            ),
        ),
        Switch => (
            "Ordered first-match labels, with unique case/default labels. Branch runIf.equals uses the label string; independent condition nodes are for multi-select routes.",
            Some(
                json!({"id":"route","title":"Route","kind":"switch","config":{"switch":{"cases":[{"label":"high","condition":{"op":"greater_than","pointer":"/input/score","value":0.8}}],"default":"other"}}}),
            ),
        ),
        Merge => (
            "Use real dependency IDs. Output is keyed by dependency ID; any joins alternate branches after they settle, all requires every dependency. This example assumes left/right already exist.",
            Some(
                json!({"id":"join","title":"Join","kind":"merge","dependsOn":["left","right"],"config":{"mergePolicy":"any"}}),
            ),
        ),
        Wait => (
            "Exactly one delayMs or untilUnixMs. Persistent wait does not call a model; bound the workflow timeout to cover its deadline.",
            Some(
                json!({"id":"wait","title":"Wait","kind":"wait","config":{"wait":{"delayMs":100}}}),
            ),
        ),
        Human => (
            "Requires actual execution-target interaction support and an explicitly authorized response driver. Test separately from unattended smoke tests.",
            Some(
                json!({"id":"approval","title":"Approval","kind":"human","config":{"human":{"prompt":"Approve this result?","responseSchema":{"type":"boolean"},"timeoutMs":1000}}}),
            ),
        ),
        Event => (
            "Requires an authenticated execution-target event driver; name/schema/deadline are persisted. No model calls while waiting.",
            Some(
                json!({"id":"event","title":"Event","kind":"event","config":{"event":{"name":"ready","payloadSchema":{"type":"object"},"timeoutMs":1000}}}),
            ),
        ),
        Agent => (
            "Judgment/language node; outputSchema validates a single response. Actual execution requires explicit consent and target Agent support; maxTurns default remains 60.",
            Some(
                json!({"id":"review","title":"Review","kind":"agent","prompt":"Judge the input and return JSON with an approved boolean.","maxTurns":60,"config":{"outputSchema":{"type":"object","required":["approved"],"properties":{"approved":{"type":"boolean"}}}}}),
            ),
        ),
        Loop => (
            "until runs AFTER each iteration. Only /iteration/index,item,output exist. greater_than excludes equality. outputSchema validates each iteration, not the aggregate array; test early/equality/limit. A saved pure Code body is preferable to an Agent for deterministic smoke tests; resolve and pin the actual child first.",
            Some(
                json!({"id":"loop","title":"Loop","kind":"loop","prompt":"Return JSON with the score computed from the actual input.","maxTurns":60,"config":{"loop":{"mode":"repeat","maxIterations":3,"until":{"op":"greater_than","pointer":"/iteration/output/score","value":0.8}},"outputSchema":{"type":"object","required":["score"],"properties":{"score":{"type":"number"}}}}}),
            ),
        ),
        Tool => (
            "Inspect the actual target tool contract returned below. Unknown, orchestration, Config and freeform tools are not advertised as callable. arguments must be an object; bindings override named keys via /input/direct /nodes. Metadata does not authorize execution. No invented tool/path/input example is provided.",
            None,
        ),
        Subworkflow => (
            "Discover and read an actual immutable definitionId/version before publication; named argument object only, bindings override keys. Nested budgets are shared; avoid heavy children for smoke tests. No fabricated child ID/version example is provided.",
            None,
        ),
    }
}
/// The detailed authoring contract, delivered just in time through `action=help`
/// instead of every request's tool description. Section keys are stable: tool
/// descriptions and error messages refer to them as `contract.<key>`.
pub(super) const CONTRACT: &[(&str, &str)] = &[
    (
        "editing",
        "Read existing drafts before edits; keep the ID and unrelated data. Bound conversations default id to their own draft and may inspect other definitions only by explicit saved version. Mutations require the current expected_revision; use the returned revision, and reload after conflicts or an unconfirmed commit before retrying. upsert_node replaces the whole node. update replaces title, description and input_schema (omitted/null clears the schema). patch_nodes atomically merges supplied node fields/config keys, preserving omitted fields and other nodes; each supplied config value replaces that value. runIf:null clears the guard, dependsOn:[] clears dependencies. Deletion-only patches omit nodes/nodes_json and use remove_node_ids; rewire dependents explicitly. Failed mutations change nothing. save validates a nonempty graph and creates an immutable version; corrections need a new version. Canvas layout uses separate CAS and does not advance content revision. Recommend response_detail=changes for mutations (affected nodes, removed IDs and revision); legacy full is still the default, read/export always return complete definitions. After input errors inspect the schema/error, isolate one field, and preserve requested semantics.",
    ),
    (
        "encoding",
        "Preserve numbers, booleans, nested arrays, defaults and Unicode exactly. Prefer node_json, nodes_json, input_schema_json or definition_json for complex nested values, especially with providers known to rewrite structured parameters; supply correctly encoded JSON text, never both alternatives. Structured fields must preserve actual types: no scalar stringification or dropped defaults. Whitespace/minifying cannot fix wrong types. Correct JSON encoding supports ordinary quotes, backslashes, regex and newlines; do not rewrite code or remove typed defaults to bypass errors. acceptanceCriteria is a flat string array.",
    ),
    (
        "dataModel",
        "Authoring checks graph/dependencies, schemas/defaults, pointers, pure code syntax and declared contracts without running agents, tools, services or desktop effects. Confirm actual target tool contracts before publication; unknown contracts remain unverified. Agent defaults retain maxTurns=60. Data is /input and /nodes/<direct dependency>; config.inputBindings appear as top-level bindings, with no implicit /output wrapper. Merge results have dependency-ID keys. Only /iteration/index, /iteration/item and /iteration/output exist in Loop; until runs after each iteration, and greater_than excludes equality. Use runIf guards to gate branches. Subworkflows pin immutable definitionId/version.",
    ),
    (
        "resultChecks",
        "Configured resultCheck receives input,nodes,bindings,result and must return true; assert actual values/types/counts/identity and inspect written artifacts. Missing data or workflowError must never automatically pass. Completed means execution ended; configured checks cover only checked nodes.",
    ),
    (
        "verification",
        "After saving, state exactly what static checks passed and ask whether actual verification is wanted. Generation/saving alone does not authorize execution. An existing request to generate and test authorizes testing within that scope without another confirmation. Authorized tests must check realistic inputs, branch non-execution, loop early-exit/equality/limit, and actual results/artifacts; repair failures in a new saved version and retest. Keep execution-unverified status until evidence satisfies the criteria. Resume completed effects; inspect unknown outcomes and never blindly replay them. Never publish credentials or sensitive verification inputs in public definitions/reports; use private run inputs and publish fingerprints/opaque references. interactionModified evidence belongs to that adjusted run and does not prove untouched saved-definition reuse.",
    ),
    (
        "reuse",
        "For requested reuse, list by title, resolve ambiguous matches in conversation, and read the selected saved version before running it with definition_id and version. Derive args from the user request and declared defaults; ask for missing or ambiguous required inputs before execution. Do not invent values or execute merely to discover missing inputs.",
    ),
    (
        "runRecovery",
        "For a failed/interrupted/cancelled run, inspect its status/error, then resume it with its run_id and the original arguments unless a correction is required. Resume reuses successful checkpoints for every node kind when its execution semantics, all upstream nodes, effective inputs and run configuration match; unfinished and affected nodes rerun. Legacy JavaScript resumes still reuse matching Agent outputs. For a changed workflow, save the new version and start a new run with definition_id, version and reuse_from_run=<old run_id>: it retains the old history and reuses the unchanged dependency-closed prefix. Supply an explicit source run and saved target version; never guess the version or automatically choose a source. Result checks run again on reused outputs. This is node-level recovery and cannot guarantee exactly-once external effects; direct-tool receipts with unknown outcomes block recovery until inspected. Inspect the persisted run status and result before waiting again. Each resumed input/verification case owns a distinct artifact attempt, preserving old evidence. Run arguments: a root array is args itself; to access args.items pass an object with an items array; do not add item wrappers or change whitespace to work around transport corruption. A saved input_schema rejects wrong types before execution; without one an arbitrary item object's intent cannot be inferred. verification_scenario declares a finite configured-check case for a pinned graph (ASCII id, requiredCheckNodes, optional exact expectedSkippedNodes) and never carries a verdict/status; script sources reject named cases; declared scenario coverage is separate from configured checks and full-graph claims, and no scenario means unrecorded.",
    ),
    (
        "storage",
        "migrate_storage/rollback_storage/archive_version require an explicit storage or history request; never run them for ordinary authoring/polling. version_references shows fixed/live/unknown blockers before explicit archive_version. Archive removes publication but retains the exact private historical snapshot (read_history) and never recycles version IDs; legacy downgrade preflight may refuse unrepresentable version counts without deleting data. Use action=verification with id/version for exact version evidence and action=capacity for distinct count/byte budgets.",
    ),
    (
        "runHistory",
        "Only after an explicit history management request use preview_run_archive with selected run_ids, present capacity/blockers/retained recovery artifacts, and wait for explicit confirmation before archive_runs with the exact run_ids, preview_token, and confirm=true. Never select or archive history to work around quota without user consent. read_archived_run reads retained observations; artifacts/checkpoints/verification and immutable saved-version references remain intact. A stale preview requires a new preview and confirmation; recoveryPending means archival committed and publication needs recovery, so query the same token without replaying other actions.",
    ),
    (
        "library",
        "list/versions discover definitions/releases; clone/import create new draft IDs, export is portable. help (optional node_kind, or node_kind=tool + tool_name) returns focused node schema/examples and actual safe target contracts on demand; help does not advertise target tools as available. Handle these requests in conversation.",
    ),
    (
        "collaboration",
        "action=collaboration_presets returns non-executing role contracts. On an empty existing draft, action=apply_collaboration requires id/expected_revision and collaboration_plan (or lossless collaboration_plan_json). It atomically adds explicit inputs, models, read-only roles, DAG-ordered scoped writers and independent checks. It does not save or execute; save normally, then run an explicitly requested fixed version. expectedArtifacts remains human-readable; config.artifactRequirements is enforced against actual native reports. Per-role modelSelection is resolved by the original Agent runner; verifiers keep the actual parent model and unsupported/unobserved models refuse before requests.",
    ),
];

pub(super) fn contract_sections() -> Value {
    Value::Object(
        CONTRACT
            .iter()
            .map(|(key, text)| ((*key).to_string(), Value::String((*text).to_string())))
            .collect(),
    )
}

pub(super) fn payload(
    kind: Option<WorkflowNodeKind>,
    contract: Option<kcoder_types::ToolDefinition>,
) -> Value {
    if let Some(kind) = kind {
        let (guide, example) = detail(kind);
        json!({"kind":kind,"nodeSchema":schema(kind),"guide":guide,"example":example,"targetToolAvailable":contract.is_some(),"targetToolContract":contract,"executionAuthorized":false})
    } else {
        json!({"contract":contract_sections(),"nodeSchema":clean_schema(schemars::schema_for!(WorkflowNode)),"guide":include_str!("authoring-help.md"),"targetTools":"Not enumerated here. Inspect the execution target's current registered tool contracts and permissions; examples do not imply availability.","discovery":"Use node_kind for a small kind-specific schema/example; for tool help also supply tool_name."})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn small_examples_parse_and_validate_without_execution() {
        use WorkflowNodeKind::*;
        for kind in [
            Code, Input, Output, Template, Transform, Condition, Switch, Merge, Wait, Human, Event,
            Agent, Loop,
        ] {
            let value = payload(Some(kind), None);
            let node: WorkflowNode = serde_json::from_value(value["example"].clone()).unwrap();
            let mut nodes = vec![node];
            if kind == Merge {
                for id in ["left", "right"] {
                    nodes.push(serde_json::from_value(json!({"id":id,"title":id,"kind":"input","config":{"pointer":"/input"}})).unwrap());
                }
            }
            let definition:kcoder_types::workflow::WorkflowDefinition=serde_json::from_value(json!({"id":"help","title":"Help","description":"","revision":1,"status":"draft","nodes":nodes,"createdAtMs":0,"updatedAtMs":0,"savedVersion":null})).unwrap();
            kcoder_workflow::graph::validate(&definition, true).unwrap();
        }
    }
}
