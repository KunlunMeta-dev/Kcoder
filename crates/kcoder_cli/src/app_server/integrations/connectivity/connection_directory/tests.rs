use super::*;
use crate::app_server::{
    ConnectionState, integrations::core::runtime_driver::test_support::Fixture,
};
use kcoder_app_protocol::integrations::connectivity::{ConnectivityPort, ConnectivityPortCall};

fn caller(
    native: &NativeIntegrationContext,
    mutation: bool,
) -> Result<(
    ConnectionState,
    std::sync::Arc<NativeConnectivityPublicCall>,
)> {
    let state = ConnectionState {
        initialized: true,
        integration_context: Some(native.recapture_for_owned_service()?),
        ..Default::default()
    };
    let call = NativeConnectivityPublicCall::capture(&state, ConnectivityPortCall {
        port: ConnectivityPort::Connection,
        method: if mutation { ConnectivityMethod::PrepareConnectionAction } else { ConnectivityMethod::ListConnections },
        request: IntegrationRequest { contract_version: IntegrationContractVersion::ParallelV1,
            request_id: "original-directory-request".into(), scope: native.scope().clone(),
            operation_id: mutation.then(|| "original-directory-save".into()), expected_revision: None,
            cancellation_ref: None, timeout_ms: 3000,
            payload: if mutation { json!({"action":"save","connectionId":"owned-connection","kind":"feishu","configuration":{"appId":"inert-app"}}) }
                else { json!({"connectionDirectoryOnly":true}) }.as_object().unwrap().clone() },
    })?;
    Ok((state, call))
}
fn second(fixture: &Fixture) -> Result<NativeIntegrationContext> {
    let root = fixture.workspace.parent().unwrap();
    PrivateDirectory::open_existing(root)?.create_private_child(OsStr::new("second-workspace"))?;
    NativeIntegrationContext::capture(
        &fixture.profile,
        &root.join("second-workspace"),
        "second-actual-ui",
        "config-1",
    )
}
fn directory(native: &NativeIntegrationContext) -> Result<PrivateDirectory> {
    NativeDomainGuard::observe(
        native.profile()?,
        native.scope(),
        NativeDomain::Connectivity,
    )?
    .unwrap()
    .directory(native.profile()?)
}

#[test]
fn target_directory_read_needs_no_main_sdk_or_new_namespace() -> Result<()> {
    let fixture = Fixture::new();
    let before = std::fs::read_dir(&fixture.profile)?.count();
    let (state, call) = caller(&fixture.context, false)?;
    let reply = directory_only(&call)?.unwrap();
    assert_eq!(reply.status, IntegrationStatus::Completed);
    assert!(read(&fixture.context)?.sources.is_empty());
    assert_eq!(std::fs::read_dir(&fixture.profile)?.count(), before);
    state.input_ended.cancel();
    assert!(directory_only(&call).is_err());
    Ok(())
}

#[test]
fn original_namespaces_are_discovered_across_workspaces_without_merging_owners() -> Result<()> {
    let fixture = Fixture::new();
    let other = second(&fixture)?;
    let first_facade =
        NativeConnectivityLeaseFacade::initialize(&fixture.context, "first-original-save")?;
    let second_facade = NativeConnectivityLeaseFacade::initialize(&other, "second-original-save")?;
    let (_first_state, first_call) = caller(&fixture.context, true)?;
    register(&first_call, &first_facade)?;
    let snapshot = read(&other)?;
    assert_eq!(snapshot.sources.len(), 2);
    assert!(!snapshot.complete);
    let first = snapshot
        .sources
        .iter()
        .find(|row| row.namespace_id == first_facade.namespace_id(&fixture.context).unwrap())
        .unwrap();
    assert!(!first.current);
    assert_eq!(first.state, ConnectivityConnectionSourceState::Available);
    assert_eq!(first.workspace_path.as_deref(), fixture.workspace.to_str());
    let second = snapshot.sources.iter().find(|row| row.current).unwrap();
    assert_eq!(
        second.state,
        ConnectivityConnectionSourceState::Unregistered
    );
    assert_ne!(first.owner.workspace_id, second.owner.workspace_id);
    let (_second_state, second_call) = caller(&other, true)?;
    register(&second_call, &second_facade)?;
    assert!(read(&fixture.context)?.complete);
    Ok(())
}

