//! Only State's registered historical owners contribute bindings. Unknown files
//! remain the copy coordinator's responsibility and never become retention proof.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

pub(crate) struct OwnerGraph {
    entries: BTreeMap<Vec<String>, (PrivateDirectory, BTreeSet<String>, bool)>,
    directory_references: BTreeSet<Vec<String>>,
    file_references: BTreeSet<(Vec<String>, String)>,
}

impl OwnerGraph {
    pub(super) fn new() -> Self {
        Self {
            entries: BTreeMap::new(),
            directory_references: BTreeSet::new(),
            file_references: BTreeSet::new(),
        }
    }

    /// An immutable owner record names this exact current object. Copying an
    /// object alone never contributes a reference or new deletion authority.
    pub(crate) fn retain_current_directory(&mut self, path: &[String]) {
        self.directory_references.insert(path.to_vec());
    }

    pub(crate) fn retain_current_file(&mut self, path: &[String], name: &str) {
        self.file_references.insert((path.to_vec(), name.into()));
    }

    /// Register only an existing directory already selected by its domain owner.
    /// Every listed file is optional here; required records are checked by that owner.
    pub(crate) fn add_directory(
        &mut self,
        path: Vec<String>,
        directory: &PrivateDirectory,
        files: impl IntoIterator<Item = String>,
    ) -> Result<()> {
        ensure!(
            !path.is_empty()
                && path.len() <= 32
                && path.iter().all(|name| !name.is_empty()
                    && name.len() <= 256
                    && !matches!(name.as_str(), "." | "..")
                    && !name.contains(['/', '\\'])),
            "HISTORY_RELOCATION_PATH_INVALID"
        );
        ensure!(
            self.entries.len() < MAX_DIRECTORIES,
            "HISTORY_RELOCATION_DIRECTORY_LIMIT"
        );
        let entry = self.entries.entry(path).or_insert((
            directory.duplicate_handle()?,
            BTreeSet::new(),
            true,
        ));
        ensure!(
            entry.0.directory_identity()? == directory.directory_identity()?,
            "HISTORY_RELOCATION_SOURCE_CHANGED"
        );
        entry.1.extend(files);
        entry.2 = true;
        ensure!(entry.1.len() <= MAX_FILES, "HISTORY_RELOCATION_FILE_LIMIT");
        Ok(())
    }

    /// A bare mutation lock still participates in actual lock/path checks, but
    /// has no persistent business identity requiring a relocation record.
    pub(crate) fn add_runtime_lock(
        &mut self,
        path: &[String],
        directory: &PrivateDirectory,
        name: &str,
    ) -> Result<()> {
        let mapping_required = self.entries.get(path).is_some_and(|entry| entry.2);
        self.add(path, directory, &[name])?;
        self.entries.get_mut(path).unwrap().2 = mapping_required;
        Ok(())
    }

    pub(crate) fn add(
        &mut self,
        path: &[String],
        directory: &PrivateDirectory,
        files: &[&str],
    ) -> Result<()> {
        self.add_directory(
            path.to_vec(),
            directory,
            files.iter().map(|name| (*name).into()),
        )
    }

