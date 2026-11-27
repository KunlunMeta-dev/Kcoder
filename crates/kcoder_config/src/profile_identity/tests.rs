use super::*;
use std::path::Path;

fn copy_record(source: &Path, target: &Path) -> Result<()> {
    std::fs::copy(source.join(RECORD), target.join(RECORD))?;
    Ok(())
}

fn write_v1(profile: &PrivateDirectory, seed: &str) -> Result<Vec<u8>> {
    let file = profile.open_read_write_file(OsStr::new(RECORD), true)?;
    let value = serde_json::json!({
        "version": 1,
        "logicalSeed": seed,
        "profileIdentity": profile.directory_identity()?,
        "recordIdentity": PortableLeaseIdentity::from_private_regular_handle(&file)?,
        "operationId": "historical-move",
        "sourceProfileIdentity": "historical-source",
        "sourceRecordSha256": null,
    });
    let mut bytes = serde_json::to_vec_pretty(&value)?;
    bytes.push(b'\n');
    (&file).write_all(&bytes)?;
    file.sync_all()?;
    Ok(bytes)
}

#[test]
fn legacy_observation_is_pure_and_uses_the_original_root_identity() -> Result<()> {
    let owned = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_existing(owned.path())?;
    let identity = ProfileIdentity::observe(&profile)?;
    assert_eq!(identity.logical_seed(), profile.directory_identity()?);
    identity.verify(&profile)?;
    assert_eq!(std::fs::read_dir(owned.path())?.count(), 0);
    Ok(())
}

#[test]
fn readonly_relocation_verifies_continuity_without_persisting_move_operations() -> Result<()> {
    let source_root = tempfile::tempdir()?;
    let target_root = tempfile::tempdir()?;
    let foreign_root = tempfile::tempdir()?;
    let source = PrivateDirectory::open_existing(source_root.path())?;
    let target = PrivateDirectory::open_existing(target_root.path())?;
    let foreign = PrivateDirectory::open_existing(foreign_root.path())?;
    let original = ProfileIdentity::observe(&source)?;
    assert!(
        original
            .verify_relocation(&source, &target, "original")
            .is_err()
    );
    assert_eq!(std::fs::read_dir(target_root.path())?.count(), 0);
    original.relocate(&source, &target, "original")?;
    let before = std::fs::read(target_root.path().join(RECORD))?;
    let identity = target.regular_file_identity(OsStr::new(RECORD))?;
    let verified = original.verify_relocation(&source, &target, "original")?;
    assert_eq!(verified.logical_seed(), original.logical_seed());
    original.verify_relocation(&source, &target, "caller-verified-operation")?;
    assert!(
        ProfileIdentity::observe(&foreign)?
            .verify_relocation(&foreign, &target, "original")
            .is_err()
    );
    assert!(
        original
            .verify_relocation(&source, &source, "same-root")
            .is_err()
    );
    for operation in ["".to_owned(), "  ".to_owned(), "x".repeat(257)] {
        assert!(
            original
                .verify_relocation(&source, &target, &operation)
                .is_err()
        );
        assert!(original.relocate(&source, &target, &operation).is_err());
    }
    assert_eq!(std::fs::read(target_root.path().join(RECORD))?, before);
    assert_eq!(target.regular_file_identity(OsStr::new(RECORD))?, identity);
    assert_eq!(std::fs::read_dir(source_root.path())?.count(), 0);
    Ok(())
}

