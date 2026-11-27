use super::*;
use kcoder_config::storage::{StorageResolveInput, inspect_storage_target, resolve_storage_paths};
use kcoder_types::{
    STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLaunchIntent, StorageLocationRecord,
    StorageMigrationPhase as Phase, StorageTargetBinding,
};
use std::fs;

const RELAY_URL: &str = "https://relay.example.test";
const SECRET: &str = "original-owned-gateway-secret-01234567890123456789";

fn root() -> PathBuf {
    kcoder_test_harness::workspace_root().unwrap()
}

fn node() -> PathBuf {
    which::which("node").expect("Node is required for the actual Relay owner contract")
}

fn owner_command() -> Command {
    let mut command = Command::new(node());
    command
        .arg(root().join("apps/kcoder-studio/src/migrations/gateway-storage-domains.mjs"))
        .env("KCODER_TARGET_DIR", root().join("target"));
    command
}

fn plan(
    home: &Path,
    original: Option<StorageLocationRecord>,
    id: &str,
) -> Result<StorageMigrationPlan> {
    let mut from = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.into()),
        record: original.clone(),
        ..Default::default()
    })?;
    // The owned fixture starts with an already unified source, without using a
    // personal locator or opening any product business runtime.
    from.layout = StorageLayout::Unified;
    from.gateway_root = from.data_root.join("studio/gateway");
    from.desktop_root = from.data_root.join("studio/desktop");
    let target = StorageLocationRecord {
        version: 1,
        revision: original.as_ref().map_or(1, |record| record.revision + 1),
        data_root: home.join(format!("Data-{id}")),
        cache_root: home.join(format!("Cache-{id}")),
        operation_id: Some(id.into()),
    };
    let target_bindings = [&target.data_root, &target.cache_root]
        .into_iter()
        .map(|path| {
            let observed = inspect_storage_target(path)?;
            Ok(StorageTargetBinding {
                path: path.to_owned(),
                existing_ancestor: observed.existing_ancestor,
                ancestor_identity: observed.ancestor_identity,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let component = StorageMigrationComponent {
        domain: STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
        source: from.data_root.clone(),
        destination: target.data_root.clone(),
        source_identity: PrivateDirectory::open_existing(&from.data_root)?.directory_identity()?,
        estimated_bytes: 0,
    };
    Ok(StorageMigrationPlan {
        version: 1,
        operation_id: id.into(),
        original,
        from,
        target,
        components: vec![component],
        target_bindings,
        launch_intent: StorageLaunchIntent::VerifyOnly,
    })
}

fn internal_reference_fixture() -> Result<(tempfile::TempDir, StorageMigrationPlan, PathBuf)> {
    use kcoder_workspace_resources::managed_worktrees::{
        ClientManagedWorktree, ClientWorktreeStore,
    };
    let owned = tempfile::tempdir()?;
    let data = owned.path().join(".config/kcoder");
    let _gateway = PrivateDirectory::open_or_create(&data.join("studio/gateway"))?;
    let project = data.join("projects/reference-owner");
    let store =
        ClientWorktreeStore::from_client_storage_root(project.join("client-sessions"), true);
    let mut state = store.load()?;
    let value = serde_json::to_value(&state)?;
    let managed_root = PathBuf::from(
        value["settings"]["resolvedWorktreeRoot"]
            .as_str()
            .context("owned root")?,
    );
    let path = managed_root.join("owned-task/repository");
    fs::create_dir_all(&path)?;
    let record = ClientManagedWorktree {
        worktree_id: "owned-task".into(),
        repository_name: "repository".into(),
        path: path.to_str().context("owned path")?.into(),
        state: "active".into(),
        revision: 7,
        ..Default::default()
    };
    state.records.insert(record.path.clone(), record);
    store.save(&state)?;
    let plan = plan(owned.path(), None, "internal-reference")?;
    Ok((owned, plan, path))
}

fn reference_preview(plan: &StorageMigrationPlan) -> Result<bool> {
    preview_gateway_domains(&kcoder_types::StorageMigrationReceipt {
        plan: plan.clone(),
        phase: Phase::Planned,
        disposition: kcoder_types::StorageMigrationDisposition::Active,
        owner_receipts: Default::default(),
        error_code: None,
    })
}

#[test]
fn gateway_internal_references_block_registered_workspaces_and_owned_settings_without_rewriting()
-> Result<()> {
    let (_owned, plan, path) = internal_reference_fixture()?;
    for field in ["workspace", "workspacePath", "settingsFile"] {
        let file = plan.from.gateway_root.join("servers.json");
        let mut server = json!({"id":"local","label":"original","transport":"local"});
        server[field] = json!(path.join("nested"));
        let value = json!([server]);
        let bytes = serde_json::to_vec(&value)?;
        fs::write(&file, &bytes)?;
        ensure!(
            reference_preview(&plan)
                .unwrap_err()
                .to_string()
                .contains("STORAGE_GATEWAY_INTERNAL_REFERENCE_UNSUPPORTED")
        );
        ensure!(fs::read(&file)? == bytes);
    }
    for root in [&plan.from.data_root, &plan.from.gateway_root] {
        let settings = root.join("settings.json");
        fs::write(&settings, b"original settings")?;
        fs::write(
            plan.from.gateway_root.join("servers.json"),
            serde_json::to_vec(&json!([
            {"id":"local","transport":"local","settingsFile":settings}]))?,
        )?;
        ensure!(
            reference_preview(&plan)
                .unwrap_err()
                .to_string()
                .contains("STORAGE_GATEWAY_INTERNAL_REFERENCE_UNSUPPORTED")
        );
        ensure!(fs::read(settings)? == b"original settings");
    }
    Ok(())
}

#[test]
fn gateway_internal_references_preserve_external_projects_ssh_unknown_fields_and_in_place_profile()
-> Result<()> {
    let (_owned, mut plan, path) = internal_reference_fixture()?;
    let project = plan.from.data_root.join("ordinary-user-project");
    fs::create_dir(&project)?;
    let file = plan.from.gateway_root.join("servers.json");
    let bytes = serde_json::to_vec(&json!([
        {"id":"ssh","transport":"ssh","workspace":path,"settingsFile":path},
        {"id":"local","transport":"local","workspace":project,"settingsFile":project.join("overlay.json"),"cwd":path,"description":path}
    ]))?;
    fs::write(&file, &bytes)?;
    ensure!(reference_preview(&plan)?);
    ensure!(fs::read(&file)? == bytes);
    // The retained Native profile does not relocate managed addresses.
    let owner = GatewayDomainsSource::observe(&plan)?;
    plan.target.data_root = plan.from.data_root.clone();
    internal_references::check(&plan, &owner)?;
    Ok(())
}

#[tokio::test]
async fn gateway_internal_references_recheck_live_and_pending_routes_but_preserve_completed_history()
-> Result<()> {
    let (_owned, plan, path) = internal_reference_fixture()?;
    let seed = Command::new(node()).args(["--input-type=module","--eval"])
        .arg("const a=await import(process.argv[1]),r=await import(process.argv[2]);const auth=a.createMobileDeviceAuth({directory:process.argv[3],identity:'owned-original'});\
            const device=await auth.pair('owned');const route=r.localRetentionRoute({targetId:'local',targetFingerprint:'a'.repeat(64),workspacePath:process.argv[4]});\
            await auth.registerRetentionRoute({deviceId:device.deviceId,authorizationGeneration:device.authorizationGeneration,route});\
            const external=r.localRetentionRoute({targetId:'local',targetFingerprint:'b'.repeat(64),workspacePath:'/external-project'});\
            await auth.registerRetentionRoute({deviceId:device.deviceId,authorizationGeneration:device.authorizationGeneration,route:external});")
        .arg(root().join("apps/kcoder-studio/src/mobile-device-auth.js"))
        .arg(root().join("apps/kcoder-studio/src/retention-device-revocation.js"))
        .arg(&plan.from.gateway_root).arg(&path).output().await?;
    ensure!(seed.status.success(), "owned mobile seed failed");
    let file = plan
        .from
        .gateway_root
        .join("mobile-device-auth/devices.json");
    let before = fs::read(&file)?;
    ensure!(
        reference_preview(&plan)
            .unwrap_err()
            .to_string()
            .contains("STORAGE_GATEWAY_INTERNAL_REFERENCE_UNSUPPORTED")
    );
    ensure!(fs::read(&file)? == before);
    let revoke = Command::new(node()).args(["--input-type=module","--eval"])
        .arg("const a=await import(process.argv[1]);const auth=a.createMobileDeviceAuth({directory:process.argv[2],identity:'owned-original'});\
              const [device]=await auth.list();await auth.revoke(device.id);")
        .arg(root().join("apps/kcoder-studio/src/mobile-device-auth.js"))
        .arg(&plan.from.gateway_root).output().await?;
    ensure!(revoke.status.success(), "owned mobile revocation failed");
    let pending = fs::read(&file)?;
    ensure!(
        reference_preview(&plan)
            .unwrap_err()
            .to_string()
            .contains("STORAGE_GATEWAY_INTERNAL_REFERENCE_UNSUPPORTED")
    );
    let acknowledge = Command::new(node()).args(["--input-type=module","--eval"])
        .arg("const a=await import(process.argv[1]);const auth=a.createMobileDeviceAuth({directory:process.argv[2],identity:'owned-original'});\
              const job=(await auth.pendingRetentionRevocations()).find(job=>job.route.workspacePath===process.argv[3]);\
              await auth.confirmRetentionRevocation({version:1,revocationId:job.statement.revocationId,routeId:job.route.routeId,complete:true});")
        .arg(root().join("apps/kcoder-studio/src/mobile-device-auth.js"))
        .arg(&plan.from.gateway_root).arg(&path).output().await?;
    ensure!(
        acknowledge.status.success(),
        "owned mobile cleanup acknowledgement failed"
    );
    let complete = fs::read(&file)?;
    let ledger: Value = serde_json::from_slice(&complete)?;
    ensure!(
        ledger["retentionRoutes"]
            .as_array()
            .context("retained routes")?
            .len()
            == 2
    );
    ensure!(reference_preview(&plan)?);
    ensure!(fs::read(&file)? == complete);
    // Recheck in the existing stopped source-prepare path, before any copy.
    fs::write(&file, &pending)?;
    let mut coordinator = StorageCoordinator::acquire(_owned.path())?;
    coordinator.begin(plan.clone())?;
    for (from, to) in [
        (Phase::Planned, Phase::Stopping),
        (Phase::Stopping, Phase::Stopped),
        (Phase::Stopped, Phase::Copying),
    ] {
        coordinator.advance(&plan.operation_id, from, to)?;
    }
    coordinator.prepare_source_retirements(&plan.operation_id)?;
    let error = prepare_gateway_domains(&mut coordinator, &plan.operation_id, None)
        .await
        .err()
        .context("internal references must block before source preparation")?;
    ensure!(
        error
            .to_string()
            .contains("STORAGE_GATEWAY_INTERNAL_REFERENCE_UNSUPPORTED")
    );
    ensure!(!plan.target.data_root.exists());
    Ok(())
}

#[tokio::test]
async fn actual_relay_owner_moves_twice_without_copying_a_prior_operation_or_accepting_its_replacement()
-> Result<()> {
    exercise_relay_moves(false).await
}

#[tokio::test]
async fn actual_relay_owner_rejects_a_same_bytes_replaced_reference_after_two_moves() -> Result<()>
{
    exercise_relay_moves(true).await
}

async fn exercise_relay_moves(replace_reference: bool) -> Result<()> {
    let owned = tempfile::tempdir()?;
    let home = owned.path();
    let data = home.join(".config/kcoder");
    fs::create_dir_all(data.join("studio/gateway/desktop-relay"))?;
    fs::write(
        data.join("studio/gateway/desktop-relay/gateway-secret"),
        SECRET,
    )?;
    let initial_identity = data.join("studio/gateway/relay/client-identity.json");
    let seed = Command::new(node())
        .args(["--input-type=module", "--eval"])
        .arg(
            "const r=await import(process.argv[1]);const identityFile=process.argv[2];\
             const fs=await import('node:fs/promises'),path=await import('node:path'),crypto=await import('node:crypto');\
             const relayUrl=process.argv[3],gatewaySecret=process.argv[4];\
             const legacyIdentityFile=path.join(path.dirname(path.dirname(identityFile)),'desktop-relay/client-identity.json');\
             await fs.writeFile(legacyIdentityFile,JSON.stringify({version:1,relayOrigin:relayUrl,\
             gatewaySecretHash:crypto.createHash('sha256').update(gatewaySecret).digest('hex'),\
             id:'owned-original-gateway',secret:'original-relay-issued-secret-01234567890123456789'}));\
             await r.prepareInstanceIdentityFile({identityFile,legacyIdentityFile,relayUrl,gatewaySecret});",
        )
        .arg(root().join("apps/kcoder-relay/src/client-identity.mjs"))
        .arg(&initial_identity)
        .args([RELAY_URL, SECRET])
        .output()
        .await?;
    ensure!(
        seed.status.success(),
        "owned Relay seed failed: {:?}",
        seed.stderr
    );
    let initial: Value = serde_json::from_slice(&fs::read(format!(
        "{}.state-v2/reference.json",
        initial_identity.display()
    ))?)?;

    let mut original = None;
    for id in [
        "relay-first-move",
        "relay-second-move",
        "relay-replaced-source",
    ] {
        let plan = plan(home, original.clone(), id)?;
        let mut coordinator = StorageCoordinator::acquire(home)?;
        coordinator.begin(plan.clone())?;
        coordinator.advance(id, Phase::Planned, Phase::Stopping)?;
        coordinator.advance(id, Phase::Stopping, Phase::Stopped)?;
        coordinator.advance(id, Phase::Stopped, Phase::Copying)?;
        coordinator.prepare_source_retirements(id)?;
        let source =
            prepare_gateway_domains(&mut coordinator, id, Some(&mut owner_command())).await?;
        let receipt_relative = Path::new("studio/gateway/relay/client-identity.json.relocation-v1");
        let old_receipt = plan
            .from
            .data_root
            .join(receipt_relative)
            .join("reference.json");
        if id == "relay-replaced-source" {
            let replaced = if replace_reference {
                plan.from
                    .data_root
                    .join("studio/gateway/relay/client-identity.json.state-v2/reference.json")
            } else {
                old_receipt.clone()
            };
            let directory = PrivateDirectory::open_existing(replaced.parent().unwrap())?;
            directory.atomic_replace(OsStr::new("reference.json"), &fs::read(&replaced)?)?;
            ensure!(source.verify(&mut coordinator, id).is_err());
            ensure!(!plan.target.data_root.exists());
            return Ok(());
        }
        ensure!(source.copy_exclusions().contains(receipt_relative) == old_receipt.exists());
        coordinator.publish_component_checked(
            id,
            STORAGE_PERSISTENT_ROOT_DOMAIN,
            source.copy_exclusions(),
            |inventory| source.verify_source_inventory(inventory),
        )?;
        let published = coordinator.open_published_component(id, STORAGE_PERSISTENT_ROOT_DOMAIN)?;
        ensure!(!published.destination_path().join(receipt_relative).exists());
        relocate_gateway_domains(
            &mut coordinator,
            id,
            Some(&mut owner_command()),
            &source,
            &published,
        )
        .await?;
        verify_gateway_domains(
            &mut coordinator,
            id,
            Some(&mut owner_command()),
            &source,
            &published,
        )
        .await?;
        let current: Value = serde_json::from_slice(&fs::read(
            published
                .destination_path()
                .join(receipt_relative)
                .join("reference.json"),
        )?)?;
        ensure!(current["operationId"] == id && current.as_object().unwrap().len() == 6);
        let reference: Value = serde_json::from_slice(&fs::read(
            published
                .destination_path()
                .join("studio/gateway/relay/client-identity.json.state-v2/reference.json"),
        )?)?;
        ensure!(reference["generation"] == initial["generation"]);
        let alias: Value =
            serde_json::from_slice(&fs::read(published.destination_path().join(
                "studio/gateway/desktop-relay/client-identity.json.state-v2/reference.json",
            ))?)?;
        ensure!(
            alias["generation"] == reference["generation"] && alias["epoch"] == reference["epoch"]
        );
        ensure!(
            !published
                .destination_path()
                .join("studio/gateway/desktop-relay/client-identity.json")
                .exists()
        );
        coordinator.advance(id, Phase::Copying, Phase::Verifying)?;
        coordinator.advance(id, Phase::Verifying, Phase::Prepared)?;
        coordinator.commit(id)?;
        coordinator.complete(id)?;
        original = Some(plan.target);
    }
    anyhow::bail!("the original source receipt replacement was not checked")
}

#[test]
fn relay_source_metadata_requires_opaque_native_identity_and_exact_links() -> Result<()> {
    let owned = tempfile::tempdir()?;
    let root = PrivateDirectory::open_existing(owned.path())?;
    let directory = root.portable_directory_handle_identity()?;
    let proof = json!({"identity":serde_json::to_string(&directory)?,"links":null});
    check_node_identity(&root, &proof)?;
    assert!(check_node_identity(&root, &json!({"dev":"0","ino":"1"})).is_err());
    assert!(
        check_node_identity(&root, &json!({"identity":proof["identity"],"links":"1"})).is_err()
    );
    fs::write(owned.path().join("metadata-only"), b"original bytes")?;
    let file = root.open_regular_file(OsStr::new("metadata-only"))?;
    let (identity, links) = observed_file(&file)?;
    let proof = json!({"identity":identity,"links":links.to_string()});
    check_node_file(&file, &proof)?;
    assert!(check_node_file(&file, &json!({"identity":proof["identity"],"links":links})).is_err());
    assert!(
        check_node_file(
            &file,
            &json!({"identity":proof["identity"],"links":(links+1).to_string()})
        )
        .is_err()
    );
    assert!(
        check_node_file(
            &file,
            &json!({"identity":"different held object","links":proof["links"]})
        )
        .is_err()
    );
    Ok(())
}

fn channel_files(path: &Path) -> Result<Vec<(String, String, std::time::SystemTime, Vec<u8>)>> {
    let directory = PrivateDirectory::open_existing(path)?;
    let mut rows = Vec::new();
    for suffix in ["", "-wal", "-shm"] {
        let name = format!("channels.sqlite3{suffix}");
        let file = match directory.open_single_link_regular_file(OsStr::new(&name)) {
            Ok(file) => file,
            Err(error) if missing(&error) => continue,
            Err(error) => return Err(error),
        };
        rows.push((
            name.clone(),
            observed_file(&file)?.0,
            file.metadata()?.modified()?,
            fs::read(path.join(name))?,
        ));
    }
    Ok(rows)
}

#[tokio::test]
async fn actual_channel_wal_owner_keeps_source_bytes_and_locks_through_copy_and_verification()
-> Result<()> {
    for retain_shm in [true, false] {
        exercise_channel_wal_owner(retain_shm).await?;
    }
    Ok(())
}

async fn exercise_channel_wal_owner(retain_shm: bool) -> Result<()> {
    let owned = tempfile::tempdir()?;
    let home = owned.path();
    let channel = home.join(".config/kcoder/studio/gateway/channels");
    fs::create_dir_all(&channel)?;
    let seed = Command::new(node())
        .args(["--input-type=module", "--eval"])
        .arg(
            "const {ChannelStore}=await import(process.argv[1]);\
             const store=new ChannelStore(process.argv[2]);\
             store.db.exec('PRAGMA wal_autocheckpoint=0');\
             store.db.prepare('INSERT INTO metadata VALUES(?,?)').run('owned-unknown','keep-original');\
             process.exit(0);",
        )
        .arg(root().join("apps/kcoder-channel-host/src/channels/store.mjs"))
        .arg(&channel)
        .output()
        .await?;
    ensure!(
        seed.status.success(),
        "owned channel seed failed: {:?}",
        seed.stderr
    );
    if !retain_shm {
        fs::remove_file(channel.join("channels.sqlite3-shm"))?;
    }
    let before = channel_files(&channel)?;
    ensure!(
        before.len() == if retain_shm { 3 } else { 2 },
        "owned channel fixture did not retain WAL/SHM"
    );
    let id = "channel-owned-wal";
    let plan = plan(home, None, id)?;
    let mut coordinator = StorageCoordinator::acquire(home)?;
    coordinator.begin(plan.clone())?;
    coordinator.advance(id, Phase::Planned, Phase::Stopping)?;
    coordinator.advance(id, Phase::Stopping, Phase::Stopped)?;
    coordinator.advance(id, Phase::Stopped, Phase::Copying)?;
    coordinator.prepare_source_retirements(id)?;
    let source = prepare_gateway_domains(&mut coordinator, id, Some(&mut owner_command())).await?;
    assert_eq!(channel_files(&channel)?, before);
    let read = source
        .channels
        .as_ref()
        .context("channel source was not prepared")?;
    let source_read_path = read.path().to_owned();
    let writer = rusqlite::Connection::open(channel.join("channels.sqlite3"))?;
    writer.busy_timeout(Duration::ZERO)?;
    let error = writer.execute_batch("BEGIN IMMEDIATE").unwrap_err();
    assert!(
        matches!(error, rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::DatabaseBusy)
    );
    // A peer reader may update its own SHM marks. Capture that separate effect
    // before asserting the migration itself leaves every source file untouched.
    writer.close().map_err(|(_, error)| error)?;
    let before_copy = channel_files(&channel)?;
    coordinator.publish_component_checked(
        id,
        STORAGE_PERSISTENT_ROOT_DOMAIN,
        source.copy_exclusions(),
        |inventory| source.verify_source_inventory(inventory),
    )?;
    let published = coordinator.open_published_component(id, STORAGE_PERSISTENT_ROOT_DOMAIN)?;
    let target_channel = published.destination_path().join("studio/gateway/channels");
    let target_before = channel_files(&target_channel)?;
    relocate_gateway_domains(
        &mut coordinator,
        id,
        Some(&mut owner_command()),
        &source,
        &published,
    )
    .await?;
    verify_gateway_domains(
        &mut coordinator,
        id,
        Some(&mut owner_command()),
        &source,
        &published,
    )
    .await?;
    assert_eq!(channel_files(&channel)?, before_copy);
    assert_eq!(channel_files(&target_channel)?, target_before);
    drop(source);
    assert!(!source_read_path.exists());
    Ok(())
}

#[tokio::test]
async fn channel_source_rejects_live_writers_and_pending_journals_without_source_mutation()
-> Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let owned = tempfile::tempdir()?;
    let home = owned.path();
    let channel = home.join(".config/kcoder/studio/gateway/channels");
    fs::create_dir_all(&channel)?;
    // Keep SQLite's POSIX locks in a separate owned process: the snapshots below
    // open/close source files, which would release a same-process SQLite lock.
    let mut command = Command::new(node());
    command.args(["--input-type=module", "--eval"])
        .arg("const{ChannelStore}=await import(process.argv[1]);const store=new ChannelStore(process.argv[2]);\
              store.db.exec('BEGIN IMMEDIATE');process.stdout.write('READY\\n');\
              process.stdin.once('data',()=>{store.db.exec('ROLLBACK');store.close();process.exit(0);});")
        .arg(root().join("apps/kcoder-channel-host/src/channels/store.mjs"))
        .arg(&channel)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit());
    let mut writer = kcoder_process_supervisor::owned_process::OwnedProcess::spawn(&mut command)?;
    let mut output = BufReader::new(writer.child.stdout.take().context("owned writer stdout")?);
    let mut ready = String::new();
    tokio::time::timeout(Duration::from_secs(15), output.read_line(&mut ready)).await??;
    ensure!(
        ready == "READY\n",
        "owned writer did not acquire SQLite's lock"
    );
    let id = "channel-busy-preflight";
    let plan = plan(home, None, id)?;
    let mut coordinator = StorageCoordinator::acquire(home)?;
    coordinator.begin(plan)?;
    coordinator.advance(id, Phase::Planned, Phase::Stopping)?;
    coordinator.advance(id, Phase::Stopping, Phase::Stopped)?;
    coordinator.advance(id, Phase::Stopped, Phase::Copying)?;
    let before = channel_files(&channel)?;
    let rejected = channels::ChannelRead::prepare(&mut coordinator, id, &channel).is_err();
    let after = channel_files(&channel)?;
    let mut input = writer.child.stdin.take().context("owned writer stdin")?;
    input.write_all(b"ROLLBACK\n").await?;
    drop(input);
    let status = tokio::time::timeout(Duration::from_secs(15), writer.child.wait()).await??;
    writer.finish().await?;
    assert!(status.success());
    assert!(rejected);
    assert_eq!(after, before);
    let journal = channel.join("channels.sqlite3-journal");
    fs::write(&journal, b"unknown original recovery journal")?;
    let before = channel_files(&channel)?;
    let error = match channels::ChannelRead::prepare(&mut coordinator, id, &channel) {
        Ok(_) => anyhow::bail!("pending channel journal was accepted"),
        Err(error) => error,
    };
    ensure!(
        error
            .to_string()
            .contains("source_sqlite_recovery_required")
    );
    assert_eq!(channel_files(&channel)?, before);
    assert_eq!(fs::read(journal)?, b"unknown original recovery journal");
    Ok(())
}
