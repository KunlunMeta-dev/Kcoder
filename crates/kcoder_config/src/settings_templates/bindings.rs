//! Immutable template versions protect session loaders from mutable canonical files.
use super::*;
use std::ffi::OsStr;
const MAX_BINDINGS: usize = 1024;
const MAX_BINDING_BYTES: u64 = 16 * 1024 * 1024;
fn filename(binding: &SettingsTemplateBinding) -> Result<String> {
    validate_id(&binding.id)?;
    anyhow::ensure!(
        binding.revision_sha256.len() == 64
            && binding
                .revision_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "settings_template_invalid_binding"
    );
    Ok(format!("{}-{}.jsonc", binding.id, binding.revision_sha256))
}
impl SettingsTemplateStore {
    /// Freeze a chosen current template for an independently loaded session overlay.
    pub fn freeze_for_session(&self, id: &str) -> Result<(PathBuf, SettingsTemplateBinding)> {
        let _guard = self.guard()?;
        self.freeze_current_unlocked(id)
    }
    /// Select and freeze the default under the same coordinator as template mutations.
    pub fn freeze_default_for_session(&self) -> Result<Option<(PathBuf, SettingsTemplateBinding)>> {
        let _guard = self.guard()?;
        self.read_index()?
            .default_id
            .map(|id| self.freeze_current_unlocked(&id))
            .transpose()
    }
    fn freeze_current_unlocked(&self, id: &str) -> Result<(PathBuf, SettingsTemplateBinding)> {
        validate_id(id)?;
        self.entry(&self.read_index()?, id)?;
        let body = self.read_template_bytes(id)?;
        let binding = SettingsTemplateBinding {
            id: id.into(),
            revision_sha256: hex_sha256(&body),
        };
        let path = self.freeze_unlocked(&binding, &body)?;
        Ok((path, binding))
    }
    /// Resume the recorded version, including after the mutable template has changed or disappeared.
    pub fn recorded_session_path(&self, binding: &SettingsTemplateBinding) -> Result<PathBuf> {
        let _guard = self.guard()?;
        let file = filename(binding)?;
        if let Some(directory) = self.bindings_directory(false)?
            && self.cached_binding(&directory, &file, binding)?
        {
            return Ok(self.root.join(".bindings").join(file));
        }
        // Legacy sessions can be upgraded only from an unchanged authoritative template.
        self.entry(&self.read_index()?, &binding.id)
            .map_err(|_| anyhow::anyhow!("settings_template_snapshot_unavailable"))?;
        let body = self
            .read_template_bytes(&binding.id)
            .map_err(|_| anyhow::anyhow!("settings_template_snapshot_unavailable"))?;
        anyhow::ensure!(
            hex_sha256(&body) == binding.revision_sha256,
            "settings_template_snapshot_unavailable"
        );
        self.freeze_unlocked(binding, &body)
    }
    pub(super) fn bindings_directory(&self, create: bool) -> Result<Option<PrivateDirectory>> {
        let Some(templates) = self.directory(create)? else {
            return Ok(None);
        };
        let directory = match templates.open_child(OsStr::new(".bindings"), false) {
            Ok(directory) => directory,
            Err(error) if storage::missing(&error) && !create => return Ok(None),
            Err(error) if storage::missing(&error) => {
                templates.create_private_child(OsStr::new(".bindings"))?
            }
            Err(error) => return Err(error),
        };
        directory.verify_trusted_config_directory()?;
        Ok(Some(directory))
    }
    fn cached_binding(
        &self,
        directory: &PrivateDirectory,
        file: &str,
        binding: &SettingsTemplateBinding,
    ) -> Result<bool> {
        let Some(stamp) = super::transaction::stamp(directory, file, MAX_TEMPLATE_BYTES as u64)?
        else {
            return Ok(false);
        };
        anyhow::ensure!(
            stamp.digest == binding.revision_sha256,
            "settings_template_snapshot_changed"
        );
        Ok(true)
    }
    fn freeze_unlocked(&self, binding: &SettingsTemplateBinding, bytes: &[u8]) -> Result<PathBuf> {
        let content = std::str::from_utf8(bytes)
            .map_err(|_| anyhow::anyhow!("settings_template_invalid_content"))?;
        checked_content(content)?;
        let file = filename(binding)?;
        let directory = self.bindings_directory(true)?.unwrap();
        if !self.cached_binding(&directory, &file, binding)? {
            let mut files = 0;
            let mut used = 0u64;
            directory.visit_entry_names_bounded(MAX_BINDINGS + 1, |name| {
                let current = directory.open_single_link_regular_file(name)?;
                files += 1;
                used = used
                    .checked_add(current.metadata()?.len())
                    .ok_or_else(|| anyhow::anyhow!("settings_template_snapshot_budget_exceeded"))?;
                Ok(())
            })?;
            anyhow::ensure!(
                files < MAX_BINDINGS
                    && used.saturating_add(bytes.len() as u64) <= MAX_BINDING_BYTES,
                "settings_template_snapshot_budget_exceeded"
            );
            directory.atomic_replace(OsStr::new(&file), bytes)?;
        }
        Ok(self.root.join(".bindings").join(file))
    }
}
