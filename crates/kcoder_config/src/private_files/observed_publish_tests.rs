use super::*;
use std::io::{Cursor, Read, Seek, SeekFrom};

#[test]
fn short_temporary_name_never_aliases_the_publication_target() -> Result<()> {
    const CHILD: &str = "KCODER_FS_TEMPORARY_ALIAS_TEST_ROOT";
    if let Some(root) = std::env::var_os(CHILD) {
        let root = PathBuf::from(root);
        let directory = PrivateDirectory::open_or_create(&root)?;
        // A dedicated child has one libtest thread, so no peer can consume the
        // next sequence between choosing the adversarial name and publication.
        for uppercase in [false, true] {
            let sequence = TEMPORARY_FILE_SEQUENCE.load(std::sync::atomic::Ordering::Relaxed);
            let name = format!(".kcoder.{}.{}.tmp", std::process::id(), sequence);
            let name = if uppercase {
                name.to_ascii_uppercase()
            } else {
                name
            };
            directory.atomic_publish_observed_from_reader(
                OsStr::new(&name),
                &mut Cursor::new(b"complete bytes"),
                false,
                || Ok(()),
                |_| {
                    assert!(
                        !root.join(&name).exists(),
                        "target appeared before publication"
                    );
                    Ok(())
                },
            )?;
            assert_eq!(std::fs::read(root.join(name))?, b"complete bytes");
        }
        println!("owned-temporary-alias-verified");
        return Ok(());
    }
    let root = crate::private_files::private_test_dir()?;
    let mut command = std::process::Command::new(std::env::current_exe()?);
    command.args(["--exact", "private_files::observed_publish_tests::short_temporary_name_never_aliases_the_publication_target",
        "--test-threads=1", "--nocapture"])
        .env_clear().env(CHILD, root.path())
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", system_root);
    }
    let mut child = command.spawn()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                child.wait()?;
                return Err(error.into());
            }
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            child.wait()?;
            anyhow::bail!("owned temporary-name test child timed out");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let output = child.wait_with_output()?;
    anyhow::ensure!(
        String::from_utf8_lossy(&output.stdout).contains("owned-temporary-alias-verified"),
        "owned test did not execute its publication assertions"
    );
    anyhow::ensure!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}
#[test]
fn the_original_flushed_descriptor_is_observed_once_before_the_destination_is_visible() -> Result<()>
{
    let root = crate::private_files::private_test_dir()?;
    let directory = PrivateDirectory::open_or_create(root.path())?;
    let mut identity = None;
    let mut calls = 0;
    let bytes = directory.atomic_publish_observed_from_reader(
        OsStr::new("owned"),
        &mut Cursor::new(b"original owned bytes"),
        false,
        || Ok(()),
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
    let root = crate::private_files::private_test_dir()?;
    let directory = PrivateDirectory::open_or_create(root.path())?;
    assert!(
        directory
            .atomic_publish_observed_from_reader(
                OsStr::new("cancelled"),
                &mut Cursor::new(b"not published"),
                false,
                || Ok(()),
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
                || Ok(()),
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
