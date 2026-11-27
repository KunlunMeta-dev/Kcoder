use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_plugins::{PluginCancellationToken, PluginId};
use kcoder_types::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::Read,
    path::{Component, Path, PathBuf},
};
mod project;
mod uploaded;
pub use project::PluginSourceProject;
pub(crate) use uploaded::discover as discover_uploaded;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Source {
    pub root: PathBuf,
    pub identity: String,
    pub kind: MigrationSourceKind,
    pub source_id: String,
    pub version: String,
    pub relative: PathBuf,
    pub metadata: Vec<(String, Option<String>)>,
    pub cache_listing: Option<String>,
    pub source_scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<Box<PluginSourceProject>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub received: Option<Box<crate::source_transfer::ReceivedPluginArchive>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uploaded: Option<Box<crate::source_transfer::uploads::UploadedRootBinding>>,
}
#[derive(Clone)]
pub struct PluginMigrationCandidate {
    pub id: String,
    pub source: MigrationSourceKind,
    pub name: String,
    pub installed_version: Option<String>,
    pub scope: String,
    pub source_enabled: Option<bool>,
    pub pending: Vec<String>,
    pub(super) binding: Option<Source>,
}
pub struct PluginMigrationCatalog {
    pub candidates: Vec<PluginMigrationCandidate>,
    pub issues: Vec<String>,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn sha(value: &impl Serialize) -> Result<String> {
    Ok(hash(&serde_json::to_vec(value)?))
}
fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
    })
}
fn parts(relative: &Path) -> Result<Vec<&OsStr>> {
    let parts = relative
        .components()
        .map(|part| {
            if let Component::Normal(name) = part {
                Ok(name)
            } else {
                Err(anyhow::anyhow!("plugin_migration_unsafe_path"))
            }
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        !parts.is_empty()
            && parts.len() <= 24
            && relative.as_os_str().as_encoded_bytes().len() <= 4096,
        "plugin_migration_unsafe_path"
    );
    Ok(parts)
}
fn directory(root: &PrivateDirectory, relative: &Path) -> Result<PrivateDirectory> {
    let components = parts(relative)?;
    let mut opened: Option<PrivateDirectory> = None;
    for name in components {
        let next = opened.as_ref().unwrap_or(root).open_child(name, false)?;
        next.verify_trusted_config_directory()?;
        opened = Some(next);
    }
    opened.context("plugin_migration_unsafe_path")
}
fn installed_directory_matches(
    root: &PrivateDirectory,
    declared: &Path,
    expected: &Path,
) -> Result<bool> {
    // Compare opened native directories, not Windows ordinary/verbatim path spellings.
    // Both paths must still traverse safe parents and belong to the granted source root.
    let depth = parts(expected)?.len();
    if !declared.is_absolute()
        || declared
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Ok(false);
    }
    let Some(declared_root) = declared.ancestors().nth(depth) else {
        return Ok(false);
    };
    let granted_identity = root.directory_identity()?;
    let declared_root = PrivateDirectory::open_existing(declared_root)?;
    declared_root.verify_trusted_config_directory()?;
    if declared_root.directory_identity()? != granted_identity {
        return Ok(false);
    }
    let expected_directory = directory(root, expected)?;
    let declared_directory = PrivateDirectory::open_existing(declared)?;
    declared_directory.verify_trusted_config_directory()?;
    Ok(declared_directory.directory_identity()? == expected_directory.directory_identity()?)
}
fn read(root: &PrivateDirectory, relative: &str) -> Result<Option<Vec<u8>>> {
    let path = Path::new(relative);
    let components = parts(path)?;
    let parent = if components.len() == 1 {
        None
    } else {
        Some(directory(root, path.parent().unwrap())?)
    };
    let file = match parent
        .as_ref()
        .unwrap_or(root)
        .open_single_link_regular_file(components[components.len() - 1])
    {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    ensure!(
        file.metadata()?.len() <= 1024 * 1024,
        "plugin_migration_index_budget_exceeded"
    );
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 1024 * 1024,
        "plugin_migration_index_budget_exceeded"
    );
    Ok(Some(bytes))
}
fn json(bytes: &[u8]) -> Result<Value> {
    serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("plugin_migration_invalid_index"))
}
fn safe(value: &str, secrets: &[&str]) -> Option<String> {
    crate::adapters::safe_text(Some(&Value::String(value.into())), 128, secrets)
}

