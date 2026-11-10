use super::*;
mod leased_versions;
mod oauth;

#[test]
fn missing_native_keyring_backing_never_projects_current_authorization() -> Result<()> {
    use kcoder_config::imported_credentials::{ImportedCredentialStore, mcp::McpSecretValues};
    let (_temp, context) = super::super::lease::tests::fixture()?;
    context.profile()?.atomic_replace(
        OsStr::new("settings.json"),
        &serde_json::to_vec(
            &json!({"providers":{},"credential_store":"keyring","mcp_servers":[]}),
        )?,
    )?;
    let backend = MemoryBackend::default();
    let mut source = config("original-keyring-source");
    source.policy.required_env.push("TOKEN".into());
    let store = ImportedCredentialStore::open(context.profile_path()?)?;
    let reference = store.prepare_mcp(
        &source,
        &["TOKEN".into()],
        &[],
        kcoder_config::CredentialStoreMode::Keyring,
        &backend,
    )?;
    let values = McpSecretValues {
        env: BTreeMap::from([("TOKEN".into(), "SYNTHETIC_NATIVE_SOURCE_VALUE".into())]),
        headers: BTreeMap::new(),
    };
    store.stage(&reference, &values.encode()?, &backend)?;
    source.policy.credential_ref = Some(reference.mcp_reference()?);
    store.publish_group(
        "group-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        std::slice::from_ref(&reference),
        &backend,
        |document| {
            document["mcp_servers"] = json!([source]);
            Ok(())
        },
    )?;
    let settings = Settings {
        credential_store: kcoder_config::CredentialStoreMode::Keyring,
        ..Default::default()
    };
    let current = NativeMcpSourceFact::from_resolved(&context, &settings, &source, None, &backend)?;
    assert!(current.account.currently_authorized());
    backend.delete(&reference.account)?;
    let before = std::fs::read(context.profile_path()?.join("credentials.json"))?;
    let missing = NativeMcpSourceFact::from_resolved(&context, &settings, &source, None, &backend)?;
    assert!(!missing.account.currently_authorized());
    assert_eq!(
        missing.application_summary()["authorization"],
        "unavailable"
    );
    assert_eq!(
        std::fs::read(context.profile_path()?.join("credentials.json"))?,
        before
    );
    Ok(())
}
use async_trait::async_trait;
use kcoder_tools::{Tool, ToolContext, ToolError, ToolOutput};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct MemoryBackend(Mutex<BTreeMap<String, String>>);
impl CredentialBackend for MemoryBackend {
    fn describe(&self) -> String {
        "owned-native-source-fixture".into()
    }
    fn available(&self) -> bool {
        true
    }
    fn get(&self, account: &str) -> Result<Option<String>> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, value: &str) -> Result<()> {
        self.0.lock().unwrap().insert(account.into(), value.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<()> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}
struct RegisteredFixture {
    name: String,
    source: ToolSource,
    schema: Value,
}
#[async_trait]
impl Tool for RegisteredFixture {
    fn name(&self) -> String {
        self.name.clone()
    }
    fn source(&self) -> ToolSource {
        self.source.clone()
    }
    fn description(&self) -> String {
        "Explicitly registered native inventory fixture; never executed".into()
    }
    fn input_schema(&self) -> Value {
        self.schema.clone()
    }
    async fn call(&self, _: Value, _: &ToolContext) -> std::result::Result<ToolOutput, ToolError> {
        Err(ToolError::Execution("not an execution test".into()))
    }
}
fn config(name: &str) -> McpServerConfig {
    serde_json::from_value(
        json!({"name":name,"transport":"stdio","command":"owned-no-execution-command"}),
    )
    .unwrap()
}
fn registry(server: &str, plugin: Option<&str>) -> ToolRegistry {
    let source = match plugin {
        Some(plugin) => ToolSource::Plugin {
            plugin: plugin.into(),
            server: server.into(),
            tool: "native-read".into(),
        },
        None => ToolSource::Mcp {
            server: server.into(),
            tool: "native-read".into(),
        },
    };
    ToolRegistry::new().register(RegisteredFixture {
        name: "human-friendly-exposed-name".into(),
        source,
        schema: json!({"type":"object","properties":{"id":{"type":"string"}}}),
    })
}
fn fact(
    context: &NativeIntegrationContext,
    settings: &Settings,
    config: &McpServerConfig,
    plugin: Option<&str>,
) -> Result<NativeMcpSourceFact> {
    NativeMcpSourceFact::from_resolved(context, settings, config, plugin, &MemoryBackend::default())
}
fn choice(
    descriptor: &IntegrationTaskCapabilitySourceDescriptor,
) -> IntegrationTaskCapabilitySourceChoice {
    IntegrationTaskCapabilitySourceChoice {
        source_ref: descriptor.source_ref.clone(),
        account_ref: descriptor.account_ref.clone(),
    }
}

#[test]
fn native_registered_provenance_selects_real_source_without_exposed_name_guessing() -> Result<()> {
    let (_temp, context) = super::super::lease::tests::fixture()?;
    let settings = Settings::default();
    let config = config("CaseSensitiveNativeServer");
    let facts = vec![fact(&context, &settings, &config, None)?];
    let catalog = NativeConnectivitySourceCatalog::initialize(&context, "native-source-opt-in")?;
    catalog.register(&context, "register-current-native-sources", &facts)?;
    let mut tools = registry(&config.name, None);
    tools
        .try_register(Arc::new(RegisteredFixture {
            name: "mcp__CaseSensitiveNativeServer__fake".into(),
            source: ToolSource::Builtin,
            schema: json!({"type":"object"}),
        }))
        .unwrap();
    tools
        .try_register(Arc::new(RegisteredFixture {
            name: "mcp__CaseSensitiveNativeServer__other".into(),
            source: ToolSource::Mcp {
                server: "different-native-source".into(),
                tool: "read".into(),
            },
            schema: json!({"type":"object"}),
        }))
        .unwrap();
    let inventory = catalog.inventory(&context, &facts, &tools)?;
    assert_eq!(inventory.task_sources.len(), 1);
    assert_eq!(inventory.tools.len(), 1);
    let descriptor = &inventory.task_sources[0];
    assert_eq!(descriptor.display_name, config.name);
    assert_eq!(
        descriptor.state,
        IntegrationTaskCapabilitySourceState::Ready
    );
    assert_eq!(descriptor.account_ref, IntegrationNullable::Null);
    assert_eq!(inventory.tools[0].name, "human-friendly-exposed-name");
    assert!(
        inventory.tools[0].capabilities.is_empty(),
        "names do not create semantic/business capabilities"
    );
    let selected = choice(descriptor);
    let native = catalog.resolve_choice(&context, &selected, &facts)?;
    assert!(native.matches_tool_source(&ToolSource::Mcp {
        server: config.name.clone(),
        tool: "future-native-tool".into()
    }));
    assert!(!native.matches_tool_source(&ToolSource::Mcp {
        server: config.name.to_lowercase(),
        tool: "read".into()
    }));
    let mut wrong = selected;
    wrong.account_ref = IntegrationNullable::Value(IntegrationRevisionRef {
        id: "claimed-account".into(),
        revision: "1".into(),
    });
    assert!(catalog.resolve_choice(&context, &wrong, &facts).is_err());
    Ok(())
}

#[test]
fn native_private_mcp_receipt_supplies_exact_account_revision_without_private_values() -> Result<()>
{
    use kcoder_config::{
        CredentialStoreMode,
        imported_credentials::{ImportedCredentialStore, mcp::McpSecretValues},
    };
    let (temp, context) = super::super::lease::tests::fixture()?;
    let backend = MemoryBackend::default();
    let initial = json!({"providers":{},"credential_store":"file","mcp_servers":[]});
    context
        .profile()?
        .atomic_replace(OsStr::new("settings.json"), &serde_json::to_vec(&initial)?)?;
    let mut config = config("actual-private-credential-source");
    config.policy.required_env.push("TOKEN".into());
    let credentials = ImportedCredentialStore::open(context.profile_path()?)?;
    let reference = credentials.prepare_mcp(
        &config,
        &["TOKEN".into()],
        &[],
        CredentialStoreMode::File,
        &backend,
    )?;
    let values = McpSecretValues {
        env: BTreeMap::from([("TOKEN".into(), "SYNTHETIC_SOURCE_PRIVATE_CREDENTIAL".into())]),
        headers: BTreeMap::new(),
    };
    credentials.stage(&reference, &values.encode()?, &backend)?;
    config.policy.credential_ref = Some(reference.mcp_reference()?);
    credentials.publish_group(
        "group-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        std::slice::from_ref(&reference),
        &backend,
        |document| {
            document["mcp_servers"] = json!([config]);
            Ok(())
        },
    )?;
    let settings = Settings {
        credential_store: CredentialStoreMode::File,
        ..Settings::default()
    };
    let facts = vec![NativeMcpSourceFact::from_resolved(
        &context, &settings, &config, None, &backend,
    )?];
    let catalog = NativeConnectivitySourceCatalog::initialize(&context, "native-source-opt-in")?;
    catalog.register(&context, "register-private-source", &facts)?;
    let inventory = catalog.inventory(&context, &facts, &registry(&config.name, None))?;
    let descriptor = &inventory.task_sources[0];
    assert_eq!(
        descriptor.account_ref.as_ref().unwrap().id,
        reference.mcp_reference()?.id
    );
    assert_eq!(
        descriptor.state,
        IntegrationTaskCapabilitySourceState::Ready
    );
    assert!(
        descriptor.account_display_name.as_ref().is_none(),
        "a native credential slot is not an inferred external username"
    );
    assert!(!serde_json::to_string(&inventory)?.contains("SYNTHETIC_SOURCE_PRIVATE_CREDENTIAL"));
    let bytes = std::fs::read(
        temp.path()
            .join("profile")
            .join(catalog.guard.namespace_id())
            .join(STATE),
    )?;
    assert!(!String::from_utf8_lossy(&bytes).contains("SYNTHETIC_SOURCE_PRIVATE_CREDENTIAL"));
    let selected = choice(descriptor);
    catalog.resolve_choice(&context, &selected, &facts)?;
    credentials.undo_group(
        "group-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        &backend,
        |document| {
            *document = initial;
            Ok(())
        },
    )?;
    let revoked = vec![NativeMcpSourceFact::from_resolved(
        &context, &settings, &config, None, &backend,
    )?];
    assert!(
        catalog
            .resolve_choice(&context, &selected, &revoked)
            .is_err()
    );
    let after = catalog.inventory(&context, &revoked, &registry(&config.name, None))?;
    assert_eq!(after.catalog_state, "unknown");
    assert!(after.task_sources.is_empty());
    Ok(())
}

#[test]
fn source_read_is_pure_and_config_change_needs_explicit_registration_original_intent() -> Result<()>
{
    let (temp, context) = super::super::lease::tests::fixture()?;
    let settings = Settings::default();
    let mut config = config("native-current-source");
    let facts = vec![fact(&context, &settings, &config, None)?];
    assert!(NativeConnectivitySourceCatalog::observe(&context)?.is_none());
    let catalog = NativeConnectivitySourceCatalog::initialize(&context, "native-source-opt-in")?;
    let state_path = temp
        .path()
        .join("profile")
        .join(catalog.guard.namespace_id())
        .join(STATE);
    let before = std::fs::read(&state_path)?;
    let absent = catalog.inventory(&context, &facts, &registry(&config.name, None))?;
    assert_eq!(absent.catalog_state, "unknown");
    assert!(absent.task_sources.is_empty());
    assert_eq!(before, std::fs::read(&state_path)?);
    catalog.register(&context, "registration-first", &facts)?;
    let original = catalog
        .inventory(&context, &facts, &registry(&config.name, None))?
        .task_sources
        .remove(0);
    let old_choice = choice(&original);
    config.args.push("changed-native-configuration".into());
    let changed = vec![fact(&context, &settings, &config, None)?];
    let before = std::fs::read(&state_path)?;
    let stale = catalog.inventory(&context, &changed, &registry(&config.name, None))?;
    assert_eq!(
        stale.task_sources[0].state,
        IntegrationTaskCapabilitySourceState::Unknown
    );
    assert_eq!(before, std::fs::read(&state_path)?);
    assert!(
        catalog
            .resolve_choice(&context, &old_choice, &changed)
            .is_err()
    );
    assert!(
        catalog
            .register(&context, "registration-first", &changed)
            .is_err()
    );
    catalog.register(&context, "registration-next", &changed)?;
    let next = catalog
        .inventory(&context, &changed, &registry(&config.name, None))?
        .task_sources
        .remove(0);
    assert_eq!(next.source_ref.id, original.source_ref.id);
    assert_ne!(next.source_ref.revision, original.source_ref.revision);
    assert_ne!(
        next.source_ref.revision, changed[0].security_fingerprint,
        "public revision is opaque, never private configuration digest"
    );
    // Reading an old operation receipt cannot republish its old source state.
    catalog.register(&context, "registration-first", &facts)?;
    assert_eq!(
        catalog
            .inventory(&context, &changed, &registry(&config.name, None))?
            .task_sources[0]
            .source_ref,
        next.source_ref
    );
    Ok(())
}

#[test]
fn reconnect_and_reopen_keep_native_revisions_but_current_registry_changes_request_snapshot()
-> Result<()> {
    let (temp, context) = super::super::lease::tests::fixture()?;
    let settings = Settings::default();
    let config = config("native-current-source");
    let facts = vec![fact(&context, &settings, &config, None)?];
    let catalog = NativeConnectivitySourceCatalog::initialize(&context, "native-source-opt-in")?;
    catalog.register(&context, "registration-first", &facts)?;
    let original = catalog.inventory(&context, &facts, &registry(&config.name, None))?;
    drop(catalog);
    let context = NativeIntegrationContext::capture(
        &temp.path().join("profile"),
        &temp.path().join("workspace"),
        "different-transport",
        &context.scope().target_revision,
    )?;
    let catalog = NativeConnectivitySourceCatalog::observe(&context)?.unwrap();
    let facts = vec![fact(&context, &settings, &config, None)?];
    catalog.register(&context, "registration-after-transport", &facts)?;
    let next = catalog.inventory(&context, &facts, &registry(&config.name, None))?;
    assert_eq!(
        next.task_sources[0].source_ref,
        original.task_sources[0].source_ref
    );
    assert_eq!(next.request_revision, original.request_revision);
    let empty = catalog.inventory(&context, &facts, &ToolRegistry::new())?;
    assert!(empty.tools.is_empty());
    assert_eq!(
        empty.task_sources[0].state,
        IntegrationTaskCapabilitySourceState::Unknown
    );
    assert_ne!(empty.request_revision, next.request_revision);
    Ok(())
}

#[test]
fn oauth_and_inline_missing_account_metadata_stay_unknown_without_initialization() -> Result<()> {
    let (temp, context) = super::super::lease::tests::fixture()?;
    let settings = Settings::default();
    let oauth: McpServerConfig = serde_json::from_value(
        json!({"name":"official-configured-endpoint","transport":"http","url":"https://mcp.example.test/mcp"}),
    )?;
    let mut inline = config("private-configured-header");
    inline
        .env
        .insert("TOKEN".into(), "SYNTHETIC_INLINE_PRIVATE_VALUE".into());
    let mut aliased = config("native-aliased-secret");
    aliased
        .policy
        .env_aliases
        .insert("TOKEN".into(), "NATIVE_DECLARED_FIXTURE_SECRET".into());
    let facts = vec![
        fact(&context, &settings, &oauth, None)?,
        fact(&context, &settings, &inline, None)?,
        fact(&context, &settings, &aliased, None)?,
    ];
    assert!(!temp.path().join("profile/mcp-oauth").exists());
    let catalog = NativeConnectivitySourceCatalog::initialize(&context, "native-source-opt-in")?;
    catalog.register(&context, "register-unknown-accounts", &facts)?;
    let inventory = catalog.inventory(&context, &facts, &registry(&oauth.name, None))?;
    assert!(inventory.task_sources.is_empty());
    assert!(inventory.tools.is_empty());
    assert_eq!(inventory.unresolved_sources, 3);
    assert!(!temp.path().join("profile/mcp-oauth").exists());
    assert!(!serde_json::to_string(&inventory)?.contains("SYNTHETIC_INLINE_PRIVATE_VALUE"));
    Ok(())
}

#[test]
fn facts_cannot_cross_native_scope_and_plugin_provenance_is_exact() -> Result<()> {
    let (_temp, context) = super::super::lease::tests::fixture()?;
    let settings = Settings::default();
    let config = config("native-plugin-server");
    let facts = vec![fact(&context, &settings, &config, Some("NativePluginId"))?];
    let catalog = NativeConnectivitySourceCatalog::initialize(&context, "native-source-opt-in")?;
    catalog.register(&context, "register-native-plugin", &facts)?;
    let inventory = catalog.inventory(
        &context,
        &facts,
        &registry(&config.name, Some("NativePluginId")),
    )?;
    assert_eq!(
        inventory.task_sources[0].kind,
        IntegrationTaskCapabilitySourceKind::PluginMcp
    );
    assert_eq!(
        inventory.task_sources[0].state,
        IntegrationTaskCapabilitySourceState::Ready
    );
    assert!(
        catalog
            .inventory(
                &context,
                &facts,
                &registry(&config.name, Some("nativepluginid"))
            )?
            .tools
            .is_empty()
    );
    let (_other, other) = super::super::lease::tests::fixture()?;
    let other_catalog = NativeConnectivitySourceCatalog::initialize(&other, "other-native-opt-in")?;
    assert!(
        other_catalog
            .register(&other, "cannot-cross-native-source-facts", &facts)
            .is_err()
    );
    assert!(
        catalog
            .inventory(
                &other,
                &facts,
                &registry(&config.name, Some("NativePluginId"))
            )
            .is_err()
    );
    let duplicate = vec![
        fact(&context, &settings, &config, Some("NativePluginId"))?,
        fact(&context, &settings, &config, Some("NativePluginId"))?,
    ];
    assert!(
        catalog
            .register(&context, "ambiguous-source", &duplicate)
            .is_err()
    );
    Ok(())
}

#[test]
fn disabling_a_registered_source_has_its_own_diagnostic_without_refreshing_its_choice() -> Result<()>
{
    let (_temp, context) = super::super::lease::tests::fixture()?;
    let mut settings = Settings::default();
    let original_config = config("lifecycle-source");
    let catalog = NativeConnectivitySourceCatalog::initialize(&context, "lifecycle-opt-in")?;
    let original_facts = vec![fact(&context, &settings, &original_config, None)?];
    catalog.register(&context, "lifecycle-register", &original_facts)?;
    let original = catalog
        .inventory(
            &context,
            &original_facts,
            &registry(&original_config.name, None),
        )?
        .task_sources
        .remove(0);
    let original_choice = choice(&original);
    settings
        .mcp_disabled_servers
        .push(original_config.name.clone());
    let disabled_facts = vec![fact(&context, &settings, &original_config, None)?];
    let disabled = catalog
        .inventory(
            &context,
            &disabled_facts,
            &registry(&original_config.name, None),
        )?
        .task_sources
        .remove(0);
    assert_eq!(
        disabled.state,
        IntegrationTaskCapabilitySourceState::Unavailable
    );
    assert_eq!(
        disabled.reason_code,
        IntegrationNullable::Value("NATIVE_SOURCE_DISABLED".into())
    );
    assert_eq!(disabled.source_ref, original.source_ref);
    assert!(disabled.capabilities.is_empty());
    assert!(
        catalog
            .resolve_choice(&context, &original_choice, &disabled_facts)
            .is_err()
    );
    settings.mcp_disabled_servers.clear();
    let mut changed_config = original_config.clone();
    changed_config.args.push("changed-generation".into());
    let changed = vec![fact(&context, &settings, &changed_config, None)?];
    assert!(
        catalog
            .resolve_choice(&context, &original_choice, &changed)
            .is_err()
    );
    assert_eq!(
        catalog
            .inventory(&context, &changed, &registry(&original_config.name, None))?
            .task_sources[0]
            .reason_code,
        IntegrationNullable::Value("NATIVE_SOURCE_REGISTRATION_STALE".into())
    );
    let restored = vec![fact(&context, &settings, &original_config, None)?];
    assert!(
        catalog
            .resolve_choice(&context, &original_choice, &restored)
            .is_ok()
    );
    Ok(())
}
