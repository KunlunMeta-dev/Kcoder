use super::*;
use kcoder_config::{PrivateDirectory, Settings};
use kcoder_types::{
    integrations::knowledge::*,
    knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind},
};
use serde_json::json;
use std::{ffi::OsStr, path::PathBuf};

struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    engine: QueryEngine,
    context: NativeIntegrationContext,
}
fn engine(cwd: &std::path::Path, settings: Settings, path: Option<PathBuf>) -> Result<QueryEngine> {
    let owner = Arc::new(kcoder_config::create_private_temp_dir(
        "knowledge-rpc-test",
    )?);
    let services = kcoder_engine::WorkspaceRuntimeServices::new(cwd, "knowledge-rpc-test")
        .with_private_client_storage(owner);
    let engine = QueryEngine::try_new_for_client_with_services(
        Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
            crate::tui_dev_mock::TuiDevScenario::FullTurn,
        )),
        kcoder_state::AppState::new(cwd),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        cwd.to_path_buf(),
        Some(true),
        services,
    )?;
    Ok(match path {
        Some(path) => engine.with_settings_persistence_path(path),
        None => engine,
    })
}
fn fixture(publications: bool, automation: bool, persistence: bool) -> Result<Fixture> {
    let root = tempfile::tempdir()?;
    let parent = PrivateDirectory::open_or_create(root.path())?;
    let profile = parent.create_private_child(OsStr::new("profile"))?;
    parent.create_private_child(OsStr::new("workspace"))?;
    profile.atomic_replace(OsStr::new("settings.json"), b"{}")?;
    let profile = root.path().join("profile");
    let mut settings = Settings::default();
    settings.integrations.knowledge.publications_enabled = publications;
    settings.integrations.knowledge.business_automation_enabled = automation;
    let engine = engine(
        &root.path().join("workspace"),
        settings,
        persistence.then(|| profile.join("settings.json")),
    )?;
    let context = NativeIntegrationContext::capture(
        &profile,
        &engine.state.cwd(),
        "owned-rpc-test",
        &engine.active_model_configuration_summary()?.revision,
    )?;
    Ok(Fixture {
        _root: root,
        profile,
        engine,
        context,
    })
}
fn names(profile: &std::path::Path) -> Result<Vec<std::ffi::OsString>> {
    let mut entries = std::fs::read_dir(profile)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort();
    Ok(entries)
}

#[tokio::test]
async fn request_fork_releases_connection_cache_and_shares_the_actual_revocation_epoch()
-> Result<()> {
    let mut f = fixture(true, true, true)?;
    let cache = Arc::new(tokio::sync::Mutex::new(NativeKnowledgeRpc::default()));
    let mut local = {
        let mut original = cache.lock().await;
        original.request_fork(&mut f.context, &f.engine)?
    };
    let held = cache
        .try_lock()
        .expect("request owns no connection mutex across await")
        .cached
        .as_ref()
        .unwrap()
        .host
        .clone();
    assert!(Arc::ptr_eq(&held, &local.cached.as_ref().unwrap().host));
    local.clear();
    assert!(
        held.runtime_sources_current(),
        "a request-local rejection cannot revoke peer tasks"
    );
    let mut local = {
        let mut original = cache.lock().await;
        original.request_fork(&mut f.context, &f.engine)?
    };
    cache.lock().await.clear();
    assert!(!held.runtime_sources_current());
    let params = request(&mut f, None, None, json!({}))?;
    let reply = call(
        &mut f,
        &mut local,
        "integrations/knowledge/listPublications",
        params,
        false,
        &CancellationToken::new(),
    )
    .await?;
    assert!(reply.result.as_ref().is_none());
    assert_eq!(
        reply.error.as_ref().unwrap().code,
        "KNOWLEDGE_RPC_CONFIGURATION_CHANGED"
    );
    Ok(())
}
fn request(
    f: &mut Fixture,
    operation: Option<&str>,
    revision: Option<u64>,
    payload: Value,
) -> Result<Value> {
    f.context
        .refresh_configuration_revision(f.engine.active_model_configuration_summary()?.revision)?;
    Ok(serde_json::to_value(IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: uuid::Uuid::new_v4().to_string(),
        scope: f.context.scope().clone(),
        operation_id: operation.map(str::to_owned),
        expected_revision: revision.map(|n| n.to_string()),
        timeout_ms: 30_000,
        cancellation_ref: None,
        payload: payload.as_object().unwrap().clone(),
    })?)
}
async fn call(
    f: &mut Fixture,
    cache: &mut NativeKnowledgeRpc,
    method: &str,
    params: Value,
    explicit: bool,
    cancel: &CancellationToken,
) -> Result<IntegrationReply> {
    request_knowledge_automation(
        method,
        params,
        &f.engine,
        &mut f.context,
        cache,
        explicit,
        cancel,
    )
    .await
}

