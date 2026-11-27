use super::*;
use crate::migration_source_authority::MigrationSourceAuthority;
use kcoder_app_protocol::{
    MigrationSourceAuthorityV1, MigrationSourceEndpointV1, MigrationSourceRoleV1,
    PrivateMigrationSourceProofV1, RetentionParentLaunchV1, RetentionPrincipalV1,
};
use kcoder_config::PrivateDirectory;
use kcoder_migration::discovery::{DiscoveryRoots, SourceRegistry};
use std::path::PathBuf;

struct Fixture {
    _root: tempfile::TempDir,
    source_scope: MigrationSourceAuthority,
    _target_scope: MigrationSourceAuthority,
    source: AuthorizedMigrationPeer,
    target: AuthorizedMigrationPeer,
    source_ref: String,
    target_ref: String,
    processor: MigrationProcessor,
    source_id: String,
    originals: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let source_profile = root.path().join("source-profile");
        let target_profile = root.path().join("target-profile");
        for profile in [&source_profile, &target_profile] {
            PrivateDirectory::open_or_create(profile).unwrap();
        }
        let authority = |profile: &std::path::Path| {
            MigrationSourceAuthority::capture(&RetentionParentLaunchV1::LocalOs, profile, profile)
                .unwrap()
        };
        let source_scope = authority(&source_profile);
        let target_scope = authority(&target_profile);
        let source_id = source_scope.identity().unwrap();
        let target_id = target_scope.identity().unwrap();
        let endpoint = |native: &TransferAuthority, fingerprint: &str| MigrationSourceEndpointV1 {
            authority: MigrationSourceAuthorityV1 {
                instance_id: native.instance_id.clone(),
                account_id: native.account_id.clone(),
            },
            target_fingerprint: fingerprint.repeat(64),
            principal: RetentionPrincipalV1::LocalOs,
        };
        let request = uuid::Uuid::new_v4().to_string();
        let proof = PrivateMigrationSourceProofV1 {
            version: 1,
            request_id: request.clone(),
            source: endpoint(&source_id, "a"),
            target: endpoint(&target_id, "b"),
        };
        let source_ref = source_scope
            .accept(MigrationSourceRoleV1::Source, proof.clone())
            .unwrap();
        let target_ref = target_scope
            .accept(MigrationSourceRoleV1::Target, proof)
            .unwrap();
        let source = source_scope.peer(&request, &source_ref).unwrap();
        let target = target_scope.peer(&request, &target_ref).unwrap();
        let originals = root.path().join("selected-originals");
        PrivateDirectory::open_or_create(&originals).unwrap();
        std::fs::write(
            originals.join("settings.json"),
            "{\"model\":\"fixture-model\"}",
        )
        .unwrap();
        let mut registry = SourceRegistry::new(DiscoveryRoots {
            home: root.path().into(),
            claude_config_dir: Some(originals.clone()),
            codex_home: None,
            project: None,
        });
        let (catalog, _) = registry.discover(
            &[kcoder_types::migration::MigrationSourceKind::ClaudeCode],
            false,
        );
        let source_id = catalog
            .iter()
            .find(|entry| entry.scope == "user")
            .unwrap()
            .source_id
            .clone();
        let processor = MigrationProcessor::new();
        *processor.registry.lock().unwrap() = Some(registry);
        Self {
            _root: root,
            source_scope,
            _target_scope: target_scope,
            source,
            target,
            source_ref,
            target_ref,
            processor,
            source_id,
            originals,
        }
    }
    fn call_with(
        &self,
        processor: &MigrationProcessor,
        operation: &str,
        mut value: Value,
    ) -> Result<Value> {
        let (peer, reference) = if operation.starts_with("source/") {
            (&self.source, &self.source_ref)
        } else {
            (&self.target, &self.target_ref)
        };
        let object = value.as_object_mut().unwrap();
        object.insert("requestId".into(), json!(peer.request_id()));
        object.insert("peerRef".into(), json!(reference));
        execute(processor, peer, operation, value)
    }
    fn call(&self, operation: &str, value: Value) -> Value {
        self.call_with(&self.processor, operation, value).unwrap()
    }
    fn prepare(&self) -> Value {
        let destination = self.call("target/grant", json!({}));
        self.call("source/prepare", json!({"destination":destination,"selections":[{"kind":"configuration","sourceId":self.source_id}]}))
    }
    async fn settled(&self) -> Value {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let state = self.call("source/state", json!({}));
            if state["capture"]["status"] != "running" {
                return state;
            }
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }
}

