//! Frame-lane protocol fixtures only; these never prove Native authentication.
use super::*;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::sync::{Notify, mpsc};
use tokio::task::JoinHandle;

struct FixtureTransport {
    incoming: tokio::sync::Mutex<mpsc::Receiver<Value>>,
    replies: mpsc::Sender<Value>,
    sent: Mutex<Vec<Value>>,
    open_count: AtomicUsize,
    stopped: AtomicBool,
    clean: AtomicBool,
    reject_prompt_write: AtomicBool,
    hold_open: AtomicBool,
    hold_prompt: AtomicBool,
    session_failure: AtomicUsize,
    prompt_id: Mutex<Option<Value>>,
    prompt_seen: Notify,
    delayed: Mutex<Vec<JoinHandle<Result<()>>>>,
    bind_delay: Mutex<Duration>,
    bind_count: AtomicUsize,
    close_count: AtomicUsize,
}
impl FixtureTransport {
    fn new() -> Arc<Self> {
        let (replies, incoming) = mpsc::channel(16);
        Arc::new(Self {
            incoming: tokio::sync::Mutex::new(incoming),
            replies,
            sent: Mutex::default(),
            open_count: AtomicUsize::new(0),
            stopped: AtomicBool::new(false),
            clean: AtomicBool::new(true),
            reject_prompt_write: AtomicBool::new(false),
            hold_open: AtomicBool::new(false),
            hold_prompt: AtomicBool::new(false),
            session_failure: AtomicUsize::new(0),
            prompt_id: Mutex::default(),
            prompt_seen: Notify::new(),
            delayed: Mutex::default(),
            bind_delay: Mutex::new(Duration::ZERO),
            bind_count: AtomicUsize::new(0),
            close_count: AtomicUsize::new(0),
        })
    }

    async fn wait_for_prompt(&self) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let notified = self.prompt_seen.notified();
                if self.prompt_id.lock().unwrap().is_some() {
                    return;
                }
                notified.await;
            }
        })
        .await
        .expect("fixture session/prompt was never dispatched");
    }
}

#[tokio::test(start_paused = true)]
#[should_panic(expected = "fixture session/prompt was never dispatched")]
async fn a_missing_prompt_marker_has_a_finite_fixture_deadline() {
    FixtureTransport::new().wait_for_prompt().await;
}

#[tokio::test]
async fn audit_malformed_settlement_ids_never_reach_the_original_host() {
    use kcoder_types::integrations::core::*;
    let transport = FixtureTransport::new();
    let host = FixtureHost::new(true);
    host.allow_settlement.store(true, Ordering::SeqCst);
    let mut peer = connect(transport.clone(), host.clone()).await.unwrap();
    let mut original = original_close_fixture();
    let NativeRemoteControlDataV1::CloseOriginal(accepted) = original.message else {
        unreachable!()
    };
    original.message = NativeRemoteControlDataV1::ObserveModel(NativeRemoteCallRefV1 {
        receiver_accepted: accepted,
        native_call_id: "original-call".into(),
    });
    for id in [Value::Null, json!({"bad":true}), json!([]), json!(true)] {
        assert!(peer.settle_original_native_accounting(&json!({"jsonrpc":"2.0","id":id,"method":NATIVE_REMOTE_CONTROL_METHOD,"params":original})).await);
    }
    assert_eq!(host.settlements.load(Ordering::SeqCst), 0);
    tokio::time::timeout(Duration::from_secs(1), async {
        while transport
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame.get("error").is_some())
            .count()
            < 4
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("malformed requests must receive rejection frames");
    assert!(
        transport
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame.get("error").is_some())
            .all(|frame| frame["id"].is_null())
    );
    peer.shutdown().await;
}

async fn null_request_reply(method: &str) -> Value {
    let transport = FixtureTransport::new();
    transport.hold_prompt.store(true, Ordering::SeqCst);
    let host = FixtureHost::new(true);
    let mut peer = connect(transport.clone(), host).await.unwrap();
    peer.initialize(&CancellationToken::new()).await.unwrap();
    let execution = tokio::spawn(async move {
        let result = peer
            .prompt_once(
                vec![OutboundContentBlock::Text(OutboundTextContent::new(
                    "one owned prompt",
                ))],
                &CancellationToken::new(),
                Duration::from_secs(2),
            )
            .await;
        (peer, result)
    });
    transport.wait_for_prompt().await;
    transport.replies.send(json!({"jsonrpc":"2.0","id":null,"method":method,"params":{
        "sessionId":"original-fixture-session","toolCall":{"toolCallId":"tool","status":"pending"},"options":[]
    }})).await.unwrap();
    // The independent fixture completes its held prompt only after this request.
    transport
        .replies
        .send(json!({"jsonrpc":"2.0","id":901,
        "method":"kcoder/nativeRemote/controlV1","params":{"authority":true}}))
        .await
        .unwrap();
    let (mut peer, result) = execution.await.unwrap();
    result.unwrap();
    let reply = transport
        .sent
        .lock()
        .unwrap()
        .iter()
        .find(|frame| frame.get("id").is_some_and(Value::is_null) && frame.get("method").is_none())
        .cloned()
        .expect("the original null request must receive a reply");
    peer.shutdown().await;
    reply
}

#[tokio::test]
async fn standard_null_permission_request_is_cancelled_without_execution() {
    let reply = null_request_reply("session/request_permission").await;
    assert_eq!(reply["result"]["outcome"]["outcome"], "cancelled");
    assert!(reply.get("error").is_none());
}

