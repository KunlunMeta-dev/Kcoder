use crate::ReplApp;
use crate::widgets::footer::context_window_remaining_percent;
use kcoder_config::{
    ApiFormat, PermissionMode, ProviderConfig, SandboxConfig, Settings, discover_project_md,
};
use kcoder_engine::{DiscoveredModelGroup, QueryEngine, context::ContextBudget};
use kcoder_hooks::{
    HookCommand, HookEvent, HookMatcher, HookRegistry, HookSource, hook_text_preview,
};
use kcoder_state::{Task, TaskStatus};
use kcoder_types::MessageRole;
use std::path::Path;

use super::{SlashCommand, SlashRegistry, SlashResult};

#[derive(Default)]
pub(super) struct TodosCommand;

#[async_trait::async_trait]
impl SlashCommand for TodosCommand {
    fn name(&self) -> &'static str {
        "/todos"
    }
    fn description(&self) -> &'static str {
        "List todos tracked by TodoWriteTool."
    }
    fn usage(&self) -> &'static str {
        "/todos"
    }
    async fn run(&self, _args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let todos = engine.state.todos();
        if todos.is_empty() {
            app.push_message(MessageRole::System, "No todos tracked yet.".to_string());
        } else {
            let lines: Vec<String> = todos
                .iter()
                .map(|t| format!("[{:?}] {}: {}", t.status, t.id, t.content))
                .collect();
            app.push_message(MessageRole::System, format!("Todos:\n{}", lines.join("\n")));
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct TasksCommand;

#[async_trait::async_trait]
impl SlashCommand for TasksCommand {
    fn name(&self) -> &'static str {
        "/tasks"
    }
    fn aliases(&self) -> &[&'static str] {
        &["/agents", "/subagents"]
    }
    fn description(&self) -> &'static str {
        "List delegated tasks tracked by Task* tools."
    }
    fn usage(&self) -> &'static str {
        "/tasks"
    }
    async fn run(&self, _args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let tasks = engine.state.tasks();
        if tasks.is_empty() {
            app.push_message(MessageRole::System, "No delegated tasks yet.".to_string());
        } else {
            let mut lines: Vec<String> = tasks
                .values()
                .map(|t| {
                    format!(
                        "[{:?}] {}: {} {}",
                        t.status,
                        t.id,
                        t.description,
                        t.output
                            .as_ref()
                            .map(|o| format!("\n  -> {}", o))
                            .unwrap_or_default()
                    )
                })
                .collect();
            lines.sort();
            app.push_message(
                MessageRole::System,
                format!("Delegated tasks:\n{}", lines.join("\n")),
            );
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct StatusCommand;

#[async_trait::async_trait]
impl SlashCommand for StatusCommand {
    fn name(&self) -> &'static str {
        "/status"
    }
    fn description(&self) -> &'static str {
        "Show current session status."
    }
    fn usage(&self) -> &'static str {
        "/status"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if !args.trim().is_empty() {
            app.push_message(MessageRole::System, "Usage: /status");
            return SlashResult::Handled;
        }

        app.refresh_engine_metadata(engine);
        app.push_message(MessageRole::System, status_card(app, engine));
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct HooksCommand;

#[async_trait::async_trait]
impl SlashCommand for HooksCommand {
    fn name(&self) -> &'static str {
        "/hooks"
    }
    fn description(&self) -> &'static str {
        "List configured lifecycle hooks."
    }
    fn usage(&self) -> &'static str {
        "/hooks"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if !args.trim().is_empty() {
            app.push_message(MessageRole::System, "Usage: /hooks");
            return SlashResult::Handled;
        }

        app.push_message(
            MessageRole::System,
            format_hooks_status(engine.hook_registry()),
        );
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct PluginsCommand;

#[async_trait::async_trait]
impl SlashCommand for PluginsCommand {
    fn name(&self) -> &'static str {
        "/plugins"
    }
    fn description(&self) -> &'static str {
        "List discovered KCoder plugins."
    }
    fn usage(&self) -> &'static str {
        "/plugins"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if !args.trim().is_empty() {
            app.push_message(MessageRole::System, "Usage: /plugins");
            return SlashResult::Handled;
        }

        let plugin_settings = engine.settings.read().unwrap().plugins.clone();
        let text =
            match kcoder_plugins::PluginManager::open_default_for_cwd_with_effective_settings(
                &engine.state.cwd(),
                plugin_settings,
            )
            .and_then(|manager| manager.list(&engine.state.cwd(), engine.folder_trusted()))
            {
                Ok(result) => format_plugins_status(&result, &engine.state.cwd()),
                Err(error) => format!("Failed to load plugins: {error:#}"),
            };
        app.push_message(MessageRole::System, text);
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct RolloutCommand;

#[async_trait::async_trait]
impl SlashCommand for RolloutCommand {
    fn name(&self) -> &'static str {
        "/rollout"
    }
    fn description(&self) -> &'static str {
        "Print current session persistence paths."
    }
    fn usage(&self) -> &'static str {
        "/rollout"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if !args.trim().is_empty() {
            app.push_message(MessageRole::System, "Usage: /rollout");
            return SlashResult::Handled;
        }

        app.push_message(MessageRole::System, rollout_status(engine));
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct AppsCommand;

#[async_trait::async_trait]
impl SlashCommand for AppsCommand {
    fn name(&self) -> &'static str {
        "/apps"
    }
    fn description(&self) -> &'static str {
        "List configured MCP app connectors."
    }
    fn usage(&self) -> &'static str {
        "/apps"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if !args.trim().is_empty() {
            app.push_message(MessageRole::System, "Usage: /apps");
            return SlashResult::Handled;
        }

        app.push_message(
            MessageRole::System,
            mcp_status(engine, McpStatusDetail::Summary),
        );
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct PsCommand;

