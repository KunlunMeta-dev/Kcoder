use super::*;
pub(super) fn engine(
    context: &NativeIntegrationContext,
    workspace: &std::path::Path,
    registry: kcoder_tools::ToolRegistry,
    plugins: kcoder_plugins::EffectivePluginSnapshot,
) -> Result<QueryEngine> {
    configuration(context, workspace, registry, plugins)?
        .create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))
}
fn configuration(
    context: &NativeIntegrationContext,
    workspace: &std::path::Path,
    registry: kcoder_tools::ToolRegistry,
    plugins: kcoder_plugins::EffectivePluginSnapshot,
) -> Result<AppServerEngineFactory> {
    let settings = kcoder_config::Settings {
        credential_store: kcoder_config::CredentialStoreMode::File,
        history_enabled: false,
        ..crate::test_fixtures::settings_with_default_provider()
    };
    let storage = Arc::new(kcoder_config::create_private_temp_dir(
        "native-actual-plugin-lease",
    )?);
    let configuration = AppServerEngineFactory::new(
        Arc::new(FamilyProvider {
            calls: AtomicUsize::new(0),
            nested: false,
        }),
        registry,
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        plugins,
        workspace.to_path_buf(),
        None,
        true,
        WorkspaceRuntimeServices::new(workspace, "native-plugin-lease")
            .with_private_client_storage(storage),
        Some(context.profile_path()?.join("settings.json")),
        context.profile_path()?.join("lease-short-ids.json"),
    );
    Ok(configuration)
}

