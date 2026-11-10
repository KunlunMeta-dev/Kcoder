//! Versioned lock locations retain the original live namespace identities.
use super::*;

fn create_layout(profile: &PrivateDirectory, version: u32) -> Result<Header> {
    let directory = profile.create_private_child(OsStr::new(DIRECTORY))?;
    let profile_lock =
        (version == 2).then(|| format!(".continuous-work-{}.locks", uuid::Uuid::new_v4()));
    let external = profile_lock
        .as_ref()
        .map(|name| profile.create_private_child(OsStr::new(name)))
        .transpose()?;
    let lock_directory = external.as_ref().unwrap_or(&directory);
    let lock = lock_directory.open_read_write_file(OsStr::new(LOCK), true)?;
    let header = Header {
        version,
        profile: profile.directory_identity()?,
        directory: directory.directory_identity()?,
        lock: lock_directory.portable_regular_handle_identity(&lock)?,
        profile_lock,
        profile_lock_identity: external
            .as_ref()
            .map(PrivateDirectory::directory_identity)
            .transpose()?,
    };
    directory.atomic_replace(OsStr::new(DATA), b"original-data")?;
    directory.atomic_replace(OsStr::new(HEADER), &serde_json::to_vec(&header)?)?;
    Ok(header)
}

#[test]
fn legacy_internal_and_v2_private_external_locks_reopen_without_reinitializing() -> Result<()> {
    for version in [1, 2] {
        let temp = kcoder_config::create_private_temp_dir("continuous-lock-layout")?;
        let profile = PrivateDirectory::open_existing(temp.path())?;
        let original = create_layout(&profile, version)?;
        let before = std::fs::read(temp.path().join(DIRECTORY).join(HEADER))?;
        let namespace =
            Namespace::open_existing(temp.path())?.context("existing layout missing")?;
        assert_eq!(namespace.header, original);
        assert_eq!(
            namespace.read(|bytes| Ok(bytes.to_vec()))?,
            b"original-data"
        );
        drop(namespace);
        assert_eq!(
            std::fs::read(temp.path().join(DIRECTORY).join(HEADER))?,
            before
        );
    }
    Ok(())
}

#[test]
fn both_lock_layouts_accept_and_reopen_original_input_without_reinitializing() -> Result<()> {
    use crate::continuous_work::{ContinuousWorkStore, InitialAdmission, WorkInputSource};
    use kcoder_types::continuous_work::{WorkRecord, WorkScope};
    use serde_json::json;

    for version in [1, 2] {
        let temp = kcoder_config::create_private_temp_dir("continuous-lock-layout-input")?;
        let profile = PrivateDirectory::open_existing(temp.path())?;
        let original = create_layout(&profile, version)?;
        let directory = profile.open_child(OsStr::new(DIRECTORY), false)?;
        directory.atomic_replace(
            OsStr::new(DATA),
            &serde_json::to_vec(
                &json!({"version":1,"works":{},"inputs":{},"inputIds":{},"operations":{}}),
            )?,
        )?;
        let header_before = std::fs::read(temp.path().join(DIRECTORY).join(HEADER))?;
        let store =
            ContinuousWorkStore::open_existing(temp.path())?.context("existing store missing")?;
        let scope = WorkScope {
            account_id: "a".into(),
            target_id: "t".into(),
            workspace_id: "w".into(),
        };
        let source = WorkInputSource {
            kind: "foreground".into(),
            instance_id: "target-thread".into(),
            conversation_id: "thread".into(),
        };
        let work: WorkRecord = serde_json::from_value(json!({
            "schemaVersion":1,"identity":{"scope":scope,"workId":"work"},
            "origin":{"kind":"foreground","initialAttempt":{"threadId":"thread","turnId":"turn","attemptId":"attempt"}},
            "linkedThreadIds":["thread"],"phase":"pending","revision":{"revision":1,"requirementsRevision":1,
            "controlEpoch":0,"ownerEpoch":0,"acceptedInputSequence":1,"requiredInputSequence":1,"appliedInputSequence":0}
        }))?;
        assert!(matches!(
            store.admit(
                &scope,
                work,
                &source,
                "request",
                json!({"text":"original"}),
                vec![]
            )?,
            InitialAdmission::Accepted(_)
        ));
        assert_eq!(
            store
                .read_input(&scope, "work", &source, "request")?
                .unwrap()
                .1,
            json!({"text":"original"})
        );
        drop(store);
        let reopened =
            ContinuousWorkStore::open_existing(temp.path())?.context("reopened store missing")?;
        assert_eq!(reopened.list_inputs(&scope, "work", None)?.inputs.len(), 1);
        assert_eq!(
            std::fs::read(temp.path().join(DIRECTORY).join(HEADER))?,
            header_before
        );
        assert_eq!(
            Namespace::open_existing(temp.path())?.unwrap().header,
            original
        );
    }
    Ok(())
}

#[test]
fn malformed_external_lock_reference_is_rejected_without_touching_data() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-lock-invalid")?;
    let profile = PrivateDirectory::open_existing(temp.path())?;
    let mut header = create_layout(&profile, 2)?;
    header.profile_lock = Some("../other".into());
    let directory = profile.open_child(OsStr::new(DIRECTORY), false)?;
    directory.atomic_replace(OsStr::new(HEADER), &serde_json::to_vec(&header)?)?;
    let header_before = std::fs::read(temp.path().join(DIRECTORY).join(HEADER))?;
    let data_before = std::fs::read(temp.path().join(DIRECTORY).join(DATA))?;
    assert!(Namespace::open_existing(temp.path()).is_err());
    assert!(Namespace::open_or_create(temp.path(), b"new-data").is_err());
    assert_eq!(
        std::fs::read(temp.path().join(DIRECTORY).join(HEADER))?,
        header_before
    );
    assert_eq!(
        std::fs::read(temp.path().join(DIRECTORY).join(DATA))?,
        data_before
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn v2_external_directory_replacement_invalidates_the_held_namespace() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-lock-replacement")?;
    let profile = PrivateDirectory::open_existing(temp.path())?;
    let header = create_layout(&profile, 2)?;
    let namespace = Namespace::open_existing(temp.path())?.unwrap();
    let name = header.profile_lock.as_ref().unwrap();
    std::fs::rename(
        temp.path().join(name),
        temp.path().join("original-lock-directory"),
    )?;
    profile.create_private_child(OsStr::new(name))?;
    assert!(namespace.read(|_| Ok(())).is_err());
    assert!(
        temp.path()
            .join("original-lock-directory")
            .join(LOCK)
            .exists()
    );
    Ok(())
}
