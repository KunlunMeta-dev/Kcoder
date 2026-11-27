//! Windows native file locks protect locator visibility, not message authority.
use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc,
};
use std::time::Duration;

fn service() -> Result<(tempfile::TempDir, Arc<PeerMessageService>)> {
    let root = tempfile::tempdir()?;
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    std::fs::create_dir(&workspace)?;
    let directory = kcoder_config::PrivateDirectory::open_or_create(&profile)?;
    directory.atomic_replace(
        std::ffi::OsStr::new("settings.json"),
        br#"{"cross_session_messages":{"enabled":true,"wake_idle":false}}"#,
    )?;
    let service = PeerMessageService::capture(
        kcoder_config::ConfigPaths::with_config_dir_and_executable_dir(&workspace, profile, None),
        workspace,
        None,
    )?;
    Ok((root, service))
}

#[test]
fn windows_locator_claim_precedes_visibility_and_survives_temporary_handle_close() -> Result<()> {
    let (_root, service) = service()?;
    let directory = service.live_registry(true)?.context("owned registry")?;
    let address = service.address("owned-worker")?;
    let name = OsString::from("owned-worker.claim.json");
    let bytes = serde_json::to_vec(&Locator {
        version: 1,
        address: address.clone(),
    })?;
    let (claimed, wait_claimed) = mpsc::sync_channel(1);
    let (release, wait_release) = mpsc::sync_channel(1);
    let worker_directory = directory.duplicate_handle()?;
    let worker_name = name.clone();
    let worker = std::thread::spawn(move || -> Result<std::fs::File> {
        let calls = AtomicUsize::new(0);
        publish_windows_claim(&worker_directory, &worker_name, &bytes, &|| {
            if calls.fetch_add(1, Ordering::SeqCst) == 1 {
                claimed.send(()).context("owned publisher claim signal")?;
                wait_release
                    .recv_timeout(Duration::from_secs(5))
                    .context("owned reader release")?;
            }
            Ok(())
        })
    });
    let observed_claim = wait_claimed.recv_timeout(Duration::from_secs(5));
    let observed = live_candidates(&service);
    let visible_before_publish = directory.entry_metadata(&name).is_ok();
    let _ = release.send(());
    let entry = worker.join().expect("owned publisher exited")?;
    observed_claim.context("owned publisher reached the pre-publication fence")?;
    assert!(observed?.is_empty());
    assert!(
        !visible_before_publish,
        "a reader never sees the unlocked publication stage"
    );
    assert!(live_candidates(&service)?.contains(&address));
    let alias = entry.try_clone()?;
    drop(alias);
    let reader = directory.open_single_link_regular_file(&name)?;
    // An older reader probes the entire file and then reads the bounded body
    // with ReadFile. The liveness byte must not deny that ordinary body read.
    let error = fs2::FileExt::try_lock_shared(&reader).expect_err("original claim remains held");
    assert!(
        error.kind() == std::io::ErrorKind::WouldBlock
            || error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
    );
    let mut legacy_reader = reader.try_clone()?;
    let mut observed_bytes = Vec::new();
    (&mut legacy_reader)
        .take(2049)
        .read_to_end(&mut observed_bytes)?;
    let observed_locator: Locator = serde_json::from_slice(&observed_bytes)?;
    assert_eq!(observed_locator.address, address);
    drop(entry);
    fs2::FileExt::try_lock_shared(&reader)?;
    fs2::FileExt::unlock(&reader)?;
    assert!(
        live_candidates(&service)?.is_empty(),
        "an actually released claim is stale"
    );
    Ok(())
}

#[test]
fn windows_locator_owner_change_after_claim_never_publishes_a_name() -> Result<()> {
    let (_root, service) = service()?;
    let directory = service.live_registry(true)?.context("owned registry")?;
    let name = std::ffi::OsStr::new("owned-worker.revoked.json");
    let checks = AtomicUsize::new(0);
    let result = publish_windows_claim(&directory, name, b"not published", &|| {
        ensure!(
            checks.fetch_add(1, Ordering::SeqCst) == 0,
            "owned source revoked"
        );
        Ok(())
    });
    assert!(result.is_err());
    assert!(directory.entry_metadata(name).is_err());
    assert!(live_candidates(&service)?.is_empty());
    Ok(())
}

#[test]
fn windows_locator_drop_preserves_a_replacement_at_the_same_name() -> Result<()> {
    let (_root, service) = service()?;
    let directory = service.live_registry(true)?.context("owned registry")?;
    let name = OsString::from("owned-worker.cleanup.json");
    let entry = publish_windows_claim(&directory, &name, b"owned original", &|| Ok(()))?;
    let registration = Registration {
        directory: directory.duplicate_handle()?,
        name: name.clone(),
        entry,
    };
    directory.rename_no_replace(&name, std::ffi::OsStr::new("moved-original"))?;
    directory.atomic_publish_from_reader(&name, &mut &b"replacement"[..], false, || Ok(()))?;
    drop(registration);
    let mut bytes = Vec::new();
    directory
        .open_single_link_regular_file(&name)?
        .read_to_end(&mut bytes)?;
    assert_eq!(bytes, b"replacement");
    Ok(())
}

#[test]
fn windows_legacy_whole_file_claim_only_supplies_validated_locator_hints() -> Result<()> {
    let (_root, service) = service()?;
    let directory = service.live_registry(true)?.context("owned registry")?;
    let thread_id = "owned-legacy-no-endpoint";
    let address = service.address(thread_id)?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let name = OsString::from(format!("{thread_id}.{nonce}.json"));
    directory.atomic_publish_from_reader(
        &name,
        &mut &b"inaccessible bytes never grant resident status"[..],
        false,
        || Ok(()),
    )?;
    let legacy_claim = directory.open_single_link_regular_file(&name)?;
    fs2::FileExt::try_lock_exclusive(&legacy_claim)?;
    assert_eq!(live_candidates(&service)?, vec![address.clone()]);
    let observed = super::super::endpoint::read_peer_status(&service, &address)
        .expect_err("a forged locked locator has no actual owner endpoint");
    assert!(
        observed
            .downcast_ref::<super::super::endpoint::OriginalSourceUnavailable>()
            .is_some(),
        "the hint reaches an actual endpoint lookup, not a resident row: {observed}"
    );
    for invalid in [
        format!("{thread_id}.not-a-uuid.json"),
        format!("{thread_id}.AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.json"),
        format!("invalid.thread.{nonce}.json"),
        format!(".{nonce}.json"),
        format!("{thread_id}.{}.json", uuid::Uuid::nil()),
    ] {
        assert!(legacy_windows_hint(&service, std::ffi::OsStr::new(&invalid))?.is_none());
    }
    // An unlocked or released name is stale even if it has the exact legacy
    // shape. The pathname and old body do not keep an owner alive.
    drop(legacy_claim);
    assert!(live_candidates(&service)?.is_empty());
    Ok(())
}
