//! Named views retain their own identity and validate every contributing source layer.
use super::*;
use crate::model::NormalizedItem;
use kcoder_types::migration::{
    MigrationIssue, MigrationIssueCode, MigrationIssuePhase, MigrationIssueSeverity,
    MigrationItemPreview, MigrationItemStatus,
};
#[cfg(test)]
mod tests;

const MAX_PROFILES: usize = 64;
const MAX_DIRECTORY_ENTRIES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "format", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum CodexProfileBinding {
    File {
        name: String,
        base_revision: Option<String>,
    },
    LegacyTable {
        name: String,
    },
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(crate) fn file_profile(name: &str) -> Option<&str> {
    name.strip_suffix(".config.toml")
        .filter(|name| valid_name(name))
}

pub(super) fn files(root: &Path) -> Result<Vec<PathBuf>> {
    let directory = match PrivateDirectory::open_existing(root) {
        Ok(directory) => directory,
        Err(error) if missing(&error) => return Ok(Vec::new()),
        Err(_) => anyhow::bail!("migration_unsafe_source_path"),
    };
    directory.verify_trusted_config_directory()?;
    let mut names = Vec::new();
    directory.visit_entry_names_bounded(MAX_DIRECTORY_ENTRIES, |name| {
        if name.to_str().and_then(file_profile).is_some() {
            ensure!(
                names.len() < MAX_PROFILES,
                "migration_source_budget_exceeded"
            );
            names.push(root.join(name));
        }
        Ok(())
    })?;
    names.sort();
    Ok(names)
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|cause| cause.kind() == std::io::ErrorKind::NotFound)
    })
}

fn base(directory: &PrivateDirectory) -> Result<Option<SourceDocument>> {
    // Only absence permits an empty base; links, unreadable files and invalid owners fail closed.
    match directory.open_single_link_regular_file(OsStr::new("config.toml")) {
        Err(error) if missing(&error) => Ok(None),
        Err(_) => anyhow::bail!("migration_unsafe_source_path"),
        Ok(_) => {
            SourceDocument::read_configuration_at(directory, OsStr::new("config.toml")).map(Some)
        }
    }
}

pub(super) fn capture_file(
    directory: &PrivateDirectory,
    name: &str,
) -> Result<Option<CodexProfileBinding>> {
    let Some(name) = file_profile(name) else {
        return Ok(None);
    };
    Ok(Some(CodexProfileBinding::File {
        name: name.into(),
        base_revision: base(directory)?.map(|document| document.revision()),
    }))
}

fn table(document: &SourceDocument) -> Result<toml::Table> {
    toml::from_str(document.text()).map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))
}

fn check_label(name: &str, document: &toml::Table) -> Result<()> {
    let document = serde_json::to_value(document)
        .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?;
    ensure!(
        crate::adapters::safe_text(
            Some(&serde_json::Value::String(name.into())),
            128,
            &crate::adapters::secret_values(&document),
        )
        .is_some(),
        "migration_unsafe_profile_name"
    );
    Ok(())
}

fn private_values(documents: &[&toml::Table]) -> Result<zeroize::Zeroizing<Vec<String>>> {
    let mut values = zeroize::Zeroizing::new(Vec::<String>::new());
    let mut bytes = 0usize;
    for document in documents {
        let document = serde_json::to_value(document)
            .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?;
        for value in crate::adapters::secret_values(&document) {
            if !values.iter().any(|known| known == value) {
                bytes = bytes.saturating_add(value.len());
                ensure!(
                    values.len() < 4096 && bytes <= 8 * 1024 * 1024,
                    "migration_source_budget_exceeded"
                );
                values.push(value.into());
            }
        }
    }
    Ok(values)
}

fn merge(target: &mut toml::Table, overlay: toml::Table) {
    for (name, value) in overlay {
        match (target.get_mut(&name), value) {
            (Some(toml::Value::Table(target)), toml::Value::Table(overlay)) => {
                merge(target, overlay)
            }
            (_, value) => {
                target.insert(name, value);
            }
        }
    }
}

impl ConfigurationBinding {
    pub(super) fn legacy_profiles(&self) -> Result<Vec<Self>> {
        if self.kind != MigrationSourceKind::Codex
            || self.name != "config.toml"
            || self.scope != "user"
            || self.codex_profile.is_some()
        {
            return Ok(Vec::new());
        }
        let document = self.read()?;
        let root = table(&document)?;
        let Some(profiles) = root.get("profiles") else {
            return Ok(Vec::new());
        };
        let profiles = profiles
            .as_table()
            .ok_or_else(|| anyhow::anyhow!("migration_invalid_source_format"))?;
        ensure!(
            profiles.len() <= MAX_PROFILES,
            "migration_source_budget_exceeded"
        );
        let mut bindings = Vec::new();
        for (name, value) in profiles {
            ensure!(
                valid_name(name) && value.is_table(),
                "migration_invalid_source_format"
            );
            check_label(name, &root)?;
            let mut binding = self.clone();
            binding.codex_profile = Some(CodexProfileBinding::LegacyTable { name: name.clone() });
            bindings.push(binding);
        }
        Ok(bindings)
    }

