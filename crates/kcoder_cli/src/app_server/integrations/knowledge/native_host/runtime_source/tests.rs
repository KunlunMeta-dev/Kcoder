use super::*;
use crate::app_server::integrations::knowledge::NativeKnowledgeRpc;
use anyhow::Context as _;
use kcoder_config::PrivateDirectory;
use kcoder_knowledge::KnowledgeCatalog;
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

struct MutateUnrelatedSubscriptionDuringActualPolicy {
    original: Arc<NativeKnowledgeHost>,
    armed: Arc<AtomicBool>,
    disable_original: bool,
}
impl KnowledgePolicyEvaluator for MutateUnrelatedSubscriptionDuringActualPolicy {
    fn evaluate_action(
        &self,
        scope: &IntegrationScope,
        action: &str,
        resource: &KnowledgeResource,
    ) -> Result<IntegrationPolicyEvaluation> {
        let automation = self
            .original
            .observe_automation()?
            .context("actual automation source missing")?;
        let policy = self.original.policy_for(Some(&automation));
        let result = policy.evaluate_action(scope, action, resource)?;
        if self.armed.swap(false, Ordering::SeqCst) {
            let original = automation
                .store
                .read_subscription("real-runtime-subscription")?;
            if self.disable_original {
                automation.store.set_subscription_enabled(
                    "disable-original-during-validation",
                    &original.draft.id,
                    original.revision,
                    false,
                    None,
                    100_001,
                )?;
            } else {
                let mut other = original.draft;
                other.id = "unrelated-explicit-subscription".into();
                let consent = kcoder_state::integrations::knowledge::ApprovedAutomationConsent::from_explicit_user_action(scope, "explicit-unrelated-edit", &other)?;
                automation.store.save_subscription(
                    "unrelated-save-during-validation",
                    0,
                    other,
                    &consent,
                    Some(u64::MAX / 2),
                    100_001,
                )?;
            }
        }
        Ok(result)
    }
}

struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    native: NativeIntegrationContext,
    engine: QueryEngine,
    cache: NativeKnowledgeRpc,
}
impl Fixture {
    fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let profile = parent.create_private_child(OsStr::new("profile"))?;
        parent.create_private_child(OsStr::new("workspace"))?;
        // Budget fixtures must not inherit the checkout's ancestor instructions.
        std::fs::write(
            root.path().join("workspace/AGENTS.md"),
            b"# Isolated runtime fixture\n",
        )?;
        profile.atomic_replace(OsStr::new("settings.json"), b"{}")?;
        let profile = root.path().join("profile");
        let engine =
            crate::app_server::tests::catalog_list_test_engine(&root.path().join("workspace"))
                .with_settings_persistence_path(profile.join("settings.json"));
        {
            let mut settings = engine.settings.write().unwrap();
            settings.integrations.knowledge.publications_enabled = true;
            settings.integrations.knowledge.business_automation_enabled = true;
            settings.knowledge.enabled = true;
        }
        let native = NativeIntegrationContext::capture(
            &profile,
            &engine.state.cwd(),
            "runtime-source-test",
            &engine.active_model_configuration_summary()?.revision,
        )?;
        Ok(Self {
            _root: root,
            profile,
            native,
            engine,
            cache: NativeKnowledgeRpc::default(),
        })
    }
    fn host(&mut self) -> Result<Arc<NativeKnowledgeHost>> {
        self.cache.host_for_engine(&self.native, &self.engine)
    }
    fn request(&self, operation: Option<&str>, payload: Value) -> IntegrationRequest {
        IntegrationRequest {
            contract_version: IntegrationContractVersion::ParallelV1,
            request_id: uuid::Uuid::new_v4().to_string(),
            scope: self.native.scope().clone(),
            operation_id: operation.map(str::to_owned),
            expected_revision: None,
            timeout_ms: 30_000,
            cancellation_ref: None,
            payload: payload.as_object().unwrap().clone(),
        }
    }
    fn publication(&mut self, adopt: bool) -> Result<()> {
        self.native
            .profile()?
            .create_private_child(OsStr::new("knowledge"))?;
        let (_, legacy) = crate::app_server::knowledge_requests::catalog_scope_for_profile(
            &self.profile.join("settings.json"),
        )?;
        let mut catalog = KnowledgeCatalog::open(&self.profile.join("knowledge/state.sqlite"))?;
        let library = catalog.create(&legacy, "source-library", "Actual source library", "")?;
        let imported = catalog.import_text(
            &legacy,
            &library.id,
            "source-material",
            "Evidence.md",
            "actual fixed r1 source",
        )?;
        let page = catalog
            .commit_generated_pages(
                &legacy,
                &library.id,
                "source-pages",
                vec![KnowledgePageDraft {
                    page_id: uuid::Uuid::new_v4().to_string(),
                    expected_revision: None,
                    kind: KnowledgePageKind::Concept,
                    title: "Actual source".into(),
                    markdown: "actual fixed r1 source".into(),
                    citations: vec![KnowledgeCitation {
                        source_id: imported.source_id,
                        revision_id: imported.revision_id,
                        chunk_id: "chunk-1".into(),
                        quote: "actual fixed r1 source".into(),
                    }],
                    related_page_ids: vec![],
                }],
            )?
            .remove(0);
        let host = self.host()?;
        let mut request=self.request(Some("publish-fixed-version"),json!({"draft":{"publicationId":"runtime-publication","title":"Runtime source","visibility":"personal","audienceId":null,"sources":[{"libraryId":library.id,"pageId":page.page_id,"pageRevision":page.revision_id}],"validFromMs":null,"validUntilMs":null,"unresolved":[]}}));
        request.expected_revision = Some("0".into());
        let response = host.knowledge(
            "publishKnowledge",
            &request,
            true,
            1000,
            &CancellationToken::new(),
        );
        anyhow::ensure!(
            response.status == IntegrationStatus::Completed,
            "publication fixture failed: status={:?}, error={:?}",
            response.status,
            response.error
        );
        if adopt {
            let mut request=self.request(Some("adopt-fixed-version"),json!({"owner":KnowledgeOwner::from(self.native.scope()),"publicationId":"runtime-publication","version":1}));
            request.expected_revision = Some("0".into());
            let response = host.knowledge(
                "adoptPublication",
                &request,
                true,
                1001,
                &CancellationToken::new(),
            );
            anyhow::ensure!(
                response.status == IntegrationStatus::Completed,
                "adoption fixture failed: status={:?}, error={:?}",
                response.status,
                response.error
            );
        }
        Ok(())
    }
    async fn run(&mut self) -> Result<(Arc<NativeKnowledgeHost>, IntegrationRequest)> {
        let draft = AutomationSubscriptionDraft {
            id: "real-runtime-subscription".into(),
            title: "Actual saved runtime source".into(),
            workflow_id: "builtin-office-source-digest".into(),
            workflow_version: 1,
            model_selection: None,
            inputs: json!({"period":"2026-W43","asOfDate":"2026-10-24","sourceRefs":[{"kind":"publication","id":"runtime-publication","revision":"1"}]}),
            schedule: Some(kcoder_types::CronSchedule::Every { every_seconds: 60 }),
            event_source: None,
            maximum_tokens: 5000,
            period_budget: None,
            maximum_runtime_seconds: 300,
            delivery: AutomationDestination::Studio,
        };
        self.run_draft(draft).await
    }
    async fn run_draft(
        &mut self,
        draft: AutomationSubscriptionDraft,
    ) -> Result<(Arc<NativeKnowledgeHost>, IntegrationRequest)> {
        let host = self.host()?;
        let save = self.request(
            Some("save-source-subscription"),
            json!({"draft":draft,"consentRef":"native-explicit-subscription"}),
        );
        let reply = host
            .automation(
                "saveSubscription",
                &save,
                true,
                1000,
                &CancellationToken::new(),
            )
            .await;
        anyhow::ensure!(
            reply.status == IntegrationStatus::Completed,
            "subscription fixture failed"
        );
        let automation = host.observe_automation()?.unwrap();
        let sub = automation
            .store
            .read_subscription("real-runtime-subscription")?;
        let due = sub.next_fire_at_ms.unwrap();
        let run = automation.store.prepare_run(
            &sub.draft.id,
            sub.revision,
            "actual-native-trigger",
            json!({"fact":"stored before runtime accept"}),
            Some(due + 60_000),
            due,
        )?;
        anyhow::ensure!(
            automation.store.claim_native_submission(&run.id)?,
            "source fixture was already claimed"
        );
        let mut payload = json!({"kind":"workflow","workflowId":sub.draft.workflow_id,"workflowVersion":sub.draft.workflow_version,"inputs":sub.draft.inputs,"maximumTokens":sub.draft.maximum_tokens,"maximumRuntimeSeconds":sub.draft.maximum_runtime_seconds,"source":{"kind":"automation","subscriptionId":sub.draft.id,"subscriptionRevision":sub.revision,"runId":run.id,"consentRef":sub.consent_ref}});
        if let Some(selection) = &sub.draft.model_selection {
            payload["modelSelection"] = serde_json::to_value(selection)?;
        }
        let request = self.request(Some(&run.native_operation_id), payload);
        Ok((host, request))
    }
}

