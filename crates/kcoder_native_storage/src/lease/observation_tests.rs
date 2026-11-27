use super::observation::MAX_OBSERVATIONS;
use super::*;

const INSTANCES: &str = "kcoder-storage-instances.lock";

fn held(path: &Path, mode: Mode) -> Result<StorageLease> {
    match StorageLease::acquire(path, INSTANCES, mode, false)? {
        Acquisition::Held(lease) => Ok(lease),
        _ => anyhow::bail!("expected the owned original instance lease"),
    }
}

fn facts(lease: &mut StorageLease, path: &str, kind: &str) -> Result<serde_json::Value> {
    Ok(serde_json::from_str(
        &lease.observe_entry(Path::new(path), kind)?,
    )?)
}

#[test]
fn observations_return_only_metadata_without_parsing_or_writing_payloads() -> Result<()> {
    let owned = tempfile::tempdir()?;
    let nested = owned.path().join("ordinary/nested");
    std::fs::create_dir_all(&nested)?;
    let bytes = vec![255; 128 * 1024];
    let payload = nested.join("opaque.bin");
    std::fs::write(&payload, &bytes)?;
    let before = std::fs::metadata(&payload)?;
    let mut lease = held(owned.path(), Mode::Shared)?;
    let directory = facts(&mut lease, "ordinary/nested", "directory")?;
    let file = facts(&mut lease, "ordinary/nested/opaque.bin", "file")?;
    assert_eq!(directory.as_object().unwrap().len(), 2);
    assert_eq!(file.as_object().unwrap().len(), 2);
    assert!(directory["links"].is_null());
    assert_eq!(file["links"], "1");
    let directory_identity: PortableLeaseIdentity =
        serde_json::from_str(directory["identity"].as_str().unwrap())?;
    assert_eq!(
        directory_identity,
        PrivateDirectory::open_existing(&nested)?.portable_directory_handle_identity()?
    );
    let (identity, links) =
        PortableLeaseIdentity::observe_regular_handle_metadata(&File::open(&payload)?)?;
    assert_eq!(file["identity"], serde_json::to_string(&identity)?);
    assert_eq!(links, 1);
    lease.verify()?;
    assert_eq!(std::fs::metadata(&payload)?.modified()?, before.modified()?);
    assert_eq!(std::fs::read(&payload)?, bytes);
    assert_eq!(std::fs::read_dir(&nested)?.count(), 1);
    assert_eq!(std::fs::read_dir(owned.path())?.count(), 2);
    Ok(())
}

#[test]
fn observations_reject_wrong_scope_kind_or_outside_paths_without_creating_entries() -> Result<()> {
    let owned = tempfile::tempdir()?;
    std::fs::create_dir(owned.path().join("child"))?;
    std::fs::write(owned.path().join("payload"), b"keep")?;
    let mut lease = held(owned.path(), Mode::Shared)?;
    for path in ["", ".", "..", "../payload", "child/../../payload"] {
        assert!(
            lease.observe_entry(Path::new(path), "file").is_err(),
            "{path}"
        );
    }
    assert!(lease.observe_entry(owned.path(), "directory").is_err());
    for kind in ["", "Directory", "symlink", "readWrite"] {
        assert!(lease.observe_entry(Path::new("child"), kind).is_err());
    }
    for (path, kind) in [
        ("payload", "directory"),
        ("child", "file"),
        ("absent", "file"),
    ] {
        assert!(lease.observe_entry(Path::new(path), kind).is_err());
    }
    for name in ["kcoder-storage.lock", "kcoder-storage-writers.lock"] {
        let Acquisition::Held(mut other) =
            StorageLease::acquire(owned.path(), name, Mode::Shared, false)?
        else {
            anyhow::bail!("expected the other owned lock");
        };
        assert!(
            other
                .observe_entry(Path::new("child"), "directory")
                .is_err()
        );
    }
    assert!(lease.observations.is_empty());
    assert!(!owned.path().join("absent").exists());
    assert_eq!(std::fs::read(owned.path().join("payload"))?, b"keep");
    lease.verify()?;
    Ok(())
}

#[test]
fn repeated_observations_are_bounded_and_never_unlock_the_original_instance_lease() -> Result<()> {
    let owned = tempfile::tempdir()?;
    for index in 0..MAX_OBSERVATIONS + 1 {
        std::fs::create_dir(owned.path().join(format!("entry-{index}")))?;
    }
    let mut lease = held(owned.path(), Mode::Exclusive)?;
    let first = facts(&mut lease, "entry-0", "directory")?;
    for _ in 0..70 {
        assert_eq!(facts(&mut lease, "entry-0", "directory")?, first);
    }
    for index in 1..MAX_OBSERVATIONS {
        facts(&mut lease, &format!("entry-{index}"), "directory")?;
    }
    assert_eq!(lease.observations.len(), MAX_OBSERVATIONS);
    assert!(
        lease
            .observe_entry(Path::new(&format!("entry-{MAX_OBSERVATIONS}")), "directory")
            .is_err()
    );
    assert!(lease.observe_entry(Path::new("entry-0"), "file").is_err());
    lease.verify()?;
    assert!(matches!(
        StorageLease::acquire(owned.path(), INSTANCES, Mode::SharedExisting, false)?,
        Acquisition::Busy
    ));
    drop(lease);
    held(owned.path(), Mode::Exclusive)?.verify()?;
    Ok(())
}