#[tokio::test]
async fn actual_registered_plugin_origin_and_live_version_lease_resolve_only_the_original_retained_ref()
-> Result<()> {
    let (temp, context) = crate::app_server::integrations::connectivity::lease::tests::fixture()?;
    let workspace = temp.path().join("workspace");
    let source = temp.path().join("managed-source");
    std::fs::create_dir_all(source.join(".claude-plugin"))?;
    let peer = temp.path().join("owned-plugin-peer");
    PrivateDirectory::open_or_create(&peer)?;
    let script = kcoder_test_harness::workspace_root()
        .expect("resolve current workspace")
        .join("crates/kcoder_cli")
        .join("../kcoder_mcp/tests/fixtures/lifecycle_server.py");
    let write = |version: &str| -> Result<()> {
        std::fs::write(source.join(".claude-plugin/plugin.json"), serde_json::json!({"name":"lease-proof","version":version,"mcpServers":{"peer":{"command":"python3","args":[script,"ping",peer,"${CLAUDE_PLUGIN_ROOT}/payload.txt"]}}}).to_string())?;
        std::fs::write(source.join("payload.txt"), version)?;
        Ok(())
    };
    write("1.0.0")?;
    let store = kcoder_plugins::PluginStore::open(&context.profile_path()?.join("plugin_store"))?;
    let first = store.install_local(&source, "owned")?;
    let plugin = first.plugin_id.to_string();
    let snapshot = kcoder_plugins::PluginRegistry::discover_with_store(&workspace, true, &store)?
        .effective_snapshot();
    let config = snapshot
        .mcp_configs
        .iter()
        .zip(&snapshot.mcp_config_sources)
        .find(|(_, item)| item.plugin_id == plugin)
        .context("actual installed MCP contribution")?
        .0
        .clone();
    let credential_context = kcoder_mcp::server_policy::CredentialContext {
        config_dir: context.profile_path()?.to_path_buf(),
        mode: kcoder_config::CredentialStoreMode::File,
    };
    let (handle, definitions) = kcoder_mcp::connect_server_with_private_values_in(
        &config,
        None,
        Arc::new(kcoder_mcp::tool::PrivateValues::default()),
        Some(&credential_context),
    )
    .await?;
    let tool: Arc<dyn kcoder_tools::Tool> = Arc::new(
        kcoder_mcp::McpTool::new(
            &config.name,
            handle.clone(),
            definitions
                .into_iter()
                .next()
                .context("actual tool definition")?,
        )
        .with_plugin_source(&plugin)
        .with_credential_context(credential_context),
    );
    let registry = kcoder_tools::ToolRegistry::new().register_arc(tool.clone());
    let engine = engine(&context, &workspace, registry.clone(), snapshot)?;
    let birth = NativeMcpSourceFact::from_registered_engine_tool(&context, &engine, &tool)?;
    let settings = kcoder_config::Settings {
        credential_store: kcoder_config::CredentialStoreMode::File,
        ..crate::test_fixtures::settings_with_default_provider()
    };
    let mut first_fact =
        NativeMcpSourceFact::from_resolved(&context, &settings, &config, Some(&plugin), &NoOs)?;
    first_fact.certify_plugin_root_environment(&context, &config, &engine.plugin_snapshot())?;
    let catalog = NativeConnectivitySourceCatalog::initialize(&context, "native-plugin-versions")?;
    catalog.register(&context, "native-plugin-v1", &[first_fact])?;
    let original = catalog
        .current_choices(&context, std::slice::from_ref(&birth))?
        .remove(0);
    write("2.0.0")?;
    let second = store.install_local(&source, "owned")?;
    assert_ne!(first.operation_id, second.operation_id);
    let current_snapshot =
        kcoder_plugins::PluginRegistry::discover_with_store(&workspace, true, &store)?
            .effective_snapshot();
    let current_config = current_snapshot
        .mcp_configs
        .iter()
        .zip(&current_snapshot.mcp_config_sources)
        .find(|(_, item)| item.plugin_id == plugin)
        .context("updated installed MCP contribution")?
        .0
        .clone();
    assert_ne!(
        serde_json::to_value(&config)?,
        serde_json::to_value(&current_config)?
    );
    let mut current = NativeMcpSourceFact::from_resolved(
        &context,
        &settings,
        &current_config,
        Some(&plugin),
        &NoOs,
    )?;
    current.certify_plugin_root_environment(&context, &current_config, &current_snapshot)?;
    catalog.register(&context, "native-plugin-v2", &[current])?;
    let current_configuration = configuration(
        &context,
        &workspace,
        registry.clone(),
        current_snapshot.clone(),
    )?;
    let live_current = super::super::super::super::native_sources::leased::for_engine(
        &context,
        &current_configuration,
        &NoOs,
        &engine,
    )?;
    catalog.resolve_choice(&context, &original, &live_current)?;
    catalog.resolve_choice(&context, &original, std::slice::from_ref(&birth))?;
    let unproved =
        NativeMcpSourceFact::from_resolved(&context, &settings, &config, Some(&plugin), &NoOs)?;
    assert!(
        catalog
            .resolve_choice(&context, &original, &[unproved])
            .is_err()
    );
    let observed = catalog.inventory(&context, std::slice::from_ref(&birth), &registry)?;
    assert_eq!(observed.task_sources[0].source_ref, original.source_ref);
    assert_eq!(
        observed.task_sources[0]
            .reason_code
            .as_ref()
            .map(String::as_str),
        Some("NATIVE_SOURCE_RETAINED_PLUGIN_VERSION")
    );
    let mut foreign = original.clone();
    foreign.source_ref.revision = uuid::Uuid::new_v4().to_string();
    assert!(
        catalog
            .resolve_choice(&context, &foreign, std::slice::from_ref(&birth))
            .is_err()
    );
    let manifest_path = source.join(".claude-plugin/plugin.json");
    let mut manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest_path)?)?;
    manifest["version"] = serde_json::json!("3.0.0");
    manifest["mcpServers"]["peer"]["policy"] =
        serde_json::json!({"oauth_account":"changed-owned-account-slot"});
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest)?)?;
    store.install_local(&source, "owned")?;
    let changed_snapshot =
        kcoder_plugins::PluginRegistry::discover_with_store(&workspace, true, &store)?
            .effective_snapshot();
    let changed_configuration =
        configuration(&context, &workspace, registry.clone(), changed_snapshot)?;
    let changed_current = super::super::super::super::native_sources::leased::for_engine(
        &context,
        &changed_configuration,
        &NoOs,
        &engine,
    )?;
    assert!(
        catalog
            .resolve_choice(&context, &original, &changed_current)
            .is_err(),
        "A new install operation cannot restore an old account configuration"
    );
    assert!(
        tool.is_model_visible(),
        "The old registered object is still alive in this account-change counterexample"
    );
    let mut disabled = settings.clone();
    disabled.mcp_disabled_servers.push(config.name.clone());
    assert!(birth.verify_lease_policy(&context, &disabled).is_err());
    let mut plugin_disabled = settings.clone();
    plugin_disabled
        .plugins
        .installed
        .entry(plugin.clone())
        .or_default()
        .enabled = Some(false);
    assert!(
        birth
            .verify_lease_policy(&context, &plugin_disabled)
            .is_err()
    );
    let mut runtime_disabled = settings.clone();
    runtime_disabled.plugins.runtime.enabled = false;
    assert!(
        birth
            .verify_lease_policy(&context, &runtime_disabled)
            .is_err()
    );
    let mut foreign_account = original.clone();
    foreign_account.account_ref = kcoder_types::integrations::core::IntegrationNullable::Value(
        kcoder_types::integrations::core::IntegrationRevisionRef {
            id: "foreign-account".into(),
            revision: "foreign-revision".into(),
        },
    );
    assert!(
        catalog
            .resolve_choice(&context, &foreign_account, std::slice::from_ref(&birth))
            .is_err()
    );
    handle.lock().await.close();
    assert!(
        catalog
            .resolve_choice(&context, &original, std::slice::from_ref(&birth))
            .is_err()
    );
    assert!(
        !peer.join("called").exists(),
        "observing lease provenance must not execute a business tool"
    );
    Ok(())
}
