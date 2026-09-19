use super::*;

#[test]
fn provider_template_commands_parse_without_provider_credentials() {
    assert!(Cli::try_parse_from(["kcoder", "config", "templates"]).is_ok());
    assert!(Cli::try_parse_from(["kcoder", "config", "template", "deepseek"]).is_ok());
    assert!(Cli::try_parse_from(["kcoder", "config", "template"]).is_err());
}

#[test]
fn clean_user_config_starts_in_yolo_mode() {
    let document = initial_config_scope_document(ConfigScope::User);
    assert_eq!(document["permission_mode"], "yolo");
    assert_eq!(document["tui"]["alternate_screen"], "auto");
    assert_eq!(document.as_object().unwrap().len(), 3);
    assert_eq!(
        initial_config_scope_document(ConfigScope::Project),
        serde_json::json!({})
    );
}

#[test]
fn first_start_creates_user_settings_without_overwriting_existing_settings() {
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().join("project");
    let config_dir = temp.path().join("config");
    std::fs::create_dir_all(&cwd).unwrap();

    let path = ensure_default_user_settings(&cwd, &config_dir).unwrap();
    let created: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(created, initial_config_scope_document(ConfigScope::User));

    let existing = serde_json::json!({"permission_mode": "ask"});
    std::fs::write(
        &path,
        format!("{}\n", serde_json::to_string_pretty(&existing).unwrap()),
    )
    .unwrap();
    ensure_default_user_settings(&cwd, &config_dir).unwrap();
    let preserved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(preserved, existing);
}

use clap::CommandFactory;

fn cli_for_test() -> Cli {
    Cli {
        prompt: None,
        command: None,
        settings_files: Vec::new(),
        credential_env_file: None,
        profile: None,
        model: None,
        max_tokens: None,
        summary_provider: None,
        summary_profile: None,
        summary_model: None,
        summary_max_tokens: None,
        provider: None,
        api_key: None,
        base_url: None,
        openai_api_key: None,
        openai_base_url: None,
        openai_user_agent: None,
        local_base_url: None,
        local_api_key: None,
        gemini_api_key: None,
        grok_api_key: None,
        max_retries: None,
        max_duration_secs: None,
        retry_base_delay_ms: None,
        permission_mode: None,
        tool_profile: ToolProfile::Auto,
        cwd: None,
        json: false,
        no_alt_screen: false,
        skill_review: false,
        training_mode: false,
        resume: None,
        orchestrate: false,
        required_skills: Vec::new(),
    }
}

#[test]
fn development_config_inputs_are_explicit_global_options() {
    let cli = Cli::try_parse_from([
        "kcoder",
        "--settings-file",
        "base.json",
        "--settings-file",
        "local.json",
        "--credential-env-file",
        "credentials.env",
        "doctor",
    ])
    .unwrap();
    assert_eq!(
        cli.settings_files,
        vec![PathBuf::from("base.json"), PathBuf::from("local.json")]
    );
    assert_eq!(
        cli.credential_env_file,
        Some(PathBuf::from("credentials.env"))
    );
}

#[test]
fn resume_flag_parses() {
    let cli = Cli::try_parse_from(["kcoder", "--resume", "latest"]).unwrap();
    assert_eq!(cli.resume.as_deref(), Some("latest"));
    let cli = Cli::try_parse_from(["kcoder"]).unwrap();
    assert!(cli.resume.is_none());
}

#[test]
fn orchestrate_flag_parses() {
    let cli = Cli::try_parse_from(["kcoder", "--orchestrate"]).unwrap();
    assert!(cli.orchestrate);
    let cli = Cli::try_parse_from(["kcoder"]).unwrap();
    assert!(!cli.orchestrate);
}

#[test]
fn cli_orchestrate_mode_rejects_resumed_default_session() {
    let temp = tempfile::tempdir().unwrap();
    let state = AppState::new(temp.path());

    let error = apply_cli_orchestrate_mode(&state, true, true).unwrap_err();

    assert!(error.to_string().contains("cannot combine --orchestrate"));
    assert!(state.session_mode().is_default());
}

#[test]
fn cli_orchestrate_mode_accepts_new_and_already_orchestrated_sessions() {
    let temp = tempfile::tempdir().unwrap();
    let state = AppState::new(temp.path());

    apply_cli_orchestrate_mode(&state, true, false).unwrap();
    assert!(state.session_mode().is_orchestrate());
    apply_cli_orchestrate_mode(&state, false, true).unwrap();
    apply_cli_orchestrate_mode(&state, true, true).unwrap();
}

#[test]
fn required_skills_and_scoped_trust_commands_parse() {
    let cli = Cli::try_parse_from([
        "kcoder",
        "--require-skill",
        "ci-triage",
        "--require-skill",
        "verification",
        "--json",
        "audit",
    ])
    .unwrap();
    assert_eq!(cli.required_skills, ["ci-triage", "verification"]);

    let cli = Cli::try_parse_from(["kcoder", "trust", "add", "--path", "/tmp/project"]).unwrap();
    assert!(matches!(
        cli.command,
        Some(Commands::Trust {
            action: TrustAction::Add { path }
        }) if path == Path::new("/tmp/project")
    ));

    assert!(Cli::try_parse_from(["kcoder", "trust", "add"]).is_err());
}

