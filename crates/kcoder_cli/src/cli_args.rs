use super::{daemon, tui_dev_mock::TuiDevScenario};
use clap::{Parser, ValueEnum};
use kcoder_api::ProviderKind as ApiProviderKind;
use kcoder_config::{ConfigScope, PermissionMode};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, ValueEnum)]
pub(super) enum CliPermissionMode {
    Ask,
    Auto,
    AcceptEdits,
    DontAsk,
    Bypass,
    Yolo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(super) enum ToolProfile {
    /// Choose by provider: full for cloud providers and core for local providers.
    Auto,
    /// Expose every built-in tool.
    Full,
    /// Expose core development, multi-agent, task, goal, and web tools.
    Core,
    /// Expose the minimal development tool set without user-question tools.
    Nano,
    /// Send no tools to the model.
    None,
}

impl ToolProfile {
    pub(super) fn effective(self, provider_kind: ApiProviderKind) -> Self {
        match self {
            Self::Auto if provider_kind == ApiProviderKind::Local => Self::Core,
            Self::Auto => Self::Full,
            other => other,
        }
    }

    /// Like [`Self::effective`], but also treats endpoints that clearly belong
    /// to a runtime on this machine or the local network (Ollama, llama.cpp
    /// server, vLLM, SGLang, LM Studio) as local, so `auto` picks the core
    /// tool profile even when the provider was configured through the
    /// OpenAI-compatible transport.
    pub(super) fn effective_with_endpoint(
        self,
        provider_kind: ApiProviderKind,
        endpoint: Option<&str>,
    ) -> Self {
        if matches!(self, Self::Auto) && endpoint.is_some_and(endpoint_is_local) {
            return Self::Core;
        }
        self.effective(provider_kind)
    }
}

/// Whether `endpoint` points at this machine or a private network address.
pub(super) fn endpoint_is_local(endpoint: &str) -> bool {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return false;
    }
    let without_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let authority = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(without_scheme);
    let authority = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    let host = if let Some(rest) = authority.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest)
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    let host = host.trim_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    if host == "localhost" || host == "::1" || host.ends_with(".local") {
        return true;
    }
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let Ok(octets) = parts
        .iter()
        .map(|part| part.parse::<u8>())
        .collect::<Result<Vec<u8>, _>>()
    else {
        return false;
    };
    matches!(octets[0], 10 | 127)
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
        || (octets[0] == 169 && octets[1] == 254)
}

impl From<CliPermissionMode> for PermissionMode {
    fn from(mode: CliPermissionMode) -> Self {
        match mode {
            CliPermissionMode::Ask => PermissionMode::Ask,
            CliPermissionMode::Auto => PermissionMode::Auto,
            CliPermissionMode::AcceptEdits => PermissionMode::AcceptEdits,
            CliPermissionMode::DontAsk => PermissionMode::DontAsk,
            CliPermissionMode::Bypass => PermissionMode::Bypass,
            CliPermissionMode::Yolo => PermissionMode::Yolo,
        }
    }
}

#[derive(Debug, Clone, Parser)]
#[command(name = "kcoder", version, about = "KCoder")]
pub(super) struct Cli {
    /// Optional single prompt to run in headless mode. Leading hyphens are
    /// accepted so prompts like "- do X" are not misparsed as flags.
    #[arg(allow_hyphen_values = true)]
    pub(super) prompt: Option<String>,

    #[command(subcommand)]
    pub(super) command: Option<Commands>,

    /// Read-only settings overlay. May be repeated; later files win.
    #[arg(long = "settings-file", value_name = "PATH", global = true)]
    pub(super) settings_files: Vec<PathBuf>,

    /// Dotenv file supplying credentials for this process only.
    #[arg(long = "credential-env-file", value_name = "PATH", global = true)]
    pub(super) credential_env_file: Option<PathBuf>,

    /// Compatibility alias for selecting a provider ID; prefer --provider.
    #[arg(long, env = "KCODER_PROFILE", global = true)]
    pub(super) profile: Option<String>,

    /// Model identifier to use.
    #[arg(short, long, env = "KCODER_MODEL", global = true)]
    pub(super) model: Option<String>,

    /// Maximum tokens to generate in a single model response.
    #[arg(long, env = "KCODER_MAX_TOKENS", global = true)]
    pub(super) max_tokens: Option<u32>,

    /// Maximum number of retries for transient provider/stream errors.
    #[arg(long, env = "KCODER_MAX_RETRIES", global = true)]
    pub(super) max_retries: Option<usize>,

