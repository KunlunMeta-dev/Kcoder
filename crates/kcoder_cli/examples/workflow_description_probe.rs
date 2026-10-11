//! Bounded real-Provider probe; only owned draft authoring is executed, never nodes.
#[path = "workflow_description_probe/owned_authoring.rs"]
mod owned_authoring;
use anyhow::{Context, Result, ensure};
use futures::StreamExt;
use kcoder_api::provider_factory::ProviderFactory;
use kcoder_config::SettingsLoader;
use kcoder_tools::{Tool, workflow_draft::WorkflowDraftTool};
use kcoder_types::{
    ContentBlock, ContentDelta, Message, MessagesRequest, StreamEvent, ToolDefinition,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    time::{Duration, Instant},
};

fn contains_expected(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => e
            .iter()
            .all(|(k, v)| a.get(k).is_some_and(|a| contains_expected(a, v))),
        _ => actual == expected,
    }
}
fn graph_valid(input: &Value) -> bool {
    let nodes = if let Some(node) = input.get("node") {
        vec![node.clone()]
    } else {
        vec![]
    };
    let definition = json!({"id":"audit-draft","title":"Audit","description":"", "revision":7,"status":"draft","nodes":nodes,"inputSchema":input.get("input_schema"),"createdAtMs":0,"updatedAtMs":0});
    serde_json::from_value::<kcoder_types::workflow::WorkflowDefinition>(definition)
        .is_ok_and(|definition| kcoder_workflow::graph::validate(&definition, false).is_ok())
}
fn mismatch_paths(actual: &Value, expected: &Value, path: &str, result: &mut Vec<String>) {
    if let (Value::Object(a), Value::Object(e)) = (actual, expected) {
        for (key, value) in e {
            let child = format!("{path}/{key}");
            match a.get(key) {
                Some(actual) => mismatch_paths(actual, value, &child, result),
                None => result.push(child),
            }
        }
    } else if let (Value::Array(a), Value::Array(e)) = (actual, expected) {
        if a.len() != e.len() {
            result.push(path.into());
        }
        for (index, (actual, expected)) in a.iter().zip(e).enumerate() {
            mismatch_paths(actual, expected, &format!("{path}/{index}"), result);
        }
    } else if actual != expected {
        result.push(if path.is_empty() {
            "/".into()
        } else {
            path.into()
        });
    }
}
fn json_kind(value: Option<&Value>) -> &'static str {
    match value {
        None => "missing",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}