#[test]
fn legacy_first_move_creates_only_a_stable_seed_and_retries_do_not_write() -> Result<()> {
    let source_root = tempfile::tempdir()?;
    let target_root = tempfile::tempdir()?;
    let source = PrivateDirectory::open_existing(source_root.path())?;
    let target = PrivateDirectory::open_existing(target_root.path())?;
    let original = ProfileIdentity::observe(&source)?;
    let relocated = original.relocate(&source, &target, "move-original")?;
    assert_eq!(relocated.logical_seed(), original.logical_seed());
    assert_ne!(relocated.logical_seed(), target.directory_identity()?);
    relocated.verify(&target)?;
    original.verify(&source)?;
    assert_eq!(std::fs::read_dir(source_root.path())?.count(), 0);
    let bytes = std::fs::read(target_root.path().join(RECORD))?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)?;
    assert_eq!(value.as_object().unwrap().len(), 2);
    assert_eq!(value["version"], 2);
    assert_eq!(value["logicalSeed"], original.logical_seed());
    let file_identity = target.regular_file_identity(OsStr::new(RECORD))?;
    for operation in ["move-original", "another-caller-verified-move"] {
        let replay = original.relocate(&source, &target, operation)?;
        assert_eq!(replay.logical_seed(), original.logical_seed());
        assert_eq!(std::fs::read(target_root.path().join(RECORD))?, bytes);
        assert_eq!(
            target.regular_file_identity(OsStr::new(RECORD))?,
            file_identity
        );
        assert_eq!(std::fs::read_dir(target_root.path())?.count(), 1);
    }
    Ok(())
}

#[test]
fn copied_v1_envelopes_keep_original_bytes_and_ignore_historical_physical_fields() -> Result<()> {
    let first_root = tempfile::tempdir()?;
    let second_root = tempfile::tempdir()?;
    let third_root = tempfile::tempdir()?;
    let first = PrivateDirectory::open_existing(first_root.path())?;
    let second = PrivateDirectory::open_existing(second_root.path())?;
    let third = PrivateDirectory::open_existing(third_root.path())?;
    let seed = first.directory_identity()?;
    let original_bytes = write_v1(&first, &seed)?;
    let original = ProfileIdentity::observe(&first)?;
    copy_record(first_root.path(), second_root.path())?;
    let cold_second = ProfileIdentity::observe(&second)?;
    assert_eq!(cold_second.logical_seed(), seed);
    cold_second.verify(&second)?;
    let second_identity = second.regular_file_identity(OsStr::new(RECORD))?;
    let moved = original.relocate(&first, &second, "new-move")?;
    assert_eq!(
        std::fs::read(second_root.path().join(RECORD))?,
        original_bytes
    );
    assert_eq!(
        second.regular_file_identity(OsStr::new(RECORD))?,
        second_identity
    );
    copy_record(second_root.path(), third_root.path())?;
    let third_identity = third.regular_file_identity(OsStr::new(RECORD))?;
    let moved_again = moved.relocate(&second, &third, "next-move")?;
    assert_eq!(moved_again.logical_seed(), seed);
    moved_again.verify(&third)?;
    moved.verify(&second)?;
    original.verify(&first)?;
    for root in [first_root.path(), second_root.path(), third_root.path()] {
        assert_eq!(std::fs::read(root.join(RECORD))?, original_bytes);
        assert_eq!(std::fs::read_dir(root)?.count(), 1);
    }
    assert_eq!(
        third.regular_file_identity(OsStr::new(RECORD))?,
        third_identity
    );
    Ok(())
}

#[test]
fn copied_v2_seed_is_stable_and_an_existing_source_record_cannot_be_recreated() -> Result<()> {
    let first_root = tempfile::tempdir()?;
    let second_root = tempfile::tempdir()?;
    let third_root = tempfile::tempdir()?;
    let first = PrivateDirectory::open_existing(first_root.path())?;
    let second = PrivateDirectory::open_existing(second_root.path())?;
    let third = PrivateDirectory::open_existing(third_root.path())?;
    let original = ProfileIdentity::observe(&first)?;
    let moved = original.relocate(&first, &second, "first-move")?;
    assert!(moved.relocate(&second, &third, "missing-copy").is_err());
    assert_eq!(std::fs::read_dir(third_root.path())?.count(), 0);
    let bytes = std::fs::read(second_root.path().join(RECORD))?;
    copy_record(second_root.path(), third_root.path())?;
    let identity = third.regular_file_identity(OsStr::new(RECORD))?;
    let cold = ProfileIdentity::observe(&third)?;
    assert_eq!(cold.logical_seed(), original.logical_seed());
    moved
        .relocate(&second, &third, "second-move")?
        .verify(&third)?;
    assert_eq!(std::fs::read(third_root.path().join(RECORD))?, bytes);
    assert_eq!(third.regular_file_identity(OsStr::new(RECORD))?, identity);
    assert_eq!(std::fs::read_dir(third_root.path())?.count(), 1);
    Ok(())
}

