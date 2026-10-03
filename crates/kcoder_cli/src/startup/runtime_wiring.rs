//! Runtime wiring for the shared CLI composition root.

use super::*;

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

impl ProviderKind {
    pub(crate) fn from_env() -> Option<ApiProviderKind> {
        ApiProviderKind::from_env()
    }

    #[cfg(test)]
    pub(crate) fn parse_settings_value(value: &str) -> Option<ApiProviderKind> {
        ApiProviderKind::parse(value)
    }

    pub(crate) fn from_settings(settings: &Settings) -> Result<Option<ApiProviderKind>> {
        ApiProviderKind::from_settings(settings)
    }
}

pub(crate) fn builtin_tools_for_settings(cli: &Cli, settings: &Settings) -> ToolRegistry {
    let tools = match cli.tool_profile.effective(settings.tools.profile) {
        kcoder_config::ToolProfile::Full => default_registry(),
        kcoder_config::ToolProfile::Core => core_registry(),
        kcoder_config::ToolProfile::Nano => nano_registry(),
        kcoder_config::ToolProfile::None => return ToolRegistry::new(),
    };
    let tools = tools.register(ConfigTool);
    let tools = if settings.knowledge.can_retrieve() {
        tools.register(kcoder_tools::wiki::WikiTool)
    } else {
        tools
    };
    if settings.knowledge.can_organize() {
        tools.register(kcoder_tools::wiki_manage::WikiManageTool)
    } else {
        tools
    }
}

pub(crate) fn runtime_plugin_snapshot(
    cwd: &std::path::Path,
    folder_trusted: bool,
    settings: &Settings,
) -> Result<kcoder_plugins::EffectivePluginSnapshot> {
    if settings.training_mode {
        return Ok(kcoder_plugins::EffectivePluginSnapshot::default());
    }
    #[cfg(windows)]
    if kcoder_plugins::computer_use_policy_allows(&settings.plugins)
        && !kcoder_plugins::computer_use_requires_explicit_enable(
            &settings.plugins,
            &settings.mcp_servers,
        )
        && std::env::current_exe()
            .ok()
            .and_then(|exe| {
                exe.parent()?
                    .parent()
                    .map(|root| root.join("computer-use/runtime-manifest.json"))
            })
            .is_some_and(|path| path.is_file())
    {
        let id = kcoder_plugins::PluginId::new("kcoder-windows-computer-use", "kcoder-bundled")?;
        if kcoder_plugins::PluginStore::open_default()?
            .read(&id)?
            .is_none_or(|record| kcoder_plugins::computer_use_guidance_needs_update(&record.source))
        {
            let manager =
                kcoder_plugins::PluginManager::open_default_for_cwd_with_effective_settings(
                    cwd,
                    settings.plugins.clone(),
                )?;
            manager.install_from_marketplace(
                cwd,
                false,
                "kcoder-bundled",
                "kcoder-windows-computer-use",
            )?;
        }
    }
    kcoder_plugins::PluginRegistry::discover_with_trust_and_settings(
        cwd,
        folder_trusted,
        &settings.plugins,
    )
    .map(|registry| registry.effective_snapshot())
}

pub(crate) fn apply_training_skill_isolation(settings: &Settings, registry: &mut SkillRegistry) {
    if settings.training_mode {
        registry.remove_named("kcoder-settings");
    }
}

pub(crate) fn optional_runtime_name(value: Option<&str>) -> Option<String> {
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

#[tokio::main]
pub(crate) async fn run(
    bootstrap_outcome: Option<internal_bootstrap::BootstrapOutcome>,
) -> Result<()> {
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

    let effective_tool_profile = cli.tool_profile.effective(settings.tools.profile);
    let mut tools = builtin_tools_for_settings(&cli, &settings);
    let is_app_server = matches!(cli.command, Some(Commands::AppServer { .. }));
    // Optional services must leave room for the Gateway's 12-second initialize handshake.
    let mcp_startup_deadline =
        is_app_server.then(|| tokio::time::Instant::now() + std::time::Duration::from_secs(8));
    let mut mcp_snapshot_complete = true;
    if !matches!(effective_tool_profile, kcoder_config::ToolProfile::None) {
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
                        let required_trust = plugin_source
                            .and_then(|source| source.required_trust_directory.as_deref())
                            .or_else(|| {
                                project_mcp_names
                                    .contains(&server.name)
                                    .then_some(cwd.as_path())
                            });
                        let tool = match required_trust {
                            Some(directory) => {
                                tool.with_folder_trust(directory, &trust_store_config_dir)
                            }
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

pub(crate) async fn run_tui_dev(
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

pub(crate) async fn run_app_server_dev(
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

pub(crate) fn build_tui_dev_engine(
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

pub(crate) fn history_dir_for_session(
    settings: &Settings,
    cwd: &std::path::Path,
) -> Result<PathBuf> {
    if settings.history_directory.is_some() || std::env::var_os("KCODER_HISTORY_DIR").is_some() {
        settings.history_dir()
    } else {
        Settings::project_data_dir(cwd)
    }
}

pub(crate) fn history_dirs_for_read(
    settings: &Settings,
    cwd: &std::path::Path,
) -> Result<Vec<PathBuf>> {
    if settings.history_directory.is_some() || std::env::var_os("KCODER_HISTORY_DIR").is_some() {
        return settings.history_dir().map(|dir| vec![dir]);
    }
    Settings::project_data_dirs_for_read(cwd)
}

pub(crate) fn apply_cli_orchestrate_mode(
    state: &AppState,
    requested: bool,
    resumed: bool,
) -> Result<()> {
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

pub(crate) fn resolve_resume_history_path(
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

pub(crate) fn configure_history_path(settings: &Settings, state: &AppState) {
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
