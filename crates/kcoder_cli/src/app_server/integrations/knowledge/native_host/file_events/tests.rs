//! Actual held files and Code workflows over the original RuntimeClient/pump.
//! This fixture's explicit read policy is not a product file-picker/watch grant.
use super::*;
use crate::app_server::integrations::knowledge::automation_runtime::prepare_native_automation_runtime_for_resident;
use crate::app_server::integrations::knowledge::{KnowledgeDependencyPort, NativeKnowledgeRpc};
use crate::app_server::{
    BackgroundEventPump, BackgroundFollowupScheduler, BackgroundFollowupState,
    BackgroundProjectionState, InteractionReceipts, ResidentTurnState, SessionLease,
    integrations::core::runtime_pump::{NativeRuntimeClient, NativeRuntimePump},
    thread_runtime::{ThreadManager, ThreadRuntime},
};
use anyhow::Context as _;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_tools::{ToolRegistry, WorkflowTool};
use kcoder_types::MessagesRequest;
use std::{
    fs::{File, FileTimes},
    future::Future,
    path::PathBuf,
    sync::{
        Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, UNIX_EPOCH},
};
use tokio::sync::Mutex as AsyncMutex;

struct NoModel(Arc<AtomicUsize>);
impl Provider for NoModel {
    fn name(&self) -> &'static str {
        "native-file-event-no-model"
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn stream_messages(
        &self,
        _: MessagesRequest,
    ) -> std::result::Result<ProviderStream, ApiErrorKind> {
        self.0.fetch_add(1, Ordering::SeqCst);
        panic!("pure Code file event requested a model")
    }
}
struct SelectedReadPolicy {
    owner: KnowledgeOwner,
    directory: kcoder_config::PrivateDirectory,
    identity: String,
    enabled: AtomicBool,
}
impl KnowledgePolicyEvaluator for SelectedReadPolicy {
    fn evaluate_action(
        &self,
        scope: &IntegrationScope,
        action: &str,
        resource: &KnowledgeResource,
    ) -> Result<IntegrationPolicyEvaluation> {
        let allow = self.enabled.load(Ordering::Acquire)
            && KnowledgeOwner::from(scope) == self.owner
            && resource.owner == self.owner
            && resource.kind == "automation-file-source"
            && resource.id == "owned-file-row"
            && action == "automation.event_source.read"
            && self.directory.directory_identity()? == self.identity;
        Ok(IntegrationPolicyEvaluation {
            decision: if allow {
                IntegrationPolicyDecision::Allow
            } else {
                IntegrationPolicyDecision::Deny
            },
            policy_revision: "owned-selected-file-read-v1".into(),
            reason_code: "owned-file-fixture".into(),
        })
    }
}
struct ResidentRuntime {
    native: NativeIntegrationContext,
    engine: QueryEngine,
    cache: Weak<AsyncMutex<NativeKnowledgeRpc>>,
    manager: Arc<AsyncMutex<ThreadManager>>,
    runtime: NativeRuntimeClient,
    accepts: Arc<AtomicUsize>,
}
#[async_trait::async_trait]
impl KnowledgeDependencyPort for ResidentRuntime {
    fn registered(&self, port: IntegrationPort, method: &str) -> bool {
        port == IntegrationPort::Runtime
            && matches!(
                method,
                "acceptTask" | "readOperation" | "readTask" | "cancelTask"
            )
    }
    async fn call(
        &self,
        _: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
    ) -> IntegrationReply {
        let perform = async {
            let native = Arc::new(self.native.recapture_for_owned_service()?);
            match method {
                "acceptTask" => {
                    let cache = self.cache.upgrade().context("fixture cache gone")?;
                    let host = cache.lock().await.host_for_engine(&native, &self.engine)?;
                    let prepared = {
                        let manager = self.manager.lock().await;
                        // Each fixture admission uses the original real resident
                        // and lease, not a public thread ID. The resident keeps
                        // any native source boundary an earlier task installed:
                        // a reset to the unbounded baseline is refused by design.
                        prepare_native_automation_runtime_for_resident(
                            &native,
                            &manager,
                            &self.engine.session_id(),
                            host,
                            request,
                            None,
                            &CancellationToken::new(),
                        )?
                    };
                    self.accepts.fetch_add(1, Ordering::SeqCst);
                    self.runtime
                        .accept(native, request.clone(), prepared.task, prepared.authority)
                        .await
                }
                "readOperation" => self.runtime.read_operation(native, request.clone()).await,
                "readTask" => self.runtime.read_task(native, request.clone()).await,
                "cancelTask" => self.runtime.cancel_task(native, request.clone()).await,
                _ => anyhow::bail!("fixture method unavailable"),
            }
        }
        .await;
        perform.expect("actual original RuntimeClient failed; no fabricated reply")
    }
}
struct Fixture {
    _root: tempfile::TempDir,
    _viewer: crate::app_server::ConnectionState,
    _profile: PathBuf,
    workspace: PathBuf,
    native: NativeIntegrationContext,
    engine: QueryEngine,
    manager: Arc<AsyncMutex<ThreadManager>>,
    pump: NativeRuntimePump,
    _client: NativeRuntimeClient,
    outbound: tokio::sync::mpsc::Sender<serde_json::Value>,
    _outbound: tokio::sync::mpsc::Receiver<serde_json::Value>,
    _cache: Arc<AsyncMutex<NativeKnowledgeRpc>>,
    host: Arc<NativeKnowledgeHost>,
    policy: Arc<SelectedReadPolicy>,
    accepts: Arc<AtomicUsize>,
    models: Arc<AtomicUsize>,
    request: IntegrationRequest,
    base: u64,
}
fn write_at(path: &std::path::Path, text: &str, at: u64) -> Result<()> {
    std::fs::write(path, text)?;
    File::options()
        .write(true)
        .open(path)?
        .set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_millis(at)))?;
    Ok(())
}
impl Fixture {
    async fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        let parent = kcoder_config::PrivateDirectory::open_existing(root.path())?;
        let profile = parent.create_private_child(OsStr::new("profile"))?;
        profile.atomic_replace(OsStr::new("settings.json"), b"{}")?;
        let workspace = parent.create_private_child(OsStr::new("workspace"))?;
        let profile = root.path().join("profile");
        let workspace_path = root.path().join("workspace");
        let models = Arc::new(AtomicUsize::new(0));
        let accepts = Arc::new(AtomicUsize::new(0));
        let mut settings = kcoder_config::Settings {
            history_enabled: false,
            ..crate::test_fixtures::settings_with_default_provider()
        };
        settings.integrations.knowledge.business_automation_enabled = true;
        settings.max_tokens = Some(4096);
        let storage = Arc::new(kcoder_config::create_private_temp_dir(
            "native-file-event-client",
        )?);
        let services = kcoder_engine::WorkspaceRuntimeServices::new(
            &workspace_path,
            "native-file-event-client",
        )
        .with_private_client_storage(storage);
        let engine = QueryEngine::try_new_for_client_with_services(
            Arc::new(NoModel(models.clone())),
            kcoder_state::AppState::new(&workspace_path),
            ToolRegistry::new().register(WorkflowTool),
            kcoder_permissions::PermissionEngine::from_settings(&settings),
            settings,
            kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
            kcoder_skills::SkillRegistry::empty(),
            Arc::new(kcoder_tools::DenyAllUserQuestioner),
            workspace_path.clone(),
            Some(true),
            services,
        )?
        .with_settings_persistence_path(profile.join("settings.json"));
        let native = NativeIntegrationContext::capture(
            &profile,
            &workspace_path,
            "owned-file-event",
            &engine.active_model_configuration_summary()?.revision,
        )?;
        let base = u64::try_from(chrono::Utc::now().timestamp_millis())? - 100_000;
        write_at(
            &workspace_path.join("selected.txt"),
            "untrusted source data; never execute",
            base,
        )?;
        write_at(
            &workspace_path.join("unselected.txt"),
            "unselected material",
            base,
        )?;
        let policy = Arc::new(SelectedReadPolicy {
            owner: KnowledgeOwner::from(native.scope()),
            identity: workspace.directory_identity()?,
            directory: workspace,
            enabled: AtomicBool::new(true),
        });
        let source = ApprovedFileEventSource::from_authorized_files(
            native.scope(),
            "owned-file-source",
            kcoder_config::PrivateDirectory::open_existing(&workspace_path)?,
            vec![("owned-file-row".into(), "selected.txt".into())],
        )?;
        let binding = Arc::new(NativeFileEventBinding::from_authorized_source(
            &native,
            &engine,
            source,
            policy.clone(),
        )?);
        let history = root.path().join("history.jsonl");
        engine.state.with_history_path(&history);
        let projection = Arc::new(AsyncMutex::new(BackgroundProjectionState::default()));
        let followups = Arc::new(BackgroundFollowupState::default());
        let viewer = crate::app_server::ConnectionState::default();
        followups.session_activity.attach(
            &viewer,
            &uuid::Uuid::new_v4().to_string(),
            &uuid::Uuid::new_v4().to_string(),
        )?;
        let (outbound, receive) = tokio::sync::mpsc::channel(128);
        let turn = ResidentTurnState::new(
            outbound.clone(),
            kcoder_config::PermissionMode::Ask,
            Arc::new(AtomicU64::new(2_000_000)),
            Arc::new(Mutex::new(InteractionReceipts::default())),
        );
        let events = BackgroundEventPump::spawn(
            &engine,
            projection.clone(),
            followups.clone(),
            outbound.clone(),
        );
        let resident = ThreadRuntime::new(
            engine.clone(),
            SessionLease::acquire(&history)?,
            projection,
            followups,
            (events, BackgroundFollowupScheduler::disabled_for_test()),
            turn,
        );
        let mut manager = ThreadManager::default();
        ensure!(
            manager.insert(resident).is_ok(),
            "fixture resident conflict"
        );
        let manager = Arc::new(AsyncMutex::new(manager));
        let (pump, client) = NativeRuntimePump::new();
        let cache = Arc::new(AsyncMutex::new(NativeKnowledgeRpc::default()));
        let port = Arc::new(ResidentRuntime {
            native: native.recapture_for_owned_service()?,
            engine: engine.clone(),
            cache: Arc::downgrade(&cache),
            manager: manager.clone(),
            runtime: client.clone(),
            accepts: accepts.clone(),
        });
        cache.lock().await.set_dependencies(Some(port));
        cache
            .lock()
            .await
            .bind_file_event_sources(&native, vec![binding])?;
        let host = cache.lock().await.host_for_engine(&native, &engine)?;
        let request = IntegrationRequest {
            contract_version: IntegrationContractVersion::ParallelV1,
            request_id: "native-file-event-tick".into(),
            scope: native.scope().clone(),
            operation_id: None,
            expected_revision: None,
            timeout_ms: 5000,
            cancellation_ref: None,
            payload: Default::default(),
        };
        let library = WorkflowStore::new(profile.join("workflow-library"));
        let draft = library.create("Owned file event Code", "Actual original no-model runtime")?;
        let draft=library.upsert_node(&draft.id,draft.revision,serde_json::from_value(json!({"id":"verify","title":"Verify fixed stored input","kind":"code","config":{"code":{"source":"if(input.value!==7) throw new Error('intent changed'); return {fileEventVerified:true,value:input.value};","timeoutMs":1000}}}))?)?;
        let definition = library.save(&draft.id, draft.revision)?;
        let mut save = request.clone();
        save.operation_id = Some("explicit-file-event-subscription".into());
        save.expected_revision = Some("0".into());
        save.payload=json!({"draft":{"id":"owned-file-subscription","title":"Explicit selected file subscription","workflowId":definition.id,"workflowVersion":1,"inputs":{"value":7},"schedule":null,"eventSource":"owned-file-source","maximumTokens":5000,"maximumRuntimeSeconds":30,"delivery":{"kind":"studio"}},"consentRef":"native-explicit-file-event"}).as_object().unwrap().clone();
        let saved = host
            .automation(
                "saveSubscription",
                &save,
                true,
                base - 1,
                &CancellationToken::new(),
            )
            .await;
        ensure!(
            saved.status == IntegrationStatus::Completed,
            "native event subscription save failed: {:?}",
            saved.error
        );
        Ok(Self {
            _root: root,
            _viewer: viewer,
            _profile: profile,
            workspace: workspace_path,
            native,
            engine,
            manager,
            pump,
            _client: client,
            outbound,
            _outbound: receive,
            _cache: cache,
            host,
            policy,
            accepts,
            models,
            request,
            base,
        })
    }
    async fn drive<F: Future<Output = Result<Vec<IntegrationReply>>>>(
        &mut self,
        future: F,
    ) -> Result<Vec<IntegrationReply>> {
        tokio::pin!(future);
        tokio::time::timeout(Duration::from_secs(10),async {
            loop {
                {let mut manager=self.manager.lock().await; ensure!(self.pump.next_request(&mut manager)?.is_none(),"fixture expected actual resident; no fake thread/start response");}
                tokio::select!{result=&mut future=>return result,
                    event=self.pump.receive()=>{let manager=self.manager.lock().await;self.pump.observe(event,&self.outbound,&manager).await?;}}
            }
        }).await?
    }
    async fn tick(&mut self, at: u64) -> Result<Vec<IntegrationReply>> {
        let host = self.host.clone();
        let request = self.request.clone();
        self.drive(async move {
            host.automation_tick(&request, at, &CancellationToken::new())
                .await
        })
        .await
    }
    async fn settle(&mut self, at: u64) -> Result<()> {
        for _ in 0..50 {
            self.tick(at).await?;
            let store = self.host.observe_automation()?.unwrap();
            if store.store.list_runs(None)?.items.iter().all(|run| {
                matches!(
                    run.status,
                    AutomationRunStatus::Completed
                        | AutomationRunStatus::Failed
                        | AutomationRunStatus::Cancelled
                )
            }) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        anyhow::bail!("actual file-event Code did not terminate")
    }
    async fn close(self) {
        self.pump.close().await;
        for runtime in self.manager.lock().await.drain() {
            runtime.shutdown().await;
        }
    }
}

