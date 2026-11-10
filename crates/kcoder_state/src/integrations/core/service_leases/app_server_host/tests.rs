use super::*;
use kcoder_types::integrations::core::{
    AppServerHostIdentity, NativeScopeHostLaunchSpec, NativeScopeHostResources,
};

#[test]
fn warm_host_selection_keeps_current_roots_live_without_replaying_history() -> Result<()> {
    let (_root, store, mut spec) = fixture()?;
    for index in 0..16 {
        spec.native_image_sha256 = format!("{index:064x}");
        store.select_app_server_host(
            &spec,
            true,
            (index != 0).then_some(index),
            &format!("launch-{index}"),
        )?;
    }
    let samples = |cold: bool| -> Result<Vec<u128>> {
        let mut times = Vec::new();
        for _ in 0..48 {
            if cold {
                *store.host_journal.lock().unwrap() = None;
            }
            let start = std::time::Instant::now();
            assert!(store.current_app_server_host()?.unwrap().0.enabled);
            times.push(start.elapsed().as_micros());
        }
        times.sort_unstable();
        Ok(times)
    };
    let cold = samples(true)?;
    let warm = samples(false)?;
    eprintln!(
        "CHANNEL_LATENCY group=host-selection samples=48 cold_p50_us={} cold_p95_us={} warm_p50_us={} warm_p95_us={}",
        cold[24], cold[45], warm[24], warm[45]
    );
    let original = spec.workspace_path.with_extension("old");
    std::fs::rename(&spec.workspace_path, original)?;
    PrivateDirectory::open_or_create(&spec.workspace_path)?;
    assert!(store.current_app_server_host().is_err());
    Ok(())
}

fn scope() -> IntegrationScope {
    serde_json::from_value(serde_json::json!({
        "accountId":"owner", "targetId":"target", "workspaceId":"workspace",
        "identityGeneration":"original", "targetRevision":"settings-one"
    }))
    .unwrap()
}

fn fixture() -> Result<(
    tempfile::TempDir,
    IntegrationServiceLeaseStore,
    AppServerHostLaunchSpec,
)> {
    let root = tempfile::tempdir()?;
    let directory = PrivateDirectory::open_or_create(root.path())?;
    let profile = root.path().join("profile");
    let workspace = root.path().join("workspace");
    PrivateDirectory::open_or_create(&profile)?;
    PrivateDirectory::open_or_create(&workspace)?;
    let scope = scope();
    let store =
        IntegrationServiceLeaseStore::create_in(&directory, OsStr::new("services"), &scope)?;
    let spec = AppServerHostLaunchSpec {
        schema_version: 1,
        identity: AppServerHostIdentity::from(&scope),
        settings_file: profile.join("settings.json"),
        profile_path: profile,
        workspace_path: workspace,
        native_image_sha256: "a".repeat(64),
        office: None,
    };
    Ok((root, store, spec))
}

fn legacy(spec: &AppServerHostLaunchSpec) -> NativeScopeHostLaunchSpec {
    NativeScopeHostLaunchSpec {
        schema_version: 1,
        scope: scope(),
        profile_path: spec.profile_path.clone(),
        workspace_path: spec.workspace_path.clone(),
        settings_file: spec.settings_file.clone(),
        native_image_sha256: spec.native_image_sha256.clone(),
        configuration_sha256: "b".repeat(64),
        resources: NativeScopeHostResources {
            component_root: spec.profile_path.join("channel"),
            component_manifest_sha256: "c".repeat(64),
            node_program: spec.profile_path.join("node"),
            node_image_sha256: "d".repeat(64),
            runtime_mode: "standalone_node".into(),
            node_version: None,
            electron_version: None,
        },
        office: None,
    }
}

#[test]
fn no_channel_grant_is_required_and_recovery_preserves_cas_and_original_receipts() -> Result<()> {
    let (root, store, spec) = fixture()?;
    assert!(store.current_app_server_host()?.is_none());
    assert!(
        !root
            .path()
            .join("services")
            .join(scope_host::HOST_SLOT)
            .exists()
    );
    let selected = store.select_app_server_host(&spec, true, None, "initial-launch")?;
    assert!(store.list_scope_hosts()?.is_empty());
    let owner = store
        .try_claim_app_server_host(&selected)?
        .context("initial slot")?;
    store.verify_app_server_host_descriptor(&selected, owner.file())?;
    let directory = PrivateDirectory::open_existing(root.path())?;
    let reader =
        IntegrationServiceLeaseStore::open_in(&directory, OsStr::new("services"), &scope())?;
    assert_eq!(
        reader.current_app_server_host()?,
        Some((selected.clone(), spec.clone()))
    );
    assert!(reader.try_claim_app_server_host(&selected)?.is_none());
    let stopped = reader.select_app_server_host(&spec, false, Some(1), "explicit-stop")?;
    assert_eq!(stopped.revision, 2);
    assert!(reader.try_claim_app_server_host(&selected).is_err());
    assert!(
        reader
            .verify_app_server_host_descriptor(&selected, owner.file())
            .is_err()
    );
    assert!(reader.try_claim_app_server_host(&stopped).is_err());
    assert_eq!(
        reader.select_app_server_host(&spec, true, None, "initial-launch")?,
        selected
    );
    assert!(
        reader
            .select_app_server_host(&spec, false, None, "initial-launch")
            .is_err()
    );
    assert!(
        reader
            .select_app_server_host(&spec, true, Some(1), "stale-start")
            .is_err()
    );
    Ok(())
}