#[tokio::test]
async fn actual_authorized_host_flow_keeps_raw_bytes_private_and_reopens_without_the_registry() {
    let f = Fixture::new();
    let prepared = f.prepare();
    assert!(
        prepared["selectionDigest"]
            .as_str()
            .is_some_and(|s| s.len() == 64)
    );
    f.call("source/capture", json!({}));
    let captured = f.settled().await;
    assert_eq!(captured["capture"]["status"], "ready");
    assert_eq!(captured["state"]["ready"], true);
    *f.processor.registry.lock().unwrap() = None;
    std::fs::remove_dir_all(&f.originals).unwrap();
    assert_eq!(f.prepare()["selectionDigest"], prepared["selectionDigest"]);
    let manifest = f.call("source/manifest", json!({}));
    f.call("target/begin", json!({"manifest":manifest["manifest"]}));
    let entry = manifest["manifest"]["entries"][0]["id"].clone();
    let chunk = f.call("source/chunk", json!({"entryId":entry,"index":0}));
    f.call("target/part/write", chunk);
    let committed = f.call("target/finish", json!({}));
    assert_eq!(f.call("target/receipt", json!({})), committed);
    assert_eq!(f.call("target/state", json!({}))["state"]["ready"], true);
    assert!(!f.target.profile().join("settings.json").exists());
    f.processor.shutdown().await;
}

