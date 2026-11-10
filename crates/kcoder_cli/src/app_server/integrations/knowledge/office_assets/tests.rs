use super::*;
use crate::app_server::integrations::knowledge::KnowledgePolicyEvaluator;
use kcoder_config::PrivateDirectory;
use kcoder_knowledge::{KnowledgeCatalog, KnowledgeScope};
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
use std::{
    ffi::OsStr,
    sync::atomic::{AtomicUsize, Ordering},
};

#[path = "management_tests.rs"]
mod management_tests;
#[path = "organization_native_tests.rs"]
mod organization_native_tests;

struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    native: NativeIntegrationContext,
    engine: QueryEngine,
    cache: Arc<Mutex<NativeKnowledgeRpc>>,
}
impl Fixture {
    fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        let directory = PrivateDirectory::open_existing(root.path())?;
        let profile = directory.create_private_child(OsStr::new("profile"))?;
        directory.create_private_child(OsStr::new("workspace"))?;
        profile.atomic_replace(OsStr::new("settings.json"), b"{}")?;
        let profile = root.path().join("profile");
        let engine =
            crate::app_server::tests::catalog_list_test_engine(&root.path().join("workspace"))
                .with_settings_persistence_path(profile.join("settings.json"));
        {
            let mut settings = engine.settings.write().unwrap();
            settings.knowledge.enabled = true;
            settings.integrations.knowledge.publications_enabled = true;
            settings.integrations.office.enabled = true;
        }
        let native = NativeIntegrationContext::capture(
            &profile,
            &engine.state.cwd(),
            "d17-native-owner",
            &engine.active_model_configuration_summary()?.revision,
        )?;
        Ok(Self {
            _root: root,
            profile,
            native,
            engine,
            cache: Arc::new(Mutex::new(NativeKnowledgeRpc::default())),
        })
    }
    fn accepted(&self) -> Result<TurnAttemptIdentity> {
        self.engine
            .state
            .add_message(kcoder_types::Message::user_text(
                "Generate from explicit owned fixed material.",
            ));
        let identity = TurnAttemptIdentity {
            thread_id: self.engine.session_id(),
            turn_id: "actual-d17-turn".into(),
            attempt_id: uuid::Uuid::new_v4().to_string(),
        };
        crate::app_server::turn_attempts::begin(
            &self.engine,
            &identity,
            false,
            None,
            "a".repeat(64),
            "b".repeat(64),
        )?;
        Ok(identity)
    }
    fn request(&self, identity: &TurnAttemptIdentity, payload: Value) -> IntegrationRequest {
        let mut payload = payload.as_object().unwrap().clone();
        payload.insert(
            "task".into(),
            json!({"threadId":identity.thread_id,"turnId":identity.turn_id}),
        );
        IntegrationRequest {
            contract_version: IntegrationContractVersion::ParallelV1,
            request_id: uuid::Uuid::new_v4().to_string(),
            scope: self.native.scope().clone(),
            operation_id: None,
            expected_revision: None,
            timeout_ms: 30_000,
            cancellation_ref: None,
            payload,
        }
    }
    fn seed(&self) -> Result<(KnowledgeCatalog, KnowledgeScope, PublicationSource)> {
        self.native
            .profile()?
            .create_private_child(OsStr::new("knowledge"))?;
        let (_, legacy) = crate::app_server::knowledge_requests::catalog_scope_for_profile(
            &self.profile.join("settings.json"),
        )?;
        let mut store = KnowledgeCatalog::open(&self.profile.join("knowledge/state.sqlite"))?;
        let library = store.create(&legacy, "owned-library", "Original real Wiki", "")?;
        let text = format!(
            "Pinned evidence with citation.\n{}\nTAIL_BEYOND_PREVIEW",
            "Complete source content must remain part of the hash. ".repeat(150)
        );
        let source =
            store.import_text(&legacy, &library.id, "owned-source", "Evidence.md", &text)?;
        let pages = store.commit_generated_pages(
            &legacy,
            &library.id,
            "owned-page",
            vec![KnowledgePageDraft {
                page_id: uuid::Uuid::new_v4().to_string(),
                expected_revision: None,
                kind: KnowledgePageKind::Concept,
                title: "Real fixed source page".into(),
                markdown: text,
                citations: vec![KnowledgeCitation {
                    source_id: source.source_id,
                    revision_id: source.revision_id,
                    chunk_id: "chunk-1".into(),
                    quote: "Pinned evidence with citation.".into(),
                }],
                related_page_ids: vec![],
            }],
        )?;
        Ok((
            store,
            legacy,
            PublicationSource {
                library_id: library.id,
                page_id: pages[0].page_id.clone(),
                page_revision: pages[0].revision_id.clone(),
            },
        ))
    }
    async fn host(&self) -> Result<Arc<NativeKnowledgeHost>> {
        self.cache
            .lock()
            .await
            .host_for_engine(&self.native, &self.engine)
    }
    async fn publish(
        &self,
        source: &PublicationSource,
        revision: u64,
    ) -> Result<KnowledgePublication> {
        let host = self.host().await?;
        let request=IntegrationRequest {contract_version:IntegrationContractVersion::ParallelV1,
            request_id:uuid::Uuid::new_v4().to_string(),scope:self.native.scope().clone(),
            operation_id:Some(format!("publication-version-{revision}")),expected_revision:Some(revision.to_string()),
            timeout_ms:30_000,cancellation_ref:None,payload:json!({"draft":{"publicationId":"actual-office-publication",
                "title":"Actual Office material publication","visibility":"personal","audienceId":null,
                "sources":[source],"validFromMs":null,"validUntilMs":null,"unresolved":[]}}).as_object().unwrap().clone()};
        let reply = host.knowledge(
            "publishKnowledge",
            &request,
            true,
            u64::try_from(chrono::Utc::now().timestamp_millis())?,
            &CancellationToken::new(),
        );
        ensure!(reply.status == IntegrationStatus::Completed, "{reply:?}");
        Ok(serde_json::from_value(
            reply.result.as_ref().unwrap()["publication"].clone(),
        )?)
    }
    async fn adopt(&self, publication: &KnowledgePublication) -> Result<()> {
        let host = self.host().await?;
        let request=IntegrationRequest {contract_version:IntegrationContractVersion::ParallelV1,
            request_id:uuid::Uuid::new_v4().to_string(),scope:self.native.scope().clone(),operation_id:Some("explicit-adoption".into()),
            expected_revision:Some("0".into()),timeout_ms:30_000,cancellation_ref:None,
            payload:json!({"owner":publication.owner,"publicationId":publication.draft.publication_id,"version":publication.version}).as_object().unwrap().clone()};
        let reply = host.knowledge(
            "adoptPublication",
            &request,
            true,
            u64::try_from(chrono::Utc::now().timestamp_millis())?,
            &CancellationToken::new(),
        );
        ensure!(reply.status == IntegrationStatus::Completed, "{reply:?}");
        Ok(())
    }
}

