//! Creation cleanup retains DELETE access only until a verified traversal handle is ready.
use super::*;

pub(super) fn finish_created(parent: &File, name: &OsStr, directory: File) -> Result<File> {
    let mut cleanup = windows_native::HandleDeleteGuard::new(directory);
    secure_private_handle(cleanup.file(), true)?;
    failure_point(Stage::Secured)?;

    // A DELETE-capable parent handle prevents handle-relative child renames on Windows.
    // Reopen without DELETE while retaining cleanup authority over the original object.
    let (reopened, created) = windows_native::open_or_create_directory(parent, name, false, false)?;
    anyhow::ensure!(
        !created && private_file_identity(cleanup.file())? == private_file_identity(&reopened)?,
        "created private directory changed before handle handoff"
    );
    failure_point(Stage::Reopened)?;
    sync_private_directory(parent)?;
    cleanup.disarm();
    Ok(reopened)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Secured,
    Reopened,
}

fn failure_point(stage: Stage) -> Result<()> {
    #[cfg(test)]
    if FAILURE.with(|failure| {
        if failure.get() == Some(stage) {
            failure.set(None);
            true
        } else {
            false
        }
    }) {
        anyhow::bail!("injected directory handoff failure: {stage:?}");
    }
    #[cfg(not(test))]
    let _ = stage;
    Ok(())
}

#[cfg(test)]
thread_local! {
    static FAILURE: std::cell::Cell<Option<Stage>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newly_created_directory_handles_support_atomic_writes_and_directory_publication() {
        let root = tempfile::tempdir().unwrap();
        let base_path = root.path().join("profile");
        let base = PrivateDirectory::open_or_create(&base_path).unwrap();
        base.verify_private_directory().unwrap();
        base.atomic_replace(OsStr::new("settings.json"), b"first")
            .unwrap();
        base.atomic_replace(OsStr::new("settings.json"), b"second")
            .unwrap();
        for (name, exclusive) in [("created", true), ("opened", false)] {
            let child = if exclusive {
                base.create_private_child(OsStr::new(name)).unwrap()
            } else {
                base.open_child(OsStr::new(name), true).unwrap()
            };
            child.verify_private_directory().unwrap();
            child
                .atomic_replace(OsStr::new("lifecycle.json"), b"first")
                .unwrap();
            child
                .atomic_replace(OsStr::new("lifecycle.json"), b"second")
                .unwrap();
            drop(child);
            let published = format!("{name}-published");
            base.rename_no_replace(OsStr::new(name), OsStr::new(&published))
                .unwrap();
            assert_eq!(
                std::fs::read(base_path.join(published).join("lifecycle.json")).unwrap(),
                b"second"
            );
        }
    }

    #[test]
    fn failed_directory_handoff_removes_only_the_new_directory() {
        let root = tempfile::tempdir().unwrap();
        let base = PrivateDirectory::open_or_create(root.path()).unwrap();
        base.atomic_replace(OsStr::new("keep"), b"existing")
            .unwrap();
        for stage in [Stage::Secured, Stage::Reopened] {
            FAILURE.with(|failure| failure.set(Some(stage)));
            let error = base
                .create_private_child(OsStr::new("new-child"))
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("injected directory handoff failure")
            );
            assert!(!root.path().join("new-child").exists(), "{stage:?}");
            assert_eq!(
                std::fs::read(root.path().join("keep")).unwrap(),
                b"existing"
            );
        }
    }

    #[test]
    fn directory_replacement_is_rejected_without_deleting_the_replacement() {
        let root = tempfile::tempdir().unwrap();
        let base = PrivateDirectory::open_or_create(root.path()).unwrap();
        let name = OsStr::new("selected");
        let (original, created) =
            windows_native::open_or_create_directory(&base.directory, name, true, false).unwrap();
        assert!(created);
        base.rename_no_replace(name, OsStr::new("moved-original"))
            .unwrap();
        std::fs::create_dir(root.path().join(name)).unwrap();
        std::fs::write(root.path().join(name).join("keep"), b"replacement").unwrap();
        let error = finish_created(&base.directory, name, original).unwrap_err();
        assert!(error.to_string().contains("changed before handle handoff"));
        assert!(!root.path().join("moved-original").exists());
        assert_eq!(
            std::fs::read(root.path().join(name).join("keep")).unwrap(),
            b"replacement"
        );
    }

    #[test]
    fn missing_directory_entry_keeps_creation_cleanup_authority() {
        let root = tempfile::tempdir().unwrap();
        let base = PrivateDirectory::open_or_create(root.path()).unwrap();
        base.atomic_replace(OsStr::new("keep"), b"existing")
            .unwrap();
        let name = OsStr::new("selected");
        let (original, created) =
            windows_native::open_or_create_directory(&base.directory, name, true, false).unwrap();
        assert!(created);
        base.rename_no_replace(name, OsStr::new("moved-original"))
            .unwrap();
        finish_created(&base.directory, name, original).unwrap_err();
        assert!(!root.path().join("selected").exists());
        assert!(!root.path().join("moved-original").exists());
        assert_eq!(
            std::fs::read(root.path().join("keep")).unwrap(),
            b"existing"
        );
    }
}