#[tokio::test]
async fn frozen_independent_native_watermark_and_late_host_cancel_are_never_replayed() {
    let f = Fixture::new();
    f.prepare();
    let command = uuid::Uuid::new_v4().to_string();
    let cancelled = f.call("source/cancel", json!({"commandId":command}));
    let native = SourceTransfers::open(f.source.profile()).unwrap();
    let destination = native
        .prepared_destination(f.source.request_id(), f.source.target_authority())
        .unwrap()
        .unwrap();
    native
        .cancel(
            f.source.request_id(),
            &destination,
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    let resume = |view: &Value| json!({"expectedSequence":view["state"]["sequence"],"expectedCancelWatermark":view["state"]["cancelWatermark"],"expectedSnapshotControl":view["snapshotControl"]});
    assert!(
        f.call_with(&f.processor, "source/resume", resume(&cancelled))
            .is_err()
    );
    let newer = f.call("source/state", json!({}));
    assert_eq!(newer["state"]["cancelled"], true);
    assert!(
        newer["snapshotControl"]["cancelWatermark"]
            .as_u64()
            .unwrap()
            > cancelled["snapshotControl"]["cancelWatermark"]
                .as_u64()
                .unwrap()
    );
    f.call("source/resume", resume(&newer));
    let late = f.call("source/cancel", json!({"commandId":command}));
    assert_eq!(late["state"]["cancelled"], false);
    assert_eq!(late["snapshotControl"]["cancelled"], false);
    f.processor.shutdown().await;
}

#[tokio::test]
async fn failed_background_capture_is_durable_and_never_reported_as_infinite_running_after_reopen()
{
    let f = Fixture::new();
    f.prepare();
    std::fs::write(
        f.originals.join("settings.json"),
        "{\"model\":\"source-changed\"}",
    )
    .unwrap();
    f.call("source/capture", json!({}));
    let failed = f.settled().await;
    assert_eq!(failed["capture"]["status"], "failed");
    assert!(failed["capture"]["errorCode"].as_str().is_some());
    f.processor.shutdown().await;
    let reopened = MigrationProcessor::new();
    assert_eq!(
        f.call_with(&reopened, "source/state", json!({})).unwrap()["capture"],
        failed["capture"]
    );
    assert!(f.call_with(&reopened, "source/capture", json!({})).is_err());
    reopened.shutdown().await;
}

#[tokio::test]
async fn a_closed_verified_connection_or_wrong_role_cannot_use_the_saved_grant() {
    let f = Fixture::new();
    let params = json!({"requestId":f.source.request_id(),"peerRef":f.source_ref});
    assert!(execute(&f.processor, &f.source, "target/grant", params).is_err());
    f.source_scope.close();
    assert!(
        f.call_with(&f.processor, "source/state", json!({}))
            .is_err()
    );
    f.processor.shutdown().await;
}

#[tokio::test]
async fn recovered_target_cancel_before_begin_blocks_the_full_peer_and_resume_checks_both_domains()
{
    let f = Fixture::new();
    f.prepare();
    f.call("source/capture", json!({}));
    assert_eq!(f.settled().await["capture"]["status"], "ready");
    let manifest = f.call("source/manifest", json!({}));
    let source_control = f.call("source/state", json!({}));
    f.source_scope.close();
    let (reference, _) = f
        ._target_scope
        .recover_target(f.target.request_id())
        .unwrap();
    let peer = f
        ._target_scope
        .peer(f.target.request_id(), &reference)
        .unwrap();
    let call = |method: &str, mut params: Value| {
        params["requestId"] = json!(peer.request_id());
        params["peerRef"] = json!(reference);
        execute(&f.processor, &peer, method, params)
    };
    for method in [
        "target/grant",
        "target/begin",
        "target/part/write",
        "source/state",
    ] {
        assert!(call(method, json!({})).is_err());
    }
    call(
        "target/cancel",
        json!({"commandId":uuid::Uuid::new_v4().to_string()}),
    )
    .unwrap();
    let one = call("target/summary", json!({})).unwrap();
    assert!(one["state"].is_null() && one["progress"].is_null());
    assert_eq!(one["admissionControl"]["cancelled"], true);
    assert!(
        f.call_with(
            &f.processor,
            "target/begin",
            json!({"manifest":manifest["manifest"]})
        )
        .is_err()
    );
    call(
        "target/cancel",
        json!({"commandId":uuid::Uuid::new_v4().to_string()}),
    )
    .unwrap();
    assert!(call("target/resume", json!({"expectedAdmissionControl":one["admissionControl"],"expectedOperationControl":null})).is_err());
    let two = call("target/summary", json!({})).unwrap();
    call(
        "target/resume",
        json!({"expectedAdmissionControl":two["admissionControl"],"expectedOperationControl":null}),
    )
    .unwrap();
    f.call("target/begin", json!({"manifest":manifest["manifest"]}));
    let source = SourceTransferIntents::open(f.source.profile()).unwrap();
    let snapshot = SourceTransfers::open(f.source.profile()).unwrap();
    let destination = source
        .destination(f.source.request_id(), f.source.target_authority())
        .unwrap();
    assert_eq!(
        source.state(f.source.request_id(), true).unwrap(),
        serde_json::from_value::<TransferState>(source_control["state"].clone()).unwrap()
    );
    assert_eq!(
        snapshot.state(f.source.request_id(), &destination).unwrap(),
        serde_json::from_value::<TransferState>(source_control["snapshotControl"].clone()).unwrap()
    );
    f.processor.shutdown().await;
}

#[tokio::test]
async fn durable_attempt_owns_target_mutations_and_an_old_id_never_regains_execution_after_reopen()
{
    let f = Fixture::new();
    f.prepare();
    f.call("source/capture", json!({}));
    assert_eq!(f.settled().await["capture"]["status"], "ready");
    let manifest = f.call("source/manifest", json!({}));
    let id = uuid::Uuid::new_v4().to_string();
    let claim = |id: &str| json!({"attemptId":id,"kind":"run","callDigest":"a".repeat(64),"selectionDigest":"b".repeat(64)});
    let accepted = f.call("target/attempt/claim", claim(&id));
    assert_eq!(accepted["admitted"], true);
    assert_eq!(accepted["view"]["running"], true);
    let other = MigrationProcessor::new();
    assert_eq!(
        f.call_with(&other, "target/attempt/claim", claim(&id))
            .unwrap()["admitted"],
        false
    );
    assert!(
        f.call_with(
            &other,
            "target/attempt/claim",
            claim(&uuid::Uuid::new_v4().to_string())
        )
        .is_err()
    );
    let begin = json!({"manifest":manifest["manifest"]});
    assert!(
        f.call_with(&other, "target/begin", begin.clone())
            .unwrap_err()
            .to_string()
            .contains("attempt_owner_required")
    );
    f.call("target/begin", begin.clone());
    f.call("target/attempt/release", json!({"attemptId":id}));
    assert_eq!(
        f.call_with(&other, "target/attempt/claim", claim(&id))
            .unwrap()["admitted"],
        false
    );
    let fresh = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        f.call_with(&other, "target/attempt/claim", claim(&fresh))
            .unwrap()["admitted"],
        true
    );
    f.call_with(&other, "target/begin", begin).unwrap();
    other.shutdown().await;
    assert_eq!(
        f.call("target/attempt/read", json!({"attemptId":fresh}))["view"]["running"],
        false
    );
    f.processor.shutdown().await;
}

