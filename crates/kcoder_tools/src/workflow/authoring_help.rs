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
pub(super) fn payload(
    kind: Option<WorkflowNodeKind>,
    contract: Option<kcoder_types::ToolDefinition>,
) -> Value {
    if let Some(kind) = kind {
        let (guide, example) = detail(kind);
        json!({"kind":kind,"nodeSchema":schema(kind),"guide":guide,"example":example,"targetToolAvailable":contract.is_some(),"targetToolContract":contract,"executionAuthorized":false})
    } else {
        json!({"nodeSchema":clean_schema(schemars::schema_for!(WorkflowNode)),"guide":include_str!("authoring-help.md"),"targetTools":"Not enumerated here. Inspect the execution target's current registered tool contracts and permissions; examples do not imply availability.","discovery":"Use node_kind for a small kind-specific schema/example; for tool help also supply tool_name."})
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
