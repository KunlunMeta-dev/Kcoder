//! Explicit channel opt-in edits configuration only; reads create no native authority.
use crate::app_server::engine_factory::AppServerEngineFactory;
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::integrations::connectivity_settings::*;
use kcoder_config::{LoadedSettings, PrivateDirectory};
use kcoder_engine::QueryEngine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{ffi::OsString, path::PathBuf};
use tokio_util::sync::CancellationToken;

mod rpc;
pub(in crate::app_server) use rpc::dispatch;

const CONNECTIVITY_FIELD: &str = "integrations.connectivity.enabled";
const SERVICES_FIELD: &str = "integrations.services.enabled";

struct Target {
    path: PathBuf,
    directory: PrivateDirectory,
    identity: String,
    name: OsString,
}
impl Target {
    fn capture(engine: &QueryEngine, factory: &AppServerEngineFactory) -> Result<Self> {
        let path = engine
            .settings_persistence_path()
            .context("CONNECTIVITY_SETTINGS_UNAVAILABLE")?;
        ensure!(
            path.is_absolute() && path == factory.hook_user_settings_path()?,
            "CONNECTIVITY_SETTINGS_TARGET_CHANGED"
        );
        let directory = PrivateDirectory::open_existing(
            path.parent().context("CONNECTIVITY_SETTINGS_UNAVAILABLE")?,
        )?;
        directory.verify_trusted_config_directory()?;
        let identity = directory.directory_identity()?;
        let name = path
            .file_name()
            .context("CONNECTIVITY_SETTINGS_UNAVAILABLE")?
            .to_os_string();
        let target = Self {
            path,
            directory,
            identity,
            name,
        };
        target.verify()?;
        Ok(target)
    }
    fn verify(&self) -> Result<()> {
        self.directory.verify_trusted_config_directory()?;
        let current = PrivateDirectory::open_existing(
            self.path
                .parent()
                .context("CONNECTIVITY_SETTINGS_UNAVAILABLE")?,
        )?;
        current.verify_trusted_config_directory()?;
        ensure!(
            current.directory_identity()? == self.identity,
            "CONNECTIVITY_SETTINGS_TARGET_CHANGED"
        );
        let file = self.directory.open_single_link_regular_file(&self.name)?;
        let metadata = file.metadata()?;
        ensure!(
            metadata.len() > 0 && metadata.len() <= 16 * 1024 * 1024,
            "CONNECTIVITY_SETTINGS_UNAVAILABLE"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            // SAFETY: geteuid only observes the current process identity.
            ensure!(
                metadata.uid() == unsafe { libc::geteuid() },
                "CONNECTIVITY_SETTINGS_UNAVAILABLE"
            );
        }
        use std::io::Read;
        let mut reader = std::io::BufReader::new(file);
        let mut buffer = [0u8; 4096];
        loop {
            let count = reader.read(&mut buffer)?;
            ensure!(count > 0, "CONNECTIVITY_SETTINGS_UNAVAILABLE");
            if buffer[..count]
                .iter()
                .any(|byte| !byte.is_ascii_whitespace())
            {
                break;
            }
        }
        Ok(())
    }
    fn revision(
        &self,
        flags: &ConnectivitySettingsPersisted,
        effective: &ConnectivitySettingsFlags,
        controlled: bool,
    ) -> Result<String> {
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&json!([
                "connectivity-switches-v1",
                self.identity,
                self.path.to_string_lossy(),
                flags,
                effective,
                controlled
            ]))?)
        ))
    }
}