#[test]
fn required_project_skill_preflight_fails_before_model_until_root_is_trusted() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    let skill_dir = project.join(".kcoder/skills/ci-triage");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: ci-triage\ndescription: Triage CI\n---\n\nUse this skill.\n",
    )
    .unwrap();
    let external_dirs = Vec::<PathBuf>::new();
    let untrusted =
        SkillRegistry::load_with_external_dirs_and_trust(&project, external_dirs.iter(), false)
            .unwrap();
    let settings = Settings {
        permission_mode: PermissionMode::Yolo,
        ..Settings::default()
    };
    let permissions = PermissionEngine::from_settings(&settings);
    let tools = default_registry();

    let failure = required_skill_preflight(
        &["ci-triage".to_string()],
        false,
        &untrusted,
        &tools,
        &permissions,
        &project,
        true,
    )
    .unwrap_err();
    assert_eq!(failure.reason, "project_not_trusted");
    assert!(failure.remediation.contains("kcoder trust add --path"));

    let trusted =
        SkillRegistry::load_with_external_dirs_and_trust(&project, external_dirs.iter(), true)
            .unwrap();
    required_skill_preflight(
        &["ci-triage".to_string()],
        true,
        &trusted,
        &tools,
        &permissions,
        &project,
        true,
    )
    .unwrap();
}

#[test]
fn prompt_with_leading_hyphen_is_accepted_as_positional() {
    let cli =
        Cli::try_parse_from(["kcoder", "- You are given a state dict. Do the task."]).unwrap();
    assert_eq!(
        cli.prompt.as_deref(),
        Some("- You are given a state dict. Do the task.")
    );
    // Flags before the prompt still parse, and a `--` separator keeps working.
    let cli =
        Cli::try_parse_from(["kcoder", "--json", "--", "- You are given a state dict."]).unwrap();
    assert!(cli.json);
    assert_eq!(cli.prompt.as_deref(), Some("- You are given a state dict."));
}

#[test]
fn moa_plan_is_a_formal_headless_subcommand() {
    let cli = Cli::try_parse_from(["kcoder", "moa-plan", "设计新的缓存失效计划"]).unwrap();
    match cli.command {
        Some(Commands::MoaPlan { prompt }) => {
            assert_eq!(prompt, "设计新的缓存失效计划");
        }
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn moa_plan_rejects_removed_yes_option() {
    let error =
        Cli::try_parse_from(["kcoder", "moa-plan", "--yes", "设计新的缓存失效计划"]).unwrap_err();

    assert!(error.to_string().contains("unexpected argument '--yes'"));
}

fn write_session(dir: &std::path::Path, session_id: &str, text: &str) {
    let state = AppState::new(dir);
    state.with_history_path(dir.join(format!("{session_id}.jsonl")));
    state.add_message(Message::user_text(text));
    state.save_history().unwrap();
}

#[test]
fn resolve_resume_history_path_supports_latest_id_and_prefix() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        history_directory: Some(tmp.path().to_path_buf()),
        ..Settings::default()
    };
    write_session(tmp.path(), "1000000000001", "first");
    std::thread::sleep(std::time::Duration::from_millis(30));
    write_session(tmp.path(), "1000000000002", "second");
    std::thread::sleep(std::time::Duration::from_millis(30));
    write_session(tmp.path(), "2000000000003", "third");

    let latest = resolve_resume_history_path(&settings, tmp.path(), "latest").unwrap();
    assert_eq!(latest.file_stem().unwrap(), "2000000000003");

    let direct = resolve_resume_history_path(&settings, tmp.path(), "1000000000001").unwrap();
    assert_eq!(direct.file_stem().unwrap(), "1000000000001");

    let prefixed = resolve_resume_history_path(&settings, tmp.path(), "20000").unwrap();
    assert_eq!(prefixed.file_stem().unwrap(), "2000000000003");

    let ambiguous = resolve_resume_history_path(&settings, tmp.path(), "10000").unwrap_err();
    assert!(ambiguous.to_string().contains("ambiguous"));

    let missing = resolve_resume_history_path(&settings, tmp.path(), "99999").unwrap_err();
    assert!(missing.to_string().contains("no session matching"));

    let outside = tmp.path().parent().unwrap().join("outside.jsonl");
    std::fs::write(&outside, "must not be resumed").unwrap();
    let traversal = resolve_resume_history_path(&settings, tmp.path(), "../outside");
    assert!(traversal.is_err());
    assert_eq!(
        std::fs::read_to_string(outside).unwrap(),
        "must not be resumed"
    );
}

#[test]
fn resolve_resume_history_path_latest_errors_without_sessions() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = Settings {
        history_directory: Some(tmp.path().to_path_buf()),
        ..Settings::default()
    };
    let error = resolve_resume_history_path(&settings, tmp.path(), "latest").unwrap_err();
    assert!(error.to_string().contains("no sessions found"));
}

#[test]
fn provider_kind_parses_settings_values_and_aliases() {
    assert_eq!(
        ProviderKind::parse_settings_value("openai"),
        Some(ApiProviderKind::Openai)
    );
    assert_eq!(
        ProviderKind::parse_settings_value("openai-compatible"),
        Some(ApiProviderKind::Local)
    );
    assert_eq!(
        ProviderKind::parse_settings_value("vllm"),
        Some(ApiProviderKind::Local)
    );
    assert_eq!(
        ProviderKind::parse_settings_value("sglang"),
        Some(ApiProviderKind::Local)
    );
    assert_eq!(ProviderKind::parse_settings_value("minimax"), None);
    assert_eq!(
        ProviderKind::parse_settings_value("kunlunmeta"),
        Some(ApiProviderKind::Kunlunmeta)
    );
    assert_eq!(ProviderKind::parse_settings_value("unknown"), None);
}