    /// Wall-clock budget for a single turn in seconds (soft deadline).
    #[arg(long, env = "KCODER_MAX_DURATION_SECS", global = true)]
    pub(super) max_duration_secs: Option<u64>,

    /// Base retry delay in milliseconds for transient provider/stream errors.
    #[arg(long, env = "KCODER_RETRY_BASE_DELAY_MS", global = true)]
    pub(super) retry_base_delay_ms: Option<u64>,

    /// Provider used only for conversation compaction summaries. By default,
    /// the active provider is reused.
    #[arg(long, env = "KCODER_SUMMARY_PROVIDER", global = true)]
    pub(super) summary_provider: Option<String>,

    /// Full provider configuration used for conversation compaction summaries.
    #[arg(long, env = "KCODER_SUMMARY_PROFILE", global = true)]
    pub(super) summary_profile: Option<String>,

    /// Model used only for conversation compaction summaries. By default, the
    /// active model is reused.
    #[arg(long, env = "KCODER_SUMMARY_MODEL", global = true)]
    pub(super) summary_model: Option<String>,

    /// Maximum tokens generated by the summary model during compaction.
    #[arg(long, env = "KCODER_SUMMARY_MAX_TOKENS", global = true)]
    pub(super) summary_max_tokens: Option<u32>,

    /// Provider ID from settings.json, or a built-in transport identifier.
    #[arg(long, env = "KCODER_PROVIDER", global = true)]
    pub(super) provider: Option<String>,

    /// Explicit API key override for Anthropic-compatible providers.
    #[arg(short, long, global = true, hide_env_values = true)]
    pub(super) api_key: Option<String>,

    /// Explicit base URL override for Anthropic-compatible providers.
    #[arg(long, global = true)]
    pub(super) base_url: Option<String>,

    /// OpenAI API key (defaults to OPENAI_API_KEY env var).
    #[arg(long, env = "OPENAI_API_KEY", global = true, hide_env_values = true)]
    pub(super) openai_api_key: Option<String>,

    /// OpenAI base URL (defaults to OPENAI_BASE_URL env var). May be a /v1 base URL
    /// or a full /v1/chat/completions URL.
    #[arg(long, env = "OPENAI_BASE_URL", global = true)]
    pub(super) openai_base_url: Option<String>,

    /// OpenAI-compatible User-Agent header (defaults to OPENAI_USER_AGENT env var).
    #[arg(long, env = "OPENAI_USER_AGENT", global = true)]
    pub(super) openai_user_agent: Option<String>,

    /// Local OpenAI-compatible base URL for vLLM/SGLang. May be a /v1 base URL
    /// or a full /v1/chat/completions URL.
    #[arg(long, env = "KCODER_LOCAL_BASE_URL", global = true)]
    pub(super) local_base_url: Option<String>,

    /// Optional API key for local OpenAI-compatible servers that enforce auth.
    #[arg(
        long,
        env = "KCODER_LOCAL_API_KEY",
        global = true,
        hide_env_values = true
    )]
    pub(super) local_api_key: Option<String>,

    /// Gemini API key (defaults to GEMINI_API_KEY env var).
    #[arg(long, env = "GEMINI_API_KEY", global = true, hide_env_values = true)]
    pub(super) gemini_api_key: Option<String>,

    /// Grok API key (defaults to GROK_API_KEY env var).
    #[arg(long, env = "GROK_API_KEY", global = true, hide_env_values = true)]
    pub(super) grok_api_key: Option<String>,

    /// Permission mode. Clean user configs start in yolo; the library fallback remains ask.
    #[arg(short, long, value_enum, env = "KCODER_PERMISSION_MODE", global = true)]
    pub(super) permission_mode: Option<CliPermissionMode>,

    /// Tool set sent to the model. `auto` selects `core` for local vLLM/SGLang
    /// providers and `full` for cloud providers.
    #[arg(long, value_enum, default_value = "auto", global = true)]
    pub(super) tool_profile: ToolProfile,

    /// Working directory.
    #[arg(short, long, global = true)]
    pub(super) cwd: Option<PathBuf>,

    /// Output headless events as newline-delimited JSON.
    #[arg(long, global = true)]
    pub(super) json: bool,

    /// Use legacy inline mode instead of full-screen terminal takeover.
    #[arg(long = "no-alt-screen", default_value_t = false, global = true)]
    pub(super) no_alt_screen: bool,

    /// Enable background skill self-improvement review for this session.
    /// This can spend additional model tokens after completed turns.
    #[arg(long = "skill-review", alias = "auto-skill-review", global = true)]
    pub(super) skill_review: bool,

    /// Run as a trajectory-training harness. Disables plugins, the built-in
    /// kcoder-settings skill, automatic summaries, the memory observer,
    /// maintenance, retries, and other background model requests.
    #[arg(long, env = "KCODER_TRAINING_MODE", global = true)]
    pub(super) training_mode: bool,

    /// Resume a previous session in headless mode: by session id, unique id
    /// prefix, or `latest` for the most recent session in this directory.
    #[arg(long, env = "KCODER_RESUME", global = true)]
    pub(super) resume: Option<String>,

    /// Start session-level read-only orchestration before the first message.
    #[arg(long, global = true)]
    pub(super) orchestrate: bool,

    /// Skill that must be loaded and authorized before a headless model request.
    /// May be specified more than once.
    #[arg(long = "require-skill", value_name = "NAME", global = true)]
    pub(super) required_skills: Vec<String>,
}

