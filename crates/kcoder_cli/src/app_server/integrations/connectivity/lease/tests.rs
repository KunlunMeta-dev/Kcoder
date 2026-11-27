use super::test_support::{self, fixture, owned_parent};
use super::*;
use std::ffi::OsStr;

#[test]
fn native_observation_is_read_only_and_missing_authority_never_creates() -> Result<()> {
    let (temp, context) = fixture()?;
    let identity_metadata = std::fs::read_dir(temp.path().join("profile"))?.count();
    assert!(NativeConnectivityLeaseFacade::observe(&context)?.is_none());
    assert_eq!(
        std::fs::read_dir(temp.path().join("profile"))?.count(),
        identity_metadata
    );
    let factory = NativeConnectivityLeaseFacade::initialize(&context, "native-first-write")?;
    assert!(factory.acquire(&context, None).is_err());
    let directory = factory.verify(&context)?;
    assert_eq!(
        control::read_log(
            &factory.log_anchor,
            &factory.initial,
            &factory.initial_identity
        )?
        .len(),
        1
    );
    let before_path = context.identity_checks();
    let path = factory.private_data_path(&context)?;
    assert_eq!(context.identity_checks() - before_path, 1);
    assert!(!path.join("connectivity.sqlite3").exists());
    control::data_directory(&directory, &factory.initial)?;
    Ok(())
}

#[tokio::test]
async fn actual_kernel_lease_rejects_peer_and_survives_lost_initialization_ack() -> Result<()> {
    let (_temp, context) = fixture()?;
    let factory = NativeConnectivityLeaseFacade::initialize(&context, "native-first-write")?;
    let (mut child, parent) = owned_parent(&context).await?;
    let lease = factory.acquire(&context, Some(parent.clone()))?;
    assert_eq!(lease.stage, "initializing");
    assert_eq!(lease.store_mode, "create");
    assert!(factory.ready_lease_id(&context, &parent).is_err());
    assert!(
        factory
            .require_ready(&context, Some(&parent), &lease.lease_id)
            .is_err()
    );
    assert_eq!(factory.acquire(&context, Some(parent.clone()))?, lease);
    assert!(!factory.release(&context, Some(&parent), &lease.lease_id)?);
    let peer_factory = NativeConnectivityLeaseFacade::observe(&context)?.unwrap();
    let (mut peer_child, peer_parent) = owned_parent(&context).await?;
    assert!(
        peer_factory
            .acquire(&context, Some(peer_parent.clone()))
            .is_err()
    );
    child.kill().await?;
    child.wait().await?;
    assert!(factory.release(&context, Some(&parent), &lease.lease_id)?);
    let recovered = peer_factory.acquire(&context, Some(peer_parent.clone()))?;
    assert_eq!(recovered.store_mode, "open_existing");
    assert_eq!(recovered.stage, "reconciling");
    assert!(
        !peer_factory
            .private_data_path(&context)?
            .join("connectivity.sqlite3")
            .exists()
    );
    peer_child.kill().await?;
    peer_child.wait().await?;
    assert!(peer_factory.release(&context, Some(&peer_parent), &recovered.lease_id)?);
    Ok(())
}

#[tokio::test]
async fn scope_changes_and_foreign_parent_cannot_renew_or_release_a_real_lease() -> Result<()> {
    let (temp, context) = fixture()?;
    let factory = NativeConnectivityLeaseFacade::initialize(&context, "native-first-write")?;
    let (mut child, parent) = owned_parent(&context).await?;
    let lease = factory.acquire(&context, Some(parent.clone()))?;
    let (mut other, other_parent) = owned_parent(&context).await?;
    assert!(
        factory
            .renew(&context, Some(&other_parent), &lease.lease_id)
            .is_err()
    );
    assert!(
        factory
            .release(&context, Some(&other_parent), &lease.lease_id)
            .is_err()
    );
    let changed = NativeIntegrationContext::capture(
        &temp.path().join("profile"),
        &temp.path().join("workspace"),
        "connection-2",
        "configuration-1",
    )?;
    // A transport nonce is not the persistent native principal generation.
    factory.renew(&changed, Some(&parent), &lease.lease_id)?;
    let revised = NativeIntegrationContext::capture(
        &temp.path().join("profile"),
        &temp.path().join("workspace"),
        "connection-3",
        "configuration-2",
    )?;
    assert!(
        factory
            .renew(&revised, Some(&parent), &lease.lease_id)
            .is_err()
    );
    child.kill().await?;
    child.wait().await?;
    factory.release(&context, Some(&parent), &lease.lease_id)?;
    other.kill().await?;
    other.wait().await?;
    Ok(())
}