#[async_trait::async_trait]
impl SlashCommand for PsCommand {
    fn name(&self) -> &'static str {
        "/ps"
    }
    fn description(&self) -> &'static str {
        "List active background tasks."
    }
    fn usage(&self) -> &'static str {
        "/ps"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if !args.trim().is_empty() {
            app.push_message(MessageRole::System, "Usage: /ps");
            return SlashResult::Handled;
        }

        let tasks = active_background_tasks(engine);
        if tasks.is_empty() {
            app.push_message(
                MessageRole::System,
                "No background tasks running.".to_string(),
            );
            return SlashResult::Handled;
        }

        let lines = tasks
            .iter()
            .map(|task| {
                format!(
                    "- {} [{}] {}",
                    task.id,
                    task_status_label(task.status),
                    task.description
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        app.push_message(MessageRole::System, format!("Background tasks:\n{lines}"));
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct StopCommand;

#[async_trait::async_trait]
impl SlashCommand for StopCommand {
    fn name(&self) -> &'static str {
        "/stop"
    }
    fn aliases(&self) -> &[&'static str] {
        &["/clean"]
    }
    fn description(&self) -> &'static str {
        "Stop one background task by id, or all active tasks when no id is given."
    }
    fn usage(&self) -> &'static str {
        "/stop [task-id]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let target = args.trim();
        if target.split_whitespace().count() > 1 {
            app.push_message(MessageRole::System, "Usage: /stop [task-id]");
            return SlashResult::Handled;
        }

        let tasks = if target.is_empty() {
            active_background_tasks(engine)
        } else {
            active_background_tasks(engine)
                .into_iter()
                .filter(|task| task.id == target)
                .collect()
        };
        if tasks.is_empty() {
            app.push_message(
                MessageRole::System,
                if target.is_empty() {
                    "No background tasks running.".to_string()
                } else {
                    format!("No active background task found with id '{target}'.")
                },
            );
            return SlashResult::Handled;
        }

        let mut stopped_ids = Vec::new();
        for task in &tasks {
            if engine.stop_background_task(&task.id).await {
                stopped_ids.push(task.id.clone());
            }
        }
        if stopped_ids.is_empty() {
            app.push_message(
                MessageRole::System,
                "No running background tasks could be stopped.".to_string(),
            );
        } else {
            app.push_message(
                MessageRole::System,
                format!(
                    "Stopping {} background task(s): {}.",
                    stopped_ids.len(),
                    stopped_ids.join(", ")
                ),
            );
        }
        SlashResult::Handled
    }
}

fn active_background_tasks(engine: &QueryEngine) -> Vec<Task> {
    let mut tasks = engine
        .state
        .tasks()
        .into_values()
        .filter(|task| {
            matches!(
                task.status,
                TaskStatus::Pending | TaskStatus::Running | TaskStatus::Paused
            )
        })
        .collect::<Vec<_>>();
    tasks.sort_by(|left, right| left.id.cmp(&right.id));
    tasks
}

fn task_status_label(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Pending => "pending",
        TaskStatus::Running => "running",
        TaskStatus::Paused => "paused",
        TaskStatus::Halted => "halted",
        TaskStatus::Completed => "completed",
        TaskStatus::Failed => "failed",
        TaskStatus::Cancelled => "cancelled",
    }
}

fn format_hooks_status(registry: &HookRegistry) -> String {
    if registry.disabled {
        return "Lifecycle hooks are disabled.".to_string();
    }

    let total_hooks: usize = registry
        .settings_hooks
        .iter()
        .map(|(_, matcher)| matcher.hooks.len())
        .sum();
    if total_hooks == 0 {
        return "No lifecycle hooks configured.".to_string();
    }

    let mut lines = vec![format!(
        "Lifecycle hooks: {total_hooks} hook(s) across {} matcher(s).",
        registry.settings_hooks.len()
    )];

    for event in HookEvent::ALL {
        let entries = registry
            .settings_hooks
            .iter()
            .filter(|(configured, _)| configured == event)
            .collect::<Vec<_>>();
        if entries.is_empty() {
            continue;
        }

        let event_hook_count: usize = entries.iter().map(|(_, matcher)| matcher.hooks.len()).sum();
        lines.push(format!("{} ({event_hook_count})", event.as_str()));

        for (_, matcher) in entries {
            lines.push(format_hook_matcher(matcher));
            for hook in &matcher.hooks {
                lines.push(format!("  - {}", hook_command_summary(hook)));
            }
        }
    }

    lines.join("\n")
}

fn format_hook_matcher(matcher: &HookMatcher) -> String {
    let pattern = matcher
        .matcher
        .as_deref()
        .filter(|pattern| !pattern.trim().is_empty())
        .unwrap_or("*");
    format!(
        "- matcher `{}`{}: {} hook(s)",
        hook_preview(pattern, 96),
        hook_source_suffix(matcher.source.as_ref()),
        matcher.hooks.len()
    )
}

fn hook_source_suffix(source: Option<&HookSource>) -> String {
    match source {
        Some(source) => format!(
            " from {} `{}`",
            source.kind.as_str(),
            hook_preview(&source.name, 80)
        ),
        None => " from settings".to_string(),
    }
}