fn normalize_contract(
    input: &Value,
    schema: &Value,
    options: &kcoder_tools::CoercionOptions,
    expected: &Value,
) -> (bool, bool, bool) {
    let mut normalized = input.clone();
    kcoder_tools::normalize_tool_input("WorkflowDraft", &mut normalized);
    kcoder_tools::coerce_input_with_options(&mut normalized, schema, options);
    let tool_contract = kcoder_tools::validate_input_against_schema(&normalized, schema).is_ok();
    let mut canonical = normalized.clone();
    for field in ["node", "nodes", "definition", "input_schema"] {
        let text_field = format!("{field}_json");
        if let Some(text) = normalized.get(&text_field) {
            if normalized.get(field).is_some() {
                return (tool_contract, false, false);
            }
            let Some(text) = text.as_str() else {
                return (tool_contract, false, false);
            };
            let Ok(decoded) = serde_json::from_str::<Value>(text) else {
                return (tool_contract, false, false);
            };
            canonical[field] = decoded;
        }
    }
    let scenario_semantics = if let Some(expected_node) = expected.get("node") {
        let mut remaining = expected.clone();
        remaining.as_object_mut().unwrap().remove("node");
        contains_expected(&canonical, &remaining)
            && owned_authoring::node_semantics(&canonical["node"], expected_node)
    } else {
        contains_expected(&canonical, expected)
    };
    (tool_contract, graph_valid(&canonical), scenario_semantics)
}
#[tokio::main]
async fn main() {
    if run().await.is_err() {
        eprintln!(
            "workflow_description_probe_failed: inspect sanitized metrics; no raw provider error retained"
        );
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    ensure!(
        std::env::var("KCODER_E2E_REAL_MODEL").as_deref() == Ok("1"),
        "authorization required"
    );
    let args: Vec<_> = std::env::args().skip(1).collect();
    ensure!(
        args.len() == 5,
        "five owned paths/profile arguments required"
    );
    eprintln!("workflow_probe_stage:loading_isolated_config");
    let settings = SettingsLoader::new(std::env::current_dir()?)
        .with_config_dir(PathBuf::from(&args[0]))
        .with_overlay_files([PathBuf::from(&args[1])])
        .load()?
        .settings;
    eprintln!("workflow_probe_stage:isolated_config_loaded");
    let spec: Value = serde_json::from_slice(&std::fs::read(&args[3])?)?;
    let model = settings
        .providers
        .get(&args[2])
        .context("missing public profile")?
        .default_model
        .clone();
    eprintln!("workflow_probe_stage:building_provider");
    let provider = ProviderFactory::new(&settings).build_named(&args[2], &model)?;
    eprintln!("workflow_probe_stage:provider_built");
    let schema = WorkflowDraftTool.input_schema();
    let validator = jsonschema::validator_for(&schema)?;
    let model_schema = kcoder_tools::inline_local_schema_refs_for_model(
        &kcoder_tools::schema_with_parameter_guidance("WorkflowDraft", &schema),
    );
    let coercion_options = kcoder_tools::CoercionOptions::from(&settings.tools.coerce);
    let old = spec["oldDescription"]
        .as_str()
        .context("missing actual old description")?;
    let new = WorkflowDraftTool.description();
    let fixture =
        owned_authoring::Fixture::create(&std::env::current_dir()?.join("authoring-fixtures"))?;
    let cases: Vec<_> = spec["cases"]
        .as_array()
        .context("cases required")?
        .iter()
        .map(|case| fixture.resolve_case(case))
        .collect();
    ensure!(cases.len() == 6, "exactly six preregistered cases");
    for case in &cases {
        eprintln!(
            "workflow_probe_preflight_case:{}",
            case["id"].as_str().unwrap_or("invalid_id")
        );
        ensure!(
            validator.is_valid(&case["expected"]) && graph_valid(&case["expected"]),
            "preregistered case is invalid"
        );
    }
    eprintln!("workflow_probe_stage:all_cases_validated_before_network");
    let mut rows = Vec::new();
    let clock = Instant::now();
    for (index, case) in cases.iter().enumerate() {
        for variant in if index % 2 == 0 {
            ["old", "new"]
        } else {
            ["new", "old"]
        } {
            let description = if variant == "old" { old } else { &new };
            let request=MessagesRequest::new(&model,vec![Message::user_text(case["prompt"].as_str().context("prompt")?)])
                .with_system("Emit exactly one WorkflowDraft tool call for this authoring request. Do not execute any workflow. Preserve every specified value and current revision. No explanation or follow-up request.")
                .with_tools(vec![ToolDefinition{name:"WorkflowDraft".into(),description:description.into(),input_schema:model_schema.clone()}]).with_max_tokens(1024);
            ensure!(
                request.tools[0].input_schema == model_schema,
                "actual outgoing schema must match Engine rendering"
            );
            let remaining = Duration::from_secs(230)
                .checked_sub(clock.elapsed())
                .context("wall budget expired")?;
            let started = Instant::now();
            let response = tokio::time::timeout(remaining.min(Duration::from_secs(35)), async {
                let mut stream = provider.stream_messages(request)?;
                let mut calls = BTreeMap::<usize, (String, String, Value)>::new();
                let mut usage = Vec::new();
                let mut stopped = false;
                while let Some(event) = stream.next().await {
                    match event? {
                        StreamEvent::ContentBlockStart {
                            index,
                            content_block: ContentBlock::ToolUse { name, input, .. },
                        } => {
                            calls.insert(index, (name, String::new(), input));
                        }
                        StreamEvent::ContentBlockDelta {
                            index,
                            delta: ContentDelta::InputJsonDelta { partial_json },
                        } => {
                            if let Some(call) = calls.get_mut(&index) {
                                call.1.push_str(&partial_json);
                            }
                        }
                        StreamEvent::MessageStart { message } => {
                            if let Some(u) = message.usage {
                                usage.push(u);
                            }
                        }
                        StreamEvent::MessageDelta { delta } => {
                            if let Some(u) = delta.usage {
                                usage.push(u);
                            }
                        }
                        StreamEvent::MessageStop => stopped = true,
                        StreamEvent::Error { .. } => anyhow::bail!("provider protocol error"),
                        _ => {}
                    }
                }
                Ok::<_, anyhow::Error>((calls, usage, stopped))
            })
            .await;
            let row = match response {
                Ok(Ok((calls, usage, stopped))) => {
                    let first = calls.values().next();
                    let parsed = first.and_then(|(_, text, input)| {
                        if text.is_empty() {
                            Some(input.clone())
                        } else {
                            serde_json::from_str::<Value>(text).ok()
                        }
                    });
                    let schema_valid = parsed
                        .as_ref()
                        .is_some_and(|input| validator.is_valid(input));
                    let semantic_valid = parsed.as_ref().is_some_and(|input| {
                        contains_expected(input, &case["expected"])
                            && graph_valid(input)
                            && (case["id"] != "delete_only"
                                || (input.get("nodes").is_none()
                                    && input.get("nodes_json").is_none()))
                    });
                    let correct_tool = first.is_some_and(|(name, _, _)| name == "WorkflowDraft");
                    let (
                        normalized_tool_contract,
                        normalized_node_contract,
                        normalized_scenario_semantics,
                    ) = parsed
                        .as_ref()
                        .map(|input| {
                            normalize_contract(input, &schema, &coercion_options, &case["expected"])
                        })
                        .unwrap_or((false, false, false));
                    let mut normalized = parsed.clone().unwrap_or(Value::Null);
                    kcoder_tools::normalize_tool_input("WorkflowDraft", &mut normalized);
                    kcoder_tools::coerce_input_with_options(
                        &mut normalized,
                        &schema,
                        &coercion_options,
                    );
                    let native_compliance = parsed.as_ref().is_some_and(|input| {
                        ["node", "nodes", "definition", "input_schema"]
                            .iter()
                            .all(|field| {
                                case["expected"].get(*field).is_none()
                                    || (input.get(*field).is_some()
                                        && input.get(format!("{field}_json")).is_none())
                            })
                    });
                    let actual_authoring = if correct_tool
                        && stopped
                        && calls.len() == 1
                        && normalized_tool_contract
                    {
                        fixture
                            .call(index, variant, &normalized, &case["expected"])
                            .await?
                    } else {
                        json!({"invoked":false,"accepted":false,"persistedSemanticsValid":false,"category":"first_call_contract_rejected"})
                    };
                    let schema_errors: Vec<_> = parsed.as_ref().map(|input| validator.iter_errors(input).take(8).map(|error| {
                        let actual = input.pointer(&error.instance_path().to_string()).unwrap_or(input);
                        let actual_type = match actual { Value::Null=>"null", Value::Bool(_)=>"boolean", Value::Number(_)=>"number", Value::String(_)=>"string", Value::Array(_)=>"array", Value::Object(_)=>"object" };
                        let expected_type = match error.kind() {
                            jsonschema::error::ValidationErrorKind::Type{kind}=>match kind { jsonschema::error::TypeKind::Single(kind)=>kind.to_string(), jsonschema::error::TypeKind::Multiple(kinds)=>kinds.into_iter().map(|kind|kind.to_string()).collect::<Vec<_>>().join("|") },
                            _=>"schema_constraint".into()
                        };
                        json!({"path":error.instance_path().to_string(),"actualType":actual_type,"expectedType":expected_type})
                    }).collect()).unwrap_or_else(|| vec![json!({"path":"/$json","actualType":"invalid_json","expectedType":"object"})]);
                    let schema_error_paths: Vec<_> = parsed
                        .as_ref()
                        .map(|input| {
                            validator
                                .iter_errors(input)
                                .take(8)
                                .map(|error| error.instance_path().to_string())
                                .collect()
                        })
                        .unwrap_or_else(|| vec!["/$json".into()]);
                    let mut semantic_error_paths = Vec::new();
                    if let Some(input) = &parsed {
                        mismatch_paths(input, &case["expected"], "", &mut semantic_error_paths);
                    }
                    let semantic_errors: Vec<_>=semantic_error_paths.iter().take(8).map(|path|json!({"path":path,"actualType":json_kind(parsed.as_ref().and_then(|value|value.pointer(path))),"expectedType":json_kind(case["expected"].pointer(path)),"category":"specified_value_or_shape_mismatch"})).collect();
                    json!({"case":case["id"],"variant":variant,"elapsedMs":started.elapsed().as_secs_f64()*1000.,"toolCallCount":calls.len(),"schemaValid":schema_valid,"nativeFieldCompliance":native_compliance,"actualAuthoring":actual_authoring,"normalizedToolContractValid":normalized_tool_contract,"normalizedNodeContractValid":normalized_node_contract,"normalizedScenarioSemanticsValid":normalized_scenario_semantics,"semanticValid":semantic_valid,"schemaErrorPaths":schema_error_paths,"schemaErrors":schema_errors,"parsedArguments":parsed.is_some(),"semanticErrorPaths":semantic_error_paths,"semanticErrors":semantic_errors,"firstLegalCall":correct_tool&&schema_valid&&semantic_valid&&calls.len()==1&&stopped,"streamStopped":stopped,"usageEvents":usage})
                }
                _ => {
                    json!({"case":case["id"],"variant":variant,"elapsedMs":started.elapsed().as_secs_f64()*1000.,"firstLegalCall":false,"error":"provider_request_failed_or_timed_out","usageEvents":[]})
                }
            };
            rows.push(row);
            let report = json!({"provider":args[2],"model":model,"maxOutputTokens":1024,"maxRequests":12,"maxWallSeconds":240,"retryCount":0,"actualOwnedAuthoringMeasured":true,"outgoingEngineRenderedSchema":true,"descriptorSource":"compiled WorkflowDraftTool::description","newDescriptionSha256":format!("{:x}",Sha256::digest(new.as_bytes())),"coercionPolicy":{"semanticBoolean":coercion_options.semantic_boolean,"semanticNumber":coercion_options.semantic_number,"semanticInteger":coercion_options.semantic_integer,"stringifyScalars":coercion_options.stringify_scalars},"modelSchemaSha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&model_schema)?)),"schemaSha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&schema)?)),"oldDescriptionCharacters":old.chars().count(),"newDescriptionCharacters":new.chars().count(),"rows":rows});
            std::fs::write(&args[4], serde_json::to_vec_pretty(&report)?)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn values_remain_typed_and_failure_paths_do_not_echo_payloads() {
        let expected = json!({"number":3,"enabled":true,"nested":[[1,2]],"label":"你好🌍"});
        let actual =
            json!({"number":"3","enabled":true,"nested":[[1,2]],"label":"PRIVATE_RETURNED_VALUE"});
        assert!(!contains_expected(&actual, &expected));
        let mut paths = Vec::new();
        mismatch_paths(&actual, &expected, "", &mut paths);
        assert_eq!(paths, vec!["/label", "/number"]);
        assert!(
            !serde_json::to_string(&paths)
                .unwrap()
                .contains("PRIVATE_RETURNED_VALUE")
        );
    }
    #[test]
    fn actual_host_coercion_and_lossless_channel_have_distinct_metrics() {
        let schema = WorkflowDraftTool.input_schema();
        let expected = json!({"action":"save","id":"audit-draft","expected_revision":7});
        let raw = json!({"action":"save","id":"audit-draft","expected_revision":"7"});
        assert!(!jsonschema::validator_for(&schema).unwrap().is_valid(&raw));
        assert_eq!(
            normalize_contract(
                &raw,
                &schema,
                &kcoder_tools::CoercionOptions::default(),
                &expected
            ),
            (true, true, true)
        );
        assert!(
            !normalize_contract(
                &raw,
                &schema,
                &kcoder_tools::CoercionOptions::strict(),
                &expected
            )
            .0
        );
        let expected = json!({"action":"create","title":"Typed","input_schema":{"type":"object","properties":{"matrix":{"type":"array","default":[[1,2],[3]]}}}});
        let mut raw = expected.clone();
        raw.as_object_mut().unwrap().remove("input_schema");
        raw["input_schema_json"] = json!(expected["input_schema"].to_string());
        assert_eq!(
            normalize_contract(
                &raw,
                &schema,
                &kcoder_tools::CoercionOptions::default(),
                &expected
            ),
            (true, true, true)
        );
    }
    #[test]
    fn numeric_predicate_values_follow_the_real_number_contract_after_coercion() {
        let schema = WorkflowDraftTool.input_schema();
        let expected = json!({"action":"upsert_node","id":"audit-draft","expected_revision":7,"node":{"id":"threshold","title":"Threshold","kind":"condition","config":{"condition":{"op":"greater_than","pointer":"/input/score","value":52}}}});
        let mut raw = expected.clone();
        raw["node"]["config"]["condition"]["value"] = json!("52");
        assert_eq!(
            normalize_contract(
                &raw,
                &schema,
                &kcoder_tools::CoercionOptions::default(),
                &expected
            ),
            (true, true, true)
        );
        raw["node"]["config"]["condition"]["value"] = json!(51);
        assert!(
            !normalize_contract(
                &raw,
                &schema,
                &kcoder_tools::CoercionOptions::default(),
                &expected
            )
            .2
        );
    }
    #[tokio::test]
    async fn canonical_cases_use_real_owned_authoring_and_exact_revisions_without_nodes() {
        let temp = tempfile::tempdir().unwrap();
        let fixture = owned_authoring::Fixture::create(temp.path()).unwrap();
        let cases = vec![
            json!({"action":"create","title":"Typed audit","input_schema":{"type":"object","properties":{"matrix":{"type":"array","items":{"type":"array","items":{"type":"integer"}},"default":[[1,2],[3]]},"label":{"type":"string","default":"你好🌍"},"enabled":{"type":"boolean","default":false}}}}),
            json!({"action":"upsert_node","id":fixture.draft_id,"expected_revision":7,"node":{"id":"compute","title":"Compute","kind":"code","config":{"code":{"source":"const pattern = /\\d+/;\nreturn {label: \"你好\", matched: pattern.test(input.text), count: 3, enabled: true};"}}}}),
            json!({"action":"patch_nodes","id":fixture.draft_id,"expected_revision":7,"remove_node_ids":["obsolete"],"response_detail":"changes"}),
            json!({"action":"save","id":fixture.draft_id,"expected_revision":7,"response_detail":"changes"}),
            json!({"action":"upsert_node","id":fixture.draft_id,"expected_revision":7,"node":{"id":"loop","title":"Loop","kind":"loop","config":{"loop":{"mode":"repeat","maxIterations":3,"body":{"definitionId":fixture.child_id,"version":3},"until":{"op":"greater_than","pointer":"/iteration/output/outputs/0/score","value":52}}}}}),
        ];
        for (index, input) in cases.iter().enumerate() {
            let observed = fixture.call(index, "native", input, input).await.unwrap();
            assert_eq!(observed["accepted"], true, "{observed}");
            assert_eq!(
                observed["persistedSemanticsValid"], true,
                "case {index}: {observed}"
            );
            assert_eq!(observed["childVersionIntact"], true);
            assert_eq!(observed["nodesExecuted"], false);
        }
        let expected = &cases[0];
        let mut alias = expected.clone();
        alias.as_object_mut().unwrap().remove("input_schema");
        alias["input_schema_json"] = json!(expected["input_schema"].to_string());
        assert_eq!(
            fixture.call(6, "alias", &alias, expected).await.unwrap()["persistedSemanticsValid"],
            true
        );
        let mut invalid = expected.clone();
        invalid["input_schema"]["properties"]["enabled"]["default"] = json!("false");
        let observed = fixture
            .call(7, "atomic_failure", &invalid, expected)
            .await
            .unwrap();
        assert_eq!(observed["accepted"], false);
        assert_eq!(observed["failureDraftUnchanged"], true);
    }
    #[tokio::test]
    async fn original_nested_default_is_valid_and_extra_constraints_are_distinct_rejections() {
        let temp = tempfile::tempdir().unwrap();
        let fixture = owned_authoring::Fixture::create(temp.path()).unwrap();
        let expected = json!({"action":"create","title":"Nested audit","input_schema":{"type":"object","properties":{"matrix":{"type":"array","items":{"type":"array","items":{"type":"integer"}},"default":[[1,2],[3]]},"label":{"type":"string","default":"你好🌍"},"enabled":{"type":"boolean","default":false}}}});
        let valid = fixture
            .call(0, "exact_expected", &expected, &expected)
            .await
            .unwrap();
        assert_eq!(valid["accepted"], true);
        assert_eq!(valid["persistedSemanticsValid"], true);
        let mut missing = expected.clone();
        missing["input_schema"]["properties"]["matrix"]
            .as_object_mut()
            .unwrap()
            .remove("default");
        let missing_result = fixture
            .call(1, "missing_default", &missing, &expected)
            .await
            .unwrap();
        assert_eq!(missing_result["accepted"], true);
        assert_eq!(missing_result["persistedSemanticsValid"], false);
        let mut constrained = expected.clone();
        constrained["input_schema"]["properties"]["matrix"]["minItems"] = json!(3);
        let constrained_result = fixture
            .call(2, "extra_constraint", &constrained, &expected)
            .await
            .unwrap();
        assert_eq!(constrained_result["accepted"], false);
        assert_eq!(constrained_result["failureDraftUnchanged"], true);
        assert_eq!(constrained_result["failureLibraryBytesUnchanged"], true);
        let schema = &constrained["input_schema"]["properties"]["matrix"];
        let validator = jsonschema::validator_for(schema).unwrap();
        let errors: Vec<_>=validator.iter_errors(&schema["default"]).map(|error|json!({"schemaKeywordPath":error.schema_path().to_string(),"instancePath":error.instance_path().to_string(),"actualType":"array","expectedConstraint":"minItems=3","actualCount":2})).collect();
        assert_eq!(errors[0]["schemaKeywordPath"], "/minItems");
        let report = json!({"scope":"no-LLM original synthetic expected and controlled contrasts; not a replay of unavailable model schemas","expected":expected["input_schema"],"exactExpected":valid,"missingMatrixDefault":missing_result,"controlledExtraMinItems":constrained_result,"controlledKeywordDiagnostics":errors,"realModelExtraConstraints":"unknown; exact returned schemas were not retained in the 12-call batch"});
        if let Some(output) = std::env::var_os("KCODER_NESTED_DEFAULT_DIAGNOSTIC_OUTPUT") {
            std::fs::write(output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        }
    }
    #[test]
    fn native_code_and_schema_samples_are_statically_legal_without_execution() {
        assert!(graph_valid(
            &json!({"action":"upsert_node","node":{"id":"compute","title":"Compute","kind":"code","config":{"code":{"source":"const p = /\\d+/;\nreturn {label: \"你好\", enabled: true};"}}}})
        ));
        assert!(graph_valid(
            &json!({"action":"create","input_schema":{"type":"object","properties":{"n":{"type":"integer","default":3}}}})
        ));
    }
}
