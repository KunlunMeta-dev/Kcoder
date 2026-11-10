use super::*;
use std::io::{Cursor, Read, Seek, SeekFrom};
#[test]
fn the_original_flushed_descriptor_is_observed_once_before_the_destination_is_visible() -> Result<()>
{
    let root = tempfile::tempdir()?;
    let directory = PrivateDirectory::open_or_create(root.path())?;
    let mut identity = None;
    let mut calls = 0;
    let bytes = directory.atomic_publish_observed_from_reader(
        OsStr::new("owned"),
        &mut Cursor::new(b"original owned bytes"),
        false,
        || Ok(None),
        |file| {
            calls += 1;
            assert!(directory.open_regular_file(OsStr::new("owned")).is_err());
            assert_eq!(file.metadata()?.len(), 20);
            let mut observed = file.try_clone()?;
            observed.seek(SeekFrom::Start(0))?;
            let mut body = Vec::new();
            observed.read_to_end(&mut body)?;
            assert_eq!(body, b"original owned bytes");
            identity = Some(directory.portable_regular_handle_identity(file)?);
            Ok(())
        },
    )?;
    assert_eq!(calls, 1);
    assert_eq!(bytes, 20);
    assert_eq!(
        directory.portable_regular_identity(OsStr::new("owned"))?,
        identity.unwrap()
    );
    Ok(())
}
#[test]
fn observation_failure_and_a_no_replace_conflict_do_not_publish_or_claim_an_existing_file()
-> Result<()> {
    let root = tempfile::tempdir()?;
    let directory = PrivateDirectory::open_or_create(root.path())?;
    assert!(
        directory
            .atomic_publish_observed_from_reader(
                OsStr::new("cancelled"),
                &mut Cursor::new(b"not published"),
                false,
                || Ok(None),
                |_| anyhow::bail!("owned observation cancelled")
            )
            .is_err()
    );
    assert!(!root.path().join("cancelled").exists());
    directory.atomic_replace(OsStr::new("occupied"), b"keep this user file")?;
    let original = directory.portable_regular_identity(OsStr::new("occupied"))?;
    let mut observed = None;
    assert!(
        directory
            .atomic_publish_observed_from_reader(
                OsStr::new("occupied"),
                &mut Cursor::new(b"new native output"),
                false,
                || Ok(None),
                |file| {
                    observed = Some(directory.portable_regular_handle_identity(file)?);
                    Ok(())
                }
            )
            .is_err()
    );
    assert_ne!(observed.unwrap(), original);
    assert_eq!(
        directory.portable_regular_identity(OsStr::new("occupied"))?,
        original
    );
    let mut bytes = Vec::new();
    directory
        .open_regular_file(OsStr::new("occupied"))?
        .read_to_end(&mut bytes)?;
    assert_eq!(bytes, b"keep this user file");
    let mut names = Vec::new();
    directory.visit_entry_names_bounded(4, |name| {
        names.push(name.to_owned());
        Ok(())
    })?;
    assert_eq!(names, [OsString::from("occupied")]);
    Ok(())
}