#[tokio::test]
async fn a_recovered_reference_cannot_claim_a_run_or_release_the_full_peers_execution_owner() {
    let f = Fixture::new();
    f.prepare();
    let id = uuid::Uuid::new_v4().to_string();
    f.call("target/attempt/claim", json!({"attemptId":id,"kind":"run","callDigest":"a".repeat(64),"selectionDigest":"b".repeat(64)}));
    let (reference, _) = f
        ._target_scope
        .recover_target(f.target.request_id())
        .unwrap();
    let peer = f
        ._target_scope
        .peer(f.target.request_id(), &reference)
        .unwrap();
    let call = |method: &str, mut v: Value| {
        v["requestId"] = json!(peer.request_id());
        v["peerRef"] = json!(reference);
        execute(&f.processor, &peer, method, v)
    };
    assert!(call("target/attempt/release", json!({"attemptId":id})).is_err());
    assert!(call("target/attempt/claim", json!({"attemptId":uuid::Uuid::new_v4().to_string(),"kind":"run","callDigest":"a".repeat(64),"selectionDigest":"b".repeat(64)})).is_err());
    assert_eq!(
        f.call("target/attempt/read", json!({"attemptId":id}))["view"]["running"],
        true
    );
    f.processor.shutdown().await;
}

#[tokio::test]
async fn source_codex_capture_rechecks_project_trust_after_preparation_without_publishing_a_snapshot()
 {
    let mut f = Fixture::new();
    let repo = f._root.path().join("codex-project");
    let cwd = repo.join("nested");
    for path in [&repo, &repo.join(".git"), &cwd, &cwd.join(".codex")] {
        PrivateDirectory::open_or_create(path).unwrap();
    }
    std::fs::write(f.originals.join("config.toml"), "model='original-model'\nmodel_provider='Office'\n[model_providers.Office]\nbase_url='https://example.invalid/v1'\nwire_api='responses'\n").unwrap();
    std::fs::write(cwd.join(".codex/config.toml"), "model='project-model'\n").unwrap();
    let trust = f.source.profile().join("trusted-folders.json");
    std::fs::write(
        &trust,
        serde_json::to_vec(&json!({"trusted":[repo],"never":[]})).unwrap(),
    )
    .unwrap();
    let mut registry = SourceRegistry::new(DiscoveryRoots {
        home: f._root.path().into(),
        claude_config_dir: None,
        codex_home: Some(f.originals.clone()),
        project: Some(cwd.clone()),
    });
    let (found, _) =
        registry.discover(&[kcoder_types::migration::MigrationSourceKind::Codex], true);
    let selected = found.iter().find(|source| source.scope == "user").unwrap();
    let layered = registry
        .select_codex_layers(&selected.source_id, &repo, &cwd)
        .unwrap();
    f.source_id = layered.source.source_id;
    *f.processor.registry.lock().unwrap() = Some(registry);
    f.prepare();
    std::fs::write(
        trust,
        serde_json::to_vec(&json!({"trusted":[],"never":[repo]})).unwrap(),
    )
    .unwrap();
    f.processor
        .source_transfer_workers
        .start(f.source.clone())
        .unwrap();
    let observed = f.settled().await;
    assert_eq!(observed["capture"]["status"], "failed");
    assert_eq!(observed["snapshotControl"]["ready"], false);
    assert!(observed["state"]["manifest"].is_null());
    f.processor.source_transfer_workers.shutdown().await;
}
