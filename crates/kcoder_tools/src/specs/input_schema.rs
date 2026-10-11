//! Spec input schema adapter behavior; domain operations remain in kcoder_specs.

use super::*;

pub(super) fn default_include_specs() -> bool {
    true
}

pub(super) fn default_spec_show_max_bytes() -> usize {
    65_536
}

pub(super) fn default_review_turns() -> usize {
    30
}

pub(super) fn schema_with_agent_turn_bounds<T: JsonSchema>() -> Value {
    let mut schema = clean_schema(schemars::schema_for!(T));
    if let Value::Object(ref mut map) = schema
        && let Some(Value::Object(props)) = map.get_mut("properties")
    {
        props.insert(
            "max_turns".to_string(),
            serde_json::json!({
                "type": "integer",
                "minimum": MIN_AGENT_MAX_TURNS,
                "maximum": MAX_AGENT_MAX_TURNS,
                "description": format!(
                    "Maximum number of turns per subagent. Defaults to {}, min {}, max {}.",
                    default_review_turns(),
                    MIN_AGENT_MAX_TURNS,
                    MAX_AGENT_MAX_TURNS
                )
            }),
        );
    }
    schema
}
