//! Workspace deletion stays relative to held directory capabilities on every platform.
use super::*;

impl PrivateDirectory {
    /// Remove one selected child; never traverse replacement links or resolve a held parent by path.
    pub fn remove_child_entry(&self, name: &OsStr, recursive: bool) -> Result<()> {
        self.remove_child_entry_at_depth(name, recursive, 0)
    }

    fn remove_child_entry_at_depth(
        &self,
        name: &OsStr,
        recursive: bool,
        depth: usize,
    ) -> Result<()> {
        validate_single_name(name)?;
        anyhow::ensure!(
            depth < 128,
            "workspace deletion exceeds directory depth limit"
        );
        #[cfg(unix)]
        {
            let metadata = self.entry_metadata(name)?;
            if metadata.is_dir() {
                if recursive {
                    cap_primitives::fs::remove_dir_all(&self.directory, Path::new(name))?;
                } else {
                    cap_primitives::fs::remove_dir(&self.directory, Path::new(name))?;
                }
            } else if metadata.is_file() || metadata.file_type().is_symlink() {
                cap_primitives::fs::remove_file(&self.directory, Path::new(name))?;
            } else {
                anyhow::bail!("workspace entry type cannot be deleted");
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            let entry = windows_native::open_entry(&self.directory, name, true)?;
            let metadata = entry.metadata()?;
            if metadata.is_dir() && metadata.file_attributes() & 0x400 == 0 && recursive {
                let child = self.open_child(name, false)?;
                anyhow::ensure!(
                    private_file_identity(&entry)? == private_file_identity(&child.directory)?,
                    "workspace deletion target changed"
                );
                child.visit_entry_names_bounded(65_536, |child_name| {
                    child.remove_child_entry_at_depth(child_name, true, depth + 1)
                })?;
            }
            // The kernel rejects nonempty directories. The handle identifies the
            // original entry even if its parent/name was concurrently replaced.
            windows_native::remove_entry_handle(&entry)?;
        }
        sync_private_directory(&self.directory)?;
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn deletion_does_not_follow_replaced_parent_or_nested_links() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("parent")).unwrap();
        std::fs::create_dir(root.path().join("parent/tree")).unwrap();
        std::fs::write(outside.path().join("retained"), "keep").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("parent/tree/link")).unwrap();
        let parent = PrivateDirectory::open_existing(&root.path().join("parent")).unwrap();
        std::fs::rename(root.path().join("parent"), root.path().join("moved")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("parent")).unwrap();
        parent.remove_child_entry(OsStr::new("tree"), true).unwrap();
        assert!(!root.path().join("moved/tree").exists());
        assert_eq!(
            std::fs::read_to_string(outside.path().join("retained")).unwrap(),
            "keep"
        );
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn deletion_remains_bound_to_held_parent_after_directory_replacement() {
        let root = tempfile::tempdir().unwrap();
        let parent_path = root.path().join("parent");
        std::fs::create_dir_all(parent_path.join("tree")).unwrap();
        std::fs::write(parent_path.join("tree/selected"), "selected").unwrap();
        let parent = PrivateDirectory::open_existing(&parent_path).unwrap();
        std::fs::rename(&parent_path, root.path().join("original")).unwrap();
        std::fs::create_dir_all(parent_path.join("tree")).unwrap();
        std::fs::write(parent_path.join("tree/retained"), "keep").unwrap();
        parent.remove_child_entry(OsStr::new("tree"), true).unwrap();
        assert!(!root.path().join("original/tree").exists());
        assert_eq!(
            std::fs::read_to_string(parent_path.join("tree/retained")).unwrap(),
            "keep"
        );
    }
}
