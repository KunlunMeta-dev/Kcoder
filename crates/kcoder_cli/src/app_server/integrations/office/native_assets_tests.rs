//! Real private OfficeStore, attachment ownership and current source tests.
use super::*;
use crate::app_server::attachments::{AttachmentDirectories, attachment_save};
use kcoder_app_protocol::AttachmentSaveParams;
use kcoder_state::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct Fixture {
    _temp: tempfile::TempDir,
    context: NativeIntegrationContext,
    engine: QueryEngine,
    store: OfficeStore,
    task: OfficeTaskRef,
    transfers: Arc<NativeOfficeTransfers>,
    services: kcoder_engine::WorkspaceRuntimeServices,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let parent = PrivateDirectory::open_existing(temp.path()).unwrap();
        parent.create_private_child(OsStr::new("profile")).unwrap();
        parent
            .create_private_child(OsStr::new("workspace"))
            .unwrap();
        let profile = temp.path().join("profile");
        let workspace = temp.path().join("workspace");
        let owner =
            Arc::new(kcoder_config::create_private_temp_dir("office-claim-owned-history").unwrap());
        let services =
            kcoder_engine::WorkspaceRuntimeServices::new(&workspace, "office-claim-owned")
                .with_private_client_storage(owner);
        let engine = Self::workspace_engine(&workspace, &profile, services.clone());
        engine.settings.write().unwrap().integrations.office.enabled = true;
        let context = NativeIntegrationContext::capture(
            &profile,
            &workspace,
            "office-claim-owned",
            "config-1",
        )
        .unwrap();
        let thread = engine.session_id();
        let task = OfficeTaskRef {
            thread_id: thread.clone(),
            turn_id: "claim-turn".into(),
            run_id: None,
        };
        TurnAttemptStore::open(&engine.session_storage_dir_for(&thread), &thread)
            .unwrap()
            .begin(TurnAttemptRecord {
                client_presentation: None,
                version: 1,
                identity: TurnAttemptIdentity {
                    thread_id: thread,
                    turn_id: task.turn_id.clone(),
                    attempt_id: "claim-attempt".into(),
                },
                parent_attempt_id: None,
                retry_operation_id: None,
                accepted_at_ms: 1,
                input_context_hash: "a".repeat(64),
                request_fingerprint: Some("b".repeat(64)),
                retained_input: None,
                status: TurnAttemptStatus::Accepted,
                completion: None,
            })
            .unwrap();
        let (_, store) = NativeDomainGuard::initialize(
            context.profile().unwrap(),
            context.scope(),
            NativeDomain::Office,
            "claim-init",
            |directory| {
                OfficeStore::create_in(
                    directory,
                    OsStr::new("data"),
                    IntegrationOwner::from(context.scope()),
                )
            },
        )
        .unwrap();
        Self {
            _temp: temp,
            context,
            engine,
            store,
            task,
            transfers: Arc::new(NativeOfficeTransfers::default()),
            services,
        }
    }
    fn workspace_engine(
        workspace: &Path,
        profile: &Path,
        services: kcoder_engine::WorkspaceRuntimeServices,
    ) -> QueryEngine {
        let settings = kcoder_config::Settings {
            training_mode: true,
            ..Default::default()
        };
        QueryEngine::try_new_for_client_with_services_and_plugin_snapshot(
            Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
                crate::tui_dev_mock::TuiDevScenario::FullTurn,
            )),
            kcoder_state::AppState::new(workspace),
            kcoder_tools::ToolRegistry::new(),
            kcoder_permissions::PermissionEngine::from_settings(&settings),
            settings,
            kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
            kcoder_skills::SkillRegistry::empty(),
            Arc::new(kcoder_tools::DenyAllUserQuestioner),
            workspace.to_path_buf(),
            Some(true),
            services,
            kcoder_plugins::EffectivePluginSnapshot::default(),
        )
        .unwrap()
        .with_settings_persistence_path(profile.join("settings.json"))
    }
    fn cold_workspace_engine(&self) -> QueryEngine {
        let engine = Self::workspace_engine(
            &self.engine.cwd,
            self.context.profile_path().unwrap(),
            self.services.clone(),
        );
        engine.settings.write().unwrap().integrations.office.enabled = true;
        assert_ne!(engine.session_id(), self.task.thread_id);
        engine
    }
    fn assets(&self, sources: Option<Arc<dyn NativeOfficeAssets>>) -> NativeOfficeFileAssets {
        NativeOfficeFileAssets::capture(
            &self.context,
            &self.engine,
            self.transfers.clone(),
            sources,
        )
        .unwrap()
    }
    fn request(&self, op: &str) -> IntegrationRequest {
        let mut request = self.assets(None).request(json!({}));
        request.operation_id = Some(op.into());
        request
    }
    fn publish(&self, bytes: &[u8], sources: Vec<OfficeResourceRef>) -> OfficeArtifactManifest {
        self.store
            .publish_artifact(
                "publish-owned",
                OfficeArtifactManifest {
                    schema_version: 1,
                    id: "owned-artifact".into(),
                    revision: 1,
                    owner: IntegrationOwner::from(self.context.scope()),
                    task: self.task.clone(),
                    kind: OfficeArtifactKind::Document,
                    title: "完整成果".into(),
                    format: OfficeFileFormat::Docx,
                    bytes: bytes.len() as u64,
                    sha256: hash(bytes),
                    source_refs: sources,
                    verification: OfficeVerification {
                        status: OfficeVerificationStatus::Partial,
                        completed_checks: vec!["content_hash".into()],
                        pending_checks: vec!["reader".into()],
                        reader_status: OfficeVerificationStatus::Pending,
                        formula_calculation: "not_applicable".into(),
                    },
                    dataset: None,
                    created_at_ms: 1,
                    presentation: None,
                },
                bytes,
            )
            .unwrap()
    }
    async fn export(
        &self,
        assets: &NativeOfficeFileAssets,
        manifest: &OfficeArtifactManifest,
        bytes: Vec<u8>,
    ) -> OfficeExportReceipt {
        serde_json::from_value(
            assets
                .prepare_export(
                    &self.context,
                    &self.request("export-owned"),
                    manifest,
                    bytes,
                    &CancellationToken::new(),
                )
                .await
                .unwrap(),
        )
        .unwrap()
    }
    fn chunk(
        &self,
        receipt: &OfficeExportReceipt,
        offset: u64,
        length: u32,
    ) -> AttachmentReadChunkParams {
        AttachmentReadChunkParams {
            thread_id: self.task.thread_id.clone(),
            path: NativeOfficeFileAssets::export_locator(receipt),
            offset,
            length,
        }
    }
}