#[test]
fn migration_and_new_images_share_the_live_legacy_slot_without_taking_it_over() -> Result<()> {
    let (_root, store, mut spec) = fixture()?;
    let legacy = store.prepare_scope_host(&legacy(&spec), "original-channel-host")?;
    let old_owner = store
        .try_claim_scope_host(&legacy)?
        .context("legacy slot")?;
    assert_eq!(
        store
            .select_app_server_host(&spec, true, None, "select-task-host")
            .unwrap_err()
            .to_string(),
        "APP_SERVER_HOST_ORIGINAL_OWNER_BUSY"
    );
    assert!(store.current_app_server_host()?.is_none());
    store.verify_scope_host_descriptor(&legacy, old_owner.file())?;
    drop(old_owner);
    let selected = store.select_app_server_host(&spec, true, None, "select-task-host")?;
    let owner = store
        .try_claim_app_server_host(&selected)?
        .context("original owner exited")?;
    spec.native_image_sha256 = "e".repeat(64);
    assert!(
        store
            .select_app_server_host(&spec, true, Some(1), "select-next-image")
            .is_err()
    );
    drop(owner);
    let next = store.select_app_server_host(&spec, true, Some(1), "select-next-image")?;
    let task_owner = store
        .try_claim_app_server_host(&next)?
        .context("original owner exited")?;
    assert!(store.try_claim_scope_host(&legacy)?.is_none());
    store.verify_app_server_host_descriptor(&next, task_owner.file())?;
    let revisions = store.app_server_host_selections()?;
    assert_eq!(revisions.len(), 2);
    assert_eq!(revisions[0].0, selected);
    assert_eq!(revisions[1], (next, spec));
    Ok(())
}

#[test]
fn ordinary_settings_changes_keep_the_host_and_foreign_project_cannot_select_it() -> Result<()> {
    let (_root, store, spec) = fixture()?;
    let selected = store.select_app_server_host(&spec, true, None, "original-start")?;
    let owner = store
        .try_claim_app_server_host(&selected)?
        .context("slot")?;
    std::fs::write(
        &spec.settings_file,
        br#"{"knowledge":{"enabled":true},"model":"other"}"#,
    )?;
    assert_eq!(
        store.current_app_server_host()?,
        Some((selected.clone(), spec.clone()))
    );
    store.verify_app_server_host_descriptor(&selected, owner.file())?;
    let mut foreign = spec.clone();
    foreign.identity.owner.workspace_id =
        kcoder_types::integrations::core::IntegrationNullable::Value("other-project".into());
    assert!(
        store
            .select_app_server_host(&foreign, true, Some(1), "foreign-start")
            .is_err()
    );
    std::fs::rename(
        &spec.workspace_path,
        spec.workspace_path.with_extension("original"),
    )?;
    PrivateDirectory::open_or_create(&spec.workspace_path)?;
    assert!(store.current_app_server_host().is_err());
    assert!(store.try_claim_app_server_host(&selected).is_err());
    Ok(())
}

#[test]
fn legacy_first_and_task_first_never_repair_a_missing_or_replaced_original_slot() -> Result<()> {
    for legacy_first in [true, false] {
        let (root, store, spec) = fixture()?;
        if legacy_first {
            store.prepare_scope_host(&legacy(&spec), "legacy-start")?;
        } else {
            store.select_app_server_host(&spec, true, None, "task-start")?;
            // The legacy preparation also accepts a proven task-host anchor.
            store.prepare_scope_host(&legacy(&spec), "legacy-later")?;
        }
        let slot = root.path().join("services").join(scope_host::HOST_SLOT);
        std::fs::rename(&slot, slot.with_extension("original"))?;
        let mut next = legacy(&spec);
        next.configuration_sha256 = "f".repeat(64);
        assert!(store.prepare_scope_host(&next, "missing-slot").is_err());
        assert!(!slot.exists());
        assert!(
            store
                .select_app_server_host(&spec, true, None, "missing-task-slot")
                .is_err()
        );
        assert!(!slot.exists());
        assert!(store.try_claim_gateway_app_server().is_err());
        assert!(!slot.exists());
        drop(
            store
                .directory
                .open_read_write_file(OsStr::new(scope_host::HOST_SLOT), true)?,
        );
        assert!(store.try_claim_gateway_app_server().is_err());
    }
    Ok(())
}

