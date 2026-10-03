//! Entry modes for the shared CLI composition root.

use super::*;

pub(crate) async fn run_cli_config_change_hook(
    cwd: &Path,
    query: impl Into<String>,
    data: serde_json::Value,
) {
    let mut matchers = kcoder_hooks::discover_hooks(cwd).into_matchers();
    match kcoder_plugins::PluginRegistry::discover(cwd) {
        Ok(registry) => matchers.extend(registry.hook_matchers()),
        Err(error) => warn!("failed to load plugin hooks for CLI config change: {error}"),
    }
    let registry = kcoder_hooks::HookRegistry::from_matchers(matchers);
    let input = kcoder_hooks::HookInput::new(kcoder_hooks::HookEvent::ConfigChange, query, data)
        .with_extra("cwd", serde_json::json!(cwd))
        .with_extra("source", serde_json::json!("cli"));
    let results = kcoder_hooks::execute_hooks(&registry, input).await;
    let effects = kcoder_hooks::AggregatedEffects::aggregate(
        results
            .iter()
            .filter_map(|result| match &result.outcome {
                kcoder_hooks::HookOutcome::Effects(effects) => Some(effects.clone()),
                _ => None,
            })
            .collect(),
    );
    for (text, is_error) in effects.messages {
        let level = if is_error { "error" } else { "message" };
        eprintln!("[hook:ConfigChange:{level}] {text}");
    }
    if let Some(error) = kcoder_hooks::first_blocking_error(&results) {
        eprintln!("[hook:ConfigChange:error] {error}");
    }
}

pub(crate) fn is_read_only_doctor_invocation(args: &[std::ffi::OsString]) -> bool {
    Cli::try_parse_from(args)
        .ok()
        .is_some_and(|cli| matches!(cli.command, Some(Commands::Doctor)))
}

pub(crate) fn provider_template_output(action: &ConfigAction) -> Result<Option<Value>> {
    let templates = kcoder_config::provider_templates::provider_templates();
    match action {
        ConfigAction::Templates => Ok(Some(serde_json::json!({ "templates": templates }))),
        ConfigAction::Template { name } => {
            let template = templates
                .iter()
                .find(|template| template.id == name)
                .context(
                    "Unknown provider template; use 'kcoder config templates' to list templates",
                )?;
            Ok(Some(
                serde_json::json!({ "template": template, "validated": false, "requiresModel": true }),
            ))
        }
        _ => Ok(None),
    }
}