fn hook_command_summary(hook: &HookCommand) -> String {
    match hook {
        HookCommand::Command {
            shell,
            command,
            if_rule,
            timeout,
            async_hook,
        } => {
            let async_label = if *async_hook { ", async" } else { "" };
            let rule = if_rule
                .as_deref()
                .filter(|rule| !rule.trim().is_empty())
                .map(|rule| format!(" if `{}`", hook_preview(rule, 80)))
                .unwrap_or_default();
            format!(
                "command [{}, timeout {}s{}]{}: {}",
                shell,
                timeout,
                async_label,
                rule,
                hook_preview(command, 120)
            )
        }
        HookCommand::Prompt {
            prompt,
            timeout,
            model,
        } => format!(
            "prompt [timeout {}s{}]: {}",
            timeout,
            hook_model_suffix(model.as_deref()),
            hook_preview(prompt, 120)
        ),
        HookCommand::Agent {
            instructions,
            timeout,
            max_turns,
            model,
        } => format!(
            "agent [timeout {}s, max_turns {}{}]: {}",
            timeout,
            max_turns,
            hook_model_suffix(model.as_deref()),
            hook_preview(instructions, 120)
        ),
        HookCommand::Http {
            url,
            method,
            headers,
            timeout,
        } => {
            let headers = if headers.is_empty() {
                String::new()
            } else {
                format!(", {} header(s)", headers.len())
            };
            format!(
                "http [{}, timeout {}s{}]: {}",
                method,
                timeout,
                headers,
                hook_preview(url, 120)
            )
        }
    }
}

fn hook_model_suffix(model: Option<&str>) -> String {
    model
        .filter(|model| !model.trim().is_empty())
        .map(|model| format!(", model {}", hook_preview(model, 48)))
        .unwrap_or_default()
}

fn hook_preview(value: &str, max_chars: usize) -> String {
    let redacted = hook_text_preview(value);
    if redacted.chars().count() <= max_chars {
        redacted
    } else {
        let prefix = redacted.chars().take(max_chars).collect::<String>();
        format!("{prefix}...")
    }
}

fn format_plugins_status(result: &kcoder_plugins::PluginListResult, cwd: &Path) -> String {
    let plugins = &result.plugins;
    let diagnostics = &result.diagnostics;
    if plugins.is_empty() && diagnostics.is_empty() {
        return "No plugins configured.".to_string();
    }

    let enabled = plugins.iter().filter(|plugin| plugin.enabled).count();
    let mut lines = vec![format!(
        "Plugins: {} discovered ({} enabled, generation {}).",
        plugins.len(),
        enabled,
        result.generation
    )];

    let mut sorted = plugins.iter().collect::<Vec<_>>();
    sorted.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });

    for plugin in sorted {
        lines.push(format_plugin_line(plugin, cwd));
        if let Some(description) = plugin
            .description
            .as_deref()
            .filter(|description| !description.trim().is_empty())
        {
            lines.push(format!("  {}", hook_preview(description, 120)));
        }
        lines.push(format!(
            "  hooks: {} matcher(s), root: {}",
            plugin.hook_matcher_count,
            plugin
                .root
                .strip_prefix(cwd)
                .unwrap_or(&plugin.root)
                .to_string_lossy()
                .replace('\\', "/")
        ));
        let deferred = if plugin.compatibility.deferred_capabilities.is_empty() {
            String::new()
        } else {
            format!(
                ", deferred: {}",
                plugin.compatibility.deferred_capabilities.join(", ")
            )
        };
        lines.push(format!(
            "  compatibility: {}{}",
            plugin.compatibility.level.as_str(),
            deferred
        ));
    }

    if !diagnostics.is_empty() {
        lines.push(format!("Plugin diagnostics: {}.", diagnostics.len()));
        let mut sorted = diagnostics.iter().collect::<Vec<_>>();
        sorted.sort_by(|left, right| left.root.cmp(&right.root));
        for diagnostic in sorted {
            let root = diagnostic
                .root
                .strip_prefix(cwd)
                .unwrap_or(&diagnostic.root)
                .to_string_lossy()
                .replace('\\', "/");
            lines.push(format!(
                "- [{}] {}: {}",
                diagnostic.code,
                root,
                hook_preview(&diagnostic.message, 160)
            ));
        }
    }

    lines.join("\n")
}

fn format_plugin_line(plugin: &kcoder_plugins::PluginListItem, _cwd: &Path) -> String {
    let status = if plugin.enabled {
        "enabled"
    } else {
        "disabled"
    };
    let version = plugin
        .version
        .as_deref()
        .filter(|version| !version.trim().is_empty())
        .map(|version| format!(" v{}", hook_preview(version, 48)))
        .unwrap_or_default();
    let ownership = if plugin.managed { "managed" } else { "manual" };
    format!(
        "- {} ({}) [{}, {}{}]",
        hook_preview(&plugin.name, 80),
        hook_preview(&plugin.id, 80),
        status,
        ownership,
        version
    )
}

fn rollout_status(engine: &QueryEngine) -> String {
    let mut lines = vec![format!("Session: {}", engine.session_id())];
    match engine.state.history_path() {
        Some(path) => lines.push(format!("History path: {}", path.display())),
        None => lines.push("History path: not configured".to_string()),
    }
    match engine.state.session_state_path() {
        Some(path) => lines.push(format!("Session state path: {}", path.display())),
        None => lines.push("Session state path: not configured".to_string()),
    }
    lines.join("\n")
}