#[test]
fn provider_resolution_prefers_cli_then_env_then_settings_then_default() {
    let settings = Settings {
        provider: Some("grok".to_string()),
        ..Settings::default()
    };

    assert_eq!(
        resolve_provider_kind(Some("openai"), Some(ApiProviderKind::Local), &settings).unwrap(),
        ApiProviderKind::Openai
    );
    assert_eq!(
        resolve_provider_kind(None, Some(ApiProviderKind::Local), &settings).unwrap(),
        ApiProviderKind::Local
    );
    assert_eq!(
        resolve_provider_kind(None, None, &settings).unwrap(),
        ApiProviderKind::Grok
    );
    assert_eq!(
        resolve_provider_kind(None, None, &Settings::default()).unwrap(),
        ApiProviderKind::Kunlunmeta
    );
}

#[test]
fn custom_provider_uses_configured_api_format_transport() {
    let settings = Settings {
        provider: Some("deepseek".to_string()),
        api_format: Some(kcoder_config::ApiFormat::OpenaiChatCompletions),
        ..Settings::default()
    };

    assert_eq!(
        resolve_provider_kind(None, None, &settings).unwrap(),
        ApiProviderKind::Openai
    );
}

#[test]
fn cli_explicit_model_keeps_provider_identity_and_per_model_limits() {
    let profile = || {
        serde_json::from_value(serde_json::json!({
        "provider":"openai", "api_format":"openai_chat_completions", "endpoint":"https://example.invalid/v1",
        "default_model":"same", "context_window_tokens":100000,"output_headroom_tokens":4096,"max_output_tokens":4096,
        "models": {
            "same":{"context_window_tokens":100000,"output_headroom_tokens":4096,"max_output_tokens":4096},
            "other":{"context_window_tokens":200000,"output_headroom_tokens":8192,"max_output_tokens":8192}
        }
    })).unwrap()
    };
    for (selector, provider, model, tokens) in [
        ("same", "first", "same", 100000),
        ("other", "first", "other", 200000),
        ("second::same", "second", "same", 100000),
    ] {
        let mut settings = Settings::default();
        settings.providers.insert("first".into(), profile());
        settings.providers.insert("second".into(), profile());
        let cli =
            Cli::try_parse_from(["kcoder", "--provider", "first", "--model", selector]).unwrap();
        apply_cli_settings_overrides(&mut settings, &cli).unwrap();
        assert_eq!(settings.active_provider.as_deref(), Some(provider));
        assert_eq!(settings.model, model);
        assert_eq!(settings.context_window_tokens, Some(tokens));
        if selector.contains("::") {
            assert_eq!(
                resolve_cli_provider_kind(&cli, Some(ApiProviderKind::Anthropic), &settings)
                    .unwrap(),
                ApiProviderKind::Openai
            );
        }
    }
    let mut settings = Settings::default();
    settings.providers.remove("openai");
    settings.apply_provider(Some("kunlunmeta")).unwrap();
    assert_eq!(settings.active_provider.as_deref(), Some("kunlunmeta"));
    let cli = Cli::try_parse_from([
        "kcoder",
        "--provider",
        "openai",
        "--model",
        "legacy-raw-model",
    ])
    .unwrap();
    apply_cli_settings_overrides(&mut settings, &cli).unwrap();
    assert_eq!(settings.provider.as_deref(), Some("openai"));
    assert!(settings.active_provider.is_none());
    assert!(settings.active_model_selection.is_none());
    assert!(settings.base_url.is_none());
    assert_eq!(settings.model, "legacy-raw-model");
    assert_eq!(
        resolve_cli_provider_kind(&cli, None, &settings).unwrap(),
        ApiProviderKind::Openai
    );
}

#[test]
fn provider_flag_selects_a_custom_profile() {
    let mut settings = Settings::default();
    settings.providers.insert(
        "deepseek".to_string(),
        serde_json::from_value(serde_json::json!({
            "provider": "deepseek",
            "credential_env": ["DEEPSEEK_API_KEY"],
            "api_format": "openai_chat_completions",
            "endpoint": "https://api.deepseek.com/v1",
            "model": "deepseek-chat",
            "context_window_tokens": 128000,
            "output_headroom_tokens": 8192,
            "max_output_tokens": 8192
        }))
        .unwrap(),
    );
    let cli = Cli::try_parse_from(["kcoder", "--provider", "deepseek"]).unwrap();

    apply_cli_settings_overrides(&mut settings, &cli).unwrap();

    assert_eq!(settings.active_provider.as_deref(), Some("deepseek"));
    assert_eq!(settings.provider.as_deref(), Some("deepseek"));
    assert_eq!(settings.model, "deepseek-chat");
    assert_eq!(
        settings.base_url.as_deref(),
        Some("https://api.deepseek.com/v1")
    );
}

#[test]
fn provider_flag_clears_active_provider_transport_for_builtin_provider() {
    let mut settings = Settings::default();
    let cli =
        Cli::try_parse_from(["kcoder", "--provider", "local", "--model", "local-model"]).unwrap();

    apply_cli_settings_overrides(&mut settings, &cli).unwrap();

    assert_eq!(settings.active_provider, None);
    assert_eq!(settings.provider.as_deref(), Some("local"));
    assert_eq!(settings.api_format, None);
    assert_eq!(settings.base_url, None);
    assert_eq!(settings.model, "local-model");
}

#[test]
fn cli_accepts_provider_retry_overrides() {
    let cli = Cli::try_parse_from([
        "kcoder",
        "--max-retries",
        "1",
        "--retry-base-delay-ms",
        "500",
    ])
    .unwrap();

    assert_eq!(cli.max_retries, Some(1));
    assert_eq!(cli.retry_base_delay_ms, Some(500));
}

