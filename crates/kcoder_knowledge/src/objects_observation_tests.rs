use super::*;

#[test]
fn observing_existing_objects_never_creates_a_root_library_or_mutation() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("objects");
    assert!(ObjectStore::open_existing(path.clone()).is_err());
    assert!(!path.exists());
    let writer = ObjectStore::open(path.clone())?;
    let library = uuid::Uuid::new_v4().to_string();
    let hash = writer.put(&library, "original source")?;
    let reader = ObjectStore::open_existing(path.clone())?;
    assert_eq!(reader.read(&library, &hash)?, "original source");
    assert!(reader.put(&library, "different content").is_err());
    assert!(reader.remove_library_unpublished(&library).is_err());
    let missing = uuid::Uuid::new_v4().to_string();
    assert!(reader.read(&missing, &hash).is_err());
    assert!(!path.join(missing).exists());
    assert_eq!(writer.read(&library, &hash)?, "original source");
    Ok(())
}

#[test]
fn replaced_object_root_is_rejected_even_with_identical_content() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("objects");
    let writer = ObjectStore::open(path.clone())?;
    let library = uuid::Uuid::new_v4().to_string();
    let hash = writer.put(&library, "source")?;
    let reader = ObjectStore::open_existing(path.clone())?;
    fs::rename(&path, temp.path().join("original-objects"))?;
    let replacement = ObjectStore::open(path)?;
    replacement.put(&library, "source")?;
    assert!(reader.read(&library, &hash).is_err());
    Ok(())
}

#[cfg(unix)]
#[test]
fn observation_rejects_hardlinks_and_exposed_permissions_without_repair() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("objects");
    let writer = ObjectStore::open(path.clone())?;
    let library = uuid::Uuid::new_v4().to_string();
    let hash = writer.put(&library, "source")?;
    let reader = ObjectStore::open_existing(path.clone())?;
    fs::hard_link(
        path.join(&library).join(format!("{hash}.md")),
        temp.path().join("other-link"),
    )?;
    assert!(reader.read(&library, &hash).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
    assert!(ObjectStore::open_existing(path.clone()).is_err());
    assert_eq!(fs::metadata(path)?.permissions().mode() & 0o777, 0o755);
    Ok(())
}
