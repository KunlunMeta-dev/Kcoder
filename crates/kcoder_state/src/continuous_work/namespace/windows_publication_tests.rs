//! Native isolation matrix for publishing a private staging directory.
use super::*;

fn owned_child_names(path: &std::path::Path) -> Result<Vec<String>> {
    std::fs::read_dir(path)?
        .map(|entry| {
            entry?
                .file_name()
                .into_string()
                .map_err(|_| std::io::Error::other("owned fixture has a non-Unicode name"))
        })
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub(super) fn before_publication() -> Result<()> {
    match std::env::var("KCODER_TEST_WINDOWS_NAMESPACE_PUBLICATION").as_deref() {
        Ok("exit") => std::process::exit(95),
        Ok("barrier") => {
            let control = std::env::var_os("KCODER_TEST_WINDOWS_NAMESPACE_CONTROL")
                .context("owned test control directory missing")?;
            let control = std::path::Path::new(&control);
            std::fs::write(
                control.join(format!("ready-{}", std::process::id())),
                b"ready",
            )?;
            let started = std::time::Instant::now();
            while !control.join("release").exists() {
                ensure!(
                    started.elapsed() < Duration::from_secs(20),
                    "owned publication barrier timed out"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[test]
fn staging_publication_is_tested_with_live_directory_and_lock_handles() -> Result<()> {
    let mut failures = Vec::new();
    for (keep_directory, keep_lock) in [(true, true), (true, false), (false, true), (false, false)]
    {
        let temp = kcoder_config::create_private_temp_dir("continuous-windows-rename")?;
        let profile = PrivateDirectory::open_existing(temp.path())?;
        profile.verify_trusted_config_directory()?;
        let stage = ".continuous-work-00000000-0000-0000-0000-000000000001.pending";
        let mut directory = Some(profile.create_private_child(OsStr::new(stage))?);
        let child = directory.as_ref().unwrap();
        let mut lock = Some(child.open_read_write_file(OsStr::new(LOCK), true)?);
        let expected_directory = child.directory_identity()?;
        let expected_lock = child.portable_regular_handle_identity(lock.as_ref().unwrap())?;
        child.atomic_replace(OsStr::new(DATA), b"{}")?;
        child.atomic_replace(OsStr::new(HEADER), b"{}")?;
        child.sync()?;
        if !keep_lock {
            drop(lock.take());
        }
        if !keep_directory {
            drop(directory.take());
        }
        match profile.rename_no_replace(OsStr::new(stage), OsStr::new(DIRECTORY)) {
            Ok(()) => {
                let reopened = profile.open_child(OsStr::new(DIRECTORY), false)?;
                ensure!(reopened.directory_identity()? == expected_directory);
                ensure!(reopened.portable_regular_identity(OsStr::new(LOCK))? == expected_lock);
                if let Some(held) = &directory {
                    ensure!(held.directory_identity()? == expected_directory);
                }
                if let Some(held) = &lock {
                    ensure!(reopened.portable_regular_handle_identity(held)? == expected_lock);
                }
                eprintln!("directory={keep_directory}, lock={keep_lock}: published");
            }
            Err(error) => {
                eprintln!("directory={keep_directory}, lock={keep_lock}: {error:#}");
                let denied = error
                    .chain()
                    .filter_map(|cause| cause.downcast_ref::<std::io::Error>())
                    .any(|cause| cause.raw_os_error() == Some(5));
                // Some Windows filesystems refuse to rename a directory with
                // open descendants. The v2 layout does not rely on this case.
                if !keep_lock || !denied {
                    failures.push(format!("directory={keep_directory}, lock={keep_lock}"));
                }
            }
        }
    }
    ensure!(
        failures.is_empty(),
        "staging publication failed for {}",
        failures.join("; ")
    );
    Ok(())
}

#[test]
fn private_sibling_lock_remains_live_across_atomic_namespace_publication() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-windows-v2")?;
    let namespace = Namespace::open_or_create(temp.path(), b"original-data")?;
    assert_eq!(namespace.header.version, 2);
    let lock_name = namespace
        .header
        .profile_lock
        .as_ref()
        .context("v2 lock directory missing")?;
    assert!(!temp.path().join(DIRECTORY).join(LOCK).exists());
    assert!(temp.path().join(lock_name).join(LOCK).exists());
    assert_eq!(
        namespace.read(|bytes| Ok(bytes.to_vec()))?,
        b"original-data"
    );
    let original_header = namespace.header.clone();
    drop(namespace);
    let reopened = Namespace::open_existing(temp.path())?.context("published namespace missing")?;
    assert_eq!(reopened.header, original_header);
    assert_eq!(reopened.read(|bytes| Ok(bytes.to_vec()))?, b"original-data");
    Ok(())
}

#[test]
fn concurrent_initializers_bind_one_namespace_without_deleting_the_loser() -> Result<()> {
    if let Some(profile) = std::env::var_os("KCODER_TEST_WINDOWS_NAMESPACE_PROFILE") {
        let namespace = Namespace::open_or_create(std::path::Path::new(&profile), b"original")?;
        println!(
            "CHILD_LOCK={}",
            namespace
                .header
                .profile_lock
                .as_deref()
                .unwrap_or("missing")
        );
        return Ok(());
    }
    let temp = kcoder_config::create_private_temp_dir("continuous-windows-init-race")?;
    let control = temp.path().join("owned-control");
    std::fs::create_dir(&control)?;
    std::fs::write(temp.path().join("keep-owned"), b"preserve")?;
    let spawn = || {
        std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "continuous_work::namespace::windows_publication_tests::concurrent_initializers_bind_one_namespace_without_deleting_the_loser", "--nocapture"])
        .env("KCODER_TEST_WINDOWS_NAMESPACE_PROFILE", temp.path())
        .env("KCODER_TEST_WINDOWS_NAMESPACE_CONTROL", &control)
        .env("KCODER_TEST_WINDOWS_NAMESPACE_PUBLICATION", "barrier")
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn()
    };
    let first = spawn()?;
    let second = match spawn() {
        Ok(child) => child,
        Err(error) => {
            let mut first = first;
            let _ = first.kill();
            let _ = first.wait();
            return Err(error.into());
        }
    };
    let mut children = vec![first, second];
    let ready = (|| -> Result<()> {
        let start = std::time::Instant::now();
        loop {
            let count = owned_child_names(&control)?
                .iter()
                .filter(|name| name.starts_with("ready-"))
                .count();
            if count == 2 {
                break;
            }
            for child in &mut children {
                ensure!(
                    child.try_wait()?.is_none(),
                    "owned initializer exited before barrier"
                );
            }
            ensure!(
                start.elapsed() < Duration::from_secs(15),
                "owned initializers did not reach barrier"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        std::fs::write(control.join("release"), b"release")?;
        Ok(())
    })();
    if let Err(error) = ready {
        for child in &mut children {
            let _ = child.kill();
            let _ = child.wait();
        }
        return Err(error);
    }
    let mut outputs = Vec::new();
    for child in children {
        outputs.push(child.wait_with_output()?);
    }
    let namespace =
        Namespace::open_existing(temp.path())?.context("published namespace missing")?;
    let winner = namespace
        .header
        .profile_lock
        .as_deref()
        .context("winner lock missing")?;
    for output in outputs {
        ensure!(
            output.status.success(),
            "owned initializer failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        ensure!(
            String::from_utf8_lossy(&output.stdout).contains(&format!("CHILD_LOCK={winner}")),
            "initializer selected a different lock"
        );
    }
    assert_eq!(namespace.read(|bytes| Ok(bytes.to_vec()))?, b"original");
    assert_eq!(std::fs::read(temp.path().join("keep-owned"))?, b"preserve");
    let names = owned_child_names(temp.path())?;
    assert_eq!(
        names
            .iter()
            .filter(|name| name.starts_with(".continuous-work-") && name.ends_with(".locks"))
            .count(),
        2
    );
    assert_eq!(
        names
            .iter()
            .filter(|name| name.starts_with(".continuous-work-") && name.ends_with(".pending"))
            .count(),
        1
    );
    Ok(())
}

#[test]
fn crash_before_publication_preserves_unclaimed_staging_and_lock() -> Result<()> {
    if let Some(profile) = std::env::var_os("KCODER_TEST_WINDOWS_NAMESPACE_CRASH_PROFILE") {
        Namespace::open_or_create(std::path::Path::new(&profile), b"original")?;
        anyhow::bail!("owned child did not exit before publication");
    }
    let temp = kcoder_config::create_private_temp_dir("continuous-windows-init-crash")?;
    let child = std::process::Command::new(std::env::current_exe()?)
        .args(["--exact", "continuous_work::namespace::windows_publication_tests::crash_before_publication_preserves_unclaimed_staging_and_lock", "--nocapture"])
        .env("KCODER_TEST_WINDOWS_NAMESPACE_CRASH_PROFILE", temp.path())
        .env("KCODER_TEST_WINDOWS_NAMESPACE_PUBLICATION", "exit").output()?;
    assert_eq!(
        child.status.code(),
        Some(95),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&child.stdout),
        String::from_utf8_lossy(&child.stderr)
    );
    assert!(!temp.path().join(DIRECTORY).exists());
    let names = owned_child_names(temp.path())?;
    let stage_name = names
        .iter()
        .find(|name| name.starts_with(".continuous-work-") && name.ends_with(".pending"))
        .context("orphan stage missing")?;
    let lock_name = names
        .iter()
        .find(|name| name.starts_with(".continuous-work-") && name.ends_with(".locks"))
        .context("orphan lock directory missing")?;
    let profile = PrivateDirectory::open_existing(temp.path())?;
    let stage = profile.open_child(OsStr::new(stage_name), false)?;
    let lock_directory = profile.open_child(OsStr::new(lock_name), false)?;
    let stage_identity = stage.directory_identity()?;
    let lock_directory_identity = lock_directory.directory_identity()?;
    let lock_anchor = lock_directory.open_single_link_regular_file(OsStr::new(LOCK))?;
    let lock_identity = lock_directory.portable_regular_handle_identity(&lock_anchor)?;
    let header = read_file(&stage, HEADER, HEADER_LIMIT)?;
    let original = read_file(&stage, DATA, DATA_LIMIT)?;
    let namespace = Namespace::open_or_create(temp.path(), b"new-original")?;
    assert_eq!(namespace.read(|bytes| Ok(bytes.to_vec()))?, b"new-original");
    assert_eq!(
        profile
            .open_child(OsStr::new(stage_name), false)?
            .directory_identity()?,
        stage_identity
    );
    assert_eq!(
        profile
            .open_child(OsStr::new(lock_name), false)?
            .directory_identity()?,
        lock_directory_identity
    );
    assert_eq!(
        lock_directory.portable_regular_identity(OsStr::new(LOCK))?,
        lock_identity
    );
    assert_eq!(read_file(&stage, HEADER, HEADER_LIMIT)?, header);
    assert_eq!(read_file(&stage, DATA, DATA_LIMIT)?, original);
    Ok(())
}
