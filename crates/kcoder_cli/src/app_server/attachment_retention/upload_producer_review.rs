//! Real service/filesystem + separately killed subprocess contracts; no Provider.
use super::*;
use std::collections::BTreeMap;

fn upload_scope(service: &RetentionService) -> Scope {
    let legacy = fixture_scope(service);
    service
        .full_scope(
            &legacy.context,
            &legacy.workspace_identity,
            Some(&WorkspaceParentAccountV2 {
                role: "user".into(),
                authorization_generation: "1".into(),
            }),
            "target-a",
        )
        .unwrap()
}
fn params(service: &RetentionService, scope: &Scope) -> RetentionUploadParamsV1 {
    let admission = service.upload_admission().unwrap();
    let id = |prefix| {
        format!(
            "{prefix}.{}.{}.0123456789abcdef0123456789abcdef",
            admission.root_namespace, admission.admission_epoch
        )
    };
    RetentionUploadParamsV1 {
        owner_request: RetentionOwnerRequestV1 {
            client_owner_request_id: id("o1"),
            immutable_parameters: BTreeMap::from([("purpose".into(), "attachment-upload".into())]),
        },
        client_upload_id: id("u1"),
        trusted_context: scope.context.clone(),
        filename: Some("input.txt".into()),
        size: Some(11),
        content_sha256: Some(digest(b"hello world")),
        offset: None,
        length: None,
        chunk_sha256: None,
        content_base64: None,
    }
}
fn chunk(mut params: RetentionUploadParamsV1, offset: u64, data: &[u8]) -> RetentionUploadParamsV1 {
    params.offset = Some(offset);
    params.length = Some(data.len() as u64);
    params.chunk_sha256 = Some(digest(data));
    params
}
fn confirmed(result: &RetentionUploadResultV1) -> u64 {
    match &result.lookup {
        RetentionUploadLookupV1::Present { recovery, .. } => recovery.confirmed_bytes,
        other => panic!("unexpected {other:?}"),
    }
}
fn state(service: &RetentionService) -> serde_json::Value {
    serde_json::to_value(&service.store.transaction().unwrap().state).unwrap()
}
#[test]
fn retained_upload_exact_read_start_chunks_seal_replay_restart() -> Result<()> {
    let (temp, service, _) = fixture(Limits::default());
    let scope = upload_scope(&service);
    let p = params(&service, &scope);
    let before = state(&service);
    assert!(matches!(
        service.read_wire_upload(&scope, &p)?.lookup,
        RetentionUploadLookupV1::Absent
    ));
    assert_eq!(
        state(&service),
        before,
        "read must not initialize or charge"
    );
    let started = service.start_wire_upload(&scope, &p)?;
    assert_eq!(confirmed(&started), 0);
    let charged = state(&service);
    service.start_wire_upload(&scope, &p)?;
    assert_eq!(state(&service)["charges"], charged["charges"]);
    let first = chunk(p.clone(), 0, b"hello ");
    service.chunk_wire_upload(&scope, &first, b"hello ")?;
    assert_eq!(confirmed(&service.read_wire_upload(&scope, &p)?), 6);
    service.chunk_wire_upload(&scope, &first, b"hello ")?;
    assert!(
        service
            .chunk_wire_upload(&scope, &chunk(p.clone(), 8, b"x"), b"x")
            .is_err()
    );
    assert!(
        service
            .chunk_wire_upload(&scope, &chunk(p.clone(), 0, b"HELLO "), b"HELLO ")
            .is_err()
    );
    service.chunk_wire_upload(&scope, &chunk(p.clone(), 6, b"world"), b"world")?;
    let sealed = service.finish_wire_upload(&scope, &p)?;
    assert_eq!(confirmed(&sealed), 11);
    drop(service);
    let restored = RetentionService::open(&temp.path().join("account"), true, Limits::default())?;
    assert_eq!(restored.read_wire_upload(&scope, &p)?, sealed);
    assert_eq!(restored.finish_wire_upload(&scope, &p)?, sealed);
    Ok(())
}
#[test]
fn retained_upload_root_global_owner_and_upload_ids_reject_foreign_scope() -> Result<()> {
    let (_temp, service, _) = fixture(Limits::default());
    let scope = upload_scope(&service);
    let p = params(&service, &scope);
    service.start_wire_upload(&scope, &p)?;
    let mut context = scope.context.clone();
    context.device_id = "foreign-device".into();
    let foreign = service.full_scope(
        &context,
        &scope.workspace_identity,
        scope.workspace_account.as_ref(),
        "target-a",
    )?;
    let before = state(&service);
    assert!(service.read_wire_upload(&foreign, &p).is_err());
    assert!(service.start_wire_upload(&foreign, &p).is_err());
    assert!(
        service
            .create_owner_with_request(&foreign, &p.owner_request)
            .is_err()
    );
    assert_eq!(state(&service), before);
    let mut changed = p.clone();
    changed.filename = Some("different.txt".into());
    assert!(service.start_wire_upload(&scope, &changed).is_err());
    assert_eq!(state(&service), before);
    Ok(())
}
#[test]
fn retained_upload_combined_admission_has_zero_effects_at_capacity() -> Result<()> {
    let limits = Limits {
        receipt_slots: 1,
        ..Limits::default()
    };
    let (_temp, service, _) = fixture(limits);
    let scope = upload_scope(&service);
    let p = params(&service, &scope);
    {
        let mut tx = service.store.transaction()?;
        tx.state.charges.receipt_slots = 1;
        tx.commit()?;
    }
    let before = state(&service);
    assert!(service.start_wire_upload(&scope, &p).is_err());
    assert_eq!(state(&service), before);
    assert!(
        service
            .read_owner_request(&scope, &p.owner_request)?
            .is_none(),
        "must not leave orphan owner"
    );
    let mut future = p.clone();
    let parts: Vec<_> = p.client_upload_id.split('.').collect();
    future.client_upload_id = format!("u1.{}.999.{}", parts[1], parts[3]);
    assert!(service.start_wire_upload(&scope, &future).is_err());
    assert_eq!(state(&service), before);
    Ok(())
}
#[test]
fn retained_upload_cancel_is_durable_and_does_not_readmit() -> Result<()> {
    let (_temp, service, _) = fixture(Limits::default());
    let scope = upload_scope(&service);
    let p = params(&service, &scope);
    service.start_wire_upload(&scope, &p)?;
    service.chunk_wire_upload(&scope, &chunk(p.clone(), 0, b"hello "), b"hello ")?;
    let cancelled = service.cancel_wire_upload(&scope, &p)?;
    assert!(
        matches!(&cancelled.lookup, RetentionUploadLookupV1::Present { recovery, .. } if recovery.state == RetentionUploadStateV1::Cancelled)
    );
    assert_eq!(service.cancel_wire_upload(&scope, &p)?, cancelled);
    assert_eq!(service.start_wire_upload(&scope, &p)?, cancelled);
    assert!(
        service
            .chunk_wire_upload(&scope, &chunk(p.clone(), 0, b"hello "), b"hello ")
            .is_err()
    );
    Ok(())
}
#[test]
fn retained_upload_crash_child() -> Result<()> {
    if std::env::var("KCODER_TEST_RETAINED_UPLOAD_CHILD")
        .ok()
        .as_deref()
        != Some("armed")
    {
        return Ok(());
    }
    let root = PathBuf::from(std::env::var_os(INIT_CRASH_CHILD_ROOT_ENV).unwrap());
    let service = RetentionService::open(&root.join("account"), true, Limits::default())?;
    let scope = upload_scope(&service);
    let p = params(&service, &scope);
    service.start_wire_upload(&scope, &p)?;
    service.chunk_wire_upload(&scope, &chunk(p.clone(), 0, b"hello world"), b"hello world")?;
    service.finish_wire_upload(&scope, &p)?;
    if std::env::var("KCODER_TEST_UPLOAD_CRASH_PHASE")
        .unwrap_or_default()
        .starts_with("release-")
    {
        service.cancel_wire_upload(&scope, &p)?;
    }
    anyhow::bail!("crash checkpoint was not reached")
}
fn kill_upload_at(temp: &TempDir, phase: &str, entry_id: &str) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700))?;
    let step = if phase.starts_with("v2-") {
        phase.into()
    } else {
        format!("v2-upload-{phase}")
    };
    let mut process = Command::new(std::env::current_exe()?)
        .args(["--exact", "app_server::attachment_retention::tests::upload_producer_review::retained_upload_crash_child", "--test-threads=1"])
        .env("KCODER_TEST_RETAINED_UPLOAD_CHILD", "armed")
        .env(INIT_CRASH_CHILD_ARM_ENV, INIT_CRASH_CHILD_ARM_VALUE)
        .env(INIT_CRASH_CHILD_ROOT_ENV, temp.path())
        .env(INIT_CRASH_CHILD_STEP_ENV, &step)
        .env("KCODER_TEST_UPLOAD_CRASH_PHASE", phase)
        .env("KCODER_TEST_UPLOAD_CRASH_ID", entry_id)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let deadline = Instant::now() + Duration::from_secs(8);
    while !temp.path().join(INIT_CRASH_READY_FILE).exists() {
        if let Some(status) = process.try_wait()? {
            let output = process.wait_with_output()?;
            anyhow::bail!(
                "{phase}: child ended early {status}: {}",
                format!(
                    "{} {}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                )
            );
        }
        if Instant::now() >= deadline {
            let _ = process.kill();
            let _ = process.wait();
            anyhow::bail!("{phase}: checkpoint timeout");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        std::fs::read_to_string(temp.path().join(INIT_CRASH_READY_FILE))?
            .starts_with(&format!("{step}\n"))
    );
    process.kill()?;
    let status = process.wait()?;
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(
        status.signal(),
        Some(libc::SIGKILL),
        "{phase}: real SIGKILL required"
    );
    Ok(())
}
#[test]
fn retained_upload_sigkill_pending_written_synced_and_sealed_recover_original_id() -> Result<()> {
    for phase in [
        "v2-reserved",
        "v2-anonymous-sealed",
        "v2-publishing",
        "payload-anonymous-sealed",
        "payload-publishing",
        "payload-linked",
        "payload-parent-synced",
        "pending",
        "written",
        "synced",
        "sealed",
    ] {
        let (temp, service, _) = fixture(Limits::default());
        let scope = upload_scope(&service);
        let p = params(&service, &scope);
        let entry_id = digest(&serde_json::to_vec(&(
            "upload-entry-v1",
            service.namespace(),
            &p.client_upload_id,
        ))?);
        drop(service);
        kill_upload_at(&temp, phase, &entry_id)?;
        let service =
            RetentionService::open(&temp.path().join("account"), true, Limits::default())?;
        let charged = state(&service)["charges"].clone();
        let read = service.read_wire_upload(&scope, &p)?;
        assert_eq!(read.client_upload_id, p.client_upload_id);
        assert_eq!(
            confirmed(&read),
            if ["written", "synced", "sealed"].contains(&phase) {
                11
            } else {
                0
            },
            "{phase}"
        );
        service.start_wire_upload(&scope, &p)?;
        for field in ["owners", "entries", "receipt_slots", "staged_bytes"] {
            assert_eq!(
                state(&service)["charges"][field],
                charged[field],
                "{phase}: no new {field} admission"
            );
        }
        service.chunk_wire_upload(&scope, &chunk(p.clone(), 0, b"hello world"), b"hello world")?;
        let sealed = service.finish_wire_upload(&scope, &p)?;
        assert_eq!(confirmed(&sealed), 11, "{phase}");
    }
    Ok(())
}
#[test]
fn retained_upload_unproven_created_directory_is_unknown_and_not_adopted() -> Result<()> {
    let (temp, service, _) = fixture(Limits::default());
    let scope = upload_scope(&service);
    let p = params(&service, &scope);
    let entry_id = digest(&serde_json::to_vec(&(
        "upload-entry-v1",
        service.namespace(),
        &p.client_upload_id,
    ))?);
    {
        let created = service.create_owner_with_upload(&scope, &p.owner_request, Some(&p))?;
        drop(created);
        let mut tx = service.store.transaction()?;
        let mut entry: Entry = tx.read(Area::Entries, &entry_id)?.unwrap();
        entry.upload.as_mut().unwrap().storage_layout = UploadStorageLayout::DirectoryV1;
        entry.directory_identity = None;
        entry.quarantine = format!("q-entry-{entry_id}");
        let value = serde_json::to_value(&entry)?;
        assert!(value["upload"].get("storage_layout").is_none());
        tx.put(Area::Entries, &entry_id, entry.epoch, &entry)?;
        tx.commit()?;
    }
    drop(service);
    kill_upload_at(&temp, "directory-created", &entry_id)?;
    let service = RetentionService::open(&temp.path().join("account"), true, Limits::default())?;
    let before = state(&service)["charges"].clone();
    let directory = service
        .store
        .data()?
        .open_child(OsStr::new(&entry_id), false)?;
    let identity = directory.retention_identity()?;
    assert!(service.start_wire_upload(&scope, &p).is_err());
    assert!(
        service
            .chunk_wire_upload(&scope, &chunk(p.clone(), 0, b"hello world"), b"hello world")
            .is_err()
    );
    assert!(service.cancel_wire_upload(&scope, &p).is_err());
    assert_eq!(
        service
            .store
            .data()?
            .open_child(OsStr::new(&entry_id), false)?
            .retention_identity()?,
        identity
    );
    assert_eq!(
        state(&service)["charges"],
        before,
        "Unknown never refunds or creates another owner"
    );
    Ok(())
}

#[test]
fn retained_upload_lost_anonymous_inode_never_adopts_payload_or_quarantine() -> Result<()> {
    for collision in ["payload", "quarantine"] {
        let (temp, service, _) = fixture(Limits::default());
        let scope = upload_scope(&service);
        let p = params(&service, &scope);
        let entry_id = digest(&serde_json::to_vec(&(
            "upload-entry-v1",
            service.namespace(),
            &p.client_upload_id,
        ))?);
        drop(service);
        kill_upload_at(&temp, "payload-publishing", &entry_id)?;
        let service =
            RetentionService::open(&temp.path().join("account"), true, Limits::default())?;
        let before = state(&service)["charges"].clone();
        let data = service.store.data()?;
        let entry: Entry = service
            .store
            .transaction()?
            .read(Area::Entries, &entry_id)?
            .unwrap();
        let (directory, payload_name) = service.upload_location(&entry)?;
        if collision == "payload" {
            directory.atomic_replace(OsStr::new(&payload_name), b"foreign")?;
        } else {
            data.atomic_replace(OsStr::new(&entry.quarantine), b"foreign")?;
        }
        assert!(service.read_wire_upload(&scope, &p).is_err(), "{collision}");
        assert!(
            service.start_wire_upload(&scope, &p).is_err(),
            "{collision}"
        );
        assert!(
            service.cancel_wire_upload(&scope, &p).is_err(),
            "{collision}"
        );
        assert_eq!(state(&service)["charges"], before);
        if collision == "payload" {
            let mut bytes = Vec::new();
            directory
                .open_regular_file(OsStr::new(&payload_name))?
                .read_to_end(&mut bytes)?;
            assert_eq!(bytes, b"foreign");
        } else {
            assert!(
                data.open_regular_file(OsStr::new(&entry.quarantine))
                    .is_ok()
            );
        }
    }
    Ok(())
}

#[test]
fn retained_upload_root_leaf_cancel_sigkill_quarantine_and_owner_retirement() -> Result<()> {
    for phase in ["release-renamed", "release-quarantined", "release-unlinked"] {
        let (temp, service, _) = fixture(Limits::default());
        let scope = upload_scope(&service);
        let p = params(&service, &scope);
        let entry_id = digest(&serde_json::to_vec(&(
            "upload-entry-v1",
            service.namespace(),
            &p.client_upload_id,
        ))?);
        drop(service);
        kill_upload_at(&temp, phase, &entry_id)?;
        let service =
            RetentionService::open(&temp.path().join("account"), true, Limits::default())?;
        let cancelled = service.cancel_wire_upload(&scope, &p)?;
        assert!(
            matches!(cancelled.lookup, RetentionUploadLookupV1::Present { ref recovery, .. } if recovery.state == RetentionUploadStateV1::Cancelled)
        );
        assert_eq!(service.cancel_wire_upload(&scope, &p)?, cancelled);
        let entry: Entry = service
            .store
            .transaction()?
            .read(Area::Entries, &entry_id)?
            .unwrap();
        assert_eq!(entry.storage_layout(), UploadStorageLayout::RootLeafV1);
        let (data, name) = service.upload_location(&entry)?;
        assert!(matches!(data.open_regular_file(OsStr::new(&name)), Err(ref e) if missing(e)));
        assert!(
            matches!(data.open_regular_file(OsStr::new(&entry.quarantine)), Err(ref e) if missing(e))
        );
        let owner = service
            .read_owner_request(&scope, &p.owner_request)?
            .unwrap();
        let lease = owner.lease.unwrap();
        service.retire_owner(&scope, &lease)?;
        drop(lease);
        assert_eq!(state(&service)["charges"]["staged_bytes"], 0);
        assert_eq!(state(&service)["charges"]["entries"], 0);
        assert_eq!(state(&service)["charges"]["receipt_slots"], 0);
        assert_eq!(service.read_wire_upload(&scope, &p)?, cancelled);
    }
    Ok(())
}
#[test]
fn retained_upload_bad_publishing_metadata_is_never_reinterpreted() -> Result<()> {
    for malformed in ["payload-identity", "manifest-digest", "manifest-inode"] {
        let (temp, service, _) = fixture(Limits::default());
        let scope = upload_scope(&service);
        let p = params(&service, &scope);
        let entry_id = digest(&serde_json::to_vec(&(
            "upload-entry-v1",
            service.namespace(),
            &p.client_upload_id,
        ))?);
        let owner_id = service.owner_request_locator(&scope, &p.owner_request)?.0;
        drop(service);
        kill_upload_at(
            &temp,
            if malformed == "payload-identity" {
                "payload-publishing"
            } else {
                "v2-publishing"
            },
            &entry_id,
        )?;
        let service =
            RetentionService::open(&temp.path().join("account"), true, Limits::default())?;
        let mut tx = service.store.transaction()?;
        if malformed == "payload-identity" {
            let mut entry: Entry = tx.read(Area::Entries, &entry_id)?.unwrap();
            entry.payload_identity = None;
            tx.put(Area::Entries, &entry_id, entry.epoch, &entry)?;
        } else {
            let mut owner: Owner = tx.read(Area::Owners, &owner_id)?.unwrap();
            if malformed == "manifest-digest" {
                owner.manifest.as_mut().unwrap().payload_sha256 = "00".repeat(32);
            } else {
                owner.lease_identity = None;
            }
            tx.put(Area::Owners, &owner_id, owner.epoch, &owner)?;
        }
        tx.commit()?;
        assert!(
            service.start_wire_upload(&scope, &p).is_err(),
            "{malformed}"
        );
        assert!(
            service.cancel_wire_upload(&scope, &p).is_err(),
            "{malformed}"
        );
        let data = service.store.data()?;
        assert!(
            matches!(data.open_regular_file(OsStr::new(&format!("u-entry-{entry_id}"))), Err(ref e) if missing(e))
        );
    }
    Ok(())
}

#[test]
fn retained_upload_root_leaf_reserve_release_consume_restart() -> Result<()> {
    let (temp, service, _) = fixture(Limits::default());
    let scope = upload_scope(&service);
    let p = params(&service, &scope);
    service.start_wire_upload(&scope, &p)?;
    service.chunk_wire_upload(&scope, &chunk(p.clone(), 0, b"hello world"), b"hello world")?;
    let sealed = service.finish_wire_upload(&scope, &p)?;
    let reference = match sealed.lookup {
        RetentionUploadLookupV1::Present { recovery, .. } => recovery.stage_ref.unwrap(),
        _ => unreachable!(),
    };
    let entry: Entry = service
        .store
        .transaction()?
        .read(Area::Entries, &reference.entry_id)?
        .unwrap();
    assert_eq!(entry.storage_layout(), UploadStorageLayout::RootLeafV1);
    let (data, name) = service.upload_location(&entry)?;
    let receipt = service.reserve(
        &scope,
        &wire_id(service.namespace(), reference.epoch),
        "thread-a",
        &[reference],
    )?;
    let lease = service
        .read_owner_request(&scope, &p.owner_request)?
        .unwrap()
        .lease
        .unwrap();
    let released =
        service.release_original_owner(&scope, &lease, &receipt.retention_id, receipt.revision)?;
    assert_eq!(released.state, RetentionReceiptStateV1::Released);
    assert!(matches!(data.open_regular_file(OsStr::new(&name)), Err(ref e) if missing(e)));
    assert!(
        matches!(data.open_regular_file(OsStr::new(&entry.quarantine)), Err(ref e) if missing(e))
    );
    let ack = RetentionConsumeAckV1 {
        retention_id: receipt.retention_id,
        terminal_revision: released.revision,
        client_ack_id: "upload-consume".into(),
    };
    assert_eq!(
        service.consume(&scope, &ack, &NoAcceptedTurnProof)?,
        RetentionConsumeStatusV1::Consumed
    );
    drop(lease);
    drop(service);
    let service = RetentionService::open(&temp.path().join("account"), true, Limits::default())?;
    assert_eq!(
        service.consume(&scope, &ack, &NoAcceptedTurnProof)?,
        RetentionConsumeStatusV1::Consumed
    );
    assert_eq!(state(&service)["charges"]["staged_bytes"], 0);
    assert_eq!(state(&service)["charges"]["entries"], 0);
    assert_eq!(state(&service)["charges"]["receipt_slots"], 0);
    Ok(())
}
#[test]
fn retained_upload_old_directory_record_without_layout_can_continue_and_cancel() -> Result<()> {
    let (temp, service, _) = fixture(Limits::default());
    let scope = upload_scope(&service);
    let p = params(&service, &scope);
    let entry_id = digest(&serde_json::to_vec(&(
        "upload-entry-v1",
        service.namespace(),
        &p.client_upload_id,
    ))?);
    let created = service.create_owner_with_upload(&scope, &p.owner_request, Some(&p))?;
    drop(created);
    {
        let mut tx = service.store.transaction()?;
        let mut entry: Entry = tx.read(Area::Entries, &entry_id)?.unwrap();
        entry.upload.as_mut().unwrap().storage_layout = UploadStorageLayout::DirectoryV1;
        entry.directory_identity = None;
        entry.quarantine = format!("q-entry-{entry_id}");
        let value = serde_json::to_value(&entry)?;
        assert!(value["upload"].get("storage_layout").is_none());
        let legacy: Entry = serde_json::from_value(value)?;
        assert_eq!(legacy.storage_layout(), UploadStorageLayout::DirectoryV1);
        tx.put(Area::Entries, &entry_id, entry.epoch, &legacy)?;
        tx.commit()?;
    }
    service.start_wire_upload(&scope, &p)?;
    service.chunk_wire_upload(&scope, &chunk(p.clone(), 0, b"hello "), b"hello ")?;
    drop(service);
    let service = RetentionService::open(&temp.path().join("account"), true, Limits::default())?;
    assert_eq!(confirmed(&service.read_wire_upload(&scope, &p)?), 6);
    service.chunk_wire_upload(&scope, &chunk(p.clone(), 6, b"world"), b"world")?;
    service.finish_wire_upload(&scope, &p)?;
    let entry: Entry = service
        .store
        .transaction()?
        .read(Area::Entries, &entry_id)?
        .unwrap();
    assert_eq!(entry.storage_layout(), UploadStorageLayout::DirectoryV1);
    service
        .store
        .data()?
        .open_verified_child(
            OsStr::new(&entry.id),
            entry.directory_identity.as_ref().unwrap(),
        )?
        .open_verified_regular(
            OsStr::new("payload"),
            entry.payload_identity.as_ref().unwrap(),
        )?;
    let cancelled = service.cancel_wire_upload(&scope, &p)?;
    assert!(
        matches!(cancelled.lookup, RetentionUploadLookupV1::Present { recovery, .. } if recovery.state == RetentionUploadStateV1::Cancelled)
    );
    assert_eq!(state(&service)["charges"]["staged_bytes"], 0);
    Ok(())
}

#[test]
fn retained_upload_allocating_transfer_metadata_cannot_recreate_any_files() -> Result<()> {
    for phase in ["payload-publishing", "v2-reserved", "v2-publishing"] {
        let (temp, service, _) = fixture(Limits::default());
        let scope = upload_scope(&service);
        let p = params(&service, &scope);
        let entry_id = digest(&serde_json::to_vec(&(
            "upload-entry-v1",
            service.namespace(),
            &p.client_upload_id,
        ))?);
        drop(service);
        kill_upload_at(&temp, phase, &entry_id)?;
        let service =
            RetentionService::open(&temp.path().join("account"), true, Limits::default())?;
        let mut tx = service.store.transaction()?;
        let mut entry: Entry = tx.read(Area::Entries, &entry_id)?.unwrap();
        entry.transfer = Some(TransferBinding {
            thread_id: "thread-a".into(),
            client_message_id: "message-a".into(),
            attempt_id: "attempt-a".into(),
            input_sha256: digest(b"input"),
            artifact_identity: entry
                .payload_identity
                .clone()
                .unwrap_or(entry.directory_identity.clone().unwrap()),
            artifact_sha256: entry.content_sha256.clone(),
            artifact_size: entry.size,
        });
        tx.put(Area::Entries, &entry_id, entry.epoch, &entry)?;
        tx.commit()?;
        let before = state(&service);
        assert!(
            service.read_wire_upload(&scope, &p).is_err(),
            "{phase}: read"
        );
        assert!(
            service.start_wire_upload(&scope, &p).is_err(),
            "{phase}: start"
        );
        assert!(
            service.cancel_wire_upload(&scope, &p).is_err(),
            "{phase}: cancel"
        );
        assert_eq!(
            state(&service),
            before,
            "{phase}: no journal or charge changes"
        );
        let data = service.store.data()?;
        for leaf in [format!("u-entry-{entry_id}"), entry.quarantine] {
            assert!(
                matches!(data.open_regular_file(OsStr::new(&leaf)), Err(ref e) if missing(e)),
                "{phase}: {leaf}"
            );
        }
    }
    Ok(())
}