#[test]
fn cli_accepts_summary_runtime_overrides() {
    let cli = Cli::try_parse_from([
        "kcoder",
        "--summary-provider",
        "minimax",
        "--summary-profile",
        "minimax-summary",
        "--summary-model",
        "MiniMax-M2.7-highspeed",
    ])
    .unwrap();

    assert_eq!(cli.summary_provider.as_deref(), Some("minimax"));
    assert_eq!(cli.summary_profile.as_deref(), Some("minimax-summary"));
    assert_eq!(cli.summary_model.as_deref(), Some("MiniMax-M2.7-highspeed"));
}

#[test]
fn training_mode_is_a_global_runtime_flag() {
    let cli = Cli::try_parse_from([
        "kcoder",
        "--orchestrate",
        "--training-mode",
        "Reply briefly.",
    ])
    .unwrap();

    assert!(cli.training_mode);
    assert!(cli.orchestrate);
}

#[test]
fn training_mode_disables_background_model_calls_without_removing_agent_capabilities() {
    let mut settings = Settings {
        auto_memory_enabled: true,
        auto_tool_memory_enabled: true,
        goal_enabled: true,
        max_retries: 5,
        ..Settings::default()
    };
    settings.memory.structured_enabled = true;
    settings.memory.legacy_prompt_enabled = true;
    settings.memory.observer_mode = kcoder_config::MemoryObserverMode::Model;
    settings.session_memory.enabled = true;
    settings.session_memory.update_enabled = true;
    settings.session_memory.compact_enabled = true;
    settings.skills.auto_skill_review_enabled = true;
    settings.skills.auto_curator_enabled = true;
    settings.moa.enabled = true;
    settings.moa_plan.enabled = true;
    let mut cli = cli_for_test();
    cli.skill_review = true;
    cli.training_mode = true;

    apply_cli_settings_overrides(&mut settings, &cli).unwrap();

    assert!(settings.training_mode);
    assert!(settings.auto_memory_enabled);
    assert!(settings.auto_tool_memory_enabled);
    assert!(settings.memory.structured_enabled);
    assert!(settings.memory.legacy_prompt_enabled);
    assert_eq!(
        settings.memory.observer_mode,
        kcoder_config::MemoryObserverMode::Model
    );
    assert!(settings.session_memory.enabled);
    assert!(settings.session_memory.update_enabled);
    assert!(settings.session_memory.compact_enabled);
    assert!(settings.auto_skill_review_enabled);
    assert!(settings.skills.auto_skill_review_enabled);
    assert!(settings.skills.auto_curator_enabled);
    assert!(settings.goal_enabled);
    assert!(settings.moa.enabled);
    assert!(settings.moa_plan.enabled);
    assert_eq!(settings.max_retries, 0);
    for name in [
        "spawn_agent",
        "explore_agent",
        "PlanAgent",
        "Workflow",
        "Config",
    ] {
        assert!(!settings.tools.disabled.iter().any(|value| value == name));
    }
}

#[test]
fn training_mode_runtime_isolation_removes_plugins_and_kcoder_settings() {
    let temp = tempfile::tempdir().unwrap();
    let plugin_dir = temp
        .path()
        .join(".kcoder/plugins/training-probe/.codex-plugin");
    let skill_dir = temp.path().join(".kcoder/skills/kcoder-settings");
    std::fs::create_dir_all(&plugin_dir).unwrap();
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        plugin_dir.join("plugin.json"),
        r#"{"name":"training-probe","version":"1.0.0"}"#,
    )
    .unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: kcoder-settings\ndescription: Test settings skill\n---\n\n# Test\n",
    )
    .unwrap();

    let mut settings = Settings::default();
    let normal = runtime_plugin_snapshot(temp.path(), true, &settings).unwrap();
    assert!(normal.plugin_ids.iter().any(|id| id == "training-probe"));
    let mut skills = SkillRegistry::load_project_only(temp.path()).unwrap();
    assert!(skills.get("kcoder-settings").is_some());

    settings.enable_training_mode();
    let training = runtime_plugin_snapshot(temp.path(), true, &settings).unwrap();
    apply_training_skill_isolation(&settings, &mut skills);

    assert!(training.plugin_ids.is_empty());
    assert!(training.skill_roots.is_empty());
    assert!(training.hook_matchers.is_empty());
    assert!(training.mcp_configs.is_empty());
    assert!(skills.get("kcoder-settings").is_none());
}

#[test]
fn summary_cli_overrides_replace_or_clear_a_settings_profile() {
    let mut settings = Settings {
        summary_profile: Some("minimax-summary".to_string()),
        ..Settings::default()
    };
    let mut cli = cli_for_test();
    cli.summary_model = Some("alternate-summary".to_string());

    apply_cli_settings_overrides(&mut settings, &cli).unwrap();

    assert_eq!(settings.summary_profile, None);
    assert_eq!(settings.summary_model.as_deref(), Some("alternate-summary"));

    settings.summary_profile = Some("minimax-summary".to_string());
    cli.summary_model = None;
    cli.summary_profile = Some("current".to_string());
    apply_cli_settings_overrides(&mut settings, &cli).unwrap();
    assert_eq!(settings.summary_profile, None);
}

#[test]
fn cli_accepts_codex_no_alt_screen_flag() {
    let cli = Cli::try_parse_from(["kcoder", "--no-alt-screen"]).unwrap();

    assert!(cli.no_alt_screen);
}

#[test]
fn mcp_add_preserves_a_windows_argument_with_spaces_and_unicode() {
    let server_path = r"C:\Users\用户 home\MCP 服务.js";
    let cli = Cli::try_parse_from([
        "kcoder",
        "mcp",
        "add",
        "windows-server",
        "--command",
        "node.exe",
        "--args",
        server_path,
        "--env",
        "WINDOWS_MCP_ENV=ok",
    ])
    .unwrap();

    let Some(Commands::Mcp {
        action: McpAction::Add { args, env, .. },
    }) = cli.command
    else {
        panic!("expected mcp add command");
    };
    assert_eq!(args, vec![server_path]);
    assert_eq!(env, vec!["WINDOWS_MCP_ENV=ok"]);
}

