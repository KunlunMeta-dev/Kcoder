//! Spec workspace paths domain implementation.

use super::*;

pub fn specs_dir_for(cwd: &Path) -> PathBuf {
    cwd.join(SPECS_DIR)
}

pub(super) fn validate_change_name(name: &str) -> Result<()> {
    // Windows device names are not regular files even with extensions; reject them consistently across platforms.
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            });
    // Reject separators, drive/ADS syntax, wildcards, and control characters while retaining ordinary Unicode names.
    anyhow::ensure!(
        !name.trim().is_empty()
            && !reserved
            && !name.contains(['/', '\\', ':', '?', '*', '<', '>', '|', '"'])
            && !name.chars().any(char::is_control)
            && !name.ends_with(['.', ' '])
            && matches!(
                Path::new(name).components().next(),
                Some(std::path::Component::Normal(_))
            )
            && Path::new(name).components().count() == 1,
        "invalid change name: expected a non-empty single path component"
    );
    Ok(())
}

pub(super) fn check_change_directory(path: &Path, workspace: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            anyhow::ensure!(
                !metadata.file_type().is_symlink(),
                "change path must not contain a symlink: {}",
                path.display()
            );
            anyhow::ensure!(
                metadata.is_dir(),
                "change path must be a directory: {}",
                path.display()
            );
            let resolved = path
                .canonicalize()
                .with_context(|| format!("failed to resolve change path {}", path.display()))?;
            anyhow::ensure!(
                resolved.starts_with(workspace),
                "change path escapes workspace: {}",
                path.display()
            );
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to inspect change path {}", path.display()));
        }
    }
    Ok(())
}

pub(super) fn checked_changes_dir(cwd: &Path) -> Result<PathBuf> {
    let workspace = cwd
        .canonicalize()
        .context("failed to resolve spec workspace")?;
    let mut path = cwd.to_path_buf();
    // Check only the static boundary at call time; this does not claim protection against concurrent parent replacement afterward.
    for part in [".kcoder", "specs", "changes"] {
        path.push(part);
        check_change_directory(&path, &workspace)?;
    }
    Ok(path)
}

pub(super) fn checked_change_dir(cwd: &Path, name: &str) -> Result<PathBuf> {
    // Validate names before canonicalize, metadata, or any other I/O.
    validate_change_name(name)?;
    let path = checked_changes_dir(cwd)?.join(name);
    let workspace = cwd
        .canonicalize()
        .context("failed to resolve spec workspace")?;
    check_change_directory(&path, &workspace)?;
    Ok(path)
}

pub(super) fn read_validated_project_config(specs_dir: &Path) -> Result<config::ProjectConfig> {
    let config = config::read_or_default(specs_dir)?;
    let errors = config::validate_schema(&config);
    if !errors.is_empty() {
        anyhow::bail!("invalid spec configuration: {}", errors.join("; "));
    }
    Ok(config)
}
