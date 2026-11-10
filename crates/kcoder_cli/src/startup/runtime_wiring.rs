//! Runtime wiring for the shared CLI composition root.

use super::*;

#[cfg(test)]
#[path = "runtime_wiring_tests.rs"]
mod instruction_startup_tests;

fn owned_command_program() -> Result<Option<PathBuf>> {
    #[cfg(target_os = "linux")]
    if kcoder_process_supervisor::linux_stdio::command_owner_available() {
        return Ok(Some(std::env::current_exe()?));
    }
    Ok(None)
}

fn migration_source_launch(
    command: Option<&Commands>,
    account_root: &std::path::Path,
    retention: Option<&app_server::RetentionLaunchConfiguration>,
) -> Result<Option<app_server::RetentionLaunchConfiguration>> {
    let requested = matches!(
        command,
        Some(Commands::AppServer {
            migration_source_parent_local_v1: true,
            ..
        })
    );
    if !requested {
        return Ok(None);
    }
    ensure!(
        retention.is_none(),
        "migration source-only parent cannot replace an existing private parent"
    );
    Ok(Some(app_server::RetentionLaunchConfiguration {
        parent: kcoder_app_protocol::RetentionParentLaunchV1::LocalOs,
        account_root: account_root.into(),
        optional: false,
        revocation_verifier: None,
    }))
}

pub(crate) use kcoder_plugin_rpc::runtime_snapshot::{
    runtime_plugin_snapshot, runtime_plugin_snapshot_with_profile,
};

pub(crate) fn run(
    inherited_parent: Option<kcoder_app_protocol::RetentionParentLaunchV1>,
    inherited_verifier: Option<kcoder_app_protocol::PrivateRetentionVerifierV1>,
    inherited_office: Option<std::ffi::OsString>,
    inherited_connectivity: Option<std::ffi::OsString>,
    runners: CliRunners,
) -> Result<()> {
    #[cfg(target_os = "linux")]
    if inherited_connectivity.is_some()
        && inherited_parent.is_some()
        && inherited_verifier.is_some()
    {
        // The former carrier applied this before starting the task process.
        // Apply it before Tokio creates any threads for the verified launch.
        ensure!(
            unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } == 0,
            "SERVICE_ACCOUNT_RESTRICTION_UNAVAILABLE"
        );
    }
    // Nested verifier/Engine futures exceed Tokio's default worker stack in
    // normal app-server execution. Reserve bounded native stack space here;
    // model/tool authorization and the original runtime shutdown stay intact.
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(16 * 1024 * 1024)
        .build()
        .context("failed to build the CLI runtime")?
        .block_on(run_async(
            inherited_parent,
            inherited_verifier,
            inherited_office,
            inherited_connectivity,
            runners,
        ))
}

