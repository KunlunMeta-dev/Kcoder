use crate::PluginId;
use anyhow::{Context, Result, bail};
use kcoder_config::PrivateDirectory;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub(super) const STORE_STATE_VERSION: u32 = 2;
pub(super) const MAX_STATE_BYTES: u64 = 1024 * 1024;
const STATE_FILE_NAME: &str = "state.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstalledPluginRecord {
    pub plugin_id: PluginId,
    pub display_name: String,
    pub version: Option<String>,
    pub enabled_by_default: bool,
    pub operation_id: String,
    pub installation_id: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub cache_relative_path: PathBuf,
    pub source: InstalledPluginSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_identity: Option<String>,
}

impl InstalledPluginRecord {
    pub fn root(&self, store_root: &Path) -> PathBuf {
        store_root.join(&self.cache_relative_path)
    }

    pub(super) fn validate(&self) -> Result<()> {
        validate_store_relative_path(&self.cache_relative_path)?;
        if self.project_identity.as_ref().is_some_and(|value| {
            value.len() != 64
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) {
            bail!("plugin_project_mapping_changed");
        }
        let expected_prefix = Path::new("cache")
            .join(self.plugin_id.marketplace_name())
            .join(self.plugin_id.plugin_name());
        if !self.cache_relative_path.starts_with(&expected_prefix) {
            bail!(
                "installed plugin {} points outside its cache namespace",
                self.plugin_id
            );
        }
        if self.display_name.trim().is_empty() {
            bail!(
                "installed plugin {} has an empty display name",
                self.plugin_id
            );
        }
        if self.operation_id.len() != 32
            || !self
                .operation_id
                .chars()
                .all(|character| character.is_ascii_hexdigit())
            || self
                .cache_relative_path
                .file_name()
                .and_then(|name| name.to_str())
                != Some(&format!("install-{}", self.operation_id))
        {
            bail!(
                "installed plugin {} has invalid operation evidence",
                self.plugin_id
            );
        }
        if self.installation_id.len() != 32
            || !self
                .installation_id
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            bail!(
                "installed plugin {} has invalid installation evidence",
                self.plugin_id
            );
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct InstalledPluginRecordV1 {
    pub plugin_id: PluginId,
    pub display_name: String,
    pub version: Option<String>,
    pub enabled_by_default: bool,
    pub operation_id: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub cache_relative_path: PathBuf,
    pub source: InstalledPluginSource,
    #[serde(default)]
    pub project_identity: Option<String>,
}

impl From<InstalledPluginRecordV1> for InstalledPluginRecord {
    fn from(record: InstalledPluginRecordV1) -> Self {
        Self {
            plugin_id: record.plugin_id,
            display_name: record.display_name,
            version: record.version,
            enabled_by_default: record.enabled_by_default,
            installation_id: record.operation_id.clone(),
            operation_id: record.operation_id,
            file_count: record.file_count,
            total_bytes: record.total_bytes,
            cache_relative_path: record.cache_relative_path,
            source: record.source,
            project_identity: record.project_identity,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum InstalledPluginSource {
    Hosted {
        url: String,
        sha256: String,
    },
    Local {
        canonical_path: PathBuf,
    },
    Marketplace {
        marketplace: String,
        entry: String,
    },
    Git {
        redacted_url: String,
        resolved_sha: String,
    },
    Npm {
        package: String,
        integrity: String,
    },
    Bundled {
        bundle: String,
        digest: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StoreState {
    pub state_version: u32,
    pub generation: u64,
    pub installed: BTreeMap<String, InstalledPluginRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoreStateV1 {
    state_version: u32,
    generation: u64,
    installed: BTreeMap<String, InstalledPluginRecordV1>,
}

impl Default for StoreState {
    fn default() -> Self {
        Self {
            state_version: STORE_STATE_VERSION,
            generation: 0,
            installed: BTreeMap::new(),
        }
    }
}

impl StoreState {
    pub(super) fn load(root: &Path, private_root: &PrivateDirectory) -> Result<Self> {
        let mut file = match private_root.open_regular_file(OsStr::new(STATE_FILE_NAME)) {
            Ok(file) => file,
            Err(_error) if !root.join(STATE_FILE_NAME).exists() => return Ok(Self::default()),
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to open plugin store state in {}", root.display())
                });
            }
        };
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_STATE_BYTES + 1)
            .read_to_end(&mut bytes)
            .context("failed to read plugin store state")?;
        if bytes.len() as u64 > MAX_STATE_BYTES {
            bail!("plugin store state exceeds {MAX_STATE_BYTES} bytes");
        }
        Self::decode(&bytes)
    }

    /// Decode current state, upgrading v1 records in memory for the next ordinary write.
    pub(super) fn decode(bytes: &[u8]) -> Result<Self> {
        if let Ok(legacy) = serde_json::from_slice::<StoreStateV1>(bytes)
            && legacy.state_version == 1
        {
            let state = Self {
                state_version: STORE_STATE_VERSION,
                generation: legacy.generation,
                installed: legacy
                    .installed
                    .into_iter()
                    .map(|(key, record)| (key, record.into()))
                    .collect(),
            };
            state.validate()?;
            return Ok(state);
        }
        let state: Self = serde_json::from_slice(bytes).context("invalid plugin store state")?;
        state.validate()?;
        Ok(state)
    }

    pub(super) fn persist(&self, private_root: &PrivateDirectory) -> Result<()> {
        self.validate()?;
        let mut bytes =
            serde_json::to_vec_pretty(self).context("failed to serialize plugin store state")?;
        bytes.push(b'\n');
        anyhow::ensure!(
            bytes.len() as u64 <= MAX_STATE_BYTES,
            "plugin store state exceeds {MAX_STATE_BYTES} bytes"
        );
        private_root
            .atomic_replace(OsStr::new(STATE_FILE_NAME), &bytes)
            .context("failed to atomically persist plugin store state")
    }

    pub(super) fn validate(&self) -> Result<()> {
        if self.state_version != STORE_STATE_VERSION {
            bail!(
                "unsupported plugin store state version {} (expected {STORE_STATE_VERSION})",
                self.state_version
            );
        }
        for (key, record) in &self.installed {
            if key != &record.plugin_id.to_string() {
                bail!("plugin store state key {key:?} does not match record identity");
            }
            record.validate()?;
        }
        Ok(())
    }
}

fn validate_store_relative_path(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        bail!("plugin store path must be a non-empty relative path");
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            bail!("plugin store path contains an unsafe component");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn record(path: &str) -> InstalledPluginRecord {
        InstalledPluginRecord {
            plugin_id: "demo@local".parse().unwrap(),
            display_name: "Demo".to_string(),
            version: Some("1.0.0".to_string()),
            enabled_by_default: true,
            operation_id: "a".repeat(32),
            installation_id: "b".repeat(32),
            file_count: 1,
            total_bytes: 4,
            cache_relative_path: PathBuf::from(path),
            project_identity: None,
            source: InstalledPluginSource::Local {
                canonical_path: PathBuf::from("/source/demo"),
            },
        }
    }

    #[test]
    fn store_state_round_trips_through_atomic_file() {
        let temp = TempDir::new().unwrap();
        let private = PrivateDirectory::open_or_create(temp.path()).unwrap();
        let mut state = StoreState {
            generation: 7,
            ..StoreState::default()
        };
        state.installed.insert(
            "demo@local".to_string(),
            record(&format!("cache/local/demo/install-{}", "a".repeat(32))),
        );

        state.persist(&private).unwrap();
        let loaded = StoreState::load(temp.path(), &private).unwrap();

        assert_eq!(loaded, state);
    }

    #[test]
    fn store_state_rejects_paths_outside_plugin_namespace() {
        let mut state = StoreState::default();
        state.installed.insert(
            "demo@local".to_string(),
            record(&format!("cache/local/other/install-{}", "a".repeat(32))),
        );

        assert!(state.validate().is_err());

        state.installed.insert(
            "demo@local".to_string(),
            record("cache/local/demo/../../outside"),
        );
        assert!(state.validate().is_err());
    }

    #[test]
    fn legacy_state_uses_operation_id_as_installation_id_without_writing() {
        let temp = TempDir::new().unwrap();
        let private = PrivateDirectory::open_or_create(temp.path()).unwrap();
        let mut legacy_record = serde_json::to_value(record(&format!(
            "cache/local/demo/install-{}",
            "a".repeat(32)
        )))
        .unwrap();
        legacy_record
            .as_object_mut()
            .unwrap()
            .remove("installation_id");
        let fixture = serde_json::to_vec(&serde_json::json!({
            "state_version": 1,
            "generation": 7,
            "installed": {"demo@local": legacy_record},
        }))
        .unwrap();
        private
            .atomic_replace(OsStr::new(STATE_FILE_NAME), &fixture)
            .unwrap();

        let loaded = StoreState::load(temp.path(), &private).unwrap();

        assert_eq!(loaded.state_version, STORE_STATE_VERSION);
        let installed = loaded.installed.get("demo@local").unwrap();
        assert_eq!(installed.installation_id, installed.operation_id);
        assert_eq!(
            std::fs::read(temp.path().join(STATE_FILE_NAME)).unwrap(),
            fixture
        );
    }

    #[test]
    fn v2_state_rejects_missing_or_invalid_installation_identity() {
        let mut value = serde_json::to_value(StoreState {
            generation: 7,
            installed: BTreeMap::from([(
                "demo@local".to_string(),
                record(&format!("cache/local/demo/install-{}", "a".repeat(32))),
            )]),
            ..StoreState::default()
        })
        .unwrap();
        value["installed"]["demo@local"]
            .as_object_mut()
            .unwrap()
            .remove("installation_id");
        assert!(StoreState::decode(&serde_json::to_vec(&value).unwrap()).is_err());

        value["installed"]["demo@local"]["installation_id"] =
            serde_json::Value::String(String::new());
        assert!(StoreState::decode(&serde_json::to_vec(&value).unwrap()).is_err());
    }

    #[test]
    fn oversized_v2_write_keeps_the_existing_state_bytes() {
        let temp = TempDir::new().unwrap();
        let private = PrivateDirectory::open_or_create(temp.path()).unwrap();
        StoreState::default().persist(&private).unwrap();
        let original = std::fs::read(temp.path().join(STATE_FILE_NAME)).unwrap();

        let mut oversized = StoreState::default();
        let mut plugin = record(&format!("cache/local/demo/install-{}", "a".repeat(32)));
        plugin.display_name = "x".repeat(MAX_STATE_BYTES as usize);
        oversized.installed.insert("demo@local".into(), plugin);

        assert!(oversized.persist(&private).is_err());
        assert_eq!(
            std::fs::read(temp.path().join(STATE_FILE_NAME)).unwrap(),
            original
        );
    }
}
