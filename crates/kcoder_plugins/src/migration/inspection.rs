use crate::{
    PluginCancellationToken, PluginHookDeclaration, PluginManifestFormat, PluginMcpDeclaration,
};
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use serde_json::Value;
use std::{collections::BTreeSet, ffi::OsStr, io::Read, path::Path};
#[derive(Clone, PartialEq, Eq)]
pub struct PluginMigrationInspection {
    pub name: String,
    pub version: Option<String>,
    pub compatible: bool,
    pub capabilities: Vec<String>,
    pub pending: Vec<String>,
    pub readiness: Vec<String>,
    pub skills: usize,
    pub commands: usize,
    pub hooks: usize,
    pub mcp_servers: usize,
}
fn json_file(path: &Path) -> Result<Value> {
    let dir = PrivateDirectory::open_existing(
        path.parent()
            .ok_or_else(|| anyhow::anyhow!("plugin_migration_invalid_package"))?,
    )?;
    let file = dir.open_single_link_regular_file(
        path.file_name()
            .ok_or_else(|| anyhow::anyhow!("plugin_migration_invalid_package"))?,
    )?;
    ensure!(
        file.metadata()?.len() <= 1024 * 1024,
        "plugin_migration_manifest_budget_exceeded"
    );
    let mut text = String::new();
    file.take(1024 * 1024 + 1).read_to_string(&mut text)?;
    ensure!(
        text.len() <= 1024 * 1024,
        "plugin_migration_manifest_budget_exceeded"
    );
    serde_json::from_str(&text).map_err(|_| anyhow::anyhow!("plugin_migration_invalid_package"))
}
fn known(value: &Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.keys().all(|key| allowed.contains(&key.as_str())))
}
fn hook_value(declaration: &PluginHookDeclaration) -> Result<Value> {
    match declaration {
        PluginHookDeclaration::Inline(value) => Ok(value.clone()),
        PluginHookDeclaration::Path(resource) => json_file(&resource.absolute_path),
    }
}
fn check_hooks(value: &Value) -> bool {
    if value.get("hooks").is_some() && !known(value, &["hooks"]) {
        return false;
    }
    let value = value.get("hooks").unwrap_or(value);
    let Some(events) = value.as_object() else {
        return false;
    };
    events.values().all(|groups| {
        groups.as_array().is_some_and(|groups| {
            groups.iter().all(|group| {
                known(group, &["matcher", "hooks"])
                    && group
                        .get("hooks")
                        .and_then(Value::as_array)
                        .is_some_and(|actions| {
                            actions.iter().all(|action| {
                                known(
                                    action,
                                    &[
                                        "type",
                                        "command",
                                        "commandWindows",
                                        "timeout",
                                        "async",
                                        "statusMessage",
                                    ],
                                ) && action.get("type").and_then(Value::as_str) == Some("command")
                            })
                        })
            })
        })
    })
}
fn mcp_value(declaration: &PluginMcpDeclaration) -> Result<Value> {
    match declaration {
        PluginMcpDeclaration::Inline(value) => Ok(value.clone()),
        PluginMcpDeclaration::Path(resource) => json_file(&resource.absolute_path),
    }
}
fn check_mcp(value: &Value) -> (bool, bool) {
    if value.get("mcpServers").is_some() && !known(value, &["mcpServers"]) {
        return (false, false);
    }
    let servers = value.get("mcpServers").unwrap_or(value);
    let Some(servers) = servers.as_object() else {
        return (false, false);
    };
    let mut private = false;
    let valid = servers.values().all(|server| {
        if !known(
            server,
            &[
                "type",
                "transport",
                "command",
                "args",
                "url",
                "env",
                "headers",
                "policy",
            ],
        ) {
            return false;
        }
        for field in ["env", "headers"] {
            if let Some(values) = server.get(field).and_then(Value::as_object) {
                for (name, value) in values {
                    if (field == "headers" || kcoder_config::looks_like_credential_env_key(name))
                        && value
                            .as_str()
                            .is_some_and(|text| !text.is_empty() && !text.contains("${"))
                    {
                        private = true;
                    }
                }
            }
        }
        if let Some(url) = server.get("url").and_then(Value::as_str)
            && let Ok(url) = url::Url::parse(url)
        {
            private |=
                !url.username().is_empty() || url.password().is_some() || url.query().is_some();
        }
        server.get("policy").is_none_or(|policy| {
            match serde_json::from_value::<kcoder_types::McpServerPolicy>(policy.clone()) {
                Ok(policy) => {
                    private |= policy.credential_ref.is_some();
                    true
                }
                Err(_) => false,
            }
        })
    });
    (valid, private)
}
fn skill_entries(
    root: &Path,
    depth: usize,
    entries: &mut usize,
    pending: &mut BTreeSet<String>,
) -> Result<usize> {
    ensure!(
        depth <= 8 && *entries <= 4096,
        "plugin_migration_skill_budget_exceeded"
    );
    let directory = PrivateDirectory::open_existing(root)?;
    let mut names = Vec::new();
    directory.visit_entry_names_bounded(4097, |name| {
        names.push(name.to_os_string());
        Ok(())
    })?;
    let mut count = 0;
    for name in names {
        *entries += 1;
        ensure!(*entries <= 4096, "plugin_migration_skill_budget_exceeded");
        let meta = directory.entry_metadata(&name)?;
        if meta.is_dir() {
            count += skill_entries(&root.join(&name), depth + 1, entries, pending)?;
        } else if name == OsStr::new("SKILL.md") {
            let file = directory.open_single_link_regular_file(&name)?;
            ensure!(
                file.metadata()?.len() <= 1024 * 1024,
                "plugin_migration_skill_budget_exceeded"
            );
            let mut text = String::new();
            file.take(1024 * 1024 + 1).read_to_string(&mut text)?;
            if text.contains("!`") || text.contains("${CLAUDE_") || text.contains("$CLAUDE_") {
                pending.insert("plugin_skill_semantics_pending".into());
            }
            let normalized = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
            if let Some(front) = normalized.strip_prefix("---\n") {
                let (front, _) = front
                    .split_once("\n---")
                    .ok_or_else(|| anyhow::anyhow!("plugin_migration_invalid_skill"))?;
                let value: serde_yaml::Value = serde_yaml::from_str(front)
                    .map_err(|_| anyhow::anyhow!("plugin_migration_invalid_skill"))?;
                if !value.as_mapping().is_some_and(|map| {
                    map.iter().all(|(key, value)| {
                        key.as_str().is_some_and(|key| {
                            [
                                "name",
                                "description",
                                "version",
                                "author",
                                "license",
                                "argument-hint",
                            ]
                            .contains(&key)
                        }) && value.is_string()
                    })
                }) {
                    pending.insert("plugin_skill_semantics_pending".into());
                }
            }
            count += 1;
        }
    }
    Ok(count)
}
/// Parse formal contributions with inert environment placeholders, never the host's credentials.
pub fn inspect_package(
    root: &Path,
    cancel: &PluginCancellationToken,
) -> Result<PluginMigrationInspection> {
    ensure!(!cancel.is_cancelled(), "plugin_migration_cancelled");
    super::package_revision(root, crate::InstallLimits::default(), cancel)?;
    let loaded = crate::load_plugin_manifest(root)
        .map_err(|_| anyhow::anyhow!("plugin_migration_invalid_package"))?
        .ok_or_else(|| anyhow::anyhow!("plugin_migration_manifest_missing"))?;
    let raw = json_file(&loaded.selected_manifest_path)?;
    let mut pending = BTreeSet::new();
    let mut readiness = BTreeSet::new();
    if !matches!(
        loaded.manifest.format,
        PluginManifestFormat::Claude | PluginManifestFormat::Codex | PluginManifestFormat::Kcoder
    ) {
        pending.insert("plugin_manifest_format_pending".into());
    }
    if !known(
        &raw,
        &[
            "name",
            "version",
            "description",
            "keywords",
            "skills",
            "commands",
            "agents",
            "hooks",
            "mcpServers",
            "interface",
            "author",
            "license",
            "homepage",
            "repository",
            "defaultEnabled",
            "displayName",
        ],
    ) {
        pending.insert("plugin_manifest_fields_pending".into());
    }
    if raw.get("interface").is_some_and(|interface| {
        !known(
            interface,
            &[
                "displayName",
                "shortDescription",
                "longDescription",
                "developerName",
                "category",
                "capabilities",
                "websiteUrl",
                "websiteURL",
                "privacyPolicyUrl",
                "privacyPolicyURL",
                "termsOfServiceUrl",
                "termsOfServiceURL",
                "defaultPrompt",
                "brandColor",
                "composerIcon",
                "logo",
                "logoDark",
                "screenshots",
            ],
        )
    }) {
        pending.insert("plugin_interface_fields_pending".into());
    }
    if !loaded.shadowed_manifest_paths.is_empty() {
        pending.insert("plugin_shadowed_manifests_pending".into());
    }
    if !loaded.compatibility.deferred_capabilities.is_empty()
        || loaded.compatibility.issues.iter().any(|issue| {
            matches!(
                issue.code.as_str(),
                "prompt_adapter_unsupported" | "model_inherited" | "permissions_inherited"
            )
        })
    {
        pending.insert("plugin_contribution_semantics_pending".into());
    }
    let mut skills = 0;
    let mut visited = 0;
    for resource in &loaded.manifest.contributions.skills {
        if resource.absolute_path.is_dir() {
            skills += skill_entries(&resource.absolute_path, 0, &mut visited, &mut pending)?;
        } else {
            pending.insert("plugin_skill_layout_pending".into());
        }
    }
    let mut hooks = 0;
    for declaration in &loaded.manifest.contributions.hooks {
        if !check_hooks(&hook_value(declaration)?) {
            pending.insert("plugin_hook_semantics_pending".into());
        }
    }
    if !loaded.manifest.contributions.hooks.is_empty() {
        match crate::contributions::hooks::resolve(&loaded.manifest.contributions.hooks) {
            Ok(outcome) if outcome.warnings.is_empty() => hooks = outcome.matchers.len(),
            _ => {
                pending.insert("plugin_hook_semantics_pending".into());
            }
        }
    }
    let mut mcp_servers = 0;
    if let Some(declaration) = &loaded.manifest.contributions.mcp_servers {
        let (known, private) = check_mcp(&mcp_value(declaration)?);
        if !known {
            pending.insert("plugin_mcp_semantics_pending".into());
        }
        if private {
            pending.insert("plugin_private_fields_require_selection".into());
        }
        match crate::contributions::mcp::required_environment_names(root, declaration) {
            Ok(names) if !names.is_empty() => {
                readiness.insert("plugin_environment_required".into());
            }
            Ok(_) => {}
            Err(_) => {
                pending.insert("plugin_mcp_semantics_pending".into());
            }
        }
        match crate::contributions::mcp::resolve_with_env(
            &loaded.manifest.name,
            root,
            declaration,
            |_| Some("migration-static-placeholder".into()),
        ) {
            Ok(configs) => mcp_servers = configs.len(),
            Err(_) => {
                pending.insert("plugin_mcp_semantics_pending".into());
            }
        }
    }
    ensure!(!cancel.is_cancelled(), "plugin_migration_cancelled");
    Ok(PluginMigrationInspection {
        name: loaded.manifest.name,
        version: loaded.manifest.version,
        compatible: pending.is_empty(),
        capabilities: loaded.compatibility.supported_capabilities,
        pending: pending.into_iter().collect(),
        readiness: readiness.into_iter().collect(),
        skills,
        commands: loaded.prompt_entries.len(),
        hooks,
        mcp_servers,
    })
}