#[tokio::test]
async fn native_selected_file_tick_reaches_original_runtime_and_dedup_storm_expiry_causality_and_stop()
-> Result<()> {
    let mut f = Fixture::new().await?;
    let result = async {
        f.tick(f.base).await?;
        f.settle(f.base).await?;
        ensure!(
            f.accepts.load(Ordering::SeqCst) == 1,
            "initial file revision did not reach actual RuntimeClient"
        );
        let first = f
            .host
            .observe_automation()?
            .unwrap()
            .store
            .list_runs(None)?
            .items;
        ensure!(
            first.len() == 1
                && first[0].status == AutomationRunStatus::Completed
                && first[0]
                    .output
                    .as_deref()
                    .is_some_and(|output| output.contains("fileEventVerified")),
            "actual Code output missing: {first:?}"
        );
        f.tick(f.base + 1).await?;
        ensure!(
            f.accepts.load(Ordering::SeqCst) == 1,
            "same revision replayed"
        );
        write_at(
            &f.workspace.join("unselected.txt"),
            "unselected change",
            f.base + 500,
        )?;
        f.tick(f.base + 500).await?;
        ensure!(
            f.accepts.load(Ordering::SeqCst) == 1,
            "unselected file produced an event"
        );
        write_at(
            &f.workspace.join("selected.txt"),
            "second selected revision",
            f.base + 1000,
        )?;
        let storm = f.tick(f.base + 1000).await?;
        ensure!(
            storm
                .iter()
                .any(|reply| reply.status == IntegrationStatus::Rejected),
            "storm was not bounded"
        );
        ensure!(
            f.accepts.load(Ordering::SeqCst) == 1,
            "storm started another task"
        );
        f.tick(f.base + 11_000).await?;
        f.settle(f.base + 11_000).await?;
        ensure!(
            f.accepts.load(Ordering::SeqCst) == 2,
            "allowed new revision did not execute"
        );
        write_at(
            &f.workspace.join("selected.txt"),
            "native own-output test revision",
            f.base + 22_000,
        )?;
        let host = f.host.clone();
        let request = f.request.clone();
        let at = f.base + 22_000;
        ensure!(
            f.drive(async move {
                host.file_event_tick(
                    &request,
                    at,
                    Some("owned-file-subscription"),
                    0,
                    &CancellationToken::new(),
                )
                .await
            })
            .await
            .is_err(),
            "native causal backedge was accepted"
        );
        ensure!(
            f.accepts.load(Ordering::SeqCst) == 2,
            "self-origin started another task"
        );
        write_at(
            &f.workspace.join("selected.txt"),
            "expired selected revision",
            f.base - 8 * 24 * 3600 * 1000,
        )?;
        let expired = f.tick(f.base + 33_000).await?;
        ensure!(
            expired
                .iter()
                .any(|reply| reply.status == IntegrationStatus::Rejected),
            "expired observation accepted"
        );
        ensure!(
            f.accepts.load(Ordering::SeqCst) == 2,
            "expired observation executed"
        );
        let mut stop = f.request.clone();
        stop.operation_id = Some("explicit-stop-file-subscription".into());
        stop.expected_revision = Some("1".into());
        stop.payload = json!({"subscriptionId":"owned-file-subscription","enabled":false})
            .as_object()
            .unwrap()
            .clone();
        ensure!(
            f.host
                .automation(
                    "setSubscriptionEnabled",
                    &stop,
                    true,
                    f.base + 44_000,
                    &CancellationToken::new()
                )
                .await
                .status
                == IntegrationStatus::Completed,
            "native disable failed"
        );
        write_at(
            &f.workspace.join("selected.txt"),
            "late edit after disable",
            f.base + 44_000,
        )?;
        f.policy.enabled.store(false, Ordering::Release);
        f.tick(f.base + 44_000).await?;
        ensure!(
            f.accepts.load(Ordering::SeqCst) == 2 && f.models.load(Ordering::SeqCst) == 0,
            "disabled event or Code issued a model/new task"
        );
        Ok(())
    }
    .await;
    f.close().await;
    result
}

