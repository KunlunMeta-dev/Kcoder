//! Explicit profile setup, separate from reading or running knowledge features.
use crate::app_server::engine_factory::AppServerEngineFactory;
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::integrations::knowledge_settings::*;
use kcoder_config::{PrivateDirectory, integrations::knowledge::KnowledgeIntegrationSettings};
use kcoder_engine::QueryEngine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{ffi::OsString, path::PathBuf};
use tokio_util::sync::CancellationToken;

mod rpc;
pub(in crate::app_server) use rpc::dispatch;

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
            .context("KNOWLEDGE_SETTINGS_UNAVAILABLE")?;
        ensure!(
            path.is_absolute() && path == factory.hook_user_settings_path()?,
            "KNOWLEDGE_SETTINGS_TARGET_CHANGED"
        );
        let directory = PrivateDirectory::open_existing(
            path.parent().context("KNOWLEDGE_SETTINGS_UNAVAILABLE")?,
        )?;
        directory.verify_trusted_config_directory()?;
        let identity = directory.directory_identity()?;
        let name = path
            .file_name()
            .context("KNOWLEDGE_SETTINGS_UNAVAILABLE")?
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
                .context("KNOWLEDGE_SETTINGS_UNAVAILABLE")?,
        )?;
        current.verify_trusted_config_directory()?;
        ensure!(
            current.directory_identity()? == self.identity,
            "KNOWLEDGE_SETTINGS_TARGET_CHANGED"
        );
        let file = self.directory.open_single_link_regular_file(&self.name)?;
        let metadata = file.metadata()?;
        ensure!(
            metadata.len() > 0 && metadata.len() <= 16 * 1024 * 1024,
            "KNOWLEDGE_SETTINGS_UNAVAILABLE"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            // SAFETY: geteuid only observes the current process identity.
            ensure!(
                metadata.uid() == unsafe { libc::geteuid() },
                "KNOWLEDGE_SETTINGS_UNAVAILABLE"
            );
        }
        use std::io::Read;
        let mut reader = std::io::BufReader::new(file);
        let mut buffer = [0u8; 4096];
        loop {
            let count = reader.read(&mut buffer)?;
            ensure!(count > 0, "KNOWLEDGE_SETTINGS_UNAVAILABLE");
            if buffer[..count]
                .iter()
                .any(|byte| !byte.is_ascii_whitespace())
            {
                break;
            }
        }
        Ok(())
    }
    fn revision(&self, flags: &KnowledgeSettingsPersisted) -> Result<String> {
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&json!([
                "knowledge-switches-v1",
                self.identity,
                flags
            ]))?)
        ))
    }
}

