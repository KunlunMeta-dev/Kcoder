//! Original prepared/final publication receipts are reusable without any source handle.
use super::super::{checkpoint, files, intent};

use files::CreationFiles;
use intent::BatchCreateIntent;
use kcoder_config::PrivateDirectory;
use std::{ffi::OsStr, fs, path::PathBuf};
const REQUEST: &str = "252abcf1-154c-4366-949e-fb81ed21f5f0";
struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    parent: PrivateDirectory,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let parent = PrivateDirectory::open_or_create(&profile.join("migrations")).unwrap();
        Self {
            _root: root,
            profile,
            parent,
        }
    }
    fn create(&self) -> (CreationFiles, kcoder_config::VerifiedPrivateLease) {
        let intent =
            BatchCreateIntent::new(REQUEST, &serde_json::json!({"sourceIds":["now-expired"]}))
                .unwrap();
        CreationFiles::create(&self.parent, &self.profile, &intent).unwrap()
    }
    fn reopen(&self) -> CreationFiles {
        CreationFiles::lookup(&self.parent, &self.profile, REQUEST)
            .unwrap()
            .unwrap()
    }
}

#[test]
fn captured_bytes_reopen_and_finish_without_live_sources_and_recover_the_original_receipt() {
    let f = Fixture::new();
    let (files, worker) = f.create();
    let captured =
        serde_json::json!({"jobId":files.birth.job_id,"captured":["owned original source bytes"]});
    files.prepare(&captured, || true).unwrap();
    files.prepare(&captured, || true).unwrap();
    assert!(!files.publication_started().unwrap());
    drop(worker);
    drop(files);
    let reopened = f.reopen();
    assert_eq!(
        reopened.prepared::<serde_json::Value>().unwrap(),
        Some(captured.clone())
    );
    let _worker = reopened.claim().unwrap();
    reopened.publish(&f.parent).unwrap();
    assert!(reopened.publication_started().unwrap());
    drop(reopened);
    let reopened = f.reopen();
    reopened.verify_first_publication(&f.parent).unwrap();
    assert_eq!(
        reopened.prepared::<serde_json::Value>().unwrap(),
        Some(captured)
    );
    assert!(
        reopened.publish(&f.parent).is_err(),
        "a lost receipt is reconciled, never republished"
    );
}

#[test]
fn changed_prepared_intent_and_same_bytes_replacement_are_rejected_without_repair() {
    let f = Fixture::new();
    let (files, _worker) = f.create();
    files
        .prepare(&serde_json::json!({"original":true}), || true)
        .unwrap();
    assert!(
        files
            .prepare(&serde_json::json!({"original":false}), || true)
            .is_err()
    );
    let name = OsStr::new("create.prepared.json");
    let path = f
        .profile
        .join("migrations")
        .join(format!("{}.plans", files.birth.job_id))
        .join(name);
    let original = fs::read(&path).unwrap();
    fs::rename(&path, path.with_extension("retained")).unwrap();
    files.directory.atomic_replace(name, &original).unwrap();
    assert!(files.prepared::<serde_json::Value>().is_err());
    assert!(
        files
            .prepare(&serde_json::json!({"original":true}), || true)
            .is_err()
    );
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn missing_prepared_or_final_publication_is_unknown_and_cannot_reset_the_journal() {
    for final_journal in [false, true] {
        let f = Fixture::new();
        let (files, _worker) = f.create();
        files
            .prepare(&serde_json::json!({"ready":true}), || true)
            .unwrap();
        if final_journal {
            files.publish(&f.parent).unwrap();
            f.parent
                .remove_regular_file(OsStr::new(&format!("{}.json", files.birth.job_id)))
                .unwrap();
            assert!(files.publication_started().unwrap());
            assert!(files.verify_first_publication(&f.parent).is_err());
            assert!(files.publish(&f.parent).is_err());
        } else {
            files
                .directory
                .remove_regular_file(OsStr::new("create.prepared.json"))
                .unwrap();
            assert!(files.prepared::<serde_json::Value>().is_err());
            assert!(
                files
                    .prepare(&serde_json::json!({"ready":true}), || true)
                    .is_err()
            );
        }
    }
}

#[test]
fn foreign_seal_and_unsealed_payload_are_never_adopted_by_their_names() {
    for foreign in [false, true] {
        let f = Fixture::new();
        let (files, _worker) = f.create();
        if foreign {
            let other = Fixture::new();
            let (original, _owner) = other.create();
            original
                .prepare(&serde_json::json!({"ready":true}), || true)
                .unwrap();
            let source = other
                .profile
                .join("migrations")
                .join(format!("{}.plans", original.birth.job_id));
            for name in ["create.prepared.json", "create.prepared.seal.json"] {
                files
                    .directory
                    .atomic_replace(OsStr::new(name), &fs::read(source.join(name)).unwrap())
                    .unwrap();
            }
        } else {
            files
                .directory
                .atomic_replace(OsStr::new("create.prepared.json"), b"{\"ready\":true}")
                .unwrap();
        }
        assert!(files.prepared::<serde_json::Value>().is_err());
        assert!(
            files
                .prepare(&serde_json::json!({"ready":true}), || true)
                .is_err()
        );
    }
}

#[test]
fn cancellation_and_oversize_encoding_never_publish_a_prepared_receipt() {
    let f = Fixture::new();
    let (files, _worker) = f.create();
    assert!(
        files
            .prepare(&serde_json::json!({"small":true}), || false)
            .is_err()
    );
    let mut checks = 0;
    let large = "x".repeat(checkpoint::MAX_JOB_BYTES + 1);
    assert!(
        files
            .prepare(&large, || {
                checks += 1;
                true
            })
            .is_err()
    );
    assert!(
        checks < 300,
        "polls are bounded by byte intervals, not per JSON character"
    );
    assert!(files.prepared::<serde_json::Value>().unwrap().is_none());
    let mut checks = 0;
    let medium = "x".repeat(512 * 1024);
    assert!(
        files
            .prepare(&medium, || {
                checks += 1;
                checks < 4
            })
            .is_err()
    );
    assert!(files.prepared::<serde_json::Value>().unwrap().is_none());
    files
        .prepare(&serde_json::json!({"resumed":true}), || true)
        .unwrap();
}
