//! DI coverage for the real destination State/lease/driver and its asynchronous private transport.
//! This is not a Gateway/account/network or platform acceptance test.
use super::*;
use crate::app_server::session_messages::{
    backchannel::{PeerRouterBackchannel, PeerTargetBackchannel},
    delivery::DestinationPeerMessageDriver,
    router_store::{IncomingPeerOperation, NativePeerRouterStore},
    service::{LivePeerSource, LocalPeerSourceAuthorization, PeerRouterLaunch},
};
use kcoder_app_protocol::{RetentionParentLaunchV1, RetentionPrincipalV1, cross_session_router::*};
use kcoder_cli_storage::session_lease::{NativeSessionLeaseWitness, SessionLease};
use kcoder_config::{ConfigPaths, PrivateDirectory};
use kcoder_types::{Message, cross_session_messages::*, session_address::SessionAddressV1};
use serde_json::{Value, json};
use std::{
    ffi::OsStr,
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

struct TargetHolder {
    state: AppState,
    owner: AppStateLifecycleIdentity,
    history: PathBuf,
    lease: NativeSessionLeaseWitness,
    address: SessionAddressV1,
    active: AtomicBool,
}
impl LocalPeerSourceAuthorization for TargetHolder {
    fn check_current(
        &self,
        _: &AppState,
        _: &AppStateLifecycleIdentity,
        _: &AgentMessageIntent,
    ) -> Result<()> {
        anyhow::bail!("fixture receiver never grants any source admission")
    }
}
impl LivePeerSource for TargetHolder {
    fn address(&self) -> Result<SessionAddressV1> {
        ensure!(
            self.active.load(Ordering::SeqCst) && self.owner.try_matches(&self.state) == Some(true),
            "fixture target revoked"
        );
        self.lease.verify_target(&self.history)?;
        Ok(self.address.clone())
    }
    fn admit_original(&self, _: &AgentMessageIntent) -> Result<()> {
        anyhow::bail!("fixture has no source authority")
    }
    fn verify_original(&self, _: &PeerMessageAttestationClaimsV1) -> Result<PeerRouterOperationV1> {
        anyhow::bail!("fixture has no source authority")
    }
}
struct NoLocalFallback;
#[async_trait]
impl PeerDeliveryAuthorizationResolver for NoLocalFallback {
    async fn resolve(
        &self,
        _: &PeerMessageCall,
        _: &CrossSessionMessageRecord,
    ) -> std::result::Result<Arc<dyn PeerMessageAuthorization>, PeerDeliveryResolutionError> {
        panic!("a different Native target must never fall back to local authorization")
    }
}

#[tokio::test(flavor = "current_thread")]
async fn every_remote_access_has_a_fresh_owned_round_trip_and_revocation_stops_wake() -> Result<()>
{
    routed_access_case(false).await
}

#[tokio::test(flavor = "current_thread")]
async fn gateway_import_on_the_same_physical_profile_still_checks_route_and_revocation()
-> Result<()> {
    routed_access_case(true).await
}

async fn routed_access_case(same_profile: bool) -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-remote-driver-di")?;
    let workspace = root.path().join("workspace");
    PrivateDirectory::open_or_create(&workspace)?;
    let profile_path = root.path().join("destination-profile");
    let profile = PrivateDirectory::open_or_create(&profile_path)?;
    profile.atomic_replace(
        OsStr::new("settings.json"),
        br#"{"cross_session_messages":{"enabled":true,"wake_idle":true}}"#,
    )?;
    let paths =
        ConfigPaths::with_config_dir_and_executable_dir(&workspace, profile_path.clone(), None);
    let service = PeerMessageService::capture(
        paths,
        workspace.clone(),
        Some(PeerRouterLaunch {
            parent: RetentionParentLaunchV1::LocalOs,
            account_root: profile_path,
        }),
    )?;
    let engine = crate::app_server::tests::catalog_list_test_engine(&workspace);
    let history = workspace
        .join("interactive-artifacts")
        .join(format!("{}.jsonl", engine.session_id()));
    let lease = SessionLease::acquire(&history)?;
    engine.state.with_history_path(&history);
    engine
        .state
        .add_message(Message::user_text("Original destination task"));
    engine.state.flush_history().await?;
    let address = service.address(&engine.session_id())?;
    let holder = Arc::new(TargetHolder {
        state: engine.state.clone(),
        owner: engine.state.inspection_lifecycle_identity(),
        history,
        lease: lease.native_witness()?,
        address: address.clone(),
        active: AtomicBool::new(true),
    });
    service.register_live_source(holder.clone())?;
    let source_profile = PrivateDirectory::open_or_create(&root.path().join("source-profile"))?;
    let other_source_store = NativePeerRouterStore::create_in(
        &source_profile,
        OsStr::new("original-router"),
        &RetentionPrincipalV1::LocalOs,
    )?;
    let local_authority = service.authority()?;
    let source_store = if same_profile {
        local_authority.store()?
    } else {
        &other_source_store
    };
    let source_workspace = if same_profile {
        service.identity()?.workspace_id
    } else {
        "source-workspace".into()
    };
    let source_identity = source_store.identity(&source_workspace)?;
    let source = SessionAddressV1 {
        target_id: source_identity.target_id.clone(),
        workspace_id: source_identity.workspace_id.clone(),
        thread_id: "same-source-name".into(),
    };
    let intent = AgentMessageIntent {
        reply_to_message_id: None,
        target_thread_id: address.thread_id.clone(),
        target_address: Some(address),
        client_message_id: "frozen-remote-operation".into(),
        mode: AgentMessageMode::WakeIfIdle,
        expected_turn_id: None,
        text: "An untrusted contribution from another actual Native namespace".into(),
    };
    let operation_id = PeerMessageService::operation_id(&source, &intent.client_message_id)?;
    source_store.prepare(&operation_id, source.clone(), &intent)?;
    let operation = source_store.mark_dispatching(&operation_id)?;
    service
        .authority()?
        .store()?
        .remember_incoming(IncomingPeerOperation {
            source_identity: source_identity.clone(),
            destination_identity: service.identity()?,
            attestation: operation.attestation.clone(),
        })?;
    let native_source = CrossSessionMessageSource {
        thread_id: source.thread_id.clone(),
        address: Some(source),
        principal_id: format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "kcoder.peer-message.source.v1",
                &source_identity.target_id,
                &source_identity.identity_epoch
            ))?)
        ),
    };
    let queue = service.mailbox()?;
    queue.enqueue(&native_source, intent, queue.revision()?)?;
    let (output, mut input) = tokio::sync::mpsc::channel(32);
    let bridge = PeerRouterBackchannel::new(output);
    bridge.negotiate(true);
    let target = Arc::new(PeerTargetBackchannel::capture(
        bridge.clone(),
        service.clone(),
        &engine,
        lease.native_witness()?,
    )?);
    let native_ledger = service
        .profile_path()
        .join("peer-router-v1/router-operations.json");
    let resolver = Arc::new(RoutedPeerDeliveryResolver::new(
        service,
        target,
        Arc::new(NoLocalFallback),
    ));
    let driver = DestinationPeerMessageDriver::new(
        engine.state.clone(),
        engine.state.inspection_lifecycle_identity(),
        lease.native_witness()?,
        queue.clone(),
        resolver,
    )?;
    let engine = engine.with_peer_message_host(Arc::new(driver));
    let deny = Arc::new(AtomicBool::new(false));
    let remote_deny = deny.clone();
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let seen = requests.clone();
    let replies = bridge.clone();
    let responder = tokio::spawn(async move {
        let mut append_checks = 0;
        while let Some(frame) = input.recv().await {
            assert_eq!(frame["params"]["kind"], "verifyOriginal");
            assert!(
                frame["params"]["sourceAttempt"].is_null(),
                "idle targets never forge an active source turn"
            );
            assert_eq!(
                frame["params"]["payload"]["attestation"],
                serde_json::to_value(&operation.attestation).unwrap()
            );
            seen.lock().unwrap().push(frame.clone());
            let is_append = frame["params"]["payload"]["access"] == "append";
            if is_append {
                append_checks += 1;
            }
            let response = if is_append && append_checks == 2 {
                json!({"id":frame["id"],"error":{"code":-32034,"message":"owned Source native store busy before writer"}})
            } else if remote_deny.load(Ordering::SeqCst) {
                json!({"id":frame["id"],"error":{"code":-32034,"message":"source revoked"}})
            } else {
                json!({"id":frame["id"],"result":operation})
            };
            assert!(replies.route_response(&response));
        }
    });
    let deferred = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        engine.apply_peer_messages_at_idle(),
    )
    .await?
    .map_err(anyhow::Error::msg)?;
    assert!(deferred.is_empty());
    let deferred_receipt = queue
        .get_by_client_id(&native_source, "frozen-remote-operation")?
        .unwrap();
    assert_eq!(
        deferred_receipt.status,
        AgentMessageStatus::Queued,
        "a fresh failed Source check before any writer is safely deferred, never poisoned Unknown"
    );
    assert!(
        engine
            .state
            .messages()
            .iter()
            .all(|message| !message.has_peer_agent_metadata())
    );
    assert!(
        kcoder_state::load_transcript_history(&engine.state.history_path().unwrap())?
            .iter()
            .all(|entry| !entry.message.has_peer_agent_metadata())
    );
    let witnesses = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        engine.apply_peer_messages_at_idle(),
    )
    .await?
    .map_err(anyhow::Error::msg)?;
    assert_eq!(witnesses.len(), 1);
    assert_eq!(
        queue
            .get_by_client_id(&native_source, "frozen-remote-operation")?
            .unwrap()
            .status,
        AgentMessageStatus::Applied
    );
    assert_eq!(
        queue
            .get_by_client_id(&native_source, "frozen-remote-operation")?
            .unwrap()
            .message_id,
        deferred_receipt.message_id
    );
    assert_eq!(
        kcoder_state::load_transcript_history(&engine.state.history_path().unwrap())?
            .iter()
            .filter(|entry| entry.message.has_peer_agent_metadata())
            .count(),
        1
    );
    let before = requests.lock().unwrap().len();
    assert!(
        before >= 6,
        "every Observe/Append boundary awaits its own private check"
    );
    assert!(
        engine
            .peer_idle_wake_authorized(&witnesses)
            .await
            .map_err(anyhow::Error::msg)?
    );
    assert!(requests.lock().unwrap().len() >= before + 2);
    deny.store(true, Ordering::SeqCst);
    assert_eq!(
        engine.peer_idle_wake_authorized(&witnesses).await,
        Err("peer_wake_authorization_deferred".into()),
        "a previous source allow is never cached"
    );
    deny.store(false, Ordering::SeqCst);
    if same_profile {
        let intact = std::fs::read(&native_ledger)?;
        let mut malformed: Value = serde_json::from_slice(&intact)?;
        // Incoming provenance is now in the original SQLite authority. A
        // damaged manifest must never become physical-profile local absence.
        assert_eq!(malformed["format"], "sqlite");
        assert!(
            malformed
                .as_object_mut()
                .unwrap()
                .remove("binding")
                .is_some()
        );
        std::fs::write(&native_ledger, serde_json::to_vec(&malformed)?)?;
        assert_eq!(
            engine.peer_idle_wake_authorized(&witnesses).await,
            Err("peer_wake_authorization_deferred".into()),
            "a malformed imported provenance authority must never fall back to physical-profile local authorization"
        );
        std::fs::write(&native_ledger, intact)?;
        assert!(
            engine
                .peer_idle_wake_authorized(&witnesses)
                .await
                .map_err(anyhow::Error::msg)?
        );
    }
    holder.active.store(false, Ordering::SeqCst);
    assert_eq!(
        engine.peer_idle_wake_authorized(&witnesses).await,
        Err("peer_wake_authorization_deferred".into()),
        "the actual destination holder can also revoke"
    );
    {
        let all = requests.lock().unwrap();
        assert!(
            all.iter()
                .any(|frame| frame["params"]["payload"]["access"] == "wake")
        );
        assert_eq!(
            all.iter()
                .map(|frame| frame["id"].as_str().unwrap())
                .collect::<std::collections::HashSet<_>>()
                .len(),
            all.len()
        );
    }
    bridge.close();
    responder.abort();
    let _ = responder.await;
    Ok(())
}
