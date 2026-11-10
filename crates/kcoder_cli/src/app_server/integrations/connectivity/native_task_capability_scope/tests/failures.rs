use super::*;

#[tokio::test]
async fn retired_sdk_receipts_cannot_manage_an_original_task() -> Result<()> {
    use super::super::super::task_capability_scope_control::NativeTaskCapabilityScopeAuthorizationReceipt;
    let f = Fixture::new().await?;
    let accepted =
        NativeAcceptedTaskIdentity::capture_studio(&f.context, &f.facts.initial, f.facts.as_ref())
            .await?;
    let selection = IntegrationTaskCapabilityScopeSelection {
        mode: IntegrationTaskCapabilityScopeMode::None,
        sources: vec![],
    };
    let admission = NativeTaskCapabilityScopeAuthorizationReceipt::explicit_owned_fixture(
        &f.context,
        &accepted,
        "owned-selection",
        &selection,
    )?;
    admission
        .receipt()
        .verify_native(&f.context, &accepted, "owned-selection", &selection)?;
    for kind in ["sdk_task_binding", "sdk_delegation"] {
        let mut saved = serde_json::to_value(admission.receipt())?;
        saved["origin"] = json!({"kind":kind,"observation_sha256":"old-proof"});
        let retired: NativeTaskCapabilityScopeAuthorizationReceipt = serde_json::from_value(saved)?;
        assert!(
            retired
                .verify_native(&f.context, &accepted, "owned-selection", &selection)
                .is_err()
        );
    }
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn unavailable_account_does_not_block_local_work_or_grant_external_access() -> Result<()> {
    let f = Fixture::new().await?;
    let choices = f.choices().await?;
    let original_facts = f.facts.sources(&f.context).await?;
    let b = choices
        .into_iter()
        .find(|choice| {
            f.catalog
                .resolve_choice(&f.context, choice, &original_facts)
                .is_ok_and(|selector| selector.server == "source-B")
        })
        .expect("source B is initially available");
    {
        let mut configs = f.facts.configs.lock().unwrap();
        let b = configs
            .iter_mut()
            .find(|config| config.name == "source-B")
            .unwrap();
        b.env.insert("TOKEN".into(), "fixture-private-value".into());
    }
    f.facts.refresh_emitter_sources(&f.context)?;
    assert!(
        f.choices().await.is_err(),
        "explicit source enumeration remains strict"
    );
    let failure = f
        .bind(selected(vec![b]))
        .await
        .err()
        .expect("an explicit unavailable source must fail");
    assert!(
        failure
            .to_string()
            .contains("NATIVE_SOURCE_ACCOUNT_UNAVAILABLE")
    );

    let binding = f
        .bind(IntegrationTaskCapabilityScopeSelection {
            mode: IntegrationTaskCapabilityScopeMode::InheritCurrent,
            sources: Vec::new(),
        })
        .await?;
    assert_eq!(
        binding
            .snapshot(&f.context, f.facts.as_ref())
            .await?
            .effective_sources
            .len(),
        1
    );
    let guard = f.guard()?;
    guard.bind(binding).await?;
    for source in [ToolSource::Builtin, external("source-A", "read")] {
        assert!(
            f.check(&guard, source, NativeToolAuthorizationPhase::Dispatch)
                .await
                .is_ok()
        );
    }
    assert!(
        f.check(
            &guard,
            external("source-B", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_err()
    );

    f.facts
        .configs
        .lock()
        .unwrap()
        .iter_mut()
        .find(|config| config.name == "source-B")
        .unwrap()
        .env
        .clear();
    f.facts.refresh_emitter_sources(&f.context)?;
    assert!(
        f.check(
            &guard,
            external("source-B", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_err()
    );
    f.shutdown().await;
    Ok(())
}
#[tokio::test]
async fn management_revocation_while_sources_are_prepared_does_not_publish_a_selection()
-> Result<()> {
    let f = Fixture::new().await?;
    let binding = f.bind(selected(f.choices().await?)).await?;
    let choice = f.choices().await?.remove(0);
    f.facts.pause_sources.store(true, Ordering::SeqCst);
    let live = binding.clone();
    let context = f.context.clone();
    let catalog = f.catalog.clone();
    let facts = f.facts.clone();
    let changing = tokio::spawn(async move {
        live.stage_selection(
            &context,
            "management-revoked-mid-prepare",
            1,
            selected(vec![choice]),
            &catalog,
            facts.as_ref(),
        )
        .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        f.facts.entered.notified(),
    )
    .await?;
    f.facts.management.store(false, Ordering::SeqCst);
    f.facts.release.notify_one();
    assert!(changing.await?.is_err());
    assert_eq!(
        binding
            .snapshot(&f.context, f.facts.as_ref())
            .await?
            .revision,
        1
    );
    f.shutdown().await;
    Ok(())
}
#[tokio::test]
async fn none_does_not_require_connector_or_account_discovery_to_preserve_local_work() -> Result<()>
{
    let f = Fixture::new().await?;
    f.facts.source_unavailable.store(true, Ordering::SeqCst);
    let binding = f.bind(none()).await?;
    let guard = f.guard()?;
    guard.bind(binding.clone()).await?;
    assert!(
        f.check(
            &guard,
            ToolSource::Builtin,
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_ok()
    );
    assert!(
        f.check(
            &guard,
            external("source-A", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_err()
    );
    let pending = binding
        .stage_selection(
            &f.context,
            "none-without-discovery",
            1,
            none(),
            &f.catalog,
            f.facts.as_ref(),
        )
        .await?;
    assert_eq!(
        pending.selection.mode,
        IntegrationTaskCapabilityScopeMode::None
    );
    f.shutdown().await;
    Ok(())
}
#[tokio::test]
async fn provider_boundary_requires_actual_current_native_attempt_without_fake_tool_request()
-> Result<()> {
    let f = Fixture::new().await?;
    let guard = f.guard()?;
    let witness = f.facts.engine.native_tool_execution_witness();
    let callback = NativeTaskCapabilityScopeCallback {
        session_id: witness.session_id(),
        native_witness: &witness,
    };
    assert!(guard.verify_provider_boundary(&callback).await.is_err());
    guard.bind(f.bind(none()).await?).await?;
    assert!(guard.verify_provider_boundary(&callback).await.is_err());
    f.facts
        .engine
        .state
        .history_attempt_scope(f.facts.initial.clone())?
        .run(async {
            let witness = f.facts.engine.native_tool_execution_witness();
            let callback = NativeTaskCapabilityScopeCallback {
                session_id: witness.session_id(),
                native_witness: &witness,
            };
            guard.verify_provider_boundary(&callback).await
        })
        .await?;
    assert!(
        f.check(
            &guard,
            ToolSource::NativeFeature {
                feature: "office".into(),
                tool: "local-document".into(),
                revision: "actual-native-fixture".into()
            },
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_ok()
    );
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn actual_oauth_alias_revocation_after_admission_denies_the_original_task_dispatch()
-> Result<()> {
    use kcoder_mcp::{
        authorization::AuthorizationServerMetadata,
        authorization_index::ConnectionAuthorization,
        authorization_registration::{RegisteredClient, RegistrationMethod},
        authorization_store::{CredentialBinding, OAuthTokenStore},
    };
    let f = Fixture::new().await?;
    let endpoint = reqwest::Url::parse("https://mcp.example.test/mcp?alias=source-task")?;
    let alias = reqwest::Url::parse("https://mcp.example.test/mcp?alias=peer")?;
    let metadata: AuthorizationServerMetadata = serde_json::from_value(
        json!({"issuer":"https://auth.example.test/","authorization_endpoint":"https://auth.example.test/authorize","token_endpoint":"https://auth.example.test/token","response_types_supported":["code"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"]}),
    )?;
    let saved = ConnectionAuthorization {
        binding: CredentialBinding {
            resource: reqwest::Url::parse("https://mcp.example.test/")?,
            issuer: reqwest::Url::parse(&metadata.issuer)?,
            client_id: "owned-task-source-oauth-fixture".into(),
            token_endpoint: reqwest::Url::parse(&metadata.token_endpoint)?,
        },
        metadata,
        redirect_uri: reqwest::Url::parse("http://127.0.0.1:45678/callback")?,
    };
    let oauth = OAuthTokenStore::open(&f.context.profile_path()?.join("mcp-oauth"))?;
    let directory = f
        .context
        .profile()?
        .open_entry_handle(OsStr::new("mcp-oauth"))?
        .open_child_directory()?;
    let mut registration = oauth
        .acquire_registration(&saved.metadata, &saved.redirect_uri)
        .await?;
    registration.save(&RegisteredClient::manual(
        &saved.metadata,
        saved.binding.client_id.clone(),
        None,
        RegistrationMethod::Public,
        &saved.redirect_uri,
    )?)?;
    drop(registration);
    let token_name = format!(
        "{:x}.json",
        Sha256::digest(serde_json::to_vec(&(
            saved.binding.resource.as_str(),
            saved.binding.issuer.as_str(),
            &saved.binding.client_id
        ))?)
    );
    {
        let _lease = oauth.acquire(saved.binding.clone()).await?;
        directory.atomic_replace(OsStr::new(&token_name),&serde_json::to_vec(&json!({"version":2,"refresh_pending":false,"resource":saved.binding.resource.as_str(),"issuer":saved.binding.issuer.as_str(),"client_id":saved.binding.client_id,"token_endpoint":saved.binding.token_endpoint.as_str(),"access_token":"SYNTHETIC_TASK_GUARD_ACCESS","refresh_token":null,"expires_at_ms":null,"scope":"read"}))?)?;
    }
    for endpoint in [&endpoint, &alias] {
        let mut association = oauth.acquire_connection(endpoint).await?;
        association.save(&saved)?;
        let generation = format!(
            "connection-{:x}.json.generation",
            Sha256::digest(endpoint.as_str().as_bytes())
        );
        directory.atomic_replace(OsStr::new(&generation), "ab".repeat(32).as_bytes())?;
    }
    let config: kcoder_types::McpServerConfig = serde_json::from_value(
        json!({"name":"source-A","transport":"http","url":endpoint.as_str()}),
    )?;
    if let Some(source) = f
        .facts
        .configs
        .lock()
        .unwrap()
        .iter_mut()
        .find(|source| source.name == "source-A")
    {
        *source = config;
    }
    f.catalog.register(
        &f.context,
        "actual-native-oauth-source",
        &f.facts.sources(&f.context).await?,
    )?;
    f.facts.refresh_emitter_sources(&f.context)?;
    let guard = f.guard()?;
    guard
        .bind(f.bind(selected(f.choices().await?)).await?)
        .await?;
    assert!(
        f.check(
            &guard,
            external("source-A", "read"),
            NativeToolAuthorizationPhase::Admission
        )
        .await
        .is_ok()
    );
    oauth.logout_endpoint(&alias).await?;
    assert!(
        f.check(
            &guard,
            external("source-A", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_err()
    );
    assert!(
        f.check(
            &guard,
            external("source-B", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_ok()
    );
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn private_credential_revocation_between_admission_and_dispatch_is_not_hidden_by_old_registry()
-> Result<()> {
    use kcoder_config::{
        CredentialStoreMode,
        imported_credentials::{ImportedCredentialStore, mcp::McpSecretValues},
    };
    let f = Fixture::new().await?;
    let initial = json!({"providers":{},"credential_store":"file","mcp_servers":[]});
    f.context
        .profile()?
        .atomic_replace(OsStr::new("settings.json"), &serde_json::to_vec(&initial)?)?;
    let mut config = config("source-A");
    config.policy.required_env.push("TOKEN".into());
    let credentials = ImportedCredentialStore::open(f.context.profile_path()?)?;
    let reference = credentials.prepare_mcp(
        &config,
        &["TOKEN".into()],
        &[],
        CredentialStoreMode::File,
        &EmptyBackend,
    )?;
    let values = McpSecretValues {
        env: BTreeMap::from([(
            "TOKEN".into(),
            "SYNTHETIC_TASK_CAPABILITY_SCOPE_PRIVATE_VALUE".into(),
        )]),
        headers: BTreeMap::new(),
    };
    credentials.stage(&reference, &values.encode()?, &EmptyBackend)?;
    config.policy.credential_ref = Some(reference.mcp_reference()?);
    credentials.publish_group(
        "group-cccccccccccccccccccccccccccccccc",
        std::slice::from_ref(&reference),
        &EmptyBackend,
        |document| {
            document["mcp_servers"] = json!([config]);
            Ok(())
        },
    )?;
    f.facts.settings.lock().unwrap().credential_store = CredentialStoreMode::File;
    if let Some(source) = f
        .facts
        .configs
        .lock()
        .unwrap()
        .iter_mut()
        .find(|source| source.name == "source-A")
    {
        *source = config;
    }
    f.catalog.register(
        &f.context,
        "actual-native-private-source",
        &f.facts.sources(&f.context).await?,
    )?;
    f.facts.refresh_emitter_sources(&f.context)?;
    let guard = f.guard()?;
    guard
        .bind(f.bind(selected(f.choices().await?)).await?)
        .await?;
    assert!(
        f.check(
            &guard,
            external("source-A", "read"),
            NativeToolAuthorizationPhase::Admission
        )
        .await
        .is_ok()
    );
    credentials.undo_group(
        "group-cccccccccccccccccccccccccccccccc",
        &EmptyBackend,
        |document| {
            *document = initial;
            Ok(())
        },
    )?;
    assert!(
        f.check(
            &guard,
            external("source-A", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_err()
    );
    assert!(
        f.check(
            &guard,
            external("source-B", "read"),
            NativeToolAuthorizationPhase::Dispatch
        )
        .await
        .is_ok()
    );
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn changing_selection_during_source_observation_refuses_the_original_dispatch() -> Result<()>
{
    let f = Fixture::new().await?;
    let binding = f.bind(selected(f.choices().await?)).await?;
    let guard = f.guard()?;
    guard.bind(binding.clone()).await?;
    f.facts.pause_sources.store(true, Ordering::SeqCst);
    let engine = f.facts.engine.clone();
    let initial = f.facts.initial.clone();
    let live = guard.clone();
    let facts = f.facts.clone();
    let checking = tokio::spawn(async move {
        engine
            .state
            .history_attempt_scope(initial)
            .unwrap()
            .run(async {
                let source = external("source-A", "read");
                let (emitter_engine, name) = emitter_engine(&engine, &source);
                let emitter = emitter_engine.native_tool_emitter_witness(&name).unwrap();
                let fact = facts
                    .emitter_sources
                    .lock()
                    .unwrap()
                    .get("source-A")
                    .unwrap()
                    .clone();
                facts
                    .emitter_objects
                    .lock()
                    .unwrap()
                    .push((emitter.tool().clone(), fact));
                let witness = emitter.execution();
                let input = json!({});
                live.authorize(&NativeToolAuthorizationRequest {
                    execution: Some(witness),
                    emitter: Some(&emitter),
                    session_id: witness.session_id(),
                    tool_name: &name,
                    source,
                    input: &input,
                    read_only: true,
                    without_sandbox: false,
                    phase: NativeToolAuthorizationPhase::Dispatch,
                })
                .await
            })
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        f.facts.entered.notified(),
    )
    .await?;
    binding
        .stage_selection(
            &f.context,
            "narrow-while-dispatch-waits",
            1,
            none(),
            &f.catalog,
            f.facts.as_ref(),
        )
        .await?;
    f.facts.release.notify_one();
    assert!(checking.await?.is_err());
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn deleted_committed_binding_is_unknown_and_cannot_be_recreated_by_replaying_initial_setter()
-> Result<()> {
    let f = Fixture::new().await?;
    let selection = selected(f.choices().await?);
    let binding = f.bind(selection.clone()).await?;
    let key = binding.task_key()?;
    let namespace = NativeDomainGuard::observe(
        f.context.profile()?,
        f.context.scope(),
        NativeDomain::ConnectivityTaskCapabilityScope,
    )?
    .unwrap();
    let directory = namespace.directory(f.context.profile()?)?;
    let name = format!("source-binding-{key}.json");
    directory.remove_regular_file(OsStr::new(&name))?;
    assert!(
        f.store
            .restore(&f.context, &key, f.facts.as_ref())
            .await
            .is_err()
    );
    assert!(f.bind(selection).await.is_err());
    assert!(
        directory
            .open_single_link_regular_file(OsStr::new(&name))
            .is_err()
    );
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn another_engine_or_session_label_cannot_borrow_root_emitter_authority() -> Result<()> {
    let f = Fixture::new().await?;
    let guard = f.guard()?;
    guard
        .bind(f.bind(selected(f.choices().await?)).await?)
        .await?;
    let peer = test_runtime(
        "unrelated-owned-engine",
        &f.temp.path().join("workspace/peer-history.jsonl"),
    );
    let engine = peer.engine();
    let child = TurnAttemptIdentity {
        thread_id: engine.session_id(),
        turn_id: "peer-turn".into(),
        attempt_id: "peer-attempt".into(),
    };
    engine
        .state
        .history_attempt_scope(child)?
        .run(async {
            let source = external("source-A", "read");
            let (emitter_engine, name) = emitter_engine(&engine, &source);
            let emitter = emitter_engine.native_tool_emitter_witness(&name).unwrap();
            let fact = f
                .facts
                .emitter_sources
                .lock()
                .unwrap()
                .get("source-A")
                .unwrap()
                .clone();
            f.facts
                .emitter_objects
                .lock()
                .unwrap()
                .push((emitter.tool().clone(), fact));
            let witness = emitter.execution();
            let input = json!({});
            for session in [witness.session_id(), f.facts.initial.thread_id.as_str()] {
                assert!(
                    guard
                        .authorize(&NativeToolAuthorizationRequest {
                            execution: Some(witness),
                            emitter: Some(&emitter),
                            session_id: session,
                            tool_name: &name,
                            source: source.clone(),
                            input: &input,
                            read_only: true,
                            without_sandbox: false,
                            phase: NativeToolAuthorizationPhase::Dispatch
                        })
                        .await
                        .is_err()
                );
            }
        })
        .await;
    peer.shutdown().await;
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn missing_native_parent_chain_is_not_replaced_by_matching_session_strings() -> Result<()> {
    let f = Fixture::new().await?;
    let accepted =
        NativeAcceptedTaskIdentity::capture_studio(&f.context, &f.facts.initial, f.facts.as_ref())
            .await?;
    let scope = f
        .facts
        .engine
        .state
        .history_attempt_scope(f.facts.initial.clone())?;
    scope
        .run(async {
            let witness = f.facts.engine.native_tool_execution_witness();
            let mut execution = f.facts.execution(&f.context, &accepted, &witness, true)?;
            execution.current_session_id = "unproven-child-session".into();
            assert!(
                accepted
                    .check_execution(&f.context, "unproven-child-session", &execution, true)
                    .is_err()
            );
            execution.current_attempt = None;
            execution.lineage = vec![NativeTaskCapabilityScopeLineageEdge {
                run: BackgroundRunKey {
                    parent_session_id: "different-parent".into(),
                    agent_id: "native-child".into(),
                    run_id: "native-run".into(),
                },
                child_session_id: "unproven-child-session".into(),
            }];
            assert!(
                accepted
                    .check_execution(&f.context, "unproven-child-session", &execution, false)
                    .is_err()
            );
            Ok::<_, anyhow::Error>(())
        })
        .await?;
    f.shutdown().await;
    Ok(())
}