#[tokio::test]
async fn native_asset_completion_records_only_the_original_frozen_automation_claim() -> Result<()> {
    use kcoder_state::integrations::knowledge::{ApprovedAutomationConsent, AutomationStore};
    use kcoder_types::integrations::knowledge::*;
    let f = Fixture::new();
    let bytes = b"Actual native P-ASSET acknowledgement fixture bytes".to_vec();
    let manifest = f.publish(&bytes, vec![]);
    let scope = f.context.scope();
    let (_, automation) = NativeDomainGuard::initialize(
        f.context.profile()?,
        scope,
        NativeDomain::Automation,
        "initialize-original-claim",
        |directory| AutomationStore::create_in(directory, OsStr::new("store"), scope),
    )?;
    let draft = AutomationSubscriptionDraft {
        id: "original-subscription".into(),
        title: "Controlled original run".into(),
        workflow_id: "original-workflow".into(),
        workflow_version: 1,
        model_selection: None,
        inputs: json!({}),
        schedule: Some(kcoder_types::CronSchedule::Every { every_seconds: 1 }),
        event_source: None,
        maximum_tokens: 100,
        period_budget: None,
        maximum_runtime_seconds: 30,
        delivery: AutomationDestination::Studio,
    };
    let consent =
        ApprovedAutomationConsent::from_explicit_user_action(scope, "original-consent", &draft)?;
    automation.save_subscription(
        "save-original-subscription",
        0,
        draft,
        &consent,
        Some(1000),
        1,
    )?;
    let run = automation.prepare_run(
        "original-subscription",
        1,
        "original-trigger",
        json!({}),
        Some(2000),
        1000,
    )?;
    // This test supplies the controlled acceptance record; the full registered
    // Core execution gate is independent and must not be inferred from it.
    automation.record_native_acceptance(&run.id, &f.task.thread_id, Some(&f.task.turn_id), 1000)?;
    let reference = IntegrationEntityRef {
        kind: IntegrationEntityKind::Artifact,
        id: manifest.id.clone(),
        revision: Some(manifest.revision.to_string()),
    };
    automation.record_artifact_manifests(&run.id, vec![reference.clone()])?;
    automation.record_native_status(
        &run.id,
        AutomationRunStatus::Completed,
        None,
        vec![manifest.id.clone()],
        1100,
    )?;
    let assets = f.assets(None);
    let receipt = f.export(&assets, &manifest, bytes).await;
    let params = kcoder_app_protocol::integrations::office::OfficeExportAcknowledgementParams {
        export_id: receipt.export_id.clone(),
        lease_revision: receipt.lease_revision.clone(),
        reference: receipt.reference.clone(),
        automation_run_id: Some(run.id.clone()),
        bytes: receipt.bytes,
        sha256: receipt.sha256.clone(),
    };
    assert!(
        assets
            .acknowledge_export(&f.context, &params, &CancellationToken::new())
            .await
            .is_err()
    );
    assert!(
        automation
            .read_artifact_claims(&run.id, None)?
            .items
            .is_empty()
    );
    assets
        .read_attachment(
            &f.context,
            &AttachmentReadParams {
                thread_id: f.task.thread_id.clone(),
                path: NativeOfficeFileAssets::export_locator(&receipt),
            },
            &CancellationToken::new(),
        )
        .await?;
    let observed = assets
        .acknowledge_export(&f.context, &params, &CancellationToken::new())
        .await?;
    let settings = kcoder_config::integrations::knowledge::KnowledgeIntegrationSettings {
        business_automation_enabled: true,
        ..Default::default()
    };
    let host =
        crate::app_server::integrations::knowledge::NativeKnowledgeHost::new(&f.context, settings)?;
    let request = f.request("explicit-original-client-ack");
    assert!(
        host.record_export_acknowledgement(&request, "foreign-run", &observed, now()?)
            .is_err()
    );
    let claim = host.record_export_acknowledgement(&request, &run.id, &observed, now()?)?;
    assert_eq!(claim.manifest_ref, reference);
    assert_eq!(claim.sha256, manifest.sha256);
    let again = host.record_export_acknowledgement(&request, &run.id, &observed, now()?)?;
    assert_eq!(again, claim);
    assert_eq!(
        automation.read_artifact_claims(&run.id, None)?.items,
        vec![claim]
    );
    Ok(())
}

