use crate::ReplApp;
use crate::render::highlight::theme_names;
use kcoder_engine::QueryEngine;
use kcoder_types::MessageRole;
use tracing::warn;

use super::info_commands::{ModelPickerEntry, model_picker_items};
use super::{SlashCommand, SlashResult};

const INIT_AGENTS_PROMPT: &str = r#"Generate a file named AGENTS.md that serves as a contributor and agent guide for this repository.
Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed - add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., cargo test, make build, npm test).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project's Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions."#;

#[derive(Default)]
pub(super) struct QuitCommand;

#[async_trait::async_trait]
impl SlashCommand for QuitCommand {
    fn name(&self) -> &'static str {
        "/quit"
    }
    fn aliases(&self) -> &[&'static str] {
        &["/q", "/exit"]
    }
    fn description(&self) -> &'static str {
        "Exit the REPL."
    }
    fn usage(&self) -> &'static str {
        "/quit"
    }
    async fn run(&self, _args: &str, _app: &mut ReplApp, _engine: &QueryEngine) -> SlashResult {
        SlashResult::Quit
    }
}

#[derive(Default)]
pub(super) struct NewCommand;

#[async_trait::async_trait]
impl SlashCommand for NewCommand {
    fn name(&self) -> &'static str {
        "/new"
    }
    fn description(&self) -> &'static str {
        "Start a new chat."
    }
    fn usage(&self) -> &'static str {
        "/new"
    }
    async fn run(&self, _args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if app.clear_conversation_ui(engine) {
            engine.set_luna_mode(false);
            app.refresh_engine_metadata(engine);
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct LunaCommand;

#[async_trait::async_trait]
impl SlashCommand for LunaCommand {
    fn name(&self) -> &'static str {
        "/luna"
    }
    fn description(&self) -> &'static str {
        "Start a new chat with the reduced Luna tool allowlist."
    }
    fn usage(&self) -> &'static str {
        "/luna"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if !args.trim().is_empty() {
            app.push_message(MessageRole::System, "Usage: /luna");
            return SlashResult::Handled;
        }

        if !app.clear_conversation_ui(engine) {
            return SlashResult::Handled;
        }
        engine.set_luna_mode(true);
        app.refresh_engine_metadata(engine);
        let allowed = engine.settings.read().unwrap().tools.luna.allowed.clone();
        app.push_message(
            MessageRole::System,
            format!("Luna mode active. Tools: {}", allowed.join(", ")),
        );
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct InitCommand;

#[async_trait::async_trait]
impl SlashCommand for InitCommand {
    fn name(&self) -> &'static str {
        "/init"
    }
    fn description(&self) -> &'static str {
        "Create an AGENTS.md guide for this repository."
    }
    fn usage(&self) -> &'static str {
        "/init"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, _engine: &QueryEngine) -> SlashResult {
        if !args.trim().is_empty() {
            app.push_message(MessageRole::System, "Usage: /init");
            return SlashResult::Handled;
        }

        SlashResult::Submit(INIT_AGENTS_PROMPT.to_string())
    }
}

#[derive(Default)]
pub(super) struct ClearCommand;

