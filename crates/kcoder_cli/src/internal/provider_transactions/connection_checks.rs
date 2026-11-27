//! Last explicit connection observations, scoped to a target's user settings file.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::ProviderProbeResult;
use kcoder_config::PrivateDirectory;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, io::Read, path::Path};

const FILE: &str = "provider-connection-checks.json";
const MAX_BYTES: u64 = 1024 * 1024;
const MAX_RECORDS: usize = 1024;

fn is_missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn key(path: &Path, provider: &str, model: &str) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            path.file_name()
                .and_then(OsStr::to_str)
                .context("Invalid settings filename")?,
            provider,
            model,
        ))?)
    ))
}

fn fingerprint(configuration: &str, credential: Option<&str>) -> String {
    let mut hash = Sha256::new();
    hash.update(configuration.as_bytes());
    hash.update([0]);
    if let Some(credential) = credential {
        hash.update(credential.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

fn read(directory: &PrivateDirectory) -> Result<Map<String, Value>> {
    let file = match directory.open_regular_file_snapshot(OsStr::new(FILE)) {
        Ok(file) => file,
        Err(error) if is_missing(&error) => return Ok(Map::new()),
        Err(error) => return Err(error),
    };
    ensure!(
        file.metadata()?.len() <= MAX_BYTES,
        "Provider connection checks exceed storage limit"
    );
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_BYTES,
        "Provider connection checks exceed storage limit"
    );
    serde_json::from_slice(&bytes).context("Invalid provider connection checks")
}

pub struct ConnectionChecks {
    records: Map<String, Value>,
}

impl ConnectionChecks {
    /// Reads never create files or rewrite settings, credentials or observations.
    pub fn load(settings: &Path) -> Result<Self> {
        let directory = match PrivateDirectory::open_existing(
            settings.parent().context("Missing settings directory")?,
        ) {
            Ok(directory) => directory,
            Err(error) if is_missing(&error) => {
                return Ok(Self {
                    records: Map::new(),
                });
            }
            Err(error) => return Err(error),
        };
        Ok(Self {
            records: read(&directory)?,
        })
    }

    pub fn matching(
        &self,
        settings: &Path,
        provider: &str,
        model: &str,
        configuration: &str,
        credential: Option<&str>,
    ) -> Result<Option<ProviderProbeResult>> {
        let Some(record) = self.records.get(&key(settings, provider, model)?) else {
            return Ok(None);
        };
        if record["fingerprint"] != fingerprint(configuration, credential) {
            return Ok(None);
        }
        Ok(Some(serde_json::from_value(record["result"].clone())?))
    }
}

/// Caller holds the Provider mutation lock and has revalidated the probe snapshot.
pub fn save(settings: &Path, result: &ProviderProbeResult, credential: Option<&str>) -> Result<()> {
    let directory =
        PrivateDirectory::open_existing(settings.parent().context("Missing settings directory")?)?;
    let mut records = read(&directory)?;
    let key = key(settings, &result.provider, &result.model)?;
    // A slower earlier request must not overwrite a later explicit check.
    if records
        .get(&key)
        .and_then(|record| record["result"]["checkedAtMs"].as_u64())
        > result.checked_at_ms
    {
        return Ok(());
    }
    records.insert(key, json!({
        "fingerprint": fingerprint(&result.configuration_revision, credential), "result": result,
    }));
    while records.len() > MAX_RECORDS {
        let oldest = records
            .iter()
            .min_by_key(|(_, record)| record["result"]["checkedAtMs"].as_u64())
            .map(|(key, _)| key.clone())
            .context("Missing connection record")?;
        records.remove(&oldest);
    }
    let bytes = serde_json::to_vec(&records)?;
    ensure!(
        bytes.len() as u64 <= MAX_BYTES,
        "Provider connection checks exceed storage limit"
    );
    directory.atomic_replace(OsStr::new(FILE), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_a_fresh_profile_does_not_create_its_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("not-created");
        assert!(
            ConnectionChecks::load(&root.join("settings.json"))
                .unwrap()
                .records
                .is_empty()
        );
        assert!(!root.exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_linked_observation_files() {
        let temp = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let target = other.path().join("outside.json");
        std::fs::write(&target, b"{}").unwrap();
        std::os::unix::fs::symlink(&target, temp.path().join(FILE)).unwrap();
        assert!(ConnectionChecks::load(&temp.path().join("settings.json")).is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"{}");
    }

    #[test]
    fn checks_survive_reload_but_not_configuration_or_credential_changes() {
        let temp = tempfile::tempdir().unwrap();
        let settings = temp.path().join("settings.json");
        std::fs::write(&settings, b"{}").unwrap();
        let mut result = ProviderProbeResult {
            checked_at_ms: Some(100),
            latency_ms: Some(10),
            configuration_revision: "cfg".into(),
            provider: "custom".into(),
            model: "model".into(),
            revision: "revision".into(),
            success: true,
            error_type: None,
            ollama_context_window: None,
        };
        assert!(
            ConnectionChecks::load(&settings)
                .unwrap()
                .records
                .is_empty()
        );
        assert!(!temp.path().join(FILE).exists());
        save(&settings, &result, Some("private-key")).unwrap();
        result.checked_at_ms = Some(50);
        result.success = false;
        save(&settings, &result, Some("private-key")).unwrap();
        let loaded = ConnectionChecks::load(&settings).unwrap();
        assert!(
            loaded
                .matching(&settings, "custom", "model", "cfg", Some("private-key"))
                .unwrap()
                .unwrap()
                .success
        );
        for (model, cfg, key) in [
            ("model", "changed", Some("private-key")),
            ("model", "cfg", Some("changed-key")),
            ("other", "cfg", Some("private-key")),
        ] {
            assert!(
                loaded
                    .matching(&settings, "custom", model, cfg, key)
                    .unwrap()
                    .is_none()
            );
        }
        let bytes = std::fs::read_to_string(temp.path().join(FILE)).unwrap();
        assert!(!bytes.contains("private-key"));
        assert_eq!(std::fs::read(&settings).unwrap(), b"{}");
        result.checked_at_ms = Some(200);
        result.error_type = Some("authentication".into());
        save(&settings, &result, Some("private-key")).unwrap();
        assert!(
            !ConnectionChecks::load(&settings)
                .unwrap()
                .matching(&settings, "custom", "model", "cfg", Some("private-key"))
                .unwrap()
                .unwrap()
                .success
        );
    }
}
