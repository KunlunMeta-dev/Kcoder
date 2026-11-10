//! Clone keeps the same verified native lock alive; no clone reopens a path or creates a file.
use super::model::*;
use anyhow::{Context, Result, ensure};
use kcoder_config::PortableLeaseIdentity;
use kcoder_config::{PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease};
use serde::{Deserialize, Serialize};
use std::{ffi::OsStr, sync::Arc};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ArchiveHeader {
    pub version: u8,
    pub scope: String,
    pub archive: String,
    pub generation: String,
    pub directory: Option<String>,
    pub lease: PortableLeaseIdentity,
}
impl ArchiveHeader {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.version == VERSION,
            "external_history_lifecycle_unknown_epoch"
        );
        digest(&self.scope)?;
        archive_id(&self.archive)?;
        ensure!(
            uuid::Uuid::parse_str(&self.generation)
                .is_ok_and(|id| id.to_string() == self.generation),
            "external_history_lifecycle_changed"
        );
        Ok(())
    }
}
struct Guard {
    _lease: VerifiedPrivateLease,
    scope: String,
    archive: String,
    generation: String,
    directory: String,
    store: Option<PrivateDirectory>,
}

/// A managed reader and all its record/projection/blob descendants retain one shared lease.
/// Legacy guards remain readable but never establish eligibility for content collection.
#[derive(Clone)]
pub struct ArchiveReadGuard {
    inner: Option<Arc<Guard>>,
    pub(in crate::external_history) require_budget: bool,
    pub(in crate::external_history) budget: Option<Arc<super::resource_budget::BudgetReader>>,
}
impl ArchiveReadGuard {
    /// Compare admitted native generations without disclosing their private identity.
    /// Legacy guards never prove managed read protection.
    pub fn same_generation(&self, other: &Self) -> bool {
        match (&self.inner, &other.inner) {
            (Some(left), Some(right)) => {
                left.scope == right.scope
                    && left.archive == right.archive
                    && left.generation == right.generation
                    && left.directory == right.directory
                    && left._lease.identity() == right._lease.identity()
            }
            _ => false,
        }
    }
    pub fn is_managed(&self) -> bool {
        self.inner.is_some()
    }
    pub(crate) fn legacy() -> Self {
        Self {
            inner: None,
            require_budget: false,
            budget: None,
        }
    }
    pub(super) fn open(control: &PrivateDirectory, header: &ArchiveHeader) -> Result<Self> {
        header.validate()?;
        let directory = header
            .directory
            .as_ref()
            .context("external_history_lifecycle_not_committed")?;
        let lease = control
            .try_existing_portable_lock(
                OsStr::new("lease.lock"),
                &header.lease,
                PrivateLeaseMode::Shared,
            )?
            .context("external_history_lifecycle_busy")?;
        Ok(Self {
            require_budget: false,
            budget: None,
            inner: Some(Arc::new(Guard {
                _lease: lease,
                scope: header.scope.clone(),
                archive: header.archive.clone(),
                generation: header.generation.clone(),
                directory: directory.clone(),
                store: None,
            })),
        })
    }
    pub(super) fn with_store(mut self, store: PrivateDirectory) -> Result<Self> {
        let guard = self
            .inner
            .as_mut()
            .and_then(Arc::get_mut)
            .context("external_history_lifecycle_changed")?;
        guard.store = Some(store);
        Ok(self)
    }
    pub(super) fn store(&self) -> Result<crate::external_history::ExternalHistoryStore> {
        let directory = self
            .inner
            .as_ref()
            .and_then(|guard| guard.store.as_ref())
            .context("external_history_lifecycle_changed")?
            .duplicate_handle()?;
        Ok(crate::external_history::ExternalHistoryStore { directory })
    }
    pub(super) fn binding(&self, scope: &str) -> Result<(&str, &str, &str)> {
        let inner = self
            .inner
            .as_ref()
            .context("external_history_lifecycle_legacy_retained")?;
        ensure!(
            inner.scope == scope,
            "external_history_lifecycle_wrong_scope"
        );
        Ok((&inner.archive, &inner.generation, &inner.directory))
    }
    pub(crate) fn assert_directory(
        &self,
        scope: &str,
        archive: &str,
        directory: &PrivateDirectory,
    ) -> Result<()> {
        let (actual, _, identity) = self.binding(scope)?;
        ensure!(
            actual == archive && directory.directory_identity()? == identity,
            "external_history_lifecycle_changed"
        );
        Ok(())
    }
}

pub(super) fn exclusive(
    control: &PrivateDirectory,
    header: &ArchiveHeader,
) -> Result<VerifiedPrivateLease> {
    header.validate()?;
    control
        .try_existing_portable_lock(
            OsStr::new("lease.lock"),
            &header.lease,
            PrivateLeaseMode::Exclusive,
        )?
        .context("external_history_lifecycle_busy")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owned() -> (tempfile::TempDir, PrivateDirectory, ArchiveHeader) {
        let root = tempfile::tempdir().unwrap();
        let directory = PrivateDirectory::open_or_create(root.path()).unwrap();
        drop(
            directory
                .try_exclusive_lock(OsStr::new("lease.lock"))
                .unwrap()
                .unwrap(),
        );
        let header = ArchiveHeader {
            version: VERSION,
            scope: "a".repeat(64),
            archive: format!("archive-{}", "b".repeat(64)),
            generation: uuid::Uuid::new_v4().to_string(),
            directory: Some(directory.directory_identity().unwrap()),
            lease: directory
                .portable_regular_identity(OsStr::new("lease.lock"))
                .unwrap(),
        };
        (root, directory, header)
    }
    #[test]
    fn a_clone_keeps_its_original_verified_read_lease_until_the_last_descendant_closes() {
        let (_root, directory, header) = owned();
        let guard = ArchiveReadGuard::open(&directory, &header).unwrap();
        let descendant = guard.clone();
        drop(guard);
        assert!(exclusive(&directory, &header).is_err());
        descendant
            .assert_directory(&header.scope, &header.archive, &directory)
            .unwrap();
        drop(descendant);
        assert!(exclusive(&directory, &header).is_ok());
    }
    #[test]
    fn observing_a_missing_or_replaced_lease_never_recreates_it_or_claims_an_owner() {
        let (root, directory, header) = owned();
        std::fs::rename(
            root.path().join("lease.lock"),
            root.path().join("saved.lock"),
        )
        .unwrap();
        assert!(ArchiveReadGuard::open(&directory, &header).is_err());
        assert!(!root.path().join("lease.lock").exists());
        std::fs::write(root.path().join("lease.lock"), "replacement").unwrap();
        assert!(ArchiveReadGuard::open(&directory, &header).is_err());
        assert_eq!(
            std::fs::read_to_string(root.path().join("lease.lock")).unwrap(),
            "replacement"
        );
    }
    #[test]
    fn a_legacy_or_foreign_scope_guard_cannot_authorize_managed_retirement() {
        assert!(!ArchiveReadGuard::legacy().is_managed());
        assert!(ArchiveReadGuard::legacy().binding(&"a".repeat(64)).is_err());
        let (_root, directory, header) = owned();
        let guard = ArchiveReadGuard::open(&directory, &header).unwrap();
        assert!(guard.binding(&"c".repeat(64)).is_err());
        let other = tempfile::tempdir().unwrap();
        assert!(
            guard
                .assert_directory(
                    &header.scope,
                    &header.archive,
                    &PrivateDirectory::open_existing(other.path()).unwrap()
                )
                .is_err()
        );
    }
}