#[async_trait::async_trait]
impl SlashCommand for ClearCommand {
    fn name(&self) -> &'static str {
        "/clear"
    }
    fn description(&self) -> &'static str {
        "Clear the conversation."
    }
    fn usage(&self) -> &'static str {
        "/clear"
    }
    async fn run(&self, _args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if app.clear_conversation_ui(engine) {
            engine.set_luna_mode(false);
            app.refresh_engine_metadata(engine);
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct CopyCommand;

#[async_trait::async_trait]
impl SlashCommand for CopyCommand {
    fn name(&self) -> &'static str {
        "/copy"
    }
    fn description(&self) -> &'static str {
        "Copy the latest answer; /copy view opens a selectable source view."
    }
    fn usage(&self) -> &'static str {
        "/copy [view]"
    }
    async fn run(&self, _args: &str, app: &mut ReplApp, _engine: &QueryEngine) -> SlashResult {
        if _args.trim() == "view" {
            app.open_copy_view();
            return SlashResult::Handled;
        }
        app.copy_last_assistant_response();
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct RawCommand;

#[async_trait::async_trait]
impl SlashCommand for RawCommand {
    fn name(&self) -> &'static str {
        "/raw"
    }
    fn description(&self) -> &'static str {
        "Toggle raw scrollback mode for copy-friendly terminal selection."
    }
    fn usage(&self) -> &'static str {
        "/raw [on|off]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, _engine: &QueryEngine) -> SlashResult {
        match args.trim().to_ascii_lowercase().as_str() {
            "" => {
                app.toggle_raw_output_mode_and_notify();
            }
            "on" => {
                app.set_raw_output_mode_and_notify(true);
            }
            "off" => {
                app.set_raw_output_mode_and_notify(false);
            }
            _ => {
                app.push_message(MessageRole::System, "Usage: /raw [on|off]");
            }
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct QueueCommand;

#[async_trait::async_trait]
impl SlashCommand for QueueCommand {
    fn name(&self) -> &'static str {
        "/queue"
    }
    fn description(&self) -> &'static str {
        "Inspect or clear queued prompts."
    }
    fn usage(&self) -> &'static str {
        "/queue [clear]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, _engine: &QueryEngine) -> SlashResult {
        match args.trim() {
            "" | "status" => {
                app.push_message(
                    MessageRole::System,
                    format!(
                        "Queued prompts: {} / {}",
                        app.queued_user_message_count(),
                        crate::USER_MESSAGE_QUEUE_MAX
                    ),
                );
            }
            "clear" => {
                let cleared = app.clear_user_message_queue();
                app.push_message(
                    MessageRole::System,
                    format!("Cleared {cleared} queued prompt(s)."),
                );
            }
            _ => {
                app.push_message(MessageRole::System, "Usage: /queue [clear]");
            }
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct ModelCommand;

#[async_trait::async_trait]
impl SlashCommand for ModelCommand {
    fn name(&self) -> &'static str {
        "/model"
    }
    fn description(&self) -> &'static str {
        "Choose what model to use."
    }
    fn usage(&self) -> &'static str {
        "/model [model-name]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let trimmed = args.trim();
        if trimmed.is_empty() {
            let discovered = cached_or_discover_models(app, engine).await;
            let settings = engine.settings.read().unwrap();
            let (entries, selected) = model_picker_items(&settings, &discovered);
            let labels = entries.iter().map(|entry| entry.label.clone()).collect();
            let selectors = entries.into_iter().map(|entry| entry.selector).collect();
            app.open_picker_overlay_with_selected(
                "Select Model (grouped by provider / profile / endpoint)",
                labels,
                crate::PickerAction::SwitchModel,
                selected,
            );
            if let Some(picker) = app.picker_overlay.as_mut() {
                picker.item_values = selectors;
            }
        } else {
            let exact_profile = {
                let settings = engine.settings.read().unwrap();
                settings
                    .providers
                    .keys()
                    .find(|name| name.eq_ignore_ascii_case(trimmed))
                    .cloned()
            };
            if let Some(profile_name) = exact_profile {
                switch_configured_profile(app, engine, &profile_name);
                return SlashResult::Handled;
            }

            if let Some((profile_name, model)) = trimmed.split_once("::") {
                let profile_name = profile_name.trim();
                let model = model.trim();
                let configured_model = {
                    let settings = engine.settings.read().unwrap();
                    settings
                        .providers
                        .iter()
                        .find(|(name, _)| name.eq_ignore_ascii_case(profile_name))
                        .map(|(name, provider)| (name.clone(), provider.default_model.clone()))
                };
                let Some((profile_name, configured_model)) = configured_model else {
                    app.push_message(
                        MessageRole::System,
                        format!("Unknown provider profile '{profile_name}'. Use /model to see grouped choices."),
                    );
                    return SlashResult::Handled;
                };
                if configured_model.eq_ignore_ascii_case(model) {
                    switch_configured_profile(app, engine, &profile_name);
                } else {
                    switch_auto_discovered_model(app, engine, &profile_name, model);
                }
                return SlashResult::Handled;
            }

            let discovered = cached_or_discover_models(app, engine).await;
            let settings = engine.settings.read().unwrap();
            let (entries, _) = model_picker_items(&settings, &discovered);
            drop(settings);
            let matches = entries
                .into_iter()
                .filter(|entry| entry.model.eq_ignore_ascii_case(trimmed))
                .collect::<Vec<_>>();
            match matches.as_slice() {
                [entry] => switch_model_entry(app, engine, entry),
                [] => app.push_message(
                    MessageRole::System,
                    format!(
                        "Unknown model '{trimmed}'. Use /model to refresh provider model lists, or use /model <profile>::<model>."
                    ),
                ),
                _ => {
                    let choices = matches
                        .iter()
                        .map(|entry| entry.selector.as_str())
                        .collect::<Vec<_>>()
                        .join(", ");
                    app.push_message(
                        MessageRole::System,
                        format!(
                            "Model name '{trimmed}' is ambiguous across deployments. Choose one of: {choices}"
                        ),
                    );
                }
            }
        }
        SlashResult::Handled
    }
}

