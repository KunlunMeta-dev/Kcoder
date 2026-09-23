use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use clap::{Parser, ValueEnum};
#[cfg(test)]
use kcoder_api::missing_api_key_message;
use kcoder_api::{
    ApiErrorKind, MissingApiKeyError, Provider, ProviderBuildOverrides, ProviderFactory,
    ProviderKind as ApiProviderKind, ProviderStream,
};
use kcoder_config::{
    ConfigPaths, ConfigScope, CredentialBackend, CredentialStore, CredentialStoreMode,
    LoadedSettings, MigrationDirection, OsCredentialBackend, PermissionMode, ProviderCredential,
    Settings, SettingsLoader, builtin_provider_credentials, default_model_name, dotted_value,
    ensure_default_user_dotenv, ensure_project_gitignore, marker_for_provider,
    merge_settings_documents, migrate_deployment_settings, normalize_legacy_settings_document,
    remove_dotted_value, set_dotted_value, update_scope, user_dotenv_path, write_scope,
    write_scope_if_missing,
};
use kcoder_engine::{EngineEvent, QueryEngine, WorkspaceRuntimeServices};
use kcoder_mcp::{McpServerConfig, McpTool};
use kcoder_memory::MemoryManager;
use kcoder_permissions::{
    PermissionDecision, PermissionEngine, PermissionPrompt, PermissionResponse,
};
use kcoder_skills::SkillRegistry;
use kcoder_state::AppState;
use kcoder_tools::{
    ConfigTool, DenyAllUserQuestioner, OcrReviewTool, ToolRegistry, UserQuestionRequest,
    UserQuestionResponse, UserQuestioner, core_registry, default_registry, nano_registry,
};
#[cfg(test)]
use kcoder_types::Message;
use kcoder_types::MessagesRequest;
use serde_json::Value;

mod app_server;
mod build_identity;
mod cli_args;
mod daemon;
mod diagnostics;
mod headless;
mod headless_outcome;
mod internal_bootstrap;
mod mcp_connection;
mod model_configuration;
mod tui_dev_mock;

pub(crate) use headless::engine_event_json;

use cli_args::{
    AuthAction, Cli, Commands, ConfigAction, MarketplaceAction, McpAction, PluginAction,
    ToolProfile, TrustAction,
};
use diagnostics::{hook_startup_notice, init_tracing};

use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::{info, warn};
use tui_dev_mock::{MockScenarioProvider, TuiDevScenario};

struct SignedOutProvider {
    name: &'static str,
    error_message: String,
}

impl Provider for SignedOutProvider {
    fn name(&self) -> &'static str {
        self.name
    }

    fn api_key_configured(&self) -> Option<bool> {
        Some(false)
    }

    fn stream_messages(&self, _request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        Err(ApiErrorKind::Api {
            error_type: "missing_api_key".to_string(),
            message: self.error_message.clone(),
        })
    }
}

/// Auto-deciding permission prompt for headless mode.
struct HeadlessPermissionPrompt {
    mode: PermissionMode,
}

#[async_trait::async_trait]
impl PermissionPrompt for HeadlessPermissionPrompt {
    async fn ask(
        &self,
        tool_name: &str,
        _description: String,
        _input: &serde_json::Value,
    ) -> PermissionResponse {
        match self.mode {
            PermissionMode::Bypass
            | PermissionMode::Yolo
            | PermissionMode::Auto
            | PermissionMode::AcceptEdits => PermissionResponse::AllowOnce,
            PermissionMode::Ask | PermissionMode::DontAsk => {
                eprintln!(
                    "\n[Permission required in headless mode: {} — denied]",
                    tool_name
                );
                PermissionResponse::DenyOnce
            }
        }
    }
}