    fn finish(self, profile_identity: &str, profile_path: &Path) -> Result<Vec<HeldDirectory>> {
        let mut records = self
            .entries
            .iter()
            .map(|(path, (directory, _, _))| Ok((path.clone(), read_record(directory)?)))
            .collect::<Result<BTreeMap<_, _>>>()?;
        let mut children: BTreeMap<Vec<String>, Vec<ChildSnapshot>> = BTreeMap::new();
        let mut inherited = BTreeMap::new();
        for (path, (directory, _, mapping_required)) in &self.entries {
            if path.len() <= 1 || !mapping_required {
                continue;
            }
            let mut parent = path.clone();
            let name = parent.pop().context("HISTORY_RELOCATION_PATH_INVALID")?;
            if !self.entries.contains_key(&parent) {
                continue;
            }
            let identity = observed_directory_identity(directory)?;
            let prior = records.get(path).and_then(Option::as_ref);
            let parent_record = records.get(&parent).and_then(Option::as_ref);
            let parent_binding = parent_record.and_then(|record| {
                record
                    .value
                    .children
                    .iter()
                    .find(|child| child.target == identity)
            });
            // A confirmed empty-directory removal can lose its own sidecar
            // before rmdir. Only the parent's original actual child ID carries
            // that known object's aliases across this gap and a later move.
            // A move changes placement, not the immutable facts still referenced
            // by this owner. Intermediate copies are never new source authority.
            let mut aliases = prior.map_or_else(
                || {
                    parent_binding
                        .map_or_else(|| vec![identity.clone()], |child| child.recorded.clone())
                },
                |record| record.value.source.retention_aliases.clone(),
            );
            let directory_identity = directory.directory_identity()?;
            let mut directory_aliases = prior.map_or_else(
                || {
                    parent_binding.map_or_else(
                        || vec![directory_identity.clone()],
                        |child| child.recorded_strings.clone(),
                    )
                },
                |record| record.value.source.directory_aliases.clone(),
            );
            if self.directory_references.contains(path) {
                if !aliases.contains(&identity) {
                    aliases.push(identity.clone());
                }
                if !directory_aliases.contains(&directory_identity) {
                    directory_aliases.push(directory_identity);
                }
            }
            let child = ChildSnapshot {
                name,
                identity,
                aliases,
                directory_aliases,
            };
            inherited.insert(path.clone(), child.clone());
            children.entry(parent).or_default().push(child);
        }
        let mut result = Vec::new();
        for (path, (directory, names, mapping_required)) in self.entries {
            // Owners validate their own directory policy before registration;
            // ordinary history parents retain their inherited modes.
            directory.verify_config_root_directory()?;
            let prior = records.remove(&path).flatten();
            let inherited = inherited.remove(&path);
            ensure!(
                prior
                    .as_ref()
                    .is_none_or(|record| record.value.target_profile == profile_identity),
                "HISTORY_RELOCATION_PROFILE_CHANGED"
            );
            let identity = directory.directory_identity()?;
            let mut directory_aliases = prior.as_ref().map_or_else(
                || {
                    inherited.as_ref().map_or_else(
                        || vec![identity.clone()],
                        |child| child.directory_aliases.clone(),
                    )
                },
                |record| record.value.source.directory_aliases.clone(),
            );
            if self.directory_references.contains(&path) && !directory_aliases.contains(&identity) {
                directory_aliases.push(identity.clone());
            }
            ensure!(
                directory_aliases.len() <= MAX_ALIASES,
                "HISTORY_RELOCATION_ALIAS_LIMIT"
            );
            let retention_identity = observed_directory_identity(&directory)?;
            let mut retention_aliases = prior.as_ref().map_or_else(
                || {
                    inherited.as_ref().map_or_else(
                        || vec![retention_identity.clone()],
                        |child| child.aliases.clone(),
                    )
                },
                |record| record.value.source.retention_aliases.clone(),
            );
            if self.directory_references.contains(&path)
                && !retention_aliases.contains(&retention_identity)
            {
                retention_aliases.push(retention_identity.clone());
            }
            ensure!(
                retention_aliases.len() <= MAX_ALIASES,
                "HISTORY_RELOCATION_ALIAS_LIMIT"
            );
            let mut files = Vec::new();
            let mut absent = Vec::new();
            let mut locks = Vec::new();
            for name in names {
                match directory.open_single_link_regular_file(OsStr::new(&name)) {
                    Ok(_) => (),
                    Err(error) if missing(&error) => {
                        absent.push(name);
                        continue;
                    }
                    Err(error) => return Err(error),
                }
                let (file_identity, bytes, sha256) = fingerprint(&directory, &name)?;
                let mut aliases = prior
                    .as_ref()
                    .and_then(|record| {
                        record
                            .value
                            .files
                            .iter()
                            .find(|file| file.target == file_identity)
                    })
                    .map_or_else(|| vec![file_identity.clone()], |file| file.recorded.clone());
                let string_identity = crate::historical_undo::manifest::identity(
                    &directory.open_single_link_regular_file(OsStr::new(&name))?,
                )?;
                let mut string_aliases = prior
                    .as_ref()
                    .and_then(|record| {
                        record
                            .value
                            .files
                            .iter()
                            .find(|file| file.target == file_identity)
                    })
                    .map_or_else(
                        || vec![string_identity.clone()],
                        |file| file.recorded_strings.clone(),
                    );
                if self.file_references.contains(&(path.clone(), name.clone())) {
                    if !aliases.contains(&file_identity) {
                        aliases.push(file_identity.clone());
                    }
                    if !string_aliases.contains(&string_identity) {
                        string_aliases.push(string_identity);
                    }
                }
                ensure!(
                    aliases.len() <= MAX_ALIASES,
                    "HISTORY_RELOCATION_ALIAS_LIMIT"
                );
                ensure!(
                    string_aliases.len() <= MAX_ALIASES,
                    "HISTORY_RELOCATION_ALIAS_LIMIT"
                );
                if name.ends_with(".lock") || name.ends_with(".lease") {
                    locks.push(
                        directory
                            .try_existing_config_root_lock(
                                OsStr::new(&name),
                                &file_identity,
                                PrivateLeaseMode::Exclusive,
                            )?
                            .context("HISTORY_RELOCATION_OWNER_BUSY")?,
                    );
                }
                files.push(FileSnapshot {
                    name,
                    identity: file_identity,
                    aliases,
                    string_aliases,
                    bytes,
                    sha256,
                });
            }
            let owner_seed = prior.as_ref().map_or_else(
                || {
                    directory_aliases
                        .first()
                        .cloned()
                        .unwrap_or(identity.clone())
                },
                |record| record.value.source.owner_seed.clone(),
            );
            let snapshot = DirectorySnapshot {
                children: children.remove(&path).unwrap_or_default(),
                scope_path: prior.as_ref().map_or_else(
                    || {
                        let path = path
                            .iter()
                            .fold(profile_path.to_path_buf(), |base, name| base.join(name));
                        dunce::simplified(&path).to_string_lossy().into_owned()
                    },
                    |record| record.value.source.scope_path.clone(),
                ),
                path,
                identity: identity.clone(),
                directory_aliases,
                owner_seed,
                owner_profile: prior.as_ref().map_or_else(
                    || profile_identity.to_owned(),
                    |record| record.value.source.owner_profile.clone(),
                ),
                retention_identity,
                retention_aliases,
                files,
                prior_record: prior
                    .as_ref()
                    .map(|record| (record.value.record_identity.clone(), hash(&record.bytes))),
            };
            ensure!(
                serde_json::to_vec(&snapshot)?
                    .len()
                    .checked_mul(3)
                    .and_then(|bytes| bytes.checked_add(4096))
                    .is_some_and(|bytes| bytes as u64 <= MAX_RECORD),
                "HISTORY_RELOCATION_METADATA_LIMIT"
            );
            result.push(HeldDirectory {
                mapping_required,
                snapshot,
                directory,
                _locks: locks,
                _record: prior,
                _absent: absent,
            });
        }
        Ok(result)
    }
}

pub(super) fn collect(
    profile: &PrivateDirectory,
    profile_path: &Path,
) -> Result<Vec<HeldDirectory>> {
    let mut graph = OwnerGraph::new();
    crate::external_history::relocation::collect(profile, &mut graph)?;
    crate::historical_contexts::relocation::collect(profile, &mut graph)?;
    super::journal::collect(profile, profile_path, &mut graph)?;
    let canonical = dunce::canonicalize(profile_path)?;
    ensure!(
        PrivateDirectory::open_existing(&canonical)?.directory_identity()?
            == profile.directory_identity()?,
        "HISTORY_RELOCATION_PROFILE_CHANGED"
    );
    graph.finish(&profile.directory_identity()?, &canonical)
}
