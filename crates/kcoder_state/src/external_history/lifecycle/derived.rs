//! Managed cache directories publish only after their actual birth identity is journaled.
use super::*;
use crate::external_history::{ExternalHistoryReader, ExternalHistoryStore};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Derived {
    pub name: String,
    pub directory: String,
    pub staging: String,
    pub published: bool,
    pub seal: Option<gc::Manifest>,
}
impl Derived {
    pub fn validate(&self) -> Result<()> {
        valid_name(&self.name)?;
        ensure!(
            self.staging.strip_prefix("cache-birth-").is_some_and(
                |id| uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id)
            ) && !self.directory.is_empty()
                && self.directory.len() <= 256,
            "external_history_derived_changed"
        );
        if let Some(seal) = &self.seal {
            seal.validate()?;
        }
        Ok(())
    }
}
fn valid_name(name: &str) -> Result<()> {
    ensure!(
        ["normalized-", "tool-links-"]
            .iter()
            .any(|prefix| name
                .strip_prefix(prefix)
                .is_some_and(|suffix| suffix.len() == 64
                    && suffix
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))),
        "external_history_derived_invalid_name"
    );
    Ok(())
}
impl Catalog<'_> {
    fn selected_archive(&self, guard: &ArchiveReadGuard) -> Result<&Archive> {
        let (id, generation, directory) = guard.binding(&self.document.scope)?;
        let archive = self
            .document
            .archives
            .get(id)
            .context("external_history_lifecycle_changed")?;
        ensure!(
            archive.generation == generation
                && archive.directory.as_deref() == Some(directory)
                && archive.phase == ArchivePhase::Active,
            "external_history_lifecycle_changed"
        );
        Ok(archive)
    }
    fn cache_directory(
        &mut self,
        guard: &ArchiveReadGuard,
        raw: &PrivateDirectory,
        name: &str,
    ) -> Result<PrivateDirectory> {
        self.ensure_writer()?;
        valid_name(name)?;
        let archive = self.selected_archive(guard)?;
        let id = archive.id.clone();
        guard.assert_directory(&self.document.scope, &id, raw)?;
        let mut record = archive.derived.get(name).cloned();
        if record.is_none() {
            ensure!(
                archive.derived.len() < 64,
                "external_history_derived_count_budget_exceeded"
            );
            match raw.open_child(OsStr::new(name), false) {
                Err(error) if missing(&error) => {}
                Err(error) => return Err(error),
                Ok(_) => anyhow::bail!("external_history_derived_ownership_unknown"),
            }
            let staging = format!("cache-birth-{}", uuid::Uuid::new_v4());
            let directory = raw.create_private_child(OsStr::new(&staging))?;
            let born = Derived {
                name: name.into(),
                directory: directory.directory_identity()?,
                staging,
                published: false,
                seal: None,
            };
            self.document
                .archives
                .get_mut(&id)
                .unwrap()
                .derived
                .insert(name.into(), born.clone());
            self.save()?;
            record = Some(born);
        }
        let record = record.unwrap();
        record.validate()?;
        let directory = match raw.open_child(OsStr::new(name), false) {
            Ok(directory) => directory,
            Err(error) if missing(&error) && !record.published => {
                let staged = raw.open_child(OsStr::new(&record.staging), false)?;
                ensure!(
                    staged.directory_identity()? == record.directory,
                    "external_history_derived_changed"
                );
                raw.rename_no_replace(OsStr::new(&record.staging), OsStr::new(name))?;
                staged
            }
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        ensure!(
            directory.directory_identity()? == record.directory,
            "external_history_derived_changed"
        );
        if !record.published {
            self.document
                .archives
                .get_mut(&id)
                .unwrap()
                .derived
                .get_mut(name)
                .unwrap()
                .published = true;
            self.save()?;
        }
        Ok(directory)
    }
    pub(super) fn cache_birth(
        &self,
        guard: &ArchiveReadGuard,
        name: &str,
        directory: &PrivateDirectory,
    ) -> Result<Option<gc::Manifest>> {
        valid_name(name)?;
        let archive = self.selected_archive(guard)?;
        let record = archive
            .derived
            .get(name)
            .context("external_history_derived_ownership_unknown")?;
        ensure!(
            record.published && record.directory == directory.directory_identity()?,
            "external_history_derived_changed"
        );
        Ok(record.seal.clone())
    }
    #[cfg(any(target_os = "linux", windows))]
    fn seal_cache(
        &mut self,
        guard: &ArchiveReadGuard,
        name: &str,
        directory: &PrivateDirectory,
        seal: gc::Manifest,
    ) -> Result<()> {
        self.ensure_writer()?;
        if let Some(previous) = self.cache_birth(guard, name, directory)? {
            ensure!(
                hash(&previous)? == hash(&seal)?,
                "external_history_derived_changed"
            );
            return Ok(());
        }
        let (id, _, _) = guard.binding(&self.document.scope)?;
        self.document
            .archives
            .get_mut(id)
            .unwrap()
            .derived
            .get_mut(name)
            .unwrap()
            .seal = Some(seal);
        self.save()
    }
}
impl ExternalHistoryReader {
    pub(crate) fn cache_directory(
        &self,
        name: &str,
        writable: bool,
    ) -> Result<Option<PrivateDirectory>> {
        if !writable || !self.lifecycle.is_managed() {
            return match self.directory.open_child(OsStr::new(name), writable) {
                Ok(directory) => Ok(Some(directory)),
                Err(error) if !writable && missing(&error) => Ok(None),
                Err(error) => Err(error),
            };
        }
        let store = self.lifecycle.store()?;
        let mut catalog = Catalog::open(&store.directory, false)?
            .context("external_history_lifecycle_missing")?;
        Ok(Some(catalog.cache_directory(
            &self.lifecycle,
            &self.directory,
            name,
        )?))
    }
}
impl ArchiveReadGuard {
    pub(crate) fn seal_cache(
        &self,
        name: &str,
        directory: &PrivateDirectory,
        mut check: impl FnMut() -> bool,
    ) -> Result<()> {
        if !self.is_managed() {
            return Ok(());
        }
        let store: ExternalHistoryStore = self.store()?;
        if Catalog::open_readonly(&store.directory)?
            .context("external_history_lifecycle_missing")?
            .cache_birth(self, name, directory)?
            .is_some()
        {
            return Ok(());
        }
        #[cfg(any(target_os = "linux", windows))]
        {
            // The producer's writer and this original read guard remain alive while hashing.
            // The global catalogue is released before any body byte or user callback is read.
            let seal = gc::Manifest::capture_cache(directory, &mut check)?;
            Catalog::open(&store.directory, false)?
                .context("external_history_lifecycle_missing")?
                .seal_cache(self, name, directory, seal)
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        {
            ensure!(check(), "external_history_lifecycle_cancelled");
            Ok(())
        }
    }
}
#[cfg(all(test, any(target_os = "linux", windows)))]
pub(super) mod tests;
