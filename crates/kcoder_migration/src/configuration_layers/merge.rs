use super::*;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use zeroize::Zeroize;

pub(super) struct PrivateValue(pub(super) Value);
impl PrivateValue {
    pub(super) fn parse(text: &str) -> Result<Self> {
        // Current Claude settings are strict JSON; legacy single-file JSONC remains separate.
        let parsed: Value = serde_json::from_str(text)
            .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?;
        let value = Self(parsed);
        ensure!(
            value.0.is_object()
                && value.0.get("model").is_none_or(Value::is_string)
                && value.0.get("env").is_none_or(|env| env
                    .as_object()
                    .is_some_and(|fields| fields.values().all(Value::is_string))),
            "migration_invalid_source_format"
        );
        bounded(&value.0, 0, &mut 0)?;
        Ok(value)
    }
}
impl Drop for PrivateValue {
    fn drop(&mut self) {
        clear(&mut self.0);
    }
}
fn clear(value: &mut Value) {
    match value {
        Value::String(value) => value.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(clear),
        Value::Object(values) => {
            for (mut name, mut value) in std::mem::take(values) {
                name.zeroize();
                clear(&mut value);
            }
        }
        _ => {}
    }
}
fn bounded(value: &Value, depth: usize, nodes: &mut usize) -> Result<()> {
    *nodes += 1;
    ensure!(
        depth <= 64 && *nodes <= 65536,
        "migration_source_budget_exceeded"
    );
    match value {
        Value::Object(fields) => {
            for value in fields.values() {
                bounded(value, depth + 1, nodes)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                bounded(value, depth + 1, nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[derive(Default)]
struct Origins(BTreeMap<Vec<String>, Vec<ConfigurationLayerScope>>);
impl Drop for Origins {
    fn drop(&mut self) {
        for mut path in std::mem::take(&mut self.0).into_keys() {
            path.zeroize();
        }
    }
}
impl Origins {
    fn replace(&mut self, path: &[String], scope: ConfigurationLayerScope) -> Result<()> {
        self.0
            .retain(|other, _| !other.starts_with(path) && !path.starts_with(other));
        self.0.insert(path.to_owned(), vec![scope]);
        self.budget()
    }
    fn budget(&self) -> Result<()> {
        ensure!(
            self.0.len() <= MAX_FIELDS
                && self
                    .0
                    .keys()
                    .map(|path| path.iter().map(String::len).sum::<usize>() + path.len() * 32)
                    .sum::<usize>()
                    <= MAX_BYTES,
            "migration_source_budget_exceeded"
        );
        Ok(())
    }
}
fn combine(
    target: &mut Value,
    source: &Value,
    path: &mut Vec<String>,
    origins: &mut Origins,
    scope: ConfigurationLayerScope,
) -> Result<()> {
    if let Value::Object(fields) = source {
        if !target.is_object() {
            clear(target);
            *target = Value::Object(Map::new());
            origins.0.retain(|other, _| !other.starts_with(path));
        }
        if fields.is_empty() {
            if !path.is_empty() && target.as_object().unwrap().is_empty() {
                origins.replace(path, scope)?;
            }
            return Ok(());
        }
        for (name, value) in fields {
            path.push(name.clone());
            combine(
                target
                    .as_object_mut()
                    .unwrap()
                    .entry(name)
                    .or_insert(Value::Null),
                value,
                path,
                origins,
                scope,
            )?;
            path.pop();
        }
    } else if let (Some(target), Some(source)) = (target.as_array_mut(), source.as_array()) {
        // Unsupported lists retain all contributors for review; no executable policy is inferred.
        target.extend(source.iter().cloned());
        origins.0.entry(path.clone()).or_default().push(scope);
        origins.budget()?;
    } else {
        clear(target);
        *target = source.clone();
        origins.replace(path, scope)?;
    }
    Ok(())
}

fn private_name(name: &str) -> bool {
    kcoder_config::looks_like_credential_env_key(name)
        || [
            "key",
            "token",
            "password",
            "secret",
            "api_key",
            "access_token",
            "refresh_token",
            "auth_token",
            "experimental_bearer_token",
            "headers",
            "http_headers",
            "env_http_headers",
            "apikeyhelper",
            "apikey",
            "authtoken",
            "clientsecret",
            "client_secret",
        ]
        .contains(&name.to_ascii_lowercase().as_str())
}
fn redact(value: &mut Value, sensitive: bool) {
    match value {
        Value::String(text) if sensitive => {
            text.zeroize();
            *value = Value::Null;
        }
        Value::Object(fields) => {
            for (name, value) in fields {
                redact(value, sensitive || private_name(name));
            }
        }
        Value::Array(values) => {
            for value in values {
                redact(value, sensitive);
            }
        }
        _ => {}
    }
}
fn public_field(path: &[String]) -> (Option<String>, bool) {
    let names = path.iter().map(String::as_str).collect::<Vec<_>>();
    match names.as_slice() {
        ["model"] | ["$schema"] | ["env"] => (Some(format!("/{}", names[0])), true),
        ["env", name]
            if ["ANTHROPIC_MODEL", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"].contains(name) =>
        {
            (Some(format!("/env/{name}")), true)
        }
        ["env", name] if ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].contains(name) => {
            (Some(format!("/env/{name}")), false)
        }
        ["apiKeyHelper"] => (Some("/apiKeyHelper".into()), false),
        ["hooks", ..] => (Some("/hooks".into()), false),
        ["permissions", ..] => (Some("/permissions".into()), false),
        ["mcpServers", ..] => (Some("/mcpServers".into()), false),
        _ => (None, false),
    }
}

pub(super) struct Resolved {
    pub(super) document: SourceDocument,
    pub(super) report: ConfigurationLayerReport,
}
pub(super) fn resolve(
    binding: &ConfigurationLayersBinding,
    sources: &[Option<SourceDocument>],
) -> Result<Resolved> {
    let mut combined = PrivateValue(Value::Object(Map::new()));
    let mut private_values = Zeroizing::new(Vec::<String>::new());
    let mut origins = Origins::default();
    for (source, layer) in sources.iter().zip(&binding.layers) {
        if let Some(source) = source {
            let mut value = PrivateValue::parse(source.text())?;
            for value in crate::adapters::secret_values(&value.0) {
                private_values.push(value.into());
                ensure!(
                    private_values.len() <= 4096
                        && private_values.iter().map(String::len).sum::<usize>() <= MAX_BYTES,
                    "migration_source_budget_exceeded"
                );
            }
            if let Some(mut definition) = value.0.as_object_mut().unwrap().remove("mcpServers") {
                // MCP has separate user/project namespaces; settings layers cannot merge them.
                origins
                    .0
                    .entry(vec!["mcpServers".into()])
                    .or_default()
                    .push(layer.scope());
                clear(&mut definition);
                origins.budget()?;
            }
            combine(
                &mut combined.0,
                &value.0,
                &mut Vec::new(),
                &mut origins,
                layer.scope(),
            )?;
        }
    }
    bounded(&combined.0, 0, &mut 0)?;
    let fields = origins
        .0
        .iter()
        .enumerate()
        .map(|(index, (path, scopes))| {
            let (field, supported) = public_field(path);
            ConfigurationFieldOrigin {
                field,
                ordinal: index as u32,
                scopes: scopes.clone(),
                private: path.iter().any(|name| private_name(name)),
                supported,
            }
        })
        .collect();
    redact(&mut combined.0, false);
    let text = serde_json::to_string(&combined.0)
        .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?;
    let document = SourceDocument::from_private_configuration(text, private_values)?;
    Ok(Resolved {
        document,
        report: ConfigurationLayerReport {
            adapter_revision: CLAUDE_LAYERS_REVISION.into(),
            layers: binding
                .layers
                .iter()
                .map(|layer| ConfigurationLayerState {
                    scope: layer.scope(),
                    present: layer.present(),
                })
                .collect(),
            fields,
            unobserved: super::report::UNOBSERVED
                .into_iter()
                .map(str::to_owned)
                .collect(),
        },
    })
}