#[tokio::test]
async fn reads_complete_real_fixed_wiki_and_explicit_publication_without_latest_or_preview_hash()
-> Result<()> {
    let fixture = Fixture::new()?;
    let (mut wiki, legacy, source) = fixture.seed()?;
    let identity = fixture.accepted()?;
    let scope = fixture
        .engine
        .state
        .history_attempt_scope(identity.clone())?;
    scope.run(async {
        let assets=NativeKnowledgeOfficeAssets::capture(&fixture.native,&fixture.engine,&identity,fixture.cache.clone())?;
        let request=fixture.request(&identity,json!({}));
        let reference=office_wiki_page_reference(&source)?;
        let original=assets.validate_sources(&fixture.native,&request,std::slice::from_ref(&reference),&CancellationToken::new()).await?;
        let page=wiki.read_page(&legacy,&source.library_id,&source.page_id,Some(&source.page_revision))?;
        let expected=json!({"schemaVersion":1,"kind":WIKI_PAGE,"source":source,"page":page.draft,"revision":page.revision_id});
        assert_eq!(original[0].sha256,format!("{:x}",Sha256::digest(serde_json::to_vec(&expected)?)));
        assert_ne!(original[0].sha256,format!("{:x}",Sha256::digest(reference.id.as_bytes())));
        let publication=fixture.publish(&source,0).await?;
        let fixed=OfficeResourceRef{kind:PUBLICATION.into(),id:publication.draft.publication_id.clone(),revision:"1".into()};
        assert!(assets.validate_sources(&fixture.native,&request,std::slice::from_ref(&fixed),&CancellationToken::new()).await.is_err());
        fixture.adopt(&publication).await?;
        let published=assets.validate_sources(&fixture.native,&request,std::slice::from_ref(&fixed),&CancellationToken::new()).await?;
        assert_eq!(published[0].sha256,format!("{:x}",Sha256::digest(serde_json::to_vec(&json!({"schemaVersion":1,"kind":PUBLICATION,"publication":publication}))?)));
        wiki.edit_page(&legacy,&source.library_id,&source.page_id,&source.page_revision,"human-r2","Updated current page","New current r2, never the original source.")?;
        assert_eq!(assets.validate_sources(&fixture.native,&request,&[reference],&CancellationToken::new()).await?,original);
        assert_eq!(assets.validate_sources(&fixture.native,&request,&[fixed],&CancellationToken::new()).await?,published);
        Ok::<_,anyhow::Error>(())
    }).await
}

