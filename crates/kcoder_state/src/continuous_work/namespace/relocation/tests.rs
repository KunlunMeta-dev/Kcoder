use super::*;
use crate::continuous_work::{
    ClaimOutcome, ClaimTrigger, ContinuousWorkStore, HostWorkScope, InitialAdmission,
    WorkInputSource,
};
use kcoder_types::continuous_work::{WorkRecord, WorkScope};
use serde_json::{Value, json};

struct Fixture {
    root: tempfile::TempDir,
    profile: PathBuf,
    workspace: PathBuf,
    store: ContinuousWorkStore,
    scope: WorkScope,
    source: WorkInputSource,
    work: WorkRecord,
}

impl Fixture {
    fn new(version: u32) -> Result<Self> {
        let root = tempfile::tempdir()?;
        let profile = root.path().join("source");
        let workspace = root.path().join("external-workspace");
        let parent = PrivateDirectory::open_or_create(&profile)?;
        PrivateDirectory::open_or_create(&workspace)?;
        let directory = parent.create_private_child(OsStr::new(DIRECTORY))?;
        let profile_lock =
            (version == 2).then(|| format!(".continuous-work-{}.locks", uuid::Uuid::new_v4()));
        let external = profile_lock
            .as_ref()
            .map(|name| parent.create_private_child(OsStr::new(name)))
            .transpose()?;
        let lock_directory = external.as_ref().unwrap_or(&directory);
        let lock = lock_directory.open_read_write_file(OsStr::new(LOCK), true)?;
        let header = Header {
            version,
            profile: parent.directory_identity()?,
            directory: directory.directory_identity()?,
            lock: lock_directory.portable_regular_handle_identity(&lock)?,
            profile_lock,
            profile_lock_identity: external
                .as_ref()
                .map(PrivateDirectory::directory_identity)
                .transpose()?,
            relocation: None,
        };
        directory.atomic_replace(OsStr::new(HEADER), &serde_json::to_vec(&header)?)?;
        directory.atomic_replace(
            OsStr::new(DATA),
            br#"{"version":1,"works":{},"inputs":{},"inputIds":{},"operations":{}}"#,
        )?;
        let store = ContinuousWorkStore::open_existing(&profile)?.unwrap();
        let scope = HostWorkScope::capture(&profile, &workspace, None)?
            .scope()
            .clone();
        let source = WorkInputSource {
            kind: "foreground".into(),
            instance_id: "original-host".into(),
            conversation_id: "thread".into(),
        };
        let work: WorkRecord = serde_json::from_value(json!({
            "schemaVersion":1,"identity":{"scope":scope,"workId":"original-work"},
            "origin":{"kind":"foreground","initialAttempt":{"threadId":"thread","turnId":"turn","attemptId":"attempt"}},
            "linkedThreadIds":["thread"],"phase":"pending","revision":{"revision":1,"requirementsRevision":1,
            "controlEpoch":0,"ownerEpoch":0,"acceptedInputSequence":1,"requiredInputSequence":1,"appliedInputSequence":0}
        }))?;
        Ok(Self {
            root,
            profile,
            workspace,
            store,
            scope,
            source,
            work,
        })
    }
    fn admit(&self) -> Result<()> {
        assert!(matches!(
            self.store.admit(
                &self.scope,
                self.work.clone(),
                &self.source,
                "original-input",
                json!({"text":"ORIGINAL_INPUT"}),
                vec![]
            )?,
            InitialAdmission::Accepted(_)
        ));
        Ok(())
    }
    fn copy(&self, source: &Path, name: &str, op: &str) -> Result<PathBuf> {
        let path = self.root.path().join(name);
        let target = PrivateDirectory::open_or_create(&path)?;
        copy_directory(source, &target)?;
        let source = PrivateDirectory::open_existing(source)?;
        ProfileIdentity::observe(&source)?.relocate(&source, &target, op)?;
        Ok(path)
    }
}

fn legacy_fixture() -> Result<Fixture> {
    let mut f = Fixture::new(1)?;
    f.admit()?;
    let mut source = f.store.relocation_snapshot()?;
    source.profile_identity = "historical-profile".into();
    source.directory_identity = "historical-namespace".into();
    let namespace = Namespace::open_existing(&f.profile)?.unwrap();
    let directory = &namespace.directory;
    let bindings = Bindings {
        version: 1,
        source_data_sha256: source.data_sha256.clone(),
        target_directory: namespace.header.directory.clone(),
        payloads: BTreeMap::new(),
    };
    let bytes = serde_json::to_vec(&bindings)?;
    directory.atomic_replace(OsStr::new(BINDINGS), &bytes)?;
    let mut header = namespace.header.clone();
    header.version = 3;
    header.relocation = Some(RelocationReceipt {
        operation_id: "legacy-move".into(),
        source,
        bindings: BindingsReference {
            identity: directory.portable_regular_identity(OsStr::new(BINDINGS))?,
            sha256: digest(&bytes),
            size: bytes.len() as u64,
        },
        stage: Stage::Ready,
    });
    directory.atomic_replace(OsStr::new(HEADER), &serde_json::to_vec(&header)?)?;
    f.store = ContinuousWorkStore::open_existing(&f.profile)?.unwrap();
    Ok(f)
}