async fn run_async(
    inherited_parent: Option<kcoder_app_protocol::RetentionParentLaunchV1>,
    inherited_verifier: Option<kcoder_app_protocol::PrivateRetentionVerifierV1>,
    inherited_office: Option<std::ffi::OsString>,
    inherited_connectivity: Option<std::ffi::OsString>,
    runners: CliRunners,
) -> Result<()> {
    let cli = Cli::parse();
    if matches!(cli.command, Some(Commands::Acp)) {
        bail!("The ACP adapter must run from its isolated stdio entry");
    }
    let interactive_tui =
        cli.prompt.is_none() && matches!(cli.command, None | Some(Commands::TuiDev { .. }));
    init_tracing(interactive_tui);

    let cwd = cli
        .cwd
        .clone()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let cwd = canonicalize_cli_cwd(cwd);
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
    let retention_launch = match &cli.command {
        Some(Commands::AppServer {
            retention_parent_v1,
            retention_account_principal_id,
            retention_account_uid,
            ..
        }) => {
            use crate::cli_args::RetentionParentMode;
            use kcoder_app_protocol::RetentionParentLaunchV1;
            let parent = match (
                retention_parent_v1,
                retention_account_principal_id,
                retention_account_uid,
            ) {
                (None, None, None) => None,
                (Some(RetentionParentMode::LocalOs), None, None) => {
                    Some(RetentionParentLaunchV1::LocalOs)
                }
                (Some(RetentionParentMode::Account), Some(principal), Some(uid))
                    if !principal.is_empty()
                        && principal.len() <= 256
                        && !principal.chars().any(char::is_control) =>
                {
                    Some(RetentionParentLaunchV1::VerifiedAccount {
                        principal_id: principal.clone(),
                        uid: *uid,
                    })
                }
                _ => bail!("invalid retention parent launch configuration"),
            };
            if let (Some(explicit), Some(inherited)) = (&parent, &inherited_parent) {
                ensure!(
                    explicit == inherited,
                    "private parent launch declarations conflict"
                );
            }
            let optional = parent.is_none();
            let parent = parent.or(inherited_parent);
            if let Some(parent) = &parent {
                crate::retention_parent_environment::validate_identity(parent)?;
            }
            parent.map(|parent| app_server::RetentionLaunchConfiguration {
                parent,
                account_root: loaded_settings.paths.config_dir.clone(),
                optional,
                revocation_verifier: inherited_verifier,
            })
        }
        _ => None,
    };
    let migration_launch = migration_source_launch(
        cli.command.as_ref(),
        &loaded_settings.paths.config_dir,
        retention_launch.as_ref(),
    )?;
    let mut settings = loaded_settings.settings.clone();
    apply_cli_settings_overrides(&mut settings, &cli)?;
    if let Some(path) = cli.credential_env_file.as_deref() {
        apply_credential_env_file(&mut settings, path)?;
    }
    emit_plaintext_settings_secret_warning_names(&loaded_settings.plaintext_secret_setting_names);

    let provider_kind = cli_provider_kind(&cli, ProviderKind::from_env(), &settings)?;

    match cli.command.clone() {
        Some(Commands::Migrate { .. }) => {
            bail!("Migration commands must run from their isolated startup entry");
        }
        Some(Commands::Acp) => unreachable!("ACP handled before runtime wiring"),
        Some(Commands::Doctor) => {
            return run_doctor(
                diagnostics::print_cli_build_identity,
                provider_kind,
                &cli,
                &settings,
                &cwd,
                &loaded_settings,
            );
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
                runners.repl,
            )
            .await;
        }
        Some(Commands::Mcp { action }) => return run_mcp(action, &cwd, &settings).await,
        Some(Commands::Daemon { action }) => return daemon::run(action).await,
        Some(Commands::AppServer {
            listen, scenario, ..
        }) => {
            if listen != "stdio://" && listen != "stdio" {
                bail!("unsupported app-server transport '{listen}'; use stdio://");
            }
            if let Some(scenario) = scenario {
                return run_app_server_dev(
                    &cli,
                    settings,
                    scenario,
                    loaded_settings.paths.user_settings.clone(),
                    retention_launch,
                    migration_launch,
                    inherited_office,
                    inherited_connectivity,
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
    // Fail before session IDs, extension processes, or workspace metadata exist.
    // The Engine rechecks the actual guide set at its construction boundary.
    kcoder_config::try_load_project_md_contents(&cwd)?;
    let _app_server_workspace_lease = matches!(cli.command, Some(Commands::AppServer { .. }))
        .then(|| app_server::acquire_app_server_workspace_runtime_lease(&cwd))
        .transpose()?;

    let model = settings.model.clone();
    let can_open_without_model =
        cli.prompt.is_none() && !cli.json && !matches!(cli.command, Some(Commands::MoaPlan { .. }));
    let model_configuration = Arc::new(model_configuration::ModelConfiguration::new(
        settings_loader.clone().freeze_overlays()?,
        cli.clone(),
    ));
    let (provider, signed_out_notice): (Arc<dyn Provider>, Option<String>) = match provider_kind
        .filter(|_| !model.trim().is_empty())
    {
        Some(kind) => {
            let provider = ProviderFactory::new(&settings)
                .with_overrides(provider_overrides_from_cli(&cli))
                .build(kind, &model);
            match provider {
                Ok(provider) => (
                    model_configuration.with_live_credentials(&settings, kind, provider)?,
                    None,
                ),
                Err(error)
                    if can_open_without_model
                        && error.downcast_ref::<MissingApiKeyError>().is_some() =>
                {
                    let notice = format!(
                        "Not signed in for {}. Run `kcoder auth login --provider {}` and restart.",
                        kind.as_str(),
                        kind.as_str()
                    );
                    (
                        Arc::new(SignedOutProvider {
                            name: kind.as_str(),
                            error_type: "missing_api_key",
                            error_message: error.to_string(),
                        }),
                        Some(notice),
                    )
                }
                Err(error) => return Err(error),
            }
        }
        None if can_open_without_model => {
            // Keep settings and history accessible without choosing a transport.
            let notice = "No model is configured. Select a model Provider in settings.";
            (
                Arc::new(SignedOutProvider {
                    name: "unconfigured",
                    error_type: "model_not_configured",
                    error_message: notice.into(),
                }),
                Some(notice.into()),
            )
        }
        None => bail!("No model is configured. Select a model Provider in settings."),
    };

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
    let (tools, mcp_snapshot_complete) = kcoder_session_configuration::configure_startup_tools(
        &cli,
        &mut settings,
        &loaded_settings.paths,
        &cwd,
        &trust_store_config_dir,
        &project_mcp_names,
        &plugin_snapshot,
    )
    .await?;
    let is_app_server = matches!(cli.command, Some(Commands::AppServer { .. }));
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
    let command_owner = owned_command_program()?;
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
        .with_session_configuration(settings_loader.clone(), cli.clone(), mcp_snapshot_complete)?
        .with_owned_command_program(command_owner.clone());
        let engine = factory
            .build_with_state(state, Arc::new(DenyAllUserQuestioner))
            .context("failed to initialize app-server client session storage")?;
        (engine, Some(factory))
    } else {
        (
            QueryEngine::try_new_with_plugin_snapshot(
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
            )?
            .with_owned_command_program(command_owner)
            .with_settings_persistence_path(loaded_settings.paths.user_settings.clone())
            .with_bundled_search_backend(Arc::new(kcoder_mcp::web_search::BundledWebSearch::new()))
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
        let factory =
            app_server_factory.expect("app-server factory is constructed with its engine");
        app_server::run_with_native_launches(
            engine,
            factory,
            permission_mode,
            retention_launch,
            migration_launch,
            inherited_office,
            inherited_connectivity,
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
        let prompt_cb = HeadlessPermissionPrompt::new(permission_mode);
        let headless = runners.headless;
        headless(&engine, prompt, &prompt_cb, cli.json, startup_events).await
    } else {
        let startup_notice = [signed_out_notice, hook_startup_notice(&startup_events)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let startup_notice = (!startup_notice.is_empty()).then(|| startup_notice.join("\n"));
        let repl = runners.repl;
        repl(engine, startup_notice).await
    }
}

pub(crate) async fn run_tui_dev(
    cli: &Cli,
    mut settings: Settings,
    scenario: TuiDevScenario,
    settings_persistence_path: PathBuf,
    repl: ReplRunner,
) -> Result<()> {
    let (engine, _) =
        build_tui_dev_engine(cli, &mut settings, scenario, settings_persistence_path)?;
    let startup_notice = Some(format!(
        "TUI dev mode is running mock scenario `{}`. Type any message and press Enter to {}.",
        scenario.as_str(),
        scenario.startup_description()
    ));
    repl(engine, startup_notice).await
}

#[expect(
    clippy::too_many_arguments,
    reason = "Keep independent inherited host resources and native parent launches explicit"
)]
pub(crate) async fn run_app_server_dev(
    cli: &Cli,
    mut settings: Settings,
    scenario: TuiDevScenario,
    settings_persistence_path: PathBuf,
    retention_launch: Option<app_server::RetentionLaunchConfiguration>,
    migration_launch: Option<app_server::RetentionLaunchConfiguration>,
    inherited_office: Option<std::ffi::OsString>,
    inherited_connectivity: Option<std::ffi::OsString>,
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
    let factory = factory.context("app-server dev engine requires a factory")?;
    app_server::run_with_native_launches(
        engine,
        factory,
        permission_mode,
        retention_launch,
        migration_launch,
        inherited_office,
        inherited_connectivity,
    )
    .await
}

pub(crate) fn build_tui_dev_engine(
    cli: &Cli,
    settings: &mut Settings,
    scenario: TuiDevScenario,
    settings_persistence_path: PathBuf,
) -> Result<(QueryEngine, Option<app_server::AppServerEngineFactory>)> {
    let command_owner = owned_command_program()?;
    settings.model = "tui-dev-mock".to_string();
    settings.permission_mode = PermissionMode::Bypass;
    settings.auto_skill_review_enabled = false;

    let cwd = cli
        .cwd
        .clone()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let cwd = canonicalize_cli_cwd(cwd);

    kcoder_config::try_load_project_md_contents(&cwd)?;
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
        )
        .with_owned_command_program(command_owner.clone());
        let engine = factory
            .build_with_state(state, Arc::new(DenyAllUserQuestioner))
            .context("failed to initialize tui-dev app-server client session storage")?;
        Ok((engine, Some(factory)))
    } else {
        Ok((
            QueryEngine::try_new_with_plugin_snapshot(
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
            )?
            .with_owned_command_program(command_owner)
            .with_settings_persistence_path(settings_persistence_path),
            None,
        ))
    }
}