#[tokio::test]
async fn parent_exit_wait_sleeps_on_kernel_handles_and_stays_bounded() -> Result<()> {
    let (_temp, context) = fixture()?;
    let (mut child, parent) = owned_parent(&context).await?;
    // A live parent is never reported exited; the wait ends at its budget.
    let started = std::time::Instant::now();
    assert!(!parent.wait_exited_blocking(Duration::from_millis(150))?);
    assert!(started.elapsed() >= Duration::from_millis(150));
    // The actual exit wakes the blocked waiter well before its long budget.
    let waiter = std::thread::spawn({
        let parent = parent.clone();
        move || {
            let started = std::time::Instant::now();
            (
                parent.wait_exited_blocking(Duration::from_secs(60)),
                started.elapsed(),
            )
        }
    });
    child.start_kill()?;
    child.wait().await?;
    let (exited, elapsed) = waiter.join().unwrap();
    assert!(exited?);
    assert!(elapsed < Duration::from_secs(20), "{elapsed:?}");
    assert!(!parent.alive()?);
    assert!(wait_parent_exit_blocking(&parent));
    Ok(())
}

#[test]
fn missing_or_replaced_native_control_is_not_reinitialized() -> Result<()> {
    let (_temp, context) = fixture()?;
    let factory = NativeConnectivityLeaseFacade::initialize(&context, "native-first-write")?;
    let directory = factory.verify(&context)?;
    let bytes = control::read_bytes(&factory.initial_anchor)?;
    directory.atomic_replace(OsStr::new(control::INIT), &bytes)?;
    assert!(factory.verify(&context).is_err());
    assert!(NativeConnectivityLeaseFacade::observe(&context).is_err());
    assert!(NativeConnectivityLeaseFacade::initialize(&context, "native-first-write").is_err());
    Ok(())
}
#[tokio::test]
async fn dropped_parent_attachment_retains_actual_kernel_lock_until_worker_exit() -> Result<()> {
    let (_temp, context) = fixture()?;
    let factory = NativeConnectivityLeaseFacade::initialize(&context, "native-first-write")?;
    let (mut child, parent) = owned_parent(&context).await?;
    factory.acquire(&context, Some(parent.clone()))?;
    drop(factory);
    let peer = NativeConnectivityLeaseFacade::observe(&context)?.unwrap();
    let (mut peer_child, peer_parent) = owned_parent(&context).await?;
    assert!(peer.acquire(&context, Some(peer_parent.clone())).is_err());
    child.kill().await?;
    child.wait().await?;
    let lease = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(lease) = peer.acquire(&context, Some(peer_parent.clone())) {
                break lease;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    assert_eq!(lease.store_mode, "open_existing");
    peer_child.kill().await?;
    peer_child.wait().await?;
    peer.release(&context, Some(&peer_parent), &lease.lease_id)?;
    Ok(())
}
#[test]
fn private_handler_does_not_accept_json_trusted_flags_or_missing_native_parent() -> Result<()> {
    let (_temp, context) = fixture()?;
    let factory = NativeConnectivityLeaseFacade::initialize(&context, "native-first-write")?;
    let handler = super::super::private_handler::NativeConnectivityPrivateContribution {
        context: &context,
        facade: &factory,
        parent: None,
    };
    assert!(
        handler
            .handle(
                "unowned.private.method",
                serde_json::json!({"trusted":true})
            )?
            .is_none()
    );
    assert!(handler.handle("private.store.acquireLease",serde_json::json!({"trusted":true,"pid":1,"path":factory.private_data_path(&context)?})).is_err());
    Ok(())
}

pub(super) fn initialize_node_files(
    factory: &NativeConnectivityLeaseFacade,
    context: &NativeIntegrationContext,
) -> Result<String> {
    let node = which::which(
        std::env::var_os("KCODER_CONNECTIVITY_TEST_NODE").unwrap_or_else(|| "node".into()),
    )?;
    let source = kcoder_test_harness::workspace_root()
        .expect("resolve current workspace")
        .join("crates/kcoder_cli")
        .join("../../apps/kcoder-channel-host/src/applications/store-bootstrap.mjs")
        .canonicalize()?;
    let source = reqwest::Url::from_file_path(source)
        .map_err(|_| anyhow::anyhow!("fixture module URL unavailable"))?;
    test_support::initialize_node_files_with(factory, context, &node, source.as_str())
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn gateway_transport_reuses_launch_identity_and_rejects_shutdown() -> Result<()> {
    let (_temp, context) = fixture()?;
    let host = super::super::NativeScopeHostBootstrap::open_gateway(context)?;
    let context = host.native();
    let facade = NativeConnectivityLeaseFacade::initialize(context, "gateway-transport-fixture")?;
    let (mut child, parent) = owned_parent(context).await?;
    parent.bind_scope_host(context, host.clone())?;
    let lease = facade.acquire(context, Some(parent.clone()))?;
    assert!(
        facade
            .held_gateway_transport_lease(context, &parent, None)
            .is_err()
    );
    let binding_hash = initialize_node_files(&facade, context)?;
    let ready = facade.commit_ready(
        context,
        Some(&parent),
        &NativeConnectivityReadyInput {
            lease_id: lease.lease_id.clone(),
            namespace_id: lease.namespace_id,
            initialization_id: lease.initialization_id,
            binding_hash,
        },
    )?;
    let before = context.identity_checks();
    for _ in 0..8 {
        assert_eq!(
            facade.held_gateway_transport_lease(context, &parent, Some(&lease.lease_id))?,
            Some(ready.clone())
        );
    }
    assert_eq!(context.identity_checks(), before);
    host.request_stop();
    assert_eq!(
        facade
            .held_gateway_transport_lease(context, &parent, Some(&lease.lease_id))
            .unwrap_err()
            .to_string(),
        "CHANNEL_HOST_OWNER_ENDED"
    );
    child.kill().await?;
    facade.release_exited_parent(&parent)?;
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn real_node_ddl_requires_native_ready_and_lost_ready_ack_never_rebuilds() -> Result<()> {
    let (_temp, context) = fixture()?;
    let factory = NativeConnectivityLeaseFacade::initialize(&context, "native-first-write")?;
    let (mut child, parent) = owned_parent(&context).await?;
    let lease = factory.acquire(&context, Some(parent.clone()))?;
    let inspect_transport = |id: &str| {
        factory.inspect_captured_ready_lease(
            &parent,
            Some(id),
            || parent.check_process_for_captured_scope(&context),
            |lease| lease.id.clone(),
        )
    };
    assert!(inspect_transport(&lease.lease_id).is_err());
    let hash = initialize_node_files(&factory, &context)?;
    let input = NativeConnectivityReadyInput {
        lease_id: lease.lease_id.clone(),
        namespace_id: lease.namespace_id.clone(),
        initialization_id: lease.initialization_id.clone(),
        binding_hash: hash,
    };
    let ready = factory.commit_ready(&context, Some(&parent), &input)?;
    assert_eq!(ready.stage, "ready");
    let before = context.identity_checks();
    assert_eq!(inspect_transport(&lease.lease_id)?, lease.lease_id);
    assert!(inspect_transport("foreign-lease").is_err());
    assert_eq!(context.identity_checks(), before);
    assert_eq!(
        factory.held_gateway_transport_lease(&context, &parent, None)?,
        None
    );
    assert_eq!(factory.ready_lease_id(&context, &parent)?, lease.lease_id);
    factory.require_ready(&context, Some(&parent), &lease.lease_id)?;
    assert_eq!(
        factory.commit_ready(&context, Some(&parent), &input)?.stage,
        "ready"
    );
    child.kill().await?;
    child.wait().await?;
    assert!(inspect_transport(&lease.lease_id).is_err());
    factory.release(&context, Some(&parent), &lease.lease_id)?;
    let recovered = NativeConnectivityLeaseFacade::observe(&context)?.unwrap();
    let (mut next_child, next_parent) = owned_parent(&context).await?;
    let next = recovered.acquire(&context, Some(next_parent.clone()))?;
    assert_eq!(next.store_mode, "open_existing");
    assert_eq!(next.stage, "reconciling");
    let input = NativeConnectivityReadyInput {
        lease_id: next.lease_id.clone(),
        ..input
    };
    assert_eq!(
        recovered
            .commit_ready(&context, Some(&next_parent), &input)?
            .stage,
        "ready"
    );
    next_child.kill().await?;
    next_child.wait().await?;
    recovered.release(&context, Some(&next_parent), &next.lease_id)?;
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn native_ready_rejects_missing_database_without_resetting_any_receipt() -> Result<()> {
    let (_temp, context) = fixture()?;
    let factory = NativeConnectivityLeaseFacade::initialize(&context, "native-first-write")?;
    let (mut child, parent) = owned_parent(&context).await?;
    let lease = factory.acquire(&context, Some(parent.clone()))?;
    let hash = initialize_node_files(&factory, &context)?;
    let input = NativeConnectivityReadyInput {
        lease_id: lease.lease_id.clone(),
        namespace_id: lease.namespace_id.clone(),
        initialization_id: lease.initialization_id.clone(),
        binding_hash: hash,
    };
    factory.commit_ready(&context, Some(&parent), &input)?;
    let database = factory
        .private_data_path(&context)?
        .join("connectivity.sqlite3");
    std::fs::remove_file(&database)?;
    assert!(
        factory
            .renew(&context, Some(&parent), &lease.lease_id)
            .is_err()
    );
    assert!(NativeConnectivityLeaseFacade::observe(&context).is_err());
    assert!(!database.exists());
    child.kill().await?;
    child.wait().await?;
    factory.release(&context, Some(&parent), &lease.lease_id)?;
    Ok(())
}
