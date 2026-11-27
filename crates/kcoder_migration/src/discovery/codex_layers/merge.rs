use super::*;
use kcoder_types::migration::{
    MigrationIssue, MigrationIssueCode, MigrationIssuePhase, MigrationIssueSeverity,
    MigrationItemStatus,
};
use std::collections::BTreeMap;
pub(super) struct PrivateTable(pub(super) toml::Table);
impl Drop for PrivateTable {
    fn drop(&mut self) {
        clear_table(&mut self.0);
    }
}
fn clear_table(table: &mut toml::Table) {
    for (mut name, mut value) in std::mem::take(table) {
        name.zeroize();
        clear(&mut value);
    }
}
fn clear(value: &mut toml::Value) {
    match value {
        toml::Value::String(value) => value.zeroize(),
        toml::Value::Table(table) => clear_table(table),
        toml::Value::Array(values) => values.iter_mut().for_each(clear),
        _ => {}
    }
}
fn clear_json(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(value) => value.zeroize(),
        serde_json::Value::Array(values) => values.iter_mut().for_each(clear_json),
        serde_json::Value::Object(values) => {
            for (mut name, mut value) in std::mem::take(values) {
                name.zeroize();
                clear_json(&mut value);
            }
        }
        _ => {}
    }
}
fn replace(table: &mut toml::Table, name: &str, value: toml::Value) {
    if let Some(old) = table.get_mut(name) {
        clear(old);
        *old = value;
    } else {
        table.insert(name.to_owned(), value);
    }
}
fn bounded(value: &toml::Value, depth: usize, nodes: &mut usize) -> Result<()> {
    *nodes += 1;
    ensure!(
        depth <= 64 && *nodes <= 65536,
        "migration_source_budget_exceeded"
    );
    match value {
        toml::Value::Table(table) => {
            for value in table.values() {
                bounded(value, depth + 1, nodes)?;
            }
        }
        toml::Value::Array(values) => {
            for value in values {
                bounded(value, depth + 1, nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn field(name: &str, project: bool) -> (Option<String>, bool, bool) {
    match name {
        "model" | "model_context_window" | "model_reasoning_effort" => {
            (Some(format!("/{name}")), true, false)
        }
        "model_provider" | "model_providers" => (Some(format!("/{name}")), !project, project),
        "project_root_markers" => (Some("/project_root_markers".into()), !project, false),
        "projects" => (Some("/projects".into()), false, !project),
        "profile" | "profiles" => (Some(format!("/{name}")), false, true),
        "openai_base_url"
        | "chatgpt_base_url"
        | "apps_mcp_product_sku"
        | "notify"
        | "otel"
        | "experimental_realtime_ws_base_url"
            if project =>
        {
            (Some(format!("/{name}")), false, true)
        }
        "mcp_servers"
        | "hooks"
        | "permissions"
        | "sandbox_mode"
        | "approval_policy"
        | "model_instructions_file" => (Some(format!("/{name}")), false, false),
        _ => (None, false, false),
    }
}
fn merge_tables(base: &mut toml::Table, overlay: &toml::Table) {
    for (name, value) in overlay {
        match (base.get_mut(name), value) {
            (Some(toml::Value::Table(base)), toml::Value::Table(overlay)) => {
                merge_tables(base, overlay)
            }
            (_, value) => {
                replace(base, name, value.clone());
            }
        }
    }
}
#[derive(Default)]
struct ProviderOrigins(BTreeMap<(String, String), u32>);
impl Drop for ProviderOrigins {
    fn drop(&mut self) {
        for ((mut provider, mut field), _) in std::mem::take(&mut self.0) {
            provider.zeroize();
            field.zeroize();
        }
    }
}
pub(super) fn resolve(
    documents: &[Option<SourceDocument>],
    first_project: usize,
) -> Result<Resolved> {
    let mut combined = PrivateTable(toml::Table::new());
    let mut origins = Vec::new();
    let mut winners = BTreeMap::new();
    let mut provider_origins = ProviderOrigins::default();
    let mut secrets = Zeroizing::new(Vec::<String>::new());
    for (index, source) in documents.iter().enumerate() {
        let Some(source) = source else {
            continue;
        };
        let table = PrivateTable(
            toml::from_str(source.text())
                .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?,
        );
        let mut nodes = 0;
        for value in table.0.values() {
            bounded(value, 1, &mut nodes)?;
        }
        // Every original layer contributes redaction facts, even when its values are ignored.
        let mut json = serde_json::to_value(&table.0)
            .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?;
        for value in crate::adapters::secret_values(&json) {
            if !secrets.contains(&value.to_owned()) {
                secrets.push(value.to_owned());
            }
        }
        clear_json(&mut json);
        for value in source.private_values() {
            if !secrets.iter().any(|old| old.as_str() == value) {
                secrets.push(value.to_owned());
            }
        }
        ensure!(
            secrets.len() <= 4096 && secrets.iter().map(String::len).sum::<usize>() <= MAX_BYTES,
            "migration_source_budget_exceeded"
        );
        for (name, value) in &table.0 {
            ensure!(origins.len() < 1024, "migration_source_budget_exceeded");
            let (field, supported, ignored) = field(name, index >= first_project);
            let private = kcoder_config::looks_like_credential_env_key(name);
            let origin = CodexFieldOrigin {
                provider_index: None,
                field,
                layer: index as u32,
                supported,
                ignored,
                private,
            };
            if supported && name == "model_providers" {
                for (provider, value) in value
                    .as_table()
                    .ok_or_else(|| anyhow::anyhow!("migration_invalid_source_format"))?
                {
                    for (field, _) in value
                        .as_table()
                        .ok_or_else(|| anyhow::anyhow!("migration_invalid_source_format"))?
                    {
                        ensure!(
                            origins.len() + provider_origins.0.len() < 1024,
                            "migration_source_budget_exceeded"
                        );
                        provider_origins
                            .0
                            .insert((provider.clone(), field.clone()), index as u32);
                    }
                }
            }
            if supported && name != "project_root_markers" {
                // Supported root fields are scalar except the user-owned provider namespace.
                ensure!(
                    if name == "model_providers" {
                        value.is_table()
                    } else if name == "model_context_window" {
                        value.as_integer().is_some_and(|n| n > 0)
                    } else {
                        value.is_str()
                    },
                    "migration_invalid_source_format"
                );
                winners.insert(name.clone(), origins.len());
                if name == "model_providers" {
                    if let Some(toml::Value::Table(base)) = combined.0.get_mut(name) {
                        merge_tables(base, value.as_table().unwrap());
                    } else {
                        replace(&mut combined.0, name, value.clone());
                    }
                } else {
                    replace(&mut combined.0, name, value.clone());
                }
            }
            origins.push(origin);
        }
    }
    // Unknown names never leave the Native private source; only fixed field identifiers do.
    let mut fields: Vec<CodexFieldOrigin> = origins
        .into_iter()
        .enumerate()
        .filter_map(|(index, field)| {
            if !field.supported
                || field.field.as_deref() == Some("/project_root_markers")
                || winners.values().any(|winner| *winner == index)
            {
                Some(field)
            } else {
                None
            }
        })
        .collect();
    if let Some(providers) = combined
        .0
        .get("model_providers")
        .and_then(toml::Value::as_table)
    {
        for ((provider, name), layer) in &provider_origins.0 {
            let provider_index = providers.keys().position(|key| key == provider).unwrap() as u32;
            let supported = matches!(
                name.as_str(),
                "name" | "base_url" | "wire_api" | "env_key" | "requires_openai_auth"
            );
            let known = supported
                || matches!(
                    name.as_str(),
                    "auth" | "experimental_bearer_token" | "http_headers" | "env_http_headers"
                );
            fields.push(CodexFieldOrigin {
                field: known.then(|| format!("/model_providers/{name}")),
                layer: *layer,
                provider_index: Some(provider_index),
                supported,
                ignored: false,
                private: matches!(
                    name.as_str(),
                    "auth" | "experimental_bearer_token" | "http_headers" | "env_http_headers"
                ),
            });
        }
    }
    ensure!(fields.len() <= 1024, "migration_source_budget_exceeded");
    let text = toml::to_string(&combined.0)
        .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?;
    let document = SourceDocument::from_private_configuration(text, secrets)?;
    Ok(Resolved {
        document,
        report: CodexLayerReport {
            profile_selected: first_project == 2,
            present: documents.iter().map(Option::is_some).collect(),
            fields,
            unobserved: super::report::UNOBSERVED
                .into_iter()
                .map(str::to_owned)
                .collect(),
        },
    })
}
pub(super) fn annotate(inventory: &mut MigrationInventory, report: &CodexLayerReport) {
    let issues = report
        .fields
        .iter()
        .filter(|field| !field.supported)
        .map(|field| MigrationIssue {
            code: if field.ignored {
                MigrationIssueCode::RequiresReview
            } else {
                MigrationIssueCode::UnsupportedField
            },
            severity: if field.ignored {
                MigrationIssueSeverity::Notice
            } else {
                MigrationIssueSeverity::Blocking
            },
            phase: MigrationIssuePhase::Import,
            field: Some(
                if field.ignored {
                    "ignored_codex_layer_field"
                } else {
                    "selected_codex_layers"
                }
                .into(),
            ),
        })
        .collect::<Vec<_>>();
    inventory.issues.extend(issues.clone());
    inventory.issues.push(MigrationIssue {
        code: MigrationIssueCode::RequiresReview,
        severity: MigrationIssueSeverity::Notice,
        phase: MigrationIssuePhase::Import,
        field: Some("unobserved_managed_runtime_layers".into()),
    });
    for item in &mut inventory.items {
        item.preview.issues.extend(issues.clone());
        item.preview.selected_by_default = false;
        item.preview.status = MigrationItemStatus::RequiresAction;
    }
}