#[test]
fn configure_history_path_uses_settings_directory_when_enabled() {
    let tmp = std::env::temp_dir().join(format!(
        "kcoder-cli-history-enabled-test-{}",
        std::process::id()
    ));
    let history_dir = tmp.join("history");
    let settings = Settings {
        history_directory: Some(history_dir.clone()),
        ..Settings::default()
    };
    let state = AppState::new(&tmp);

    configure_history_path(&settings, &state);

    let history_path = state.history_path().expect("history path should be set");
    assert_eq!(history_path.parent(), Some(history_dir.as_path()));
    assert_eq!(
        history_path.extension().and_then(|ext| ext.to_str()),
        Some("jsonl")
    );
}

#[test]
fn configure_history_path_respects_disabled_history() {
    let tmp = std::env::temp_dir().join(format!(
        "kcoder-cli-history-disabled-test-{}",
        std::process::id()
    ));
    let settings = Settings {
        history_enabled: false,
        history_directory: Some(tmp.join("history")),
        ..Settings::default()
    };
    let state = AppState::new(&tmp);

    configure_history_path(&settings, &state);

    assert!(state.history_path().is_none());
}

#[test]
fn canonicalize_cli_cwd_uses_user_facing_windows_paths() {
    let temp = tempfile::tempdir().unwrap();
    let canonical = canonicalize_cli_cwd(temp.path().to_path_buf());
    assert!(canonical.is_absolute());
    #[cfg(windows)]
    assert!(
        !canonical.to_string_lossy().starts_with(r"\\?\"),
        "CLI paths must not expose the Windows verbatim-path prefix: {}",
        canonical.display()
    );
}

#[test]
fn cli_accepts_tui_dev_scenario() {
    let cli = Cli::try_parse_from(["kcoder", "tui-dev", "--scenario", "full-turn"]).unwrap();

    assert!(matches!(
        cli.command,
        Some(Commands::TuiDev {
            scenario: TuiDevScenario::FullTurn
        })
    ));
}

#[test]
fn cli_accepts_tui_dev_markdown_showcase_scenario() {
    let cli =
        Cli::try_parse_from(["kcoder", "tui-dev", "--scenario", "markdown-showcase"]).unwrap();

    assert!(matches!(
        cli.command,
        Some(Commands::TuiDev {
            scenario: TuiDevScenario::MarkdownShowcase
        })
    ));
}

#[test]
fn cli_accepts_tui_dev_mixed_tools_scenario() {
    let cli = Cli::try_parse_from(["kcoder", "tui-dev", "--scenario", "mixed-tools"]).unwrap();

    assert!(matches!(
        cli.command,
        Some(Commands::TuiDev {
            scenario: TuiDevScenario::MixedTools
        })
    ));
}

#[test]
fn cli_accepts_tui_dev_busy_wait_scenario() {
    let cli = Cli::try_parse_from(["kcoder", "tui-dev", "--scenario", "busy-wait"]).unwrap();

    assert!(matches!(
        cli.command,
        Some(Commands::TuiDev {
            scenario: TuiDevScenario::BusyWait
        })
    ));
}

#[test]
fn cli_accepts_tui_dev_long_write_scenario() {
    let cli = Cli::try_parse_from(["kcoder", "tui-dev", "--scenario", "long-write"]).unwrap();

    assert!(matches!(
        cli.command,
        Some(Commands::TuiDev {
            scenario: TuiDevScenario::LongWrite
        })
    ));
}

#[test]
fn cli_accepts_tui_dev_thinking_preview_scenario() {
    let cli = Cli::try_parse_from(["kcoder", "tui-dev", "--scenario", "thinking-preview"]).unwrap();

    assert!(matches!(
        cli.command,
        Some(Commands::TuiDev {
            scenario: TuiDevScenario::ThinkingPreview
        })
    ));
}

#[test]
fn cli_accepts_tui_dev_lsp_diagnostics_scenario() {
    let cli = Cli::try_parse_from(["kcoder", "tui-dev", "--scenario", "lsp-diagnostics"]).unwrap();

    assert!(matches!(
        cli.command,
        Some(Commands::TuiDev {
            scenario: TuiDevScenario::LspDiagnostics
        })
    ));
}

#[test]
fn cli_accepts_tui_dev_ocr_review_scenario() {
    let cli = Cli::try_parse_from(["kcoder", "tui-dev", "--scenario", "ocr-review"]).unwrap();

    assert!(matches!(
        cli.command,
        Some(Commands::TuiDev {
            scenario: TuiDevScenario::OcrReview
        })
    ));
}

#[test]
fn cli_accepts_tui_dev_subagent_trace_scenario() {
    let cli = Cli::try_parse_from(["kcoder", "tui-dev", "--scenario", "subagent-trace"]).unwrap();

    assert!(matches!(
        cli.command,
        Some(Commands::TuiDev {
            scenario: TuiDevScenario::SubagentTrace
        })
    ));
}

#[test]
fn local_base_url_prefers_cli_over_settings() {
    let mut cli = cli_for_test();
    cli.local_base_url = Some("https://cli.example/v1".to_string());
    let settings = Settings {
        local_base_url: Some("https://settings-local.example/v1".to_string()),
        openai_base_url: Some("https://settings-openai.example/v1".to_string()),
        base_url: Some("https://settings-generic.example/v1".to_string()),
        ..Settings::default()
    };

    assert_eq!(local_base_url(&cli, &settings), "https://cli.example/v1");
}

#[test]
fn first_non_empty_trims_and_skips_empty_values() {
    assert_eq!(
        first_non_empty([None, Some("  ".to_string()), Some(" key ".to_string())]),
        Some("key".to_string())
    );
}

#[test]
fn doctor_secret_status_never_exposes_secret_fragments() {
    assert_eq!(mask_secret(None), "not set");
    assert_eq!(mask_secret(Some("prefix-SECRETVALUE-suffix")), "configured");
}

#[test]
fn only_top_level_doctor_uses_read_only_bootstrap() {
    let top_level = ["kcoder", "doctor"]
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
    let plugin = ["kcoder", "plugin", "doctor"]
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
    assert!(is_read_only_doctor_invocation(&top_level));
    assert!(!is_read_only_doctor_invocation(&plugin));
}

#[test]
fn reads_kunlunmeta_key_only_from_explicit_dotenv_path() {
    let temp = tempfile::tempdir().unwrap();
    let env_file = temp.path().join("source-root.env");
    std::fs::write(
            &env_file,
            "OTHER=value\nMINIMAX_API_KEY='ignored-minimax-key'\nKUNLUNMETA_BASE_API_KEY='dotenv-kunlunmeta-key'\n",
        )
        .unwrap();

    let settings = Settings::default();
    let kunlunmeta = settings.provider_credential(Some("kunlunmeta")).unwrap();
    let kunlunmeta_key = read_dotenv_api_key(&env_file, &kunlunmeta)
        .unwrap()
        .unwrap();
    assert_eq!(kunlunmeta_key, "dotenv-kunlunmeta-key");
}

#[test]
fn unified_user_dotenv_loads_missing_values_without_overriding_process_env() {
    let temp = tempfile::tempdir().unwrap();
    let config_dir = temp.path().join("config");
    std::fs::create_dir_all(&config_dir).unwrap();
    let suffix = std::process::id();
    let missing_name = format!("KCODER_DOTENV_TEST_MISSING_{suffix}");
    let existing_name = format!("KCODER_DOTENV_TEST_EXISTING_{suffix}");
    std::fs::write(
        config_dir.join(".env"),
        format!("{missing_name}=loaded\n{existing_name}=from-file\n"),
    )
    .unwrap();
    unsafe {
        std::env::remove_var(&missing_name);
        std::env::set_var(&existing_name, "from-process");
    }

    load_unified_user_dotenv(&config_dir).unwrap();

    assert_eq!(std::env::var(&missing_name).unwrap(), "loaded");
    assert_eq!(std::env::var(&existing_name).unwrap(), "from-process");
    unsafe {
        std::env::remove_var(&missing_name);
        std::env::remove_var(&existing_name);
    }
}

#[test]
fn kimi_has_no_builtin_dotenv_credential_mapping() {
    let temp = tempfile::tempdir().unwrap();
    let env_file = temp.path().join("source-root.env");
    std::fs::write(&env_file, "KIMI_API_KEY='kimi-secret-key'\n").unwrap();

    let kimi = Settings::default()
        .provider_credential(Some("kimi"))
        .unwrap();
    let key = read_dotenv_api_key(&env_file, &kimi).unwrap();

    assert_eq!(key, None);
    assert_eq!(kimi.id, "kimi");
}

#[test]
fn explicit_dotenv_supports_custom_profile_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let env_file = temp.path().join("source-root.env");
    std::fs::write(&env_file, "DEEPSEEK_API_KEY='temporary-deepseek-key'\n").unwrap();
    let mut settings = Settings::default();
    settings.providers.insert(
        "deepseek".to_string(),
        serde_json::from_value(serde_json::json!({
            "provider": "deepseek",
            "credential_env": ["DEEPSEEK_API_KEY"],
            "api_format": "openai_chat_completions",
            "endpoint": "https://api.deepseek.com/v1",
            "model": "deepseek-chat",
            "context_window_tokens": 128000,
            "output_headroom_tokens": 8192,
            "max_output_tokens": 8192
        }))
        .unwrap(),
    );
    settings
        .stored_provider_credentials
        .insert("deepseek".to_string(), "stored-deepseek-key".to_string());

    apply_credential_env_file(&mut settings, &env_file).unwrap();

    assert_eq!(
        settings.resolve_provider_api_key(Some("deepseek"), None),
        Some("temporary-deepseek-key".to_string())
    );
}

