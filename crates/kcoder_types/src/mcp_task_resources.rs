//! Explicit native configuration for reviewed resource-read tool semantics.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The actual tool schema and complete input shape are pinned by the owner.
/// Only the URI slot varies; an extra operation/write/send field is rejected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct McpTaskResourceReadRule {
    pub schema_sha256: String,
    pub uri_input_pointer: String,
    pub input_template: Value,
}
impl McpTaskResourceReadRule {
    pub fn resource_uri<'a>(
        &self,
        actual_schema_sha256: &str,
        input: &'a Value,
    ) -> Option<&'a str> {
        if self.schema_sha256.len() != 64
            || !self
                .schema_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || self.schema_sha256 != actual_schema_sha256
            || !self.uri_input_pointer.starts_with('/')
            || self.uri_input_pointer.len() > 512
            || !self.input_template.is_object()
            || !self
                .input_template
                .pointer(&self.uri_input_pointer)
                .is_some_and(Value::is_null)
        {
            return None;
        }
        let uri = input.pointer(&self.uri_input_pointer)?.as_str()?;
        if uri.is_empty() || uri.len() > 4096 {
            return None;
        }
        let mut shaped = input.clone();
        *shaped.pointer_mut(&self.uri_input_pointer)? = Value::Null;
        (shaped == self.input_template).then_some(uri)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn reviewed_read_shape_cannot_add_send_mode_or_change_schema() {
        let rule = McpTaskResourceReadRule {
            schema_sha256: "a".repeat(64),
            uri_input_pointer: "/uri".into(),
            input_template: json!({"uri":null,"operation":"read"}),
        };
        assert_eq!(
            rule.resource_uri(
                &"a".repeat(64),
                &json!({"uri":"resource://one","operation":"read"})
            ),
            Some("resource://one")
        );
        assert!(
            rule.resource_uri(
                &"b".repeat(64),
                &json!({"uri":"resource://one","operation":"read"})
            )
            .is_none()
        );
        assert!(
            rule.resource_uri(
                &"a".repeat(64),
                &json!({"uri":"resource://one","operation":"write"})
            )
            .is_none()
        );
        assert!(
            rule.resource_uri(
                &"a".repeat(64),
                &json!({"uri":"resource://one","operation":"read","send":true})
            )
            .is_none()
        );
        assert!(
            rule.resource_uri(
                &"a".repeat(64),
                &json!({"uri":["resource://one"],"operation":"read"})
            )
            .is_none()
        );
    }
}