#[tokio::test]
async fn actual_persisted_auto_selection_is_never_downgraded_to_inherit_or_payload_authority()
-> Result<()> {
    let mut fixture = Fixture::new()?;
    fixture.publication(true)?;
    let draft = AutomationSubscriptionDraft {
        id: "real-runtime-subscription".into(),
        title: "Explicit saved AUTO intent".into(),
        workflow_id: "builtin-office-source-digest".into(),
        workflow_version: 1,
        model_selection: Some(IntegrationModelSelectionIntent::AutoPolicy {
            id: "personal-pool".into(),
            version: "original-policy-version".into(),
        }),
        inputs: json!({"period":"2026-W43","asOfDate":"2026-10-24","sourceRefs":[{"kind":"publication","id":"runtime-publication","revision":"1"}]}),
        schedule: Some(kcoder_types::CronSchedule::Every { every_seconds: 60 }),
        event_source: None,
        maximum_tokens: 5000,
        period_budget: None,
        maximum_runtime_seconds: 300,
        delivery: AutomationDestination::Studio,
    };
    let (host, request) = fixture.run_draft(draft).await?;
    let source = NativeAutomationSource::capture(
        &fixture.native,
        &fixture.engine,
        host.clone(),
        &request,
        &CancellationToken::new(),
    )?;
    assert_eq!(
        source.effective_model_selection(),
        IntegrationModelSelectionIntent::AutoPolicy {
            id: "personal-pool".into(),
            version: "original-policy-version".into()
        }
    );
    let mut removed = request.clone();
    removed.payload.remove("modelSelection");
    assert!(
        NativeAutomationSource::capture(
            &fixture.native,
            &fixture.engine,
            host.clone(),
            &removed,
            &CancellationToken::new()
        )
        .is_err()
    );
    let mut changed = request.clone();
    changed.payload["modelSelection"] =
        json!({"kind":"auto_policy","id":"personal-pool","version":"new-version"});
    assert!(
        NativeAutomationSource::capture(
            &fixture.native,
            &fixture.engine,
            host.clone(),
            &changed,
            &CancellationToken::new()
        )
        .is_err()
    );
    let result = crate::app_server::integrations::knowledge::automation_runtime::prepare_native_automation_runtime(&fixture.native, &fixture.engine, host, &request, None, &CancellationToken::new());
    assert!(
        result.is_err(),
        "an unavailable configured policy cannot downgrade the original AUTO intent to inherit"
    );
    assert!(!fixture.profile.join("workflow-runs").exists());
    Ok(())
}

#[path = "runtime_tests.rs"]
mod runtime_tests;