#[test]
fn auth_login_accepts_an_explicit_env_file() {
    let cli = Cli::try_parse_from([
        "kcoder",
        "auth",
        "login",
        "--provider",
        "deepseek",
        "--env-file",
        "/source/project/.env",
    ])
    .unwrap();

    assert!(matches!(
        cli.command,
        Some(Commands::Auth {
            action: Some(AuthAction::Login {
                env_file: Some(_),
                ..
            })
        })
    ));
}

#[test]
fn auth_import_only_persists_explicitly_mapped_providers() {
    let temp = tempfile::tempdir().unwrap();
    let config_dir = temp.path().join("config");
    let paths = ConfigPaths::with_config_dir(temp.path(), config_dir);
    let env_file = temp.path().join("source-root.env");
    std::fs::write(
        &env_file,
        "DEEPSEEK_API_KEY='deepseek-key'\nKIMI_API_KEY='kimi-key'\nUNUSED_KEY='ignored'\n",
    )
    .unwrap();
    let mut settings = Settings::default();
    let mut profile = settings.providers["kunlunmeta"].clone();
    profile.credential_env = vec!["DEEPSEEK_API_KEY".to_string()];
    settings
        .providers
        .insert("DeepSeekInternal".to_string(), profile);

    let imported = import_dotenv_credentials(&settings, &paths, &env_file).unwrap();
    let stored = CredentialStore::load_from(&paths.credentials).unwrap();

    assert!(imported.contains(&"DeepSeekInternal".to_string()));
    assert!(!imported.contains(&"kimi".to_string()));
    assert_eq!(
        stored
            .credentials
            .get("DeepSeekInternal")
            .map(String::as_str),
        Some("deepseek-key")
    );
    assert!(!stored.credentials.contains_key("kimi"));
    assert!(!stored.credentials.contains_key("deepseekinternal"));
}