#[tokio::test]
async fn guessed_task_or_nonaccepted_scope_unknown_kind_and_current_policy_deny_release_no_identity()
-> Result<()> {
    let fixture = Fixture::new()?;
    let (_, _, source) = fixture.seed()?;
    let identity = fixture.accepted()?;
    assert!(
        NativeKnowledgeOfficeAssets::capture(
            &fixture.native,
            &fixture.engine,
            &identity,
            fixture.cache.clone()
        )
        .is_err()
    );
    let scope = fixture
        .engine
        .state
        .history_attempt_scope(identity.clone())?;
    scope
        .run(async {
            let assets = NativeKnowledgeOfficeAssets::capture(
                &fixture.native,
                &fixture.engine,
                &identity,
                fixture.cache.clone(),
            )?;
            let mut request = fixture.request(&identity, json!({}));
            let reference = office_wiki_page_reference(&source)?;
            request.payload.get_mut("task").unwrap()["turnId"] =
                json!("not-the-actual-accepted-turn");
            assert!(
                assets
                    .validate_sources(
                        &fixture.native,
                        &request,
                        std::slice::from_ref(&reference),
                        &CancellationToken::new()
                    )
                    .await
                    .is_err()
            );
            let request = fixture.request(&identity, json!({}));
            let unsupported = OfficeResourceRef {
                kind: "file".into(),
                ..reference.clone()
            };
            assert_eq!(
                assets
                    .validate_sources(
                        &fixture.native,
                        &request,
                        &[unsupported],
                        &CancellationToken::new()
                    )
                    .await
                    .unwrap_err()
                    .to_string(),
                "OFFICE_INPUT_PROVIDER_UNAVAILABLE"
            );
            fixture.cache.lock().await.set_policy(Some(Arc::new(Deny)));
            assert!(
                assets
                    .validate_sources(
                        &fixture.native,
                        &request,
                        &[reference],
                        &CancellationToken::new()
                    )
                    .await
                    .is_err()
            );
            Ok::<_, anyhow::Error>(())
        })
        .await
}

struct Deny;
impl KnowledgePolicyEvaluator for Deny {
    fn evaluate_action(
        &self,
        _: &IntegrationScope,
        _: &str,
        _: &super::super::KnowledgeResource,
    ) -> Result<IntegrationPolicyEvaluation> {
        Ok(IntegrationPolicyEvaluation {
            decision: IntegrationPolicyDecision::Deny,
            policy_revision: "actual-current-policy".into(),
            reason_code: "deny".into(),
        })
    }
}

struct ReplacePolicyDuringRead {
    cache: Arc<Mutex<NativeKnowledgeRpc>>,
    reads: AtomicUsize,
}
impl KnowledgePolicyEvaluator for ReplacePolicyDuringRead {
    fn evaluate_action(
        &self,
        scope: &IntegrationScope,
        _: &str,
        resource: &super::super::KnowledgeResource,
    ) -> Result<IntegrationPolicyEvaluation> {
        if self.reads.fetch_add(1, Ordering::SeqCst) == 0 {
            self.cache
                .try_lock()
                .context("current cache must not stay locked during source I/O")?
                .set_policy(Some(Arc::new(Deny)));
        }
        Ok(IntegrationPolicyEvaluation {
            decision: if resource.owner == KnowledgeOwner::from(scope) {
                IntegrationPolicyDecision::Allow
            } else {
                IntegrationPolicyDecision::Deny
            },
            policy_revision: "original-read-policy".into(),
            reason_code: "owned-real-source".into(),
        })
    }
}

