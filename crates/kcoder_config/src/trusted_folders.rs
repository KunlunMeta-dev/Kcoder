//! Folder trust store: project-level extensions (skills, hooks, plugins, MCP
//! servers) are only activated for directories the user has explicitly
//! trusted. An untrusted repo cannot smuggle executable hooks, MCP servers,
//! plugins, or skills into a session merely by being opened.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Outcome of a trust lookup for a directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderTrust {
    /// The directory or one of its ancestors is trusted.
    Trusted,
    /// The user chose "never trust" for this directory.
    Never,
    /// No decision recorded yet.
    Unknown,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TrustFile {
    #[serde(default)]
    trusted: BTreeSet<PathBuf>,
    #[serde(default)]
    never: BTreeSet<PathBuf>,
}

/// Persistent folder-trust store at `<config_dir>/trusted-folders.json`.
#[derive(Debug, Clone)]
pub struct FolderTrustStore {
    path: PathBuf,
    file: TrustFile,
}

impl FolderTrustStore {
    /// Load the store from `<config_dir>/trusted-folders.json`; a missing or
    /// malformed file starts empty (fail closed, nothing is trusted).
    pub fn load(config_dir: &Path) -> Self {
        let path = config_dir.join("trusted-folders.json");
        let file = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self { path, file }
    }

    fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_string_pretty(&self.file)?;
        std::fs::write(&self.path, raw)
            .with_context(|| format!("failed to write {}", self.path.display()))
    }

    fn normalize(path: &Path) -> PathBuf {
        path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
    }

    fn contains_ancestor(set: &BTreeSet<PathBuf>, path: &Path) -> bool {
        set.iter().any(|base| path.starts_with(base))
    }

    /// Resolve the trust status of `path` (a directory).
    pub fn check(&self, path: &Path) -> FolderTrust {
        let normalized = Self::normalize(path);
        if Self::contains_ancestor(&self.file.never, &normalized) {
            return FolderTrust::Never;
        }
        if Self::contains_ancestor(&self.file.trusted, &normalized) {
            return FolderTrust::Trusted;
        }
        FolderTrust::Unknown
    }

    /// Record a trust decision. Returns whether persisting succeeded; callers
    /// may continue with the in-memory decision even on write failure.
    pub fn trust(&mut self, path: &Path) -> Result<()> {
        let normalized = Self::normalize(path);
        self.file.never.remove(&normalized);
        self.file.trusted.insert(normalized);
        self.save()
    }

    pub fn never(&mut self, path: &Path) -> Result<()> {
        let normalized = Self::normalize(path);
        self.file.trusted.remove(&normalized);
        self.file.never.insert(normalized);
        self.save()
    }

    pub fn revoke(&mut self, path: &Path) -> Result<()> {
        let normalized = Self::normalize(path);
        self.file.trusted.remove(&normalized);
        self.file.never.remove(&normalized);
        self.save()
    }

    /// Explicitly bypassed via --trust-all or KCODER_TRUST_ALL; used by
    /// the gating code instead of touching the store.
    pub fn trust_all_from_environment() -> bool {
        std::env::var("KCODER_TRUST_ALL")
            .map(|value| matches!(value.as_str(), "1" | "true" | "yes"))
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_by_default_and_ancestor_resolution_works() {
        let tmp = tempfile::tempdir().unwrap();
        let mut store = FolderTrustStore::load(tmp.path());
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(repo.join("sub")).unwrap();

        assert_eq!(store.check(&repo), FolderTrust::Unknown);
        store.trust(&repo).unwrap();
        assert_eq!(store.check(&repo), FolderTrust::Trusted);
        assert_eq!(store.check(&repo.join("sub")), FolderTrust::Trusted);

        // Persists across reloads.
        let reloaded = FolderTrustStore::load(tmp.path());
        assert_eq!(reloaded.check(&repo), FolderTrust::Trusted);
    }

    #[test]
    fn never_overrides_trust_and_revoke_clears() {
        let tmp = tempfile::tempdir().unwrap();
        let mut store = FolderTrustStore::load(tmp.path());
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();

        store.trust(&repo).unwrap();
        store.never(&repo).unwrap();
        assert_eq!(store.check(&repo), FolderTrust::Never);
        store.revoke(&repo).unwrap();
        assert_eq!(store.check(&repo), FolderTrust::Unknown);
    }
}
