//! Borrowed final-body serialization with narrowly scoped tool property ordering.
use serde::{
    Serialize, Serializer,
    ser::{SerializeMap, SerializeSeq},
};
use serde_json::Value;

#[derive(Clone, Copy)]
pub(super) enum Format {
    Anthropic,
    Chat,
    Responses,
    Gemini,
}

#[derive(Clone, Copy)]
enum Position {
    Root(Format),
    Tools(Format),
    Tool(Format),
    Declarations,
    Function,
    Schema,
    Properties,
    Plain,
}

pub(super) fn serialize(
    payload: &Value,
    enabled: bool,
    format: Format,
) -> serde_json::Result<String> {
    if !enabled {
        return serde_json::to_string(payload);
    }
    serde_json::to_string(&Ordered {
        value: payload,
        position: Position::Root(format),
    })
}

struct Ordered<'a> {
    value: &'a Value,
    position: Position,
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use kcoder_types::{Message, MessagesRequest, ToolDefinition};

    pub(in crate::providers) fn assert_final_body(build: impl Fn(MessagesRequest) -> String) {
        let nested = serde_json::json!({"type":"object","properties":{"content":{"const":"nested"},"file_path":{"type":"string"}}});
        let schema = serde_json::json!({"type":"object","properties":{
            "content":{"type":"string"}, "file_path":{"type":"string"},
            "new_string":{"type":"string"}, "nested":nested
        },"required":["new_string","content","file_path"],"examples":[{"content":"example","file_path":r"C:\project\file.rs"},{"content":"UNC example","file_path":r"\\server\share\file.rs"}]});
        let request = MessagesRequest::new(
            "model",
            vec![Message::user_text("content file_path unchanged")],
        )
        .with_tools(
            ["write", "edit", "other", "Write"]
                .into_iter()
                .map(|name| ToolDefinition {
                    name: name.into(),
                    description: "file_path content".into(),
                    input_schema: schema.clone(),
                })
                .collect(),
        );
        assert!(!request.path_first_tools);
        let disabled = build(request.clone());
        let enabled = build(request.with_path_first_tools(true));
        let original: Value = serde_json::from_str(&disabled).unwrap();
        assert_eq!(disabled, serde_json::to_string(&original).unwrap());
        assert_eq!(original, serde_json::from_str::<Value>(&enabled).unwrap());
        assert_eq!(
            enabled.matches("\"properties\":{\"file_path\":").count(),
            2,
            "{enabled}"
        );
        assert!(
            enabled.contains("\"properties\":{\"file_path\":{\"type\":\"string\"},\"content\":")
        );
        assert_eq!(
            enabled
                .matches(&serde_json::to_string(&nested).unwrap())
                .count(),
            4
        );
        assert_eq!(
            enabled
                .matches("\"required\":[\"new_string\",\"content\",\"file_path\"]")
                .count(),
            4
        );
        assert!(!enabled.contains("path_first_tools"));
        assert!(!disabled.contains("path_first_tools"));
    }

    #[test]
    fn path_first_wire_only_exact_descriptor_positions() {
        let schema = serde_json::json!({"properties":{"content":{},"file_path":{}}});
        for (format, tools) in [
            (
                Format::Anthropic,
                serde_json::json!([{"name":"write","type":"custom","input_schema":schema}]),
            ),
            (
                Format::Chat,
                serde_json::json!([{"type":"custom","function":{"name":"write","parameters":schema}},{"type":"function","function":{"name":"other","parameters":schema}}]),
            ),
            (
                Format::Responses,
                serde_json::json!([{"type":"custom","name":"write","parameters":schema},{"type":"function","name":"other","parameters":schema}]),
            ),
        ] {
            let payload = serde_json::json!({"tools":tools,"messages":[{"tools":[{"name":"write","input_schema":schema}]}],"example":{"name":"write","parameters":schema}});
            assert_eq!(
                serialize(&payload, true, format).unwrap(),
                serde_json::to_string(&payload).unwrap()
            );
            assert_eq!(
                serialize(&payload, false, format).unwrap(),
                serde_json::to_string(&payload).unwrap()
            );
        }
    }
}

impl Serialize for Ordered<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if let (Position::Declarations, Value::Array(declarations)) = (self.position, self.value) {
            let mut seq = serializer.serialize_seq(Some(declarations.len()))?;
            for declaration in declarations {
                seq.serialize_element(&Ordered {
                    value: declaration,
                    position: Position::Function,
                })?;
            }
            return seq.end();
        }
        if let (Position::Tools(format), Value::Array(tools)) = (self.position, self.value) {
            let mut seq = serializer.serialize_seq(Some(tools.len()))?;
            for tool in tools {
                seq.serialize_element(&Ordered {
                    value: tool,
                    position: Position::Tool(format),
                })?;
            }
            return seq.end();
        }
        if matches!(self.position, Position::Plain) {
            return self.value.serialize(serializer);
        }
        let Value::Object(map) = self.value else {
            return self.value.serialize(serializer);
        };
        let mut output = serializer.serialize_map(Some(map.len()))?;
        let path_first = matches!(self.position, Position::Properties);
        if path_first && let Some(path) = map.get("file_path") {
            output.serialize_entry("file_path", path)?;
        }
        let named_tool = matches!(
            map.get("name").and_then(Value::as_str),
            Some("write" | "edit")
        );
        let function_tool = map.get("type").and_then(Value::as_str) == Some("function");
        for (key, value) in map {
            if path_first && key == "file_path" {
                continue;
            }
            let position = match (self.position, key.as_str()) {
                (Position::Root(format), "tools") => Position::Tools(format),
                (Position::Tool(Format::Anthropic), "input_schema")
                    if named_tool && !map.contains_key("type") =>
                {
                    Position::Schema
                }
                (Position::Tool(Format::Chat), "function") if function_tool => Position::Function,
                (Position::Tool(Format::Gemini), "functionDeclarations") => Position::Declarations,
                (Position::Tool(Format::Responses), "parameters")
                    if function_tool && named_tool =>
                {
                    Position::Schema
                }
                (Position::Function, "parameters") if named_tool => Position::Schema,
                (Position::Schema, "properties") => Position::Properties,
                _ => Position::Plain,
            };
            output.serialize_entry(key, &Ordered { value, position })?;
        }
        output.end()
    }
}
