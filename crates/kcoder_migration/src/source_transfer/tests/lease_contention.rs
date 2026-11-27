use super::*;
use std::{sync::mpsc, thread, time::Duration};

#[test]
fn target_admission_survives_a_short_original_observer_lease() {
    let fixture = Fixture::new();
    let manifest = fixture.export(ExportSelection::Configuration(
        fixture.config(Kind::ClaudeCode),
    ));
    let directory = PrivateDirectory::open_existing(
        &fixture
            .target_profile
            .join("migrations/source-transfer/incoming")
            .join(format!("{}.admission", fixture.request)),
    )
    .unwrap();
    let observer = super::super::storage::try_operation_lease(&directory, "writer.lock")
        .unwrap()
        .unwrap();
    thread::scope(|scope| {
        let (send, receive) = mpsc::sync_channel(1);
        let target = &fixture.target;
        let source = fixture.source.authority();
        let manifest = &manifest;
        scope.spawn(move || {
            let result = target.begin(manifest, source);
            send.send(result.map(|_| ())).unwrap();
        });
        let before_release = receive.recv_timeout(Duration::from_millis(30));
        drop(observer);
        let result = match before_release {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                receive.recv_timeout(Duration::from_secs(2)).unwrap()
            }
            Err(error) => panic!("producer disconnected: {error}"),
        };
        result.expect("a short observer lease must not terminate the original admission");
    });
    assert_eq!(fixture.copy(&manifest).request_id, fixture.request);
}

#[test]
fn long_held_observer_lease_stays_bounded_without_starting_or_resetting_target() {
    let fixture = Fixture::new();
    let manifest = fixture.export(ExportSelection::Configuration(
        fixture.config(Kind::ClaudeCode),
    ));
    let root = fixture
        .target_profile
        .join("migrations/source-transfer/incoming");
    let path = root.join(format!("{}.admission", fixture.request));
    let directory = PrivateDirectory::open_existing(&path).unwrap();
    let before = std::fs::read(path.join("control.json")).unwrap();
    let observer = super::super::storage::try_operation_lease(&directory, "writer.lock")
        .unwrap()
        .unwrap();
    let started = std::time::Instant::now();
    let result = fixture.target.begin(&manifest, fixture.source.authority());
    assert_eq!(result.err().unwrap().to_string(), "source_transfer_busy");
    assert!(started.elapsed() >= Duration::from_millis(250));
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(std::fs::read(path.join("control.json")).unwrap(), before);
    assert!(!root.join(&fixture.request).exists());
    assert!(
        super::super::storage::try_operation_lease(&directory, "writer.lock")
            .unwrap()
            .is_none()
    );
    drop(observer);
}

#[test]
fn contended_acquisition_never_rebinds_a_replaced_original_lock() {
    let fixture = Fixture::new();
    let path = fixture
        .target_profile
        .join("migrations/source-transfer/incoming")
        .join(format!("{}.admission", fixture.request));
    let directory = PrivateDirectory::open_existing(&path).unwrap();
    let observer = super::super::storage::try_operation_lease(&directory, "writer.lock")
        .unwrap()
        .unwrap();
    std::fs::rename(path.join("writer.lock"), path.join("original-writer.lock")).unwrap();
    std::fs::write(
        path.join("writer.lock"),
        b"replacement is not original authority",
    )
    .unwrap();
    let result = super::super::storage::operation_lease(&directory, "writer.lock");
    assert!(result.is_err());
    assert_eq!(
        std::fs::read(path.join("writer.lock")).unwrap(),
        b"replacement is not original authority"
    );
    drop(observer);
}

#[test]
fn waiting_never_refreshes_authority_from_a_replaced_anchor_and_lock() {
    let fixture = Fixture::new();
    let path = fixture
        .target_profile
        .join("migrations/source-transfer/incoming")
        .join(format!("{}.admission", fixture.request));
    let directory = PrivateDirectory::open_existing(&path).unwrap();
    let observer = super::super::storage::try_operation_lease(&directory, "writer.lock")
        .unwrap()
        .unwrap();
    let mut replaced = false;
    let mut changed_anchor = Vec::new();
    let result =
        super::super::storage::operation_lease_with_wait(&directory, "writer.lock", |_| {
            assert!(!replaced);
            std::fs::rename(path.join("writer.lock"), path.join("original-writer.lock")).unwrap();
            let replacement = directory
                .try_exclusive_lock(OsStr::new("writer.lock"))
                .unwrap()
                .unwrap();
            let mut anchor: super::super::storage::Anchor =
                serde_json::from_slice(&std::fs::read(path.join("binding.json")).unwrap()).unwrap();
            anchor.writer = directory
                .portable_regular_identity(OsStr::new("writer.lock"))
                .unwrap();
            changed_anchor = serde_json::to_vec(&anchor).unwrap();
            drop(replacement);
            std::fs::write(path.join("binding.json"), &changed_anchor).unwrap();
            replaced = true;
        });
    assert!(replaced);
    assert_eq!(
        result.err().unwrap().to_string(),
        "source_transfer_owner_changed"
    );
    assert_eq!(
        std::fs::read(path.join("binding.json")).unwrap(),
        changed_anchor
    );
    assert!(std::fs::read(path.join("writer.lock")).unwrap().is_empty());
    drop(observer);
}