#[test]
fn connection_owned_cache_and_request_future_support_serial_spawned_tasks() -> Result<()> {
    fn send_sync<T: Send + Sync>() {}
    fn send_future<T: std::future::Future + Send>(_: T) {}
    send_sync::<NativeKnowledgeRpc>();
    let mut f = fixture(true, false, true)?;
    let mut cache = NativeKnowledgeRpc::default();
    let params = request(&mut f, None, None, json!({}))?;
    let cancel = CancellationToken::new();
    send_future(request_knowledge_automation(
        "integrations/knowledge/listPublications",
        params,
        &f.engine,
        &mut f.context,
        &mut cache,
        false,
        &cancel,
    ));
    assert_eq!(
        format!("{cache:?}"),
        "NativeKnowledgeRpc { cached: false, native_policy: false, native_dependencies: false }"
    );
    Ok(())
}

#[tokio::test]
async fn disabled_engine_settings_never_enable_domains_or_initialize_state() -> Result<()> {
    let mut f = fixture(false, false, true)?;
    let before = names(&f.profile)?;
    let mut cache = NativeKnowledgeRpc::default();
    assert!(native_knowledge_capabilities(&f.engine, &f.context)?.is_empty());
    for method in [
        "integrations/knowledge/listPublications",
        "integrations/automation/listSubscriptions",
    ] {
        let params = request(&mut f, None, None, json!({}))?;
        let reply = call(
            &mut f,
            &mut cache,
            method,
            params,
            false,
            &CancellationToken::new(),
        )
        .await?;
        assert_eq!(reply.status, IntegrationStatus::Unavailable);
        assert!(reply.result.as_ref().is_none());
    }
    assert_eq!(names(&f.profile)?, before);
    assert!(cache.cached.is_none());
    assert!(
        !f.engine
            .settings
            .read()
            .unwrap()
            .integrations
            .knowledge
            .publications_enabled
    );
    assert_eq!(std::fs::read(f.profile.join("settings.json"))?, b"{}");
    Ok(())
}

