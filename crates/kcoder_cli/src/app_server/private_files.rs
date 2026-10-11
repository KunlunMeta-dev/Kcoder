use anyhow::{Context, Result};
use kcoder_config::PrivateDirectory;
use sha2::Digest as _;
use std::path::Path;

pub(super) fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", sha2::Sha256::digest(bytes))
}

pub(super) fn ensure_private_artifact_directory(path: &Path) -> Result<()> {
    PrivateDirectory::open_or_create(path)?;
    Ok(())
}

pub(super) fn write_private_artifact_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("artifact file has no parent")?;
    let name = path.file_name().context("artifact file has no name")?;
    PrivateDirectory::open_or_create(parent)?.atomic_replace(name, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_is_stable() {
        assert_eq!(
            hex_sha256(b"kcoder"),
            "d1319c6d7ba13c0583e18ea13942202d26c9f00fd70bb4a046b68fa3f300b481"
        );
    }

    #[test]
    fn private_file_wrapper_replaces_content_and_keeps_one_leaf() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("nested").join("artifacts");
        let target = directory.join("state.json");

        write_private_artifact_file(&target, b"first").unwrap();
        write_private_artifact_file(&target, b"second").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"second");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn private_file_wrapper_rejects_a_symlinked_directory() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let linked = root.path().join("linked");
        symlink(outside.path(), &linked).unwrap();

        write_private_artifact_file(&linked.join("state.json"), b"private").unwrap_err();

        assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
    }
}