fn copy_directory(source: &Path, target: &PrivateDirectory) -> Result<()> {
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            let child = target.create_private_child(&entry.file_name())?;
            copy_directory(&entry.path(), &child)?;
        } else {
            ensure!(kind.is_file(), "unexpected_synthetic_fixture_entry");
            target.atomic_replace(&entry.file_name(), &std::fs::read(entry.path())?)?;
        }
    }
    Ok(())
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn binding_convergence_committed_inputs_move_without_a_fileid_map() -> Result<()> {
    let f = Fixture::new(1)?;
    f.admit()?;
    let expected = f.store.relocation_snapshot()?;
    let path = f.copy(&f.profile, "target", "move")?;
    let moved = f.store.relocate(&path, "move", &expected)?;
    assert!(!path.join(DIRECTORY).join(BINDINGS).exists());
    assert!(
        moved
            .read_input(&f.scope, "original-work", &f.source, "original-input")?
            .is_some()
    );
    Ok(())
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn both_lock_layouts_keep_exact_claims_receipts_and_modern_input_reading_across_relocations()
-> Result<()> {
    for version in [1, 2] {
        let f = Fixture::new(version)?;
        f.admit()?;
        let claim = f.store.claim(
            &f.scope,
            "original-work",
            1,
            0,
            "original-claim",
            "thread",
            ClaimTrigger::Input,
        )?;
        let expected = f.store.relocation_snapshot()?;
        let data = std::fs::read(f.profile.join(DIRECTORY).join(DATA))?;
        let input = f
            .store
            .read_input(&f.scope, "original-work", &f.source, "original-input")?;
        let path = f.copy(&f.profile, "target", "original-move")?;
        assert!(ContinuousWorkStore::open_existing(&path).is_err());
        drop(f.store.relocate(&path, "original-move", &expected)?);
        let before_header = std::fs::read(path.join(DIRECTORY).join(HEADER))?;
        assert!(!path.join(DIRECTORY).join(BINDINGS).exists());
        let target = f.store.relocate(&path, "original-move", &expected)?;
        f.store
            .verify_relocation(&path, "original-move", &expected)?;
        assert_eq!(std::fs::read(path.join(DIRECTORY).join(DATA))?, data);
        assert_eq!(std::fs::read(f.profile.join(DIRECTORY).join(DATA))?, data);
        assert_eq!(
            std::fs::read(path.join(DIRECTORY).join(HEADER))?,
            before_header
        );
        assert!(!path.join(DIRECTORY).join(BINDINGS).exists());
        assert_eq!(
            target.read_input(&f.scope, "original-work", &f.source, "original-input")?,
            input
        );
        assert!(
            matches!((claim, target.claim(&f.scope, "original-work", 1, 0, "original-claim", "thread", ClaimTrigger::Input)?),
            (ClaimOutcome::Acquired(before), ClaimOutcome::ExistingActive(after)) if before == after)
        );
        assert_eq!(
            HostWorkScope::capture(&path, &f.workspace, None)?.scope(),
            &f.scope
        );
        f.store
            .verify_relocation(&path, "another-operation", &expected)?;
        let expected = target.relocation_snapshot()?;
        let second_path = f.copy(&path, "second-target", "second-move")?;
        let second = target.relocate(&second_path, "second-move", &expected)?;
        assert_eq!(std::fs::read(second_path.join(DIRECTORY).join(DATA))?, data);
        assert_eq!(
            second.read_input(&f.scope, "original-work", &f.source, "original-input")?,
            input
        );
    }
    Ok(())
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn legacy_preparing_sidecar_remains_unconfirmed_without_rewriting_history() -> Result<()> {
    let f = legacy_fixture()?;
    let namespace = Namespace::open_existing(&f.profile)?.unwrap();
    let directory = &namespace.directory;
    let before = read_file(directory, DATA, DATA_LIMIT)?;
    let mut header = namespace.header.clone();
    header.relocation.as_mut().unwrap().stage = Stage::Preparing;
    directory.atomic_replace(OsStr::new(HEADER), &serde_json::to_vec(&header)?)?;
    assert!(ContinuousWorkStore::open_existing(&f.profile).is_err());
    assert_eq!(read_file(directory, DATA, DATA_LIMIT)?, before);
    Ok(())
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn source_revision_and_changed_target_payload_block_without_rewriting_headers() -> Result<()> {
    let f = Fixture::new(1)?;
    f.admit()?;
    let expected = f.store.relocation_snapshot()?;
    let path = f.copy(&f.profile, "target", "move")?;
    let before = std::fs::read(path.join(DIRECTORY).join(HEADER))?;
    f.store.claim(
        &f.scope,
        "original-work",
        1,
        0,
        "new-owner",
        "thread",
        ClaimTrigger::Input,
    )?;
    assert!(f.store.relocate(&path, "move", &expected).is_err());
    assert_eq!(std::fs::read(path.join(DIRECTORY).join(HEADER))?, before);

    let f = Fixture::new(1)?;
    f.admit()?;
    let expected = f.store.relocation_snapshot()?;
    let path = f.copy(&f.profile, "target", "move")?;
    let directory =
        PrivateDirectory::open_existing(&path)?.open_child(OsStr::new(DIRECTORY), false)?;
    let before = read_file(&directory, HEADER, HEADER_LIMIT)?;
    let receipt = f
        .store
        .read_input(&f.scope, "original-work", &f.source, "original-input")?
        .unwrap()
        .0;
    directory.atomic_replace(
        OsStr::new(&receipt.payload_ref),
        br#"{"text":"CHANGED_PAYLOAD"}"#,
    )?;
    assert!(f.store.relocate(&path, "move", &expected).is_err());
    assert_eq!(read_file(&directory, HEADER, HEADER_LIMIT)?, before);
    Ok(())
}

#[test]
fn real_owner_lease_and_unowned_sidecar_refuse_header_conversion() -> Result<()> {
    let f = Fixture::new(2)?;
    let expected = f.store.relocation_snapshot()?;
    let path = f.copy(&f.profile, "target", "move")?;
    let namespace = Namespace::open_existing(&f.profile)?.unwrap();
    let lease = namespace.lease(false)?;
    assert!(f.store.relocate(&path, "move", &expected).is_err());
    drop(lease);
    let directory =
        PrivateDirectory::open_existing(&path)?.open_child(OsStr::new(DIRECTORY), false)?;
    let before = read_file(&directory, HEADER, HEADER_LIMIT)?;
    directory.atomic_replace(OsStr::new(BINDINGS), b"UNKNOWN_OWNER")?;
    assert!(f.store.relocate(&path, "move", &expected).is_err());
    assert_eq!(read_file(&directory, HEADER, HEADER_LIMIT)?, before);
    assert_eq!(
        read_file(&directory, BINDINGS, BINDINGS_LIMIT)?,
        b"UNKNOWN_OWNER"
    );
    Ok(())
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn legacy_mapping_held_replacement_is_rejected_and_cold_read_verifies_exact_bytes() -> Result<()> {
    let f = legacy_fixture()?;
    let expected = f.store.relocation_snapshot()?;
    let path = f.copy(&f.profile, "target", "move")?;
    let target = f.store.relocate(&path, "move", &expected)?;
    let directory =
        PrivateDirectory::open_existing(&path)?.open_child(OsStr::new(DIRECTORY), false)?;
    let data = read_file(&directory, DATA, DATA_LIMIT)?;
    let bindings = read_file(&directory, BINDINGS, BINDINGS_LIMIT)?;
    directory.atomic_replace(OsStr::new(BINDINGS), &bindings)?;
    assert!(
        target
            .read_input(&f.scope, "original-work", &f.source, "original-input")
            .is_err()
    );
    assert!(ContinuousWorkStore::open_existing(&path)?.is_some());
    assert_eq!(read_file(&directory, DATA, DATA_LIMIT)?, data);
    Ok(())
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn warm_reads_do_not_reread_or_write_the_mapping_and_in_place_corruption_fails_closed() -> Result<()>
{
    use std::io::Write;
    let f = legacy_fixture()?;
    let expected = f.store.relocation_snapshot()?;
    let path = f.copy(&f.profile, "target", "move")?;
    drop(f.store.relocate(&path, "move", &expected)?);
    BINDING_READS.with(|count| count.set(0));
    let target = ContinuousWorkStore::open_existing(&path)?.unwrap();
    assert_eq!(BINDING_READS.with(|count| count.get()), 1);
    let directory =
        PrivateDirectory::open_existing(&path)?.open_child(OsStr::new(DIRECTORY), false)?;
    let state = read_file(&directory, DATA, DATA_LIMIT)?;
    let bindings = read_file(&directory, BINDINGS, BINDINGS_LIMIT)?;
    let state_identity = directory.portable_regular_identity(OsStr::new(DATA))?;
    let binding_identity = directory.portable_regular_identity(OsStr::new(BINDINGS))?;
    for _ in 0..5 {
        assert!(
            target
                .read_input(&f.scope, "original-work", &f.source, "original-input")?
                .is_some()
        );
    }
    assert_eq!(BINDING_READS.with(|count| count.get()), 1);
    assert_eq!(read_file(&directory, DATA, DATA_LIMIT)?, state);
    assert_eq!(read_file(&directory, BINDINGS, BINDINGS_LIMIT)?, bindings);
    assert!(directory.portable_regular_identity(OsStr::new(DATA))? == state_identity);
    assert!(directory.portable_regular_identity(OsStr::new(BINDINGS))? == binding_identity);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .open(path.join(DIRECTORY).join(BINDINGS))?;
    file.write_all(b"CORRUPTED_IN_PLACE")?;
    file.sync_all()?;
    assert!(directory.portable_regular_identity(OsStr::new(BINDINGS))? == binding_identity);
    assert!(
        target
            .read_input(&f.scope, "original-work", &f.source, "original-input")
            .is_err()
    );
    assert!(ContinuousWorkStore::open_existing(&path).is_err());
    assert_eq!(read_file(&directory, DATA, DATA_LIMIT)?, state);
    Ok(())
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn pending_publication_remains_an_explicit_blocker_with_its_original_receipts_and_state()
-> Result<()> {
    let f = Fixture::new(1)?;
    f.admit()?;
    let directory =
        PrivateDirectory::open_existing(&f.profile)?.open_child(OsStr::new(DIRECTORY), false)?;
    let mut data: Value = serde_json::from_slice(&read_file(&directory, DATA, DATA_LIMIT)?)?;
    let intent =
        data["inputs"].as_object().unwrap().values().next().unwrap()["publication"].clone();
    let operation_key = data["operations"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    let identity_key = data["inputIds"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    for key in ["works", "inputs", "inputIds", "operations"] {
        data[key] = json!({});
    }
    data["pendingPublications"] = json!({operation_key.clone(): intent});
    data["pendingInputIds"] = json!({identity_key: operation_key});
    directory.atomic_replace(OsStr::new(DATA), &serde_json::to_vec(&data)?)?;
    let before = read_file(&directory, DATA, DATA_LIMIT)?;
    assert!(ContinuousWorkStore::open_existing(&f.profile)?.is_some());
    let error = f.store.relocation_snapshot().unwrap_err();
    assert_eq!(
        error.to_string(),
        "CONTINUOUS_WORK_RELOCATION_PENDING_PUBLICATION"
    );
    assert_eq!(read_file(&directory, DATA, DATA_LIMIT)?, before);
    Ok(())
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn old_compatibility_bytes_survive_two_more_moves_without_new_payload_maps() -> Result<()> {
    let f = legacy_fixture()?;
    let directory =
        PrivateDirectory::open_existing(&f.profile)?.open_child(OsStr::new(DIRECTORY), false)?;
    let history = read_file(&directory, BINDINGS, BINDINGS_LIMIT)?;
    let data = read_file(&directory, DATA, DATA_LIMIT)?;
    let original_header: Header =
        serde_json::from_slice(&read_file(&directory, HEADER, HEADER_LIMIT)?)?;
    let expected = f.store.relocation_snapshot()?;
    let first_path = f.copy(&f.profile, "first-legacy-target", "first-move")?;
    let first = f.store.relocate(&first_path, "first-move", &expected)?;
    let expected = first.relocation_snapshot()?;
    let second_path = f.copy(&first_path, "second-legacy-target", "second-move")?;
    let second = first.relocate(&second_path, "second-move", &expected)?;
    let moved =
        PrivateDirectory::open_existing(&second_path)?.open_child(OsStr::new(DIRECTORY), false)?;
    assert_eq!(read_file(&moved, BINDINGS, BINDINGS_LIMIT)?, history);
    assert_eq!(read_file(&moved, DATA, DATA_LIMIT)?, data);
    let mut header: Header = serde_json::from_slice(&read_file(&moved, HEADER, HEADER_LIMIT)?)?;
    header.lock = original_header.lock.clone();
    assert_eq!(header, original_header);
    assert!(
        second
            .read_input(&f.scope, "original-work", &f.source, "original-input")?
            .is_some()
    );
    first.verify_relocation(&second_path, "second-move", &expected)?;
    Ok(())
}