#[test]
fn held_observation_rejects_record_replacement_and_a_different_root() -> Result<()> {
    let source_root = tempfile::tempdir()?;
    let target_root = tempfile::tempdir()?;
    let other_root = tempfile::tempdir()?;
    let source = PrivateDirectory::open_existing(source_root.path())?;
    let target = PrivateDirectory::open_existing(target_root.path())?;
    let other = PrivateDirectory::open_existing(other_root.path())?;
    let original = ProfileIdentity::observe(&source)?;
    let before = ProfileIdentity::observe(&target)?;
    let relocated = original.relocate(&source, &target, "move")?;
    assert!(before.verify(&target).is_err());
    assert!(relocated.verify(&other).is_err());
    let bytes = std::fs::read(target_root.path().join(RECORD))?;
    target.atomic_replace(OsStr::new(RECORD), &bytes)?;
    assert!(relocated.verify(&target).is_err());
    let cold = ProfileIdentity::observe(&target)?;
    assert_eq!(cold.logical_seed(), relocated.logical_seed());
    cold.verify(&target)?;
    assert_eq!(std::fs::read(target_root.path().join(RECORD))?, bytes);
    Ok(())
}

#[test]
fn held_observation_rejects_in_place_record_changes() -> Result<()> {
    let root = tempfile::tempdir()?;
    let profile = PrivateDirectory::open_existing(root.path())?;
    let original_bytes = write_v1(&profile, "original-logical-seed")?;
    let observed = ProfileIdentity::observe(&profile)?;
    let changed = String::from_utf8(original_bytes.clone())?
        .replace("original-logical-seed", "modified-logical-seed");
    assert_eq!(changed.len(), original_bytes.len());
    let file = profile.open_read_write_file(OsStr::new(RECORD), false)?;
    (&file).write_all(changed.as_bytes())?;
    file.sync_all()?;
    assert!(observed.verify(&profile).is_err());
    Ok(())
}

#[test]
fn conflicting_valid_records_are_preserved_even_when_the_seed_matches() -> Result<()> {
    let source_root = tempfile::tempdir()?;
    let target_root = tempfile::tempdir()?;
    let source = PrivateDirectory::open_existing(source_root.path())?;
    let target = PrivateDirectory::open_existing(target_root.path())?;
    let seed = source.directory_identity()?;
    write_v1(&source, &seed)?;
    let conflicting = write_v1(&target, &seed)?;
    let original = ProfileIdentity::observe(&source)?;
    assert!(original.relocate(&source, &target, "move").is_err());
    assert!(
        original
            .verify_relocation(&source, &target, "move")
            .is_err()
    );
    assert_eq!(std::fs::read(target_root.path().join(RECORD))?, conflicting);
    assert_eq!(std::fs::read_dir(target_root.path())?.count(), 1);
    Ok(())
}

#[test]
fn unknown_future_or_partial_records_are_preserved() -> Result<()> {
    for bytes in [
        br#"{"version":99,"logicalSeed":"seed"}"#.as_slice(),
        br#"{"version":2,"logicalSeed":""}"#,
        br#"{"version":2,"logicalSeed":"seed","extra":true}"#,
        b"partial",
    ] {
        let source_root = tempfile::tempdir()?;
        let target_root = tempfile::tempdir()?;
        let source = PrivateDirectory::open_existing(source_root.path())?;
        let target = PrivateDirectory::open_existing(target_root.path())?;
        let original = ProfileIdentity::observe(&source)?;
        target.atomic_replace(OsStr::new(RECORD), bytes)?;
        assert!(ProfileIdentity::observe(&target).is_err());
        assert!(original.relocate(&source, &target, "move").is_err());
        assert_eq!(std::fs::read(target_root.path().join(RECORD))?, bytes);
        assert_eq!(std::fs::read_dir(target_root.path())?.count(), 1);
    }
    Ok(())
}

