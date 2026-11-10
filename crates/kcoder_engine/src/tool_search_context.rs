//! Plain-message tool documentation and visibility-based deduplication.
use super::*;
use sha2::{Digest, Sha256};

pub(super) fn context_fingerprint(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub(super) const DISCOVERY_HEADER: &str = "# Discovered tools\n<!--kcoder:tool-discovery-v2-->\n";
const RECORD: &str = "<!--kcoder:tool-definition ";

pub(super) fn schema_hash(schema: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(schema).expect("JSON schema serializes"))
    )
}

pub(super) fn definition_version(name: &str, source: &str, schema: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(name, source, schema)).expect("definition identity serializes")
        )
    )
}

pub(super) fn definition_markdown(
    name: &str,
    description: &str,
    schema: &Value,
    version: &str,
    direct: bool,
) -> String {
    let metadata =
        serde_json::json!({"name":name,"version":version,"schema_hash":schema_hash(schema)});
    let description = description.replace('<', "&lt;").replace('>', "&gt;");
    let title = name.replace('`', "\\`");
    let route = if direct {
        "Call this already-attached tool directly."
    } else {
        "Call `tool_execute` with this exact `tool_name` and `arguments` matching the JSON Schema below."
    };
    format!(
        "\n## `{title}`\n\n{description}\n\n{route}\n\n{RECORD}{metadata}-->\n```json\n{}\n```\n",
        // Compact JSON preserves every schema value and its existing hash while
        // avoiding whitespace-only context charges in ordinary discovery data.
        serde_json::to_string(schema).expect("JSON schema serializes")
    )
}

pub(super) fn is_discovery_context(text: &str) -> bool {
    text.starts_with(DISCOVERY_HEADER)
        || serde_json::from_str::<Value>(text)
            .ok()
            .is_some_and(|value| value["kind"] == "deferred_tool_definitions")
}

/// Only complete runtime-authored definitions still in model context suppress repeats.
pub(super) fn visible_definitions(
    messages: &kcoder_types::SharedMessages,
) -> HashMap<String, String> {
    let mut found = HashMap::new();
    for message in messages {
        let Message::User {
            origin: kcoder_types::MessageOrigin::Runtime,
            content,
        } = message
        else {
            continue;
        };
        for block in content {
            let ContentBlock::Text { text } = block else {
                continue;
            };
            if text.starts_with(DISCOVERY_HEADER) {
                for section in text.split(RECORD).skip(1) {
                    let Some((metadata, body)) = section.split_once("-->\n```json\n") else {
                        continue;
                    };
                    let Some((schema, _)) = body.split_once("\n```\n") else {
                        continue;
                    };
                    let (Ok(metadata), Ok(schema)) = (
                        serde_json::from_str::<Value>(metadata),
                        serde_json::from_str::<Value>(schema),
                    ) else {
                        continue;
                    };
                    let (Some(name), Some(version), Some(expected)) = (
                        metadata["name"].as_str(),
                        metadata["version"].as_str(),
                        metadata["schema_hash"].as_str(),
                    ) else {
                        continue;
                    };
                    if schema_hash(&schema) == expected {
                        found.insert(name.to_owned(), version.to_owned());
                    }
                }
            } else if let Ok(value) = serde_json::from_str::<Value>(text)
                && value["kind"] == "deferred_tool_definitions"
                && let Some(tools) = value["tools"].as_array()
            {
                for tool in tools {
                    if let (Some(name), Some(schema)) =
                        (tool["name"].as_str(), tool.get("input_schema"))
                    {
                        found.insert(name.to_owned(), format!("legacy:{}", schema_hash(schema)));
                    }
                }
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visibility_requires_complete_runtime_authored_schema() {
        let schema = serde_json::json!({"type":"object","properties":{"id":{"type":"integer"}}});
        let text = format!(
            "{DISCOVERY_HEADER}{}",
            definition_markdown("sample", "A useful tool", &schema, "version", false)
        );
        let runtime = kcoder_types::SharedMessages::from(vec![Message::runtime_text(&text)]);
        assert_eq!(
            visible_definitions(&runtime)
                .get("sample")
                .map(String::as_str),
            Some("version")
        );
        let user = kcoder_types::SharedMessages::from(vec![Message::user_text(&text)]);
        assert!(visible_definitions(&user).is_empty());
        let truncated = text.split_once("```json\n").unwrap().0;
        assert!(visible_definitions(&vec![Message::runtime_text(truncated)].into()).is_empty());
    }
    #[test]
    fn complete_native_office_schema_round_trips_compact_with_unchanged_binding() {
        let raw =
            kcoder_tools::integrations::office::native_tool_input_schema("OfficeDocument").unwrap();
        let schema = crate::tool_schema_runtime::model_schema_for_tool_input(
            "OfficeDocument",
            &raw,
            &kcoder_tools::ToolInputFormat::Json,
        );
        let version = definition_version("OfficeDocument", "native:office:original", &schema);
        let text = format!(
            "{DISCOVERY_HEADER}{}",
            definition_markdown(
                "OfficeDocument",
                "Original Native definition",
                &schema,
                &version,
                false
            )
        );
        let (_, body) = text.split_once("```json\n").unwrap();
        let (body, _) = body.split_once("\n```\n").unwrap();
        let decoded: Value = serde_json::from_str(body).unwrap();
        assert_eq!(
            decoded, schema,
            "Every complete field/default/constraint/ref must be preserved"
        );
        assert_eq!(schema_hash(&decoded), schema_hash(&schema));
        assert_eq!(
            visible_definitions(&vec![Message::runtime_text(text.clone())].into())
                .get("OfficeDocument"),
            Some(&version)
        );
        assert!(body.len() < serde_json::to_string_pretty(&schema).unwrap().len());
    }
}
