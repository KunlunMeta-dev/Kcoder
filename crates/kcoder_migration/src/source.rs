//! A user-selected source is read through pinned handles, never executed.
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, fmt, io::Read, path::Path};
use zeroize::Zeroizing;

const MAX_CONFIGURATION_BYTES: u64 = 8 * 1024 * 1024;

pub struct SourceDocument {
    text: Zeroizing<String>,
    private_values: Zeroizing<Vec<String>>,
}

impl fmt::Debug for SourceDocument {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SourceDocument")
            .field("content", &"[private source]")
            .finish()
    }
}

impl SourceDocument {
    /// The caller must obtain explicit user selection before choosing this file.
    pub fn read_selected_configuration(path: &Path) -> Result<Self> {
        let parent = path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let root = parent
            .canonicalize()
            .map_err(|_| anyhow::anyhow!("migration_source_unavailable"))?;
        let name = path
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("migration_unsafe_source_path"))?;
        // Authentication stores are never configuration inputs, even when selected directly.
        let directory = PrivateDirectory::open_existing(&root)
            .map_err(|_| anyhow::anyhow!("migration_unsafe_source_path"))?;
        Self::read_configuration_at(&directory, name)
    }

    pub(crate) fn read_configuration_at(
        directory: &PrivateDirectory,
        name: &OsStr,
    ) -> Result<Self> {
        let name_text = name
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("migration_unsafe_source_path"))?;
        ensure!(
            matches!(
                name_text,
                "config.toml"
                    | "settings.json"
                    | "settings.local.json"
                    | "settings.jsonc"
                    | ".claude.json"
                    | ".mcp.json"
            ) || crate::discovery::codex_profile_filename(name_text),
            "migration_unsupported_configuration_name"
        );
        let mut file = directory
            .open_single_link_regular_file(name)
            .map_err(|_| anyhow::anyhow!("migration_unsafe_source_path"))?;
        let before = file
            .metadata()
            .map_err(|_| anyhow::anyhow!("migration_source_unavailable"))?;
        ensure!(
            before.len() <= MAX_CONFIGURATION_BYTES,
            "migration_source_budget_exceeded"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            // SAFETY: geteuid has no preconditions and only observes this process's identity.
            ensure!(
                before.uid() == unsafe { libc::geteuid() } && before.nlink() == 1,
                "migration_source_ownership_mismatch"
            );
        }
        let mut bytes = Zeroizing::new(Vec::new());
        file.by_ref()
            .take(MAX_CONFIGURATION_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| anyhow::anyhow!("migration_source_unavailable"))?;
        let after = file
            .metadata()
            .map_err(|_| anyhow::anyhow!("migration_source_unavailable"))?;
        ensure!(
            bytes.len() as u64 <= MAX_CONFIGURATION_BYTES,
            "migration_source_budget_exceeded"
        );
        ensure!(
            before.len() == after.len() && before.modified().ok() == after.modified().ok(),
            "migration_source_changed"
        );
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| anyhow::anyhow!("migration_invalid_source_encoding"))?;
        Ok(Self {
            text: Zeroizing::new(text.to_owned()),
            private_values: Zeroizing::new(Vec::new()),
        })
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub(crate) fn from_private_configuration(
        text: String,
        private_values: Zeroizing<Vec<String>>,
    ) -> Result<Self> {
        let text = Zeroizing::new(text);
        ensure!(
            text.len() as u64 <= MAX_CONFIGURATION_BYTES,
            "migration_source_budget_exceeded"
        );
        ensure!(
            private_values.len() <= 4096
                && private_values.iter().map(String::len).sum::<usize>() as u64
                    <= MAX_CONFIGURATION_BYTES,
            "migration_source_budget_exceeded"
        );
        Ok(Self {
            text,
            private_values,
        })
    }

    pub(crate) fn private_values(&self) -> Vec<&str> {
        self.private_values.iter().map(String::as_str).collect()
    }

    pub fn revision(&self) -> String {
        format!("source-{:x}", Sha256::digest(self.text.as_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_only_explicit_configuration_and_never_exposes_raw_source_in_debug() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("settings.json");
        std::fs::write(&file, "private synthetic source").unwrap();
        let source = SourceDocument::read_selected_configuration(&file).unwrap();
        assert_eq!(source.text(), "private synthetic source");
        assert!(!format!("{source:?}").contains("synthetic"));
        let credentials = root.path().join("auth.json");
        std::fs::write(&credentials, "must not be read").unwrap();
        assert!(SourceDocument::read_selected_configuration(&credentials).is_err());
    }
    #[test]
    #[cfg(unix)]
    fn rejects_linked_configuration_and_does_not_modify_its_source() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("private");
        std::fs::write(&real, "source bytes").unwrap();
        let linked = root.path().join("settings.json");
        symlink(&real, &linked).unwrap();
        assert!(SourceDocument::read_selected_configuration(&linked).is_err());
        std::fs::remove_file(&linked).unwrap();
        std::fs::hard_link(&real, &linked).unwrap();
        assert!(SourceDocument::read_selected_configuration(&linked).is_err());
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "source bytes");
    }
}