#[test]
fn linked_file_observation_records_exact_links_without_relaxing_strict_file_apis() -> Result<()> {
    for remove_link in [false, true] {
        let owned = tempfile::tempdir()?;
        let payload = owned.path().join("payload");
        std::fs::write(&payload, b"known linked bytes")?;
        std::fs::hard_link(&payload, owned.path().join("alias"))?;
        let mut lease = held(owned.path(), Mode::Shared)?;
        let observed = facts(&mut lease, "payload", "file")?;
        assert_eq!(observed["links"], "2");
        assert_eq!(observed, facts(&mut lease, "alias", "file")?);
        assert!(
            lease
                .directory
                .open_single_link_regular_file(OsStr::new("payload"))
                .is_err()
        );
        assert!(PortableLeaseIdentity::from_regular_handle(&File::open(&payload)?).is_err());
        lease.verify()?;
        if remove_link {
            std::fs::remove_file(owned.path().join("alias"))?;
        } else {
            std::fs::hard_link(&payload, owned.path().join("third"))?;
        }
        assert!(lease.verify().is_err());
        assert!(lease.observe_entry(Path::new("payload"), "file").is_err());
        assert_eq!(std::fs::read(&payload)?, b"known linked bytes");
    }
    Ok(())
}

#[cfg(unix)]
#[test]
fn directory_and_same_byte_file_replacements_invalidate_the_original_observation() -> Result<()> {
    for kind in ["directory", "file"] {
        let owned = tempfile::tempdir()?;
        let entry = owned.path().join("entry");
        if kind == "directory" {
            std::fs::create_dir(&entry)?;
        } else {
            std::fs::write(&entry, b"same bytes")?;
        }
        let mut lease = held(owned.path(), Mode::Shared)?;
        facts(&mut lease, "entry", kind)?;
        std::fs::rename(&entry, owned.path().join("original"))?;
        if kind == "directory" {
            std::fs::create_dir(&entry)?;
        } else {
            std::fs::write(&entry, b"same bytes")?;
        }
        assert!(lease.verify().is_err(), "{kind}");
        assert!(lease.observe_entry(Path::new("entry"), kind).is_err());
        assert!(owned.path().join("original").exists());
    }
    Ok(())
}

#[cfg(unix)]
#[test]
fn replacing_a_parent_is_rejected_even_when_the_observed_child_identity_survives() -> Result<()> {
    let owned = tempfile::tempdir()?;
    std::fs::create_dir(owned.path().join("parent"))?;
    std::fs::write(owned.path().join("parent/entry"), b"same object")?;
    let mut lease = held(owned.path(), Mode::Shared)?;
    facts(&mut lease, "parent/entry", "file")?;
    std::fs::rename(owned.path().join("parent"), owned.path().join("detached"))?;
    std::fs::create_dir(owned.path().join("parent"))?;
    std::fs::rename(
        owned.path().join("detached/entry"),
        owned.path().join("parent/entry"),
    )?;
    assert!(lease.verify().is_err());
    assert_eq!(
        std::fs::read(owned.path().join("parent/entry"))?,
        b"same object"
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn observations_do_not_follow_a_leaf_or_parent_symlink_outside_the_held_root() -> Result<()> {
    use std::os::unix::fs::symlink;
    let owned = tempfile::tempdir()?;
    let root = owned.path().join("root");
    let outside = owned.path().join("outside");
    std::fs::create_dir(&root)?;
    std::fs::create_dir(&outside)?;
    std::fs::write(outside.join("payload"), b"outside bytes")?;
    symlink(&outside, root.join("parent-link"))?;
    symlink(outside.join("payload"), root.join("file-link"))?;
    let mut lease = held(&root, Mode::Shared)?;
    for (path, kind) in [
        ("parent-link", "directory"),
        ("parent-link/payload", "file"),
        ("file-link", "file"),
    ] {
        assert!(lease.observe_entry(Path::new(path), kind).is_err());
    }
    assert!(lease.observations.is_empty());
    assert_eq!(std::fs::read(outside.join("payload"))?, b"outside bytes");
    lease.verify()?;
    Ok(())
}

#[test]
fn individual_observation_does_not_replace_the_full_parent_fence_check() -> Result<()> {
    let owned = tempfile::tempdir()?;
    std::fs::write(owned.path().join("first"), b"first")?;
    std::fs::write(owned.path().join("second"), b"second")?;
    let mut lease = held(owned.path(), Mode::Shared)?;
    facts(&mut lease, "first", "file")?;
    // Observe is not admission: another previously observed object's invalidation
    // must still fail the full verify used before every live parent handshake.
    std::fs::hard_link(owned.path().join("first"), owned.path().join("new-alias"))?;
    facts(&mut lease, "second", "file")?;
    assert!(lease.verify().is_err());
    assert!(matches!(
        StorageLease::acquire(owned.path(), INSTANCES, Mode::Exclusive, false)?,
        Acquisition::Busy
    ));
    Ok(())
}
