pub use kcoder_tool_input::{
    clean_schema, coerce_input, coerce_input_with_options, description_with_input_shape,
    example_input_for_schema, inline_local_schema_refs_for_model, normalize_tool_input,
    parse_input, schema_with_parameter_guidance, validate_input_against_schema,
};

#[cfg(test)]
mod tests {
    use serde_json::Value;

    #[test]
    fn workflow_named_arguments_are_objects_in_model_facing_schema() {
        use crate::Tool;
        let raw = crate::workflow_draft::WorkflowDraftTool.input_schema();
        let schema = super::schema_with_parameter_guidance("WorkflowDraft", &raw);
        for name in ["WorkflowSubworkflowConfig", "WorkflowToolConfig"] {
            let arguments = &schema["definitions"][name]["properties"]["arguments"];
            assert_eq!(arguments["type"], "object", "{name}: {arguments}");
            let description = arguments["description"].as_str().unwrap();
            assert!(
                !description.contains("Must be a JSON array"),
                "{description}"
            );
        }
    }

    #[test]
    fn examples_omit_optional_values_and_honor_supported_bounds() {
        let required_strings = serde_json::json!({"type":"object","properties":{
            "description":{"type":"string"},"pattern":{"type":"string"},"pages":{"type":"string"}
        },"required":["description","pattern","pages"]});
        let example = super::example_input_for_schema(&required_strings).unwrap();
        assert_eq!(example["description"], "Describe the operation");
        assert_eq!(example["pattern"], "README");
        assert_eq!(example["pages"], "1-5");
        let schema = serde_json::json!({"type":"object","properties":{
            "max_turns":{"type":"integer","minimum":60,"maximum":180},
            "context_turns":{"type":"integer","minimum":1},
            "items":{"type":"array","minItems":2,"maxItems":3,"items":{"type":"integer","minimum":5}}
        },"required":["context_turns","items"]});
        let example = super::example_input_for_schema(&schema).unwrap();
        assert!(example.get("max_turns").is_none());
        assert_eq!(example["context_turns"], 1);
        assert_eq!(example["items"], serde_json::json!([5, 5]));
        assert_eq!(
            super::example_input_for_schema(
                &serde_json::json!({"type":"integer","minimum":60,"maximum":180})
            ),
            Some(serde_json::json!(60))
        );
        assert!(
            super::example_input_for_schema(&serde_json::json!({"type":"string","pattern":"^x$"}))
                .is_none()
        );
        let schema = serde_json::json!({"type":"object","properties":{"next":{"$ref":"#/definitions/node"}},"required":["next"],"definitions":{"node":{"type":"object","properties":{"next":{"$ref":"#/definitions/node"}},"required":["next"]}}});
        assert!(super::example_input_for_schema(&schema).is_none());
        use crate::Tool;
        let question =
            super::example_input_for_schema(&crate::AskUserQuestionTool.input_schema()).unwrap();
        assert_eq!(
            question["questions"][0]["options"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(question["questions"][0]["options"][1]["label"], "Option B");
    }

    #[test]
    fn compatibility_aliases_normalize_without_type_coercion() {
        let mut grep = serde_json::json!({"pattern":"needle", "-C":2});
        super::normalize_tool_input("grep", &mut grep);
        assert_eq!(grep, serde_json::json!({"pattern":"needle", "context":2}));
        let mut equal = serde_json::json!({"context":2,"-C":2});
        super::normalize_tool_input("grep", &mut equal);
        assert_eq!(equal, serde_json::json!({"context":2}));
        let mut conflict = serde_json::json!({"context":2,"-C":3});
        let original = conflict.clone();
        super::normalize_tool_input("grep", &mut conflict);
        assert_eq!(conflict, original);
        let mut string = serde_json::json!({"-C":"2"});
        super::normalize_tool_input("grep", &mut string);
        assert_eq!(string, serde_json::json!({"context":"2"}));
        let mut browser = serde_json::json!({"action":"screenshot","url":"https://example.com"});
        super::normalize_tool_input("WebBrowser", &mut browser);
        assert_eq!(browser["action"], "snapshot");
        let mut other_tool = original.clone();
        super::normalize_tool_input("other", &mut other_tool);
        assert_eq!(other_tool, original);
        use crate::Tool;
        let grep_schema = crate::GrepTool.input_schema();
        assert!(super::validate_input_against_schema(&grep, &grep_schema).is_ok());
        assert!(super::validate_input_against_schema(&conflict, &grep_schema).is_err());
        assert!(super::validate_input_against_schema(&string, &grep_schema).is_err());
        assert!(
            super::validate_input_against_schema(&browser, &crate::WebBrowserTool.input_schema())
                .is_ok()
        );
    }

    #[test]
    fn guidance_preserves_all_validation_keywords_and_nested_semantics() {
        fn without_descriptions(value: &mut serde_json::Value) {
            match value {
                serde_json::Value::Object(map) => {
                    map.remove("description");
                    for child in map.values_mut() {
                        without_descriptions(child);
                    }
                }
                serde_json::Value::Array(values) => {
                    for child in values {
                        without_descriptions(child);
                    }
                }
                _ => {}
            }
        }
        for tool in crate::default_registry().all() {
            let mut original = tool.input_schema();
            let mut enriched = super::schema_with_parameter_guidance(&tool.name(), &original);
            assert_eq!(
                enriched.to_string().matches("numeric-key object").count(),
                original.to_string().matches("numeric-key object").count(),
                "{} repeats generic array guidance",
                tool.name()
            );
            without_descriptions(&mut original);
            without_descriptions(&mut enriched);
            assert_eq!(
                original,
                enriched,
                "{} changed validation contract",
                tool.name()
            );
        }
    }

    use super::*;

    #[test]
    fn full_registry_object_schemas_always_declare_properties() {
        let mut missing = Vec::new();
        for tool in crate::default_registry().all() {
            let schema = tool.input_schema();
            if schema.get("type").and_then(Value::as_str) == Some("object")
                && schema.get("properties").is_none()
            {
                missing.push(tool.name());
            }
        }
        assert!(missing.is_empty(), "tools missing properties: {missing:?}");
    }
}

#[cfg(test)]
mod bounded_reference_expansion_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn full_registry_reference_expansion_has_a_bounded_cost() {
        let mut sizes = Vec::new();
        for tool in crate::default_registry().all() {
            let schema = schema_with_parameter_guidance(&tool.name(), &tool.input_schema());
            let source = serde_json::to_vec(&schema).unwrap().len();
            let rendered = serde_json::to_vec(&inline_local_schema_refs_for_model(&schema))
                .unwrap()
                .len();
            assert!(
                rendered <= source + 4096,
                "{} expands from {} to {}",
                tool.name(),
                source,
                rendered
            );
            sizes.push((rendered + tool.description().len(), source, tool.name()));
        }
        sizes.sort_by_key(|b| std::cmp::Reverse(b.0));
        eprintln!(
            "all static tools bytes={} largest={:?}",
            sizes.iter().map(|item| item.0).sum::<usize>(),
            &sizes[..sizes.len().min(15)]
        );
    }

    #[test]
    fn actual_rich_workflow_tool_schema_stays_small_for_the_model() {
        let raw = <crate::workflow_draft::WorkflowDraftTool as crate::Tool>::input_schema(
            &crate::workflow_draft::WorkflowDraftTool,
        );
        let rendered = inline_local_schema_refs_for_model(&raw);
        let raw_bytes = serde_json::to_vec(&raw).unwrap().len();
        let model_bytes = serde_json::to_vec(&rendered).unwrap().len();
        eprintln!("WorkflowDraft schema bytes raw={raw_bytes} model={model_bytes}");
        assert!(model_bytes <= raw_bytes + 4096, "{model_bytes}");
        assert!(rendered["properties"]["node"].is_object());
    }
}

#[cfg(test)]
mod workflow_nested_regressions {
    use super::*;
    use crate::Tool;
    use serde_json::json;
    #[test]
    fn tagged_transform_parameters_are_coerced_using_the_selected_operation() {
        let schema = crate::workflow_draft::WorkflowDraftTool.input_schema();
        let mut input = json!({"action":"upsert_node","id":"flow","expected_revision":1,"node":{
            "id":"transform","title":"Transform","kind":"transform","config":{"transform":{
                "sourcePointer":"/input/items","steps":[{"op":"limit","count":"20"},{"op":"sort","pointer":"/price","descending":"true"}]
            }}
        }});
        coerce_input(&mut input, &schema);
        assert_eq!(
            input["node"]["config"]["transform"]["steps"][0]["count"],
            20
        );
        assert_eq!(
            input["node"]["config"]["transform"]["steps"][1]["descending"],
            true
        );
    }
    #[test]
    fn multiline_valid_workflow_json_preserves_nested_types_and_freeform_data() {
        let schema = crate::workflow_draft::WorkflowDraftTool.input_schema();
        let original = json!({"action":"update","id":"flow","title":"Typed defaults","expected_revision":1,
            "input_schema":{"type":"object","properties":{"days":{"type":"integer","default":3},"flag":{"type":"boolean","default":true},"items":{"type":"array","default":[1,2]}}}});
        for serialized in [
            serde_json::to_string(&original).unwrap(),
            serde_json::to_string_pretty(&original).unwrap(),
        ] {
            let mut input = serde_json::from_str(&serialized).unwrap();
            coerce_input(&mut input, &schema);
            assert_eq!(input, original);
        }
    }
}

#[cfg(test)]
mod type_array_regressions {
    use super::*;
    use crate::Tool;
    use serde_json::json;
    #[test]
    fn workflow_input_schema_boolean_is_accepted_and_preserved() {
        let schema = crate::workflow_draft::WorkflowDraftTool.input_schema();
        for value in [json!(true), json!(false)] {
            let mut input = json!({"action":"update","id":"flow","title":"Flow","expected_revision":1,"input_schema":value});
            let original = input.clone();
            coerce_input(&mut input, &schema);
            assert_eq!(input, original);
            validate_input_against_schema(&input, &schema).unwrap();
        }
    }
}

#[cfg(test)]
mod nested_wrapper_regressions {
    use super::*;
    use crate::Tool;
    use serde_json::json;
    #[test]
    fn nested_transport_wrappers_are_unwrapped_only_at_declared_array_boundaries() {
        let schema = crate::workflow_draft::WorkflowDraftTool.input_schema();
        let mut input = json!({"action":"upsert_node","id":"flow","expected_revision":1,"node":{"id":"t","kind":"transform","config":{"transform":{"sourcePointer":"/input/items","steps":{"item":{"item":[{"op":"limit","count":"20"},{"op":"sort","pointer":"/price","descending":"true"}]}}}}}});
        coerce_input(&mut input, &schema);
        assert_eq!(
            input["node"]["config"]["transform"]["steps"],
            json!([{"op":"limit","count":20},{"op":"sort","pointer":"/price","descending":true}])
        );
        let schema = json!({"type":"array","items":{"type":"object","properties":{"item":{"type":"array"}},"required":["item"]}});
        let mut input = json!({"item":{"item":[1,2]}});
        coerce_input(&mut input, &schema);
        assert_eq!(input, json!([{"item":[1,2]}]));
    }
}
