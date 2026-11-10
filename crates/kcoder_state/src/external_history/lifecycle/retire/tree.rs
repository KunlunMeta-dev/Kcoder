//! A bounded tree contains only directories born and sealed by the original native producers.
use super::*;
use std::collections::BTreeMap;
impl Archive {
    pub(in crate::external_history::lifecycle) fn collection_entries(
        &self,
    ) -> Result<BTreeMap<String, u64>> {
        let manifest = self
            .baseline
            .as_ref()
            .context("external_history_lifecycle_unsealed_retained")?;
        let mut entries = BTreeMap::new();
        for leaf in &manifest.leaves {
            entries.insert(leaf.name.clone(), leaf.bytes);
        }
        for (name, derived) in &self.derived {
            ensure!(derived.published, "external_history_derived_incomplete");
            let seal = derived
                .seal
                .as_ref()
                .context("external_history_lifecycle_unsealed_retained")?;
            seal.validate()?;
            for leaf in &seal.leaves {
                entries.insert(format!("{name}/{}", leaf.name), leaf.bytes);
            }
            entries.insert(format!("{name}/"), 0);
        }
        Ok(entries)
    }
}
impl Collection {
    pub(super) fn verify_tree(
        &mut self,
        directory: &PrivateDirectory,
        removed: &[String],
        external: &mut impl FnMut() -> bool,
    ) -> Result<()> {
        let archive = self.archive.clone();
        let manifest = self.manifest.clone();
        let mut children = archive
            .derived
            .keys()
            .filter(|name| !removed.contains(&format!("{name}/")))
            .cloned()
            .collect::<Vec<_>>();
        children.extend(self.payload_roots()?);
        let cache_children = children
            .iter()
            .filter(|name| archive.derived.contains_key(*name))
            .cloned()
            .collect::<Vec<_>>();
        let mut control_error = None;
        let mut check = || match self.check(external, false) {
            Ok(()) => true,
            Err(error) => {
                control_error = Some(error);
                false
            }
        };
        let result = (|| {
            manifest.verify_remaining_with_children(directory, removed, &children, &mut check)?;
            for name in &cache_children {
                let derived = &archive.derived[name];
                let seal = derived
                    .seal
                    .as_ref()
                    .context("external_history_lifecycle_unsealed_retained")?;
                let child =
                    directory.portable_open_verified_child(OsStr::new(name), &seal.directory)?;
                ensure!(
                    child.directory_identity()? == derived.directory,
                    "external_history_derived_changed"
                );
                let prefix = format!("{name}/");
                let removed_leaves = removed
                    .iter()
                    .filter_map(|value| value.strip_prefix(&prefix).map(str::to_owned))
                    .collect::<Vec<_>>();
                seal.verify_remaining(&child, &removed_leaves, &mut check)?;
            }
            Ok(())
        })();
        if let Some(error) = control_error {
            return Err(error);
        }
        result
    }
    fn claim_pending(&self, name: &str) -> Result<()> {
        let mut catalog = self.catalogue()?;
        let record = catalog
            .document
            .retirements
            .get_mut(&self.operation)
            .unwrap();
        ensure!(
            record
                .pending
                .as_deref()
                .is_none_or(|pending| pending == name),
            "external_history_lifecycle_changed"
        );
        record.pending = Some(name.into());
        bump(record)?;
        catalog.save()
    }
    pub(super) fn reconcile_pending(
        &self,
        directory: &PrivateDirectory,
        record: &Retirement,
    ) -> Result<()> {
        let Some(pending) = &record.pending else {
            return Ok(());
        };
        let exists = if let Some(name) = pending.strip_suffix('/') {
            let derived = self
                .archive
                .derived
                .get(name)
                .context("external_history_lifecycle_changed")?;
            let seal = derived
                .seal
                .as_ref()
                .context("external_history_lifecycle_unsealed_retained")?;
            directory
                .portable_open_verified_child(OsStr::new(name), &seal.directory)
                .map(|_| ())
        } else if let Some((name, leaf)) = pending.split_once('/') {
            let derived = self
                .archive
                .derived
                .get(name)
                .context("external_history_lifecycle_changed")?;
            let seal = derived
                .seal
                .as_ref()
                .context("external_history_lifecycle_unsealed_retained")?;
            let child =
                directory.portable_open_verified_child(OsStr::new(name), &seal.directory)?;
            child
                .open_single_link_regular_file(OsStr::new(leaf))
                .map(|_| ())
        } else {
            directory
                .open_single_link_regular_file(OsStr::new(pending))
                .map(|_| ())
        };
        match exists {
            Ok(()) => Ok(()),
            Err(error) if missing(&error) => self.removed(pending),
            Err(error) => Err(error),
        }
    }
    fn collect_leaves(
        &mut self,
        directory: &PrivateDirectory,
        prefix: &str,
        manifest: &gc::Manifest,
        external: &mut impl FnMut() -> bool,
    ) -> Result<()> {
        for leaf in &manifest.leaves {
            let path = format!("{prefix}{}", leaf.name);
            if self
                .catalogue()?
                .retirement(&self.operation)?
                .removed
                .contains(&path)
            {
                continue;
            }
            self.check(external, true)?;
            self.claim_pending(&path)?;
            let result = directory
                .portable_remove_verified_regular_leaf(OsStr::new(&leaf.name), &leaf.identity)?;
            if result
                .removed
                .iter()
                .any(|name| name == OsStr::new(&leaf.name))
            {
                self.removed(&path)?;
            }
            if let Some(error) = result.failure {
                return Err(error);
            }
        }
        Ok(())
    }
    pub(super) fn collect_tree(
        &mut self,
        directory: &PrivateDirectory,
        external: &mut impl FnMut() -> bool,
    ) -> Result<()> {
        let derived = self.archive.derived.clone();
        for (name, derived) in &derived {
            let marker = format!("{name}/");
            if self
                .catalogue()?
                .retirement(&self.operation)?
                .removed
                .contains(&marker)
            {
                continue;
            }
            let seal = derived
                .seal
                .as_ref()
                .context("external_history_lifecycle_unsealed_retained")?;
            let child =
                directory.portable_open_verified_child(OsStr::new(name), &seal.directory)?;
            self.collect_leaves(&child, &marker, seal, external)?;
            self.check(external, true)?;
            self.claim_pending(&marker)?;
            directory
                .portable_remove_verified_empty_directory(OsStr::new(name), &seal.directory)?;
            self.removed(&marker)?;
        }
        let manifest = self.manifest.clone();
        self.collect_leaves(directory, "", &manifest, external)
    }
}