async fn cached_or_discover_models(
    app: &mut ReplApp,
    engine: &QueryEngine,
) -> Vec<kcoder_engine::DiscoveredModelGroup> {
    let discovery = engine.settings.read().unwrap().model_discovery.clone();
    if !discovery.enabled {
        return Vec::new();
    }
    if let Some(cache) = &app.model_discovery_cache
        && cache.fetched_at.elapsed().as_secs() < discovery.cache_ttl_secs
    {
        return cache.groups.clone();
    }
    let groups = engine.discover_provider_models().await;
    for group in &groups {
        if let Some(error) = &group.error {
            warn!(
                "model discovery failed for profile '{}': {}",
                group.profile_name, error
            );
        }
    }
    app.model_discovery_cache = Some(crate::ModelDiscoveryCache {
        fetched_at: std::time::Instant::now(),
        groups: groups.clone(),
    });
    groups
}

fn switch_model_entry(app: &mut ReplApp, engine: &QueryEngine, entry: &ModelPickerEntry) {
    if entry.discovered {
        switch_auto_discovered_model(app, engine, &entry.profile_name, &entry.model);
    } else {
        switch_configured_profile(app, engine, &entry.profile_name);
    }
}

fn switch_configured_profile(app: &mut ReplApp, engine: &QueryEngine, profile_name: &str) {
    match engine.switch_provider_profile(profile_name) {
        Ok(settings) => {
            persist_model_selection(engine, profile_name, None);
            app.refresh_engine_metadata(engine);
            app.push_message(
                MessageRole::System,
                format!("Model switched to: {} ({profile_name})", settings.model),
            );
        }
        Err(error) => app.push_message(
            MessageRole::System,
            format!("Failed to switch model profile '{profile_name}': {error}"),
        ),
    }
}

fn switch_auto_discovered_model(
    app: &mut ReplApp,
    engine: &QueryEngine,
    profile_name: &str,
    model: &str,
) {
    match engine.switch_discovered_model(profile_name, model) {
        Ok(settings) => {
            persist_model_selection(engine, profile_name, Some(model));
            app.refresh_engine_metadata(engine);
            app.push_message(
                MessageRole::System,
                format!("Model switched to: {profile_name}::{model}"),
            );
            let warning_key = format!("{}::{}", profile_name.to_ascii_lowercase(), model);
            if app.warned_discovered_models.insert(warning_key) {
                app.push_message(
                    MessageRole::System,
                    format!(
                        "First-use notice: '{profile_name}::{model}' was auto-discovered from the Provider model list. Listing proves only the model ID, not availability or capabilities. KCoder keeps the complete '{profile_name}' Provider configuration: {} context, {} output headroom, max output {}. Define another Provider ID when this model needs different capabilities or credentials.",
                        settings.context_window_tokens.unwrap_or_default(),
                        settings.context_output_headroom.unwrap_or_default(),
                        settings.max_tokens.unwrap_or_default(),
                    ),
                );
            }
        }
        Err(error) => app.push_message(
            MessageRole::System,
            format!("Failed to switch discovered model '{profile_name}::{model}': {error}"),
        ),
    }
}