#[test]
fn cli_accepts_bulk_auth_import() {
    let cli = Cli::try_parse_from([
        "kcoder",
        "auth",
        "import",
        "--env-file",
        "/source/project/.env",
    ])
    .unwrap();

    assert!(matches!(
        cli.command,
        Some(Commands::Auth {
            action: Some(AuthAction::Import { .. })
        })
    ));
}

#[test]
fn missing_api_key_message_does_not_recommend_settings_storage() {
    let message = missing_api_key_message("OPENAI_API_KEY", "--openai-api-key");

    assert!(message.contains("OPENAI_API_KEY"));
    assert!(message.contains("--openai-api-key"));
    assert!(message.contains("Do not store API keys in settings.json"));
    assert!(message.contains("kcoder auth login --provider openai"));
    assert!(!message.contains("configured in settings.json"));
    assert!(!message.contains("openai_api_key/api_key"));
}

#[test]
fn signed_out_provider_defers_the_missing_key_error_until_a_request() {
    let provider = SignedOutProvider {
        name: "kunlunmeta",
        error_message: "sign in first".to_string(),
    };

    assert_eq!(provider.name(), "kunlunmeta");
    assert_eq!(provider.api_key_configured(), Some(false));
    let error = provider
        .stream_messages(MessagesRequest::new("test-model", Vec::new()))
        .err()
        .expect("signed-out provider must reject model requests");
    assert!(matches!(
        error,
        ApiErrorKind::Api { error_type, message }
            if error_type == "missing_api_key" && message == "sign in first"
    ));
}

#[test]
fn cli_help_hides_api_key_env_values() {
    let previous = std::env::var_os("OPENAI_API_KEY");
    unsafe {
        std::env::set_var("OPENAI_API_KEY", "sk-test-secret");
    }

    let mut command = Cli::command();
    let mut output = Vec::new();
    command
        .write_long_help(&mut output)
        .expect("help should render");
    let help = String::from_utf8(output).unwrap();

    match previous {
        Some(value) => unsafe {
            std::env::set_var("OPENAI_API_KEY", value);
        },
        None => unsafe {
            std::env::remove_var("OPENAI_API_KEY");
        },
    }

    assert!(help.contains("OPENAI_API_KEY"));
    assert!(!help.contains("sk-test-secret"));
}

#[test]
fn plaintext_secret_warning_lists_fields_without_values() {
    let settings = Settings {
        api_key: Some("sk-secret-value".to_string()),
        kunlunmeta_api_key: Some("kunlunmeta-secret".to_string()),
        ..Settings::default()
    };

    let warning = plaintext_settings_secret_warning(&settings).unwrap();

    assert!(warning.contains("api_key"));
    assert!(warning.contains("kunlunmeta_api_key"));
    assert!(warning.contains("environment variables"));
    assert!(!warning.contains("sk-secret-value"));
    assert!(!warning.contains("kunlunmeta-secret"));
}

#[test]
fn migration_moves_legacy_minimax_fields_without_losing_values() {
    let mut value = serde_json::json!({
        "active_provider": "minimax",
        "model": "legacy-model",
        "minimax_base_url": "https://legacy.example/anthropic",
        "max_tokens": 1234
    });
    migrate_deployment_settings(&mut value);

    assert!(value.get("model").is_none());
    assert!(value.get("minimax_base_url").is_none());
    assert_eq!(
        value["providers"]["kunlunmeta"]["default_model"],
        "legacy-model"
    );
    assert_eq!(
        value["providers"]["kunlunmeta"]["endpoint"],
        "https://legacy.example/anthropic"
    );
    assert_eq!(value["providers"]["kunlunmeta"]["max_output_tokens"], 1234);
    assert_eq!(value["active_provider"], "kunlunmeta");
    assert!(value["providers"].get("minimax").is_none());
}

#[test]
fn settings_import_normalization_discards_obsolete_fields() {
    let mut imported = serde_json::json!({
        "model": "imported-model",
        "max_tool_timeout_ms": 600000
    });

    normalize_legacy_settings_document(&mut imported);

    assert_eq!(imported["model"], "imported-model");
    assert!(imported.get("max_tool_timeout_ms").is_none());
}

#[test]
fn migration_preserves_non_minimax_legacy_provider_as_compatible_profile() {
    let mut value = serde_json::json!({
        "provider": "openai",
        "model": "legacy-openai-model",
        "openai_base_url": "https://gateway.example/v1"
    });
    migrate_deployment_settings(&mut value);

    assert_eq!(value["active_provider"], "openai");
    assert!(value["providers"]["openai"].get("provider").is_none());
    assert_eq!(
        value["providers"]["openai"]["api_format"],
        "openai_chat_completions"
    );
    assert_eq!(
        value["providers"]["openai"]["endpoint"],
        "https://gateway.example/v1"
    );
}

