use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Global user memory file path.
///
/// Honours `KCODER_CONFIG_DIR` so isolated runs (containers, tests,
/// multi-account setups) never read or write the real user-level store.
pub fn global_memory_path() -> Result<PathBuf> {
    Ok(kcoder_config::user_config_dir()?.join("memories.json"))
}

#[cfg(test)]
fn global_memory_path_with_override(override_dir: Option<std::ffi::OsString>) -> Result<PathBuf> {
    let dir = override_dir
        .filter(|dir| !dir.is_empty())
        .ok_or_else(|| anyhow::anyhow!("config directory override was empty"))?;
    Ok(PathBuf::from(dir).join("memories.json"))
}

/// Resolve a project memory directory from the current working directory.
///
/// Uses the git root when available, otherwise the canonicalized cwd.
pub fn project_memory_dir(cwd: impl AsRef<Path>, base: impl AsRef<Path>) -> Result<PathBuf> {
    let key = project_key_for_path(cwd.as_ref());
    let dir = base.as_ref().join("projects").join(&key).join("memory");
    if !dir.exists() {
        // Migrate the immediately preceding 32-bit key first, then the
        // original unhashed key. Propagate failures so callers never switch
        // to an empty new directory while the old store remains stranded.
        for old_key in [
            unbounded_project_key(cwd.as_ref()),
            previous_project_key_for_path(cwd.as_ref()),
            legacy_project_key_for_path(cwd.as_ref()),
        ] {
            let old_dir = base.as_ref().join("projects").join(old_key).join("memory");
            if !old_dir.exists() {
                continue;
            }
            if let Some(parent) = dir.parent() {
                std::fs::create_dir_all(parent).with_context(|| {
                    format!(
                        "failed to create project memory migration directory {}",
                        parent.display()
                    )
                })?;
                std::fs::rename(&old_dir, &dir).with_context(|| {
                    format!(
                        "failed to migrate legacy project memory from {} to {}",
                        old_dir.display(),
                        dir.display()
                    )
                })?;
            }
            break;
        }
    }
    Ok(dir)
}

// The key rule is shared with self-evolution project partitions and lives in
// `kcoder_config`; these re-exports keep the existing Memory API unchanged.
pub use kcoder_config::memory_project_key::{
    legacy_project_key_for_path, previous_project_key_for_path, project_key_for_path,
};

pub(crate) fn unbounded_project_key(cwd: &Path) -> String {
    kcoder_config::memory_project_key::unbounded_project_key_for_path(cwd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn long_unicode_project_paths_create_memory_and_retain_full_path_identity() {
        let temp = TempDir::new().unwrap();
        let cwd = temp.path().join("项目".repeat(20)).join("目录".repeat(20));
        std::fs::create_dir_all(&cwd).unwrap();
        let key = project_key_for_path(&cwd);
        assert!(key.len() <= 217);
        assert_ne!(key, project_key_for_path(cwd.join("another")));
        let memory = project_memory_dir(&cwd, temp.path().join("memory-base")).unwrap();
        std::fs::create_dir_all(&memory).unwrap();
        std::fs::write(memory.join("note.md"), "retained").unwrap();
        assert_eq!(
            std::fs::read_to_string(memory.join("note.md")).unwrap(),
            "retained"
        );
    }

    #[test]
    fn bounded_project_key_migrates_existing_64_bit_key() {
        let temp = TempDir::new().unwrap();
        let cwd = temp.path().join("x".repeat(175));
        std::fs::create_dir_all(&cwd).unwrap();
        let base = temp.path().join("memory-base");
        let old = base
            .join("projects")
            .join(unbounded_project_key(&cwd))
            .join("memory");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("note.md"), "previous").unwrap();
        let memory = project_memory_dir(&cwd, &base).unwrap();
        assert_eq!(
            std::fs::read_to_string(memory.join("note.md")).unwrap(),
            "previous"
        );
    }

    #[test]
    fn project_memory_dir_migrates_legacy_unhashed_store() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("membase");
        let cwd = tmp.path().join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        // Write a store under the pre-hash key format.
        let legacy_dir = base
            .join("projects")
            .join(legacy_project_key_for_path(&cwd))
            .join("memory");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(legacy_dir.join("note.md"), "legacy").unwrap();

        let dir = project_memory_dir(&cwd, &base).unwrap();

        assert!(
            dir.join("note.md").exists(),
            "legacy store must be migrated, not orphaned"
        );
        assert!(
            !legacy_dir.exists(),
            "legacy directory must be moved, not copied"
        );
    }

    #[test]
    fn project_memory_dir_migrates_previous_32_bit_key_store() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("membase");
        let cwd = tmp.path().join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        let previous_dir = base
            .join("projects")
            .join(previous_project_key_for_path(&cwd))
            .join("memory");
        std::fs::create_dir_all(&previous_dir).unwrap();
        std::fs::write(previous_dir.join("note.md"), "previous").unwrap();

        let dir = project_memory_dir(&cwd, &base).unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.join("note.md")).unwrap(),
            "previous"
        );
        assert!(!previous_dir.exists());
    }

    #[test]
    fn project_memory_dir_reports_legacy_migration_failure() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("membase");
        let cwd = tmp.path().join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        let legacy_dir = base
            .join("projects")
            .join(legacy_project_key_for_path(&cwd))
            .join("memory");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(legacy_dir.join("note.md"), "legacy").unwrap();

        let destination_project = base.join("projects").join(project_key_for_path(&cwd));
        std::fs::create_dir_all(destination_project.parent().unwrap()).unwrap();
        std::fs::write(&destination_project, "blocks destination directory").unwrap();

        let error = project_memory_dir(&cwd, &base).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("failed to create project memory migration directory"),
            "{error:#}"
        );
        assert!(legacy_dir.join("note.md").exists());
    }

    #[test]
    fn project_memory_dir_under_base() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("membase");
        let dir = project_memory_dir(tmp.path(), &base).unwrap();
        assert!(dir.starts_with(&base));
        assert!(dir.to_string_lossy().contains("memory"));
    }

    #[test]
    fn global_memory_path_honours_config_dir_env() {
        let tmp = TempDir::new().unwrap();
        let resolved =
            global_memory_path_with_override(Some(tmp.path().as_os_str().to_owned())).unwrap();
        assert_eq!(resolved, tmp.path().join("memories.json"));
    }
}