#[tokio::test]
async fn replacing_actual_cached_policy_mid_read_discards_old_authorized_body_and_hash()
-> Result<()> {
    let fixture = Fixture::new()?;
    let (_, _, source) = fixture.seed()?;
    let identity = fixture.accepted()?;
    let scope = fixture
        .engine
        .state
        .history_attempt_scope(identity.clone())?;
    scope
        .run(async {
            let policy = Arc::new(ReplacePolicyDuringRead {
                cache: fixture.cache.clone(),
                reads: AtomicUsize::new(0),
            });
            fixture.cache.lock().await.set_policy(Some(policy.clone()));
            let assets = NativeKnowledgeOfficeAssets::capture(
                &fixture.native,
                &fixture.engine,
                &identity,
                fixture.cache.clone(),
            )?;
            let result = assets
                .validate_sources(
                    &fixture.native,
                    &fixture.request(&identity, json!({})),
                    &[office_wiki_page_reference(&source)?],
                    &CancellationToken::new(),
                )
                .await;
            assert!(result.is_err());
            assert!(policy.reads.load(Ordering::SeqCst) > 0);
            assert!(!fixture.profile.join("office").exists());
            Ok::<_, anyhow::Error>(())
        })
        .await
}

#[tokio::test]
async fn missing_real_wiki_never_initializes_a_store_or_hashes_the_locator() -> Result<()> {
    let fixture = Fixture::new()?;
    let identity = fixture.accepted()?;
    let scope = fixture
        .engine
        .state
        .history_attempt_scope(identity.clone())?;
    scope
        .run(async {
            let assets = NativeKnowledgeOfficeAssets::capture(
                &fixture.native,
                &fixture.engine,
                &identity,
                fixture.cache.clone(),
            )?;
            let reference = office_wiki_page_reference(&PublicationSource {
                library_id: "unknown-library".into(),
                page_id: "unknown-page".into(),
                page_revision: "unknown-r1".into(),
            })?;
            assert!(
                assets
                    .validate_sources(
                        &fixture.native,
                        &fixture.request(&identity, json!({})),
                        &[reference],
                        &CancellationToken::new()
                    )
                    .await
                    .is_err()
            );
            assert!(!fixture.profile.join("knowledge").exists());
            Ok::<_, anyhow::Error>(())
        })
        .await
}

struct RevokeAfterSecondRead {
    assets: Arc<NativeKnowledgeOfficeAssets>,
    host: Arc<NativeKnowledgeHost>,
    revoke: IntegrationRequest,
    calls: AtomicUsize,
}
#[async_trait]
impl NativeOfficeAssets for RevokeAfterSecondRead {
    async fn validate_sources(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        sources: &[OfficeResourceRef],
        cancel: &CancellationToken,
    ) -> Result<Vec<OfficeCanonicalInputIdentity>> {
        let identities = self
            .assets
            .validate_sources(native, request, sources, cancel)
            .await?;
        if self.calls.fetch_add(1, Ordering::SeqCst) == 1 {
            let reply = self.host.knowledge(
                "revokePublication",
                &self.revoke,
                true,
                u64::try_from(chrono::Utc::now().timestamp_millis())?,
                cancel,
            );
            ensure!(reply.status == IntegrationStatus::Completed, "{reply:?}");
        }
        Ok(identities)
    }
}