#[tokio::test]
async fn file_read_revocation_and_reopened_missing_authority_never_become_new_permission()
-> Result<()> {
    let mut f = Fixture::new().await?;
    let result = async {
        f.tick(f.base).await?;
        f.settle(f.base).await?;
        let before = f.accepts.load(Ordering::SeqCst);
        f.policy.enabled.store(false, Ordering::Release);
        write_at(
            &f.workspace.join("selected.txt"),
            "revoked edit",
            f.base + 12_000,
        )?;
        ensure!(
            f.tick(f.base + 12_000).await.is_err(),
            "revoked read authority allowed file detection"
        );
        ensure!(
            f.accepts.load(Ordering::SeqCst) == before,
            "revoked file produced a native task"
        );
        let metadata = NativeKnowledgeHost::new(&f.native, settings_for_events())?
            .with_file_event_bindings(f.host.file_events.clone())?;
        ensure!(
            metadata
                .automation(
                    "listSubscriptions",
                    &f.request,
                    false,
                    f.base + 12_000,
                    &CancellationToken::new()
                )
                .await
                .status
                == IntegrationStatus::Completed,
            "read revocation blocked original-owner metadata/cleanup access"
        );
        let mut changed = f.native.recapture_for_owned_service()?;
        changed.refresh_configuration_revision("new-model-metadata".into())?;
        let metadata = NativeKnowledgeHost::new(&changed, settings_for_events())?
            .with_file_event_bindings(f.host.file_events.clone())?;
        let mut read = f.request.clone();
        read.scope = changed.scope().clone();
        ensure!(
            metadata
                .automation(
                    "listSubscriptions",
                    &read,
                    false,
                    f.base + 12_000,
                    &CancellationToken::new()
                )
                .await
                .status
                == IntegrationStatus::Completed,
            "model metadata change hid original-owner subscription controls"
        );
        let reopened = NativeKnowledgeHost::new(&f.native, settings_for_events())?;
        ensure!(
            reopened
                .file_event_tick(
                    &f.request,
                    f.base + 12_000,
                    None,
                    0,
                    &CancellationToken::new()
                )
                .await
                .is_err(),
            "restart silently recreated a file grant"
        );
        f.policy.enabled.store(true, Ordering::Release);
        // Reusing the actual live read authority observes the old cursor; no
        // record/history display or host restart resets event deduplication.
        write_at(
            &f.workspace.join("selected.txt"),
            "untrusted source data; never execute",
            f.base,
        )?;
        let source = ApprovedFileEventSource::from_authorized_files(
            f.native.scope(),
            "owned-file-source",
            kcoder_config::PrivateDirectory::open_existing(&f.workspace)?,
            vec![("owned-file-row".into(), "selected.txt".into())],
        )?;
        let reauthorized = Arc::new(NativeFileEventBinding::from_authorized_source(
            &f.native,
            &f.engine,
            source,
            f.policy.clone(),
        )?);
        let dependencies = f.host.dependencies.as_ref().unwrap().clone();
        f.host = Arc::new(
            NativeKnowledgeHost::new(&f.native, settings_for_events())?
                .with_dependencies(dependencies)
                .with_file_event_bindings(vec![reauthorized])?,
        );
        f.tick(f.base + 20_000).await?;
        ensure!(
            f.accepts.load(Ordering::SeqCst) == before,
            "restart/current cursor replayed original revision"
        );
        ensure!(
            f.models.load(Ordering::SeqCst) == 0,
            "file observer requested a model"
        );
        Ok(())
    }
    .await;
    f.close().await;
    result
}
fn settings_for_events() -> KnowledgeIntegrationSettings {
    KnowledgeIntegrationSettings {
        business_automation_enabled: true,
        ..Default::default()
    }
}