struct ModelStatusFields {
    summary: Vec<(&'static str, String)>,
    details: Vec<(&'static str, String)>,
}

fn model_status_fields(
    settings: &Settings,
    provider_name: &str,
    endpoint: Option<&str>,
    api_key_configured: Option<bool>,
    request_timeout_secs: Option<u64>,
    budget: ContextBudget,
) -> ModelStatusFields {
    let provider = provider_name.trim();
    let api_format = settings
        .api_format
        .unwrap_or_else(|| default_api_format(provider));
    let endpoint = endpoint
        .map(sanitize_endpoint_for_display)
        .unwrap_or_else(|| "not reported".to_string());
    let summary = vec![
        ("Model", settings.model.clone()),
        ("Provider", provider.to_string()),
        (
            "Profile",
            settings
                .active_provider
                .as_deref()
                .unwrap_or("none")
                .to_string(),
        ),
        ("Endpoint", endpoint),
    ];
    let details = vec![
        ("API format", api_format.as_str().to_string()),
        (
            "Model source",
            settings
                .active_model_selection
                .as_ref()
                .map(|selection| format!("auto-discovered via {}", selection.source_profile))
                .unwrap_or_else(|| "configured profile".to_string()),
        ),
        (
            "Capabilities",
            format_model_capabilities(&settings.model_capabilities),
        ),
        (
            "Auto discovery",
            if settings.model_discovery.enabled {
                "enabled"
            } else {
                "disabled"
            }
            .to_string(),
        ),
        (
            "Reasoning effort",
            settings
                .model_reasoning_effort
                .as_ref()
                .map(ToString::to_string)
                .unwrap_or_else(|| "default".to_string()),
        ),
        (
            "Context window",
            format!("{} tokens", format_tokens_compact(budget.total as u64)),
        ),
        (
            "Auto compact at",
            format!(
                "{} tokens",
                format_tokens_compact(budget.auto_compact_threshold() as u64)
            ),
        ),
        (
            "Max output",
            settings
                .max_tokens
                .map(|value| format!("{} tokens", format_tokens_compact(value as u64)))
                .unwrap_or_else(|| "provider default".to_string()),
        ),
        (
            "Request timeout",
            request_timeout_secs
                .map(|value| format!("{value}s"))
                .unwrap_or_else(|| "not reported".to_string()),
        ),
        (
            "Retries",
            format!(
                "{} ({}ms base delay)",
                settings.max_retries, settings.retry_base_delay_ms
            ),
        ),
        ("No proxy", settings.provider_no_proxy.to_string()),
        (
            "API key",
            match api_key_configured {
                Some(true) => "configured",
                Some(false) => "not configured",
                None => "not reported",
            }
            .to_string(),
        ),
    ];

    ModelStatusFields { summary, details }
}

fn status_card(app: &ReplApp, engine: &QueryEngine) -> String {
    let settings = engine.settings.read().unwrap();
    let cwd = engine.state.cwd();
    let permission_mode = permission_mode_label(settings.permission_mode);
    let sandbox = sandbox_summary(&settings.sandbox);
    let render_markdown = settings.render_markdown;
    let code_theme = settings.code_theme.clone();
    let provider = engine.provider_name();
    let endpoint = engine.provider_endpoint();
    let api_key_configured = engine.provider_api_key_configured();
    let request_timeout_secs = engine.provider_request_timeout_secs();
    let budget = ContextBudget::from_settings(&settings);
    let model_fields = model_status_fields(
        &settings,
        &provider,
        endpoint.as_deref(),
        api_key_configured,
        request_timeout_secs,
        budget,
    );
    drop(settings);

    let usage = engine.cumulative_usage();
    let context_used = engine.estimated_token_count();
    let context_total = budget.hard_input_limit();
    let context_left =
        context_window_remaining_percent(context_used, context_total).unwrap_or(100.0);
    let agents_md = project_instruction_status(&cwd);
    let background = app.background_status_label();
    let goal_status = app.goal_status_label();
    let raw_mode = if app.raw_output_mode() { "on" } else { "off" };
    let render_mode = if render_markdown { "markdown" } else { "plain" };
    let queue = format!(
        "{} / {}",
        app.queued_user_message_count(),
        crate::USER_MESSAGE_QUEUE_MAX
    );

    let mut fields = model_fields.summary;
    fields.extend([
        ("Directory", cwd.display().to_string()),
        ("Permissions", permission_mode.to_string()),
        ("Sandbox", sandbox),
        ("Agents.md", agents_md),
        ("Session", engine.session_id().to_string()),
    ]);

    if let Some(title) = app.session_title() {
        fields.push(("Thread name", title.to_string()));
    }

    fields.extend([
        (
            "Token usage",
            format!(
                "{} total  ({} input + {} output)",
                format_tokens_compact(usage.total()),
                format_tokens_compact(usage.input_tokens),
                format_tokens_compact(usage.output_tokens)
            ),
        ),
        (
            "Context",
            format!(
                "{} used / {} ({:.0}% left)",
                format_tokens_compact(context_used as u64),
                format_tokens_compact(context_total as u64),
                context_left
            ),
        ),
        ("Queue", queue),
        (
            "Rendering",
            format!("{render_mode} ({code_theme}), raw output {raw_mode}"),
        ),
    ]);

    if !background.is_empty() {
        fields.push(("Background", background));
    }
    if !goal_status.is_empty() {
        fields.push(("Goal", goal_status));
    }

    let mut lines = vec![" >_ KCoder".to_string(), String::new()];
    lines.push("Session status".to_string());
    lines.push(String::new());
    lines.extend(format_status_fields(&fields));
    lines.push(String::new());
    lines.push("Model details".to_string());
    lines.push(String::new());
    lines.extend(format_status_fields(&model_fields.details));

    lines.join("\n")
}

fn permission_mode_label(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Ask => "Ask for approval",
        PermissionMode::Auto => "Auto",
        PermissionMode::AcceptEdits => "Accept edits",
        PermissionMode::DontAsk => "Do not ask",
        PermissionMode::Bypass => "Bypass approvals",
        PermissionMode::Yolo => "Yolo (non-interactive)",
    }
}

fn format_status_fields(fields: &[(&str, String)]) -> Vec<String> {
    let label_width = fields
        .iter()
        .map(|(label, _)| label.len())
        .max()
        .unwrap_or(0);
    fields
        .iter()
        .map(|(label, value)| {
            let padding = 3 + label_width.saturating_sub(label.len());
            format!(" {label}:{}{}", " ".repeat(padding), value)
        })
        .collect()
}

fn sandbox_summary(sandbox: &SandboxConfig) -> String {
    if !sandbox.enabled {
        return "disabled".to_string();
    }

    let mut parts = Vec::new();
    if sandbox.readonly {
        parts.push("read-only".to_string());
    } else {
        parts.push("enabled".to_string());
    }
    if !sandbox.allowed_paths.is_empty() {
        parts.push(format!("{} allowed path(s)", sandbox.allowed_paths.len()));
    }
    if !sandbox.denied_paths.is_empty() {
        parts.push(format!("{} denied path(s)", sandbox.denied_paths.len()));
    }
    if sandbox.allow_shell_escalation {
        parts.push("shell escalation allowed".to_string());
    }
    parts.join(", ")
}

fn project_instruction_status(cwd: &Path) -> String {
    let paths = discover_project_md(cwd);
    if paths.is_empty() {
        return "not found".to_string();
    }

    let labels = paths
        .iter()
        .map(|path| relative_path_label(path, cwd))
        .collect::<Vec<_>>();
    format!("loaded ({})", labels.join(", "))
}

fn relative_path_label(path: &Path, cwd: &Path) -> String {
    path.strip_prefix(cwd).unwrap_or(path).display().to_string()
}

fn format_tokens_compact(value: u64) -> String {
    if value < 1_000 {
        return value.to_string();
    }

    let value_f64 = value as f64;
    let (scaled, suffix) = if value >= 1_000_000_000_000 {
        (value_f64 / 1_000_000_000_000.0, "T")
    } else if value >= 1_000_000_000 {
        (value_f64 / 1_000_000_000.0, "B")
    } else if value >= 1_000_000 {
        (value_f64 / 1_000_000.0, "M")
    } else {
        (value_f64 / 1_000.0, "K")
    };

    let decimals = if scaled < 10.0 {
        2
    } else if scaled < 100.0 {
        1
    } else {
        0
    };

    let mut formatted = format!("{scaled:.decimals$}");
    if formatted.contains('.') {
        while formatted.ends_with('0') {
            formatted.pop();
        }
        if formatted.ends_with('.') {
            formatted.pop();
        }
    }

    format!("{formatted}{suffix}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ModelPickerEntry {
    pub label: String,
    pub selector: String,
    pub profile_name: String,
    pub model: String,
    pub discovered: bool,
}

pub(super) fn model_picker_items(
    settings: &Settings,
    discovered_groups: &[DiscoveredModelGroup],
) -> (Vec<ModelPickerEntry>, usize) {
    let mut profiles = settings.providers.iter().collect::<Vec<_>>();
    profiles.sort_by_key(|(name, profile)| {
        (
            settings.active_provider.as_deref() != Some(name.as_str()),
            name.to_ascii_lowercase(),
            profile.endpoint.to_ascii_lowercase(),
        )
    });

    let mut deployment_order = Vec::new();
    for (name, profile) in &profiles {
        let identity = provider_deployment_identity(name, profile);
        if !deployment_order.contains(&identity) {
            deployment_order.push(identity);
        }
    }

    let mut entries = Vec::new();
    // List every explicitly configured model first so one provider's long catalog cannot bury later entries.
    for (profile_name, profile) in &profiles {
        let group = provider_group_label(profile_name, profile_name, &profile.endpoint);
        entries.push(ModelPickerEntry {
            label: format!("[configured] {}  │  {group}", profile.default_model),
            selector: (*profile_name).clone(),
            profile_name: (*profile_name).clone(),
            model: profile.default_model.clone(),
            discovered: false,
        });
    }

    for deployment in deployment_order {
        let deployment_profiles = profiles
            .iter()
            .copied()
            .filter(|(name, profile)| provider_deployment_identity(name, profile) == deployment)
            .collect::<Vec<_>>();

        for (profile_name, profile) in deployment_profiles {
            let group = provider_group_label(profile_name, profile_name, &profile.endpoint);
            let mut discovered_models = discovered_groups
                .iter()
                .find(|candidate| candidate.profile_name == *profile_name)
                .map(|candidate| candidate.models.clone())
                .unwrap_or_default();
            if settings.active_provider.as_deref() == Some(profile_name.as_str())
                && settings.model != profile.default_model
                && !discovered_models
                    .iter()
                    .any(|model| model == &settings.model)
            {
                discovered_models.push(settings.model.clone());
            }
            discovered_models.sort_by_key(|model| model.to_ascii_lowercase());
            discovered_models.dedup();
            for model in discovered_models {
                let explicitly_configured = profiles
                    .iter()
                    .any(|(_, configured)| configured.default_model.eq_ignore_ascii_case(&model));
                if explicitly_configured {
                    continue;
                }
                entries.push(ModelPickerEntry {
                    label: format!("[auto:text-only] {model}  │  {group}"),
                    selector: format!("{profile_name}::{model}"),
                    profile_name: profile_name.clone(),
                    model,
                    discovered: true,
                });
            }
        }
    }

    let selected = entries
        .iter()
        .position(|entry| {
            entry.model == settings.model
                && settings.active_provider.as_deref() == Some(entry.profile_name.as_str())
        })
        .or_else(|| {
            let selection = settings.active_model_selection.as_ref()?;
            let source_profile = settings.providers.get(&selection.source_profile)?;
            entries.iter().position(|entry| {
                !entry.discovered
                    && entry.model.eq_ignore_ascii_case(&selection.model)
                    && settings
                        .providers
                        .get(&entry.profile_name)
                        .is_some_and(|profile| {
                            normalized_endpoint_identity(&profile.endpoint)
                                == normalized_endpoint_identity(&source_profile.endpoint)
                        })
            })
        })
        .unwrap_or(0);
    (entries, selected)
}

fn provider_deployment_identity(provider_id: &str, profile: &ProviderConfig) -> (String, String) {
    (
        provider_id.to_ascii_lowercase(),
        normalized_endpoint_identity(&profile.endpoint),
    )
}

fn normalized_endpoint_identity(endpoint: &str) -> String {
    url::Url::parse(endpoint.trim())
        .map(|mut url| {
            url.set_fragment(None);
            url.to_string().trim_end_matches('/').to_string()
        })
        .unwrap_or_else(|_| endpoint.trim().trim_end_matches('/').to_string())
}

fn provider_group_label(provider: &str, profile: &str, endpoint: &str) -> String {
    let host = url::Url::parse(endpoint)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_string();
            Some(match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host,
            })
        })
        .unwrap_or_else(|| "custom endpoint".to_string());
    format!("{provider} / {profile} @ {host}")
}

