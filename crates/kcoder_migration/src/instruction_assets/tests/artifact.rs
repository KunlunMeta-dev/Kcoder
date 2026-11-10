//! The next asset slice seals source bytes in the original job's private namespace.
use crate::instruction_sources;
use kcoder_config::{FolderTrustStore, PrivateDirectory};
use kcoder_types::migration::MigrationSourceKind;
use std::{ffi::OsStr, fs, path::PathBuf};

use super::super::artifact;
use artifact::InstructionArtifactReference;

const JOB: &str = "mig-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    source: PathBuf,
    plans: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let source = root.path().join("source");
        let plans = profile.join("migrations").join(format!("{JOB}.plans"));
        PrivateDirectory::open_or_create(&plans).unwrap();
        fs::create_dir_all(source.join(".git")).unwrap();
        fs::write(source.join("AGENTS.md"), "ordinary ancestor guide").unwrap();
        FolderTrustStore::load(&profile).trust(&source).unwrap();
        Self {
            _root: root,
            profile,
            source,
            plans,
        }
    }
    fn capture(&self) -> instruction_sources::InstructionSourceSnapshot {
        instruction_sources::InstructionSourceGrant::capture(
            &self.profile,
            &self.source,
            &self.source,
            MigrationSourceKind::Codex,
        )
        .unwrap()
        .capture_sources(
            &instruction_sources::InstructionSourcePolicy {
                codex_max_bytes: 4 * 1024 * 1024,
                ..Default::default()
            },
            |_| true,
        )
        .unwrap()
    }
    fn directory(&self) -> PrivateDirectory {
        PrivateDirectory::open_existing(&self.plans).unwrap()
    }
}

#[test]
fn same_job_artifact_reopens_offline_and_reconciles_the_exact_snapshot() {
    let f = Fixture::new();
    let snapshot = f.capture();
    let directory = f.directory();
    let reference =
        InstructionArtifactReference::publish(&directory, &f.profile, JOB, &snapshot, || true)
            .unwrap();
    assert_eq!(
        serde_json::to_value(&reference).unwrap()["sha256"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    assert_eq!(
        InstructionArtifactReference::publish(&directory, &f.profile, JOB, &snapshot, || true)
            .unwrap(),
        reference
    );
    fs::rename(&f.source, f.source.with_extension("removed")).unwrap();
    drop(directory);
    let reference: InstructionArtifactReference =
        serde_json::from_slice(&serde_json::to_vec(&reference).unwrap()).unwrap();
    let reopened = reference.read(&f.directory(), &f.profile, JOB).unwrap();
    assert!(reopened.verify_source(|_| true).is_err());
    assert_eq!(
        reopened
            .original_bytes(&reopened.summaries()[0].id)
            .unwrap()
            .as_slice(),
        b"ordinary ancestor guide"
    );
    assert_eq!(fs::read_dir(&f.plans).unwrap().count(), 1);
}

#[test]
fn artifact_read_rejects_another_profile_job_parent_and_same_bytes_replacement() {
    let f = Fixture::new();
    let snapshot = f.capture();
    let directory = f.directory();
    let reference =
        InstructionArtifactReference::publish(&directory, &f.profile, JOB, &snapshot, || true)
            .unwrap();
    let other_profile = f._root.path().join("other-profile");
    let other_directory = PrivateDirectory::open_or_create(&other_profile).unwrap();
    assert!(reference.read(&directory, &other_profile, JOB).is_err());
    assert!(
        reference
            .read(
                &directory,
                &f.profile,
                "mig-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            )
            .is_err()
    );
    assert!(reference.read(&other_directory, &f.profile, JOB).is_err());
    let name = fs::read_dir(&f.plans)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .file_name();
    let bytes = fs::read(f.plans.join(&name)).unwrap();
    fs::rename(f.plans.join(&name), f.plans.join("original-artifact")).unwrap();
    directory.atomic_replace(&name, &bytes).unwrap();
    assert!(reference.read(&directory, &f.profile, JOB).is_err());
    assert_eq!(fs::read(f.plans.join(&name)).unwrap(), bytes);
}

#[test]
fn missing_or_corrupt_committed_artifact_is_not_repaired_by_observation() {
    let f = Fixture::new();
    let snapshot = f.capture();
    let directory = f.directory();
    let reference =
        InstructionArtifactReference::publish(&directory, &f.profile, JOB, &snapshot, || true)
            .unwrap();
    let name = fs::read_dir(&f.plans)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .file_name();
    directory
        .atomic_replace(&name, b"corrupt source recipe")
        .unwrap();
    assert!(reference.read(&directory, &f.profile, JOB).is_err());
    assert!(
        InstructionArtifactReference::publish(&directory, &f.profile, JOB, &snapshot, || true)
            .is_err()
    );
    assert_eq!(
        fs::read(f.plans.join(&name)).unwrap(),
        b"corrupt source recipe"
    );
    directory.remove_regular_file(&name).unwrap();
    assert!(reference.read(&directory, &f.profile, JOB).is_err());
    assert_eq!(fs::read_dir(&f.plans).unwrap().count(), 0);
}

#[test]
fn cancellation_before_or_during_encoding_does_not_publish_a_recipe() {
    let f = Fixture::new();
    fs::write(f.source.join("AGENTS.md"), "x".repeat(1024 * 1024)).unwrap();
    let snapshot = f.capture();
    let directory = f.directory();
    assert!(
        InstructionArtifactReference::publish(&directory, &f.profile, JOB, &snapshot, || false)
            .is_err()
    );
    let mut checks = 0;
    let result =
        InstructionArtifactReference::publish(&directory, &f.profile, JOB, &snapshot, || {
            checks += 1;
            checks < 4
        });
    assert!(result.is_err());
    assert!(checks >= 4);
    assert_eq!(fs::read_dir(&f.plans).unwrap().count(), 0);
    assert!(
        directory
            .open_single_link_regular_file(OsStr::new("unexpected"))
            .is_err()
    );
}

#[test]
fn cancellation_during_temporary_copy_removes_only_the_owned_unpublished_file() {
    let f = Fixture::new();
    let snapshot = f.capture();
    let directory = f.directory();
    let mut copying = false;
    let result =
        InstructionArtifactReference::publish(&directory, &f.profile, JOB, &snapshot, || {
            if fs::read_dir(&f.plans).unwrap().next().is_some() {
                copying = true;
                false
            } else {
                true
            }
        });
    assert!(
        copying,
        "the actual temporary file was opened before cancellation"
    );
    assert!(result.is_err());
    assert_eq!(fs::read_dir(&f.plans).unwrap().count(), 0);
}
