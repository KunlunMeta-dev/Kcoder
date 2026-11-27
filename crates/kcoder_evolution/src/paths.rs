//! Scope-root resolution and storage names for target keys.

use crate::error::{EvolutionError, Result};
use kcoder_types::evolution::TargetKey;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Directory created under every scope root.
pub const EVOLUTION_DIR_NAME: &str = "evolution";
/// Directory under the data root that holds project partitions.
pub const EVOLUTION_PROJECTS_DIR_NAME: &str = "evolution-projects";

/// Which partition a target's evolution data belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvolutionScope {
    /// User-level targets: user, bundled, Hub and external skills, tools and
    /// preferences.
    User,
    /// Project-level targets (project skills and project knowledge) of the
    /// project that contains this working directory.
    Project { cwd: PathBuf },
}

/// The user data root for evolution storage: the user configuration
/// directory, honouring `KCODER_CONFIG_DIR` and `KCODER_HOME`.
pub fn default_data_root() -> Result<PathBuf> {
    Ok(kcoder_config::user_config_dir()?)
}

/// Resolve the scope root under `data_root`.
///
/// - [`EvolutionScope::User`] resolves to `data_root`, so data lives in
///   `<data_root>/evolution/`.
/// - [`EvolutionScope::Project`] resolves to
///   `<data_root>/evolution-projects/<project-key>`, where the key is the
///   Memory project key (`kcoder_config::memory_project_key`), so data lives
///   in `<data_root>/evolution-projects/<project-key>/evolution/`.
///
/// Project data is never placed inside the project: a data root located in
/// the project's Git root (or working directory) is rejected.
pub fn resolve_scope_root(data_root: &Path, scope: &EvolutionScope) -> Result<PathBuf> {
    match scope {
        EvolutionScope::User => Ok(data_root.to_path_buf()),
        EvolutionScope::Project { cwd } => {
            let project_root = kcoder_config::memory_project_key::project_root_for_path(cwd);
            let project_root = normalize_existing(&project_root);
            if normalize_existing(data_root).starts_with(&project_root) {
                return Err(EvolutionError::ScopeInsideProject(data_root.to_path_buf()));
            }
            let key = kcoder_config::memory_project_key::project_key_for_path(cwd);
            Ok(data_root.join(EVOLUTION_PROJECTS_DIR_NAME).join(key))
        }
    }
}

/// Canonicalize the longest existing prefix so a not-yet-created data root
/// still compares against the canonical project root.
fn normalize_existing(path: &Path) -> PathBuf {
    let mut suffix = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        if let Ok(canonical) = current.canonicalize() {
            let mut result = canonical;
            for component in suffix.iter().rev() {
                result.push(component);
            }
            return result;
        }
        match (
            current.file_name().map(|name| name.to_os_string()),
            current.parent(),
        ) {
            (Some(name), Some(parent)) => {
                suffix.push(name);
                current = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// Filesystem-safe, case-collision-free directory name for a target key:
/// `<type>.<source>.<sanitized-name>.<hash>`, where the hash is the first
/// 16 hex digits of SHA-256 over the full case-preserving key. The full key
/// is also stored in `overlay.json` and verified on read.
pub fn target_storage_component(key: &TargetKey) -> String {
    let full = key.to_string();
    let digest = Sha256::digest(full.as_bytes());
    let hash: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let mut name: String = key
        .name()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    name.truncate(48);
    format!(
        "{}.{}.{}.{}",
        key.target_type().as_str(),
        key.source(),
        name,
        hash
    )
}