#[derive(Debug, Clone, Parser)]
pub(super) enum Commands {
    /// Print a health check of the environment.
    Doctor,
    /// Generate one plan from independent model drafts and a final synthesis.
    MoaPlan {
        /// Planning request passed unchanged to every planner.
        prompt: String,
    },
    /// Manage provider credentials.
    Auth {
        #[command(subcommand)]
        action: Option<AuthAction>,
    },
    /// Inspect or modify trust for an explicit project root.
    Trust {
        #[command(subcommand)]
        action: TrustAction,
    },
    /// Inspect or update layered settings.
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Start the interactive TUI with deterministic mock model responses.
    TuiDev {
        /// Deterministic mock scenario to stream through the real engine/TUI.
        #[arg(long, value_enum, default_value = "full-turn")]
        scenario: TuiDevScenario,
    },
    /// MCP server management (stub).
    Mcp {
        #[command(subcommand)]
        action: McpAction,
    },
    /// Manage local plugins.
    Plugin {
        #[command(subcommand)]
        action: PluginAction,
    },
    /// Manage local plugin marketplaces.
    Marketplace {
        #[command(subcommand)]
        action: MarketplaceAction,
    },
    /// Manage tmux-backed background sessions (bg/ps/attach/kill/logs).
    Daemon {
        #[command(subcommand)]
        action: daemon::DaemonAction,
    },
    /// Run the machine-readable app server for desktop and SSH clients.
    AppServer {
        /// Transport URL. The first release supports stdio:// only.
        #[arg(long, default_value = "stdio://")]
        listen: String,
        /// Use a deterministic provider for client development and tests.
        #[arg(long, value_enum)]
        scenario: Option<TuiDevScenario>,
    },
}

#[derive(Debug, Clone, Parser)]
pub(super) enum TrustAction {
    /// Show the effective trust decision for a project root.
    Status {
        #[arg(long, value_name = "PATH")]
        path: PathBuf,
    },
    /// Persist trust for this project root and its descendants.
    Add {
        #[arg(long, value_name = "PATH")]
        path: PathBuf,
    },
    /// Revoke the persisted trust decision for this project root.
    Revoke {
        #[arg(long, value_name = "PATH")]
        path: PathBuf,
    },
    /// Persist a never-trust decision for this project root.
    Never {
        #[arg(long, value_name = "PATH")]
        path: PathBuf,
    },
}

