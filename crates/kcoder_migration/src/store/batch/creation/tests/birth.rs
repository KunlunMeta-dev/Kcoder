//! Real Native directory and fixed-handle birth proofs, with no source resolution.
use super::super::{files, intent, model};

use files::CreationFiles;
use intent::BatchCreateIntent;
use kcoder_config::PrivateDirectory;
use std::{ffi::OsStr, fs, path::PathBuf};
const REQUEST: &str = "232abcf1-154c-4366-949e-fb81ed21f5f0";
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
    fn intent(&self) -> BatchCreateIntent {
        BatchCreateIntent::new(
            REQUEST,
            &serde_json::json!({"sourceIds":["opaque-expired"]}),
        )
        .unwrap()
    }
}
#[test]
fn birth_reopens_with_original_physical_lease_and_rejects_changed_public_intent() {
    let f = Fixture::new();
    let intent = f.intent();
    assert!(
        CreationFiles::lookup(&f.parent, &f.profile, REQUEST)
            .unwrap()
            .is_none()
    );
    let (original, owner) = CreationFiles::create(&f.parent, &f.profile, &intent).unwrap();
    assert!(original.running().unwrap());
    assert!(original.claim().is_err());
    drop(owner);
    let reopened = CreationFiles::lookup(&f.parent, &f.profile, REQUEST)
        .unwrap()
        .unwrap();
    assert!(!reopened.running().unwrap());
    reopened.require_intent(&intent).unwrap();
    reopened.binding().validate_shape().unwrap();
    assert_eq!(reopened.birth_sha256, original.birth_sha256);
    let changed =
        BatchCreateIntent::new(REQUEST, &serde_json::json!({"sourceIds":["replacement"]})).unwrap();
    assert!(reopened.require_intent(&changed).is_err());
    let _owner = reopened.claim().unwrap();
    assert!(reopened.running().unwrap());
}

#[test]
fn prebirth_or_missing_coordination_is_unknown_without_creating_replacement_facts() {
    for existing_birth in [false, true] {
        let f = Fixture::new();
        let job_id = files::job_id(REQUEST);
        let _directory = if existing_birth {
            let (files, lease) = CreationFiles::create(&f.parent, &f.profile, &f.intent()).unwrap();
            drop(lease);
            files
                .directory
                .remove_regular_file(OsStr::new("create.lock"))
                .unwrap();
            files.directory
        } else {
            f.parent
                .create_private_child(OsStr::new(&format!("{job_id}.plans")))
                .unwrap()
        };
        let path = f.profile.join("migrations").join(format!("{job_id}.plans"));
        let entries = || {
            let mut names = fs::read_dir(&path)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .take(17)
                .collect::<Vec<_>>();
            assert!(names.len() <= 16);
            names.sort();
            names
        };
        let before = entries();
        assert!(
            CreationFiles::lookup(&f.parent, &f.profile, REQUEST).is_err(),
            "an incomplete original birth is not permission to recreate it"
        );
        assert!(CreationFiles::create(&f.parent, &f.profile, &f.intent()).is_err());
        assert_eq!(entries(), before);
    }
}

#[test]
fn same_spelling_parent_or_lease_replacement_does_not_inherit_the_creation() {
    for replace_parent in [false, true] {
        let f = Fixture::new();
        let (original, lease) = CreationFiles::create(&f.parent, &f.profile, &f.intent()).unwrap();
        drop(lease);
        if replace_parent {
            let path = f
                .profile
                .join("migrations")
                .join(format!("{}.plans", original.birth.job_id));
            let old = path.with_extension("old");
            fs::rename(&path, &old).unwrap();
            PrivateDirectory::open_or_create(&path).unwrap();
            for entry in fs::read_dir(old).unwrap() {
                let entry = entry.unwrap();
                fs::rename(entry.path(), path.join(entry.file_name())).unwrap();
            }
        } else {
            original
                .directory
                .remove_regular_file(OsStr::new("create.lock"))
                .unwrap();
            original
                .directory
                .open_read_write_file(OsStr::new("create.lock"), true)
                .unwrap();
        }
        assert!(
            CreationFiles::lookup(&f.parent, &f.profile, REQUEST).is_err(),
            "replacement parent={replace_parent} cannot inherit the original birth"
        );
    }
}

#[test]
fn control_mutations_use_the_separate_original_lease_and_validate_receipt_order() {
    let f = Fixture::new();
    let (files, _worker) = CreationFiles::create(&f.parent, &f.profile, &f.intent()).unwrap();
    let _controller = files.control_lease().unwrap();
    assert!(files.control_lease().is_err());
    let mut control = files.control().unwrap();
    control.receipts.push(model::ControlReceipt {
        request_id: uuid::Uuid::new_v4().to_string(),
        action: model::ControlAction::Cancel,
        expected_revision: 1,
        revision: 2,
    });
    control.revision = 2;
    control.cancel_requested = true;
    files.save_control(&control, &_controller).unwrap();
    assert!(files.control().unwrap().cancel_requested);
    control.receipts[0].revision = 3;
    assert!(files.save_control(&control, &_controller).is_err());
    assert_eq!(files.control().unwrap().revision, 2);
}