#[test]
fn optional_office_metadata_preserves_older_launches_and_waits_for_the_original_owner() -> Result<()>
{
    let (_root, store, mut spec) = fixture()?;
    let old = serde_json::to_value(&spec)?;
    assert!(old.get("office").is_none());
    assert_eq!(
        serde_json::from_value::<AppServerHostLaunchSpec>(old.clone())?,
        spec
    );
    let first = store.select_app_server_host(&spec, true, None, "without-office")?;
    let owner = store
        .try_claim_app_server_host(&first)?
        .context("original slot")?;
    // Shape-only metadata cannot prove an installed Office package or grant.
    spec.office = Some(serde_json::from_value(serde_json::json!({
        "resourceCopyRef":format!("scope-host-{}","c".repeat(64)),
        "launch":{"schemaVersion":1,"originalLaunch":"e30","profileIdentity":"profile",
            "workspaceIdentity":"workspace","workspaceDigest":"a".repeat(64),"configurationSha256":"b".repeat(64)}
    }))?);
    assert!(
        store
            .select_app_server_host(&spec, true, Some(1), "component-change")
            .is_err()
    );
    assert_eq!(
        serde_json::to_value(store.current_app_server_host()?.unwrap().1)?,
        old
    );
    drop(owner);
    let changed = store.select_app_server_host(&spec, true, Some(1), "component-change")?;
    assert_eq!(changed.revision, 2);
    assert_eq!(store.current_app_server_host()?.unwrap().1, spec);
    let mut forged = serde_json::to_value(spec.office.as_ref().unwrap())?;
    forged["backgroundAuthorized"] = serde_json::json!(true);
    assert!(
        serde_json::from_value::<kcoder_types::integrations::core::AppServerHostOfficeLaunch>(
            forged
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn gateway_and_legacy_carrier_cannot_own_the_same_scope() -> Result<()> {
    let (_root, store, spec) = fixture()?;
    let direct = store
        .try_claim_gateway_app_server()?
        .context("Gateway fence")?;
    assert!(store.current_app_server_host()?.is_none());
    assert!(store.try_claim_gateway_app_server()?.is_none());
    store.verify_gateway_app_server_descriptor(direct.file())?;
    assert!(
        store
            .select_app_server_host(&spec, true, None, "legacy")
            .is_err()
    );
    drop(direct);

    let legacy = store.select_app_server_host(&spec, true, None, "legacy")?;
    let owner = store
        .try_claim_app_server_host(&legacy)?
        .context("legacy fence")?;
    assert!(store.try_claim_gateway_app_server()?.is_none());
    drop(owner);

    let direct = store
        .try_claim_gateway_app_server()?
        .context("Gateway fence")?;
    assert_eq!(store.current_app_server_host()?.unwrap().0, legacy);
    store.verify_gateway_app_server_descriptor(direct.file())?;
    assert!(store.try_claim_app_server_host(&legacy)?.is_none());
    drop(direct);
    assert!(store.try_claim_app_server_host(&legacy)?.is_some());
    Ok(())
}

#[test]
fn ordinary_stdio_reopens_a_workspace_with_an_inactive_legacy_selection() -> Result<()> {
    let (_root, store, spec) = fixture()?;
    assert!(store.guard_stdio_against_legacy_host()?.is_none());
    let legacy = store.select_app_server_host(&spec, true, None, "legacy")?;
    let running = store
        .try_claim_app_server_host(&legacy)?
        .context("legacy fence")?;
    assert_eq!(
        store
            .guard_stdio_against_legacy_host()
            .err()
            .context("expected legacy lock contention")?
            .to_string(),
        "APP_SERVER_HOST_ORIGINAL_OWNER_BUSY"
    );
    drop(running);

    let stdio = store
        .guard_stdio_against_legacy_host()?
        .context("stdio fence")?;
    let peer = store
        .guard_stdio_against_legacy_host()?
        .context("peer fence")?;
    assert_eq!(store.current_app_server_host()?.unwrap().0, legacy);
    assert!(store.try_claim_app_server_host(&legacy)?.is_none());
    assert!(store.try_claim_gateway_app_server()?.is_none());
    drop(stdio);
    assert!(store.try_claim_app_server_host(&legacy)?.is_none());
    drop(peer);
    assert!(store.try_claim_app_server_host(&legacy)?.is_some());
    Ok(())
}