pub(crate) async fn run_config(
    action: ConfigAction,
    loader: &SettingsLoader,
    cli: &Cli,
    cwd: &Path,
) -> Result<()> {
    let paths = loader.paths()?;
    match action {
        ConfigAction::Templates | ConfigAction::Template { .. } => {
            println!(
                "{}",
                serde_json::to_string_pretty(&provider_template_output(&action)?)?
            );
        }
        ConfigAction::Path { scope } => match scope {
            Some(scope) => println!("{}", paths.for_scope(scope.into()).display()),
            None => {
                println!("user: {}", paths.user_settings.display());
                println!("executable: {}", paths.executable_settings.display());
                println!("project: {}", paths.project_settings.display());
                println!("local: {}", paths.local_settings.display());
                println!("credentials: {}", paths.credentials.display());
            }
        },
        ConfigAction::Init { scope } => {
            let scope = ConfigScope::from(scope);
            let path = paths.for_scope(scope);
            if path.exists() {
                println!(
                    "Keeping existing {} settings at {}",
                    scope.as_str(),
                    path.display()
                );
            } else {
                let value = initial_config_scope_document(scope);
                write_scope(&paths, scope, &value)?;
                println!("Created {} settings at {}", scope.as_str(), path.display());
            }
        }
        ConfigAction::Migrate => {
            update_scope(&paths, ConfigScope::User, |value| {
                migrate_deployment_settings(value);
                Ok(())
            })?;
            println!(
                "Updated deployment profiles in {}",
                paths.user_settings.display()
            );
        }
        ConfigAction::Import { file, scope } => {
            let content = std::fs::read_to_string(&file)
                .with_context(|| format!("failed to read settings import {}", file.display()))?;
            let mut imported: Value =
                jsonc_parser::parse_to_serde_value(&content, &Default::default()).with_context(
                    || format!("failed to parse settings import {}", file.display()),
                )?;
            if !imported.is_object() {
                bail!("settings import root must be a JSON object");
            }
            reject_secret_settings_document(&imported, "")?;
            normalize_legacy_settings_document(&mut imported);
            let scope = ConfigScope::from(scope);
            update_scope(&paths, scope, |document| {
                merge_settings_documents(document, imported);
                Ok(())
            })?;
            loader
                .load()
                .context("settings were imported but the merged configuration is invalid")?;
            println!(
                "Imported {} into {} settings: {}",
                file.display(),
                scope.as_str(),
                paths.for_scope(scope).display()
            );
        }
        ConfigAction::List { sources } => {
            let mut loaded = loader.load()?;
            apply_cli_settings_overrides(&mut loaded.settings, cli)?;
            let value = serde_json::to_value(&loaded.settings)
                .context("failed to serialize effective settings")?;
            println!("{}", serde_json::to_string_pretty(&value)?);
            if sources {
                println!("\nLoaded sources:");
                if loaded.loaded_sources.is_empty() {
                    println!("  default");
                } else {
                    for source in loaded.loaded_sources {
                        println!("  {}: {}", source.scope.as_str(), source.path.display());
                    }
                }
                for path in loaded.overlay_sources {
                    println!("  overlay: {}", path.display());
                }
                println!("\nOverridden fields:");
                for (key, scope) in loaded.field_sources {
                    println!("  {key}: {}", scope.as_str());
                }
                for key in loaded.overlay_fields {
                    println!("  {key}: overlay");
                }
                let runtime_keys = [
                    "model",
                    "provider",
                    "max_tokens",
                    "max_retries",
                    "retry_base_delay_ms",
                    "summary_provider",
                    "summary_profile",
                    "summary_model",
                    "summary_max_tokens",
                    "permission_mode",
                    "base_url",
                    "openai_base_url",
                    "local_base_url",
                ]
                .into_iter()
                .filter(|key| runtime_override_source(cli, key).is_some())
                .collect::<Vec<_>>();
                if !runtime_keys.is_empty() {
                    println!("\nCLI/environment overrides:");
                    for key in runtime_keys {
                        println!("  {key}");
                    }
                }
            }
        }
        ConfigAction::Get { key, source } => {
            let mut loaded = loader.load()?;
            apply_cli_settings_overrides(&mut loaded.settings, cli)?;
            let value = serde_json::to_value(&loaded.settings)
                .context("failed to serialize effective settings")?;
            let value = dotted_value(&value, &key)?
                .ok_or_else(|| anyhow::anyhow!("unknown setting '{key}'"))?;
            if value.is_string() {
                println!("{}", value.as_str().unwrap_or_default());
            } else {
                println!("{}", serde_json::to_string_pretty(value)?);
            }
            if source {
                let origin = runtime_override_source(cli, &key).unwrap_or_else(|| {
                    if loaded.overlay_fields.contains(&key) {
                        "overlay"
                    } else {
                        loaded
                            .field_sources
                            .get(&key)
                            .map(|scope| scope.as_str())
                            .unwrap_or("default")
                    }
                });
                eprintln!("source: {origin}");
            }
        }
        ConfigAction::Set { key, value, scope } => {
            reject_secret_config_key(&key)?;
            let scope = ConfigScope::from(scope);
            let value = serde_json::from_str(&value).unwrap_or(Value::String(value));
            update_scope(&paths, scope, |document| {
                set_dotted_value(document, &key, value.clone())
            })?;
            loader
                .load()
                .context("settings were written but the merged configuration is invalid")?;
            run_cli_config_change_hook(
                cwd,
                key.clone(),
                serde_json::json!({
                    "scope": scope.as_str(),
                    "action": "set",
                    "value": value,
                }),
            )
            .await;
            println!(
                "Updated {key} in {} settings: {}",
                scope.as_str(),
                paths.for_scope(scope).display()
            );
        }
        ConfigAction::Unset { key, scope } => {
            reject_secret_config_key(&key)?;
            let scope = ConfigScope::from(scope);
            update_scope(&paths, scope, |document| {
                if !remove_dotted_value(document, &key)? {
                    bail!(
                        "setting '{key}' is not present in {} settings",
                        scope.as_str()
                    );
                }
                Ok(())
            })?;
            loader
                .load()
                .context("settings were written but the merged configuration is invalid")?;
            run_cli_config_change_hook(
                cwd,
                key.clone(),
                serde_json::json!({
                    "scope": scope.as_str(),
                    "action": "unset",
                }),
            )
            .await;
            println!(
                "Removed {key} from {} settings: {}",
                scope.as_str(),
                paths.for_scope(scope).display()
            );
        }
        ConfigAction::Validate => {
            let loaded = loader.load()?;
            println!("Configuration is valid.");
            for (provider, config) in &loaded.settings.providers {
                if kcoder_config::is_plaintext_remote_endpoint(&config.endpoint) {
                    println!(
                        "warning: provider '{provider}' uses a plaintext HTTP endpoint outside loopback: {} (prefer HTTPS)",
                        config.endpoint
                    );
                }
            }
            if loaded.loaded_sources.is_empty() && loaded.overlay_sources.is_empty() {
                println!("Using built-in defaults; no settings files were found.");
            } else {
                for source in loaded.loaded_sources {
                    println!("{}: {}", source.scope.as_str(), source.path.display());
                }
                for path in loaded.overlay_sources {
                    println!("overlay: {}", path.display());
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn initial_config_scope_document(scope: ConfigScope) -> Value {
    if scope == ConfigScope::User {
        serde_json::json!({
            "$schema": "./settings.schema.jsonc",
            "permission_mode": "yolo",
            "tui": { "alternate_screen": "auto" }
        })
    } else {
        serde_json::json!({})
    }
}

pub(crate) fn reject_secret_config_key(key: &str) -> Result<()> {
    let normalized = key.trim().to_ascii_lowercase().replace(['.', '-'], "_");
    if normalized == "api_key" || normalized.ends_with("_api_key") {
        bail!("'{key}' is a secret; use `kcoder auth login --provider <provider>` instead");
    }
    Ok(())
}

pub(crate) fn reject_secret_settings_document(value: &Value, prefix: &str) -> Result<()> {
    let Value::Object(object) = value else {
        return Ok(());
    };
    for (key, nested) in object {
        let path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        reject_secret_config_key(&path)?;
        reject_secret_settings_document(nested, &path)?;
    }
    Ok(())
}

pub(crate) fn run_doctor(
    provider_kind: &ApiProviderKind,
    cli: &Cli,
    settings: &Settings,
    cwd: &std::path::Path,
    loaded: &LoadedSettings,
) -> Result<()> {
    let explicit_key = match provider_kind {
        ApiProviderKind::Openai => cli.openai_api_key.clone(),
        ApiProviderKind::Local => {
            first_non_empty([cli.local_api_key.clone(), cli.openai_api_key.clone()])
        }
        ApiProviderKind::Gemini => cli.gemini_api_key.clone(),
        ApiProviderKind::Grok => cli.grok_api_key.clone(),
        _ => cli.api_key.clone(),
    };
    let active_credential = settings.provider_credential(None);
    let active_key = settings.resolve_provider_api_key(None, explicit_key);
    let local_base_url = local_base_url(cli, settings);

    println!("kcoder doctor");
    println!("=================");
    println!("version: {}", env!("CARGO_PKG_VERSION"));
    println!("build commit: {}", env!("KCODER_BUILD_COMMIT"));
    println!("build dirty: {}", env!("KCODER_BUILD_DIRTY"));
    println!("build time (unix): {}", env!("KCODER_BUILD_TIME_UNIX"));
    println!(
        "executable sha256: {}",
        build_identity::executable_sha256()
            .as_deref()
            .unwrap_or("unavailable")
    );
    println!("cwd: {}", cwd.display());
    println!("user settings: {}", loaded.paths.user_settings.display());
    println!(
        "project settings: {}",
        loaded.paths.project_settings.display()
    );
    println!("local settings: {}", loaded.paths.local_settings.display());
    println!("credentials: {}", loaded.paths.credentials.display());
    let credentials_path = loaded.paths.credentials.clone();
    match kcoder_config::is_user_only_file(&credentials_path) {
        Some(true) => println!(
            "credentials: {} (user-only permissions)",
            credentials_path.display()
        ),
        Some(false) => println!(
            "warning: credentials file is readable by other users: {} (restrict it to the owner)",
            credentials_path.display()
        ),
        None => println!("credentials: {}", credentials_path.display()),
    }
    {
        let backend = OsCredentialBackend::new();
        let keyring_available = CredentialBackend::available(&backend);
        let stored = CredentialStore::load_from(&credentials_path)?;
        let keyring_backed = stored
            .credentials
            .values()
            .filter(|value| kcoder_config::provider_from_marker(value).is_some())
            .count();
        let plaintext = stored.credentials.len().saturating_sub(keyring_backed);
        println!(
            "credential store: {} ({}{}) mode={} keyring={} plaintext={}{}",
            backend.describe(),
            if keyring_available {
                "available".to_string()
            } else {
                "unavailable".to_string()
            },
            credential_store_reason(&backend, keyring_available),
            settings.credential_store.as_str(),
            keyring_backed,
            plaintext,
            if backend.available() && plaintext > 0 {
                " — run `kcoder auth migrate --to keyring`"
            } else {
                ""
            }
        );
    }
    let dev_debug = kcoder_api::providers::debug_log::dev_debug_enabled();
    println!("DEV_DEBUG: {}", if dev_debug { "on" } else { "off" });
    if dev_debug {
        match kcoder_api::providers::debug_log::debug_log_usage() {
            Some(usage) => {
                println!(
                    "request logs: {} files, {:.1} MiB{}",
                    usage.files,
                    usage.bytes as f64 / (1024.0 * 1024.0),
                    usage
                        .oldest_day
                        .map(|day| format!(", oldest {day}"))
                        .unwrap_or_default()
                );
                println!("request log root: {}", usage.root.display());
            }
            None => println!("request logs: configuration directory unavailable"),
        }
        println!(
            "request log retention: {} days (pruned automatically)",
            kcoder_api::providers::debug_log::DEBUG_LOG_RETENTION_DAYS
        );
        println!(
            "to stop recording: remove the DEV_DEBUG line from {} and restart",
            loaded.paths.config_dir.join(".env").display()
        );
    }
    if loaded.loaded_sources.is_empty() {
        println!("loaded settings: defaults only");
    } else {
        println!(
            "loaded settings: {}",
            loaded
                .loaded_sources
                .iter()
                .map(|source| source.scope.as_str())
                .collect::<Vec<_>>()
                .join(" -> ")
        );
    }
    println!(
        "active profile: {}",
        settings.active_provider.as_deref().unwrap_or("(none)")
    );
    println!(
        "model: {} (source: {})",
        settings.model,
        effective_setting_source(cli, loaded, "model")
    );
    println!("max tokens: {:?}", settings.max_tokens);
    println!(
        "summary profile: {}",
        settings.summary_profile.as_deref().unwrap_or("(none)")
    );
    println!(
        "summary provider: {}",
        settings
            .summary_provider
            .as_deref()
            .unwrap_or("(main provider)")
    );
    println!(
        "summary model: {}",
        settings.summary_model.as_deref().unwrap_or("(main model)")
    );
    println!("summary max tokens: {}", settings.summary_max_tokens);
    println!("tool timeout ms: {}", settings.tool_timeout_ms);
    println!(
        "provider: {:?} (source: {})",
        provider_kind,
        effective_setting_source(cli, loaded, "provider")
    );
    println!(
        "API format: {}",
        settings
            .api_format
            .map(|format| format.as_str().to_string())
            .unwrap_or_else(|| "provider default".to_string())
    );
    println!(
        "endpoint: {}",
        settings.base_url.as_deref().unwrap_or("provider default")
    );
    println!(
        "context window tokens: {}",
        settings
            .context_window_tokens
            .map(|value| value.to_string())
            .unwrap_or_else(|| "model catalog".to_string())
    );
    println!(
        "output headroom tokens: {}",
        settings
            .context_output_headroom
            .map(|value| value.to_string())
            .unwrap_or_else(|| "model catalog".to_string())
    );
    println!(
        "settings provider: {}",
        settings.provider.as_deref().unwrap_or("(unset)")
    );
    println!(
        "credential ID: {}",
        active_credential
            .as_ref()
            .map(|credential| credential.id.as_str())
            .unwrap_or("(none)")
    );
    println!("active API key: {}", mask_secret(active_key.as_deref()));
    println!(
        "OpenAI base URL: {}",
        first_non_empty([
            cli.openai_base_url.clone(),
            settings.openai_base_url.clone(),
            settings.base_url.clone(),
        ])
        .unwrap_or_else(|| "(default)".to_string())
    );
    println!("local base URL: {}", local_base_url);
    println!("permission mode: {:?}", settings.permission_mode);
    println!(
        "tool profile: {:?} (effective: {:?})",
        cli.tool_profile,
        cli.tool_profile.effective(settings.tools.profile)
    );
    let project_skills = kcoder_tools::skill_telemetry::project_skills_root(cwd);
    print_skill_store_doctor("project", &project_skills)?;
    if let Some(config_dir) = loaded.paths.user_settings.parent() {
        let user_skills = config_dir.join("skills");
        print_skill_store_doctor("user", &user_skills)?;
        print_skill_store_doctor("builtin", &user_skills.join(".builtin"))?;
    }
    Ok(())
}

pub(crate) fn print_skill_store_doctor(label: &str, root: &Path) -> Result<()> {
    let report = kcoder_skills::SkillStore::open(root)
        .with_context(|| format!("failed to open {label} skill store"))?
        .inspect()
        .with_context(|| format!("failed to inspect {label} skill store"))?;
    println!(
        "skill store {label}: root={} lock={} pending={} orphan={} commit_generation={} state_generation={}",
        report.root.display(),
        if report.lock_available {
            "available"
        } else {
            "busy"
        },
        report.pending_transactions.len(),
        report.orphan_paths.len(),
        report
            .last_commit_generation
            .map(|value| value.to_string())
            .unwrap_or_else(|| "none".to_string()),
        report
            .state_generation
            .map(|value| value.to_string())
            .unwrap_or_else(|| "none".to_string()),
    );
    for pending in report.pending_transactions {
        println!(
            "  pending transaction: id={} phase={} operation={}",
            pending.transaction_id,
            pending.phase,
            pending.operation_id.as_deref().unwrap_or("unknown")
        );
    }
    for orphan in report.orphan_paths {
        println!("  orphan path: {}", orphan.display());
    }
    for diagnostic in report.diagnostics {
        println!(
            "  diagnostic: {}",
            serde_json::to_string(&diagnostic).unwrap_or_else(|_| format!("{diagnostic:?}"))
        );
    }
    Ok(())
}

pub(crate) async fn run_mcp(action: McpAction, cwd: &Path) -> Result<()> {
    match action {
        McpAction::List => {
            let settings = Settings::load().unwrap_or_default();
            if settings.mcp_servers.is_empty() {
                println!("No MCP servers configured.");
            } else {
                println!("Configured MCP servers:");
                for server in &settings.mcp_servers {
                    println!(
                        "  {} [{}] {}",
                        server.name,
                        server.transport,
                        if server.transport == "sse" {
                            server.url.clone()
                        } else {
                            format!("{} {}", server.command, server.args.join(" "))
                        }
                    );
                }
            }
        }
        McpAction::Add {
            name,
            command,
            args,
            env,
        } => {
            let env_map = parse_key_value_pairs(&env)?;
            let server = McpServerConfig {
                name: name.clone(),
                transport: "stdio".to_string(),
                command,
                args,
                url: String::new(),
                env: env_map,
                headers: std::collections::HashMap::new(),
            };
            let paths = ConfigPaths::discover(cwd)?;
            update_scope(&paths, ConfigScope::User, |document| {
                let mut servers = document
                    .get("mcp_servers")
                    .cloned()
                    .map(serde_json::from_value::<Vec<McpServerConfig>>)
                    .transpose()
                    .context("failed to parse user MCP server settings")?
                    .unwrap_or_default();
                if servers.iter().any(|configured| configured.name == name) {
                    bail!("MCP server '{}' already exists", name);
                }
                servers.push(server.clone());
                document["mcp_servers"] = serde_json::to_value(servers)?;
                Ok(())
            })?;
            run_cli_config_change_hook(
                cwd,
                "mcp_servers",
                serde_json::json!({
                    "scope": "mcp",
                    "action": "add",
                    "name": name,
                    "server": server,
                }),
            )
            .await;
            println!("Added MCP server '{}'.", name);
        }
        McpAction::Remove { name } => {
            let paths = ConfigPaths::discover(cwd)?;
            let mut removed_server = None;
            update_scope(&paths, ConfigScope::User, |document| {
                let mut servers = document
                    .get("mcp_servers")
                    .cloned()
                    .map(serde_json::from_value::<Vec<McpServerConfig>>)
                    .transpose()
                    .context("failed to parse user MCP server settings")?
                    .unwrap_or_default();
                let Some(index) = servers.iter().position(|server| server.name == name) else {
                    bail!("MCP server '{}' not found", name);
                };
                removed_server = Some(servers.remove(index));
                document["mcp_servers"] = serde_json::to_value(servers)?;
                Ok(())
            })?;
            run_cli_config_change_hook(
                cwd,
                "mcp_servers",
                serde_json::json!({
                    "scope": "mcp",
                    "action": "remove",
                    "name": name,
                    "server": removed_server,
                }),
            )
            .await;
            println!("Removed MCP server '{}'.", name);
        }
        McpAction::Test { name } => {
            let settings = Settings::load().unwrap_or_default();
            let config = settings
                .mcp_servers
                .iter()
                .find(|s| s.name == name)
                .ok_or_else(|| anyhow::anyhow!("MCP server '{}' not found", name))?;
            println!("Connecting to '{}'...", name);
            match mcp_connection::connect(config).await {
                Ok((_, tools)) => {
                    println!("Connected. Tools exposed by '{}':", name);
                    if tools.is_empty() {
                        println!("  (none)");
                    } else {
                        for tool in tools {
                            println!("  - {}", tool.name);
                        }
                    }
                }
                Err(e) => {
                    bail!("Failed to connect to '{}': {}", name, e);
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn run_plugin(
    action: PluginAction,
    cwd: &std::path::Path,
    settings: &kcoder_config::PluginsSettings,
) -> Result<()> {
    let manager = kcoder_plugins::PluginManager::open_default_for_cwd_with_effective_settings(
        cwd,
        settings.clone(),
    )
    .context("failed to open the managed plugin store")?;
    let project_trusted = cli_folder_trusted(cwd);
    match action {
        PluginAction::List { all, json } => {
            let mut result = manager
                .list(cwd, project_trusted)
                .context("failed to discover plugins")?;
            if !all {
                result.plugins.retain(|plugin| plugin.enabled);
            }
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
                return Ok(());
            }
            if result.plugins.is_empty() && result.diagnostics.is_empty() {
                println!("No plugins discovered.");
                println!(
                    "Search paths include project .kcoder/plugins, user plugins, and the managed store."
                );
                return Ok(());
            }
            println!("Plugin generation: {}", result.generation);
            if !result.plugins.is_empty() {
                println!("Plugins:");
                for plugin in &result.plugins {
                    let enabled = if plugin.enabled {
                        "enabled"
                    } else {
                        "disabled"
                    };
                    let version = plugin.version.as_deref().unwrap_or("unversioned");
                    let ownership = if plugin.managed { "managed" } else { "manual" };
                    println!(
                        "  {} ({}) [{}, {}]",
                        plugin.name, version, enabled, ownership
                    );
                    println!("    id: {}", plugin.id);
                    println!("    root: {}", plugin.root.display());
                    println!("    compatibility: {}", plugin.compatibility.level.as_str());
                    if !plugin.compatibility.deferred_capabilities.is_empty() {
                        println!(
                            "    deferred: {}",
                            plugin.compatibility.deferred_capabilities.join(", ")
                        );
                    }
                    if let Some(description) = &plugin.description
                        && !description.trim().is_empty()
                    {
                        println!("    {}", description);
                    }
                }
            }
            if !result.diagnostics.is_empty() {
                println!("Plugin diagnostics:");
                for diagnostic in &result.diagnostics {
                    println!(
                        "  [{}] {}: {}",
                        diagnostic.code,
                        diagnostic.root.display(),
                        diagnostic.message
                    );
                }
            }
        }
        PluginAction::Read { plugin_id, json } => {
            let plugin_id: kcoder_plugins::PluginId = plugin_id.parse()?;
            let result = manager
                .read(cwd, project_trusted, &plugin_id)?
                .with_context(|| format!("plugin {plugin_id} was not found"))?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!("{}", result.plugin.name);
                println!("  id: {}", result.plugin.id);
                println!(
                    "  version: {}",
                    result.plugin.version.as_deref().unwrap_or("unversioned")
                );
                println!("  enabled: {}", result.plugin.enabled);
                println!("  managed: {}", result.plugin.managed);
                println!("  root: {}", result.plugin.root.display());
                println!(
                    "  compatibility: {}",
                    result.plugin.compatibility.level.as_str()
                );
            }
        }
        PluginAction::Doctor { plugin_id, json } => {
            let parsed = plugin_id
                .as_deref()
                .map(str::parse::<kcoder_plugins::PluginId>)
                .transpose()?;
            let report = manager.doctor(cwd, project_trusted, parsed.as_ref())?;
            if json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!(
                    "Plugin health: {} (generation {})",
                    if report.healthy {
                        "healthy"
                    } else {
                        "issues found"
                    },
                    report.generation
                );
                for plugin in &report.plugins {
                    println!(
                        "  {}: {} ({} diagnostic(s))",
                        plugin.id,
                        plugin.compatibility.level.as_str(),
                        plugin.diagnostic_count
                    );
                }
                for diagnostic in &report.diagnostics {
                    println!(
                        "  [{}] {}: {}",
                        diagnostic.code,
                        diagnostic.root.display(),
                        diagnostic.message
                    );
                }
            }
        }
        PluginAction::Install {
            path,
            marketplace,
            name,
        } => {
            let record = match (path, marketplace, name) {
                (Some(path), None, None) => manager.install_local(&path)?,
                (None, Some(marketplace), Some(name)) => {
                    manager.install_from_marketplace(cwd, project_trusted, &marketplace, &name)?
                }
                _ => {
                    bail!("plugin install requires either --path or both --marketplace and --name")
                }
            };
            println!("Installed plugin {}.", record.plugin_id);
            println!(
                "  version: {}",
                record.version.as_deref().unwrap_or("unversioned")
            );
            println!("  root: {}", record.root(manager.store().root()).display());
            println!("Start a new session to use the updated plugin snapshot.");
        }
        PluginAction::Uninstall {
            plugin_id,
            purge_data,
        } => {
            let plugin_id: kcoder_plugins::PluginId = plugin_id.parse()?;
            if !manager.uninstall(&plugin_id, purge_data)? {
                bail!("plugin {plugin_id} is not installed");
            }
            println!("Uninstalled plugin {plugin_id}.");
            if !purge_data {
                println!("Plugin data was retained; pass --purge-data to remove it.");
            }
        }
        PluginAction::Enable { plugin_id } => {
            let plugin_id: kcoder_plugins::PluginId = plugin_id.parse()?;
            if manager.set_enabled(&plugin_id, true)? {
                println!("Enabled plugin {plugin_id}.");
            } else {
                println!("Plugin {plugin_id} was already enabled.");
            }
            println!("Start a new session to use the updated plugin snapshot.");
        }
        PluginAction::Disable { plugin_id } => {
            let plugin_id: kcoder_plugins::PluginId = plugin_id.parse()?;
            if manager.set_enabled(&plugin_id, false)? {
                println!("Disabled plugin {plugin_id}.");
            } else {
                println!("Plugin {plugin_id} was already disabled.");
            }
            println!("Start a new session to use the updated plugin snapshot.");
        }
    }
    Ok(())
}

pub(crate) fn run_marketplace(
    action: MarketplaceAction,
    cwd: &Path,
    settings: &kcoder_config::PluginsSettings,
) -> Result<()> {
    let manager = kcoder_plugins::PluginManager::open_default_for_cwd_with_effective_settings(
        cwd,
        settings.clone(),
    )
    .context("failed to open the managed plugin store")?;
    let project_trusted = cli_folder_trusted(cwd);
    match action {
        MarketplaceAction::List { json } => {
            let result = manager.marketplace_list(cwd, project_trusted)?;
            print_marketplace_result(&result, json)?;
        }
        MarketplaceAction::Add {
            marketplace_id,
            path,
        } => {
            manager.marketplace_add_with_trust(&marketplace_id, &path, cwd, project_trusted)?;
            println!("Added marketplace {marketplace_id}.");
        }
        MarketplaceAction::Remove { marketplace_id } => {
            if !manager.marketplace_remove(&marketplace_id)? {
                bail!("marketplace {marketplace_id} is not configured");
            }
            println!("Removed marketplace {marketplace_id}.");
        }
        MarketplaceAction::Refresh {
            marketplace_id,
            json,
        } => {
            let result =
                manager.marketplace_refresh(cwd, project_trusted, marketplace_id.as_deref())?;
            print_marketplace_result(&result, json)?;
        }
    }
    Ok(())
}

pub(crate) fn print_marketplace_result(
    result: &kcoder_plugins::MarketplaceListResult,
    json: bool,
) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(result)?);
        return Ok(());
    }
    if result.marketplaces.is_empty() && result.diagnostics.is_empty() {
        println!("No marketplaces configured.");
        return Ok(());
    }
    for marketplace in &result.marketplaces {
        println!(
            "{} [{}] - {} plugin(s)",
            marketplace.id,
            if marketplace.configured {
                "configured"
            } else {
                "project"
            },
            marketplace.plugins.len()
        );
        println!("  path: {}", marketplace.path.display());
        for plugin in &marketplace.plugins {
            println!(
                "  - {} ({})",
                plugin.plugin_id.plugin_name(),
                plugin.install_policy.as_str()
            );
        }
    }
    for diagnostic in &result.diagnostics {
        println!("[{}] {}", diagnostic.code, diagnostic.message);
    }
    Ok(())
}

pub(crate) fn cli_folder_trusted(cwd: &Path) -> bool {
    if kcoder_config::FolderTrustStore::trust_all_from_environment() {
        return true;
    }
    kcoder_config::user_config_dir()
        .map(|config_dir| kcoder_config::FolderTrustStore::load(&config_dir))
        .is_ok_and(|store| store.check(cwd) == kcoder_config::FolderTrust::Trusted)
}

pub(crate) fn parse_key_value_pairs(pairs: &[String]) -> Result<HashMap<String, String>> {
    let mut map = HashMap::new();
    for pair in pairs {
        let (key, value) = pair
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("invalid KEY=VALUE pair: {}", pair))?;
        map.insert(key.to_string(), value.to_string());
    }
    Ok(map)
}

pub(crate) fn mask_secret(secret: Option<&str>) -> String {
    if secret.is_some() {
        "configured".to_string()
    } else {
        "not set".to_string()
    }
}