#[test]
fn first_seed_publication_recovers_only_its_exact_prepared_bytes() -> Result<()> {
    for matching in [true, false] {
        let source_root = tempfile::tempdir()?;
        let target_root = tempfile::tempdir()?;
        let source = PrivateDirectory::open_existing(source_root.path())?;
        let target = PrivateDirectory::open_existing(target_root.path())?;
        let original = ProfileIdentity::observe(&source)?;
        let prepared = prepared_name(
            "caller-verified-move",
            &source.directory_identity()?,
            &target.directory_identity()?,
        )?;
        let bytes = if matching {
            original.relocation_bytes()?
        } else {
            b"partial".to_vec()
        };
        target.atomic_replace(OsStr::new(&prepared), &bytes)?;
        let result = original.relocate(&source, &target, "caller-verified-move");
        assert_eq!(result.is_ok(), matching);
        let name = if matching { RECORD } else { &prepared };
        assert_eq!(std::fs::read(target_root.path().join(name))?, bytes);
        assert_eq!(std::fs::read_dir(target_root.path())?.count(), 1);
    }
    Ok(())
}

#[test]
fn a_prepared_seed_copied_from_the_source_is_not_adopted() -> Result<()> {
    let source_root = tempfile::tempdir()?;
    let target_root = tempfile::tempdir()?;
    let source = PrivateDirectory::open_existing(source_root.path())?;
    let target = PrivateDirectory::open_existing(target_root.path())?;
    let original = ProfileIdentity::observe(&source)?;
    let prepared = prepared_name(
        "original-operation",
        &source.directory_identity()?,
        &target.directory_identity()?,
    )?;
    let bytes = original.relocation_bytes()?;
    source.atomic_replace(OsStr::new(&prepared), &bytes)?;
    std::fs::copy(
        source_root.path().join(&prepared),
        target_root.path().join(&prepared),
    )?;
    assert!(
        original
            .relocate(&source, &target, "original-operation")
            .is_err()
    );
    assert!(!target_root.path().join(RECORD).exists());
    for root in [source_root.path(), target_root.path()] {
        assert_eq!(std::fs::read(root.join(&prepared))?, bytes);
        assert_eq!(std::fs::read_dir(root)?.count(), 1);
    }
    Ok(())
}

#[cfg(unix)]
#[test]
fn symlink_and_hard_link_records_are_rejected_without_repair() -> Result<()> {
    use std::os::unix::fs::symlink;
    for symbolic in [true, false] {
        let source_root = tempfile::tempdir()?;
        let target_root = tempfile::tempdir()?;
        let source = PrivateDirectory::open_existing(source_root.path())?;
        let target = PrivateDirectory::open_existing(target_root.path())?;
        let original = ProfileIdentity::observe(&source)?;
        original.relocate(&source, &target, "move")?;
        let alias = target_root.path().join("original-record");
        if symbolic {
            std::fs::rename(target_root.path().join(RECORD), &alias)?;
            symlink(&alias, target_root.path().join(RECORD))?;
        } else {
            std::fs::hard_link(target_root.path().join(RECORD), &alias)?;
        }
        let before = std::fs::read(&alias)?;
        assert!(ProfileIdentity::observe(&target).is_err());
        assert!(original.relocate(&source, &target, "move").is_err());
        assert_eq!(std::fs::read(&alias)?, before);
        assert_eq!(std::fs::read_dir(target_root.path())?.count(), 2);
    }
    Ok(())
}