#[test]
fn copied_foreign_locator_cannot_redirect_another_namespace() -> Result<()> {
    let fixture = Fixture::new();
    let other = second(&fixture)?;
    let first = NativeConnectivityLeaseFacade::initialize(&fixture.context, "first-save")?;
    NativeConnectivityLeaseFacade::initialize(&other, "second-save")?;
    let (_state, call) = caller(&fixture.context, true)?;
    register(&call, &first)?;
    let mut bytes = Vec::new();
    directory(&fixture.context)?
        .open_single_link_regular_file(OsStr::new(LOCATOR))?
        .read_to_end(&mut bytes)?;
    directory(&other)?.atomic_replace(OsStr::new(LOCATOR), &bytes)?;
    let snapshot = read(&fixture.context)?;
    assert!(!snapshot.complete);
    let wrong = snapshot.sources.iter().find(|row| !row.current).unwrap();
    assert_eq!(wrong.state, ConnectivityConnectionSourceState::Unavailable);
    assert!(wrong.workspace_path.is_none());
    assert_eq!(
        snapshot
            .sources
            .iter()
            .find(|row| row.current)
            .unwrap()
            .state,
        ConnectivityConnectionSourceState::Available
    );
    Ok(())
}

#[test]
fn moved_workspace_is_unavailable_until_its_actual_owner_registers_the_same_identity() -> Result<()>
{
    let fixture = Fixture::new();
    let other = second(&fixture)?;
    let first = NativeConnectivityLeaseFacade::initialize(&fixture.context, "first-save")?;
    let (_state, call) = caller(&fixture.context, true)?;
    register(&call, &first)?;
    let moved = fixture.workspace.with_file_name("moved-original-workspace");
    std::fs::rename(&fixture.workspace, &moved)?;
    let snapshot = read(&other)?;
    assert_eq!(
        snapshot.sources[0].state,
        ConnectivityConnectionSourceState::Unavailable
    );
    let restored =
        NativeIntegrationContext::capture(&fixture.profile, &moved, "actual-moved-ui", "config-1")?;
    let observed = NativeConnectivityLeaseFacade::observe(&restored)?.unwrap();
    let (_state, call) = caller(&restored, true)?;
    register(&call, &observed)?;
    let snapshot = read(&other)?;
    assert_eq!(
        snapshot.sources[0].state,
        ConnectivityConnectionSourceState::Available
    );
    assert_eq!(
        snapshot.sources[0].workspace_path.as_deref(),
        moved.to_str()
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn symlink_locator_is_unavailable_and_never_followed_or_repaired() -> Result<()> {
    let fixture = Fixture::new();
    NativeConnectivityLeaseFacade::initialize(&fixture.context, "original-save")?;
    let outside = fixture.workspace.join("unrelated-data");
    std::fs::write(&outside, b"original unrelated bytes")?;
    let native_directory = directory(&fixture.context)?;
    let guard = NativeDomainGuard::observe(
        fixture.context.profile()?,
        fixture.context.scope(),
        NativeDomain::Connectivity,
    )?
    .unwrap();
    let root = fixture.profile.join(guard.namespace_id());
    std::os::unix::fs::symlink(&outside, root.join(LOCATOR))?;
    let snapshot = read(&fixture.context)?;
    assert_eq!(
        snapshot.sources[0].state,
        ConnectivityConnectionSourceState::Unavailable
    );
    assert!(snapshot.sources[0].workspace_path.is_none());
    assert!(!snapshot.complete);
    assert_eq!(std::fs::read(&outside)?, b"original unrelated bytes");
    assert!(std::fs::symlink_metadata(root.join(LOCATOR))?.is_symlink());
    native_directory.verify_private_directory()?;
    Ok(())
}

#[test]
fn locator_cannot_relabel_a_different_workspace_inode_as_the_original_owner() -> Result<()> {
    let fixture = Fixture::new();
    let other = second(&fixture)?;
    let facade = NativeConnectivityLeaseFacade::initialize(&fixture.context, "original-save")?;
    let (_state, call) = caller(&fixture.context, true)?;
    register(&call, &facade)?;
    let original = directory(&fixture.context)?;
    let mut locator = read_locator(&original)?.unwrap();
    locator.workspace_path = other.workspace_path()?.to_str().unwrap().into();
    locator.workspace_identity = other.workspace_directory_identity()?;
    original.atomic_replace(OsStr::new(LOCATOR), &serde_json::to_vec(&locator)?)?;
    let snapshot = read(&fixture.context)?;
    assert_eq!(
        snapshot.sources[0].state,
        ConnectivityConnectionSourceState::Unavailable
    );
    assert!(!snapshot.complete);
    Ok(())
}