#[cfg(test)]
fn format_model_configuration(
    settings: &Settings,
    provider_name: &str,
    endpoint: Option<&str>,
    api_key_configured: Option<bool>,
    request_timeout_secs: Option<u64>,
    budget: ContextBudget,
) -> String {
    let model_fields = model_status_fields(
        settings,
        provider_name,
        endpoint,
        api_key_configured,
        request_timeout_secs,
        budget,
    );
    let mut fields = model_fields.summary;
    fields.extend(model_fields.details);

    let mut lines = vec!["Current model configuration".to_string(), String::new()];
    lines.extend(format_status_fields(&fields));
    lines.join("\n")
}

fn format_model_capabilities(capabilities: &kcoder_config::ModelCapabilities) -> String {
    let mut enabled = Vec::new();
    if capabilities.text {
        enabled.push("text");
    }
    if capabilities.tools {
        enabled.push("tools");
    }
    if capabilities.vision {
        enabled.push("vision");
    }
    if capabilities.reasoning {
        enabled.push("reasoning");
    }
    if capabilities.structured_output {
        enabled.push("structured-output");
    }
    enabled.join(", ")
}

fn sanitize_endpoint_for_display(endpoint: &str) -> String {
    let Ok(mut url) = url::Url::parse(endpoint.trim()) else {
        return "invalid endpoint (redacted)".to_string();
    };
    if !matches!(url.scheme(), "http" | "https") {
        return "unsupported endpoint scheme (redacted)".to_string();
    }

    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_fragment(None);
    let query = url
        .query_pairs()
        .map(|(key, value)| {
            let value = if endpoint_query_key_is_sensitive(&key) {
                "REDACTED".to_string()
            } else {
                value.into_owned()
            };
            (key.into_owned(), value)
        })
        .collect::<Vec<_>>();
    if query.is_empty() {
        url.set_query(None);
    } else {
        url.query_pairs_mut().clear().extend_pairs(query);
    }
    url.to_string()
}

