//! Reviewed application semantics pin a schema and a finite complete input shape.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum McpApplicationAction {
    #[serde(rename = "document.read")]
    DocumentRead,
    #[serde(rename = "document.create")]
    DocumentCreate,
    #[serde(rename = "document.lookup")]
    DocumentLookup,
    #[serde(rename = "mail.list")]
    MailList,
    #[serde(rename = "mail.read")]
    MailRead,
    #[serde(rename = "mail.attachment")]
    MailAttachment,
    #[serde(rename = "mail.send")]
    MailSend,
    #[serde(rename = "mail.lookup")]
    MailLookup,
    #[serde(rename = "table.query")]
    TableQuery,
    #[serde(rename = "table.export")]
    TableExport,
    #[serde(rename = "table.lookup")]
    TableLookup,
}
impl McpApplicationAction {
    pub fn is_effect(self) -> bool {
        matches!(
            self,
            Self::DocumentCreate | Self::MailSend | Self::TableExport
        )
    }
    /// A lookup observes a real platform object by its original idempotency key.
    pub fn reconciles_effect(self) -> Option<Self> {
        match self {
            Self::DocumentLookup => Some(Self::DocumentCreate),
            Self::MailLookup => Some(Self::MailSend),
            Self::TableLookup => Some(Self::TableExport),
            _ => None,
        }
    }
    pub fn requires_operation_id(self) -> bool {
        self.is_effect() || self.reconciles_effect().is_some()
    }
    pub fn permits_task(self, task: &str) -> bool {
        match self {
            Self::DocumentRead => matches!(
                task,
                "document.read" | "document.create" | "document.summarize" | "document.compare"
            ),
            Self::DocumentCreate | Self::DocumentLookup => task == "document.create",
            Self::MailList | Self::MailRead | Self::MailAttachment => matches!(
                task,
                "mail.list"
                    | "mail.read"
                    | "mail.attachment"
                    | "mail.send"
                    | "mail.summarize"
                    | "mail.draft"
            ),
            Self::MailSend | Self::MailLookup => task == "mail.send",
            Self::TableQuery => matches!(task, "table.query" | "table.export" | "table.analyze"),
            Self::TableExport | Self::TableLookup => task == "table.export",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum McpApplicationInputField {
    String {
        max_bytes: usize,
        #[serde(default)]
        allowed_values: Vec<String>,
    },
    Integer {
        minimum: i64,
        maximum: i64,
    },
}
impl McpApplicationInputField {
    fn matches(&self, value: &Value) -> bool {
        match self {
            Self::String {
                max_bytes,
                allowed_values,
            } => value.as_str().is_some_and(|text| {
                (1..=65536).contains(max_bytes)
                    && !text.is_empty()
                    && text.len() <= *max_bytes
                    && allowed_values.len() <= 100
                    && (allowed_values.is_empty() || allowed_values.iter().any(|item| item == text))
            }),
            Self::Integer { minimum, maximum } => value.as_i64().is_some_and(|number| {
                minimum <= maximum && number >= *minimum && number <= *maximum
            }),
        }
    }
}
/// Only local reviewed configuration supplies this rule; server annotations cannot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct McpApplicationActionRule {
    pub action: McpApplicationAction,
    pub schema_sha256: String,
    pub resource_uri_input_pointer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id_input_pointer: Option<String>,
    pub input_template: Value,
    #[serde(default)]
    pub fields: BTreeMap<String, McpApplicationInputField>,
}
impl McpApplicationActionRule {
    /// Validate final arguments after normal Hooks and ToolApproval.
    pub fn resource_uri<'a>(
        &self,
        schema: &str,
        task: &str,
        operation: &str,
        input: &'a Value,
    ) -> Option<&'a str> {
        if self.schema_sha256.len() != 64
            || !self.schema_sha256.bytes().all(|b| b.is_ascii_hexdigit())
            || self.schema_sha256 != schema
            || !self.action.permits_task(task)
            || !self.input_template.is_object()
            || self.fields.len() > 16
            || self.action.requires_operation_id() != self.operation_id_input_pointer.is_some()
            || serde_json::to_vec(input).ok()?.len() > 65536
        {
            return None;
        }
        let mut shape = input.clone();
        let mut seen = BTreeSet::new();
        let mut clear = |pointer: &str| -> Option<()> {
            if !pointer.starts_with('/')
                || pointer.len() > 512
                || !seen.insert(pointer.to_string())
                || !self
                    .input_template
                    .pointer(pointer)
                    .is_some_and(Value::is_null)
            {
                return None;
            }
            *shape.pointer_mut(pointer)? = Value::Null;
            Some(())
        };
        let uri = input.pointer(&self.resource_uri_input_pointer)?.as_str()?;
        if uri.is_empty() || uri.len() > 4096 || uri.chars().any(char::is_control) {
            return None;
        }
        clear(&self.resource_uri_input_pointer)?;
        if let Some(pointer) = &self.operation_id_input_pointer {
            if operation.is_empty() || input.pointer(pointer)?.as_str()? != operation {
                return None;
            }
            clear(pointer)?;
        }
        for (pointer, field) in &self.fields {
            if !field.matches(input.pointer(pointer)?) {
                return None;
            }
            clear(pointer)?;
        }
        (shape == self.input_template).then_some(uri)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn exact_business_shape_binds_schema_operation_and_target() {
        let rule: McpApplicationActionRule = serde_json::from_value(json!({
            "action":"mail.send","schema_sha256":"a".repeat(64),"resource_uri_input_pointer":"/uri",
            "operation_id_input_pointer":"/operationId","input_template":{"uri":null,"operationId":null,"to":null,"body":null},
            "fields":{"/to":{"type":"string","max_bytes":100,"allowed_values":["owned@example.invalid"]},"/body":{"type":"string","max_bytes":128}}
        })).unwrap();
        let input = json!({"uri":"owned://mail","operationId":"original","to":"owned@example.invalid","body":"Exact approved body"});
        assert_eq!(
            rule.resource_uri(&"a".repeat(64), "mail.send", "original", &input),
            Some("owned://mail")
        );
        for (key, value) in [
            ("operationId", json!("other")),
            ("to", json!("other@example.invalid")),
            ("body", json!({"arbitrary":"JSON"})),
            ("extra", json!(true)),
        ] {
            let mut changed = input.clone();
            changed[key] = value;
            assert!(
                rule.resource_uri(&"a".repeat(64), "mail.send", "original", &changed)
                    .is_none()
            );
        }
        assert!(
            rule.resource_uri(&"b".repeat(64), "mail.send", "original", &input)
                .is_none()
        );
        assert!(
            rule.resource_uri(&"a".repeat(64), "mail.draft", "original", &input)
                .is_none()
        );
        let mut duplicate = rule;
        duplicate.fields.insert(
            "/uri".into(),
            McpApplicationInputField::String {
                max_bytes: 100,
                allowed_values: vec![],
            },
        );
        assert!(
            duplicate
                .resource_uri(&"a".repeat(64), "mail.send", "original", &input)
                .is_none()
        );
    }
    #[test]
    fn original_lookups_are_non_effects_but_require_the_exact_original_operation() {
        for (action, task) in [
            (McpApplicationAction::DocumentLookup, "document.create"),
            (McpApplicationAction::MailLookup, "mail.send"),
            (McpApplicationAction::TableLookup, "table.export"),
        ] {
            let mut rule: McpApplicationActionRule = serde_json::from_value(json!({"action":"document.lookup","schema_sha256":"a".repeat(64),"resource_uri_input_pointer":"/uri","operation_id_input_pointer":"/operationId","input_template":{"uri":null,"operationId":null}})).unwrap();
            rule.action = action;
            let input = json!({"uri":"owned://selected","operationId":"original"});
            assert!(!action.is_effect());
            assert!(action.reconciles_effect().unwrap().is_effect());
            assert!(
                rule.resource_uri(&"a".repeat(64), task, "original", &input)
                    .is_some()
            );
            assert!(
                rule.resource_uri(&"a".repeat(64), task, "changed", &input)
                    .is_none()
            );
            assert!(
                rule.resource_uri(&"a".repeat(64), "document.summarize", "original", &input)
                    .is_none()
            );
            rule.operation_id_input_pointer = None;
            assert!(
                rule.resource_uri(&"a".repeat(64), task, "original", &input)
                    .is_none()
            );
        }
    }
    #[test]
    fn bounded_queries_do_not_gain_export_or_arbitrary_json_semantics() {
        let rule:McpApplicationActionRule=serde_json::from_value(json!({"action":"table.query","schema_sha256":"a".repeat(64),"resource_uri_input_pointer":"/uri","input_template":{"uri":null,"limit":null},"fields":{"/limit":{"type":"integer","minimum":1,"maximum":10}}})).unwrap();
        assert!(
            rule.resource_uri(
                &"a".repeat(64),
                "table.export",
                "op",
                &json!({"uri":"owned://table","limit":10})
            )
            .is_some()
        );
        assert!(
            rule.resource_uri(
                &"a".repeat(64),
                "table.export",
                "op",
                &json!({"uri":"owned://table","limit":11})
            )
            .is_none()
        );
        let mut effect = rule;
        effect.action = McpApplicationAction::TableExport;
        assert!(
            effect
                .resource_uri(
                    &"a".repeat(64),
                    "table.export",
                    "op",
                    &json!({"uri":"owned://table","limit":1})
                )
                .is_none()
        );
    }
}