fn segment(value: &str) -> bool {
    !value.is_empty()
        && !matches!(value, "." | "..")
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'))
}
fn versions(root: &PrivateDirectory, relative: &Path) -> Result<Vec<String>> {
    let dir = directory(root, relative)?;
    let mut names = Vec::new();
    dir.visit_entry_names_bounded(65, |name| {
        if let Some(name) = name.to_str()
            && segment(name)
        {
            let metadata = dir.entry_metadata(OsStr::new(name))?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                names.push(name.into());
            }
        }
        Ok(())
    })?;
    ensure!(
        names.len() <= 64,
        "plugin_migration_version_budget_exceeded"
    );
    names.sort();
    Ok(names)
}
fn active(versions: &[String]) -> Option<String> {
    if versions.iter().any(|v| v == "local") {
        return Some("local".into());
    }
    versions
        .iter()
        .max_by(
            |a, b| match (semver::Version::parse(a), semver::Version::parse(b)) {
                (Ok(a), Ok(b)) => a.cmp(&b),
                _ => a.cmp(b),
            },
        )
        .cloned()
}
impl Source {
    pub(super) fn verify_uploaded_copy(
        &self,
        frozen: &Path,
        cancel: &PluginCancellationToken,
    ) -> Result<()> {
        uploaded::verify_copy(self, frozen, cancel)
    }
    pub fn verify(&self) -> Result<PathBuf> {
        self.verify_available().map_err(|error| {
            if error.chain().any(|cause| {
                cause.downcast_ref::<std::io::Error>().is_some_and(|error| {
                    matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                    )
                })
            }) {
                anyhow::anyhow!("plugin_migration_source_unavailable")
            } else {
                error
            }
        })
    }
    fn verify_available(&self) -> Result<PathBuf> {
        if let Some(received) = &self.received {
            received.verify()?;
            let origin = received.origin()?;
            ensure!(
                origin.source == self.kind
                    && origin.scope == self.source_scope
                    && PrivateDirectory::open_existing(received.profile())?.directory_identity()?
                        == self.identity,
                "plugin_migration_source_changed"
            );
            return Ok(received.profile().to_owned());
        }
        if let Some(project) = &self.project {
            project.verify()?;
        }
        if let Some(uploaded) = &self.uploaded {
            uploaded.verify(&self.root, self.kind)?;
        }
        let root = PrivateDirectory::open_existing(&self.root)?;
        root.verify_trusted_config_directory()?;
        ensure!(
            root.directory_identity()? == self.identity,
            "plugin_migration_source_changed"
        );
        for (path, expected) in &self.metadata {
            ensure!(
                read(&root, path)?.as_deref().map(hash).as_ref() == expected.as_ref(),
                "plugin_migration_source_changed"
            );
        }
        if let Some(expected) = &self.cache_listing {
            let parent = self
                .relative
                .parent()
                .context("plugin_migration_unsafe_path")?;
            ensure!(
                sha(&versions(&root, parent)?)? == *expected,
                "plugin_migration_source_changed"
            );
        }
        directory(&root, &self.relative)?;
        Ok(self.root.join(&self.relative))
    }
}
/// root is an explicit source-home grant. No home discovery, source CLI, helper or network is invoked.
pub fn discover(
    root: &Path,
    kind: MigrationSourceKind,
    cancel: &PluginCancellationToken,
) -> Result<PluginMigrationCatalog> {
    discover_inner(root, kind, None, None, cancel)
}
/// The caller separately authorizes the source project; its path never maps a destination.
pub fn discover_with_project(
    root: &Path,
    kind: MigrationSourceKind,
    project: &PluginSourceProject,
    cancel: &PluginCancellationToken,
) -> Result<PluginMigrationCatalog> {
    project.verify()?;
    ensure!(project.kind() == kind, "plugin_migration_source_changed");
    discover_inner(root, kind, Some(project), None, cancel)
}
fn discover_inner(
    root: &Path,
    kind: MigrationSourceKind,
    project: Option<&PluginSourceProject>,
    uploaded: Option<&crate::source_transfer::uploads::UploadedRootBinding>,
    cancel: &PluginCancellationToken,
) -> Result<PluginMigrationCatalog> {
    ensure!(!cancel.is_cancelled(), "plugin_migration_cancelled");
    let handle = PrivateDirectory::open_existing(root)?;
    handle.verify_trusted_config_directory()?;
    let identity = handle.directory_identity()?;
    let canonical = root.canonicalize()?;
    ensure!(
        PrivateDirectory::open_existing(&canonical)?.directory_identity()? == identity,
        "plugin_migration_source_changed"
    );
    let mut candidates = Vec::new();
    let mut issues = Vec::new();
    if kind == MigrationSourceKind::ClaudeCode {
        let Some(bytes) = read(&handle, "plugins/installed_plugins.json")? else {
            return Ok(PluginMigrationCatalog {
                candidates,
                issues: vec!["plugin_install_index_missing".into()],
            });
        };
        let settings = read(&handle, "settings.json")?;
        if let Some(uploaded) = uploaded {
            uploaded.verify_file_set(
                std::iter::once((
                    canonical.join("plugins/installed_plugins.json"),
                    bytes.as_slice(),
                ))
                .chain(
                    settings
                        .as_deref()
                        .map(|bytes| (canonical.join("settings.json"), bytes)),
                ),
            )?;
        }
        let document = json(&bytes)?;
        ensure!(
            document.get("version").and_then(Value::as_u64) == Some(2),
            "plugin_migration_unsupported_index"
        );
        let plugins = document
            .get("plugins")
            .and_then(Value::as_object)
            .context("plugin_migration_invalid_index")?;
        ensure!(
            plugins.len() <= 256,
            "plugin_migration_index_budget_exceeded"
        );
        let enabled = settings.as_deref().map(json).transpose()?;
        let mut secrets = crate::adapters::secret_values(&document);
        if let Some(settings) = &enabled {
            secrets.extend(crate::adapters::secret_values(settings));
        }
        for (source_id, values) in plugins {
            if cancel.is_cancelled() {
                anyhow::bail!("plugin_migration_cancelled")
            }
            if safe(source_id, &secrets).is_none() {
                issues.push("plugin_private_index_fields_pending".into());
                continue;
            }
            let Ok(plugin_id) = source_id.parse::<PluginId>() else {
                issues.push("plugin_install_identity_pending".into());
                continue;
            };
            let entries = values
                .as_array()
                .context("plugin_migration_invalid_index")?;
            ensure!(
                entries.len() <= 64 && candidates.len() + entries.len() <= 512,
                "plugin_migration_index_budget_exceeded"
            );
            for (index, entry) in entries.iter().enumerate() {
                let scope = entry
                    .get("scope")
                    .and_then(Value::as_str)
                    .filter(|v| matches!(*v, "user" | "project" | "local" | "managed"))
                    .unwrap_or("unknown");
                let source_project = if matches!(scope, "project" | "local") {
                    project.filter(|project| {
                        entry
                            .get("projectPath")
                            .and_then(Value::as_str)
                            .is_some_and(|path| project.matches(Path::new(path)))
                    })
                } else {
                    None
                };
                if project.is_some()
                    && matches!(scope, "project" | "local")
                    && source_project.is_none()
                {
                    continue;
                }
                let version = entry.get("version").and_then(Value::as_str).unwrap_or("");
                let mut pending = Vec::new();
                if scope != "user" {
                    pending.push(
                        if matches!(scope, "project" | "local") {
                            "plugin_project_mapping_required"
                        } else {
                            "plugin_scope_pending"
                        }
                        .into(),
                    );
                }
                if !entry.as_object().is_some_and(|map| {
                    map.keys().all(|key| {
                        [
                            "scope",
                            "projectPath",
                            "installPath",
                            "version",
                            "installedAt",
                            "lastUpdated",
                            "gitCommitSha",
                            "isLocal",
                        ]
                        .contains(&key.as_str())
                    })
                }) {
                    pending.push("plugin_install_fields_pending".into());
                }
                let expected = PathBuf::from("plugins/cache")
                    .join(plugin_id.marketplace_name())
                    .join(plugin_id.plugin_name())
                    .join(version);
                let actual = entry
                    .get("installPath")
                    .and_then(Value::as_str)
                    .map(Path::new);
                if !segment(version)
                    || safe(version, &secrets).is_none()
                    || uploaded.is_none()
                        && !actual.is_some_and(|declared| {
                            installed_directory_matches(&handle, declared, &expected)
                                .unwrap_or(false)
                        })
                {
                    pending.push("plugin_install_path_requires_grant".into());
                }
                if pending.is_empty() && directory(&handle, &expected).is_err() {
                    pending.push("plugin_install_payload_missing_or_unsafe".into());
                }
                let binding = (!pending.iter().any(|code| {
                    code == "plugin_install_path_requires_grant"
                        || code == "plugin_install_payload_missing_or_unsafe"
                }))
                .then(|| Source {
                    root: canonical.clone(),
                    identity: identity.clone(),
                    kind,
                    source_id: source_id.clone(),
                    version: version.into(),
                    relative: expected,
                    metadata: vec![
                        ("plugins/installed_plugins.json".into(), Some(hash(&bytes))),
                        ("settings.json".into(), settings.as_deref().map(hash)),
                    ],
                    cache_listing: None,
                    source_scope: scope.into(),
                    project: source_project.cloned().map(Box::new),
                    received: None,
                    uploaded: uploaded.cloned().map(Box::new),
                });
                candidates.push(PluginMigrationCandidate {
                    id: if let Some(project) = source_project {
                        sha(&(
                            identity.as_str(),
                            source_id,
                            index,
                            hash(&bytes),
                            project.revision()?,
                        ))?
                    } else {
                        sha(&(identity.as_str(), source_id, index, hash(&bytes)))?
                    },
                    source: kind,
                    name: safe(plugin_id.plugin_name(), &secrets)
                        .unwrap_or_else(|| "plugin".into()),
                    installed_version: safe(version, &secrets),
                    scope: scope.into(),
                    source_enabled: if uploaded.is_some() && scope != "user" {
                        None
                    } else if let Some(project) = source_project {
                        project.enabled(scope, source_id)?
                    } else {
                        enabled
                            .as_ref()
                            .and_then(|v| v.get("enabledPlugins"))
                            .and_then(|v| v.get(source_id))
                            .and_then(Value::as_bool)
                    },
                    pending,
                    binding,
                });
            }
        }
    } else {
        let user_configuration = read(&handle, "config.toml")?;
        if user_configuration.is_none() && project.is_none() {
            return Ok(PluginMigrationCatalog {
                candidates,
                issues: vec!["plugin_install_index_missing".into()],
            });
        }
        let bytes = user_configuration.as_deref().unwrap_or_default();
        if let (Some(uploaded), Some(bytes)) = (uploaded, user_configuration.as_deref()) {
            uploaded.verify_bytes(&canonical.join("config.toml"), bytes)?;
        }
        let document: toml::Value = std::str::from_utf8(bytes)
            .ok()
            .and_then(|text| toml::from_str(text).ok())
            .context("plugin_migration_invalid_index")?;
        let secret_document = serde_json::to_value(&document)?;
        let secrets = crate::adapters::secret_values(&secret_document);
        if let Some(plugins) = document.get("plugins").and_then(toml::Value::as_table) {
            ensure!(
                plugins.len() <= 256,
                "plugin_migration_index_budget_exceeded"
            );
            for (source_id, entry) in plugins {
                if safe(source_id, &secrets).is_none() {
                    issues.push("plugin_private_index_fields_pending".into());
                    continue;
                }
                let Ok(plugin_id) = source_id.parse::<PluginId>() else {
                    issues.push("plugin_install_identity_pending".into());
                    continue;
                };
                let mut pending = Vec::new();
                if !entry.as_table().is_some_and(|table| {
                    table.keys().all(|key| key == "enabled")
                        && table.get("enabled").is_none_or(toml::Value::is_bool)
                }) {
                    pending.push("plugin_install_policy_pending".into());
                }
                let base = PathBuf::from("plugins/cache")
                    .join(plugin_id.marketplace_name())
                    .join(plugin_id.plugin_name());
                let versions = match versions(&handle, &base) {
                    Ok(versions) => versions,
                    Err(_) => {
                        pending.push("plugin_install_payload_missing_or_unsafe".into());
                        vec![]
                    }
                };
                let version = active(&versions).filter(|version| safe(version, &secrets).is_some());
                if version.is_none() {
                    pending.push("plugin_install_payload_missing_or_unsafe".into());
                }
                let binding = version.as_ref().map(|version| Source {
                    root: canonical.clone(),
                    identity: identity.clone(),
                    kind,
                    source_id: source_id.clone(),
                    version: version.clone(),
                    relative: base.join(version),
                    metadata: vec![(
                        "config.toml".into(),
                        user_configuration.as_deref().map(hash),
                    )],
                    cache_listing: sha(&versions).ok(),
                    source_scope: "user".into(),
                    project: None,
                    received: None,
                    uploaded: uploaded.cloned().map(Box::new),
                });
                candidates.push(PluginMigrationCandidate {
                    id: sha(&(identity.as_str(), source_id, hash(bytes)))?,
                    source: kind,
                    name: safe(plugin_id.plugin_name(), &secrets)
                        .unwrap_or_else(|| "plugin".into()),
                    installed_version: version,
                    scope: "user".into(),
                    source_enabled: entry
                        .get("enabled")
                        .map(toml::Value::as_bool)
                        .unwrap_or(Some(true)),
                    pending,
                    binding,
                });
            }
        }
    }
    if let Some(project) = project {
        if kind == MigrationSourceKind::Codex {
            candidates.extend(project.codex_candidates(&handle, &canonical)?);
        }
        project.verify()?;
    }
    ensure!(
        PrivateDirectory::open_existing(root)?.directory_identity()? == identity,
        "plugin_migration_source_changed"
    );
    Ok(PluginMigrationCatalog { candidates, issues })
}