fn endpoint_query_key_is_sensitive(key: &str) -> bool {
    let key = key.trim().to_ascii_lowercase().replace('-', "_");
    matches!(
        key.as_str(),
        "api_key"
            | "apikey"
            | "accesskey"
            | "access_key"
            | "authorization"
            | "credential"
            | "key"
            | "password"
            | "secret"
            | "signature"
            | "token"
    ) || key.ends_with("_key")
        || key.ends_with("_token")
        || key.ends_with("_secret")
        || key.ends_with("_signature")
}

fn default_api_format(provider: &str) -> ApiFormat {
    match provider.to_ascii_lowercase().as_str() {
        "anthropic" | "kunlunmeta" => ApiFormat::AnthropicMessages,
        "gemini" => ApiFormat::GeminiGenerateContent,
        _ => ApiFormat::OpenaiChatCompletions,
    }
}

#[derive(Default)]
pub(super) struct McpCommand;

#[async_trait::async_trait]
impl SlashCommand for McpCommand {
    fn name(&self) -> &'static str {
        "/mcp"
    }
    fn description(&self) -> &'static str {
        "List configured MCP tools; use /mcp verbose for details."
    }
    fn usage(&self) -> &'static str {
        "/mcp [verbose]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let detail = match args.trim() {
            "" => McpStatusDetail::Summary,
            "verbose" => McpStatusDetail::Verbose,
            _ => {
                app.push_message(MessageRole::System, "Usage: /mcp [verbose]");
                return SlashResult::Handled;
            }
        };
        app.push_message(MessageRole::System, mcp_status(engine, detail));
        SlashResult::Handled
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum McpStatusDetail {
    Summary,
    Verbose,
}

fn mcp_status(engine: &QueryEngine, detail: McpStatusDetail) -> String {
    let settings = engine.settings.read().unwrap();
    if settings.mcp_servers.is_empty() {
        return "No MCP servers configured.".to_string();
    }
    let mut lines = vec!["MCP servers:".to_string()];
    for server in &settings.mcp_servers {
        let prefix = mcp_tool_prefix(&server.name);
        let tool_names: Vec<String> = engine
            .tools
            .all()
            .iter()
            .filter(|t| t.name().starts_with(&prefix))
            .map(|t| t.name())
            .collect();
        lines.push(format!(
            "- {} ({}): {}",
            server.name,
            server.transport,
            if tool_names.is_empty() {
                "no tools loaded".to_string()
            } else {
                format!("{} tools", tool_names.len())
            }
        ));
        if detail == McpStatusDetail::Verbose {
            for name in tool_names {
                lines.push(format!("    {}", name));
            }
        }
    }
    lines.join("\n")
}