#[tokio::test]
async fn explicit_export_acknowledgement_requires_original_complete_stream_and_current_owner() {
    let fixture = Fixture::new();
    let bytes = (0..600_017).map(|n| (n % 251) as u8).collect::<Vec<_>>();
    let manifest = fixture.publish(&bytes, vec![]);
    let assets = fixture.assets(None);
    let receipt = fixture.export(&assets, &manifest, bytes.clone()).await;
    let params = kcoder_app_protocol::integrations::office::OfficeExportAcknowledgementParams {
        export_id: receipt.export_id.clone(),
        lease_revision: receipt.lease_revision.clone(),
        reference: receipt.reference.clone(),
        automation_run_id: Some("original-run-locator-only".into()),
        bytes: receipt.bytes,
        sha256: receipt.sha256.clone(),
    };
    let cancel = CancellationToken::new();
    assert!(
        assets
            .acknowledge_export(&fixture.context, &params, &cancel)
            .await
            .is_err()
    );
    assets
        .read_attachment_chunk(
            &fixture.context,
            &fixture.chunk(&receipt, receipt.bytes - 1, 1),
            &cancel,
        )
        .await
        .unwrap();
    assert!(
        assets
            .acknowledge_export(&fixture.context, &params, &cancel)
            .await
            .is_err()
    );
    let mut offset = 0;
    while offset < receipt.bytes {
        let read = assets
            .read_attachment_chunk(
                &fixture.context,
                &fixture.chunk(&receipt, offset, 192 * 1024),
                &cancel,
            )
            .await
            .unwrap();
        offset += read.size;
    }
    let acknowledged = assets
        .acknowledge_export(&fixture.context, &params, &cancel)
        .await
        .unwrap();
    assert_eq!(acknowledged.bytes(), bytes.len() as u64);
    assert_eq!(acknowledged.sha256(), hash(&bytes));
    assert_eq!(acknowledged.export_id(), receipt.export_id);
    let repeated = assets
        .acknowledge_export(&fixture.context, &params, &cancel)
        .await
        .unwrap();
    assert_eq!(repeated.completed_at_ms(), acknowledged.completed_at_ms());
    let foreign = NativeOfficeFileAssets::capture(
        &fixture.context,
        &fixture.engine,
        Arc::new(NativeOfficeTransfers::default()),
        None,
    )
    .unwrap();
    assert!(
        foreign
            .acknowledge_export(&fixture.context, &params, &cancel)
            .await
            .is_err()
    );
    let mut forged = params.clone();
    forged.sha256 = "0".repeat(64);
    assert!(
        assets
            .acknowledge_export(&fixture.context, &forged, &cancel)
            .await
            .is_err()
    );
    let mut forged = params.clone();
    forged.lease_revision = "other-owner".into();
    assert!(
        assets
            .acknowledge_export(&fixture.context, &forged, &cancel)
            .await
            .is_err()
    );
    let stopped = CancellationToken::new();
    stopped.cancel();
    assert!(
        assets
            .acknowledge_export(&fixture.context, &params, &stopped)
            .await
            .is_err()
    );
    fixture
        .engine
        .settings
        .write()
        .unwrap()
        .integrations
        .office
        .enabled = false;
    assert!(
        assets
            .acknowledge_export(&fixture.context, &params, &cancel)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn existing_attachment_reader_receives_exact_complete_hash_without_private_path() {
    let fixture = Fixture::new();
    let bytes = (0..600_017).map(|n| (n % 251) as u8).collect::<Vec<_>>();
    let manifest = fixture.publish(&bytes, vec![]);
    let assets = fixture.assets(None);
    let receipt = fixture.export(&assets, &manifest, bytes.clone()).await;
    assert_eq!(
        fixture.export(&assets, &manifest, bytes.clone()).await,
        receipt
    );
    assert!(
        !serde_json::to_string(&receipt)
            .unwrap()
            .contains(fixture._temp.path().to_str().unwrap())
    );
    assert!(
        assets
            .read_attachment(
                &fixture.context,
                &AttachmentReadParams {
                    thread_id: fixture.task.thread_id.clone(),
                    path: NativeOfficeFileAssets::export_locator(&receipt)
                },
                &CancellationToken::new()
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("256 KiB")
    );
    let mut result = vec![];
    loop {
        let page = assets
            .read_attachment_chunk(
                &fixture.context,
                &fixture.chunk(&receipt, result.len() as u64, 192 * 1024),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(page.offset, result.len() as u64);
        assert_eq!(page.total_size, bytes.len() as u64);
        let decoded = STANDARD.decode(page.content_base64).unwrap();
        assert_eq!(decoded.len() as u64, page.size);
        result.extend(decoded);
        if page.eof {
            break;
        }
    }
    assert_eq!(result, bytes);
    assert_eq!(hash(&result), receipt.sha256);
    // A different connection cannot regain this ephemeral byte authority merely
    // by supplying the same valid owner and immutable artifact reference.
    let reopened = NativeOfficeFileAssets::capture(
        &fixture.context,
        &fixture.engine,
        Arc::new(NativeOfficeTransfers::default()),
        None,
    )
    .unwrap();
    assert!(
        reopened
            .read_attachment_chunk(
                &fixture.context,
                &fixture.chunk(&receipt, 0, 32),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn owner_thread_revision_cancellation_and_current_settings_are_enforced() {
    let fixture = Fixture::new();
    let bytes = b"actual private artifact bytes";
    let manifest = fixture.publish(bytes, vec![]);
    let assets = fixture.assets(None);
    let receipt = fixture.export(&assets, &manifest, bytes.to_vec()).await;
    let mut params = fixture.chunk(&receipt, 0, 12);
    params.thread_id = "unrelated-thread".into();
    assert!(
        assets
            .read_attachment_chunk(&fixture.context, &params, &CancellationToken::new())
            .await
            .is_err()
    );
    params = fixture.chunk(&receipt, 0, 12);
    params.path.push('x');
    assert!(
        assets
            .read_attachment_chunk(&fixture.context, &params, &CancellationToken::new())
            .await
            .is_err()
    );
    let canceled = CancellationToken::new();
    canceled.cancel();
    assert!(
        assets
            .read_attachment_chunk(&fixture.context, &fixture.chunk(&receipt, 0, 12), &canceled)
            .await
            .is_err()
    );
    fixture
        .engine
        .settings
        .write()
        .unwrap()
        .integrations
        .office
        .enabled = false;
    assert!(
        assets
            .read_attachment_chunk(
                &fixture.context,
                &fixture.chunk(&receipt, 0, 12),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    fixture
        .engine
        .settings
        .write()
        .unwrap()
        .integrations
        .office
        .enabled = true;
    let other = Fixture::new();
    assert!(
        assets
            .read_attachment_chunk(
                &other.context,
                &fixture.chunk(&receipt, 0, 12),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    let mut wrong = manifest.clone();
    wrong.revision = 2;
    assert!(
        assets
            .prepare_export(
                &fixture.context,
                &fixture.request("wrong-revision"),
                &wrong,
                bytes.to_vec(),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert!(
        assets
            .prepare_export(
                &fixture.context,
                &fixture.request("wrong-bytes"),
                &manifest,
                b"tampered".to_vec(),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
}

struct SourceAuthority {
    allowed: AtomicBool,
    calls: AtomicUsize,
    revoke_on_call: usize,
}
#[async_trait]
impl NativeOfficeAssets for SourceAuthority {
    async fn validate_sources(
        &self,
        _: &NativeIntegrationContext,
        _: &IntegrationRequest,
        sources: &[OfficeResourceRef],
        _: &CancellationToken,
    ) -> Result<Vec<OfficeCanonicalInputIdentity>> {
        let count = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        ensure!(
            self.allowed.load(Ordering::SeqCst) && count != self.revoke_on_call,
            "OFFICE_ACCESS_DENIED"
        );
        Ok(sources
            .iter()
            .map(|reference| OfficeCanonicalInputIdentity {
                reference: reference.clone(),
                sha256: "a".repeat(64),
            })
            .collect())
    }
}
#[tokio::test]
async fn source_revocation_before_or_during_range_yields_zero_returned_bytes_and_no_fallback() {
    let fixture = Fixture::new();
    let bytes = b"content bound to an explicitly routed source";
    let source = OfficeResourceRef {
        kind: "publication".into(),
        id: "fixed-publication".into(),
        revision: "1".into(),
    };
    let manifest = fixture.publish(bytes, vec![source]);
    let policy = Arc::new(SourceAuthority {
        allowed: AtomicBool::new(true),
        calls: AtomicUsize::new(0),
        revoke_on_call: usize::MAX,
    });
    let assets = fixture.assets(Some(policy.clone()));
    let receipt = fixture.export(&assets, &manifest, bytes.to_vec()).await;
    policy.allowed.store(false, Ordering::SeqCst);
    assert!(
        assets
            .read_attachment_chunk(
                &fixture.context,
                &fixture.chunk(&receipt, 0, 12),
                &CancellationToken::new()
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("OFFICE_ACCESS_DENIED")
    );
    let no_provider = fixture.assets(None);
    assert!(
        no_provider
            .read_attachment_chunk(
                &fixture.context,
                &fixture.chunk(&receipt, 0, 12),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    // The second authorization is after the real store range read. Revoking
    // there must discard the bytes rather than returning a successful page.
    let during = fixture.assets(Some(Arc::new(SourceAuthority {
        allowed: AtomicBool::new(true),
        calls: AtomicUsize::new(0),
        revoke_on_call: 2,
    })));
    assert!(
        during
            .read_attachment_chunk(
                &fixture.context,
                &fixture.chunk(&receipt, 0, 12),
                &CancellationToken::new()
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("OFFICE_ACCESS_DENIED")
    );
    assert_eq!(policy.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn only_actual_owned_attachment_receipt_can_be_accepted_and_replayed_locally() {
    let fixture = Fixture::new();
    let assets = fixture.assets(None);
    let bytes = b"owned original material";
    let mut staged = AttachmentDirectories::default();
    let saved = attachment_save(
        &fixture.task.thread_id,
        &AttachmentSaveParams {
            retention: None,
            filename: "material.txt".into(),
            content_base64: STANDARD.encode(bytes),
        },
        &mut staged,
    )
    .unwrap();
    let metadata = OfficeInputMetadata {
        filename: "material.txt".into(),
        media_type: "text/plain".into(),
        expected_bytes: bytes.len() as u64,
        expected_sha256: hash(bytes),
    };
    assert!(
        assets
            .accept_staged_input(
                &fixture.context,
                &AttachmentDirectories::default(),
                &saved,
                "native-input",
                metadata.clone(),
                &CancellationToken::new()
            )
            .is_err()
    );
    let receipt = assets
        .accept_staged_input(
            &fixture.context,
            &staged,
            &saved,
            "native-input",
            metadata.clone(),
            &CancellationToken::new(),
        )
        .unwrap();
    assert_eq!(
        assets
            .accept_staged_input(
                &fixture.context,
                &staged,
                &saved,
                "native-input",
                metadata.clone(),
                &CancellationToken::new()
            )
            .unwrap(),
        receipt
    );
    let reference = OfficeArtifactRef {
        id: receipt.input_id.clone(),
        revision: 1,
    };
    assert_eq!(
        assets
            .input_bytes(&reference, &CancellationToken::new())
            .unwrap()
            .1,
        bytes
    );
    let resource = OfficeResourceRef {
        kind: "input".into(),
        id: receipt.input_id,
        revision: "1".into(),
    };
    let result = assets
        .validate_sources(
            &fixture.context,
            &fixture.request("read-material"),
            &[resource],
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result[0].sha256, hash(bytes));
    let reopened = NativeOfficeFileAssets::capture(
        &fixture.context,
        &fixture.engine,
        Arc::new(NativeOfficeTransfers::default()),
        None,
    )
    .unwrap();
    assert!(
        reopened
            .accept_staged_input(
                &fixture.context,
                &staged,
                &saved,
                "native-input",
                metadata,
                &CancellationToken::new()
            )
            .unwrap_err()
            .to_string()
            .contains("RECONCILIATION")
    );
    std::fs::write(&saved.path, b"changed original bytes!").unwrap();
    assert!(
        assets
            .input_bytes(&reference, &CancellationToken::new())
            .is_err()
    );
}

#[tokio::test]
async fn management_history_uses_real_original_ledger_without_activating_or_renaming_session() {
    let fixture = Fixture::new();
    let bytes = b"completed original artifact";
    let manifest = fixture.publish(bytes, vec![]);
    let old_assets = fixture.assets(None);
    let old_receipt = fixture.export(&old_assets, &manifest, bytes.to_vec()).await;
    let bootstrap = fixture.cold_workspace_engine();
    let initial_id = bootstrap.session_id();
    let initial_messages = bootstrap.state.messages();
    let bootstrap_directory = bootstrap.session_storage_dir_for(&initial_id);
    assert!(!bootstrap_directory.exists());
    let transfers = Arc::new(NativeOfficeTransfers::default());
    let management = NativeOfficeFileAssets::capture_management(
        &fixture.context,
        &bootstrap,
        transfers.clone(),
        None,
    )
    .unwrap();
    assert!(
        management
            .read_attachment_chunk(
                &fixture.context,
                &fixture.chunk(&old_receipt, 0, 32),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    let receipt: OfficeExportReceipt = serde_json::from_value(
        management
            .prepare_export(
                &fixture.context,
                &fixture.request("cold-new-export-operation"),
                &manifest,
                bytes.to_vec(),
                &CancellationToken::new(),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_ne!(old_receipt.export_id, receipt.export_id);
    let chunk = management
        .read_attachment_chunk(
            &fixture.context,
            &fixture.chunk(&receipt, 0, 128),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(STANDARD.decode(chunk.content_base64).unwrap(), bytes);
    assert!(chunk.eof);
    assert_eq!(bootstrap.session_id(), initial_id);
    assert_eq!(bootstrap.state.messages(), initial_messages);
    assert!(!bootstrap_directory.exists());
    let safe_debug = format!("{transfers:?}");
    assert!(safe_debug.contains("exports: Some(1)"));
    assert!(!safe_debug.contains(&transfers.connection_id));
    assert!(!safe_debug.contains(&receipt.export_id));
    assert!(!safe_debug.contains(fixture._temp.path().to_str().unwrap()));
}

#[tokio::test]
async fn historical_read_requires_real_known_receipt_and_rejects_replaced_history_directory() {
    let fixture = Fixture::new();
    let bytes = b"original file and accepted witness";
    let manifest = fixture.publish(bytes, vec![]);
    let bootstrap = fixture.cold_workspace_engine();
    let management = NativeOfficeFileAssets::capture_management(
        &fixture.context,
        &bootstrap,
        Arc::new(NativeOfficeTransfers::default()),
        None,
    )
    .unwrap();
    let receipt: OfficeExportReceipt = serde_json::from_value(
        management
            .prepare_export(
                &fixture.context,
                &fixture.request("before-replace"),
                &manifest,
                bytes.to_vec(),
                &CancellationToken::new(),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    let mut invented = manifest.clone();
    invented.id = "stored-but-no-actual-task".into();
    invented.task.turn_id = "guessed-turn".into();
    fixture
        .store
        .publish_artifact("inject-unproven-test-manifest", invented.clone(), bytes)
        .unwrap();
    assert!(
        management
            .prepare_export(
                &fixture.context,
                &fixture.request("unproven-export"),
                &invented,
                bytes.to_vec(),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    let session_path = fixture
        .engine
        .session_storage_dir_for(&fixture.task.thread_id);
    let original = session_path.join("turn-attempts");
    let moved = session_path.join("old-turn-attempts");
    std::fs::rename(&original, &moved).unwrap();
    let parent = PrivateDirectory::open_existing(&session_path).unwrap();
    let replacement = parent
        .create_private_child(OsStr::new("turn-attempts"))
        .unwrap();
    let old = PrivateDirectory::open_existing(&moved).unwrap();
    for (name, mut file) in old.open_regular_files(|_| true).unwrap() {
        let mut bytes = vec![];
        file.read_to_end(&mut bytes).unwrap();
        replacement.atomic_replace(&name, &bytes).unwrap();
    }
    assert!(
        management
            .read_attachment_chunk(
                &fixture.context,
                &fixture.chunk(&receipt, 0, 128),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
}

#[tokio::test]
#[ignore = "Explicit native Node; actual local host gate, not a live model/platform test"]
async fn actual_generated_docx_is_downloadable_by_existing_attachment_contract_with_canonical_source()
 {
    use super::super::native_host::{
        NativeOfficeComposition, NativeOfficeInstalledPaths, NativeOfficeProviders,
    };
    let node = std::env::var_os("KCODER_OFFICE_COMPONENT_TEST_NODE").expect("explicit actual Node");
    let fixture = Fixture::new();
    let assets = Arc::new(fixture.assets(None));
    let installed = NativeOfficeInstalledPaths::from_native_installation(
        Path::new(&node),
        &kcoder_test_harness::workspace_root()
            .expect("resolve current workspace")
            .join("crates/kcoder_cli")
            .join("../../apps/kcoder-office-components"),
    )
    .unwrap();
    let composition = NativeOfficeComposition::observe(
        &fixture.context,
        &fixture.engine,
        installed.clone(),
        NativeOfficeProviders {
            tasks: Some(Arc::new(NativeOfficeAcceptedTurnAuthority)),
            assets: Some(assets.clone()),
            ports: None,
        },
    )
    .unwrap()
    .unwrap();
    let mut generate = fixture.request("actual-docx");
    generate.payload = json!({"task":fixture.task,"sourceRefs":[],"specification":{"schemaVersion":1,"kind":"docx","title":"真实可领取成果","paragraphs":[{"text":"完整文件由原生受控附件通道交付。"}]}}).as_object().unwrap().clone();
    let reply = composition
        .dispatch(
            &fixture.context,
            "integrations/office/generate",
            &generate,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(reply.status, IntegrationStatus::Completed, "{reply:?}");
    let manifest: OfficeArtifactManifest =
        serde_json::from_value(reply.result.as_ref().unwrap()["manifest"].clone()).unwrap();
    // A completed original turn is valid provenance for a later user download;
    // it is not an authorization to execute another model/tool turn.
    TurnAttemptStore::open_existing(
        &fixture
            .engine
            .session_storage_dir_for(&fixture.task.thread_id),
        &fixture.task.thread_id,
    )
    .unwrap()
    .unwrap()
    .finish(
        &TurnAttemptIdentity {
            thread_id: fixture.task.thread_id.clone(),
            turn_id: fixture.task.turn_id.clone(),
            attempt_id: "claim-attempt".into(),
        },
        kcoder_state::turn_attempt_store::TurnAttemptCompletion {
            status: TurnAttemptStatus::Completed,
            finished_at_ms: 2,
            error: None,
            provider_failure: None,
            partial_output: String::new(),
            partial_output_truncated: false,
            committed_history_uuid: None,
        },
    )
    .unwrap();
    let mut export = fixture.request("actual-docx-export");
    export.payload =
        json!({"reference":{"id":manifest.id,"revision":manifest.revision},"format":"docx"})
            .as_object()
            .unwrap()
            .clone();
    let reply = composition
        .dispatch(
            &fixture.context,
            "integrations/artifact/export",
            &export,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(reply.status, IntegrationStatus::Completed, "{reply:?}");
    let receipt: OfficeExportReceipt =
        serde_json::from_value(reply.result.as_ref().unwrap()["export"].clone()).unwrap();
    let mut result = vec![];
    loop {
        let page = assets
            .read_attachment_chunk(
                &fixture.context,
                &fixture.chunk(&receipt, result.len() as u64, 1024),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        result.extend(STANDARD.decode(page.content_base64).unwrap());
        if page.eof {
            break;
        }
    }
    assert!(result.starts_with(b"PK"));
    assert_eq!(result.len() as u64, receipt.bytes);
    assert_eq!(hash(&result), manifest.sha256);
    let source = fixture
        .store
        .read_canonical_source(&receipt.reference, None, 0, 1, true)
        .unwrap();
    assert_eq!(
        source.availability,
        OfficeCanonicalSourceAvailability::Available
    );
    assert_eq!(source.source.unwrap().output_sha256, receipt.sha256);

    // Simulate a fresh connection with only a new native workspace/bootstrap
    // Engine. No thread/start, thread/resume or State ID replacement occurs.
    let bootstrap = fixture.cold_workspace_engine();
    let initial_id = bootstrap.session_id();
    let initial_messages = bootstrap.state.messages();
    let directory = bootstrap.session_storage_dir_for(&initial_id);
    assert!(!directory.exists());
    let cold_assets = Arc::new(
        NativeOfficeFileAssets::capture_management(
            &fixture.context,
            &bootstrap,
            Arc::new(NativeOfficeTransfers::default()),
            None,
        )
        .unwrap(),
    );
    let cold = NativeOfficeComposition::observe(
        &fixture.context,
        &bootstrap,
        installed,
        NativeOfficeProviders {
            tasks: Some(Arc::new(NativeOfficeAcceptedTurnAuthority)),
            assets: Some(cold_assets.clone()),
            ports: None,
        },
    )
    .unwrap()
    .unwrap();
    // The completed original export operation returns its original receipt. It
    // cannot mint a new lease on another connection or replay an unknown write.
    let old_reply = cold
        .dispatch(
            &fixture.context,
            "integrations/artifact/export",
            &export,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(old_reply.status, IntegrationStatus::Completed);
    let old: OfficeExportReceipt =
        serde_json::from_value(old_reply.result.as_ref().unwrap()["export"].clone()).unwrap();
    assert_eq!(old.export_id, receipt.export_id);
    assert!(
        cold_assets
            .read_attachment_chunk(
                &fixture.context,
                &fixture.chunk(&old, 0, 1024),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    export.request_id = format!("cold-request-{}", uuid::Uuid::new_v4());
    export.operation_id = Some("actual-docx-export-fresh-connection".into());
    let new_reply = cold
        .dispatch(
            &fixture.context,
            "integrations/artifact/export",
            &export,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        new_reply.status,
        IntegrationStatus::Completed,
        "{new_reply:?}"
    );
    let renewed: OfficeExportReceipt =
        serde_json::from_value(new_reply.result.as_ref().unwrap()["export"].clone()).unwrap();
    assert_ne!(renewed.export_id, receipt.export_id);
    let mut claimed = vec![];
    loop {
        let page = cold_assets
            .read_attachment_chunk(
                &fixture.context,
                &fixture.chunk(&renewed, claimed.len() as u64, 1024),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        claimed.extend(STANDARD.decode(page.content_base64).unwrap());
        if page.eof {
            break;
        }
    }
    assert_eq!(claimed, result);
    assert_eq!(hash(&claimed), renewed.sha256);
    assert_eq!(bootstrap.session_id(), initial_id);
    assert_eq!(bootstrap.state.messages(), initial_messages);
    assert!(!directory.exists());
}

struct InputHarness {
    _temp: tempfile::TempDir,
    native: NativeIntegrationContext,
    engine: QueryEngine,
}
impl InputHarness {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let parent = PrivateDirectory::open_existing(temp.path()).unwrap();
        parent.create_private_child(OsStr::new("profile")).unwrap();
        parent
            .create_private_child(OsStr::new("workspace"))
            .unwrap();
        let profile = temp.path().join("profile");
        let workspace = temp.path().join("workspace");
        let owner = Arc::new(kcoder_config::create_private_temp_dir("office-input-only").unwrap());
        let services =
            kcoder_engine::WorkspaceRuntimeServices::new(&workspace, "office-input-only")
                .with_private_client_storage(owner);
        let engine = Fixture::workspace_engine(&workspace, &profile, services);
        engine.settings.write().unwrap().integrations.office.enabled = true;
        let native =
            NativeIntegrationContext::capture(&profile, &workspace, "actual-upload", "config-r1")
                .unwrap();
        Self {
            _temp: temp,
            native,
            engine,
        }
    }
    fn assets(&self) -> NativeOfficeFileAssets {
        NativeOfficeFileAssets::capture(
            &self.native,
            &self.engine,
            Arc::new(NativeOfficeTransfers::default()),
            None,
        )
        .unwrap()
    }
    fn office_exists(&self) -> bool {
        NativeDomainGuard::observe(
            self.native.profile().unwrap(),
            self.native.scope(),
            NativeDomain::Office,
        )
        .unwrap()
        .is_some()
    }
    fn request(
        &self,
        assets: &NativeOfficeFileAssets,
        operation: &str,
        bytes: &[u8],
    ) -> IntegrationRequest {
        let mut request = assets.request(json!({"filename":"material.txt","mediaType":"text/plain","expectedBytes":bytes.len(),"expectedSha256":hash(bytes)}));
        request.operation_id = Some(operation.into());
        request
    }
    fn finish(&self, staged: &mut AttachmentDirectories, bytes: &[u8]) -> AttachmentSaveResult {
        use crate::app_server::attachments::{
            attachment_upload_chunk, attachment_upload_finish, attachment_upload_start,
        };
        let start = attachment_upload_start(
            &self.engine.session_id(),
            &serde_json::from_value(json!({"filename":"material.txt","size":bytes.len()})).unwrap(),
            staged,
        )
        .unwrap();
        for (index, chunk) in bytes.chunks(512 * 1024).enumerate() {
            attachment_upload_chunk(&serde_json::from_value(json!({"upload_id":start.upload_id,"index":index,"content_base64":STANDARD.encode(chunk)})).unwrap(), staged).unwrap();
        }
        attachment_upload_finish(
            &serde_json::from_value(json!({"upload_id":start.upload_id})).unwrap(),
            staged,
        )
        .unwrap()
    }
}

#[tokio::test]
async fn actual_upload_finish_accepts_durable_material_without_creating_a_thread() {
    let fixture = InputHarness::new();
    let assets = fixture.assets();
    let initial_id = fixture.engine.session_id();
    let session_path = fixture.engine.session_storage_dir_for(&initial_id);
    assert!(!session_path.exists());
    assert!(!fixture.office_exists());
    let bytes = (0..1_100_017)
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    let mut staged = AttachmentDirectories::default();
    let actual = fixture.finish(&mut staged, &bytes);
    let request = fixture.request(&assets, "actual-material-finish", &bytes);
    let prepared = assets
        .prepare_finished_input(
            &fixture.native,
            &staged,
            &actual,
            &request,
            &CancellationToken::new(),
        )
        .unwrap();
    assert!(
        !fixture.office_exists(),
        "Capturing a true finished upload must not initialize Office state"
    );
    let receipt = assets
        .commit_finished_input(&fixture.native, prepared, &CancellationToken::new())
        .unwrap();
    receipt.validate().unwrap();
    assert_eq!(receipt.sha256, hash(&bytes));
    assert_eq!(receipt.bytes, bytes.len() as u64);
    let public = serde_json::to_value(&receipt).unwrap();
    assert_eq!(public["kind"], "office_input");
    assert_eq!(public.as_object().unwrap().len(), 10);
    assert!(
        public.get("path").is_none()
            && public.get("native").is_none()
            && public.get("stageRef").is_none()
    );
    assert!(
        !serde_json::to_string(&receipt)
            .unwrap()
            .contains(&actual.path)
    );
    assert_eq!(fixture.engine.session_id(), initial_id);
    assert!(!session_path.exists());
    // Closing the original native staged owner removes the temporary file. A
    // different connection must still resolve the actual owner-bound blob.
    drop(staged);
    assert!(!Path::new(&actual.path).exists());
    let reopened = fixture.assets();
    let reference = OfficeArtifactRef {
        id: receipt.input_id.clone(),
        revision: 1,
    };
    let (stored, actual_bytes) = reopened
        .input_bytes(&reference, &CancellationToken::new())
        .unwrap();
    assert_eq!(actual_bytes, bytes);
    assert_eq!(stored.sha256.as_deref(), Some(receipt.sha256.as_str()));
    let source = OfficeResourceRef {
        kind: "input".into(),
        id: reference.id,
        revision: "1".into(),
    };
    let identities = reopened
        .validate_sources(
            &fixture.native,
            &request,
            &[source],
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(identities[0].sha256, receipt.sha256);
}

#[tokio::test]
async fn input_finish_rejects_fabricated_receipt_extra_keys_changed_owner_and_precommit_cancel() {
    let fixture = InputHarness::new();
    let assets = fixture.assets();
    let bytes = b"actual original selected file";
    let mut staged = AttachmentDirectories::default();
    let actual = fixture.finish(&mut staged, bytes);
    let mut request = fixture.request(&assets, "input-negative", bytes);
    assert!(
        assets
            .prepare_finished_input(
                &fixture.native,
                &AttachmentDirectories::default(),
                &actual,
                &request,
                &CancellationToken::new()
            )
            .is_err()
    );
    request.payload.insert("path".into(), json!(actual.path));
    assert!(
        assets
            .prepare_finished_input(
                &fixture.native,
                &staged,
                &actual,
                &request,
                &CancellationToken::new()
            )
            .is_err()
    );
    request.payload.remove("path");
    let prepared = assets
        .prepare_finished_input(
            &fixture.native,
            &staged,
            &actual,
            &request,
            &CancellationToken::new(),
        )
        .unwrap();
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(
        assets
            .commit_finished_input(&fixture.native, prepared, &cancelled)
            .is_err()
    );
    assert!(!fixture.office_exists());
    let other = InputHarness::new();
    let prepared = assets
        .prepare_finished_input(
            &fixture.native,
            &staged,
            &actual,
            &request,
            &CancellationToken::new(),
        )
        .unwrap();
    assert!(
        other
            .assets()
            .commit_finished_input(&other.native, prepared, &CancellationToken::new())
            .is_err()
    );
    assert!(!other.office_exists() && !fixture.office_exists());
}

#[tokio::test]
async fn input_size_hash_and_existing_unknown_operation_fail_without_replaying() {
    let fixture = InputHarness::new();
    let assets = fixture.assets();
    let bytes = b"hash controlled actual data";
    let mut staged = AttachmentDirectories::default();
    let actual = fixture.finish(&mut staged, bytes);
    let mut request = fixture.request(&assets, "wrong-hash", bytes);
    request
        .payload
        .insert("expectedSha256".into(), json!("f".repeat(64)));
    let prepared = assets
        .prepare_finished_input(
            &fixture.native,
            &staged,
            &actual,
            &request,
            &CancellationToken::new(),
        )
        .unwrap();
    assert!(
        assets
            .commit_finished_input(&fixture.native, prepared, &CancellationToken::new())
            .unwrap_err()
            .to_string()
            .contains("HASH_MISMATCH")
    );
    assert!(!fixture.office_exists());
    request = fixture.request(&assets, "oversize", bytes);
    request
        .payload
        .insert("expectedBytes".into(), json!(100 * 1024 * 1024 + 1));
    assert!(
        assets
            .prepare_finished_input(
                &fixture.native,
                &staged,
                &actual,
                &request,
                &CancellationToken::new()
            )
            .is_err()
    );
    assert!(!fixture.office_exists());
    let good = fixture.request(&assets, "first-known", bytes);
    let prepared = assets
        .prepare_finished_input(
            &fixture.native,
            &staged,
            &actual,
            &good,
            &CancellationToken::new(),
        )
        .unwrap();
    assets
        .commit_finished_input(&fixture.native, prepared, &CancellationToken::new())
        .unwrap();
    let pending = fixture.request(&assets, "unknown-original", bytes);
    let id = format!(
        "input-{}",
        hash(&serde_json::to_vec(&(fixture.native.scope(), "unknown-original")).unwrap())
    );
    let store = assets.store().unwrap();
    store
        .begin_input(
            "unknown-original",
            &id,
            serde_json::from_value(Value::Object(pending.payload.clone())).unwrap(),
        )
        .unwrap();
    let prepared = assets
        .prepare_finished_input(
            &fixture.native,
            &staged,
            &actual,
            &pending,
            &CancellationToken::new(),
        )
        .unwrap();
    assert!(
        assets
            .commit_finished_input(&fixture.native, prepared, &CancellationToken::new())
            .unwrap_err()
            .to_string()
            .contains("RECONCILIATION_REQUIRED")
    );
    let original = store.read_input(&id).unwrap().unwrap();
    assert_eq!(original.receipt.status, "pending");
    assert!(original.stored_content.is_none());
    assert!(Path::new(&actual.path).exists());
}

#[tokio::test]
async fn cancelled_chunk_upload_never_reaches_office_and_zero_byte_file_is_real() {
    use crate::app_server::attachments::{
        attachment_upload_cancel, attachment_upload_chunk, attachment_upload_finish,
        attachment_upload_start,
    };
    let fixture = InputHarness::new();
    let mut staged = AttachmentDirectories::default();
    assert!(
        attachment_upload_start(
            &fixture.engine.session_id(),
            &serde_json::from_value(json!({"filename":"material.txt","size":100*1024*1024+1}))
                .unwrap(),
            &mut staged
        )
        .is_err()
    );
    let start = attachment_upload_start(
        &fixture.engine.session_id(),
        &serde_json::from_value(json!({"filename":"material.txt","size":10*1024*1024})).unwrap(),
        &mut staged,
    )
    .unwrap();
    attachment_upload_chunk(&serde_json::from_value(json!({"upload_id":start.upload_id,"index":0,"content_base64":STANDARD.encode(vec![1;512*1024])})).unwrap(), &mut staged).unwrap();
    attachment_upload_cancel(&start.upload_id, &mut staged).unwrap();
    assert!(
        attachment_upload_finish(
            &serde_json::from_value(json!({"upload_id":start.upload_id})).unwrap(),
            &mut staged
        )
        .is_err()
    );
    assert!(!fixture.office_exists());
    let assets = fixture.assets();
    let actual = fixture.finish(&mut staged, b"");
    let request = fixture.request(&assets, "real-empty", b"");
    let prepared = assets
        .prepare_finished_input(
            &fixture.native,
            &staged,
            &actual,
            &request,
            &CancellationToken::new(),
        )
        .unwrap();
    let receipt = assets
        .commit_finished_input(&fixture.native, prepared, &CancellationToken::new())
        .unwrap();
    drop(staged);
    let (_, bytes) = fixture
        .assets()
        .input_bytes(
            &OfficeArtifactRef {
                id: receipt.input_id,
                revision: 1,
            },
            &CancellationToken::new(),
        )
        .unwrap();
    assert!(bytes.is_empty());
    assert_eq!(receipt.sha256, hash(b""));
}

#[tokio::test]
async fn canonical_result_export_observation_uses_same_real_lease_and_denies_peer_scope_and_expiry()
{
    let fixture = Fixture::new();
    let bytes = b"original canonical result";
    let manifest = fixture.publish(bytes, vec![]);
    let original = fixture.assets(None);
    let receipt = fixture.export(&original, &manifest, bytes.to_vec()).await;
    let management = NativeOfficeFileAssets::capture_management(
        &fixture.context,
        &fixture.engine,
        fixture.transfers.clone(),
        None,
    )
    .unwrap();
    assert_eq!(
        management
            .current_result_export(&fixture.context, &manifest, &CancellationToken::new())
            .unwrap(),
        Some(receipt.clone())
    );
    let peer = Fixture::new();
    assert!(
        management
            .current_result_export(&peer.context, &manifest, &CancellationToken::new())
            .is_err()
    );
    let foreign = OfficeArtifactRef {
        id: "peer-artifact".into(),
        revision: 1,
    };
    assert!(
        management
            .read_result_manifest(
                &fixture.context,
                &foreign,
                &fixture.task,
                &CancellationToken::new()
            )
            .is_err()
    );
    fixture
        .transfers
        .exports
        .lock()
        .unwrap()
        .get_mut(&receipt.export_id)
        .unwrap()
        .receipt
        .expires_at_ms = 0;
    assert!(
        management
            .current_result_export(&fixture.context, &manifest, &CancellationToken::new())
            .is_err()
    );
    fixture.transfers.exports.lock().unwrap().clear();
    assert!(
        management
            .current_result_export(&fixture.context, &manifest, &CancellationToken::new())
            .is_err(),
        "Pruning an expired lease must not renew or adopt its receipt"
    );
    assert!(fixture.transfers.exports.lock().unwrap().is_empty());
}

#[tokio::test]
async fn ordinary_export_ack_receipt_is_durable_and_never_revives_original_lease() -> Result<()> {
    let f = Fixture::new();
    let bytes = b"Actual ordinary native byte-receipt boundary";
    let source = OfficeResourceRef {
        kind: "publication".into(),
        id: "original-source".into(),
        revision: "1".into(),
    };
    let manifest = f.publish(bytes, vec![source]);
    let policy = Arc::new(SourceAuthority {
        allowed: AtomicBool::new(true),
        calls: AtomicUsize::new(0),
        revoke_on_call: usize::MAX,
    });
    let assets = f.assets(Some(policy.clone()));
    let export = f.export(&assets, &manifest, bytes.to_vec()).await;
    let params = kcoder_app_protocol::integrations::office::OfficeExportAcknowledgementParams {
        export_id: export.export_id.clone(),
        lease_revision: export.lease_revision.clone(),
        reference: export.reference.clone(),
        automation_run_id: None,
        bytes: export.bytes,
        sha256: export.sha256.clone(),
    };
    let request = f.request("ordinary-original-ack");
    let cancel = CancellationToken::new();
    assert!(
        assets
            .acknowledge_export_receipt(&f.context, &request, &params, &cancel)
            .await
            .is_err()
    );
    assert!(
        f.store.read_operation("ordinary-original-ack")?.is_none(),
        "unread bytes cannot persist an ACK"
    );
    assets
        .read_attachment_chunk(&f.context, &f.chunk(&export, 0, 512), &cancel)
        .await?;
    let acknowledged = assets
        .acknowledge_export_receipt(&f.context, &request, &params, &cancel)
        .await?;
    assert_eq!(acknowledged.task, manifest.task);
    assert_eq!(acknowledged.source_identities.len(), 1);
    assert_eq!(
        assets
            .acknowledge_export_receipt(&f.context, &request, &params, &cancel)
            .await?,
        acknowledged
    );
    for field in ["bytes", "hash", "artifact"] {
        let mut altered = params.clone();
        match field {
            "bytes" => altered.bytes += 1,
            "hash" => altered.sha256 = "b".repeat(64),
            _ => altered.reference.id = "another-artifact".into(),
        }
        assert!(
            assets
                .acknowledge_export_receipt(&f.context, &request, &altered, &cancel)
                .await
                .is_err()
        );
    }
    let foreign = Fixture::new();
    assert!(
        assets
            .read_export_acknowledgement_operation(
                &foreign.context,
                "ordinary-original-ack",
                &cancel
            )
            .await
            .is_err()
    );
    let bootstrap = f.cold_workspace_engine();
    let fresh = NativeOfficeFileAssets::capture_management(
        &f.context,
        &bootstrap,
        Arc::new(NativeOfficeTransfers::default()),
        Some(policy.clone()),
    )?;
    assert!(
        fresh
            .read_attachment_chunk(&f.context, &f.chunk(&export, 0, 1), &cancel)
            .await
            .is_err()
    );
    assert_eq!(
        fresh
            .read_export_acknowledgement_operation(&f.context, "ordinary-original-ack", &cancel)
            .await?,
        Some(acknowledged.clone())
    );
    // A known exact ACK replays as readback; it neither adopts nor extends the old export lease.
    assert_eq!(
        fresh
            .acknowledge_export_receipt(&f.context, &request, &params, &cancel)
            .await?,
        acknowledged
    );
    assert!(
        fresh
            .read_attachment_chunk(&f.context, &f.chunk(&export, 0, 1), &cancel)
            .await
            .is_err()
    );
    policy.allowed.store(false, Ordering::SeqCst);
    assert!(
        fresh
            .read_export_acknowledgement_operation(&f.context, "ordinary-original-ack", &cancel)
            .await
            .is_err()
    );
    assert!(
        f.store.read_operation("ordinary-original-ack")?.is_some(),
        "revocation cannot erase history"
    );
    // Non-ACK operations retain their original readback route and bytes.
    assert!(
        f.store
            .read_export_acknowledgement("publish-owned", None)?
            .is_none()
    );
    Ok(())
}
