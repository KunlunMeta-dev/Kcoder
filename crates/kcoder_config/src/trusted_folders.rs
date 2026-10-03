//! Folder trust store for project extensions (skills, hooks, plugins, MCP).
//! The runtime user's home is trusted by default. Explicit never-trust decisions
//! take precedence, and revoking trust also disables inherited home defaults.

use anyhow::{Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::io::Read;
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
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    revoked_defaults: BTreeSet<PathBuf>,
}

/// Persistent folder-trust store at `<config_dir>/trusted-folders.json`.
#[derive(Debug, Clone)]
pub struct FolderTrustStore {
    path: PathBuf,
    file: TrustFile,
    default_home: Option<PathBuf>,
}

impl FolderTrustStore {
    /// Resolve home on the runtime target, not from the client's config path.
    /// Invalid or unreadable existing trust files remain fail-closed.
    pub fn load(config_dir: &Path) -> Self {
        Self::load_with_home(config_dir, dirs::home_dir())
    }

    fn load_with_home(config_dir: &Path, home: Option<PathBuf>) -> Self {
        let path = config_dir.join("trusted-folders.json");
        let (file, allow_default) = match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str(&raw) {
                Ok(file) => (file, true),
                Err(_) => (TrustFile::default(), false),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (TrustFile::default(), true)
            }
            Err(_) => (TrustFile::default(), false),
        };
        let default_home = home
            .filter(|_| allow_default)
            .and_then(|home| home.canonicalize().ok())
            .filter(|home| home.is_dir() && home.parent().is_some());
        Self {
            path,
            file,
            default_home,
        }
    }

    /// Mutations reload under a process-shared lock and publish atomically. An
    /// unsuccessful write must neither alter memory nor erase another writer.
    fn update(&mut self, change: impl FnOnce(&mut TrustFile)) -> Result<()> {
        let parent = self.path.parent().context("trust store has no parent")?;
        let directory = crate::PrivateDirectory::open_or_create(parent)?;
        let lock_name = OsStr::new("trusted-folders.lock");
        let lock = match directory.open_read_write_file(lock_name, true) {
            Ok(lock) => lock,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::AlreadyExists) =>
            {
                directory.open_read_write_file(lock_name, false)?
            }
            Err(error) => return Err(error),
        };
        lock.lock_exclusive()?;
        let name = OsStr::new("trusted-folders.json");
        let mut latest = match directory.open_regular_file(name) {
            Ok(mut file) => {
                let mut raw = String::new();
                file.read_to_string(&mut raw)?;
                serde_json::from_str::<TrustFile>(&raw).context("invalid existing trust store")?
            }
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                TrustFile::default()
            }
            Err(error) => return Err(error),
        };
        change(&mut latest);
        directory.atomic_replace(name, &serde_json::to_vec_pretty(&latest)?)?;
        self.file = latest;
        Ok(())
    }

    pub fn default_home(&self) -> Option<&Path> {
        self.default_home.as_deref()
    }

    /// Explicit records include exclusions, so revocations remain manageable.
    pub fn explicit_decisions(&self) -> impl Iterator<Item = (&Path, FolderTrust)> {
        self.file
            .trusted
            .iter()
            .map(|path| (path.as_path(), FolderTrust::Trusted))
            .chain(
                self.file
                    .never
                    .iter()
                    .map(|path| (path.as_path(), FolderTrust::Never)),
            )
            .chain(
                self.file
                    .revoked_defaults
                    .iter()
                    .map(|path| (path.as_path(), FolderTrust::Unknown)),
            )
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
        if !Self::contains_ancestor(&self.file.revoked_defaults, &normalized)
            && self.default_home.as_ref().is_some_and(|home| {
                // Require real paths so a dangling symlink cannot inherit trust
                // from its lexical position inside the home directory.
                path.canonicalize().is_ok_and(|path| path.starts_with(home))
            })
        {
            return FolderTrust::Trusted;
        }
        FolderTrust::Unknown
    }

    /// Publish a trust decision only after persistence succeeds.
    pub fn trust(&mut self, path: &Path) -> Result<()> {
        let normalized = Self::normalize(path);
        self.update(|file| {
            file.never.remove(&normalized);
            file.revoked_defaults.remove(&normalized);
            file.trusted.insert(normalized);
        })
    }

    pub fn never(&mut self, path: &Path) -> Result<()> {
        let normalized = Self::normalize(path);
        self.update(|file| {
            file.trusted.remove(&normalized);
            file.revoked_defaults.remove(&normalized);
            file.never.insert(normalized);
        })
    }

    pub fn revoke(&mut self, path: &Path) -> Result<()> {
        let normalized = Self::normalize(path);
        self.update(|file| {
            file.trusted.remove(&normalized);
            file.never.remove(&normalized);
            file.revoked_defaults.insert(normalized);
        })
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
    fn independent_trust_writers_merge_and_rejected_updates_preserve_memory() {
        let temp = tempfile::tempdir().unwrap();
        let mut first = FolderTrustStore::load_with_home(temp.path(), None);
        let mut second = FolderTrustStore::load_with_home(temp.path(), None);
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        first.trust(&a).unwrap();
        second.never(&b).unwrap();
        let loaded = FolderTrustStore::load_with_home(temp.path(), None);
        assert_eq!(loaded.check(&a), FolderTrust::Trusted);
        assert_eq!(loaded.check(&b), FolderTrust::Never);
        assert_eq!(loaded.explicit_decisions().count(), 2);
        std::fs::write(temp.path().join("trusted-folders.json"), "invalid").unwrap();
        assert!(first.revoke(&a).is_err());
        assert_eq!(first.check(&a), FolderTrust::Trusted);
        assert_eq!(
            std::fs::read_to_string(temp.path().join("trusted-folders.json")).unwrap(),
            "invalid"
        );
    }

    #[test]
    fn home_default_is_target_scoped_and_explicit_decisions_persist() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("runtime-user");
        let project = home.join("project");
        let outside = tmp.path().join("another-user");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let config = tmp.path().join("custom-config");
        let mut store = FolderTrustStore::load_with_home(&config, Some(home.clone()));
        assert_eq!(store.check(&home), FolderTrust::Trusted);
        assert_eq!(store.check(&project), FolderTrust::Trusted);
        assert_eq!(store.check(&outside), FolderTrust::Unknown);
        assert!(!config.join("trusted-folders.json").exists());
        store.never(&project).unwrap();
        assert_eq!(
            FolderTrustStore::load_with_home(&config, Some(home.clone())).check(&project),
            FolderTrust::Never
        );
        store.revoke(&project).unwrap();
        assert_eq!(
            FolderTrustStore::load_with_home(&config, Some(home.clone())).check(&project),
            FolderTrust::Unknown
        );
        assert_eq!(store.check(&home), FolderTrust::Trusted);
        store.trust(&project).unwrap();
        assert_eq!(store.check(&project), FolderTrust::Trusted);
        store.revoke(&home).unwrap();
        assert_eq!(
            FolderTrustStore::load_with_home(&config, Some(home.clone())).check(&home),
            FolderTrust::Unknown
        );
        std::fs::write(config.join("trusted-folders.json"), "invalid").unwrap();
        assert_eq!(
            FolderTrustStore::load_with_home(&config, Some(home)).check(&project),
            FolderTrust::Unknown
        );
    }

    #[cfg(unix)]
    #[test]
    fn home_default_does_not_follow_links_outside_home() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, home.join("link")).unwrap();
        let store = FolderTrustStore::load_with_home(tmp.path(), Some(home.clone()));
        assert_eq!(store.check(&home.join("link")), FolderTrust::Unknown);
        assert_eq!(
            store.check(&home.join("link/missing")),
            FolderTrust::Unknown
        );
    }

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
