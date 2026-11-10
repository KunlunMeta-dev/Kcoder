//! Handle-relative template IO under one profile-owned coordinator.
use super::*;
use crate::PrivateDirectory;
use std::{ffi::OsStr, fs::File, io::Read};
pub(super) const INDEX_LIMIT: u64 = 1024 * 1024;
pub(super) const MAX_TEMPLATES: usize = 256;

pub(super) fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|error| {
        error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}
impl SettingsTemplateStore {
    pub(super) fn guard(&self) -> Result<File> {
        let current = PrivateDirectory::open_existing(&self.config_dir)?;
        anyhow::ensure!(
            current.directory_identity()? == self.directory.directory_identity()?,
            "settings_template_profile_changed"
        );
        // A short lease handoff (including fork/exec descriptor inheritance) is not a failed mutation.
        let started = std::time::Instant::now();
        let guard = loop {
            if let Some(guard) = self
                .directory
                .try_exclusive_lock(OsStr::new(".settings-templates.lock"))?
            {
                break guard;
            }
            anyhow::ensure!(
                started.elapsed() < std::time::Duration::from_millis(100),
                "settings_template_busy"
            );
            std::thread::sleep(std::time::Duration::from_millis(2));
        };
        anyhow::ensure!(
            PrivateDirectory::open_existing(&self.config_dir)?.directory_identity()?
                == self.directory.directory_identity()?,
            "settings_template_profile_changed"
        );
        self.recover()?;
        Ok(guard)
    }
    pub(super) fn directory(&self, create: bool) -> Result<Option<PrivateDirectory>> {
        let directory = match self.directory.open_child(OsStr::new("templates"), false) {
            Ok(directory) => directory,
            Err(error) if missing(&error) && !create => return Ok(None),
            Err(error) if missing(&error) => self
                .directory
                .create_private_child(OsStr::new("templates"))?,
            Err(error) => return Err(error),
        };
        directory.verify_trusted_config_directory()?;
        Ok(Some(directory))
    }
    pub(super) fn read_file(&self, name: &str, limit: u64) -> Result<Option<Vec<u8>>> {
        let Some(directory) = self.directory(false)? else {
            return Ok(None);
        };
        let mut file = match directory.open_single_link_regular_file(OsStr::new(name)) {
            Ok(file) => file,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        anyhow::ensure!(
            file.metadata()?.len() <= limit,
            "settings_template_read_budget_exceeded"
        );
        let before = PrivateDirectory::identity_of_file(&file)?;
        let mut bytes = Vec::new();
        (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
        anyhow::ensure!(
            bytes.len() as u64 <= limit
                && before == PrivateDirectory::identity_of_file(&file)?
                && before == directory.regular_file_identity(OsStr::new(name))?,
            "settings_template_file_changed"
        );
        Ok(Some(bytes))
    }
    pub(super) fn read_index(&self) -> Result<TemplateIndex> {
        let Some(bytes) = self.read_file(INDEX_FILE, INDEX_LIMIT)? else {
            return Ok(Default::default());
        };
        let index: TemplateIndex = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("settings_template_invalid_index"))?;
        check_index(&index)?;
        Ok(index)
    }
    pub(super) fn write_index(&self, index: &TemplateIndex) -> Result<()> {
        check_index(index)?;
        self.write_file(INDEX_FILE, &serde_json::to_vec_pretty(index)?)
    }
    pub(super) fn write_file(&self, name: &str, bytes: &[u8]) -> Result<()> {
        self.directory(true)?
            .unwrap()
            .atomic_replace(OsStr::new(name), bytes)
    }
    pub(super) fn read_template_bytes(&self, id: &str) -> Result<Vec<u8>> {
        validate_id(id)?;
        self.read_file(&format!("{id}.jsonc"), MAX_TEMPLATE_BYTES as u64)?
            .ok_or_else(|| anyhow::anyhow!("unknown settings template: {id}"))
    }
}
pub(super) fn check_index(index: &TemplateIndex) -> Result<()> {
    anyhow::ensure!(
        index.templates.len() <= MAX_TEMPLATES
            && serde_json::to_vec(index)?.len() as u64 <= INDEX_LIMIT,
        "settings_template_index_budget_exceeded"
    );
    owned::validate(&index.imports)?;
    let mut ids = std::collections::BTreeSet::new();
    for entry in &index.templates {
        validate_id(&entry.id)?;
        anyhow::ensure!(
            ids.insert(&entry.id)
                && !entry.name.trim().is_empty()
                && entry.name.len() <= 512
                && entry
                    .description
                    .as_ref()
                    .is_none_or(|value| value.len() <= 4096)
                && entry.size_bytes <= MAX_TEMPLATE_BYTES as u64,
            "settings_template_invalid_index"
        );
    }
    if let Some(id) = &index.default_id {
        validate_id(id)?;
    }
    Ok(())
}