#[tokio::test]
async fn actual_native_run_and_adopted_publication_freeze_normalized_inputs_without_a_runtime()
-> Result<()> {
    let mut f = Fixture::new()?;
    f.publication(true)?;
    let (host, request) = f.run().await?;
    let source = NativeAutomationSource::capture(
        &f.native,
        &f.engine,
        host,
        &request,
        &CancellationToken::new(),
    )?;
    assert_eq!(source.pin().definition().id, "builtin-office-source-digest");
    assert_eq!(source.pin().args()["outputLanguage"], "zh-CN");
    assert_eq!(source.maximum_tokens(), 5000);
    assert_eq!(source.maximum_runtime_seconds(), 300);
    let data = source.read_materials(&f.native, &request, &CancellationToken::new())?;
    assert_eq!(data.len(), 1);
    assert!(data[0].to_string().contains("actual fixed r1 source"));
    assert!(!f.profile.join("workflow-library").exists());
    assert!(!f.profile.join("workflow-runs").exists());
    Ok(())
}

#[tokio::test]
async fn fabricated_runtime_payload_or_unadopted_version_cannot_release_material() -> Result<()> {
    let mut f = Fixture::new()?;
    f.publication(false)?;
    let (host, request) = f.run().await?;
    assert!(
        NativeAutomationSource::capture(
            &f.native,
            &f.engine,
            host.clone(),
            &request,
            &CancellationToken::new()
        )
        .is_err()
    );
    for field in ["workflowVersion", "maximumTokens", "inputs"] {
        let mut wrong = request.clone();
        wrong.payload.insert(field.into(), json!(999));
        assert!(
            NativeAutomationSource::capture(
                &f.native,
                &f.engine,
                host.clone(),
                &wrong,
                &CancellationToken::new()
            )
            .is_err()
        );
    }
    let mut wrong = request.clone();
    wrong.operation_id = Some("invented-operation".into());
    assert!(
        NativeAutomationSource::capture(
            &f.native,
            &f.engine,
            host,
            &wrong,
            &CancellationToken::new()
        )
        .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn disabling_subscription_or_revoking_publication_invalidates_old_source_without_latest_fallback()
-> Result<()> {
    let mut f = Fixture::new()?;
    f.publication(true)?;
    let (host, request) = f.run().await?;
    let source = NativeAutomationSource::capture(
        &f.native,
        &f.engine,
        host.clone(),
        &request,
        &CancellationToken::new(),
    )?;
    let mut revoke = f.request(
        Some("revoke-source-version"),
        json!({"owner":KnowledgeOwner::from(f.native.scope()),"publicationId":"runtime-publication","version":1}),
    );
    revoke.expected_revision = Some("1".into());
    let reply = host.knowledge(
        "revokePublication",
        &revoke,
        true,
        2000,
        &CancellationToken::new(),
    );
    assert_eq!(reply.status, IntegrationStatus::Completed);
    assert!(
        source
            .read_materials(&f.native, &request, &CancellationToken::new())
            .is_err()
    );
    let mut f = Fixture::new()?;
    f.publication(true)?;
    let (host, request) = f.run().await?;
    let source = NativeAutomationSource::capture(
        &f.native,
        &f.engine,
        host.clone(),
        &request,
        &CancellationToken::new(),
    )?;
    let mut disable = f.request(
        Some("disable-source-subscription"),
        json!({"subscriptionId":"real-runtime-subscription","enabled":false}),
    );
    disable.expected_revision = Some("1".into());
    assert_eq!(
        host.automation(
            "setSubscriptionEnabled",
            &disable,
            true,
            2000,
            &CancellationToken::new()
        )
        .await
        .status,
        IntegrationStatus::Completed
    );
    assert!(
        source
            .verify(&f.native, &request, &CancellationToken::new())
            .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn replacing_current_policy_cache_invalidates_the_captured_host_source() -> Result<()> {
    let mut f = Fixture::new()?;
    f.publication(true)?;
    let (host, request) = f.run().await?;
    let source = NativeAutomationSource::capture(
        &f.native,
        &f.engine,
        host,
        &request,
        &CancellationToken::new(),
    )?;
    f.cache.clear();
    assert!(
        source
            .read_materials(&f.native, &request, &CancellationToken::new())
            .is_err()
    );
    Ok(())
}

struct RejectPolicy;
impl crate::app_server::integrations::knowledge::KnowledgePolicyEvaluator for RejectPolicy {
    fn evaluate_action(
        &self,
        _scope: &IntegrationScope,
        _action: &str,
        _resource: &crate::app_server::integrations::knowledge::KnowledgeResource,
    ) -> Result<IntegrationPolicyEvaluation> {
        anyhow::bail!("SOURCE_TEST_POLICY_REVOKED")
    }
}
struct NoCallsDependency;
#[async_trait::async_trait]
impl crate::app_server::integrations::knowledge::KnowledgeDependencyPort for NoCallsDependency {
    fn registered(&self, _port: IntegrationPort, _method: &str) -> bool {
        false
    }
    async fn call(
        &self,
        _port: IntegrationPort,
        _method: &str,
        _request: &IntegrationRequest,
    ) -> IntegrationReply {
        panic!("this native cache/source test must not dispatch or fabricate a receipt")
    }
}

#[tokio::test]
async fn replacing_real_policy_invalidates_old_source_but_same_arc_and_none_are_noops() -> Result<()>
{
    let mut f = Fixture::new()?;
    f.publication(true)?;
    let (host, request) = f.run().await?;
    let source = NativeAutomationSource::capture(
        &f.native,
        &f.engine,
        host.clone(),
        &request,
        &CancellationToken::new(),
    )?;
    f.cache.set_policy(None);
    source.verify(&f.native, &request, &CancellationToken::new())?;
    let policy: Arc<dyn crate::app_server::integrations::knowledge::KnowledgePolicyEvaluator> =
        Arc::new(RejectPolicy);
    f.cache.set_policy(Some(policy.clone()));
    assert!(!host.runtime_sources_current());
    assert!(
        source
            .read_materials(&f.native, &request, &CancellationToken::new())
            .is_err()
    );
    let replacement = f.host()?;
    f.cache.set_policy(Some(policy));
    assert!(replacement.runtime_sources_current());
    assert!(Arc::ptr_eq(&replacement, &f.host()?));
    Ok(())
}

#[tokio::test]
async fn actual_dependency_rebind_revokes_old_sources_and_same_wrapped_arc_retains_runtime()
-> Result<()> {
    let mut f = Fixture::new()?;
    f.publication(true)?;
    let (host, request) = f.run().await?;
    let source = NativeAutomationSource::capture(
        &f.native,
        &f.engine,
        host.clone(),
        &request,
        &CancellationToken::new(),
    )?;
    f.cache.set_dependencies(None);
    source.verify(&f.native, &request, &CancellationToken::new())?;
    let dependency: Arc<dyn crate::app_server::integrations::knowledge::KnowledgeDependencyPort> =
        Arc::new(NoCallsDependency);
    f.cache.set_dependencies(Some(dependency.clone()));
    assert!(!host.runtime_sources_current());
    assert!(
        source
            .verify(&f.native, &request, &CancellationToken::new())
            .is_err()
    );
    let prior_runtime = f.host()?;
    f.cache.bind_native_runtime(Arc::new(NoCallsDependency));
    assert!(!prior_runtime.runtime_sources_current());
    assert!(f.cache.has_native_runtime_binding());
    let current = f.host()?;
    let source = NativeAutomationSource::capture(
        &f.native,
        &f.engine,
        current.clone(),
        &request,
        &CancellationToken::new(),
    )?;
    f.cache.set_dependencies(Some(dependency));
    assert!(f.cache.has_native_runtime_binding());
    assert!(Arc::ptr_eq(&current, &f.host()?));
    source.verify(&f.native, &request, &CancellationToken::new())?;
    // Already-bound calls preserve the original connection's exact Runtime;
    // a request-local view is also unable to revoke the shared accepted source.
    f.cache.bind_native_runtime(Arc::new(NoCallsDependency));
    let mut native = f.native.recapture_for_owned_service()?;
    let mut fork = f.cache.request_fork(&mut native, &f.engine)?;
    fork.clear();
    source.verify(&f.native, &request, &CancellationToken::new())?;
    f.cache.set_dependencies(None);
    assert!(!f.cache.has_native_runtime_binding());
    assert!(!current.runtime_sources_current());
    assert!(
        source
            .verify(&f.native, &request, &CancellationToken::new())
            .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn cancellation_and_unknown_runs_never_initialize_a_source_store() -> Result<()> {
    let mut f = Fixture::new()?;
    let host = f.host()?;
    let request=f.request(Some("no-existing-run"),json!({"kind":"workflow","workflowId":"builtin-office-source-digest","workflowVersion":1,"inputs":{},"maximumTokens":5000,"maximumRuntimeSeconds":300,"source":{"kind":"automation","subscriptionId":"missing","subscriptionRevision":1,"runId":"missing","consentRef":"untrusted-string"}}));
    assert!(
        NativeAutomationSource::capture(
            &f.native,
            &f.engine,
            host.clone(),
            &request,
            &CancellationToken::new()
        )
        .is_err()
    );
    assert!(host.observe_automation()?.is_none());
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(
        NativeAutomationSource::capture(&f.native, &f.engine, host, &request, &cancel).is_err()
    );
    Ok(())
}

#[tokio::test]
async fn unrelated_actual_subscription_write_revalidates_original_source_without_revoking_it()
-> Result<()> {
    let mut fixture = Fixture::new()?;
    fixture.publication(true)?;
    let (original, request) = fixture.run().await?;
    let armed = Arc::new(AtomicBool::new(false));
    let settings = fixture
        .engine
        .settings
        .read()
        .unwrap()
        .integrations
        .knowledge
        .clone();
    let host = Arc::new(
        NativeKnowledgeHost::new(&fixture.native, settings)?.with_policy(Arc::new(
            MutateUnrelatedSubscriptionDuringActualPolicy {
                original,
                armed: armed.clone(),
                disable_original: false,
            },
        )),
    );
    let source = NativeAutomationSource::capture(
        &fixture.native,
        &fixture.engine,
        host,
        &request,
        &CancellationToken::new(),
    )?;
    let before = source.change_epoch()?;
    armed.store(true, Ordering::SeqCst);
    super::super::super::automation_runtime::revalidate_runtime_source_for_test(&source)?;
    assert_ne!(before, source.change_epoch()?);
    source.verify(&fixture.native, &request, &CancellationToken::new())?;
    assert!(
        source.read_materials(&fixture.native, &request, &CancellationToken::new())?[0]
            .to_string()
            .contains("actual fixed r1 source")
    );
    assert!(!fixture.profile.join("workflow-runs").exists());
    Ok(())
}

#[tokio::test]
async fn original_subscription_disable_during_actual_source_validation_still_rejects() -> Result<()>
{
    let mut fixture = Fixture::new()?;
    fixture.publication(true)?;
    let (original, request) = fixture.run().await?;
    let armed = Arc::new(AtomicBool::new(false));
    let settings = fixture
        .engine
        .settings
        .read()
        .unwrap()
        .integrations
        .knowledge
        .clone();
    let host = Arc::new(
        NativeKnowledgeHost::new(&fixture.native, settings)?.with_policy(Arc::new(
            MutateUnrelatedSubscriptionDuringActualPolicy {
                original,
                armed: armed.clone(),
                disable_original: true,
            },
        )),
    );
    let source = NativeAutomationSource::capture(
        &fixture.native,
        &fixture.engine,
        host,
        &request,
        &CancellationToken::new(),
    )?;
    armed.store(true, Ordering::SeqCst);
    assert!(
        super::super::super::automation_runtime::revalidate_runtime_source_for_test(&source)
            .is_err()
    );
    assert!(!fixture.profile.join("workflow-runs").exists());
    Ok(())
}