#[tokio::test]
async fn standard_null_unsupported_request_retains_method_not_found() {
    let reply = null_request_reply("client/unknown").await;
    assert_eq!(reply["error"]["code"], -32601);
}

#[tokio::test]
async fn private_null_request_cannot_enter_the_native_host() {
    let reply = null_request_reply("kcoder/nativeRemote/controlV1").await;
    assert_eq!(reply["error"]["code"], -32600);
}

impl OwnedNativeFrameTransport for FixtureTransport {
    fn endpoint_instance_id(&self) -> &str {
        "fixture-owned-endpoint"
    }
    fn verify_owner(&self) -> Result<()> {
        Ok(())
    }
    fn open(&self) -> NativeFrameFuture<'_, ()> {
        Box::pin(async {
            self.open_count.fetch_add(1, Ordering::SeqCst);
            if self.hold_open.load(Ordering::SeqCst) {
                std::future::pending::<()>().await;
            }
            Ok(())
        })
    }
    fn send(&self, frame: Value) -> NativeFrameFuture<'_, ()> {
        Box::pin(async move {
            self.sent.lock().unwrap().push(frame.clone());
            match frame["method"].as_str() {
            Some("initialize") => self.replies.send(json!({"jsonrpc":"2.0","id":frame["id"],"result":{"protocolVersion":1,"agentCapabilities":{},"agentInfo":{"name":"frame-fixture","version":"1"}}})).await?,
            Some(kcoder_types::integrations::core::NATIVE_REMOTE_CONTROL_METHOD) if frame["params"]["message"]["method"] == "close_original" => {
                self.close_count.fetch_add(1, Ordering::SeqCst);
                let params=&frame["params"];
                self.replies.send(json!({"jsonrpc":"2.0","id":frame["id"],"result":{
                    "version":params["version"],"operationId":params["operationId"],"requestId":params["requestId"],
                    "endpointRevision":params["endpointRevision"],"endpointInstanceId":params["endpointInstanceId"],
                    "state":"received","data":{"kind":"owner_closed","accepted":params["message"]["params"],
                    "outcome":"completed","backendExited":true,"ownerTreeCleanupConfirmed":true}}})).await?;
            }
            Some(kcoder_types::integrations::core::NATIVE_REMOTE_CONTROL_METHOD) => {
                self.bind_count.fetch_add(1, Ordering::SeqCst);
                let sender=self.replies.clone();
                let delay=*self.bind_delay.lock().unwrap();
                let params=frame["params"].clone();
                let pending = tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    sender.send(json!({"jsonrpc":"2.0","id":frame["id"],"result":{
                        "version":params["version"],"operationId":params["operationId"],
                        "requestId":params["requestId"],"endpointRevision":params["endpointRevision"],
                        "endpointInstanceId":params["endpointInstanceId"],"state":"received",
                        "data":{"kind":"original_bound","frozenInputSha256":params["message"]["params"]["frozenInputSha256"],
                            "receiverSettingsSha256":"c".repeat(64)}}})).await.map_err(|_|anyhow::anyhow!("fixture bind receiver closed"))
                });
                self.delayed.lock().unwrap().push(pending);
            }
            Some("session/new") => {
                let reply = match self.session_failure.load(Ordering::SeqCst) {
                    1 => json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32000,"message":"Owned fixture rejection"}}),
                    2 => json!({"jsonrpc":"2.0","id":frame["id"],"result":{"sessionId":42}}),
                    _ => json!({"jsonrpc":"2.0","id":frame["id"],"result":{"sessionId":"original-fixture-session"}}),
                };
                self.replies.send(reply).await?;
            },
            Some("session/prompt") => {
                if self.reject_prompt_write.load(Ordering::SeqCst) { bail!("fixture write receipt lost"); }
                *self.prompt_id.lock().unwrap() = Some(frame["id"].clone());
                self.prompt_seen.notify_one();
                if self.hold_prompt.load(Ordering::SeqCst) { return Ok(()); }
                self.replies.send(json!({"jsonrpc":"2.0","id":900,"method":"session/request_permission","params":{}})).await?;
                self.replies.send(json!({"jsonrpc":"2.0","id":901,"method":kcoder_types::integrations::core::NATIVE_REMOTE_CONTROL_METHOD,"params":{"authority":true}})).await?;
            }
            None if frame["id"] == 901 => {
                let id = self.prompt_id.lock().unwrap().take().ok_or_else(||anyhow::anyhow!("fixture settlement reply preceded its original session/prompt"))?;
                self.replies.send(json!({"jsonrpc":"2.0","id":id,"result":{"stopReason":"end_turn"}})).await?;
            }
            _ => {}
        }
            Ok(())
        })
    }
    fn receive(&self) -> NativeFrameFuture<'_, Option<Value>> {
        Box::pin(async { Ok(self.incoming.lock().await.recv().await) })
    }
    fn begin_close(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        for task in self.delayed.lock().unwrap().iter() {
            task.abort();
        }
    }
    fn close(&self) -> NativeFrameFuture<'_, bool> {
        Box::pin(async {
            self.begin_close();
            let tasks = std::mem::take(&mut *self.delayed.lock().unwrap());
            for task in tasks {
                match task.await {
                    Ok(result) => result?,
                    Err(error) if error.is_cancelled() => {}
                    Err(error) => return Err(error.into()),
                }
            }
            Ok(self.clean.load(Ordering::SeqCst))
        })
    }
}
struct FixtureHost {
    allow_transport: bool,
    admission_failure: AtomicBool,
    allow_bind: AtomicBool,
    allow_close: AtomicBool,
    allow_settlement: AtomicBool,
    settlements: AtomicUsize,
    close_admitted: AtomicBool,
    close_unknown: AtomicUsize,
    bind_unknown: AtomicUsize,
    spawn_failure: AtomicBool,
    observation_failure: AtomicBool,
    unknown_failure: AtomicBool,
    session_receipt_failure: AtomicBool,
    cancel_started: AtomicUsize,
    cancel_finished: AtomicUsize,
    deadline: tokio::time::Instant,
    effects: Mutex<Vec<OutboundEffect>>,
    unknown: Mutex<Vec<OutboundEffect>>,
}
impl FixtureHost {
    fn new(allow_transport: bool) -> Arc<Self> {
        Self::with_deadline(allow_transport, Duration::from_secs(10))
    }
    fn with_deadline(allow_transport: bool, duration: Duration) -> Arc<Self> {
        Arc::new(Self {
            allow_transport,
            admission_failure: AtomicBool::new(false),
            allow_bind: AtomicBool::new(false),
            allow_close: AtomicBool::new(false),
            allow_settlement: AtomicBool::new(false),
            settlements: AtomicUsize::new(0),
            close_admitted: AtomicBool::new(false),
            close_unknown: AtomicUsize::new(0),
            bind_unknown: AtomicUsize::new(0),
            spawn_failure: AtomicBool::new(false),
            observation_failure: AtomicBool::new(false),
            unknown_failure: AtomicBool::new(false),
            session_receipt_failure: AtomicBool::new(false),
            cancel_started: AtomicUsize::new(0),
            cancel_finished: AtomicUsize::new(0),
            deadline: tokio::time::Instant::now() + duration,
            effects: Mutex::default(),
            unknown: Mutex::default(),
        })
    }
}
impl OutboundHost for FixtureHost {
    fn handle_owned_native_settlement<'a>(&'a self, _: &'a Value) -> OwnedNativeControlFuture<'a> {
        Box::pin(async move {
            ensure!(
                self.allow_settlement.load(Ordering::SeqCst),
                "no fixture settlement capability"
            );
            self.settlements.fetch_add(1, Ordering::SeqCst);
            Ok(Some(json!({"ownedOriginalSettlement":true})))
        })
    }
    fn begin_owned_cancel(&self, _: &Value) -> Result<()> {
        ensure!(
            self.allow_settlement.load(Ordering::SeqCst),
            "no fixture retained cancel"
        );
        self.cancel_started.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn finish_owned_cancel(&self, _: bool) -> Result<()> {
        self.cancel_finished.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn owned_cancel_complete(&self) -> Result<bool> {
        ensure!(
            !self.observation_failure.load(Ordering::SeqCst),
            "PRIVATE_OWNED_OBSERVATION_DETAIL"
        );
        Ok(false)
    }

    fn check_owned_native_close(&self) -> Result<()> {
        ensure!(
            self.allow_close.load(Ordering::SeqCst),
            "no private fixture close admission"
        );
        Ok(())
    }
    fn before_owned_native_close(&self, _: &Value) -> Result<()> {
        self.check_owned_native_close()?;
        ensure!(
            !self.close_admitted.swap(true, Ordering::SeqCst),
            "no fixture close replay"
        );
        Ok(())
    }
    fn record_owned_native_close(&self, receipt: &Value) -> Result<()> {
        ensure!(
            receipt["data"]["backendExited"] == true
                && receipt["data"]["ownerTreeCleanupConfirmed"] == true,
            "fixture close receipt unconfirmed"
        );
        Ok(())
    }
    fn unknown_owned_native_close(&self) -> Result<()> {
        self.close_unknown.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn before_owned_native_bind(&self, _: &Value) -> Result<()> {
        ensure!(
            self.allow_bind.load(Ordering::SeqCst),
            "no private fixture bind admission"
        );
        Ok(())
    }
    fn record_owned_native_bind(&self, _: &Value) -> Result<()> {
        ensure!(
            self.allow_bind.load(Ordering::SeqCst),
            "no private fixture bind admission"
        );
        Ok(())
    }
    fn unknown_owned_native_bind(&self) -> Result<()> {
        self.bind_unknown.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn verify_runner(&self, _: &InstalledOutboundRunner) -> Result<()> {
        bail!("no process in frame fixture")
    }
    fn verify_owned_frame_transport(&self, _: &dyn OwnedNativeFrameTransport) -> Result<()> {
        ensure!(self.allow_transport, "no native fixture admission");
        Ok(())
    }
    fn check_current(&self) -> Result<()> {
        ensure!(
            !self.admission_failure.load(Ordering::SeqCst),
            "private fixture source error"
        );
        Ok(())
    }
    fn deadline(&self) -> tokio::time::Instant {
        self.deadline
    }
    fn before_effect(&self, effect: OutboundEffect, _: &Value) -> Result<()> {
        ensure!(
            !self.spawn_failure.load(Ordering::SeqCst),
            "private fixture journal error"
        );
        let mut effects = self.effects.lock().unwrap();
        ensure!(!effects.contains(&effect), "no fixture effect replay");
        effects.push(effect);
        Ok(())
    }
    fn record_receipt(&self, effect: OutboundEffect, _: &Value) -> Result<()> {
        ensure!(
            !(effect == OutboundEffect::Session
                && self.session_receipt_failure.load(Ordering::SeqCst)),
            "PRIVATE_SESSION_RECEIPT_DETAIL"
        );
        Ok(())
    }
    fn record_unknown(&self, effect: OutboundEffect) -> Result<()> {
        self.unknown.lock().unwrap().push(effect);
        ensure!(
            !(effect == OutboundEffect::Prompt && self.unknown_failure.load(Ordering::SeqCst)),
            "PRIVATE_PROMPT_JOURNAL_DETAIL"
        );
        ensure!(
            !(effect == OutboundEffect::Session && self.unknown_failure.load(Ordering::SeqCst)),
            "PRIVATE_SESSION_JOURNAL_DETAIL"
        );
        Ok(())
    }
}
async fn connect(transport: Arc<FixtureTransport>, host: Arc<FixtureHost>) -> Result<OutboundAcp> {
    OutboundAcp::connect_owned_transport(
        transport,
        Some(PathBuf::from("D:\\owned-fixture")),
        ("frame-fixture", "1"),
        host,
        &CancellationToken::new(),
    )
    .await
}

#[tokio::test]
async fn an_owned_frame_transport_alone_does_not_enable_private_receiver_binding() {
    use kcoder_types::integrations::core::*;
    let transport = FixtureTransport::new();
    let host = FixtureHost::new(true);
    let mut peer = connect(transport.clone(), host).await.unwrap();
    peer.initialize(&CancellationToken::new()).await.unwrap();
    let original = NativeRemoteControlFrameV1 {
        version: 1,
        operation_id: "original-operation".into(),
        request_id: "original-bind".into(),
        endpoint_revision: "original-target".into(),
        endpoint_instance_id: "fixture-owned-endpoint".into(),
        source_accepted_sha256: "a".repeat(64),
        message: NativeRemoteControlDataV1::BindOriginal(NativeRemoteBindOriginalV1 {
            source_scope: IntegrationScope {
                account_id: "routing-fixture".into(),
                target_id: "routing-target".into(),
                workspace_id: IntegrationNullable::Value("routing-workspace".into()),
                identity_generation: "routing-generation".into(),
                target_revision: "routing-revision".into(),
                organization_id: None,
            },
            source_attempt: NativeRemoteTurnIdentityV1 {
                thread_id: "original-thread".into(),
                turn_id: "original-turn".into(),
                attempt_id: "original-attempt".into(),
            },
            frozen_input_sha256: "b".repeat(64),
            deadline_utc_ms: 1,
            prompt: "original bounded input".into(),
            allowed_output_formats: vec![],
            materials: vec![],
        }),
    };
    assert!(
        peer.bind_owned_native_original(&original, &CancellationToken::new())
            .await
            .is_err()
    );
    let mut material = original.clone();
    material.message = NativeRemoteControlDataV1::OfferMaterial(NativeRemoteMaterialOfferV1 {
        content: NativeRemoteContentRefV1 {
            source: kcoder_types::integrations::office::OfficeArtifactRef {
                id: "not-an-upload-authority".into(),
                revision: 1,
            },
            bytes: 1,
            sha256: "c".repeat(64),
        },
        filename: "literal.txt".into(),
        media_type: "text/plain".into(),
    });
    assert!(
        peer.write_owned_native_material(&material, &CancellationToken::new())
            .await
            .is_err()
    );
    assert!(
        transport
            .sent
            .lock()
            .unwrap()
            .iter()
            .all(|frame| frame["method"] != NATIVE_REMOTE_CONTROL_METHOD),
        "Generic ACP host must reject before any private frame is dispatched"
    );
    assert!(peer.shutdown().await.confirmed());
}
#[tokio::test]
async fn unadmitted_transport_cannot_open_even_when_its_frame_claims_native_identity() {
    let transport = FixtureTransport::new();
    let host = FixtureHost::new(false);
    assert!(connect(transport.clone(), host.clone()).await.is_err());
    assert_eq!(transport.open_count.load(Ordering::SeqCst), 0);
    assert!(host.effects.lock().unwrap().is_empty());
}
#[tokio::test]
async fn frame_lane_preserves_original_acp_flow_and_denies_permission_and_private_control() {
    let transport = FixtureTransport::new();
    let host = FixtureHost::new(true);
    let mut peer = connect(transport.clone(), host.clone()).await.unwrap();
    let cancel = CancellationToken::new();
    peer.initialize(&cancel).await.unwrap();
    peer.prompt_once(
        vec![OutboundContentBlock::Text(OutboundTextContent::new(
            "frozen fixture prompt",
        ))],
        &cancel,
        Duration::from_secs(2),
    )
    .await
    .unwrap();
    let sent = transport.sent.lock().unwrap().clone();
    assert_eq!(
        sent.iter()
            .filter(|frame| frame["method"] == "session/prompt")
            .count(),
        1
    );
    assert!(sent.iter().any(|frame| frame["id"] == 900 && frame["result"]["outcome"]["outcome"] == "cancelled"));
    assert!(
        sent.iter()
            .any(|frame| frame["id"] == 901 && frame["error"]["code"] == -32601)
    );
    let cleanup = peer.shutdown().await;
    assert!(cleanup.confirmed() && cleanup.belongs_to(&host));
    assert_eq!(cleanup.owned_pid(), 0);
    assert_eq!(
        cleanup.owned_endpoint_instance(),
        Some("fixture-owned-endpoint")
    );
    assert_eq!(
        *host.effects.lock().unwrap(),
        vec![
            OutboundEffect::Spawn,
            OutboundEffect::Initialize,
            OutboundEffect::Session,
            OutboundEffect::Prompt
        ]
    );
}
#[tokio::test]
async fn lost_prompt_write_receipt_remains_unknown_and_never_replays_on_the_same_lane() {
    let transport = FixtureTransport::new();
    transport.reject_prompt_write.store(true, Ordering::SeqCst);
    transport.clean.store(false, Ordering::SeqCst);
    let host = FixtureHost::new(true);
    let mut peer = connect(transport.clone(), host.clone()).await.unwrap();
    let cancel = CancellationToken::new();
    peer.initialize(&cancel).await.unwrap();
    for _ in 0..2 {
        assert!(
            peer.prompt_once(
                vec![OutboundContentBlock::Text(OutboundTextContent::new(
                    "original prompt"
                ))],
                &cancel,
                Duration::from_secs(2)
            )
            .await
            .is_err()
        );
    }
    assert_eq!(
        transport
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame["method"] == "session/prompt")
            .count(),
        1
    );
    assert!(
        host.unknown
            .lock()
            .unwrap()
            .contains(&OutboundEffect::Prompt)
    );
    assert!(!peer.shutdown().await.confirmed());
    assert!(transport.stopped.load(Ordering::SeqCst));
}
#[tokio::test]
async fn dropping_pending_open_requests_only_original_cleanup_and_records_unknown() {
    let transport = FixtureTransport::new();
    transport.hold_open.store(true, Ordering::SeqCst);
    let host = FixtureHost::new(true);
    {
        let pending = connect(transport.clone(), host.clone());
        tokio::pin!(pending);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut pending)
                .await
                .is_err()
        );
    }
    assert_eq!(transport.open_count.load(Ordering::SeqCst), 1);
    assert!(transport.stopped.load(Ordering::SeqCst));
    assert_eq!(*host.unknown.lock().unwrap(), vec![OutboundEffect::Spawn]);
}

#[tokio::test]
async fn private_open_diagnostic_context_identifies_rejection_before_transport_open() {
    for stage in [
        "REMOTE_OWNED_OPEN_SOURCE_ADMISSION",
        "REMOTE_OWNED_OPEN_TRANSPORT_BINDING",
        "REMOTE_OWNED_OPEN_SPAWN_JOURNAL",
    ] {
        let transport = FixtureTransport::new();
        let host = FixtureHost::new(stage != "REMOTE_OWNED_OPEN_TRANSPORT_BINDING");
        host.admission_failure.store(
            stage == "REMOTE_OWNED_OPEN_SOURCE_ADMISSION",
            Ordering::SeqCst,
        );
        host.spawn_failure
            .store(stage == "REMOTE_OWNED_OPEN_SPAWN_JOURNAL", Ordering::SeqCst);
        let error = match connect(transport.clone(), host.clone()).await {
            Ok(_) => panic!("Original open must be denied"),
            Err(error) => error,
        };
        assert_eq!(error.to_string(), stage);
        assert_eq!(transport.open_count.load(Ordering::SeqCst), 0);
        assert!(host.effects.lock().unwrap().is_empty());
    }
}

fn delayed_original_bind() -> kcoder_types::integrations::core::NativeRemoteControlFrameV1 {
    use kcoder_types::integrations::core::*;
    NativeRemoteControlFrameV1 {
        version: 1,
        operation_id: "original-delayed-bind".into(),
        request_id: "original-bind-request".into(),
        endpoint_revision: "original-target".into(),
        endpoint_instance_id: "fixture-owned-endpoint".into(),
        source_accepted_sha256: "a".repeat(64),
        message: NativeRemoteControlDataV1::BindOriginal(NativeRemoteBindOriginalV1 {
            source_scope: IntegrationScope {
                account_id: "routing-fixture".into(),
                target_id: "routing-target".into(),
                workspace_id: IntegrationNullable::Null,
                identity_generation: "routing-generation".into(),
                target_revision: "routing-revision".into(),
                organization_id: None,
            },
            source_attempt: NativeRemoteTurnIdentityV1 {
                thread_id: "original-thread".into(),
                turn_id: "original-turn".into(),
                attempt_id: "original-attempt".into(),
            },
            frozen_input_sha256: "b".repeat(64),
            deadline_utc_ms: 1,
            prompt: "original bounded input".into(),
            allowed_output_formats: vec![],
            materials: vec![],
        }),
    }
}

#[tokio::test(start_paused = true)]
async fn native_bind_uses_original_remaining_deadline_for_a_reply_after_ten_seconds() {
    let transport = FixtureTransport::new();
    *transport.bind_delay.lock().unwrap() = Duration::from_secs(11);
    let host = FixtureHost::with_deadline(true, Duration::from_secs(30));
    host.allow_bind.store(true, Ordering::SeqCst);
    let original_deadline = host.deadline;
    let mut peer = connect(transport.clone(), host.clone()).await.unwrap();
    let cancel = CancellationToken::new();
    peer.initialize(&cancel).await.unwrap();
    let start = tokio::time::Instant::now();
    peer.bind_owned_native_original(&delayed_original_bind(), &cancel)
        .await
        .expect("Native bind must not truncate the original remaining deadline to ten seconds");
    assert!(start.elapsed() >= Duration::from_secs(11));
    assert_eq!(
        host.deadline, original_deadline,
        "The original hard deadline never moves"
    );
    assert_eq!(transport.bind_count.load(Ordering::SeqCst), 1);
    assert_eq!(host.bind_unknown.load(Ordering::SeqCst), 0);
    peer.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn a_short_original_bind_deadline_preserves_unknown_and_never_resends() {
    let transport = FixtureTransport::new();
    *transport.bind_delay.lock().unwrap() = Duration::from_secs(11);
    let host = FixtureHost::with_deadline(true, Duration::from_secs(3));
    host.allow_bind.store(true, Ordering::SeqCst);
    let original_deadline = host.deadline;
    let mut peer = connect(transport.clone(), host.clone()).await.unwrap();
    let cancel = CancellationToken::new();
    peer.initialize(&cancel).await.unwrap();
    assert!(
        peer.bind_owned_native_original(&delayed_original_bind(), &cancel)
            .await
            .is_err()
    );
    assert_eq!(tokio::time::Instant::now(), original_deadline);
    assert!(
        peer.bind_owned_native_original(&delayed_original_bind(), &cancel)
            .await
            .is_err()
    );
    assert_eq!(transport.bind_count.load(Ordering::SeqCst), 1);
    assert_eq!(host.bind_unknown.load(Ordering::SeqCst), 1);
    peer.shutdown().await;
    assert!(
        transport.delayed.lock().unwrap().is_empty(),
        "Owned delayed replies must be joined during close"
    );
}

fn original_close_fixture() -> kcoder_types::integrations::core::NativeRemoteControlFrameV1 {
    serde_json::from_value(json!({"version":1,"operationId":"original-operation","requestId":"original-close",
        "endpointRevision":"original-target","endpointInstanceId":"fixture-owned-endpoint","sourceAcceptedSha256":"a".repeat(64),
        "message":{"method":"close_original","params":{"identity":{"threadId":"receiver-thread","turnId":"receiver-turn","attemptId":"receiver-attempt"},
            "acceptedInputSha256":"b".repeat(64),"acceptedReceiptSha256":"c".repeat(64),"receiverSettingsSha256":"d".repeat(64)}}})).unwrap()
}
#[tokio::test]
async fn owned_transport_never_grants_a_native_close_effect() {
    let transport = FixtureTransport::new();
    let host = FixtureHost::new(true);
    let mut peer = connect(transport.clone(), host.clone()).await.unwrap();
    peer.initialize(&CancellationToken::new()).await.unwrap();
    assert!(
        peer.close_owned_native_original(&original_close_fixture())
            .await
            .is_err()
    );
    assert_eq!(transport.close_count.load(Ordering::SeqCst), 0);
    assert_eq!(host.close_unknown.load(Ordering::SeqCst), 0);
    peer.shutdown().await;
}
#[tokio::test]
async fn original_close_uses_dedicated_admission_and_never_replays() {
    let transport = FixtureTransport::new();
    let host = FixtureHost::new(true);
    let mut peer = connect(transport.clone(), host.clone()).await.unwrap();
    peer.initialize(&CancellationToken::new()).await.unwrap();
    host.allow_close.store(true, Ordering::SeqCst);
    host.admission_failure.store(true, Ordering::SeqCst);
    let deadline = host.deadline;
    peer.close_owned_native_original(&original_close_fixture())
        .await
        .unwrap();
    assert!(
        peer.close_owned_native_original(&original_close_fixture())
            .await
            .is_err()
    );
    assert_eq!(transport.close_count.load(Ordering::SeqCst), 1);
    assert_eq!(host.close_unknown.load(Ordering::SeqCst), 0);
    assert_eq!(host.deadline, deadline);
    assert!(
        host.check_owned_native_observation().is_err(),
        "Close needs no read admission"
    );
    peer.shutdown().await;
}

#[tokio::test]
async fn unknown_original_prompt_keeps_only_dedicated_close_without_replaying_execution() {
    let transport = FixtureTransport::new();
    transport.hold_prompt.store(true, Ordering::SeqCst);
    let host = FixtureHost::new(true);
    host.allow_close.store(true, Ordering::SeqCst);
    let mut peer = connect(transport.clone(), host.clone()).await.unwrap();
    peer.initialize(&CancellationToken::new()).await.unwrap();
    let execution = tokio::spawn(async move {
        let result = peer
            .prompt_once(
                vec![OutboundContentBlock::Text(OutboundTextContent::new(
                    "original once",
                ))],
                &CancellationToken::new(),
                Duration::from_secs(10),
            )
            .await;
        (peer, result)
    });
    transport.wait_for_prompt().await;
    host.admission_failure.store(true, Ordering::SeqCst);
    let (mut peer, result) = execution.await.unwrap();
    assert!(result.is_err());
    assert!(
        !transport.stopped.load(Ordering::SeqCst),
        "Retain only the original Native close lane: error={:?}, retain={}, endpoint={:?}, closed={}, unknown={:?}",
        result.as_ref().err(),
        peer.may_retain_original_close(),
        peer.peer.native_endpoint(),
        peer.peer.is_closed(),
        host.unknown.lock().unwrap()
    );
    assert!(
        host.unknown
            .lock()
            .unwrap()
            .contains(&OutboundEffect::Prompt)
    );
    assert!(
        peer.prompt_once(
            vec![OutboundContentBlock::Text(OutboundTextContent::new(
                "must not replay"
            ))],
            &CancellationToken::new(),
            Duration::from_secs(10)
        )
        .await
        .is_err()
    );
    peer.close_owned_native_original(&original_close_fixture())
        .await
        .unwrap();
    assert_eq!(transport.open_count.load(Ordering::SeqCst), 1);
    assert_eq!(transport.close_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        transport
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame["method"] == "session/prompt")
            .count(),
        1
    );
    peer.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn cancellation_drives_only_the_original_retained_settlement_before_close() {
    use kcoder_types::integrations::core::*;
    let transport = FixtureTransport::new();
    transport.hold_prompt.store(true, Ordering::SeqCst);
    let host = FixtureHost::new(true);
    host.allow_close.store(true, Ordering::SeqCst);
    host.allow_settlement.store(true, Ordering::SeqCst);
    let mut peer = connect(transport.clone(), host.clone()).await.unwrap();
    peer.initialize(&CancellationToken::new()).await.unwrap();
    let execution = tokio::spawn(async move {
        let result = peer
            .prompt_once(
                vec![OutboundContentBlock::Text(OutboundTextContent::new(
                    "original once",
                ))],
                &CancellationToken::new(),
                Duration::from_secs(10),
            )
            .await;
        (peer, result)
    });
    transport.wait_for_prompt().await;
    host.admission_failure.store(true, Ordering::SeqCst);
    let mut original = original_close_fixture();
    let NativeRemoteControlDataV1::CloseOriginal(accepted) = original.message else {
        unreachable!()
    };
    original.message = NativeRemoteControlDataV1::ObserveModel(NativeRemoteCallRefV1 {
        receiver_accepted: accepted,
        native_call_id: "original-dispatched-call".into(),
    });
    transport.replies.send(json!({"jsonrpc":"2.0","id":990,"method":NATIVE_REMOTE_CONTROL_METHOD,"params":original})).await.unwrap();
    let (mut peer, result) = execution.await.unwrap();
    assert!(result.is_err());
    assert_eq!(host.settlements.load(Ordering::SeqCst), 1);
    assert!(
        transport
            .sent
            .lock()
            .unwrap()
            .iter()
            .any(|frame| frame["id"] == 990 && frame["result"]["ownedOriginalSettlement"] == true)
    );
    peer.close_owned_native_original(&original_close_fixture())
        .await
        .unwrap();
    assert_eq!(transport.open_count.load(Ordering::SeqCst), 1);
    assert_eq!(transport.close_count.load(Ordering::SeqCst), 1);
    peer.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn consumed_permission_is_denied_when_execution_admission_ends() {
    for id in [Value::Null, json!(712), json!("original-permission")] {
        let transport = FixtureTransport::new();
        transport.hold_prompt.store(true, Ordering::SeqCst);
        let host = FixtureHost::new(true);
        host.allow_close.store(true, Ordering::SeqCst);
        host.allow_settlement.store(true, Ordering::SeqCst);
        let mut peer = connect(transport.clone(), host.clone()).await.unwrap();
        peer.initialize(&CancellationToken::new()).await.unwrap();
        let execution = tokio::spawn(async move {
            let result = peer
                .prompt_once(
                    vec![OutboundContentBlock::Text(OutboundTextContent::new(
                        "one original prompt",
                    ))],
                    &CancellationToken::new(),
                    Duration::from_secs(10),
                )
                .await;
            (peer, result)
        });
        transport.wait_for_prompt().await;
        host.admission_failure.store(true, Ordering::SeqCst);
        transport
            .replies
            .send(json!({"jsonrpc":"2.0","id":id,
            "method":"session/request_permission","params":{
                "sessionId":"original-fixture-session","options":[],
                "toolCall":{"toolCallId":"original-tool","status":"pending"}}}))
            .await
            .unwrap();
        let (mut peer, result) = execution.await.unwrap();
        let denied = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(reply) = transport
                    .sent
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|frame| frame.get("id") == Some(&id) && frame.get("result").is_some())
                    .cloned()
                {
                    break reply;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await;
        peer.shutdown().await;
        assert!(result.is_err());
        assert_eq!(denied.unwrap()["result"]["outcome"]["outcome"], "cancelled");
        assert_eq!(
            transport
                .sent
                .lock()
                .unwrap()
                .iter()
                .filter(|frame| frame.get("id") == Some(&id) && frame.get("result").is_some())
                .count(),
            1
        );
    }
}

#[tokio::test(start_paused = true)]
async fn invalid_prompt_notification_uses_the_original_owned_cancel_policy() {
    let transport = FixtureTransport::new();
    transport.hold_prompt.store(true, Ordering::SeqCst);
    let host = FixtureHost::new(true);
    host.allow_close.store(true, Ordering::SeqCst);
    host.allow_settlement.store(true, Ordering::SeqCst);
    let mut peer = connect(transport.clone(), host).await.unwrap();
    peer.initialize(&CancellationToken::new()).await.unwrap();
    let execution = tokio::spawn(async move {
        let result = peer
            .prompt_once(
                vec![OutboundContentBlock::Text(OutboundTextContent::new(
                    "one original prompt",
                ))],
                &CancellationToken::new(),
                Duration::from_secs(10),
            )
            .await;
        (peer, result)
    });
    transport.wait_for_prompt().await;
    transport
        .replies
        .send(json!({"jsonrpc":"2.0","method":"unsupported/notification"}))
        .await
        .unwrap();
    let (mut peer, result) = execution.await.unwrap();
    let cancelled = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if transport
                .sent
                .lock()
                .unwrap()
                .iter()
                .any(|frame| frame["method"] == "session/cancel")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await;
    peer.shutdown().await;
    assert!(result.is_err());
    assert!(
        cancelled.is_ok(),
        "the original prompt must enter its owned cancellation policy"
    );
}

#[tokio::test(start_paused = true)]
async fn cancel_observation_failure_is_unknown_without_spending_the_entire_grace() {
    let transport = FixtureTransport::new();
    transport.hold_prompt.store(true, Ordering::SeqCst);
    let host = FixtureHost::new(true);
    host.allow_settlement.store(true, Ordering::SeqCst);
    host.observation_failure.store(true, Ordering::SeqCst);
    let mut peer = connect(transport.clone(), host.clone()).await.unwrap();
    peer.initialize(&CancellationToken::new()).await.unwrap();
    let execution = tokio::spawn(async move {
        let result = peer
            .prompt_once(
                vec![OutboundContentBlock::Text(OutboundTextContent::new(
                    "one original prompt",
                ))],
                &CancellationToken::new(),
                Duration::from_secs(10),
            )
            .await;
        (peer, result)
    });
    transport.wait_for_prompt().await;
    let began = tokio::time::Instant::now();
    transport
        .replies
        .send(json!({"jsonrpc":"2.0","method":"unsupported/notification"}))
        .await
        .unwrap();
    let (mut peer, result) = execution.await.unwrap();
    let elapsed = began.elapsed();
    peer.shutdown().await;
    assert!(result.is_err());
    assert_eq!(host.cancel_started.load(Ordering::SeqCst), 1);
    assert_eq!(host.cancel_finished.load(Ordering::SeqCst), 1);
    assert!(
        elapsed < Duration::from_secs(1),
        "observation failure burned {elapsed:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn an_unknown_prompt_receipt_failure_keeps_the_original_close_lane_and_error() {
    let transport = FixtureTransport::new();
    transport.hold_prompt.store(true, Ordering::SeqCst);
    let host = FixtureHost::new(true);
    host.allow_close.store(true, Ordering::SeqCst);
    host.allow_settlement.store(true, Ordering::SeqCst);
    host.unknown_failure.store(true, Ordering::SeqCst);
    let mut peer = connect(transport.clone(), host.clone()).await.unwrap();
    peer.initialize(&CancellationToken::new()).await.unwrap();
    let execution = tokio::spawn(async move {
        let result = peer
            .prompt_once(
                vec![OutboundContentBlock::Text(OutboundTextContent::new(
                    "one original prompt",
                ))],
                &CancellationToken::new(),
                Duration::from_secs(10),
            )
            .await;
        (peer, result)
    });
    transport.wait_for_prompt().await;
    transport
        .replies
        .send(json!({"jsonrpc":"2.0","method":"unsupported/notification"}))
        .await
        .unwrap();
    let (mut peer, result) = execution.await.unwrap();
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("the protocol failure must remain a failure"),
    };
    let closed = peer
        .close_owned_native_original(&original_close_fixture())
        .await;
    peer.shutdown().await;
    assert!(!format!("{error:#}").contains("PRIVATE_PROMPT_JOURNAL_DETAIL"));
    assert!(
        closed.is_ok(),
        "retained original close was lost: {closed:?}"
    );
    assert_eq!(
        host.unknown
            .lock()
            .unwrap()
            .iter()
            .filter(|effect| **effect == OutboundEffect::Prompt)
            .count(),
        1
    );
}

#[tokio::test(start_paused = true)]
async fn session_receipt_errors_retain_only_original_close_without_fabricating_a_session() {
    for failure in [1, 2, 3] {
        let transport = FixtureTransport::new();
        transport.session_failure.store(failure, Ordering::SeqCst);
        let host = FixtureHost::new(true);
        host.allow_close.store(true, Ordering::SeqCst);
        host.unknown_failure.store(true, Ordering::SeqCst);
        host.session_receipt_failure
            .store(failure == 3, Ordering::SeqCst);
        let mut peer = connect(transport.clone(), host.clone()).await.unwrap();
        peer.initialize(&CancellationToken::new()).await.unwrap();
        let result = peer
            .prompt_once(
                vec![OutboundContentBlock::Text(OutboundTextContent::new(
                    "one original prompt",
                ))],
                &CancellationToken::new(),
                Duration::from_secs(10),
            )
            .await;
        let closed = peer
            .close_owned_native_original(&original_close_fixture())
            .await;
        peer.shutdown().await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("the missing session receipt must remain unknown"),
        };
        assert!(!format!("{error:#}").contains("PRIVATE_"));
        assert!(
            closed.is_ok(),
            "failure {failure} lost the original close lane: {closed:?}"
        );
        assert_eq!(
            host.unknown
                .lock()
                .unwrap()
                .iter()
                .filter(|effect| **effect == OutboundEffect::Session)
                .count(),
            1
        );
        assert!(
            !transport
                .sent
                .lock()
                .unwrap()
                .iter()
                .any(|frame| frame["method"] == "session/prompt"
                    || frame["method"] == "session/cancel")
        );
    }
}
