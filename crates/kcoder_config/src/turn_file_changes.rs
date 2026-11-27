//! Turn file-change snapshot policy.
//!
//! Each completed turn snapshots the worktree so the change can be reviewed or
//! reverted. Large workspaces (model weights, datasets, virtual images) make
//! that unbounded, so the policy bounds what is stored and how long it lives.

use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const DEFAULT_TURN_FILE_CHANGES_RETENTION_DAYS: u64 = 14;
pub const DEFAULT_TURN_FILE_CHANGES_MAX_TOTAL_BYTES: u64 = 5 * 1024 * 1024 * 1024;
pub const DEFAULT_TURN_FILE_CHANGES_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TurnFileChangesSettings {
    /// When false, completed turns stop writing snapshots entirely.
    pub enabled: bool,
    /// Snapshots older than this are reclaimed.
    pub retention_days: u64,
    /// Soft cap for the total snapshot footprint; the oldest snapshots go first.
    pub max_total_bytes: u64,
    /// Files larger than this are listed as changed but their contents are not stored.
    pub max_file_bytes: u64,
    /// Additional path globs excluded from snapshots (for example `**/*.gguf`).
    pub ignore_globs: Vec<String>,
}

impl Default for TurnFileChangesSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            retention_days: DEFAULT_TURN_FILE_CHANGES_RETENTION_DAYS,
            max_total_bytes: DEFAULT_TURN_FILE_CHANGES_MAX_TOTAL_BYTES,
            max_file_bytes: DEFAULT_TURN_FILE_CHANGES_MAX_FILE_BYTES,
            ignore_globs: Vec::new(),
        }
    }
}

impl TurnFileChangesSettings {
    /// Compiles `ignore_globs`; invalid patterns are reported to the caller.
    pub fn compile_ignore_globs(&self) -> Result<GlobSet, globset::Error> {
        let mut builder = GlobSetBuilder::new();
        for pattern in &self.ignore_globs {
            builder.add(Glob::new(pattern.trim())?);
        }
        builder.build()
    }

    /// True when `relative_path` must stay out of the snapshot.
    pub fn excludes(&self, relative_path: &Path, ignore: &GlobSet) -> bool {
        !self.enabled || ignore.is_match(relative_path)
    }

    /// True when a file of `size` bytes is too large to store.
    pub fn file_exceeds_limit(&self, size: u64) -> bool {
        self.max_file_bytes > 0 && size > self.max_file_bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_bound_the_snapshot_footprint() {
        let settings = TurnFileChangesSettings::default();
        assert!(settings.enabled);
        assert_eq!(settings.retention_days, 14);
        assert_eq!(settings.max_total_bytes, 5 * 1024 * 1024 * 1024);
        assert_eq!(settings.max_file_bytes, 64 * 1024 * 1024);
        assert!(settings.ignore_globs.is_empty());
    }

    #[test]
    fn ignore_globs_exclude_matching_paths_only() {
        let settings = TurnFileChangesSettings {
            ignore_globs: vec!["**/*.gguf".into(), "node_modules/**".into()],
            ..TurnFileChangesSettings::default()
        };
        let ignore = settings.compile_ignore_globs().unwrap();
        assert!(settings.excludes(Path::new("models/qwen.gguf"), &ignore));
        assert!(settings.excludes(Path::new("node_modules/pkg/index.js"), &ignore));
        assert!(!settings.excludes(Path::new("crates/api/src/lib.rs"), &ignore));
    }

    #[test]
    fn file_size_limit_is_inclusive_and_can_be_disabled() {
        let settings = TurnFileChangesSettings {
            max_file_bytes: 1024,
            ..TurnFileChangesSettings::default()
        };
        assert!(!settings.file_exceeds_limit(1024));
        assert!(settings.file_exceeds_limit(1025));
        let unlimited = TurnFileChangesSettings {
            max_file_bytes: 0,
            ..TurnFileChangesSettings::default()
        };
        assert!(!unlimited.file_exceeds_limit(u64::MAX));
    }

    #[test]
    fn disabled_policy_excludes_everything() {
        let settings = TurnFileChangesSettings {
            enabled: false,
            ..TurnFileChangesSettings::default()
        };
        let ignore = settings.compile_ignore_globs().unwrap();
        assert!(settings.excludes(Path::new("crates/api/src/lib.rs"), &ignore));
    }

    #[test]
    fn invalid_glob_patterns_are_reported() {
        let settings = TurnFileChangesSettings {
            ignore_globs: vec!["[".into()],
            ..TurnFileChangesSettings::default()
        };
        assert!(settings.compile_ignore_globs().is_err());
    }
}