fn mcp_tool_prefix(server_name: &str) -> String {
    format!(
        "mcp__{}__",
        sanitize_mcp_tool_name_part(server_name, "server")
    )
}

fn sanitize_mcp_tool_name_part(value: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(value.len().min(48));
    let mut previous_was_separator = false;
    for ch in value.chars() {
        let next = if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            ch
        } else {
            '_'
        };
        if next == '_' {
            if previous_was_separator {
                continue;
            }
            previous_was_separator = true;
        } else {
            previous_was_separator = false;
        }
        out.push(next);
        if out.len() >= 48 {
            break;
        }
    }
    let out = out.trim_matches('_');
    if out.is_empty() {
        fallback.to_string()
    } else {
        out.to_string()
    }
}

#[derive(Default)]
pub(super) struct KeysCommand;

#[async_trait::async_trait]
impl SlashCommand for KeysCommand {
    fn name(&self) -> &'static str {
        "/keys"
    }
    fn aliases(&self) -> &[&'static str] {
        &["/keymap"]
    }
    fn description(&self) -> &'static str {
        "Show keyboard shortcuts."
    }
    fn usage(&self) -> &'static str {
        "/keys"
    }
    async fn run(&self, _args: &str, app: &mut ReplApp, _engine: &QueryEngine) -> SlashResult {
        app.open_keys_overlay();
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct UsageCommand;

#[async_trait::async_trait]
impl SlashCommand for UsageCommand {
    fn name(&self) -> &'static str {
        "/usage"
    }
    fn description(&self) -> &'static str {
        "Show cumulative API token usage for this session."
    }
    fn usage(&self) -> &'static str {
        "/usage"
    }
    async fn run(&self, _args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let usage = engine.cumulative_usage();
        app.push_message(MessageRole::System, usage.format());
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct HelpCommand;

#[async_trait::async_trait]
impl SlashCommand for HelpCommand {
    fn name(&self) -> &'static str {
        "/help"
    }
    fn aliases(&self) -> &[&'static str] {
        &["/?"]
    }
    fn description(&self) -> &'static str {
        "Show this help message."
    }
    fn usage(&self) -> &'static str {
        "/help"
    }
    async fn run(&self, _args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let registry = SlashRegistry::new();
        let goal_enabled = engine.settings.read().unwrap().goal_enabled;
        let mut lines = vec!["Commands:".to_string()];
        for cmd in registry.iter() {
            if !goal_enabled && cmd.name() == "/goal" {
                continue;
            }
            lines.push(format!(
                "{} {} - {}",
                cmd.name(),
                cmd.usage()
                    .strip_prefix(cmd.name())
                    .unwrap_or(cmd.usage())
                    .trim(),
                cmd.description()
            ));
        }
        app.push_message(MessageRole::System, lines.join("\n"));
        SlashResult::Handled
    }
}

#[cfg(test)]
mod tests {
    use super::{
        format_hooks_status, format_model_configuration, format_tokens_compact, mcp_tool_prefix,
        model_picker_items,
    };
    use kcoder_config::{ActiveModelSelection, ApiFormat, Settings};
    use kcoder_engine::{DiscoveredModelGroup, context::ContextBudget};
    use kcoder_hooks::{HookCommand, HookEvent, HookMatcher, HookRegistry, HookSource};
    use kcoder_types::ReasoningEffort;

    #[test]
    fn model_picker_prioritizes_configured_model_and_suppresses_auto_duplicate() {
        let mut settings = Settings::default();
        settings.providers.retain(|name, _| name == "kunlunmeta");
        let mut deepseek = settings.providers["kunlunmeta"].clone();
        deepseek.default_model = "deepseek-v4-flash".to_string();
        settings
            .providers
            .insert("kunlunmeta-deepseek-v4-flash".to_string(), deepseek);
        settings.active_provider = Some("kunlunmeta".to_string());
        settings.model = "deepseek-v4-flash".to_string();
        settings.active_model_selection = Some(ActiveModelSelection {
            source_profile: "kunlunmeta".to_string(),
            model: "deepseek-v4-flash".to_string(),
        });
        let discovered = vec![DiscoveredModelGroup {
            profile_name: "kunlunmeta".to_string(),
            provider: "kunlunmeta".to_string(),
            endpoint: "http://127.0.0.1:8000".to_string(),
            configured_model: "MiniMax-M3".to_string(),
            models: vec![
                "deepseek-v4-flash".to_string(),
                "other-auto-model".to_string(),
            ],
            error: None,
        }];

        let (entries, selected) = model_picker_items(&settings, &discovered);

        let configured_index = entries
            .iter()
            .position(|entry| entry.selector == "kunlunmeta-deepseek-v4-flash")
            .expect("explicit DeepSeek profile should be visible");
        let first_auto_index = entries
            .iter()
            .position(|entry| entry.discovered)
            .expect("unconfigured discovered model should remain visible");
        assert!(configured_index < first_auto_index);
        assert_eq!(selected, configured_index);
        assert!(entries[configured_index].label.starts_with("[configured] "));
        assert!(
            entries[first_auto_index]
                .label
                .starts_with("[auto:text-only] ")
        );
        assert!(!entries.iter().any(|entry| {
            entry.discovered && entry.model.eq_ignore_ascii_case("deepseek-v4-flash")
        }));
    }

