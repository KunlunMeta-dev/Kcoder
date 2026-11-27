//! Bounded skill entry discovery shared by runtime loading and Studio inventory.
use anyhow::{Context, Result, ensure};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

/// Accept a skill collection, a single skill directory, or an explicit SKILL.md.
/// A single skill is not recursively scanned for examples or reference bundles.
pub fn skill_entry_paths(root: &Path) -> Result<Vec<PathBuf>> {
    let metadata = fs::symlink_metadata(root)
        .with_context(|| format!("failed to inspect skill root {root:?}"))?;
    ensure!(
        !metadata.file_type().is_symlink(),
        "skill root may not be a symlink: {root:?}"
    );
    if metadata.is_file() {
        ensure!(
            root.file_name().is_some_and(|name| name == "SKILL.md"),
            "explicit skill file must be SKILL.md"
        );
        return Ok(vec![root.to_path_buf()]);
    }
    ensure!(
        metadata.is_dir(),
        "skill root must be a directory or SKILL.md"
    );
    let direct = root.join("SKILL.md");
    match fs::symlink_metadata(&direct) {
        Ok(metadata) => {
            ensure!(
                metadata.is_file() && !metadata.file_type().is_symlink(),
                "skill entry must be a regular non-symlink file"
            );
            return Ok(vec![direct]);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("failed to inspect direct skill entry"),
    }
    let started = Instant::now();
    let mut result = Vec::new();
    for (index, entry) in fs::read_dir(root)?.enumerate() {
        ensure!(
            index < 4096 && started.elapsed() <= Duration::from_secs(5),
            "skill discovery budget exceeded (4096 entries / 5 seconds) at {root:?}"
        );
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path().join("SKILL.md");
        if fs::symlink_metadata(&path)
            .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        {
            result.push(path);
        }
    }
    result.sort();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_collection_leaf_and_file_without_loading_nested_examples() {
        let temp = tempfile::tempdir().unwrap();
        let leaf = temp.path().join("design");
        fs::create_dir_all(leaf.join("examples/other")).unwrap();
        fs::write(leaf.join("SKILL.md"), "body").unwrap();
        fs::write(leaf.join("examples/other/SKILL.md"), "example").unwrap();
        for root in [
            temp.path().to_path_buf(),
            leaf.clone(),
            leaf.join("SKILL.md"),
        ] {
            assert_eq!(
                skill_entry_paths(&root).unwrap(),
                vec![leaf.join("SKILL.md")]
            );
        }
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_roots_and_ignores_symlink_children() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("SKILL.md"), "body").unwrap();
        let link = temp.path().join("linked");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        assert!(skill_entry_paths(&link).is_err());
        assert!(skill_entry_paths(temp.path()).unwrap().is_empty());
    }
}