fn persist_model_selection(engine: &QueryEngine, profile_name: &str, model: Option<&str>) {
    let cwd = engine.cwd.clone();
    let profile_name = profile_name.to_string();
    let model = model.map(ToString::to_string);
    tokio::task::spawn_blocking(move || {
        let result = (|| -> anyhow::Result<()> {
            let paths = kcoder_config::ConfigPaths::discover(&cwd)?;
            let mut document =
                kcoder_config::read_scope(&paths, kcoder_config::ConfigScope::Local)?;
            kcoder_config::set_dotted_value(
                &mut document,
                "active_provider",
                serde_json::Value::String(profile_name.clone()),
            )?;
            let selection = match model {
                Some(model) => serde_json::json!({
                    "source_profile": profile_name,
                    "model": model,
                }),
                None => serde_json::Value::Null,
            };
            kcoder_config::set_dotted_value(&mut document, "active_model_selection", selection)?;
            kcoder_config::write_scope(&paths, kcoder_config::ConfigScope::Local, &document)
        })();
        if let Err(error) = result {
            warn!("failed to persist active model selection: {error}");
        }
    });
}

#[derive(Default)]
pub(super) struct ThemeCommand;

fn theme_picker_items(current_theme: &str) -> (Vec<String>, usize) {
    let mut themes = theme_names();
    if !current_theme.trim().is_empty()
        && !themes
            .iter()
            .any(|theme| theme.eq_ignore_ascii_case(current_theme))
    {
        themes.insert(0, current_theme.to_string());
    }
    let selected = themes
        .iter()
        .position(|theme| theme.eq_ignore_ascii_case(current_theme))
        .unwrap_or(0);
    (themes, selected)
}

#[async_trait::async_trait]
impl SlashCommand for ThemeCommand {
    fn name(&self) -> &'static str {
        "/theme"
    }
    fn description(&self) -> &'static str {
        "Choose a syntax highlighting theme."
    }
    fn usage(&self) -> &'static str {
        "/theme [theme-name]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let trimmed = args.trim();
        if trimmed.is_empty() {
            let current_theme = engine.settings.read().unwrap().code_theme.clone();
            let (themes, selected) = theme_picker_items(&current_theme);
            app.open_picker_overlay_with_selected(
                "Select Theme",
                themes,
                crate::PickerAction::SwitchTheme,
                selected,
            );
        } else {
            let settings_clone = {
                let mut settings = engine.settings.write().unwrap();
                settings.code_theme = trimmed.to_string();
                settings.clone()
            };
            if let Err(e) = engine
                .persist_settings_fields(settings_clone, &["code_theme"])
                .await
            {
                warn!("failed to save theme setting: {}", e);
            }
            app.set_code_theme(trimmed.to_string());
            app.push_message(
                MessageRole::System,
                format!("Theme switched to: {}", trimmed),
            );
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct MentionCommand;

#[async_trait::async_trait]
impl SlashCommand for MentionCommand {
    fn name(&self) -> &'static str {
        "/mention"
    }
    fn description(&self) -> &'static str {
        "Mention a file."
    }
    fn usage(&self) -> &'static str {
        "/mention"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, _engine: &QueryEngine) -> SlashResult {
        if !args.trim().is_empty() {
            app.push_message(MessageRole::System, "Usage: /mention");
            return SlashResult::Handled;
        }
        app.prefill_input("@".to_string());
        SlashResult::Handled
    }
}
