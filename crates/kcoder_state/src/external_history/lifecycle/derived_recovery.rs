//! A completed cache may only roll back to its original sealed bytes.
use super::*;
use kcoder_config::VerifiedPortableEntry;

#[cfg(all(test, any(target_os = "linux", windows)))]
#[path = "derived_recovery_crash_tests.rs"]
mod crash_tests;

pub(crate) struct SealedCacheRecovery {
    seal: gc::Manifest,
    database: gc::Leaf,
    journal: VerifiedPortableEntry,
}

impl ArchiveReadGuard {
    pub(crate) fn sealed_cache_recovery(
        &self,
        name: &str,
        directory: &PrivateDirectory,
    ) -> Result<Option<SealedCacheRecovery>> {
        if !self.is_managed() {
            return Ok(None);
        }
        let identity = match directory
            .portable_retention_regular_identity(OsStr::new("catalog.sqlite3-journal"))
        {
            Ok(identity) => identity,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let journal = directory
            .portable_open_verified_regular(OsStr::new("catalog.sqlite3-journal"), &identity)?;
        let store = self.store()?;
        let catalog = Catalog::open_readonly(&store.directory)?
            .context("external_history_lifecycle_missing")?;
        let seal = catalog
            .cache_birth(self, name, directory)?
            .context("external_history_derived_ownership_unknown")?;
        let database = seal
            .leaves
            .iter()
            .find(|leaf| leaf.name == "catalog.sqlite3")
            .context("external_history_derived_incomplete")?
            .clone();
        // The damaged database is still the original object. Every other sealed
        // leaf must remain intact; no additional filename is adopted as owned.
        let mut check = || true;
        seal.verify_remaining_with_children(
            directory,
            &["catalog.sqlite3".into()],
            &["catalog.sqlite3-journal".into()],
            &mut check,
        )?;
        directory
            .portable_open_verified_regular(OsStr::new("catalog.sqlite3"), &database.identity)?;
        Ok(Some(SealedCacheRecovery {
            seal,
            database,
            journal,
        }))
    }
}

impl SealedCacheRecovery {
    pub(crate) fn database_bytes(&self) -> u64 {
        self.database.bytes
    }

    pub(crate) fn verify_file(
        &self,
        directory: &PrivateDirectory,
        name: &str,
        file: &std::fs::File,
    ) -> Result<()> {
        let expected = match name {
            "catalog.sqlite3" => &self.database.identity,
            "catalog.sqlite3-journal" => self.journal.identity(),
            _ => anyhow::bail!("history_projection_recovery_file_denied"),
        };
        ensure!(
            directory.portable_retention_regular_handle_identity(file)? == *expected
                && directory.portable_retention_regular_identity(OsStr::new(name))? == *expected,
            "history_projection_recovery_file_changed"
        );
        Ok(())
    }

    pub(crate) fn verify_restored(&self, directory: &PrivateDirectory) -> Result<()> {
        // A rollback is not accepted merely because SQLite opened successfully.
        // Its complete original identity, length and sealed digest must match.
        self.seal.verify_remaining(directory, &[], &mut || true)
    }
}
