//! Revision-checked edits of only the native target user's Office enabled field.
use crate::app_server::engine_factory::AppServerEngineFactory;
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::integrations::office_settings::{
    OfficeSettingsReadResult, OfficeSettingsSaveParams,
};
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{ffi::OsString, path::PathBuf};
use tokio_util::sync::CancellationToken;

const FIELD: &str = "integrations.office.enabled";
const MAX_CONFIG_BYTES: u64 = 16 * 1024 * 1024;

struct NativeTarget {
    path: PathBuf,
    parent_path: PathBuf,
    parent: PrivateDirectory,
    identity: String,
    name: OsString,
}
impl NativeTarget {
    fn capture(engine: &QueryEngine, factory: &AppServerEngineFactory) -> Result<Self> {
        let path = engine
            .settings_persistence_path()
            .context("OFFICE_SETTINGS_UNAVAILABLE")?;
        ensure!(path.is_absolute(), "OFFICE_SETTINGS_TARGET_CHANGED");
        let parent_path = path
            .parent()
            .context("OFFICE_SETTINGS_UNAVAILABLE")?
            .to_path_buf();
        let parent = PrivateDirectory::open_existing(&parent_path)?;
        parent.verify_trusted_config_directory()?;
        let identity = parent.directory_identity()?;
        let name = path
            .file_name()
            .context("OFFICE_SETTINGS_UNAVAILABLE")?
            .to_os_string();
        let result = Self {
            path,
            parent_path,
            parent,
            identity,
            name,
        };
        result.verify()?;
        ensure!(
            result.path == factory.hook_user_settings_path()?,
            "OFFICE_SETTINGS_TARGET_CHANGED"
        );
        Ok(result)
    }
    fn verify(&self) -> Result<()> {
        self.parent.verify_trusted_config_directory()?;
        let current = PrivateDirectory::open_existing(&self.parent_path)?;
        current.verify_trusted_config_directory()?;
        ensure!(
            current.directory_identity()? == self.identity,
            "OFFICE_SETTINGS_TARGET_CHANGED"
        );
        let file = self.parent.open_single_link_regular_file(&self.name)?;
        let metadata = file.metadata()?;
        ensure!(
            metadata.len() > 0 && metadata.len() <= MAX_CONFIG_BYTES,
            "OFFICE_SETTINGS_UNAVAILABLE"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            // SAFETY: geteuid only reads this process's native effective identity.
            ensure!(
                metadata.uid() == unsafe { libc::geteuid() },
                "OFFICE_SETTINGS_UNAVAILABLE"
            );
        }
        let mut reader = std::io::BufReader::new(file);
        use std::io::Read;
        let mut prefix = [0u8; 4096];
        let mut meaningful = false;
        loop {
            let count = reader.read(&mut prefix)?;
            if count == 0 {
                break;
            }
            if prefix[..count]
                .iter()
                .any(|byte| !byte.is_ascii_whitespace())
            {
                meaningful = true;
                break;
            }
        }
        ensure!(meaningful, "OFFICE_SETTINGS_UNAVAILABLE");
        Ok(())
    }
    fn revision(&self, value: Option<bool>) -> Result<String> {
        let bytes = serde_json::to_vec(&json!(["office-enabled-v1", self.identity, value]))?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
}
fn enabled(document: &Value) -> Result<Option<bool>> {
    let mut current = document;
    for key in ["integrations", "office", "enabled"] {
        ensure!(current.is_object(), "OFFICE_SETTINGS_UNAVAILABLE");
        let Some(value) = current.get(key) else {
            return Ok(None);
        };
        current = value;
    }
    Ok(Some(
        current.as_bool().context("OFFICE_SETTINGS_UNAVAILABLE")?,
    ))
}
fn check(cancel: &CancellationToken) -> Result<()> {
    ensure!(!cancel.is_cancelled(), "OFFICE_SETTINGS_CANCELLED");
    Ok(())
}
fn result(
    target: &NativeTarget,
    document: &Value,
    engine: &QueryEngine,
    factory: &AppServerEngineFactory,
) -> Result<OfficeSettingsReadResult> {
    let persisted_enabled = enabled(document)?;
    let effective_enabled = factory.current_settings()?.integrations.office.enabled;
    let connection_enabled = engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("OFFICE_SETTINGS_UNAVAILABLE"))?
        .integrations
        .office
        .enabled;
    Ok(OfficeSettingsReadResult {
        persisted_enabled,
        effective_enabled,
        connection_enabled,
        revision: target.revision(persisted_enabled)?,
        restart_required: effective_enabled != connection_enabled,
    })
}
fn public_error(error: anyhow::Error) -> anyhow::Error {
    let code = error
        .chain()
        .find_map(|error| match error.to_string().as_str() {
            "OFFICE_SETTINGS_TARGET_CHANGED" => Some("OFFICE_SETTINGS_TARGET_CHANGED"),
            "OFFICE_SETTINGS_REVISION_CONFLICT" => Some("OFFICE_SETTINGS_REVISION_CONFLICT"),
            "OFFICE_SETTINGS_CANCELLED" => Some("OFFICE_SETTINGS_CANCELLED"),
            "OFFICE_SETTINGS_INVALID_REQUEST" => Some("OFFICE_SETTINGS_INVALID_REQUEST"),
            _ => None,
        })
        .unwrap_or("OFFICE_SETTINGS_UNAVAILABLE");
    anyhow::anyhow!(code)
}

pub(in crate::app_server) fn read(
    engine: &QueryEngine,
    factory: &AppServerEngineFactory,
    cancel: &CancellationToken,
) -> Result<OfficeSettingsReadResult> {
    (|| {
        check(cancel)?;
        let target = NativeTarget::capture(engine, factory)?;
        let document = kcoder_config::read_settings_file(&target.path)?;
        target.verify()?;
        check(cancel)?;
        let observed = result(&target, &document, engine, factory)?;
        check(cancel)?;
        Ok(observed)
    })()
    .map_err(public_error)
}

pub(in crate::app_server) fn save(
    engine: &QueryEngine,
    factory: &AppServerEngineFactory,
    params: OfficeSettingsSaveParams,
    cancel: &CancellationToken,
) -> Result<OfficeSettingsReadResult> {
    (|| {
        check(cancel)?;
        ensure!(
            params.expected_revision.len() == 64
                && params
                    .expected_revision
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()),
            "OFFICE_SETTINGS_INVALID_REQUEST"
        );
        let target = NativeTarget::capture(engine, factory)?;
        let document = kcoder_config::update_settings_file(&target.path, |document| {
            check(cancel)?;
            target.verify()?;
            ensure!(
                target.revision(enabled(document)?)? == params.expected_revision,
                "OFFICE_SETTINGS_REVISION_CONFLICT"
            );
            kcoder_config::set_dotted_value(document, FIELD, Value::Bool(params.enabled))
        })?;
        target.verify()?;
        check(cancel)?;
        let observed = result(&target, &document, engine, factory)?;
        check(cancel)?;
        Ok(observed)
    })()
    .map_err(public_error)
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
