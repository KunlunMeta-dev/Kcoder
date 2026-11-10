//! Recognize only real direct OfficeDocument or the strict deferred envelope.
use kcoder_tools::tool_execute::ToolExecuteInput;
use serde_json::{Value, json};

pub(super) enum OfficeHistoryCall<'a> {
    Direct(&'a Value),
    Deferred(&'a Value),
}
impl<'a> OfficeHistoryCall<'a> {
    pub(super) fn parse(name: &str, input: &'a Value) -> Option<Self> {
        match name {
            "OfficeDocument" => Some(Self::Direct(input)),
            "tool_execute" => {
                if input.get("tool_name").and_then(Value::as_str) != Some("OfficeDocument") {
                    return None;
                }
                // Decode the shipped typed schema so aliases, unknown fields and
                // guessed wrapper formats cannot become a Native receipt claim.
                let wrapper: ToolExecuteInput = serde_json::from_value(input.clone()).ok()?;
                if wrapper.tool_name != "OfficeDocument" {
                    return None;
                }
                Some(Self::Deferred(input.get("arguments")?))
            }
            _ => None,
        }
    }
    pub(super) fn arguments(&self) -> &Value {
        match self {
            Self::Direct(input) | Self::Deferred(input) => input,
        }
    }
    pub(super) fn project(&self, reference: Value) -> Value {
        match self {
            Self::Direct(_) => reference,
            Self::Deferred(_) => json!({"tool_name":"OfficeDocument","arguments":reference}),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_real_envelope_preserves_the_outer_route_and_exact_inner_input() {
        let args = json!({"specification":{"schemaVersion":1,"kind":"docx","paragraphs":[{"text":"literal data"}]},"sourceRefs":[]});
        let wrapper = json!({"tool_name":"OfficeDocument","arguments":args});
        let call = OfficeHistoryCall::parse("tool_execute", &wrapper).unwrap();
        assert_eq!(call.arguments(), &args);
        let reference = json!({"_storedOfficeGenerationSource":{"id":"receipt-r1"}});
        assert_eq!(
            call.project(reference.clone()),
            json!({"tool_name":"OfficeDocument","arguments":reference})
        );
        assert_eq!(wrapper["arguments"], args);
    }
    #[test]
    fn unknown_routes_tools_aliases_or_extra_fields_do_not_get_native_projection() {
        for input in [
            json!({"toolName":"OfficeDocument","arguments":{}}),
            json!({"tool_name":"OfficeDocument","arguments":{},"nativeAuthority":true}),
            json!({"tool_name":"tool_execute","arguments":{"tool_name":"OfficeDocument","arguments":{}}}),
            json!({"tool_name":"other","arguments":{}}),
            json!({"tool_name":"OfficeDocument"}),
        ] {
            assert!(OfficeHistoryCall::parse("tool_execute", &input).is_none());
        }
        assert!(
            OfficeHistoryCall::parse(
                "json-marker",
                &json!({"tool_name":"OfficeDocument","arguments":{}})
            )
            .is_none()
        );
    }
}