fn flags(settings: &KnowledgeIntegrationSettings) -> KnowledgeSettingsFlags {
    KnowledgeSettingsFlags {
        memory_center_enabled: settings.memory_center_enabled,
        publications_enabled: settings.publications_enabled,
        business_automation_enabled: settings.business_automation_enabled,
    }
}
fn persisted(document: &Value) -> Result<KnowledgeSettingsPersisted> {
    fn field(document: &Value, key: &str) -> Result<Option<bool>> {
        let mut current = document;
        for key in ["integrations", "knowledge", key] {
            ensure!(current.is_object(), "KNOWLEDGE_SETTINGS_UNAVAILABLE");
            let Some(value) = current.get(key) else {
                return Ok(None);
            };
            current = value;
        }
        Ok(Some(
            current
                .as_bool()
                .context("KNOWLEDGE_SETTINGS_UNAVAILABLE")?,
        ))
    }
    Ok(KnowledgeSettingsPersisted {
        memory_center_enabled: field(document, "memory_center_enabled")?,
        publications_enabled: field(document, "publications_enabled")?,
        business_automation_enabled: field(document, "business_automation_enabled")?,
    })
}
fn observe(
    target: &Target,
    document: &Value,
    engine: &QueryEngine,
    factory: &AppServerEngineFactory,
) -> Result<KnowledgeSettingsReadResult> {
    let persisted = persisted(document)?;
    let effective = flags(&factory.current_settings()?.integrations.knowledge);
    let connection = flags(
        &engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("KNOWLEDGE_SETTINGS_UNAVAILABLE"))?
            .integrations
            .knowledge,
    );
    Ok(KnowledgeSettingsReadResult {
        revision: target.revision(&persisted)?,
        persisted,
        restart_required: effective != connection,
        effective,
        connection,
    })
}
fn check(cancel: &CancellationToken) -> Result<()> {
    ensure!(!cancel.is_cancelled(), "KNOWLEDGE_SETTINGS_CANCELLED");
    Ok(())
}
fn public_error(error: anyhow::Error) -> anyhow::Error {
    let code = error
        .chain()
        .find_map(|error| match error.to_string().as_str() {
            "KNOWLEDGE_SETTINGS_TARGET_CHANGED" => Some("KNOWLEDGE_SETTINGS_TARGET_CHANGED"),
            "KNOWLEDGE_SETTINGS_REVISION_CONFLICT" => Some("KNOWLEDGE_SETTINGS_REVISION_CONFLICT"),
            "KNOWLEDGE_SETTINGS_CANCELLED" => Some("KNOWLEDGE_SETTINGS_CANCELLED"),
            "KNOWLEDGE_SETTINGS_INVALID_REQUEST" => Some("KNOWLEDGE_SETTINGS_INVALID_REQUEST"),
            "KNOWLEDGE_SETTINGS_RESULT_UNCONFIRMED" => {
                Some("KNOWLEDGE_SETTINGS_RESULT_UNCONFIRMED")
            }
            _ => None,
        })
        .unwrap_or("KNOWLEDGE_SETTINGS_UNAVAILABLE");
    anyhow::anyhow!(code)
}
fn read(
    engine: &QueryEngine,
    factory: &AppServerEngineFactory,
    cancel: &CancellationToken,
) -> Result<KnowledgeSettingsReadResult> {
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
    params: KnowledgeSettingsSaveParams,
    cancel: &CancellationToken,
) -> Result<KnowledgeSettingsReadResult> {
    (|| {
        check(cancel)?;
        ensure!(
            params.expected_revision.len() == 64
                && params
                    .expected_revision
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()),
            "KNOWLEDGE_SETTINGS_INVALID_REQUEST"
        );
        let target = Target::capture(engine, factory)?;
        // Resolving the registry may read current Wiki settings. Capture native
        // inputs before taking the settings writer lock; setup itself follows CAS.
        let memory_setup =
            if params.feature == KnowledgeSettingsFeature::MemoryCenter && params.enabled {
                Some((
                    engine.state.cwd(),
                    engine.active_model_configuration_summary()?.revision,
                ))
            } else {
                None
            };
        let field = match params.feature {
            KnowledgeSettingsFeature::MemoryCenter => {
                "integrations.knowledge.memory_center_enabled"
            }
            KnowledgeSettingsFeature::SharedKnowledge => {
                "integrations.knowledge.publications_enabled"
            }
            KnowledgeSettingsFeature::Subscriptions => {
                "integrations.knowledge.business_automation_enabled"
            }
        };
        let document = kcoder_config::update_settings_file(&target.path, |document| {
            check(cancel)?;
            target.verify()?;
            ensure!(
                target.revision(&persisted(document)?)? == params.expected_revision,
                "KNOWLEDGE_SETTINGS_REVISION_CONFLICT"
            );
            if let Some((workspace, revision)) = memory_setup.as_ref() {
                let native =
                    crate::app_server::integrations::core::NativeIntegrationContext::capture(
                        target
                            .path
                            .parent()
                            .context("KNOWLEDGE_SETTINGS_UNAVAILABLE")?,
                        workspace,
                        "memory-feature-enable",
                        revision,
                    )?;
                crate::app_server::integrations::core::NativeMemoryService::prepare_enabled(
                    &native,
                )?;
                check(cancel)?;
                target.verify()?;
            }
            kcoder_config::set_dotted_value(document, field, Value::Bool(params.enabled))
        })?;
        // A committed setting is reconciled by reading it; never replay a lost save.
        (|| {
            target.verify()?;
            check(cancel)?;
            let result = observe(&target, &document, engine, factory)?;
            check(cancel)?;
            Ok(result)
        })()
        .map_err(|_: anyhow::Error| anyhow::anyhow!("KNOWLEDGE_SETTINGS_RESULT_UNCONFIRMED"))
    })()
    .map_err(public_error)
}

#[cfg(test)]
mod tests;
