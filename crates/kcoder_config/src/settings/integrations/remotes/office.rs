//! Independent receiver Office policy and installation evidence, never authority.
use anyhow::{Result, ensure};
use kcoder_types::integrations::office::OfficeFileFormat;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::PathBuf};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct NativeRemoteOfficePolicy {
    pub enabled: bool,
    pub allowed_formats: Vec<OfficeFileFormat>,
    pub allowed_tools: Vec<String>,
    pub startup_configuration: Option<NativeRemoteOfficeStartupConfiguration>,
}

/// These selectors identify an installation. Only the receiving native process
/// can bind them to its own held parent/profile/workspace and original Accepted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteOfficeStartupConfiguration {
    pub schema_version: u32,
    pub component_root: PathBuf,
    pub manifest_sha256: String,
    pub runtime: NativeRemoteOfficeRuntimeConfiguration,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteOfficeRuntimeConfiguration {
    pub program: PathBuf,
    pub sha256: String,
    pub mode: String,
    pub node_version: String,
    pub electron_version: Option<String>,
}
impl NativeRemoteOfficePolicy {
    pub(super) fn validate(&self) -> Result<()> {
        let tools: BTreeSet<_> = self.allowed_tools.iter().map(String::as_str).collect();
        let formats: BTreeSet<_> = self
            .allowed_formats
            .iter()
            .map(|format| format.extension())
            .collect();
        ensure!(
            tools.len() == self.allowed_tools.len()
                && formats.len() == self.allowed_formats.len()
                && tools
                    .iter()
                    .all(|name| ["OfficeDocument", "tool_execute", "tool_search"].contains(name))
                && self.allowed_formats.iter().all(|format| matches!(
                    format,
                    OfficeFileFormat::Docx | OfficeFileFormat::Xlsx | OfficeFileFormat::Pptx
                )),
            "REMOTE_OFFICE_POLICY_INVALID"
        );
        if let Some(value) = &self.startup_configuration {
            ensure!(
                value.schema_version == 1
                    && value.component_root.is_absolute()
                    && sha(&value.manifest_sha256)
                    && value.runtime.program.is_absolute()
                    && sha(&value.runtime.sha256)
                    && ["standalone_node", "electron_as_node"]
                        .contains(&value.runtime.mode.as_str())
                    && !value.runtime.node_version.is_empty()
                    && value.runtime.node_version.len() <= 64
                    && value
                        .runtime
                        .electron_version
                        .as_ref()
                        .is_none_or(|version| !version.is_empty() && version.len() <= 64),
                "REMOTE_OFFICE_STARTUP_CONFIGURATION_INVALID"
            );
        }
        if self.enabled {
            ensure!(
                !self.allowed_formats.is_empty()
                    && tools.len() == 3
                    && self.startup_configuration.is_some(),
                "REMOTE_OFFICE_EXPLICIT_CONFIGURATION_REQUIRED"
            );
        }
        Ok(())
    }
}
fn sha(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn receiver_office_requires_explicit_formats_tools_and_installation_evidence() {
        let mut policy = NativeRemoteOfficePolicy::default();
        policy.validate().unwrap();
        policy.enabled = true;
        assert!(policy.validate().is_err());
        policy.allowed_formats = vec![OfficeFileFormat::Docx];
        policy.allowed_tools = vec![
            "OfficeDocument".into(),
            "tool_execute".into(),
            "tool_search".into(),
        ];
        assert!(policy.validate().is_err());
        policy.startup_configuration = Some(NativeRemoteOfficeStartupConfiguration {
            schema_version: 1,
            component_root: std::env::current_dir()
                .unwrap()
                .join("installation-selector"),
            manifest_sha256: "a".repeat(64),
            runtime: NativeRemoteOfficeRuntimeConfiguration {
                program: std::env::current_dir().unwrap().join("runtime-selector"),
                sha256: "b".repeat(64),
                mode: "standalone_node".into(),
                node_version: "22.0.0".into(),
                electron_version: None,
            },
        });
        policy.validate().unwrap();
        policy.allowed_tools.push("bash".into());
        assert!(policy.validate().is_err());
        policy.allowed_tools.pop();
        policy.allowed_formats.push(OfficeFileFormat::Pdf);
        assert!(policy.validate().is_err());
        policy.allowed_formats.pop();
        policy.allowed_formats.push(OfficeFileFormat::Docx);
        assert!(policy.validate().is_err());
    }
}
