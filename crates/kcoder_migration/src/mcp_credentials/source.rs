//! Only selected literal fields from a pinned configuration may become a private payload.
use super::*;
use kcoder_types::migration::MigrationSourceKind;
use zeroize::{Zeroize, Zeroizing};

struct PrivateDocument(Value);
impl Drop for PrivateDocument {
    fn drop(&mut self) {
        fn clear(value: &mut Value) {
            match value {
                Value::String(text) => text.zeroize(),
                Value::Array(values) => values.iter_mut().for_each(clear),
                Value::Object(fields) => {
                    for (mut name, mut value) in std::mem::take(fields) {
                        name.zeroize();
                        clear(&mut value);
                    }
                }
                _ => {}
            }
        }
        clear(&mut self.0);
    }
}

pub(crate) fn read(
    source: &ConfigurationBinding,
    source_name: &str,
    fields: &[Field],
) -> Result<Zeroizing<String>> {
    ensure!(
        !source.has_configuration_layers(),
        "migration_configuration_layers_mcp_unsupported"
    );
    let document = source.read()?;
    let parsed = PrivateDocument(match source.kind {
        MigrationSourceKind::ClaudeCode => {
            jsonc_parser::parse_to_serde_value(document.text(), &Default::default())
                .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?
        }
        MigrationSourceKind::Codex => toml::from_str::<Value>(document.text())
            .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?,
    });
    let key = if source.kind == MigrationSourceKind::Codex {
        "mcp_servers"
    } else {
        "mcpServers"
    };
    let definition = parsed
        .0
        .get(key)
        .and_then(|value| value.get(source_name))
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("migration_mcp_private_source_missing"))?;
    let mut values = McpSecretValues::default();
    for field in fields {
        let (name, value, destination) = match field {
            Field::Environment(name) => (
                name,
                definition.get("env").and_then(|value| value.get(name)),
                &mut values.env,
            ),
            Field::Header(name) => {
                let matches = ["headers", "http_headers"]
                    .into_iter()
                    .filter_map(|key| definition.get(key).and_then(Value::as_object))
                    .flat_map(|values| values.iter())
                    .filter(|(key, _)| key.eq_ignore_ascii_case(name))
                    .collect::<Vec<_>>();
                ensure!(matches.len() == 1, "migration_mcp_private_source_ambiguous");
                (name, Some(matches[0].1), &mut values.headers)
            }
        };
        let value = value
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("migration_mcp_private_source_invalid"))?;
        // Expansion expressions stay unresolved; do not execute helpers or read arbitrary variables.
        ensure!(
            !value.contains("${"),
            "migration_mcp_private_expansion_unsupported"
        );
        destination.insert(name.clone(), value.to_owned());
    }
    values.encode().map_err(safe_error)
}

#[cfg(test)]
mod layered_tests {
    use super::*;
    #[test]
    fn layered_settings_are_not_a_synthetic_mcp_private_source() {
        let root = tempfile::tempdir().unwrap();
        let user = root.path().join("user");
        let project = root.path().join("project");
        std::fs::create_dir(&user).unwrap();
        std::fs::create_dir(&project).unwrap();
        std::fs::write(user.join("settings.json"), "{\"model\":\"fixture\"}").unwrap();
        let binding = ConfigurationBinding::capture_claude_layers(&user, &project)
            .unwrap()
            .unwrap();
        assert_eq!(
            read(&binding, "documents", &[Field::Environment("TOKEN".into())])
                .unwrap_err()
                .to_string(),
            "migration_configuration_layers_mcp_unsupported"
        );
    }
}