#[derive(Debug, Clone, Parser)]
pub(super) enum AuthAction {
    /// Store an API key in the user-only credentials file.
    Login {
        /// Provider/profile/credential ID. Custom configured providers are accepted.
        #[arg(long = "provider")]
        provider: String,
        /// API key. Omit this option to enter it without terminal echo.
        #[arg(long, hide_env_values = true)]
        api_key: Option<String>,
        /// Read the provider API key from this dotenv file.
        #[arg(long, value_name = "PATH")]
        env_file: Option<PathBuf>,
        /// Where to keep the secret; `auto` prefers the operating-system credential store.
        #[arg(long, value_name = "MODE", value_parser = ["auto", "keyring", "file"])]
        store: Option<String>,
    },
    /// Move stored API keys between the operating-system credential store and the file.
    Migrate {
        /// Destination: `keyring` stores secrets in the OS store, `file` keeps them plaintext.
        #[arg(long = "to", value_name = "DESTINATION", value_parser = ["keyring", "file"])]
        to: String,
    },
    /// Import credentials for every configured provider found in a dotenv file.
    Import {
        /// Dotenv file containing keys named by provider `credential_env` fields.
        #[arg(long, value_name = "PATH")]
        env_file: PathBuf,
    },
    /// Remove a stored API key.
    Logout {
        #[arg(long = "provider")]
        provider: String,
    },
    /// Show credential availability without revealing secret values.
    Status,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(super) enum ConfigScopeArg {
    User,
    Project,
    Local,
}

impl From<ConfigScopeArg> for ConfigScope {
    fn from(scope: ConfigScopeArg) -> Self {
        match scope {
            ConfigScopeArg::User => ConfigScope::User,
            ConfigScopeArg::Project => ConfigScope::Project,
            ConfigScopeArg::Local => ConfigScope::Local,
        }
    }
}

#[derive(Debug, Clone, Parser)]
pub(super) enum ConfigAction {
    /// List connection templates without reading or writing configuration.
    Templates,
    /// Preview an unverified connection template; the model must be chosen explicitly.
    Template { name: String },
    /// Print configuration file paths.
    Path {
        #[arg(long, value_enum)]
        scope: Option<ConfigScopeArg>,
    },
    /// Create a settings file without overwriting an existing one.
    Init {
        #[arg(long, value_enum, default_value = "user")]
        scope: ConfigScopeArg,
    },
    /// Add newly shipped deployment profiles without overwriting user values.
    Migrate,
    /// Merge a settings document into a writable configuration layer.
    Import {
        #[arg(long, value_name = "PATH")]
        file: PathBuf,
        #[arg(long, value_enum, default_value = "user")]
        scope: ConfigScopeArg,
    },
    /// Print the effective merged settings.
    List {
        /// Include loaded files and per-field source annotations.
        #[arg(long)]
        sources: bool,
    },
    /// Read one effective setting using a dotted path.
    Get {
        key: String,
        #[arg(long)]
        source: bool,
    },
    /// Set one setting in a selected configuration layer.
    Set {
        key: String,
        value: String,
        #[arg(long, value_enum, default_value = "user")]
        scope: ConfigScopeArg,
    },
    /// Remove one setting from a selected configuration layer.
    Unset {
        key: String,
        #[arg(long, value_enum, default_value = "user")]
        scope: ConfigScopeArg,
    },
    /// Parse and merge every active configuration layer.
    Validate,
}

#[derive(Debug, Clone, Parser)]
pub(super) enum McpAction {
    /// List configured MCP servers.
    List,
    /// Add a new stdio MCP server.
    Add {
        /// Display name for the server.
        name: String,
        /// Command to execute.
        #[arg(long)]
        command: String,
        /// Arguments for the command.
        #[arg(long, num_args = 0..)]
        args: Vec<String>,
        /// Environment variables as KEY=VALUE.
        #[arg(long, value_delimiter = ',', num_args = 0..)]
        env: Vec<String>,
    },
    /// Remove an MCP server by name.
    Remove {
        /// Name of the server to remove.
        name: String,
    },
    /// Connect to an MCP server and list its tools.
    Test {
        /// Name of the server to test.
        name: String,
    },
}

#[derive(Debug, Clone, Parser)]
pub(super) enum PluginAction {
    /// List discovered plugins and their compatibility status.
    List {
        /// Include disabled plugins.
        #[arg(long)]
        all: bool,
        /// Emit stable JSON output.
        #[arg(long)]
        json: bool,
    },
    /// Read detailed status for a managed plugin.
    Read {
        plugin_id: String,
        /// Emit stable JSON output.
        #[arg(long)]
        json: bool,
    },
    /// Inspect a plugin manifest, contributions, and managed state.
    Doctor {
        plugin_id: Option<String>,
        /// Emit stable JSON output.
        #[arg(long)]
        json: bool,
    },
    /// Safely copy and install a plugin from a local directory.
    Install {
        #[arg(
            long,
            value_name = "DIR",
            required_unless_present = "marketplace",
            conflicts_with = "marketplace"
        )]
        path: Option<PathBuf>,
        #[arg(long, value_name = "ID", requires = "name")]
        marketplace: Option<String>,
        #[arg(long, value_name = "NAME", requires = "marketplace")]
        name: Option<String>,
    },
    /// Uninstall a managed plugin; retain its data directory by default.
    Uninstall {
        plugin_id: String,
        #[arg(long)]
        purge_data: bool,
    },
    /// Enable a managed plugin.
    Enable { plugin_id: String },
    /// Disable a managed plugin.
    Disable { plugin_id: String },
}

