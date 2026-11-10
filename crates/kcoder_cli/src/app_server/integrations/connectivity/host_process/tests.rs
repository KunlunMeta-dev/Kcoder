use super::*;
use kcoder_app_protocol::integrations::connectivity::{ConnectivityMethod, ConnectivityPort};
use kcoder_config::PrivateDirectory;
use kcoder_types::integrations::core::{
    IntegrationContractVersion, IntegrationNullable, IntegrationRequest,
};
use std::ffi::OsStr;
use std::path::PathBuf;

struct NativeReadOnlyFixture;
#[async_trait]
impl NativeConnectivityReverseHandler for NativeReadOnlyFixture {
    async fn handle(
        &self,
        _: &NativeIntegrationContext,
        _: &NativeConnectivityParent,
        _: &dyn NativeConnectivityFactPipe,
        method: &str,
        params: Value,
        _: CancellationToken,
    ) -> Result<Value> {
        match method {
            "private.host.configuration" => Ok(json!({"enabled":false})),
            "private.integration.call" => {
                ensure!(
                    params["port"] == "P-POLICY" && params["method"] == "evaluateAction",
                    "fixture permits no Runtime/model/platform action"
                );
                Ok(
                    json!({"contractVersion":"parallel-v1","requestId":params["request"]["requestId"],"status":"completed","operationId":params["request"].get("operationId").cloned().unwrap_or(Value::Null),"entityRevision":null,"observedAt":"2026-10-24T00:00:00Z","error":null,"result":{"decision":"allow","policyRevision":"owned-native-fixture","reasonCode":"READ_ONLY_PROTOCOL_FIXTURE"}}),
                )
            }
            "private.connectivity.inventory" => {
                tokio::time::sleep(Duration::from_millis(150)).await;
                Ok(json!({"tools":[],"requestRevision":"owned-no-model-request"}))
            }
            _ => anyhow::bail!("BUSINESS_PROVIDER_UNAVAILABLE"),
        }
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn gateway_fact_reads_bound_identity_io_and_reject_revocation_during_ipc() -> Result<()> {
    use crate::app_server::integrations::core::NativeIdentity;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    struct NoReverse;
    #[async_trait]
    impl super::super::host_rpc::ReverseRequest for NoReverse {
        async fn handle(&self, _: &str, _: Value) -> Result<Value> {
            anyhow::bail!("unexpected reverse request in fact-only fixture")
        }
    }

    let (_temp, native) = super::super::lease::tests::fixture()?;
    let owner = crate::app_server::NativeScopeHostBootstrap::open_gateway(native)?;
    let context = Arc::new(owner.native().recapture_for_owned_service()?);
    let caller = context.recapture_for_owned_service()?;
    let facade = Arc::new(NativeConnectivityLeaseFacade::initialize(
        &context,
        "gateway-fact-read-fixture",
    )?);
    let (mut child, parent) = super::super::lease::tests::owned_parent(&context).await?;
    parent.bind_scope_host(&context, owner.clone())?;
    let lease = facade.acquire(&context, Some(parent.clone()))?;
    let binding_hash = super::super::lease::tests::initialize_node_files(&facade, &context)?;
    facade.commit_ready(
        &context,
        Some(&parent),
        &super::super::NativeConnectivityReadyInput {
            lease_id: lease.lease_id.clone(),
            namespace_id: lease.namespace_id.clone(),
            initialization_id: lease.initialization_id,
            binding_hash,
        },
    )?;
    let (rpc, output) = HostRpc::new();
    let (local, remote) = tokio::io::duplex(16384);
    let (input, writer) = tokio::io::split(local);
    let reader_job = tokio::spawn(
        rpc.clone()
            .run_reader(BufReader::new(input), Arc::new(NoReverse)),
    );
    let writer_job = tokio::spawn(rpc.clone().run_writer(writer, output));
    let requests = Arc::new(AtomicUsize::new(0));
    let revoke_on_reply = Arc::new(AtomicBool::new(false));
    let peer = tokio::spawn({
        let requests = requests.clone();
        let revoke = revoke_on_reply.clone();
        let context = context.clone();
        let cancel = rpc.cancel.clone();
        async move {
            let (input, mut output) = tokio::io::split(remote);
            let mut lines = BufReader::new(input).lines();
            loop {
                let line = tokio::select! {
                    _ = cancel.cancelled() => break,
                    line = lines.next_line() => line?,
                };
                let Some(line) = line else { break };
                let request: Value = serde_json::from_str(&line)?;
                requests.fetch_add(1, Ordering::Relaxed);
                if revoke.swap(false, Ordering::AcqRel) {
                    let profile = context.profile()?;
                    let mut scope = context.scope().clone();
                    scope.workspace_id = IntegrationNullable::Null;
                    scope.organization_id = None;
                    NativeIdentity::observe(profile, &scope)?
                        .context("fixture identity missing")?
                        .disable(profile, "revoke-during-fact-read", 1, 1000)?;
                }
                let response =
                    json!({"jsonrpc":"2.0","id":request["id"],"result":{"controlled":true}});
                output.write_all(format!("{response}\n").as_bytes()).await?;
            }
            Ok::<_, anyhow::Error>(())
        }
    });
    let pipe = Arc::new(OwnedFactPipe {
        context: context.clone(),
        parent: parent.clone(),
        facade: facade.clone(),
        rpc: rpc.clone(),
    });
    struct UnexpectedBusinessCall(Arc<AtomicUsize>);
    #[async_trait]
    impl NativeConnectivityReverseHandler for UnexpectedBusinessCall {
        async fn handle(
            &self,
            _: &NativeIntegrationContext,
            _: &NativeConnectivityParent,
            _: &dyn NativeConnectivityFactPipe,
            _: &str,
            _: Value,
            _: CancellationToken,
        ) -> Result<Value> {
            self.0.fetch_add(1, Ordering::Relaxed);
            anyhow::bail!("retired callback reached application services")
        }
    }
    let business_calls = Arc::new(AtomicUsize::new(0));
    let dispatcher = Dispatcher {
        pipe: pipe.clone(),
        handler: Arc::new(UnexpectedBusinessCall(business_calls.clone())),
    };
    for method in [
        "private.bots.acquire",
        "private.bots.release",
        "private.workers.start",
        "private.workers.stop",
        "private.credentials.acquire",
        "private.credentials.release",
        "private.secretContexts.put",
        "private.assets.acceptChannelInput",
    ] {
        assert_eq!(
            dispatcher
                .handle(method, json!({}))
                .await
                .unwrap_err()
                .to_string(),
            "CONNECTIVITY_REVERSE_METHOD_DENIED"
        );
    }
    assert_eq!(business_calls.load(Ordering::Relaxed), 0);
    assert_eq!(requests.load(Ordering::Relaxed), 0);
    let read_lease = NativeFactReadLease {
        context: &caller,
        facade: &facade,
        parent: &parent,
        id: &lease.lease_id,
    };
    let identity_before = context.identity_checks();
    let caller_before = caller.identity_checks();
    let inspections_before = facade.ready_inspections();
    for _ in 0..8 {
        let (value, namespace) = pipe
            .read_on_lease(&read_lease, "connectivity.installationFacts", json!({}))
            .await?;
        assert_eq!(value, json!({"controlled":true}));
        assert_eq!(namespace, lease.namespace_id);
    }
    assert_eq!(context.identity_checks() - identity_before, 16);
    assert_eq!(caller.identity_checks(), caller_before);
    assert_eq!(facade.ready_inspections(), inspections_before);
    let mut wrong_scope = caller.scope().clone();
    wrong_scope.target_revision = "another-target".into();
    assert_eq!(
        pipe.read_on_lease(
            &read_lease,
            "connectivity.resolveApplicationConfiguration",
            json!({"scope":wrong_scope}),
        )
        .await
        .unwrap_err()
        .to_string(),
        "INTEGRATION_SCOPE_MISMATCH"
    );
    assert_eq!(requests.load(Ordering::Relaxed), 8);
    let wrong_lease = NativeFactReadLease {
        id: "not-the-original-lease",
        ..read_lease
    };
    assert_eq!(
        pipe.read_on_lease(&wrong_lease, "connectivity.installationFacts", json!({}))
            .await
            .unwrap_err()
            .to_string(),
        "CONNECTIVITY_LEASE_UNAVAILABLE"
    );
    assert_eq!(requests.load(Ordering::Relaxed), 8);
    revoke_on_reply.store(true, Ordering::Release);
    assert_eq!(
        pipe.read_on_lease(&read_lease, "connectivity.installationFacts", json!({}))
            .await
            .unwrap_err()
            .to_string(),
        "INTEGRATION_IDENTITY_REVOKED"
    );
    assert_eq!(requests.load(Ordering::Relaxed), 9);
    rpc.cancel.cancel();
    reader_job.await??;
    writer_job.await??;
    peer.await??;
    child.kill().await?;
    facade.release_exited_parent(&parent)?;
    Ok(())
}

#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "requires the same-source built native supervisor binary; run explicitly after cargo build"]
async fn actual_supervised_node_host_bootstraps_reads_and_reclaims_owned_tree() -> Result<()> {
    let supervisor = std::env::var_os("KCODER_CONNECTIVITY_TEST_SUPERVISOR")
        .context("same-source supervisor prerequisite missing")?;
    let supervisor = PathBuf::from(supervisor).canonicalize()?;
    let node = which::which(
        std::env::var_os("KCODER_CONNECTIVITY_TEST_NODE").unwrap_or_else(|| "node".into()),
    )?
    .canonicalize()?;
    let entry = kcoder_test_harness::workspace_root()
        .expect("resolve current workspace")
        .join("crates/kcoder_cli")
        .join("../../apps/kcoder-channel-host/src/applications/stdio.mjs")
        .canonicalize()?;
    let temp = tempfile::tempdir()?;
    let parent = PrivateDirectory::open_or_create(temp.path())?;
    parent.create_private_child(OsStr::new("profile"))?;
    parent.create_private_child(OsStr::new("workspace"))?;
    let context = Arc::new(NativeIntegrationContext::capture(
        &temp.path().join("profile"),
        &temp.path().join("workspace"),
        "owned-connection",
        "owned-settings",
    )?);
    let facade = Arc::new(NativeConnectivityLeaseFacade::initialize(
        &context,
        "owned-host-initialization",
    )?);
    let host = NativeConnectivityHost::spawn(
        context.clone(),
        facade.clone(),
        NativeConnectivityHostPaths {
            node: node.clone(),
            entry: entry.clone(),
            supervisor: supervisor.clone(),
        },
        Arc::new(NativeReadOnlyFixture),
    )
    .await?;
    let request = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "owned-read-list".into(),
        scope: context.scope().clone(),
        operation_id: None,
        expected_revision: None,
        timeout_ms: 5000,
        cancellation_ref: None,
        payload: serde_json::from_value(json!({"limit":10}))?,
    };
    let result = host
        .call(
            &ConnectivityPortCall {
                port: ConnectivityPort::Connection,
                method: ConnectivityMethod::ListConnections,
                request,
            },
            None,
        )
        .await?;
    let IntegrationNullable::Value(result) = result.result else {
        anyhow::bail!("native host returned no list")
    };
    assert_eq!(result["items"], json!([]));
    let files = host
        .read_owned(host.parent(), "connectivity.installationFacts", json!({}))
        .await?;
    assert!(files.as_array().is_some_and(|files| files.len() == 5));
    let lease_id = facade.ready_lease_id(&context, host.parent())?;
    let read_lease = NativeFactReadLease {
        context: &context,
        facade: &facade,
        parent: host.parent(),
        id: &lease_id,
    };
    let reads_before = facade.ready_inspections();
    let (bound_files, namespace) = host
        .read_on_lease(&read_lease, "connectivity.installationFacts", json!({}))
        .await?;
    assert_eq!(facade.ready_inspections() - reads_before, 2);
    assert_eq!(bound_files, files);
    assert_eq!(namespace, facade.namespace_id(&context)?);
    let mut wrong_scope = context.scope().clone();
    wrong_scope.target_revision = "other-target-revision".into();
    let reads_before_wrong_scope = facade.ready_inspections();
    let wrong_scope_error = host
        .read_on_lease(
            &read_lease,
            "connectivity.resolveIngressAuthority",
            json!({"scope":wrong_scope,"ingressId":"never-read"}),
        )
        .await
        .unwrap_err();
    assert_eq!(wrong_scope_error.to_string(), "INTEGRATION_SCOPE_MISMATCH");
    assert_eq!(facade.ready_inspections(), reads_before_wrong_scope);
    let wrong_lease = NativeFactReadLease {
        id: "not-the-original-lease",
        ..read_lease
    };
    let wrong_lease_error = host
        .read_on_lease(&wrong_lease, "connectivity.installationFacts", json!({}))
        .await
        .unwrap_err();
    assert_eq!(
        wrong_lease_error.to_string(),
        "CONNECTIVITY_LEASE_UNAVAILABLE"
    );
    let inspect = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "owned-timed-read".into(),
        scope: context.scope().clone(),
        operation_id: None,
        expected_revision: None,
        timeout_ms: 20,
        cancellation_ref: None,
        payload: serde_json::from_value(json!({}))?,
    };
    assert!(
        host.call(
            &ConnectivityPortCall {
                port: ConnectivityPort::Readiness,
                method: ConnectivityMethod::InspectReadiness,
                request: inspect
            },
            None
        )
        .await
        .is_err()
    );
    assert!(host.parent().alive()?);
    let next = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "owned-peer-safe-read".into(),
        scope: context.scope().clone(),
        operation_id: None,
        expected_revision: None,
        timeout_ms: 5000,
        cancellation_ref: None,
        payload: serde_json::from_value(json!({}))?,
    };
    host.call(
        &ConnectivityPortCall {
            port: ConnectivityPort::Connection,
            method: ConnectivityMethod::ListConnections,
            request: next,
        },
        None,
    )
    .await?;
    host.close().await?;
    assert!(!host.parent().alive()?);
    let reopen = NativeConnectivityLeaseFacade::observe(&context)?
        .context("native receipt missing after host exit")?;
    assert!(
        reopen
            .private_data_path(&context)?
            .join("connectivity.sqlite3")
            .exists()
    );
    // The original namespace reopens existing data; spontaneous owned-tree EOF
    // closes the pipe and releases only that actual process's native authority.
    let restarted = NativeConnectivityHost::spawn(
        context,
        Arc::new(reopen),
        NativeConnectivityHostPaths {
            node,
            entry,
            supervisor,
        },
        Arc::new(NativeReadOnlyFixture),
    )
    .await?;
    let pid = restarted.parent().pid;
    // SAFETY: the retained pidfd/owned helper proves this live test child identity.
    assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGTERM) }, 0);
    tokio::time::timeout(
        Duration::from_secs(8),
        restarted.pipe.rpc.cancel.cancelled(),
    )
    .await?;
    restarted.close().await?;
    assert!(!restarted.parent().alive()?);
    Ok(())
}