#[tokio::test]
async fn actual_engine_flags_and_path_drive_pure_reads_and_cache_reloads_without_forcing_settings()
-> Result<()> {
    let mut f = fixture(true, true, true)?;
    let before = names(&f.profile)?;
    let mut cache = NativeKnowledgeRpc::default();
    assert_eq!(
        native_knowledge_capabilities(&f.engine, &f.context)?.len(),
        4
    );
    let params = request(&mut f, None, None, json!({}))?;
    let first = call(
        &mut f,
        &mut cache,
        "integrations/knowledge/listPublications",
        params,
        false,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(first.status, IntegrationStatus::Completed);
    let original = cache.cached.as_ref().unwrap().host.clone();
    let params = request(&mut f, None, None, json!({"locale":"en"}))?;
    let templates = call(
        &mut f,
        &mut cache,
        "integrations/automation/listTemplates",
        params,
        false,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(templates.status, IntegrationStatus::Completed);
    let templates = templates.result.as_ref().unwrap()["templates"]
        .as_array()
        .unwrap();
    assert!(
        templates
            .iter()
            .any(|template| template["id"] == "scheduled-review")
    );
    assert!(Arc::ptr_eq(&original, &cache.cached.as_ref().unwrap().host));
    assert_eq!(names(&f.profile)?, before);
    f.engine
        .settings
        .write()
        .unwrap()
        .integrations
        .knowledge
        .publications_enabled = false;
    let params = request(&mut f, None, None, json!({}))?;
    let disabled = call(
        &mut f,
        &mut cache,
        "integrations/knowledge/listPublications",
        params,
        false,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(disabled.status, IntegrationStatus::Unavailable);
    assert!(cache.cached.is_none());
    assert_eq!(std::fs::read(f.profile.join("settings.json"))?, b"{}");
    Ok(())
}

#[tokio::test]
async fn missing_runtime_provider_is_unavailable_after_explicit_isolated_subscription_save()
-> Result<()> {
    let mut f = fixture(false, true, true)?;
    let mut cache = NativeKnowledgeRpc::default();
    cache.set_dependencies(None);
    let draft = AutomationSubscriptionDraft {
        id: "rpc-explicit-subscription".into(),
        title: "Isolated explicit weekly report".into(),
        workflow_id: "builtin-office-weekly-report".into(),
        workflow_version: 1,
        model_selection: None,
        inputs: json!({"period":"2026-W43","asOfDate":"2026-10-24","sourceRefs":[{"kind":"publication","id":"selected-fixed-source","revision":"1"}]}),
        schedule: Some(kcoder_types::CronSchedule::Every { every_seconds: 60 }),
        event_source: None,
        maximum_tokens: 5000,
        period_budget: None,
        maximum_runtime_seconds: 300,
        delivery: AutomationDestination::Studio,
    };
    let params = request(
        &mut f,
        Some("explicit-subscription-save"),
        Some(0),
        json!({"draft":draft,"consentRef":"isolated-native-user-action"}),
    )?;
    let saved = call(
        &mut f,
        &mut cache,
        "integrations/automation/saveSubscription",
        params,
        true,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(
        saved.status,
        IntegrationStatus::Completed,
        "{:?}",
        saved.error
    );
    let params = request(
        &mut f,
        Some("cancel-without-native-driver"),
        None,
        json!({"runId":"original-run-not-created-by-preview"}),
    )?;
    let unavailable = call(
        &mut f,
        &mut cache,
        "integrations/automation/cancelAutomationRun",
        params,
        true,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(unavailable.status, IntegrationStatus::Unavailable);
    assert_eq!(
        unavailable.error.as_ref().unwrap().code,
        "AUTOMATION_RUNTIME_UNAVAILABLE"
    );
    assert!(unavailable.result.as_ref().is_none());
    Ok(())
}

#[tokio::test]
async fn json_consent_forged_scope_and_cancelled_owner_cannot_initialize_or_mutate() -> Result<()> {
    let mut f = fixture(true, true, true)?;
    let before = names(&f.profile)?;
    let mut cache = NativeKnowledgeRpc::default();
    let params = request(
        &mut f,
        Some("not-native-consent"),
        Some(1),
        json!({"explicitUserAction":true}),
    )?;
    let rejected = call(
        &mut f,
        &mut cache,
        "integrations/knowledge/revokePublication",
        params,
        false,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(rejected.status, IntegrationStatus::Rejected);
    assert_eq!(
        rejected.error.as_ref().unwrap().code,
        "KNOWLEDGE_EXPLICIT_REQUEST_REQUIRED"
    );
    let mut params = request(&mut f, None, None, json!({}))?;
    params["scope"]["accountId"] = json!("forged-owner");
    let denied = call(
        &mut f,
        &mut cache,
        "integrations/knowledge/listPublications",
        params,
        false,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(denied.status, IntegrationStatus::Rejected);
    assert!(denied.result.as_ref().is_none());
    let cancel = CancellationToken::new();
    cancel.cancel();
    let params = request(&mut f, Some("cancelled-before-call"), Some(1), json!({}))?;
    let stopped = call(
        &mut f,
        &mut cache,
        "integrations/automation/removeSubscription",
        params,
        true,
        &cancel,
    )
    .await?;
    assert_eq!(
        stopped.error.as_ref().unwrap().code,
        "KNOWLEDGE_RPC_CANCELLED_BEFORE_DISPATCH"
    );
    assert!(cache.cached.is_none());
    assert_eq!(names(&f.profile)?, before);
    Ok(())
}

fn seed(
    f: &Fixture,
) -> Result<(
    kcoder_knowledge::KnowledgeCatalog,
    kcoder_knowledge::KnowledgeScope,
    PublicationDraft,
)> {
    let path = f.engine.settings_persistence_path().unwrap();
    let (profile, scope) = crate::app_server::knowledge_requests::catalog_scope_for_profile(&path)?;
    f.context
        .profile()?
        .create_private_child(OsStr::new("knowledge"))?;
    let mut source =
        kcoder_knowledge::KnowledgeCatalog::open(&profile.join("knowledge/state.sqlite"))?;
    let library = source.create(&scope, "rpc-source-library", "Actual RPC Wiki", "")?;
    let material = source.import_text(
        &scope,
        &library.id,
        "rpc-original",
        "Source.md",
        "RPC fixed r1 evidence.",
    )?;
    let pages = source.commit_generated_pages(
        &scope,
        &library.id,
        "rpc-fixed-page",
        vec![KnowledgePageDraft {
            page_id: uuid::Uuid::new_v4().to_string(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: "Fixed original".into(),
            markdown: "RPC fixed r1 evidence.".into(),
            citations: vec![KnowledgeCitation {
                source_id: material.source_id,
                revision_id: material.revision_id,
                chunk_id: "chunk-1".into(),
                quote: "RPC fixed r1 evidence.".into(),
            }],
            related_page_ids: vec![],
        }],
    )?;
    let draft = PublicationDraft {
        publication_id: "rpc-publication".into(),
        title: "Explicit fixed publication".into(),
        purpose: Some("Read exact source".into()),
        review_conclusion: None,
        visibility: KnowledgeVisibility::Personal,
        audience_id: None,
        sources: vec![PublicationSource {
            library_id: library.id,
            page_id: pages[0].page_id.clone(),
            page_revision: pages[0].revision_id.clone(),
        }],
        valid_from_ms: None,
        valid_until_ms: None,
        unresolved: vec![],
    };
    Ok((source, scope, draft))
}

#[tokio::test]
async fn adapter_uses_the_actual_engine_wiki_scope_and_fixed_r1_while_current_wiki_advances()
-> Result<()> {
    let mut f = fixture(true, false, true)?;
    let (mut source, scope, draft) = seed(&f)?;
    let mut cache = NativeKnowledgeRpc::default();
    let params = request(&mut f, Some("rpc-publish"), Some(0), json!({"draft":draft}))?;
    let published = call(
        &mut f,
        &mut cache,
        "integrations/knowledge/publishKnowledge",
        params,
        true,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(
        published.status,
        IntegrationStatus::Completed,
        "{:?}",
        published.error
    );
    let publication: KnowledgePublication =
        serde_json::from_value(published.result.as_ref().unwrap()["publication"].clone())?;
    let r2 = source.edit_page(
        &scope,
        &draft.sources[0].library_id,
        &draft.sources[0].page_id,
        &draft.sources[0].page_revision,
        "rpc-source-r2",
        "Current",
        "This current r2 cannot replace explicit r1.",
    )?;
    let params = request(
        &mut f,
        None,
        None,
        json!({"owner":publication.owner,"publicationId":draft.publication_id,"version":1}),
    )?;
    let read = call(
        &mut f,
        &mut cache,
        "integrations/knowledge/resolvePublication",
        params,
        false,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(read.status, IntegrationStatus::Completed);
    assert_eq!(
        read.result.as_ref().unwrap()["publication"]["pages"][0]["markdown"],
        "RPC fixed r1 evidence."
    );
    let params = request(
        &mut f,
        None,
        None,
        json!({"owner":publication.owner,"publicationId":draft.publication_id,"version":1,"after":null}),
    )?;
    let states = call(
        &mut f,
        &mut cache,
        "integrations/knowledge/readPublicationSources",
        params,
        false,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(states.status, IntegrationStatus::Completed);
    assert_eq!(
        states.result.as_ref().unwrap()["page"]["items"][0]["source"],
        serde_json::to_value(&draft.sources[0])?
    );
    assert_eq!(
        source
            .read_page(
                &scope,
                &draft.sources[0].library_id,
                &draft.sources[0].page_id,
                None
            )?
            .revision_id,
        r2.revision_id
    );
    assert_eq!(source.list(&scope, None, 10)?.len(), 1);
    Ok(())
}

#[tokio::test]
async fn absent_persistence_and_foreign_profile_or_workspace_never_use_a_default_profile()
-> Result<()> {
    let mut missing = fixture(true, false, false)?;
    let mut cache = NativeKnowledgeRpc::default();
    let params = request(&mut missing, None, None, json!({}))?;
    let unavailable = call(
        &mut missing,
        &mut cache,
        "integrations/knowledge/listPublications",
        params,
        false,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(unavailable.status, IntegrationStatus::Unavailable);
    assert_eq!(
        unavailable.error.as_ref().unwrap().code,
        "KNOWLEDGE_RPC_CONFIGURATION_UNAVAILABLE"
    );
    let mut owner = fixture(true, false, true)?;
    let other = fixture(true, false, true)?;
    let params = request(&mut owner, None, None, json!({}))?;
    let denied = request_knowledge_automation(
        "integrations/knowledge/listPublications",
        params,
        &other.engine,
        &mut owner.context,
        &mut cache,
        false,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(denied.status, IntegrationStatus::Rejected);
    assert!(denied.result.as_ref().is_none());
    let wrong_workspace = engine(
        &other.engine.state.cwd(),
        owner.engine.settings.read().unwrap().clone(),
        owner.engine.settings_persistence_path(),
    )?;
    let params = request(&mut owner, None, None, json!({}))?;
    let denied = request_knowledge_automation(
        "integrations/knowledge/listPublications",
        params,
        &wrong_workspace,
        &mut owner.context,
        &mut cache,
        false,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(denied.status, IntegrationStatus::Rejected);
    assert!(cache.cached.is_none());
    Ok(())
}

struct MutatingPolicy {
    settings: Option<Arc<std::sync::RwLock<Settings>>>,
    cancel: Option<CancellationToken>,
}
impl KnowledgePolicyEvaluator for MutatingPolicy {
    fn evaluate_action(
        &self,
        _: &IntegrationScope,
        _: &str,
        _: &super::super::KnowledgeResource,
    ) -> Result<IntegrationPolicyEvaluation> {
        if let Some(settings) = &self.settings {
            settings
                .write()
                .unwrap()
                .integrations
                .knowledge
                .business_automation_enabled = false;
        }
        if let Some(cancel) = &self.cancel {
            cancel.cancel();
        }
        Ok(IntegrationPolicyEvaluation {
            decision: IntegrationPolicyDecision::Allow,
            policy_revision: "actual-configuration-fence-test".into(),
            reason_code: "controlled-native-policy".into(),
        })
    }
}
#[tokio::test]
async fn actual_engine_setting_change_during_observation_discards_cached_result() -> Result<()> {
    let mut f = fixture(false, true, true)?;
    let mut cache = NativeKnowledgeRpc::default();
    cache.set_policy(Some(Arc::new(MutatingPolicy {
        settings: Some(f.engine.settings.clone()),
        cancel: None,
    })));
    let params = request(&mut f, None, None, json!({"locale":"en"}))?;
    let changed = call(
        &mut f,
        &mut cache,
        "integrations/automation/listTemplates",
        params,
        false,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(changed.status, IntegrationStatus::Unavailable);
    assert!(changed.result.as_ref().is_none());
    assert!(cache.cached.is_none());
    Ok(())
}

#[tokio::test]
async fn cancelling_an_owner_after_actual_write_keeps_unknown_distinct_from_unexecuted()
-> Result<()> {
    let mut f = fixture(true, false, true)?;
    let (_source, _scope, draft) = seed(&f)?;
    let mut cache = NativeKnowledgeRpc::default();
    let params = request(
        &mut f,
        Some("publish-for-cancel"),
        Some(0),
        json!({"draft":draft}),
    )?;
    let first = call(
        &mut f,
        &mut cache,
        "integrations/knowledge/publishKnowledge",
        params,
        true,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(first.status, IntegrationStatus::Completed);
    let owner = serde_json::to_value(KnowledgeOwner::from(f.context.scope()))?;
    let cancel = CancellationToken::new();
    cache.set_policy(Some(Arc::new(MutatingPolicy {
        settings: None,
        cancel: Some(cancel.clone()),
    })));
    let params = request(
        &mut f,
        Some("original-rpc-revoke"),
        Some(1),
        json!({"owner":owner,"publicationId":draft.publication_id,"version":1}),
    )?;
    let unknown = call(
        &mut f,
        &mut cache,
        "integrations/knowledge/revokePublication",
        params,
        true,
        &cancel,
    )
    .await?;
    assert_eq!(unknown.status, IntegrationStatus::Unknown);
    assert!(unknown.result.as_ref().is_none());
    assert_eq!(
        unknown.operation_id.as_ref().map(String::as_str),
        Some("original-rpc-revoke")
    );
    assert_eq!(
        unknown.error.as_ref().unwrap().recovery,
        IntegrationRecovery::ReconcileOriginal
    );
    cache.set_policy(None);
    let params = request(
        &mut f,
        None,
        None,
        json!({"owner":owner,"publicationId":draft.publication_id,"version":1}),
    )?;
    let actual = call(
        &mut f,
        &mut cache,
        "integrations/knowledge/resolvePublication",
        params,
        false,
        &CancellationToken::new(),
    )
    .await?;
    assert_eq!(actual.status, IntegrationStatus::Rejected);
    assert_eq!(
        actual.error.as_ref().unwrap().code,
        "KNOWLEDGE_PUBLICATION_REVOKED"
    );
    Ok(())
}
