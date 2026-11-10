//! Pending bundle producer uses real scoped grants and private artifacts, without a target publication.
use super::super::binding;
use crate::instruction_sources;
use binding::{FrozenInstructionBinding, InstructionBinding, LiveInstructionBinding};
use instruction_sources::*;
use kcoder_config::PrivateDirectory;
use kcoder_types::migration::MigrationSourceKind;
use std::{collections::BTreeMap, fs, path::PathBuf, sync::Arc};
const JOB: &str = "mig-31313131313131313131313131313131";
struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    source: PathBuf,
    target: PathBuf,
    directory: PrivateDirectory,
    snapshot: Arc<InstructionSourceSnapshot>,
    mapping: BTreeMap<String, ScopedInstructionDestination>,
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    PrivateDirectory::open_or_create(&profile).unwrap();
    let source = root.path().join("source");
    let target = root.path().join("target");
    fs::create_dir_all(source.join(".git")).unwrap();
    fs::create_dir_all(target.join("src")).unwrap();
    fs::write(
        source.join("AGENTS.md"),
        "BODY_ONLY_IN_THE_IMMUTABLE_SOURCE_RECIPE\n",
    )
    .unwrap();
    fs::write(
        profile.join("trusted-folders.json"),
        serde_json::to_vec(&serde_json::json!({"trusted":[source,target],"never":[]})).unwrap(),
    )
    .unwrap();
    let snapshot = Arc::new(
        InstructionSourceGrant::capture(&profile, &source, &source, MigrationSourceKind::Codex)
            .unwrap()
            .capture_sources(&InstructionSourcePolicy::default(), |_| true)
            .unwrap(),
    );
    let destination = InstructionDestination::capture(&profile, &target).unwrap();
    let mapping = BTreeMap::from([(
        snapshot.summaries()[0].id.clone(),
        ScopedInstructionDestination::capture(&destination, "src").unwrap(),
    )]);
    let directory =
        PrivateDirectory::open_or_create(&profile.join("migrations").join(format!("{JOB}.plans")))
            .unwrap();
    Fixture {
        _root: root,
        profile,
        source,
        target,
        directory,
        snapshot,
        mapping,
    }
}
#[test]
fn live_grant_cannot_serialize_and_owned_capture_reopens_without_the_source_body_in_the_journal() {
    let f = fixture();
    let granted = LiveInstructionBinding::capture(
        f.snapshot.clone(),
        f.mapping.clone(),
        &f.profile,
        false,
        |_| true,
    )
    .unwrap();
    let live = InstructionBinding::Granted(Arc::new(granted.clone()));
    assert!(serde_json::to_vec(&live).is_err());
    let frozen = granted
        .freeze(&f.directory, &f.profile, JOB, |_| true)
        .unwrap();
    let wire = serde_json::to_vec(&frozen).unwrap();
    let value = String::from_utf8(wire.clone()).unwrap();
    assert!(!value.contains("BODY_ONLY_IN_THE_IMMUTABLE_SOURCE_RECIPE"));
    assert!(!value.contains(f.source.to_str().unwrap()));
    assert_eq!(
        serde_json::to_value(&frozen).unwrap()["artifact"]["sha256"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    let tagged = InstructionBinding::Captured(Box::new(frozen));
    serde_json::from_slice::<InstructionBinding>(&serde_json::to_vec(&tagged).unwrap()).unwrap();
    fs::rename(&f.source, f.source.with_extension("withheld")).unwrap();
    let restored: FrozenInstructionBinding = serde_json::from_slice(&wire).unwrap();
    let snapshot = restored.snapshot(&f.directory, &f.profile, JOB).unwrap();
    assert!(snapshot.verify_source(|_| true).is_err());
    let summary = restored.summaries().unwrap().remove(0);
    assert_eq!(
        snapshot.original_bytes(&summary.id).unwrap().as_slice(),
        b"BODY_ONLY_IN_THE_IMMUTABLE_SOURCE_RECIPE\n"
    );
    restored
        .target(&summary.id)
        .unwrap()
        .verify(&f.profile)
        .unwrap();
}
#[test]
fn capture_does_not_refresh_source_or_mapping_and_cancellation_creates_no_recipe() {
    let f = fixture();
    assert!(
        LiveInstructionBinding::capture(
            f.snapshot.clone(),
            f.mapping.clone(),
            &f.profile,
            false,
            |_| false
        )
        .is_err()
    );
    let granted = LiveInstructionBinding::capture(
        f.snapshot.clone(),
        f.mapping.clone(),
        &f.profile,
        false,
        |_| true,
    )
    .unwrap();
    assert!(
        granted
            .freeze(&f.directory, &f.profile, JOB, |_| false)
            .is_err()
    );
    assert_eq!(
        fs::read_dir(f.profile.join("migrations").join(format!("{JOB}.plans")))
            .unwrap()
            .count(),
        0
    );
    fs::rename(f.target.join("src"), f.target.join("retained-src")).unwrap();
    fs::create_dir(f.target.join("src")).unwrap();
    assert!(
        granted
            .freeze(&f.directory, &f.profile, JOB, |_| true)
            .is_err()
    );
    assert!(
        LiveInstructionBinding::capture(f.snapshot.clone(), f.mapping, &f.profile, false, |_| true)
            .is_err()
    );
}