    #[test]
    fn model_configuration_reports_effective_settings_without_exposing_api_key() {
        let settings = Settings {
            active_provider: Some("kimi".to_string()),
            provider: Some("openai".to_string()),
            api_format: Some(ApiFormat::OpenaiResponses),
            base_url: Some("https://api.kimi.com/coding/v1".to_string()),
            model: "kimi-for-coding/k2p6".to_string(),
            model_reasoning_effort: Some(ReasoningEffort::High),
            openai_api_key: Some("super-secret-key".to_string()),
            request_timeout_secs: Some(120),
            max_retries: 3,
            retry_base_delay_ms: 500,
            provider_no_proxy: true,
            max_tokens: Some(32_768),
            ..Settings::default()
        };
        let budget = ContextBudget {
            total: 1_048_576,
            system: 2_000,
            tools: 4_000,
            reserved_output: 32_768,
            messages: 1_009_808,
            auto_compact_threshold: Some(900_000),
            hard_input_limit: None,
            prefire_threshold: None,
            estimated_tool_growth: 15_000,
        };

        let rendered = format_model_configuration(
            &settings,
            "openai",
            Some(
                "https://user:password-secret@api.kimi.com/coding/v1?x-api-key=query-secret&key=gemini-secret&subscription-key=azure-secret&region=cn#token-fragment",
            ),
            Some(true),
            Some(120),
            budget,
        );

        for expected in [
            "Current model configuration",
            "Profile",
            "kimi",
            "Provider",
            "openai",
            "API format",
            "openai_responses",
            "Endpoint",
            "https://api.kimi.com/coding/v1?x-api-key=REDACTED&key=REDACTED&subscription-key=REDACTED&region=cn",
            "Model",
            "kimi-for-coding/k2p6",
            "Reasoning effort",
            "high",
            "Context window",
            "1.05M tokens",
            "Auto compact at",
            "900K tokens",
            "Max output",
            "32.8K tokens",
            "Request timeout",
            "120s",
            "Retries",
            "3 (500ms base delay)",
            "No proxy",
            "true",
            "API key",
            "configured",
        ] {
            assert!(
                rendered.contains(expected),
                "missing {expected:?} in {rendered}"
            );
        }
        assert!(!rendered.contains("super-secret-key"));
        assert!(!rendered.contains("password-secret"));
        assert!(!rendered.contains("query-secret"));
        assert!(!rendered.contains("gemini-secret"));
        assert!(!rendered.contains("azure-secret"));
        assert!(!rendered.contains("token-fragment"));
    }

    #[test]
    fn format_tokens_compact_uses_expected_suffixes() {
        assert_eq!(format_tokens_compact(999), "999");
        assert_eq!(format_tokens_compact(1_250), "1.25K");
        assert_eq!(format_tokens_compact(12_500), "12.5K");
        assert_eq!(format_tokens_compact(123_456), "123K");
        assert_eq!(format_tokens_compact(1_200_000), "1.2M");
    }

    #[test]
    fn mcp_tool_prefix_matches_namespaced_mcp_tool_names() {
        assert_eq!(mcp_tool_prefix("files"), "mcp__files__");
        assert_eq!(mcp_tool_prefix("local server"), "mcp__local_server__");
        assert_eq!(mcp_tool_prefix("!!!"), "mcp__server__");
    }

    #[test]
    fn hooks_status_reports_empty_configuration() {
        let registry = HookRegistry::default();

        assert_eq!(
            format_hooks_status(&registry),
            "No lifecycle hooks configured."
        );
    }

    #[test]
    fn hooks_status_groups_hooks_and_redacts_sensitive_values() {
        let registry = HookRegistry::from_matchers(vec![
            (
                HookEvent::PreToolUse,
                HookMatcher {
                    matcher: Some("Bash".to_string()),
                    hooks: vec![HookCommand::Command {
                        shell: "bash".to_string(),
                        command:
                            "OPENAI_API_KEY=sk-secret curl -H 'Authorization: Bearer token-value'"
                                .to_string(),
                        if_rule: Some("input.command contains npm".to_string()),
                        timeout: 5,
                        async_hook: true,
                    }],
                    source: Some(HookSource::plugin(
                        "plugin-hooks",
                        "Hooks Plugin",
                        "/tmp/plugin-hooks",
                    )),
                },
            ),
            (
                HookEvent::Stop,
                HookMatcher {
                    matcher: None,
                    hooks: vec![HookCommand::Http {
                        url: "https://example.test/hook?api_key=needle-secret".to_string(),
                        method: "POST".to_string(),
                        headers: Default::default(),
                        timeout: 10,
                    }],
                    source: None,
                },
            ),
        ]);

        let rendered = format_hooks_status(&registry);

        assert!(rendered.contains("Lifecycle hooks: 2 hook(s) across 2 matcher(s)."));
        assert!(rendered.contains("PreToolUse (1)"));
        assert!(rendered.contains("- matcher `Bash` from plugin `Hooks Plugin`: 1 hook(s)"));
        assert!(rendered.contains("command [bash, timeout 5s, async]"));
        assert!(rendered.contains("if `input.command contains npm`"));
        assert!(rendered.contains("Stop (1)"));
        assert!(rendered.contains("- matcher `*` from settings: 1 hook(s)"));
        assert!(rendered.contains("http [POST, timeout 10s]: [redacted]"));
        assert!(!rendered.contains("sk-secret"));
        assert!(!rendered.contains("token-value"));
        assert!(!rendered.contains("needle-secret"));
    }
}