#[tokio::test]
#[ignore = "Requires explicit actual Node; isolated accepted material-to-Office acceptance"]
async fn actual_office_document_node_binds_adopted_source_and_rejects_revocation_before_publication()
-> Result<()> {
    use crate::app_server::integrations::office::{
        OfficeNodeGenerator,
        native_host::{
            NativeOfficeAcceptedTurnAuthority, NativeOfficeComposition, NativeOfficeInstalledPaths,
            NativeOfficeProviders,
        },
    };
    use kcoder_engine::integrations::office::{OfficeNativeToolOwner, OfficeToolOwnerResolver};
    let node = std::env::var_os("KCODER_OFFICE_COMPONENT_TEST_NODE")
        .context("explicit actual Node required")?;
    for revoke_during_generation in [false, true] {
        let fixture = Fixture::new()?;
        let (_wiki, _legacy, source) = fixture.seed()?;
        let publication = fixture.publish(&source, 0).await?;
        fixture.adopt(&publication).await?;
        let identity = fixture.accepted()?;
        let scope = fixture
            .engine
            .state
            .history_attempt_scope(identity.clone())?;
        scope.run(async {
            let assets=Arc::new(NativeKnowledgeOfficeAssets::capture(&fixture.native,&fixture.engine,&identity,fixture.cache.clone())?);
            let reference=OfficeResourceRef {kind:PUBLICATION.into(),id:publication.draft.publication_id.clone(),revision:"1".into()};
            let expected=assets.validate_sources(&fixture.native,&fixture.request(&identity,json!({})),
                std::slice::from_ref(&reference),&CancellationToken::new()).await?;
            let host=fixture.host().await?;
            let revoke=IntegrationRequest{contract_version:IntegrationContractVersion::ParallelV1,
                request_id:uuid::Uuid::new_v4().to_string(),scope:fixture.native.scope().clone(),
                operation_id:Some("actual-mid-node-revoke".into()),expected_revision:Some("1".into()),
                timeout_ms:30_000,cancellation_ref:None,payload:json!({"owner":publication.owner,
                    "publicationId":publication.draft.publication_id,"version":1}).as_object().unwrap().clone()};
            let input_provider:Arc<dyn NativeOfficeAssets>=if revoke_during_generation {
                Arc::new(RevokeAfterSecondRead{assets,host,revoke,calls:AtomicUsize::new(0)})
            } else { assets };
            let package=kcoder_test_harness::workspace_root().expect("resolve current workspace").join("crates/kcoder_cli").join("../../apps/kcoder-office-components");
            let installed=NativeOfficeInstalledPaths::from_verified_generator(
                OfficeNodeGenerator::from_trusted_paths(std::path::Path::new(&node),&package)?);
            let composition=NativeOfficeComposition::initialize(&fixture.native,&fixture.engine,installed,
                NativeOfficeProviders {tasks:Some(Arc::new(NativeOfficeAcceptedTurnAuthority)),
                    assets:Some(input_provider),..Default::default()},"actual-d17-office-initialize")?;
            let task=OfficeTaskRef{thread_id:identity.thread_id.clone(),turn_id:identity.turn_id.clone(),run_id:None};
            let state_identity=fixture.engine.state.inspection_identity();
            let native_scope=fixture.native.scope().clone();
            let resolve:OfficeToolOwnerResolver=Arc::new(move |_|Ok(OfficeNativeToolOwner{
                scope:native_scope.clone(),task:task.clone(),state_identity:state_identity.clone(),
                native_call_id:"actual-office-document-call".into(),operation_id:"actual-office-document-operation".into()}));
            let registry=composition.tool_registry(&fixture.native,"actual-d17-source-revision".into(),resolve)?;
            let context=kcoder_tools::ToolContext::new(fixture.engine.state.clone()).with_tool_call_id("actual-office-document-call");
            let specification=json!({"schemaVersion":1,"kind":"docx","title":"Actual adopted source report",
                "paragraphs":[{"text":publication.pages[0].markdown}]});
            let result=registry.get("OfficeDocument").context("real OfficeDocument missing")?
                .call(json!({"specification":specification,"sourceRefs":[reference]}),&context).await;
            if revoke_during_generation {
                assert!(result.is_err(),"actual Node must not publish after its real source is revoked");
                assert!(composition.service().store.generation_publication("actual-office-document-operation")?.is_none());
            } else {
                let output=result?;
                let kcoder_types::ContentBlock::Text{text}= &output.content[0] else {anyhow::bail!("actual tool receipt missing")};
                let value:Value=serde_json::from_str(text)?;
                assert!(value.is_object());
                let manifest=composition.service().store.generation_publication("actual-office-document-operation")?
                    .context("real native generation publication missing")?;
                assert_eq!(manifest.format,OfficeFileFormat::Docx);
                assert!(manifest.bytes>1000);
                let reference=OfficeArtifactRef{id:manifest.id.clone(),revision:manifest.revision};
                let canonical=composition.service().store.read_canonical_source(&reference,None,0,64*1024,true)?;
                assert_eq!(canonical.source.context("actual canonical source missing")?.inputs,expected);
                let (bytes,total)=composition.service().store.read_artifact_chunk(&reference,0,512*1024)?;
                assert_eq!(bytes.len() as u64,total);
                assert!(bytes.starts_with(b"PK"));
                assert_eq!(manifest.sha256,format!("{:x}",Sha256::digest(&bytes)));
            }
            Ok::<_,anyhow::Error>(())
        }).await?;
    }
    Ok(())
}
