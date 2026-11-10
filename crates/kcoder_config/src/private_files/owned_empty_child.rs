//! Remove only a caller-owned Windows directory by its verified native handle.

use super::{PrivateDirectory, private_file_identity, windows_native};
use anyhow::{Result, ensure};
use std::ffi::OsStr;

impl PrivateDirectory {
    /// Delete an empty child only if it is the same object as `original`.
    /// The deletion acts on the verified handle even if the name later changes.
    pub fn remove_owned_empty_child(&self, name: &OsStr, original: &Self) -> Result<()> {
        self.remove_owned_empty_child_with(name, original, || {})
    }

    fn remove_owned_empty_child_with(
        &self,
        name: &OsStr,
        original: &Self,
        after_open: impl FnOnce(),
    ) -> Result<()> {
        let candidate = windows_native::open_directory_for_deletion(&self.directory, name)?;
        ensure!(
            private_file_identity(&candidate)? == private_file_identity(&original.directory)?,
            "owned directory identity changed before cleanup"
        );
        after_open();
        ensure!(
            windows_native::directory_names_bounded(&candidate, 1)?.is_empty(),
            "owned directory is not empty"
        );
        windows_native::mark_handle_for_deletion(&candidate)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PrivateDirectory) {
        let root = tempfile::tempdir().unwrap();
        let parent = PrivateDirectory::open_or_create(&root.path().join("owned")).unwrap();
        (root, parent)
    }

    #[test]
    fn deletes_the_original_empty_child() {
        let (root, parent) = fixture();
        let child = parent.create_private_child(OsStr::new("child")).unwrap();
        parent
            .remove_owned_empty_child(OsStr::new("child"), &child)
            .unwrap();
        drop(child);
        assert!(!root.path().join("owned/child").exists());
    }

    #[test]
    fn nonempty_original_is_not_removed() {
        let (root, parent) = fixture();
        let child = parent.create_private_child(OsStr::new("child")).unwrap();
        child
            .atomic_replace(OsStr::new("keep"), b"owned data")
            .unwrap();
        assert!(
            parent
                .remove_owned_empty_child(OsStr::new("child"), &child)
                .is_err()
        );
        assert_eq!(
            std::fs::read(root.path().join("owned/child/keep")).unwrap(),
            b"owned data"
        );
    }

    #[test]
    fn replacement_is_not_removed() {
        let (root, parent) = fixture();
        let original = parent.create_private_child(OsStr::new("child")).unwrap();
        parent
            .rename_no_replace(OsStr::new("child"), OsStr::new("moved"))
            .unwrap();
        let replacement = parent.create_private_child(OsStr::new("child")).unwrap();
        assert!(
            parent
                .remove_owned_empty_child(OsStr::new("child"), &original)
                .is_err()
        );
        drop(replacement);
        assert!(root.path().join("owned/child").is_dir());
        assert!(root.path().join("owned/moved").is_dir());
    }

    #[test]
    fn replacement_after_open_does_not_redirect_deletion() {
        let (root, parent) = fixture();
        let original = parent.create_private_child(OsStr::new("child")).unwrap();
        parent
            .remove_owned_empty_child_with(OsStr::new("child"), &original, || {
                parent
                    .rename_no_replace(OsStr::new("child"), OsStr::new("moved"))
                    .unwrap();
                parent.create_private_child(OsStr::new("child")).unwrap();
            })
            .unwrap();
        drop(original);
        assert!(root.path().join("owned/child").is_dir());
        assert!(!root.path().join("owned/moved").exists());
    }
}