#[test]
fn auth_store_and_migrate_flags_parse_and_reject_unknown_modes() {
    let cli = Cli::try_parse_from([
        "kcoder",
        "auth",
        "login",
        "--provider",
        "deepseek",
        "--store",
        "keyring",
    ])
    .unwrap();
    assert!(matches!(
        cli.command,
        Some(Commands::Auth {
            action: Some(AuthAction::Login { store: Some(_), .. })
        })
    ));

    let cli = Cli::try_parse_from(["kcoder", "auth", "migrate", "--to", "file"]).unwrap();
    assert!(matches!(
        cli.command,
        Some(Commands::Auth {
            action: Some(AuthAction::Migrate { .. })
        })
    ));

    assert!(Cli::try_parse_from(["kcoder", "auth", "migrate", "--to", "vault"]).is_err());
    assert!(
        Cli::try_parse_from([
            "kcoder",
            "auth",
            "login",
            "--provider",
            "deepseek",
            "--store",
            "vault",
        ])
        .is_err()
    );
}

#[test]
fn auth_migrate_to_file_keeps_markers_without_an_entry() {
    let temp = tempfile::tempdir().unwrap();
    let config_dir = temp.path().join("config");
    std::fs::create_dir_all(&config_dir).unwrap();
    let paths = ConfigPaths::with_config_dir(temp.path(), config_dir);
    let document = serde_json::json!({
        "deepseek": { "type": "api", "key": "keyring:kcoder/deepseek" }
    });
    std::fs::write(
        &paths.credentials,
        serde_json::to_vec_pretty(&document).unwrap(),
    )
    .unwrap();
    let before = std::fs::read(&paths.credentials).unwrap();

    // Migrating out of the store can only move entries the store actually holds. Whether the
    // store reports "no entry" or is unreachable, the document must stay untouched.
    match migrate_provider_credentials(&paths, "file") {
        Ok(()) => {}
        Err(error) => {
            let message = error.to_string();
            assert!(
                message.contains("could not be migrated") || message.contains("unavailable"),
                "{message}"
            );
        }
    }
    assert_eq!(std::fs::read(&paths.credentials).unwrap(), before);

    let document: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&paths.credentials).unwrap()).unwrap();
    assert_eq!(document["deepseek"]["key"], "keyring:kcoder/deepseek");
}

#[derive(Default)]
struct RecordingCredentialBackend {
    deleted: std::sync::Mutex<Vec<String>>,
    fail_delete: bool,
}

impl kcoder_config::CredentialBackend for RecordingCredentialBackend {
    fn describe(&self) -> String {
        "recording store".to_string()
    }
    fn available(&self) -> bool {
        !self.fail_delete
    }
    fn get(&self, _account: &str) -> anyhow::Result<Option<String>> {
        Ok(None)
    }
    fn set(&self, _account: &str, _secret: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn delete(&self, account: &str) -> anyhow::Result<()> {
        if self.fail_delete {
            anyhow::bail!("store is unreachable");
        }
        self.deleted.lock().unwrap().push(account.to_string());
        Ok(())
    }
}

fn logout_fixture() -> (tempfile::TempDir, ConfigPaths) {
    let temp = tempfile::tempdir().unwrap();
    let config_dir = temp.path().join("config");
    std::fs::create_dir_all(&config_dir).unwrap();
    let paths = ConfigPaths::with_config_dir(temp.path(), config_dir);
    std::fs::write(
        &paths.credentials,
        serde_json::to_vec_pretty(&serde_json::json!({
            "Orphan-Id": { "type": "api", "key": "keyring:kcoder/Orphan-Id" },
            "openai": { "type": "api", "key": "sk-plain" },
        }))
        .unwrap(),
    )
    .unwrap();
    (temp, paths)
}

#[test]
fn auth_logout_accepts_document_only_ids_and_deletes_the_store_entry() {
    let (_temp, paths) = logout_fixture();
    let backend = RecordingCredentialBackend::default();
    let outcome =
        logout_provider_credential(&paths, "Orphan-Id", &Settings::default(), &backend).unwrap();
    assert_eq!(outcome.credential_id, "Orphan-Id");
    assert!(outcome.removed_from_store);
    assert!(outcome.store_note.is_none());
    assert_eq!(backend.deleted.lock().unwrap().as_slice(), ["Orphan-Id"]);

    let remaining: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&paths.credentials).unwrap()).unwrap();
    assert!(remaining.get("Orphan-Id").is_none());
    assert_eq!(remaining["openai"]["key"], "sk-plain");
}

#[test]
fn auth_logout_keeps_the_document_consistent_when_the_store_delete_fails() {
    let (_temp, paths) = logout_fixture();
    let backend = RecordingCredentialBackend {
        fail_delete: true,
        ..Default::default()
    };
    let outcome =
        logout_provider_credential(&paths, "Orphan-Id", &Settings::default(), &backend).unwrap();
    assert!(!outcome.removed_from_store);
    assert!(outcome.store_note.unwrap().contains("could not be deleted"));
    let remaining: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&paths.credentials).unwrap()).unwrap();
    assert!(remaining.get("Orphan-Id").is_none());
}

#[test]
fn auth_commands_do_not_resolve_their_provider_as_a_model_transport() {
    let cli = Cli::try_parse_from([
        "kcoder",
        "auth",
        "logout",
        "--provider",
        "DeepSeek-V4.1-Flash",
    ])
    .unwrap();
    // The auth path must not consult the global flag or settings at all: it keeps whatever the
    // environment selected, so an id that is not a transport cannot fail the command.
    assert_eq!(
        cli_provider_kind(&cli, Some(ApiProviderKind::Openai), &Settings::default()).unwrap(),
        ApiProviderKind::Openai
    );
    assert_eq!(
        cli_provider_kind(&cli, None, &Settings::default()).unwrap(),
        ApiProviderKind::Kunlunmeta
    );
}