    pub(super) fn profile_document(
        &self,
        directory: &PrivateDirectory,
        source: SourceDocument,
    ) -> Result<SourceDocument> {
        let Some(profile) = &self.codex_profile else {
            return Ok(source);
        };
        ensure!(
            self.kind == MigrationSourceKind::Codex && self.scope == "user",
            "migration_invalid_source_binding"
        );
        let (mut resolved, private_values) = match profile {
            CodexProfileBinding::File {
                name,
                base_revision,
            } => {
                ensure!(
                    file_profile(&self.name) == Some(name.as_str()),
                    "migration_invalid_source_binding"
                );
                let base = base(directory)?;
                if let (Some(root), Some(base)) = (&self.selected_root, &base) {
                    root.verify_uploaded_bytes(
                        &self.root.join("config.toml"),
                        base.text().as_bytes(),
                    )?;
                }
                ensure!(
                    base.as_ref().map(SourceDocument::revision) == *base_revision,
                    "migration_source_changed"
                );
                let mut resolved = base.as_ref().map(table).transpose()?.unwrap_or_default();
                let overlay = table(&source)?;
                check_label(name, &resolved)?;
                check_label(name, &overlay)?;
                let private_values = private_values(&[&resolved, &overlay])?;
                merge(&mut resolved, overlay);
                (resolved, private_values)
            }
            CodexProfileBinding::LegacyTable { name } => {
                ensure!(
                    self.name == "config.toml" && valid_name(name),
                    "migration_invalid_source_binding"
                );
                let mut resolved = table(&source)?;
                check_label(name, &resolved)?;
                let private_values = private_values(&[&resolved])?;
                let overlay = resolved
                    .get("profiles")
                    .and_then(|profiles| profiles.get(name))
                    .and_then(toml::Value::as_table)
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("migration_source_changed"))?;
                merge(&mut resolved, overlay);
                (resolved, private_values)
            }
        };
        // Current files do not activate legacy routing; legacy selection is explicit per view.
        resolved.remove("profiles");
        resolved.remove("profile");
        let text = toml::to_string(&resolved)
            .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?;
        SourceDocument::from_private_configuration(text, private_values)
    }

    pub(super) fn profile_label(&self) -> Option<String> {
        self.codex_profile.as_ref().map(|profile| match profile {
            CodexProfileBinding::File { name, .. } => format!("{name}.config.toml"),
            CodexProfileBinding::LegacyTable { name } => format!("profiles.{name}"),
        })
    }

    pub(super) fn profile_inventory(
        &self,
        inventory: &mut MigrationInventory,
        source: &SourceDocument,
    ) -> Result<()> {
        let Some(profile) = &self.codex_profile else {
            return Ok(());
        };
        ensure!(
            inventory.items.len() < 1024,
            "migration_source_budget_exceeded"
        );
        inventory.adapter_revision = match profile {
            CodexProfileBinding::File { .. } => "codex-profile-file/v1",
            CodexProfileBinding::LegacyTable { .. } => "codex-profile-table/v1",
        }
        .into();
        append_template(inventory, source, self.profile_label().unwrap())
    }

    pub(super) fn refreshed_profile(&self, mut refreshed: Self) -> Result<Self> {
        if let Some(CodexProfileBinding::LegacyTable { name }) = &self.codex_profile {
            refreshed.codex_profile = Some(CodexProfileBinding::LegacyTable { name: name.clone() });
            refreshed.read()?;
        }
        Ok(refreshed)
    }
}

/// Composite Native views reuse the same bounded template adapter as existing profile views.
pub(super) fn append_template(
    inventory: &mut MigrationInventory,
    source: &SourceDocument,
    label: String,
) -> Result<()> {
    ensure!(
        inventory.items.len() < 1024,
        "migration_source_budget_exceeded"
    );
    let source_value = serde_json::to_value(table(source)?)
        .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?;
    let active = source_value
        .get("model_provider")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("openai");
    let provider = inventory
        .items
        .iter()
        .find(|item| item.provider.is_some() && item.preview.source_name == active);
    let mut issues = inventory.issues.clone();
    for issue in &mut issues {
        if issue.code == MigrationIssueCode::UnsupportedField {
            issue.severity = MigrationIssueSeverity::Blocking;
        }
    }
    let mut template = provider.map(|item| crate::model::TemplateCandidate {
        source_provider: item.preview.source_name.clone(),
        reasoning_effort: None,
    });
    if let Some(effort) = source_value.get("model_reasoning_effort") {
        let effort = crate::adapters::safe_text(Some(effort), 64, &source.private_values());
        if let Some(effort) = effort.filter(|value| {
            matches!(
                value.as_str(),
                "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
            )
        }) {
            if let Some(template) = &mut template {
                template.reasoning_effort = Some(effort);
            }
        } else {
            issues.push(MigrationIssue {
                code: MigrationIssueCode::UnsupportedField,
                severity: MigrationIssueSeverity::Blocking,
                phase: MigrationIssuePhase::Import,
                field: Some("model_reasoning_effort".into()),
            });
        }
    }
    issues.push(MigrationIssue {
        code: MigrationIssueCode::MissingDependency,
        severity: MigrationIssueSeverity::Blocking,
        phase: if template.is_some() {
            MigrationIssuePhase::Activation
        } else {
            MigrationIssuePhase::Import
        },
        field: Some("session_template".into()),
    });
    inventory.items.push(NormalizedItem {
        preview: MigrationItemPreview {
            id: "codex-profile-template".into(),
            category: MigrationCategory::Provider,
            source_name: label,
            status: MigrationItemStatus::RequiresAction,
            selected_by_default: false,
            issues,
        },
        provider: None,
        mcp: None,
        asset: None,
        template,
    });
    Ok(())
}
