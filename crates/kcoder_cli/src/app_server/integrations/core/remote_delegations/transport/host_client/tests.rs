//! Private routing fixtures; the Parent below is not production parent authority.
use super::*;
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_host_transport::native_component_parent::NativeComponentParentAuthority;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
pub(in crate::app_server::integrations::core::remote_delegations::transport) struct Parent {
    active: AtomicBool,
    profile: String,
    workspace: String,
}
impl NativeComponentParentAuthority for Parent {
    fn administrative_workspace_binding(
        &self,
    ) -> Result<(&str, kcoder_app_protocol::RetentionPrincipalV1)> {
        ensure!(self.active.load(Ordering::SeqCst), "fixture parent revoked");
        Ok((
            "fixture-workspace",
            kcoder_app_protocol::RetentionPrincipalV1::LocalOs,
        ))
    }
    fn verify_native_component_roots(
        &self,
        profile: &PrivateDirectory,
        workspace: &PrivateDirectory,
    ) -> Result<()> {
        ensure!(
            self.active.load(Ordering::SeqCst)
                && profile.directory_identity()? == self.profile
                && workspace.directory_identity()? == self.workspace,
            "fixture held roots changed"
        );
        Ok(())
    }
}

#[tokio::test]
async fn ordinary_profiles_do_not_capture_a_host_lane_but_enabled_peers_still_require_the_parent() {
    let f = super::super::super::source_budget::tests::Fixture::new();
    let parent = Arc::new(Parent {
        active: AtomicBool::new(false),
        profile: f.native.profile().unwrap().directory_identity().unwrap(),
        workspace: f.native.workspace_directory_identity().unwrap(),
    });
    let check = || {
        NativeRemoteHostClient::capture_if_configured(
            parent.clone(),
            &|| f.engine.settings_persistence_path(),
            &|| f.engine.state.cwd(),
            mpsc::channel(8).0,
        )
    };
    let peer = json!({"id":"owned-peer","enabled":false,"target":{"targetId":"owned-target",
        "targetRevision":"original-revision","targetPlatform":"linux","expectedNativeSha256":"a".repeat(64)}});
    assert!(check().unwrap().is_none());
    for configuration in [
        json!({}),
        json!({"enabled":false}),
        json!({"enabled":true,"nativeSshPeers":[]}),
        json!({"enabled":true,"nativeSshPeers":[peer.clone()]}),
    ] {
        f.native
            .profile()
            .unwrap()
            .atomic_replace(
                std::ffi::OsStr::new("settings.json"),
                &serde_json::to_vec(&json!({"integrations":{"remotes":configuration}})).unwrap(),
            )
            .unwrap();
        assert!(check().unwrap().is_none());
    }
    f.native
        .profile()
        .unwrap()
        .atomic_replace(std::ffi::OsStr::new("settings.json"), b"{invalid")
        .unwrap();
    assert!(check().is_err());
    let mut enabled = peer;
    enabled["enabled"] = json!(true);
    f.native
        .profile()
        .unwrap()
        .atomic_replace(
            std::ffi::OsStr::new("settings.json"),
            &serde_json::to_vec(
                &json!({"integrations":{"remotes":{"enabled":true,"nativeSshPeers":[enabled]}}}),
            )
            .unwrap(),
        )
        .unwrap();
    assert!(
        check()
            .unwrap_err()
            .to_string()
            .contains("fixture held roots changed")
    );
    f.close().await;
}
pub(in crate::app_server::integrations::core::remote_delegations::transport) fn fixture() -> (
    super::super::super::source_budget::tests::Fixture,
    Arc<NativeRemoteHostClient>,
    Arc<Parent>,
    mpsc::Receiver<Value>,
) {
    let fixture = super::super::super::source_budget::tests::Fixture::new();
    let parent = Arc::new(Parent {
        active: AtomicBool::new(true),
        profile: fixture
            .native
            .profile()
            .unwrap()
            .directory_identity()
            .unwrap(),
        workspace: fixture.native.workspace_directory_identity().unwrap(),
    });
    let (tx, rx) = mpsc::channel(8);
    let client = NativeRemoteHostClient::capture_after_verified_parent(
        parent.clone(),
        &|| fixture.engine.settings_persistence_path(),
        &|| fixture.engine.state.cwd(),
        tx,
    )
    .unwrap();
    (fixture, client, parent, rx)
}
#[tokio::test]
async fn old_epoch_and_response_only_client_ids_cannot_settle_a_new_private_request() {
    let (_fixture, client, _parent, mut rx) = fixture();
    let sender = client.clone();
    let request = tokio::spawn(async move {
        sender
            .request(
                NativeHostMethod::Open,
                json!({"operationId":"original"}),
                tokio::time::Instant::now() + std::time::Duration::from_secs(2),
                &CancellationToken::new(),
            )
            .await
    });
    let frame = rx.recv().await.unwrap();
    assert!(client.route_response(
        &json!({"jsonrpc":"2.0","id":"native-remote-host-old-1","result":{"forged":true}})
    ));
    assert!(!request.is_finished());
    assert!(!client.route_response(&json!({"jsonrpc":"2.0","id":"ordinary-client","result":{}})));
    assert!(
        client
            .route_response(&json!({"jsonrpc":"2.0","id":frame["id"],"result":{"original":true}}))
    );
    assert_eq!(request.await.unwrap().unwrap(), json!({"original":true}));
}
#[tokio::test]
async fn cancelled_private_request_releases_its_slot_and_late_receipt_never_reaches_the_next_request()
 {
    let (_fixture, client, _parent, mut rx) = fixture();
    let cancel = CancellationToken::new();
    let cancelled = cancel.clone();
    let sender = client.clone();
    let first = tokio::spawn(async move {
        sender
            .request(
                NativeHostMethod::Exchange,
                json!({}),
                tokio::time::Instant::now() + std::time::Duration::from_secs(2),
                &cancelled,
            )
            .await
    });
    let original = rx.recv().await.unwrap();
    cancel.cancel();
    assert!(first.await.unwrap().is_err());
    assert!(client.pending_is_empty_for_test());
    let sender = client.clone();
    let next = tokio::spawn(async move {
        sender
            .request(
                NativeHostMethod::Exchange,
                json!({}),
                tokio::time::Instant::now() + std::time::Duration::from_secs(2),
                &CancellationToken::new(),
            )
            .await
    });
    let second = rx.recv().await.unwrap();
    assert_ne!(original["id"], second["id"]);
    client.route_response(&json!({"jsonrpc":"2.0","id":original["id"],"result":{"late":true}}));
    assert!(!next.is_finished());
    client.route_response(&json!({"jsonrpc":"2.0","id":second["id"],"result":{"sameOwner":true}}));
    assert_eq!(next.await.unwrap().unwrap(), json!({"sameOwner":true}));
}
#[tokio::test]
async fn parent_revocation_and_connection_close_settle_pending_requests_as_unknown() {
    for revoked in [true, false] {
        let (_fixture, client, parent, mut rx) = fixture();
        let sender = client.clone();
        let pending = tokio::spawn(async move {
            sender
                .request(
                    NativeHostMethod::Open,
                    json!({}),
                    tokio::time::Instant::now() + std::time::Duration::from_secs(2),
                    &CancellationToken::new(),
                )
                .await
        });
        let frame = rx.recv().await.unwrap();
        if revoked {
            parent.active.store(false, Ordering::SeqCst);
            client.route_response(
                &json!({"jsonrpc":"2.0","id":frame["id"],"result":{"approved":true}}),
            );
        } else {
            client.close();
        }
        assert!(pending.await.unwrap().is_err());
        assert!(client.pending_is_empty_for_test());
    }
}