#[derive(Debug, Clone, Parser)]
pub(super) enum MarketplaceAction {
    /// List local marketplaces from configuration and trusted projects.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Add a local marketplace manifest to user configuration.
    Add {
        marketplace_id: String,
        #[arg(long, value_name = "PATH")]
        path: PathBuf,
    },
    /// Remove a marketplace from user configuration.
    Remove { marketplace_id: String },
    /// Reload one or all local marketplaces.
    Refresh {
        marketplace_id: Option<String>,
        #[arg(long)]
        json: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_auto_profile_uses_expanded_core() {
        assert_eq!(
            ToolProfile::Auto.effective(ApiProviderKind::Local),
            ToolProfile::Core
        );
    }

    #[test]
    fn nano_profile_remains_explicit_for_local_provider() {
        assert_eq!(
            ToolProfile::Nano.effective(ApiProviderKind::Local),
            ToolProfile::Nano
        );
    }

    #[test]
    fn endpoint_locality_detection_covers_local_and_private_hosts() {
        for endpoint in [
            "http://localhost:11434/v1",
            "http://127.0.0.1:8000/v1",
            "http://[::1]:8080/v1",
            "https://user:pass@localhost:11434/v1",
            "http://10.0.0.5:8000/v1",
            "http://172.16.5.9:8000/v1",
            "http://172.31.255.254:1/v1",
            "http://192.168.1.7:5000/v1",
            "http://ollama.local:11434/v1",
        ] {
            assert!(endpoint_is_local(endpoint), "{endpoint}");
        }
        for endpoint in [
            "",
            "https://api.example.com/v1",
            "https://api.openai.com/v1",
            "http://172.32.0.1/v1",
            "http://11.0.0.1/v1",
            "http://192.169.0.1/v1",
            "https://ollama.example.com/v1",
        ] {
            assert!(!endpoint_is_local(endpoint), "{endpoint}");
        }
    }

    #[test]
    fn auto_profile_treats_local_endpoints_as_local_runtimes() {
        assert_eq!(
            ToolProfile::Auto.effective_with_endpoint(
                ApiProviderKind::Openai,
                Some("http://localhost:11434/v1")
            ),
            ToolProfile::Core
        );
        assert_eq!(
            ToolProfile::Auto.effective_with_endpoint(
                ApiProviderKind::Openai,
                Some("https://api.example.com/v1")
            ),
            ToolProfile::Full
        );
        assert_eq!(
            ToolProfile::Auto.effective_with_endpoint(ApiProviderKind::Local, None),
            ToolProfile::Core
        );
        assert_eq!(
            ToolProfile::Full.effective_with_endpoint(
                ApiProviderKind::Openai,
                Some("http://localhost:11434/v1")
            ),
            ToolProfile::Full
        );
    }

    #[test]
    fn plugin_lifecycle_commands_parse_stable_ids_and_paths() {
        let install =
            Cli::try_parse_from(["kcoder", "plugin", "install", "--path", "/tmp/demo"]).unwrap();
        assert!(matches!(
            install.command,
            Some(Commands::Plugin {
                action: PluginAction::Install { path: Some(_), .. }
            })
        ));

        let uninstall = Cli::try_parse_from([
            "kcoder",
            "plugin",
            "uninstall",
            "demo@local",
            "--purge-data",
        ])
        .unwrap();
        assert!(matches!(
            uninstall.command,
            Some(Commands::Plugin {
                action: PluginAction::Uninstall {
                    purge_data: true,
                    ..
                }
            })
        ));

        let marketplace_install = Cli::try_parse_from([
            "kcoder",
            "plugin",
            "install",
            "--marketplace",
            "team-tools",
            "--name",
            "demo",
        ])
        .unwrap();
        assert!(matches!(
            marketplace_install.command,
            Some(Commands::Plugin {
                action: PluginAction::Install {
                    path: None,
                    marketplace: Some(_),
                    name: Some(_),
                }
            })
        ));

        let marketplace_add = Cli::try_parse_from([
            "kcoder",
            "marketplace",
            "add",
            "team-tools",
            "--path",
            "/tmp/marketplace",
        ])
        .unwrap();
        assert!(matches!(
            marketplace_add.command,
            Some(Commands::Marketplace {
                action: MarketplaceAction::Add { .. }
            })
        ));
    }
}