// Observe the same higher-priority source bytes before and under the user-file lock.
// Reloading SettingsLoader inside that lock would deadlock its provider transaction.
struct SourceFence(Vec<(PathBuf, Option<Vec<u8>>)>);
impl SourceFence {
    fn digest(path: &std::path::Path) -> Result<Option<Vec<u8>>> {
        use std::io::Read;
        let open = || -> Result<std::fs::File> {
            let parent = PrivateDirectory::open_existing(
                path.parent().context("CONNECTIVITY_SETTINGS_UNAVAILABLE")?,
            )?;
            parent.open_single_link_regular_file(
                path.file_name()
                    .context("CONNECTIVITY_SETTINGS_UNAVAILABLE")?,
            )
        };
        let file = match open() {
            Ok(file) => file,
            Err(error) if crate::app_server::error_is_not_found(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        ensure!(
            file.metadata()?.is_file(),
            "CONNECTIVITY_SETTINGS_UNAVAILABLE"
        );
        let mut bytes = Vec::new();
        file.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 16 * 1024 * 1024,
            "CONNECTIVITY_SETTINGS_UNAVAILABLE"
        );
        Ok(Some(Sha256::digest(&bytes).to_vec()))
    }
    fn capture(loaded: &LoadedSettings) -> Result<Self> {
        let mut paths = vec![
            loaded.paths.executable_settings.clone(),
            loaded.paths.project_settings.clone(),
            loaded.paths.local_settings.clone(),
        ];
        paths.extend(loaded.overlay_sources.iter().cloned());
        paths.extend(
            loaded
                .loaded_sources
                .iter()
                .filter(|source| source.scope != kcoder_config::ConfigScope::User)
                .map(|source| source.path.clone()),
        );
        paths.retain(|path| path != &loaded.paths.user_settings);
        paths.sort();
        paths.dedup();
        Ok(Self(
            paths
                .into_iter()
                .map(|path| Ok((path.clone(), Self::digest(&path)?)))
                .collect::<Result<_>>()?,
        ))
    }
    fn verify(&self) -> Result<()> {
        for (path, digest) in &self.0 {
            ensure!(
                Self::digest(path)? == *digest,
                "CONNECTIVITY_SETTINGS_REVISION_CONFLICT"
            );
        }
        Ok(())
    }
}

fn flags(settings: &kcoder_config::Settings) -> ConnectivitySettingsFlags {
    ConnectivitySettingsFlags {
        enabled: settings.integrations.connectivity.enabled,
        services_enabled: settings.integrations.services.enabled,
    }
}
fn persisted(document: &Value) -> Result<ConnectivitySettingsPersisted> {
    fn field(document: &Value, domain: &str) -> Result<Option<bool>> {
        let mut current = document;
        for key in ["integrations", domain, "enabled"] {
            ensure!(current.is_object(), "CONNECTIVITY_SETTINGS_UNAVAILABLE");
            let Some(next) = current.get(key) else {
                return Ok(None);
            };
            current = next;
        }
        Ok(Some(
            current
                .as_bool()
                .context("CONNECTIVITY_SETTINGS_UNAVAILABLE")?,
        ))
    }
    Ok(ConnectivitySettingsPersisted {
        enabled: field(document, "connectivity")?,
        services_enabled: field(document, "services")?,
    })
}
fn field_controlled(loaded: &LoadedSettings, target: &str) -> bool {
    let covered = |field: &str| {
        field == target
            || field.starts_with(&format!("{target}."))
            || target.starts_with(&format!("{field}."))
    };
    loaded.overlay_fields.iter().any(|field| covered(field))
        || loaded.field_sources.iter().any(|(field, source)| {
            covered(field)
                && matches!(
                    source,
                    kcoder_config::ConfigScope::Executable
                        | kcoder_config::ConfigScope::Project
                        | kcoder_config::ConfigScope::Local
                )
        })
}
fn controlled(loaded: &LoadedSettings, effective: &ConnectivitySettingsFlags) -> bool {
    field_controlled(loaded, CONNECTIVITY_FIELD)
        || (!effective.services_enabled && field_controlled(loaded, SERVICES_FIELD))
}
fn observation_policy(
    target: &Target,
    factory: &AppServerEngineFactory,
) -> Result<(ConnectivitySettingsFlags, bool, LoadedSettings)> {
    let loaded = factory.connectivity_settings_sources()?;
    ensure!(
        loaded.paths.user_settings == target.path,
        "CONNECTIVITY_SETTINGS_TARGET_CHANGED"
    );
    let effective = flags(&loaded.settings);
    let controlled = controlled(&loaded, &effective);
    Ok((effective, controlled, loaded))
}
fn observe(
    target: &Target,
    document: &Value,
    engine: &QueryEngine,
    factory: &AppServerEngineFactory,
) -> Result<ConnectivitySettingsReadResult> {
    let persisted = persisted(document)?;
    let (effective, controlled, _) = observation_policy(target, factory)?;
    let connection = {
        let settings = engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_SETTINGS_UNAVAILABLE"))?;
        flags(&settings)
    };
    Ok(ConnectivitySettingsReadResult {
        revision: target.revision(&persisted, &effective, controlled)?,
        persisted,
        restart_required: effective != connection,
        effective,
        connection,
        editable: !controlled,
        controlled_by_overlay: controlled,
    })
}
fn check(cancel: &CancellationToken) -> Result<()> {
    ensure!(!cancel.is_cancelled(), "CONNECTIVITY_SETTINGS_CANCELLED");
    Ok(())
}
fn public_error(error: anyhow::Error) -> anyhow::Error {
    let code = error
        .chain()
        .find_map(|error| match error.to_string().as_str() {
            "CONNECTIVITY_SETTINGS_TARGET_CHANGED" => Some("CONNECTIVITY_SETTINGS_TARGET_CHANGED"),
            "CONNECTIVITY_SETTINGS_REVISION_CONFLICT" => {
                Some("CONNECTIVITY_SETTINGS_REVISION_CONFLICT")
            }
            "CONNECTIVITY_SETTINGS_CONTROLLED_BY_OVERLAY" => {
                Some("CONNECTIVITY_SETTINGS_CONTROLLED_BY_OVERLAY")
            }
            "CONNECTIVITY_SETTINGS_CANCELLED" => Some("CONNECTIVITY_SETTINGS_CANCELLED"),
            "CONNECTIVITY_SETTINGS_INVALID_REQUEST" => {
                Some("CONNECTIVITY_SETTINGS_INVALID_REQUEST")
            }
            "CONNECTIVITY_SETTINGS_RESULT_UNCONFIRMED" => {
                Some("CONNECTIVITY_SETTINGS_RESULT_UNCONFIRMED")
            }
            _ => None,
        })
        .unwrap_or("CONNECTIVITY_SETTINGS_UNAVAILABLE");
    anyhow::anyhow!(code)
}
fn read(
    engine: &QueryEngine,
    factory: &AppServerEngineFactory,
    cancel: &CancellationToken,
) -> Result<ConnectivitySettingsReadResult> {
    (|| {
        check(cancel)?;
        let target = Target::capture(engine, factory)?;
        let document = kcoder_config::read_settings_file(&target.path)?;
        target.verify()?;
        check(cancel)?;
        let result = observe(&target, &document, engine, factory)?;
        check(cancel)?;
        Ok(result)
    })()
    .map_err(public_error)
}
fn save(
    engine: &QueryEngine,
    factory: &AppServerEngineFactory,
    params: ConnectivitySettingsSaveParams,
    cancel: &CancellationToken,
) -> Result<ConnectivitySettingsReadResult> {
    (|| {
        check(cancel)?;
        ensure!(
            params.expected_revision.len() == 64
                && params
                    .expected_revision
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()),
            "CONNECTIVITY_SETTINGS_INVALID_REQUEST"
        );
        let target = Target::capture(engine, factory)?;
        let first = factory.connectivity_settings_sources()?;
        let sources = SourceFence::capture(&first)?;
        let (effective, controlled, loaded) = observation_policy(&target, factory)?;
        ensure!(
            first.paths == loaded.paths,
            "CONNECTIVITY_SETTINGS_TARGET_CHANGED"
        );
        ensure!(!controlled, "CONNECTIVITY_SETTINGS_CONTROLLED_BY_OVERLAY");
        sources.verify()?;
        let document = kcoder_config::update_settings_file(&target.path, |document| {
            check(cancel)?;
            target.verify()?;
            sources.verify()?;
            ensure!(
                target.revision(&persisted(document)?, &effective, controlled)?
                    == params.expected_revision,
                "CONNECTIVITY_SETTINGS_REVISION_CONFLICT"
            );
            if params.enabled && !field_controlled(&loaded, SERVICES_FIELD) {
                kcoder_config::set_dotted_value(document, SERVICES_FIELD, Value::Bool(true))?;
            }
            kcoder_config::set_dotted_value(
                document,
                CONNECTIVITY_FIELD,
                Value::Bool(params.enabled),
            )
        })
        .map_err(|error| {
            let error = public_error(error);
            match error.to_string().as_str() {
                "CONNECTIVITY_SETTINGS_REVISION_CONFLICT"
                | "CONNECTIVITY_SETTINGS_TARGET_CHANGED"
                | "CONNECTIVITY_SETTINGS_CANCELLED"
                | "CONNECTIVITY_SETTINGS_CONTROLLED_BY_OVERLAY"
                | "CONNECTIVITY_SETTINGS_INVALID_REQUEST" => error,
                _ => anyhow::anyhow!("CONNECTIVITY_SETTINGS_RESULT_UNCONFIRMED"),
            }
        })?;
        // A committed write may outlive its response; reconciliation is read-only.
        (|| {
            target.verify()?;
            check(cancel)?;
            let result = observe(&target, &document, engine, factory)?;
            check(cancel)?;
            Ok(result)
        })()
        .map_err(|_: anyhow::Error| anyhow::anyhow!("CONNECTIVITY_SETTINGS_RESULT_UNCONFIRMED"))
    })()
    .map_err(public_error)
}

#[cfg(test)]
mod tests;