async fn run_cli_config_change_hook(cwd: &Path, query: impl Into<String>, data: serde_json::Value) {
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

/// Interactive question prompt for headless mode.
struct HeadlessUserQuestioner;

#[async_trait]
impl UserQuestioner for HeadlessUserQuestioner {
    async fn ask(&self, request: UserQuestionRequest) -> Result<UserQuestionResponse, String> {
        let mut answers = std::collections::HashMap::new();
        for question in request.questions {
            eprintln!("\n[Question] {}", question.question);
            for (i, opt) in question.options.iter().enumerate() {
                eprintln!("  {}. {} - {}", i + 1, opt.label, opt.description);
            }
            eprint!(
                "Enter choice number{}: ",
                if question.multi_select {
                    "s (comma-separated)"
                } else {
                    ""
                }
            );
            let _ = std::io::stderr().flush();
            let mut line = String::new();
            match std::io::stdin().read_line(&mut line) {
                Ok(_) => {
                    let indices: Vec<usize> = line
                        .split(',')
                        .filter_map(|s| s.trim().parse::<usize>().ok())
                        .filter(|&n| n > 0 && n <= question.options.len())
                        .collect();
                    let selected: Vec<String> = indices
                        .iter()
                        .map(|&n| question.options[n - 1].label.clone())
                        .collect();
                    if selected.is_empty() {
                        return Err("no valid option selected".to_string());
                    }
                    answers.insert(question.question, selected.join(", "));
                }
                Err(e) => return Err(format!("failed to read answer: {}", e)),
            }
        }
        Ok(UserQuestionResponse {
            questions: Vec::new(),
            answers,
            annotations: None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum ProviderKind {
    Anthropic,
    Openai,
    #[value(alias = "vllm", alias = "sglang", alias = "openai-compatible")]
    Local,
    Gemini,
    Grok,
    #[value(alias = "kunlun-meta", alias = "kunlun_meta")]
    Kunlunmeta,
}

impl ProviderKind {
    fn from_env() -> Option<ApiProviderKind> {
        ApiProviderKind::from_env()
    }

    #[cfg(test)]
    fn parse_settings_value(value: &str) -> Option<ApiProviderKind> {
        ApiProviderKind::parse(value)
    }

    fn from_settings(settings: &Settings) -> Result<Option<ApiProviderKind>> {
        ApiProviderKind::from_settings(settings)
    }
}

fn resolve_provider_kind(
    cli_provider: Option<&str>,
    env_provider: Option<ApiProviderKind>,
    settings: &Settings,
) -> Result<ApiProviderKind> {
    if let Some(provider) = cli_provider {
        if let Some(provider) = ApiProviderKind::parse(provider) {
            return Ok(provider);
        }
        return ProviderKind::from_settings(settings)?.ok_or_else(|| {
            anyhow::anyhow!("custom provider '{provider}' must declare an api_format")
        });
    }
    if let Some(provider) = env_provider {
        return Ok(provider);
    }
    Ok(ProviderKind::from_settings(settings)?.unwrap_or(ApiProviderKind::Kunlunmeta))
}

/// Endpoint of the provider that will actually serve this session, used to
/// decide whether the `auto` tool profile should treat the target as a local
/// runtime (Ollama, llama.cpp, vLLM, SGLang, LM Studio).
fn active_provider_endpoint(settings: &Settings) -> Option<&str> {
    if let Some(active) = settings.active_provider.as_deref()
        && let Some(profile) = settings.providers.get(active)
    {
        return Some(profile.endpoint.as_str());
    }
    settings.base_url.as_deref()
}

/// Model API kind for the session commands.
///
/// `auth` carries its own `--provider`, which names a credential (and may be an id that is not a
/// transport at all). The global flag is marked `global = true`, so Clap also fills the global
/// one for `auth` invocations; resolving it as a transport would reject every such id.
fn cli_provider_kind(
    cli: &Cli,
    env_provider: Option<ApiProviderKind>,
    settings: &Settings,
) -> Result<ApiProviderKind> {
    if matches!(cli.command, Some(Commands::Auth { .. })) {
        return Ok(env_provider.unwrap_or(ApiProviderKind::Kunlunmeta));
    }
    resolve_cli_provider_kind(cli, env_provider, settings)
}

fn resolve_cli_provider_kind(
    cli: &Cli,
    env_provider: Option<ApiProviderKind>,
    settings: &Settings,
) -> Result<ApiProviderKind> {
    if cli
        .model
        .as_deref()
        .is_some_and(|model| model.contains("::"))
    {
        // A qualified model selector explicitly owns its transport identity.
        resolve_provider_kind(None, None, settings)
    } else {
        resolve_provider_kind(cli.provider.as_deref(), env_provider, settings)
    }
}

fn apply_cli_settings_overrides(settings: &mut Settings, cli: &Cli) -> Result<()> {
    if cli.profile.is_some() {
        settings.apply_provider(cli.profile.as_deref())?;
    }
    if let Some(provider) = non_empty(cli.provider.clone()) {
        if cli.profile.is_none() && settings.providers.contains_key(&provider) {
            settings.apply_provider(Some(&provider))?;
        } else {
            // Direct selection of a built-in transport must not inherit protocol or endpoint from the previously active provider.
            settings.active_provider = None;
            settings.active_model_selection = None;
            settings.api_format = None;
            settings.base_url = None;
            settings.request_timeout_secs = None;
            settings.provider_no_proxy = false;
            settings.provider_extra_body.clear();
            settings.provider_chat_protocol = kcoder_types::ChatProtocol::Auto;
            settings.provider = Some(provider);
        }
    }
    if let Some(model) = non_empty(cli.model.clone()) {
        if let Some((provider, model)) = model.split_once("::") {
            settings.apply_discovered_model(provider, model)?;
        } else if let Some(provider) = settings.active_provider.clone() {
            settings.apply_discovered_model(&provider, &model)?;
        } else {
            settings.model = model;
        }
    }
    if settings.model.trim().is_empty() {
        settings.model = default_model_name();
    }
    if let Some(max_tokens) = cli.max_tokens {
        settings.max_tokens = Some(max_tokens);
    }
    if let Some(max_retries) = cli.max_retries {
        settings.max_retries = max_retries;
    }
    if let Some(max_duration_secs) = cli.max_duration_secs {
        settings.max_duration_secs = Some(max_duration_secs);
    }
    if let Some(retry_base_delay_ms) = cli.retry_base_delay_ms {
        settings.retry_base_delay_ms = retry_base_delay_ms;
    }
    let summary_profile_was_explicit = cli.summary_profile.is_some();
    if summary_profile_was_explicit {
        settings.summary_profile = optional_runtime_name(cli.summary_profile.as_deref());
    } else if cli.summary_provider.is_some() || cli.summary_model.is_some() {
        settings.summary_profile = None;
    }
    if cli.summary_provider.is_some() {
        settings.summary_provider = optional_runtime_name(cli.summary_provider.as_deref());
    }
    if cli.summary_model.is_some() {
        settings.summary_model = optional_runtime_name(cli.summary_model.as_deref());
    }
    if let Some(summary_max_tokens) = cli.summary_max_tokens {
        settings.summary_max_tokens = summary_max_tokens.max(1);
    }
    if let Some(permission_mode) = cli.permission_mode {
        settings.permission_mode = permission_mode.into();
    }
    if let Some(api_key) = non_empty(cli.api_key.clone()) {
        settings.api_key = Some(api_key);
    }
    if let Some(api_key) = non_empty(cli.openai_api_key.clone()) {
        settings.openai_api_key = Some(api_key);
    }
    if let Some(api_key) = non_empty(cli.local_api_key.clone()) {
        settings.local_api_key = Some(api_key);
    }
    if let Some(api_key) = non_empty(cli.gemini_api_key.clone()) {
        settings.gemini_api_key = Some(api_key);
    }
    if let Some(api_key) = non_empty(cli.grok_api_key.clone()) {
        settings.grok_api_key = Some(api_key);
    }
    if let Some(base_url) = non_empty(cli.base_url.clone()) {
        settings.base_url = Some(base_url);
    }
    if let Some(value) = non_empty(cli.openai_base_url.clone()) {
        settings.openai_base_url = Some(value);
    }
    if let Some(value) = non_empty(cli.openai_user_agent.clone()) {
        settings.openai_user_agent = Some(value);
    }
    if let Some(value) = non_empty(cli.local_base_url.clone()) {
        settings.local_base_url = Some(value);
    }
    settings.tui.no_alt_screen = cli.no_alt_screen;
    settings.auto_skill_review_enabled = cli.skill_review;
    if cli.training_mode {
        settings.enable_training_mode();
    }
    Ok(())
}

fn runtime_override_source(cli: &Cli, key: &str) -> Option<&'static str> {
    if cli.profile.is_some()
        && matches!(
            key,
            "model"
                | "provider"
                | "api_format"
                | "base_url"
                | "context_window_tokens"
                | "context_output_headroom"
                | "max_tokens"
                | "model_reasoning_effort"
        )
    {
        return Some("CLI profile");
    }
    let overridden = match key {
        "model" => cli.model.is_some(),
        "provider" => cli.provider.is_some(),
        "max_tokens" => cli.max_tokens.is_some(),
        "max_retries" => cli.max_retries.is_some(),
        "max_duration_secs" => cli.max_duration_secs.is_some(),
        "retry_base_delay_ms" => cli.retry_base_delay_ms.is_some(),
        "summary_provider" => cli.summary_provider.is_some(),
        "summary_profile" => cli.summary_profile.is_some(),
        "summary_model" => cli.summary_model.is_some(),
        "summary_max_tokens" => cli.summary_max_tokens.is_some(),
        "permission_mode" => cli.permission_mode.is_some(),
        "base_url" => cli.base_url.is_some(),
        "openai_base_url" => cli.openai_base_url.is_some(),
        "local_base_url" => cli.local_base_url.is_some(),
        _ => false,
    };
    overridden.then_some("CLI/environment")
}

fn runtime_plugin_snapshot(
    cwd: &std::path::Path,
    folder_trusted: bool,
    settings: &Settings,
) -> Result<kcoder_plugins::EffectivePluginSnapshot> {
    if settings.training_mode {
        return Ok(kcoder_plugins::EffectivePluginSnapshot::default());
    }
    kcoder_plugins::PluginRegistry::discover_with_trust_and_settings(
        cwd,
        folder_trusted,
        &settings.plugins,
    )
    .map(|registry| registry.effective_snapshot())
}

fn apply_training_skill_isolation(settings: &Settings, registry: &mut SkillRegistry) {
    if settings.training_mode {
        registry.remove_named("kcoder-settings");
    }
}

fn optional_runtime_name(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty()
        || value.eq_ignore_ascii_case("current")
        || value.eq_ignore_ascii_case("default")
        || value.eq_ignore_ascii_case("none")
    {
        None
    } else {
        Some(value.to_string())
    }
}

fn canonicalize_cli_cwd(cwd: PathBuf) -> PathBuf {
    dunce::canonicalize(&cwd).unwrap_or(cwd)
}

fn load_unified_user_dotenv(config_dir: &Path) -> Result<PathBuf> {
    let dotenv_path = ensure_default_user_dotenv(config_dir)?;
    dotenvy::from_path(&dotenv_path).with_context(|| {
        format!(
            "failed to load unified user environment from {}",
            dotenv_path.display()
        )
    })?;
    Ok(dotenv_path)
}

fn ensure_default_user_settings(cwd: &Path, config_dir: &Path) -> Result<PathBuf> {
    let paths = ConfigPaths::with_config_dir(cwd, config_dir.to_path_buf());
    let value = initial_config_scope_document(ConfigScope::User);
    write_scope_if_missing(&paths, ConfigScope::User, &value)?;
    Ok(paths.user_settings)
}

fn main() -> Result<()> {
    // Version queries are read-only probes and must be handled before configuration
    // bootstrap or first-start writes. Do not parse regular arguments early because
    // Clap environment variables from the user's .env must load before full parsing.
    if matches!(
        std::env::args_os().skip(1).collect::<Vec<_>>().as_slice(),
        [arg] if arg == "--version" || arg == "-V"
    ) {
        println!("kcoder {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let raw_args = std::env::args_os().collect::<Vec<_>>();
    // Template previews are pure data and must precede all first-start writes.
    if let Ok(parsed) = Cli::try_parse_from(&raw_args)
        && let Some(Commands::Config { action }) = parsed.command
        && let Some(value) = provider_template_output(&action)?
    {
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    let read_only_doctor = is_read_only_doctor_invocation(&raw_args);
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let cwd = canonicalize_cli_cwd(cwd);
    let bootstrap_outcome = if read_only_doctor {
        None
    } else {
        internal_bootstrap::bootstrap_from_current_exe(&cwd)?
    };
    let config_dir = kcoder_config::user_config_dir()?;
    if read_only_doctor {
        let dotenv = user_dotenv_path(&config_dir);
        if dotenv.is_file() {
            dotenvy::from_path(&dotenv).with_context(|| {
                format!(
                    "failed to load unified user environment from {}",
                    dotenv.display()
                )
            })?;
        }
    } else {
        load_unified_user_dotenv(&config_dir)?;
        kcoder_config::ensure_user_settings_schema(&config_dir)?;
        kcoder_skills::ensure_builtin_skills(&config_dir)?;
        ensure_default_user_settings(&cwd, &config_dir)?;
    }
    run(bootstrap_outcome)
}

fn is_read_only_doctor_invocation(args: &[std::ffi::OsString]) -> bool {
    Cli::try_parse_from(args)
        .ok()
        .is_some_and(|cli| matches!(cli.command, Some(Commands::Doctor)))
}

#[tokio::main]
async fn run(bootstrap_outcome: Option<internal_bootstrap::BootstrapOutcome>) -> Result<()> {
    let cli = Cli::parse();
    let interactive_tui =
        cli.prompt.is_none() && matches!(cli.command, None | Some(Commands::TuiDev { .. }));
    init_tracing(interactive_tui);

    let cwd = cli
        .cwd
        .clone()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let cwd = canonicalize_cli_cwd(cwd);
    if let Some(outcome) = bootstrap_outcome {
        eprintln!(
            "Initialized bundled company configuration (settings: {}, credentials: {}, .env: {}).",
            if outcome.settings_written {
                "written"
            } else {
                "kept"
            },
            if outcome.credentials_written {
                "written"
            } else {
                "kept"
            },
            if outcome.dotenv_written {
                "written"
            } else {
                "kept"
            }
        );
    }
    let include_bundled_providers =
        std::env::var("KCODER_INCLUDE_BUNDLED_PROFILES").is_ok_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        });
    let settings_loader = SettingsLoader::new(&cwd)
        .with_overlay_files(cli.settings_files.clone())
        .with_bundled_providers(include_bundled_providers);

    if let Some(Commands::Config { action }) = cli.command.clone() {
        return run_config(action, &settings_loader, &cli, &cwd).await;
    }
    if let Some(Commands::Trust { action }) = cli.command.clone() {
        return run_trust_action(action, &cwd);
    }

    let deterministic_scenario = matches!(
        cli.command,
        Some(Commands::TuiDev { .. })
            | Some(Commands::AppServer {
                scenario: Some(_),
                ..
            })
    );
    let loaded_settings = match settings_loader.load() {
        Ok(settings) => settings,
        Err(error) if deterministic_scenario => {
            warn!("failed to load settings for deterministic scenario; using defaults: {error:?}");
            LoadedSettings {
                settings: Settings::default(),
                model_runtime_overrides: Default::default(),
                model_configuration_sources: Default::default(),
                paths: settings_loader.paths()?,
                loaded_sources: Vec::new(),
                overlay_sources: Vec::new(),
                overlay_fields: Default::default(),
                field_sources: Default::default(),
                plaintext_secret_setting_names: Vec::new(),
            }
        }
        Err(error) => return Err(error).context("failed to load settings"),
    };
    let mut settings = loaded_settings.settings.clone();
    apply_cli_settings_overrides(&mut settings, &cli)?;
    if let Some(path) = cli.credential_env_file.as_deref() {
        apply_credential_env_file(&mut settings, path)?;
    }
    emit_plaintext_settings_secret_warning_names(&loaded_settings.plaintext_secret_setting_names);

    let provider_kind = cli_provider_kind(&cli, ProviderKind::from_env(), &settings)?;

    match cli.command.clone() {
        Some(Commands::Doctor) => {
            return run_doctor(&provider_kind, &cli, &settings, &cwd, &loaded_settings);
        }
        Some(Commands::MoaPlan { .. }) => {}
        Some(Commands::Auth { action }) => {
            return run_auth_action(
                action.unwrap_or(AuthAction::Status),
                &cli,
                &settings,
                &loaded_settings.paths,
            );
        }
        Some(Commands::Config { .. }) => unreachable!("config handled before settings load"),
        Some(Commands::Trust { .. }) => unreachable!("trust handled before settings load"),
        Some(Commands::TuiDev { scenario }) => {
            return run_tui_dev(
                &cli,
                settings,
                scenario,
                loaded_settings.paths.user_settings.clone(),
            )
            .await;
        }
        Some(Commands::Mcp { action }) => return run_mcp(action, &cwd).await,
        Some(Commands::Daemon { action }) => return daemon::run(action).await,
        Some(Commands::AppServer { listen, scenario }) => {
            if listen != "stdio://" && listen != "stdio" {
                bail!("unsupported app-server transport '{listen}'; use stdio://");
            }
            if let Some(scenario) = scenario {
                return run_app_server_dev(
                    &cli,
                    settings,
                    scenario,
                    loaded_settings.paths.user_settings.clone(),
                )
                .await;
            }
        }
        Some(Commands::Plugin { action }) => {
            let cwd = cli
                .cwd
                .clone()
                .or_else(|| std::env::current_dir().ok())
                .unwrap_or_else(|| PathBuf::from("."));
            let cwd = canonicalize_cli_cwd(cwd);
            return run_plugin(action, &cwd, &settings.plugins);
        }
        Some(Commands::Marketplace { action }) => {
            let cwd = cli
                .cwd
                .clone()
                .or_else(|| std::env::current_dir().ok())
                .unwrap_or_else(|| PathBuf::from("."));
            let cwd = canonicalize_cli_cwd(cwd);
            return run_marketplace(action, &cwd, &settings.plugins);
        }
        None => {}
    }

    // Acquire this before providers, memory, skills, workspace services, or the engine
    // access cwd. Together with the exclusive archival lease for managed worktrees,
    // it forms a cross-process admission gate.
    let _app_server_workspace_lease = matches!(cli.command, Some(Commands::AppServer { .. }))
        .then(|| app_server::acquire_app_server_workspace_runtime_lease(&cwd))
        .transpose()?;

    let model = settings.model.clone();
    let provider_result = ProviderFactory::new(&settings)
        .with_overrides(provider_overrides_from_cli(&cli))
        .build(provider_kind, &model);
    let (provider, signed_out_notice): (Arc<dyn Provider>, Option<String>) = match provider_result {
        Ok(provider) => (provider, None),
        Err(error)
            if cli.prompt.is_none()
                && !cli.json
                && !matches!(cli.command, Some(Commands::MoaPlan { .. }))
                && error.downcast_ref::<MissingApiKeyError>().is_some() =>
        {
            let error_message = error.to_string();
            let notice = format!(
                "Not signed in for {}. Run `kcoder auth login --provider {}` and restart. You can enter KCoder now, but model requests require an API key.",
                provider_kind.as_str(),
                provider_kind.as_str()
            );
            (
                Arc::new(SignedOutProvider {
                    name: provider_kind.as_str(),
                    error_message,
                }),
                Some(notice),
            )
        }
        Err(error) => return Err(error),
    };

    let model_configuration = Arc::new(model_configuration::ModelConfiguration::new(
        settings_loader.clone().freeze_overlays()?,
        cli.clone(),
    ));
    let provider = model_configuration.with_live_credentials(&settings, provider_kind, provider)?;

    info!("starting KCoder rust prototype");

    let state = if cli.resume.is_some() {
        AppState::new(&cwd)
    } else {
        AppState::new_with_short_id(&cwd, &Settings::config_dir()?.join("session-ids"))?
    };
    state.set_short_id_registry(&Settings::config_dir()?.join("session-ids"));
    configure_history_path(&settings, &state);
    let resume_notice = if let Some(resume) = cli.resume.as_deref() {
        let resume_path = resolve_resume_history_path(&settings, &cwd, resume)?;
        let restored = state
            .resume_from_history(&resume_path)
            .with_context(|| format!("failed to resume session from {}", resume_path.display()))?;
        let session_label = resume_path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| resume.to_string());
        eprintln!(
            "Resumed session {} ({} messages) from {}",
            session_label,
            restored,
            resume_path.display()
        );
        Some(format!(
            "Resumed session {session_label} ({restored} messages)"
        ))
    } else {
        None
    };
    apply_cli_orchestrate_mode(&state, cli.orchestrate, cli.resume.is_some())?;

    // Folder trust gate: project-level executable extensions (MCP servers,
    // hooks, plugins, skills) activate only for trusted directories.
    let trust_store_config_dir = Settings::config_dir()?;
    let mut trust_store = kcoder_config::FolderTrustStore::load(&trust_store_config_dir);
    let mut folder_trusted = kcoder_config::FolderTrustStore::trust_all_from_environment()
        || trust_store.check(&cwd) == kcoder_config::FolderTrust::Trusted;
    if !folder_trusted
        && trust_store.check(&cwd) == kcoder_config::FolderTrust::Unknown
        && project_has_extension_surface(&cwd)
    {
        folder_trusted = prompt_folder_trust(&cwd, &mut trust_store);
    }
    let project_mcp_names = project_mcp_server_names(&cwd);
    if !folder_trusted {
        // Strip project-layer MCP servers (user-level MCP config stays).
        let project_names = project_mcp_server_names(&cwd);
        if !project_names.is_empty() {
            settings
                .mcp_servers
                .retain(|server| !project_names.contains(&server.name));
        }
        if cli.prompt.is_some() || cli.json {
            eprintln!(
                "[kcoder] folder not trusted: project-level hooks, plugins, skills and MCP servers are disabled for {}",
                cwd.display()
            );
        }
    }
    let plugin_snapshot =
        runtime_plugin_snapshot(&cwd, folder_trusted, &settings).unwrap_or_else(|error| {
            warn!("failed to load plugin contribution snapshot: {error:#}");
            kcoder_plugins::EffectivePluginSnapshot::default()
        });
    let configured_mcp_server_count = settings.mcp_servers.len();
    settings
        .mcp_servers
        .extend(plugin_snapshot.mcp_configs.iter().cloned());

    let effective_tool_profile = cli
        .tool_profile
        .effective_with_endpoint(provider_kind, active_provider_endpoint(&settings));
    let mut tools = match effective_tool_profile {
        ToolProfile::Full => default_registry(),
        ToolProfile::Core => core_registry(),
        ToolProfile::Nano => nano_registry(),
        ToolProfile::None => ToolRegistry::new(),
        ToolProfile::Auto => unreachable!("auto tool profile should be resolved"),
    };
    if !matches!(effective_tool_profile, ToolProfile::None) {
        tools = tools.register(ConfigTool);
    }
    let session_builtin_tools = tools.clone();
    let is_app_server = matches!(cli.command, Some(Commands::AppServer { .. }));
    // Optional services must leave room for the Gateway's 12-second initialize handshake.
    let mcp_startup_deadline =
        is_app_server.then(|| tokio::time::Instant::now() + std::time::Duration::from_secs(8));
    let mut mcp_snapshot_complete = true;
    if !matches!(effective_tool_profile, ToolProfile::None) {
        for (server_index, server) in settings.mcp_servers.iter().enumerate() {
            let plugin_source = if server_index < configured_mcp_server_count {
                None
            } else if let Some(source) = plugin_snapshot
                .mcp_config_sources
                .get(server_index - configured_mcp_server_count)
            {
                Some(source)
            } else {
                let diagnostic = format!(
                    "MCP server {:?} rejected: plugin contribution has no source identity",
                    server.name
                );
                warn!("{diagnostic}");
                eprintln!("[kcoder] {diagnostic}");
                continue;
            };
            let connected = if let Some(deadline) = mcp_startup_deadline {
                tokio::time::timeout_at(deadline, mcp_connection::connect(server))
                    .await
                    .context("optional MCP startup deadline exceeded")
                    .and_then(std::convert::identity)
            } else {
                mcp_connection::connect(server).await
            };
            match connected {
                Ok((handle, mut defs)) => {
                    if let Some(source) = plugin_source {
                        defs.retain(|definition| source.tool_policy.allows(&definition.name));
                    }
                    info!(
                        "MCP server '{}' connected with {} tools",
                        server.name,
                        defs.len()
                    );
                    let conflicts = tools.extend(defs.into_iter().map(|definition| {
                        let tool = McpTool::new(&server.name, Arc::clone(&handle), definition);
                        let tool = match plugin_source {
                            Some(source) => tool.with_plugin_source(&source.plugin_id),
                            None => tool,
                        };
                        let required_trust = plugin_source.and_then(|source| source.required_trust_directory.as_deref())
                            .or_else(|| project_mcp_names.contains(&server.name).then_some(cwd.as_path()));
                        let tool = match required_trust {
                            Some(directory) => tool.with_folder_trust(directory, &trust_store_config_dir),
                            None => tool,
                        };
                        Arc::new(tool) as Arc<dyn kcoder_tools::Tool>
                    }));
                    for conflict in conflicts {
                        warn!("{conflict}");
                        eprintln!("[kcoder] {conflict}");
                    }
                }
                Err(e) => {
                    mcp_snapshot_complete = false;
                    warn!("failed to connect MCP server '{}': {e:#}", server.name);
                }
            }
        }
    }
    if !settings.tools.disabled.is_empty() {
        tools = tools.filtered_out_by_patterns(&settings.tools.disabled);
    }
    let mut permissions = PermissionEngine::from_settings(&settings);
    let permission_mode = settings.permission_mode;
    permissions.mode = permission_mode;
    let permissions = permissions.with_audit_log(Settings::config_dir()?.join("permissions.log"));

    let memory_store = kcoder_memory::MemoryStore::load().unwrap_or_else(|e| {
        warn!("failed to load memory store: {}, using empty store", e);
        kcoder_memory::MemoryStore::empty()
    });
    let memory_manager = MemoryManager::new(memory_store, &cwd, &settings.memory_dir()?)?;
    let mut external_skill_dirs = settings.skills.external_dirs.clone();
    external_skill_dirs.extend(plugin_snapshot.skill_roots.iter().cloned());
    let mut skill_registry = SkillRegistry::load_with_external_dirs_and_trust(
        &cwd,
        external_skill_dirs.iter(),
        folder_trusted,
    )
    .unwrap_or_else(|e| {
        warn!("failed to load skill registry: {}, using empty registry", e);
        SkillRegistry::empty()
    });
    for (root, directory) in &plugin_snapshot.skill_trust_roots {
        skill_registry.require_folder_trust(root, directory, Some(trust_store_config_dir.clone()));
    }
    apply_training_skill_isolation(&settings, &mut skill_registry);
    if let Err(failure) = required_skill_preflight(
        &cli.required_skills,
        folder_trusted,
        &skill_registry,
        &tools,
        &permissions,
        &cwd,
        cli.prompt.is_some() || cli.json,
    ) {
        emit_required_skill_preflight_failure(&failure, cli.json, state.session_id());
        bail!(failure.message);
    }
    if !matches!(cli.command, Some(Commands::AppServer { .. })) {
        ensure_project_gitignore(&cwd)?;
    }

    let history_directory = state
        .history_path()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    let (mut engine, app_server_factory) = if is_app_server {
        let workspace_services =
            WorkspaceRuntimeServices::try_new_for_client(&cwd, &state.session_id())?;
        let factory = app_server::AppServerEngineFactory::new(
            Arc::clone(&provider),
            tools.clone(),
            permissions.clone(),
            settings.clone(),
            memory_manager.clone(),
            skill_registry.clone(),
            plugin_snapshot.clone(),
            cwd.clone(),
            history_directory,
            folder_trusted,
            workspace_services,
            Some(loaded_settings.paths.user_settings.clone()),
            Settings::config_dir()?.join("session-ids"),
        )
        .with_session_configuration(
            settings_loader.clone(),
            cli.clone(),
            session_builtin_tools,
            mcp_snapshot_complete,
        )?;
        let engine = factory
            .build_with_state(state, Arc::new(DenyAllUserQuestioner))
            .context("failed to initialize app-server client session storage")?;
        (engine, Some(factory))
    } else {
        (
            QueryEngine::new_with_plugin_snapshot(
                provider,
                state,
                tools,
                permissions,
                settings,
                memory_manager,
                skill_registry,
                Arc::new(DenyAllUserQuestioner),
                cwd,
                plugin_snapshot,
            )
            .with_settings_persistence_path(loaded_settings.paths.user_settings.clone())
            .with_client_model_configuration(model_configuration),
            None,
        )
    };

    let startup_events = if is_app_server {
        Vec::new()
    } else {
        engine.run_startup_hooks().await
    };
    let startup_events = match resume_notice {
        Some(notice) => {
            let mut events = vec![EngineEvent::SystemNotice(notice)];
            events.extend(startup_events);
            events
        }
        None => startup_events,
    };

    if is_app_server {
        app_server::run(
            engine,
            app_server_factory.expect("app-server factory is constructed with its engine"),
            permission_mode,
        )
        .await
    } else if let Some(Commands::MoaPlan { prompt: request }) = cli.command.clone() {
        let preflight = engine.moa_plan_preflight()?;
        eprintln!(
            "MoA plan: {} planners, about {} context tokens per planner",
            preflight.planner_count, preflight.estimated_context_tokens_per_planner
        );
        let json_progress = cli.json;
        let progress = Arc::new(move |update: kcoder_engine::MoaPlanProgress| {
            if json_progress {
                println!(
                    "{}",
                    serde_json::json!({
                        "type": "moa_plan_progress",
                        "phase": update.phase,
                        "message": update.message,
                        "completed": update.completed,
                        "total": update.total,
                    })
                );
            } else {
                eprintln!(
                    "MoA plan: {} ({}/{})",
                    update.message, update.completed, update.total
                );
            }
        });
        let result = engine
            .run_moa_plan_with_progress(&request, progress)
            .await?;
        if cli.json {
            println!(
                "{}",
                serde_json::json!({
                    "type": "moa_plan_result",
                    "final_path": result.final_path,
                    "draft_paths": result.draft_paths,
                    "failed_planners": result.failed_planners,
                    "final_markdown": result.final_markdown,
                    "session_id": engine.session_id(),
                })
            );
        } else {
            println!("{}", result.final_markdown);
            eprintln!("Final plan: {}", result.final_path.display());
        }
        Ok(())
    } else if let Some(prompt) = cli.prompt {
        engine.set_user_questioner(Arc::new(HeadlessUserQuestioner));
        let prompt_cb = HeadlessPermissionPrompt {
            mode: permission_mode,
        };
        headless::run(&engine, prompt, &prompt_cb, cli.json, startup_events).await
    } else {
        let startup_notice = [signed_out_notice, hook_startup_notice(&startup_events)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let startup_notice = (!startup_notice.is_empty()).then(|| startup_notice.join("\n"));
        kcoder_repl::run_repl_with_engine(engine, startup_notice).await
    }
}

/// True when the working directory exposes a project-level executable
/// extension surface (hooks/MCP settings, skills, plugins).
fn project_has_extension_surface(cwd: &Path) -> bool {
    cwd.join(".kcoder").join("settings.json").is_file()
        || cwd.join(".kcoder").join("settings.local.json").is_file()
        || cwd.join(".kcoder").join("skills").is_dir()
        || cwd.join(".kcoder").join("plugins").is_dir()
}

fn run_trust_action(action: TrustAction, cwd: &Path) -> Result<()> {
    let config_dir = Settings::config_dir()?;
    let mut store = kcoder_config::FolderTrustStore::load(&config_dir);
    let requested_path = match &action {
        TrustAction::Status { path }
        | TrustAction::Add { path }
        | TrustAction::Revoke { path }
        | TrustAction::Never { path } => path.clone(),
    };
    let path = canonicalize_cli_cwd(if requested_path.is_absolute() {
        requested_path
    } else {
        cwd.join(requested_path)
    });

    match action {
        TrustAction::Status { .. } => {
            let decision = match store.check(&path) {
                kcoder_config::FolderTrust::Trusted => "trusted",
                kcoder_config::FolderTrust::Never => "never",
                kcoder_config::FolderTrust::Unknown => "unknown",
            };
            println!("{}\t{}", decision, path.display());
        }
        TrustAction::Add { .. } => {
            if !path.is_dir() {
                bail!(
                    "trust target is not an existing directory: {}",
                    path.display()
                );
            }
            store.trust(&path)?;
            println!("trusted\t{}", path.display());
        }
        TrustAction::Revoke { .. } => {
            store.revoke(&path)?;
            println!("unknown\t{}", path.display());
        }
        TrustAction::Never { .. } => {
            if !path.is_dir() {
                bail!(
                    "trust target is not an existing directory: {}",
                    path.display()
                );
            }
            store.never(&path)?;
            println!("never\t{}", path.display());
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RequiredSkillPreflightFailure {
    skill: String,
    reason: &'static str,
    message: String,
    remediation: String,
}

fn required_skill_preflight(
    required_skills: &[String],
    folder_trusted: bool,
    registry: &SkillRegistry,
    tools: &ToolRegistry,
    permissions: &PermissionEngine,
    cwd: &Path,
    headless: bool,
) -> std::result::Result<(), RequiredSkillPreflightFailure> {
    let mut names = required_skills
        .iter()
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    names.sort_unstable();
    names.dedup();

    for name in names {
        if registry.get_active(name).is_none() {
            let project_copy = find_project_skill_file(cwd, name);
            let (reason, remediation) = if !folder_trusted && project_copy.is_some() {
                (
                    "project_not_trusted",
                    format!("kcoder trust add --path {}", cwd.display()),
                )
            } else {
                (
                    "required_skill_missing",
                    format!("install or create the `{name}` skill before starting this run"),
                )
            };
            return Err(RequiredSkillPreflightFailure {
                skill: name.to_string(),
                reason,
                message: format!(
                    "required skill `{name}` is unavailable before model startup ({reason})"
                ),
                remediation,
            });
        }

        let Some(skill_tool) = tools.get("skill") else {
            return Err(RequiredSkillPreflightFailure {
                skill: name.to_string(),
                reason: "skill_tool_unavailable",
                message: format!(
                    "required skill `{name}` is loaded, but the `skill` tool is not in the active tool profile"
                ),
                remediation: "use --tool-profile full so the skill tool is available".to_string(),
            });
        };
        let decision = permissions.decide(skill_tool.as_ref(), &serde_json::json!({"skill": name}));
        if decision == PermissionDecision::Deny
            || (headless
                && decision == PermissionDecision::Ask
                && matches!(
                    permissions.mode,
                    PermissionMode::Ask | PermissionMode::DontAsk
                ))
        {
            return Err(RequiredSkillPreflightFailure {
                skill: name.to_string(),
                reason: "skill_permission_denied",
                message: format!(
                    "required skill `{name}` is loaded, but current permissions deny the `skill` tool"
                ),
                remediation: "allow the `skill` tool in the selected project permission profile"
                    .to_string(),
            });
        }
    }
    Ok(())
}

fn find_project_skill_file(cwd: &Path, skill_name: &str) -> Option<PathBuf> {
    let relative_name = skill_name.replace(':', "/");
    for directory in cwd.ancestors() {
        let candidate = directory
            .join(".kcoder")
            .join("skills")
            .join(&relative_name)
            .join("SKILL.md");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn emit_required_skill_preflight_failure(
    failure: &RequiredSkillPreflightFailure,
    json: bool,
    session_id: String,
) {
    if json {
        let mut event = serde_json::json!({
            "type": "preflight_failed",
            "check": "required_skill",
            "skill": failure.skill,
            "reason": failure.reason,
            "remediation": failure.remediation,
            "state_mutated": false,
        });
        build_identity::add_to_json(&mut event);
        println!("{event}");

        let mut result = serde_json::json!({
            "type": "result",
            "subtype": "error",
            "run_status": "completed",
            "task_status": "blocked",
            "termination_reason": "required_skill_unavailable",
            "session_id": session_id,
            "timed_out": false,
            "retryable": false,
            "resume_safe": true,
            "nudge_sent": false,
            "work_remaining": [format!("load required skill `{}`", failure.skill)],
            "error": failure.message,
        });
        build_identity::add_to_json(&mut result);
        println!("{result}");
    } else {
        eprintln!("[preflight blocked] {}", failure.message);
        eprintln!("Remediation: {}", failure.remediation);
    }
}

/// Names of MCP servers declared by project-layer settings files; these are
/// stripped when the folder is untrusted (user-level MCP config is kept).
fn project_mcp_server_names(cwd: &Path) -> std::collections::BTreeSet<String> {
    let mut names = std::collections::BTreeSet::new();
    for file in ["settings.json", "settings.local.json"] {
        let path = cwd.join(".kcoder").join(file);
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if let Some(servers) = json.get("mcp_servers").and_then(|value| value.as_array()) {
            for server in servers {
                if let Some(name) = server.get("name").and_then(|value| value.as_str()) {
                    names.insert(name.to_string());
                }
            }
        }
    }
    names
}

/// One-time interactive trust prompt shown before the TUI starts. Non-TTY
/// stdin (headless/CI) means "skip", matching headless permission behavior.
fn prompt_folder_trust(cwd: &Path, store: &mut kcoder_config::FolderTrustStore) -> bool {
    use std::io::IsTerminal as _;
    if !std::io::stdin().is_terminal() {
        return false;
    }
    eprintln!();
    eprintln!(
        "This project contains executable extensions (.kcoder hooks/MCP settings, skills, plugins)."
    );
    eprintln!("They can run commands inside this session.");
    eprint!(
        "Trust {}? [y] trust / [n] skip / [never] never: ",
        cwd.display()
    );
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return false;
    }
    match line.trim() {
        "y" | "Y" | "yes" => {
            if let Err(error) = store.trust(cwd) {
                warn!("failed to persist folder trust: {error}");
            }
            true
        }
        "never" | "N" => {
            if let Err(error) = store.never(cwd) {
                warn!("failed to persist folder trust: {error}");
            }
            false
        }
        _ => false,
    }
}

async fn run_tui_dev(
    cli: &Cli,
    mut settings: Settings,
    scenario: TuiDevScenario,
    settings_persistence_path: PathBuf,
) -> Result<()> {
    let (engine, _) =
        build_tui_dev_engine(cli, &mut settings, scenario, settings_persistence_path)?;
    let startup_notice = Some(format!(
        "TUI dev mode is running mock scenario `{}`. Type any message and press Enter to {}.",
        scenario.as_str(),
        scenario.startup_description()
    ));
    kcoder_repl::run_repl_with_engine(engine, startup_notice).await
}

async fn run_app_server_dev(
    cli: &Cli,
    mut settings: Settings,
    scenario: TuiDevScenario,
    settings_persistence_path: PathBuf,
) -> Result<()> {
    let cwd = cli
        .cwd
        .clone()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let cwd = canonicalize_cli_cwd(cwd);
    let _workspace_runtime_lease = app_server::acquire_app_server_workspace_runtime_lease(&cwd)?;
    let permission_mode = PermissionMode::Bypass;
    let (engine, factory) =
        build_tui_dev_engine(cli, &mut settings, scenario, settings_persistence_path)?;
    engine.activate_client_session();
    app_server::run(
        engine,
        factory.context("app-server dev engine requires a factory")?,
        permission_mode,
    )
    .await
}

fn build_tui_dev_engine(
    cli: &Cli,
    settings: &mut Settings,
    scenario: TuiDevScenario,
    settings_persistence_path: PathBuf,
) -> Result<(QueryEngine, Option<app_server::AppServerEngineFactory>)> {
    settings.model = "tui-dev-mock".to_string();
    settings.permission_mode = PermissionMode::Bypass;
    settings.auto_skill_review_enabled = false;

    let cwd = cli
        .cwd
        .clone()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let cwd = canonicalize_cli_cwd(cwd);

    if matches!(cli.command, Some(Commands::TuiDev { .. })) {
        ensure_project_gitignore(&cwd)?;
    }
    let state = AppState::new(&cwd);
    configure_history_path(settings, &state);
    // `tui-dev`/deterministic app-server bypass the normal engine construction
    // branch above, but CLI session-mode semantics must remain identical so the
    // real TUI harness can exercise the Orchestrate surface.
    apply_cli_orchestrate_mode(&state, cli.orchestrate, false)?;
    let tools = match scenario {
        TuiDevScenario::SubagentTrace | TuiDevScenario::GoalPro => {
            default_registry().register(ConfigTool)
        }
        _ => core_registry().register(OcrReviewTool).register(ConfigTool),
    };

    let mut permissions = PermissionEngine::from_settings(settings);
    permissions.mode = PermissionMode::Bypass;
    let permissions = permissions.with_audit_log(Settings::config_dir()?.join("permissions.log"));

    let memory_store = kcoder_memory::MemoryStore::load().unwrap_or_else(|e| {
        warn!(
            "failed to load memory store for tui-dev: {}, using empty store",
            e
        );
        kcoder_memory::MemoryStore::empty()
    });
    let memory_manager = MemoryManager::new(memory_store, &cwd, &settings.memory_dir()?)?;
    let plugin_snapshot = runtime_plugin_snapshot(&cwd, true, settings).unwrap_or_else(|error| {
        warn!("failed to load tui-dev plugin contribution snapshot: {error:#}");
        kcoder_plugins::EffectivePluginSnapshot::default()
    });
    let mut external_skill_dirs = settings.skills.external_dirs.clone();
    external_skill_dirs.extend(plugin_snapshot.skill_roots.iter().cloned());
    let mut skill_registry =
        SkillRegistry::load_with_external_dirs(&cwd, external_skill_dirs.iter()).unwrap_or_else(
            |e| {
                warn!(
                    "failed to load skill registry for tui-dev: {}, using empty registry",
                    e
                );
                SkillRegistry::empty()
            },
        );
    apply_training_skill_isolation(settings, &mut skill_registry);

    let provider: Arc<dyn Provider> = Arc::new(MockScenarioProvider::new(scenario));
    if matches!(cli.command, Some(Commands::AppServer { .. })) {
        let history_directory = state
            .history_path()
            .and_then(|path| path.parent().map(Path::to_path_buf));
        let workspace_services =
            WorkspaceRuntimeServices::try_new_for_client(&cwd, &state.session_id())?;
        let factory = app_server::AppServerEngineFactory::new(
            Arc::clone(&provider),
            tools,
            permissions,
            settings.clone(),
            memory_manager,
            skill_registry,
            plugin_snapshot.clone(),
            cwd,
            history_directory,
            true,
            workspace_services,
            Some(settings_persistence_path),
            Settings::config_dir()?.join("session-ids"),
        );
        let engine = factory
            .build_with_state(state, Arc::new(DenyAllUserQuestioner))
            .context("failed to initialize tui-dev app-server client session storage")?;
        Ok((engine, Some(factory)))
    } else {
        Ok((
            QueryEngine::new_with_plugin_snapshot(
                provider,
                state,
                tools,
                permissions,
                settings.clone(),
                memory_manager,
                skill_registry,
                Arc::new(DenyAllUserQuestioner),
                cwd,
                plugin_snapshot,
            )
            .with_settings_persistence_path(settings_persistence_path),
            None,
        ))
    }
}

fn history_dir_for_session(settings: &Settings, cwd: &std::path::Path) -> Result<PathBuf> {
    if settings.history_directory.is_some() || std::env::var_os("KCODER_HISTORY_DIR").is_some() {
        settings.history_dir()
    } else {
        Settings::project_data_dir(cwd)
    }
}

fn history_dirs_for_read(settings: &Settings, cwd: &std::path::Path) -> Result<Vec<PathBuf>> {
    if settings.history_directory.is_some() || std::env::var_os("KCODER_HISTORY_DIR").is_some() {
        return settings.history_dir().map(|dir| vec![dir]);
    }
    Settings::project_data_dirs_for_read(cwd)
}

fn apply_cli_orchestrate_mode(state: &AppState, requested: bool, resumed: bool) -> Result<()> {
    if !requested {
        return Ok(());
    }
    if resumed && state.session_mode().is_default() {
        bail!(
            "cannot combine --orchestrate with a resumed default session; start a new session or resume an existing Orchestrate session without the flag"
        );
    }
    if state.session_mode().is_orchestrate() {
        return Ok(());
    }
    state.enter_orchestrate_before_first_message()?;
    Ok(())
}

fn resolve_resume_history_path(
    settings: &Settings,
    cwd: &std::path::Path,
    resume: &str,
) -> Result<PathBuf> {
    let history_dirs = history_dirs_for_read(settings, cwd)?;
    if resume == "latest" {
        let mut sessions = Vec::new();
        for history_dir in &history_dirs {
            sessions.extend(kcoder_state::recent_sessions(history_dir, 1)?);
        }
        sessions.sort_by_key(|(_, path, _)| {
            std::fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
        });
        return sessions
            .last()
            .map(|(_, path, _)| path.clone())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "no sessions found in {}",
                    history_dirs
                        .iter()
                        .map(|path| path.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            });
    }
    for history_dir in &history_dirs {
        let direct = history_dir.join(format!(
            "{}.jsonl",
            kcoder_state::artifact_id_path_component(resume)
        ));
        if direct.is_file() {
            return Ok(direct);
        }
    }
    let mut sessions = Vec::new();
    for history_dir in &history_dirs {
        sessions.extend(kcoder_state::recent_sessions(history_dir, 100)?);
    }
    let matches: Vec<_> = sessions
        .iter()
        .filter(|(id, _, _)| id.starts_with(resume))
        .collect();
    match matches.len() {
        1 => Ok(matches[0].1.clone()),
        0 => anyhow::bail!(
            "no session matching '{resume}' in {}",
            history_dirs
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
        n => anyhow::bail!("session prefix '{resume}' is ambiguous ({n} matches)"),
    }
}

fn configure_history_path(settings: &Settings, state: &AppState) {
    if settings.history_enabled
        && let Ok(history_dir) = history_dir_for_session(settings, &state.cwd())
    {
        let session_id = state.session_id();
        let history_path = history_dir.join(format!(
            "{}.jsonl",
            kcoder_state::artifact_id_path_component(&session_id)
        ));
        state.with_history_path(history_path);
    }
}

fn provider_template_output(action: &ConfigAction) -> Result<Option<Value>> {
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

async fn run_config(
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

fn initial_config_scope_document(scope: ConfigScope) -> Value {
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

fn reject_secret_config_key(key: &str) -> Result<()> {
    let normalized = key.trim().to_ascii_lowercase().replace(['.', '-'], "_");
    if normalized == "api_key" || normalized.ends_with("_api_key") {
        bail!("'{key}' is a secret; use `kcoder auth login --provider <provider>` instead");
    }
    Ok(())
}

fn reject_secret_settings_document(value: &Value, prefix: &str) -> Result<()> {
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

fn apply_credential_env_file(settings: &mut Settings, path: &Path) -> Result<()> {
    let values = dotenvy::from_path_iter(path)
        .with_context(|| format!("failed to read credential dotenv {}", path.display()))?
        .collect::<std::result::Result<HashMap<_, _>, _>>()
        .with_context(|| format!("failed to parse credential dotenv {}", path.display()))?;
    let find = |names: &[String]| {
        names
            .iter()
            .find_map(|name| values.get(name))
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let mut credentials = settings
        .provider_credential(None)
        .into_iter()
        .collect::<Vec<_>>();
    credentials.extend(
        settings
            .providers
            .iter()
            .map(|(id, provider)| provider.credential(id)),
    );
    credentials.extend(builtin_provider_credentials());
    for credential in credentials {
        if let Some(value) = find(&credential.env) {
            settings
                .credential_overrides
                .entry(credential.id)
                .or_insert(value);
        }
    }
    Ok(())
}

fn run_auth_action(
    action: AuthAction,
    cli: &Cli,
    settings: &Settings,
    paths: &ConfigPaths,
) -> Result<()> {
    match action {
        AuthAction::Status => run_auth_status(cli, settings, paths),
        AuthAction::Login {
            provider,
            api_key,
            env_file,
            store,
        } => {
            let credential = settings
                .provider_credential(Some(&provider))
                .ok_or_else(|| anyhow::anyhow!("invalid provider credential id '{provider}'"))?;
            let (api_key, source) = if let Some(value) = non_empty(api_key) {
                (value, "command line".to_string())
            } else if let Some(path) = env_file {
                let value = read_dotenv_api_key(&path, &credential)?.ok_or_else(|| {
                    anyhow::anyhow!(
                        "{} does not define {}",
                        path.display(),
                        credential.env.join(" or ")
                    )
                })?;
                (value, path.display().to_string())
            } else if let Some(value) = provider_process_environment_key(&credential) {
                (value, "environment".to_string())
            } else {
                (
                    rpassword::prompt_password(format!("API key for {}: ", credential.id))?,
                    "interactive input".to_string(),
                )
            };
            let api_key = api_key.trim();
            if api_key.is_empty() {
                bail!("API key cannot be empty");
            }
            let requested = store
                .as_deref()
                .map(CredentialStoreMode::parse)
                .transpose()?
                .unwrap_or(settings.credential_store);
            let backend = OsCredentialBackend::new();
            let keyring_available = backend.available();
            let use_keyring = match requested {
                CredentialStoreMode::Keyring => true,
                CredentialStoreMode::Auto => keyring_available,
                CredentialStoreMode::File => false,
            };
            if use_keyring && !keyring_available {
                bail!(
                    "the operating-system credential store is unavailable ({}); \
                     retry with --store file to keep the secret in {}{}",
                    backend.describe(),
                    paths.credentials.display(),
                    credential_store_reason(&backend, keyring_available),
                );
            }
            if use_keyring {
                CredentialStore::update_file(&paths.credentials, |credentials| {
                    backend.set(&credential.id, api_key)?;
                    credentials.set_api_key(&credential.id, marker_for_provider(&credential.id))
                })?;
                println!(
                    "Stored {} credentials from {} in {}; {} keeps only the reference",
                    credential.id,
                    source,
                    backend.describe(),
                    paths.credentials.display()
                );
            } else {
                CredentialStore::update_file(&paths.credentials, |credentials| {
                    credentials.set_api_key(&credential.id, api_key.to_string())
                })?;
                println!(
                    "Stored {} credentials from {} in {}",
                    credential.id,
                    source,
                    paths.credentials.display()
                );
                if requested == CredentialStoreMode::Auto {
                    println!(
                        "note: {} is unavailable, so the secret stays in plaintext; \
                         use --store keyring once the store is reachable",
                        backend.describe()
                    );
                }
            }
            Ok(())
        }
        AuthAction::Migrate { to } => migrate_provider_credentials(paths, &to),
        AuthAction::Import { env_file } => {
            let imported = import_dotenv_credentials(settings, paths, &env_file)?;
            if imported.is_empty() {
                println!(
                    "No configured provider credentials were found in {}",
                    env_file.display()
                );
            } else {
                println!(
                    "Imported {} provider credential(s) from {} into {}: {}",
                    imported.len(),
                    env_file.display(),
                    paths.credentials.display(),
                    imported.join(", ")
                );
            }
            Ok(())
        }
        AuthAction::Logout { provider } => {
            let backend = OsCredentialBackend::new();
            let outcome = logout_provider_credential(paths, &provider, settings, &backend)?;
            if let Some(note) = &outcome.store_note {
                eprintln!("{note}");
            }
            println!(
                "Removed stored {} credentials{}.",
                outcome.credential_id,
                if outcome.removed_from_store {
                    " and the entry in the operating-system credential store"
                } else {
                    ""
                }
            );
            Ok(())
        }
    }
}

fn import_dotenv_credentials(
    settings: &Settings,
    paths: &ConfigPaths,
    env_file: &Path,
) -> Result<Vec<String>> {
    let values = dotenvy::from_path_iter(env_file)
        .with_context(|| format!("failed to parse {}", env_file.display()))?
        .collect::<std::result::Result<HashMap<_, _>, _>>()
        .with_context(|| format!("failed to parse {}", env_file.display()))?;
    let mut available = builtin_provider_credentials()
        .into_iter()
        .map(|credential| (credential.id.clone(), credential))
        .collect::<BTreeMap<_, _>>();
    for (id, provider) in &settings.providers {
        let credential = provider.credential(id);
        available.insert(credential.id.clone(), credential);
    }

    let mut imports = Vec::new();
    let mut imported = Vec::new();
    for (id, credential) in available {
        let Some(api_key) = credential
            .env
            .iter()
            .find_map(|name| values.get(name))
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        imports.push((id.clone(), api_key.to_string()));
        imported.push(id);
    }
    if !imports.is_empty() {
        CredentialStore::update_file(&paths.credentials, |credentials| {
            for (id, api_key) in imports {
                credentials.set_api_key(&id, api_key)?;
            }
            Ok(())
        })?;
    }
    Ok(imported)
}

fn provider_process_environment_key(credential: &ProviderCredential) -> Option<String> {
    credential
        .env
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .and_then(|value| non_empty(Some(value)))
}

fn read_dotenv_api_key(
    path: &std::path::Path,
    credential: &ProviderCredential,
) -> Result<Option<String>> {
    if credential.env.is_empty() {
        return Ok(None);
    }
    let values = dotenvy::from_path_iter(path)
        .with_context(|| format!("failed to parse {}", path.display()))?
        .map(|entry| entry.with_context(|| format!("failed to parse {}", path.display())))
        .collect::<Result<std::collections::HashMap<_, _>>>()?;
    Ok(credential.env.iter().find_map(|name| {
        values
            .get(name)
            .cloned()
            .and_then(|value| non_empty(Some(value)))
    }))
}

fn run_doctor(
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
        cli.tool_profile.effective(*provider_kind)
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

fn print_skill_store_doctor(label: &str, root: &Path) -> Result<()> {
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

fn provider_overrides_from_cli(cli: &Cli) -> ProviderBuildOverrides {
    ProviderBuildOverrides {
        api_key: cli.api_key.clone(),
        base_url: cli.base_url.clone(),
        openai_api_key: cli.openai_api_key.clone(),
        openai_base_url: cli.openai_base_url.clone(),
        openai_user_agent: cli.openai_user_agent.clone(),
        local_base_url: cli.local_base_url.clone(),
        local_api_key: cli.local_api_key.clone(),
        gemini_api_key: cli.gemini_api_key.clone(),
        grok_api_key: cli.grok_api_key.clone(),
    }
}

fn local_base_url(cli: &Cli, settings: &Settings) -> String {
    ProviderFactory::new(settings)
        .with_overrides(provider_overrides_from_cli(cli))
        .local_base_url()
}

/// Move stored API keys between the operating-system credential store and the file.
/// Outcome of removing one stored credential.
struct LogoutOutcome {
    credential_id: String,
    removed_from_store: bool,
    store_note: Option<String>,
}

/// Remove a stored credential from the document, and from the operating-system store when the
/// document only held a reference to it.
///
/// The id is first resolved through settings, but an id that only exists in the credential
/// document is accepted as-is: entries left behind by an older profile would otherwise be
/// impossible to remove.
fn logout_provider_credential(
    paths: &ConfigPaths,
    provider: &str,
    settings: &Settings,
    backend: &dyn CredentialBackend,
) -> Result<LogoutOutcome> {
    let credential_id = settings
        .provider_credential(Some(provider))
        .map(|credential| credential.id.clone())
        .unwrap_or_else(|| provider.to_string());
    let mut stored = None;
    CredentialStore::update_file(&paths.credentials, |credentials| {
        stored = credentials.credentials.get(&credential_id).cloned();
        let already_revoked = credentials.revoked.contains(&credential_id);
        if !credentials.remove_api_key(&credential_id)?
            && !already_revoked
            && settings.resolve_provider_api_key(Some(&credential_id), None).is_none()
        {
            bail!("no stored credentials for {credential_id}");
        }
        Ok(())
    })?;
    let Some(account) = stored
        .as_deref()
        .and_then(kcoder_config::provider_from_marker)
    else {
        return Ok(LogoutOutcome {
            credential_id,
            removed_from_store: false,
            store_note: None,
        });
    };
    match backend.delete(account) {
        Ok(()) => Ok(LogoutOutcome {
            credential_id,
            removed_from_store: true,
            store_note: None,
        }),
        Err(error) => Ok(LogoutOutcome {
            credential_id,
            removed_from_store: false,
            store_note: Some(format!(
                "warning: the stored credential could not be deleted ({}: {error:#})",
                backend.describe()
            )),
        }),
    }
}

/// Suffix explaining why the operating-system credential store is unreachable.
fn credential_store_reason(backend: &OsCredentialBackend, available: bool) -> String {
    if available {
        return String::new();
    }
    match CredentialBackend::unavailable_reason(backend) {
        Some(reason) => format!(": {reason}"),
        None => String::new(),
    }
}

fn migrate_provider_credentials(paths: &ConfigPaths, to: &str) -> Result<()> {
    let direction = match to {
        "keyring" => MigrationDirection::ToKeyring,
        "file" => MigrationDirection::ToFile,
        other => bail!("invalid migration destination '{other}'"),
    };
    let backend = OsCredentialBackend::new();
    let keyring_available = CredentialBackend::available(&backend);
    if direction == MigrationDirection::ToKeyring && !keyring_available {
        bail!(
            "the operating-system credential store is unavailable ({}); no credential was moved{}",
            backend.describe(),
            credential_store_reason(&backend, keyring_available),
        );
    }
    let mut migration_report = None;
    CredentialStore::update_file(&paths.credentials, |credentials| {
        let (rewritten, report) =
            migrate_stored_credentials_wrapper(&credentials.credentials, &backend, direction);
        for moved in &report.moved {
            if let Some(value) = rewritten.get(moved) {
                credentials.set_api_key(moved, value.clone())?;
            }
        }
        migration_report = Some(report);
        Ok(())
    })?;
    let report = migration_report.context("credential migration produced no report")?;
    println!(
        "Migrated {} credential(s) to {to}: {}{}",
        report.moved.len(),
        if report.moved.is_empty() {
            "none".to_string()
        } else {
            report.moved.join(", ")
        },
        if report.skipped.is_empty() {
            String::new()
        } else {
            format!(" (already {to}: {})", report.skipped.join(", "))
        }
    );
    for failure in &report.failures {
        eprintln!("warning: {failure}");
    }
    ensure!(
        report.failures.is_empty(),
        "{} credential(s) could not be migrated",
        report.failures.len()
    );
    Ok(())
}

fn migrate_stored_credentials_wrapper(
    stored: &std::collections::BTreeMap<String, String>,
    backend: &dyn CredentialBackend,
    direction: MigrationDirection,
) -> (
    std::collections::BTreeMap<String, String>,
    kcoder_config::MigrationReport,
) {
    kcoder_config::migrate_stored_credentials(stored, backend, direction)
}

fn run_auth_status(cli: &Cli, settings: &Settings, paths: &ConfigPaths) -> Result<()> {
    let backend = OsCredentialBackend::new();
    let keyring_available = CredentialBackend::available(&backend);
    let stored = CredentialStore::load_from(&paths.credentials)?;
    let mut credentials = builtin_provider_credentials()
        .into_iter()
        .map(|credential| (credential.id.clone(), credential))
        .collect::<BTreeMap<_, _>>();
    for (id, provider) in &settings.providers {
        let credential = provider.credential(id);
        credentials.insert(credential.id.clone(), credential);
    }
    let mut rows = Vec::new();
    for (id, _) in credentials {
        let stored_value = stored.credentials.get(&id).map(String::as_str);
        let source = match stored_value {
            Some(value) if kcoder_config::provider_from_marker(value).is_some() => {
                format!("keyring ({})", backend.describe())
            }
            Some(_) => "file (plaintext)".to_string(),
            None => {
                if settings.resolve_provider_api_key(Some(&id), None).is_some() {
                    "environment".to_string()
                } else {
                    "not configured".to_string()
                }
            }
        };
        let configured = settings.resolve_provider_api_key(Some(&id), None).is_some();
        rows.push(serde_json::json!({"id":id,"configured":configured,"source":source}));
    }
    if cli.json {
        println!("{}", serde_json::json!({"providers":rows}));
    } else {
        println!("kcoder auth");
        println!("==============");
        println!("credential store: {}", paths.credentials.display());
    println!(
        "credential store mode: {} ({}: {}{})",
        settings.credential_store.as_str(),
        backend.describe(),
        if keyring_available {
            "available".to_string()
        } else {
            "unavailable".to_string()
        },
        credential_store_reason(&backend, keyring_available),
    );
        for row in rows {
            println!("{}: {}", row["id"].as_str().unwrap_or_default(), row["source"].as_str().unwrap_or_default());
        }
    }
    Ok(())
}

fn first_non_empty(values: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

async fn run_mcp(action: McpAction, cwd: &Path) -> Result<()> {
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

fn run_plugin(
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

fn run_marketplace(
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

fn print_marketplace_result(
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

fn cli_folder_trusted(cwd: &Path) -> bool {
    if kcoder_config::FolderTrustStore::trust_all_from_environment() {
        return true;
    }
    kcoder_config::user_config_dir()
        .map(|config_dir| kcoder_config::FolderTrustStore::load(&config_dir))
        .is_ok_and(|store| store.check(cwd) == kcoder_config::FolderTrust::Trusted)
}

fn parse_key_value_pairs(pairs: &[String]) -> Result<HashMap<String, String>> {
    let mut map = HashMap::new();
    for pair in pairs {
        let (key, value) = pair
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("invalid KEY=VALUE pair: {}", pair))?;
        map.insert(key.to_string(), value.to_string());
    }
    Ok(map)
}

fn mask_secret(secret: Option<&str>) -> String {
    if secret.is_some() {
        "configured".to_string()
    } else {
        "not set".to_string()
    }
}

fn effective_setting_source<'a>(cli: &Cli, loaded: &'a LoadedSettings, key: &str) -> &'a str {
    if let Some(source) = runtime_override_source(cli, key) {
        return source;
    }
    loaded
        .field_sources
        .get(key)
        .map(|scope| scope.as_str())
        .unwrap_or("default")
}

#[cfg(test)]
fn plaintext_settings_secret_warning(settings: &Settings) -> Option<String> {
    let fields = settings.plaintext_secret_setting_names();
    if fields.is_empty() {
        return None;
    }
    Some(format!(
        "warning: settings.json contains plaintext secret field(s): {}. Move API keys to environment variables, CLI arguments, or an OS keyring, then remove them from settings.json.",
        fields.join(", ")
    ))
}

fn emit_plaintext_settings_secret_warning_names(fields: &[String]) {
    if !fields.is_empty() {
        eprintln!(
            "warning: settings.json contains plaintext secret field(s): {}. Move API keys to `kcoder auth login`, environment variables, or CLI arguments, then remove them from settings.json.",
            fields.join(", ")
        );
    }
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;
