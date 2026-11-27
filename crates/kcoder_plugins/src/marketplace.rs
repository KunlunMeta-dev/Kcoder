use crate::{PluginId, load_plugin_manifest};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const MAX_MARKETPLACE_BYTES: u64 = 1024 * 1024;
const MARKETPLACE_LAYOUTS: [&str; 6] = [
    ".agents/plugins/marketplace.json",
    ".agents/plugins/api_marketplace.json",
    ".claude-plugin/marketplace.json",
    ".cursor-plugin/marketplace.json",
    ".grok-plugin/marketplace.json",
    ".codebuddy-plugin/marketplace.json",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum SourcePathPolicy {
    LocalCatalog,
    ConfinedSnapshot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MarketplaceManifest {
    #[serde(default)]
    pub diagnostics: Vec<String>,
    pub name: String,
    pub path: PathBuf,
    pub root: PathBuf,
    pub display_name: Option<String>,
    pub plugins: Vec<MarketplaceEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MarketplaceEntry {
    pub plugin_id: PluginId,
    pub source: PluginSource,
    pub version: Option<String>,
    pub install_policy: InstallPolicy,
    pub auth_policy: AuthPolicy,
    pub manifest_fallback: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum PluginSource {
    Trae {
        id: String,
        version: String,
    },
    Qoder {
        id: String,
    },
    Local {
        path: PathBuf,
    },
    Git {
        url: String,
        path: Option<String>,
        ref_name: Option<String>,
        sha: Option<String>,
    },
    Npm {
        package: String,
        version: Option<String>,
        registry: Option<String>,
        integrity: Option<String>,
    },
    Bundled {
        bundle: String,
        digest: String,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum InstallPolicy {
    #[serde(rename = "NOT_AVAILABLE", alias = "not_available")]
    NotAvailable,
    #[default]
    #[serde(rename = "AVAILABLE", alias = "available")]
    Available,
    #[serde(rename = "INSTALLED_BY_DEFAULT", alias = "installed_by_default")]
    InstalledByDefault,
}

impl InstallPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotAvailable => "not_available",
            Self::Available => "available",
            Self::InstalledByDefault => "installed_by_default",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum AuthPolicy {
    #[default]
    #[serde(rename = "ON_INSTALL", alias = "on_install")]
    OnInstall,
    #[serde(rename = "ON_USE", alias = "on_use")]
    OnUse,
}

impl AuthPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OnInstall => "on_install",
            Self::OnUse => "on_use",
        }
    }
}

pub fn load_marketplace_manifest(path: &Path) -> Result<MarketplaceManifest> {
    load_marketplace_manifest_with_policy(path, SourcePathPolicy::LocalCatalog, None)
}

pub(crate) fn load_marketplace_manifest_confined(path: &Path) -> Result<MarketplaceManifest> {
    load_marketplace_manifest_with_policy(path, SourcePathPolicy::ConfinedSnapshot, None)
}

/// Load a configured marketplace using its actual storage location as provenance.
/// A snapshot directly beneath the private marketplace store is always confined,
/// regardless of origin metadata stored inside that snapshot.
pub(crate) fn load_marketplace_manifest_for_store(
    path: &Path,
    store_root: &Path,
) -> Result<MarketplaceManifest> {
    load_marketplace_manifest_with_policy(path, SourcePathPolicy::LocalCatalog, Some(store_root))
}

pub(crate) fn is_managed_snapshot_root(root: &Path, store_root: &Path) -> Result<bool> {
    let managed_parent = match dunce::canonicalize(store_root.join("marketplaces")) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(error).context("failed to resolve managed marketplace directory");
        }
    };
    let canonical_root = dunce::canonicalize(root)
        .with_context(|| format!("failed to resolve marketplace root {}", root.display()))?;
    Ok(canonical_root.parent() == Some(managed_parent.as_path()))
}

fn load_marketplace_manifest_with_policy(
    path: &Path,
    requested_source_path_policy: SourcePathPolicy,
    store_root: Option<&Path>,
) -> Result<MarketplaceManifest> {
    let path = resolve_marketplace_manifest_path(dunce::simplified(path))?;
    ensure_regular_file_without_symlink(&path)?;
    let canonical_path = dunce::canonicalize(&path)
        .with_context(|| format!("failed to resolve marketplace {}", path.display()))?;
    let (root, layout) = marketplace_root_and_layout(&canonical_path)?;
    let source_path_policy = if let Some(store_root) = store_root {
        if is_managed_snapshot_root(&root, store_root)? {
            SourcePathPolicy::ConfinedSnapshot
        } else {
            SourcePathPolicy::LocalCatalog
        }
    } else {
        requested_source_path_policy
    };
    let mut file = fs::File::open(&canonical_path)
        .with_context(|| format!("failed to open marketplace {}", canonical_path.display()))?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_MARKETPLACE_BYTES + 1)
        .read_to_end(&mut bytes)
        .context("failed to read marketplace manifest")?;
    if bytes.len() as u64 > MAX_MARKETPLACE_BYTES {
        bail!("marketplace manifest exceeds {MAX_MARKETPLACE_BYTES} bytes");
    }
    let raw: RawMarketplaceManifest =
        serde_json::from_slice(&bytes).context("invalid marketplace manifest JSON")?;
    PluginId::new("validation", &raw.name).context("marketplace manifest has an invalid name")?;
    let mut seen = BTreeSet::new();
    let mut plugins = Vec::with_capacity(raw.plugins.len());
    let mut diagnostics = Vec::new();
    for mut raw_plugin in raw.plugins {
        let name = raw_plugin.name.clone();
        if !seen.insert(name.clone()) {
            bail!("marketplace contains duplicate plugin entry {name}");
        }
        let parsed: Result<MarketplaceEntry> = (|| {
            let mut install_policy = raw_plugin.policy.installation;
            let mut installation_issue: Option<(&str, String)> = None;
            let mut missing_credential_names = Vec::new();
            let plugin_id = PluginId::new(&raw_plugin.name, &raw.name)
                .context("marketplace entry has an invalid plugin identity")?;

            let source = resolve_source(&root, layout, raw_plugin.source, source_path_policy)?;
            if let PluginSource::Local { path } = &source {
                match load_plugin_manifest(path).map_err(anyhow::Error::from)? {
                    Some(loaded) => {
                        // Catalogs may keep presentation metadata only in each plugin.
                        let interface = loaded.manifest.interface.as_ref();
                        for (key, value) in [
                            ("version", loaded.manifest.version.as_ref()),
                            (
                                "displayName",
                                interface.and_then(|value| value.display_name.as_ref()),
                            ),
                            (
                                "description",
                                interface
                                    .and_then(|value| value.short_description.as_ref())
                                    .or(loaded.manifest.description.as_ref()),
                            ),
                        ] {
                            if let Some(value) = value {
                                raw_plugin
                                    .manifest_fields
                                    .entry(key.to_owned())
                                    .or_insert_with(|| Value::String(value.clone()));
                            }
                        }
                        let mut compatibility = loaded.compatibility.clone();
                        let mcp_check = crate::contributions::mcp::preflight_manifest_with_env(
                            &plugin_id.to_string(),
                            path,
                            &loaded.manifest,
                            |name| std::env::var(name).ok(),
                        )
                        .and_then(|outcome| {
                            if outcome.configs.is_empty() && !outcome.warnings.is_empty() {
                                return Err(outcome.warnings.join("; "));
                            }
                            for warning in outcome.warnings {
                                compatibility.add_issue(
                                    "invalid_mcp_server",
                                    Some("mcp_servers"),
                                    warning,
                                );
                            }
                            Ok(())
                        });
                        if let Err(message) = mcp_check {
                            if message.starts_with("MCP environment variable `")
                                || message.starts_with("MCP connector credential `")
                            {
                                missing_credential_names =
                                    crate::contributions::mcp::required_manifest_environment_names(
                                        path,
                                        &loaded.manifest,
                                    )
                                    .unwrap_or_default()
                                    .into_iter()
                                    .filter(|name| {
                                        std::env::var(name)
                                            .map_or(true, |value| value.trim().is_empty())
                                    })
                                    .collect();
                            }
                            compatibility.defer_capability(
                                "mcp_servers",
                                "invalid_mcp_config",
                                message.clone(),
                            );
                            if compatibility.supported_capabilities.is_empty() {
                                installation_issue = Some(("installation_configuration", message));
                            }
                        }
                        if compatibility.supported_capabilities.is_empty() {
                            install_policy = InstallPolicy::NotAvailable;
                            installation_issue.get_or_insert_with(|| {
                                if compatibility.deferred_capabilities.is_empty() {
                                    ("installation_no_components", "The package does not declare any components supported by the current runtime. It cannot provide usable tools or skills after installation.".into())
                                } else {
                                    ("installation_unsupported", format!("Only unsupported plugin capabilities are declared: {}", compatibility.deferred_capabilities.join(", ")))
                                }
                            });
                        }
                        raw_plugin.manifest_fields.insert(
                            "compatibility".into(),
                            serde_json::json!({
                                "level": compatibility.level.as_str(),
                                "supportedCapabilities": compatibility.supported_capabilities,
                                "deferredCapabilities": compatibility.deferred_capabilities,
                                "issues": compatibility.issues,
                            }),
                        );
                        let manifest_name = loaded
                            .manifest
                            .id
                            .as_deref()
                            .unwrap_or(&loaded.manifest.name);
                        let name_alias = loaded.manifest.id.is_none();
                        if manifest_name != plugin_id.plugin_name() && !name_alias {
                            bail!(
                                "marketplace plugin {} does not match manifest identity {}",
                                plugin_id.plugin_name(),
                                manifest_name
                            );
                        }
                    }
                    None if !raw_plugin.strict
                        && raw_plugin
                            .manifest_fields
                            .get("skills")
                            .is_some_and(Value::is_array) => {}
                    None if !raw_plugin.strict || has_conventional_skill(path)? => {
                        install_policy = InstallPolicy::NotAvailable;
                    }
                    None => {
                        install_policy = InstallPolicy::NotAvailable;
                        installation_issue = Some((
                            "installation_missing_manifest",
                            format!(
                                "Local marketplace plugin {} has no supported manifest",
                                plugin_id.plugin_name()
                            ),
                        ));
                    }
                }
            }
            let mut fallback_fields = raw_plugin.manifest_fields.clone();
            fallback_fields.insert("strict".into(), Value::Bool(raw_plugin.strict));
            let fallback = Some(Value::Object(fallback_fields));
            let version = raw_plugin
                .manifest_fields
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_string);
            let mut entry = MarketplaceEntry {
                plugin_id,
                source,
                version,
                install_policy,
                auth_policy: raw_plugin.policy.authentication,
                manifest_fallback: fallback,
            };
            if let Some((code, message)) = installation_issue {
                crate::marketplace_availability::unavailable(&mut entry, code, &message);
                if code == "installation_configuration"
                    && (message.starts_with("MCP environment variable `")
                        || message.starts_with("MCP connector credential `"))
                {
                    entry.manifest_fallback.as_mut().unwrap()["installationAvailability"] = serde_json::json!({
                        "category":"credentials", "retryable":false, "originalInstallPolicy":raw_plugin.policy.installation,
                        "missingNames": missing_credential_names
                    });
                }
            }
            crate::marketplace_availability::apply(&mut entry);
            Ok(entry)
        })();
        match parsed {
            Ok(plugin) => plugins.push(plugin),
            Err(error) => diagnostics.push(format!("Plugin {name} is unavailable: {error:#}")),
        }
    }
    Ok(MarketplaceManifest {
        diagnostics,
        name: raw.name,
        path: canonical_path,
        root,
        display_name: raw.interface.and_then(|interface| interface.display_name),
        plugins,
    })
}

fn has_conventional_skill(root: &Path) -> Result<bool> {
    let skills = root.join("skills");
    let metadata = match fs::symlink_metadata(&skills) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(false);
    }
    for entry in fs::read_dir(&skills)? {
        let entry = entry?;
        let path = entry.path().join("SKILL.md");
        if fs::symlink_metadata(path)
            .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn find_marketplace_manifest_path(root: &Path) -> Option<PathBuf> {
    MARKETPLACE_LAYOUTS
        .iter()
        .map(|relative| root.join(relative))
        .find(|candidate| {
            fs::symlink_metadata(candidate)
                .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        })
}

fn resolve_marketplace_manifest_path(path: &Path) -> Result<PathBuf> {
    if path.is_dir() {
        return find_marketplace_manifest_path(path).with_context(|| {
            format!(
                "no supported marketplace manifest was found under {}",
                path.display()
            )
        });
    }
    Ok(path.to_path_buf())
}

fn marketplace_root_and_layout(path: &Path) -> Result<(PathBuf, &'static str)> {
    for layout in MARKETPLACE_LAYOUTS {
        if path.ends_with(layout) {
            let component_count = Path::new(layout).components().count();
            let mut root = path.to_path_buf();
            for _ in 0..component_count {
                root.pop();
            }
            return Ok((root, layout));
        }
    }
    bail!(
        "marketplace manifest must use one of the supported layouts: {}",
        MARKETPLACE_LAYOUTS.join(", ")
    )
}

fn resolve_source(
    root: &Path,
    layout: &str,
    source: RawPluginSource,
    source_path_policy: SourcePathPolicy,
) -> Result<PluginSource> {
    match source {
        RawPluginSource::Object(RawPluginSourceObject::Trae { id, version }) => {
            crate::hosted::validate_id(&id)?;
            crate::hosted::trae::validate_version(&version)?;
            Ok(PluginSource::Trae { id, version })
        }
        RawPluginSource::Object(RawPluginSourceObject::Qoder { id }) => {
            crate::hosted::validate_id(&id)?;
            Ok(PluginSource::Qoder { id })
        }
        RawPluginSource::Path(path) => {
            if !layout.starts_with(".cursor-plugin/") && !path.starts_with("./") {
                bail!("local plugin source path must start with './'");
            }
            resolve_local_source(root, &path, source_path_policy)
        }
        RawPluginSource::GrokLocal(RawGrokLocalSource { path, .. }) => {
            resolve_local_source(root, &path, source_path_policy)
        }
        RawPluginSource::Object(RawPluginSourceObject::Local { path }) => {
            resolve_local_source(root, &path, source_path_policy)
        }
        RawPluginSource::Object(RawPluginSourceObject::Url {
            url,
            path,
            ref_name,
            sha,
        }) => {
            let url = validate_git_url(&url)?;
            ensure_marketplace_git_source_allowed(&url, source_path_policy)?;
            Ok(PluginSource::Git {
                url,
                path: normalize_optional_relative(path, "git source path")?,
                ref_name: trim_optional(ref_name),
                sha: trim_optional(sha),
            })
        }
        RawPluginSource::Object(RawPluginSourceObject::GitSubdir {
            url,
            path,
            ref_name,
            sha,
        }) => {
            let url = validate_git_url(&url)?;
            ensure_marketplace_git_source_allowed(&url, source_path_policy)?;
            Ok(PluginSource::Git {
                url,
                path: Some(normalize_relative(&path, "git source path")?),
                ref_name: trim_optional(ref_name),
                sha: trim_optional(sha),
            })
        }
        RawPluginSource::Object(RawPluginSourceObject::Npm {
            package,
            version,
            registry,
            integrity,
        }) => Ok(PluginSource::Npm {
            package: validate_npm_package(&package)?,
            version: trim_optional(version),
            registry: registry
                .map(|registry| validate_registry_url(&registry))
                .transpose()?,
            integrity: trim_optional(integrity),
        }),
        RawPluginSource::Unsupported(serde::de::IgnoredAny) => {
            bail!(
                "unsupported marketplace plugin source format; use a supported local, Git, hosted, or npm source"
            )
        }
    }
}

fn ensure_marketplace_git_source_allowed(
    url: &str,
    source_path_policy: SourcePathPolicy,
) -> Result<()> {
    if source_path_policy == SourcePathPolicy::ConfinedSnapshot
        && (url.starts_with("file://") || Path::new(url).is_absolute())
    {
        bail!("managed marketplace Git sources must use HTTPS URLs");
    }
    Ok(())
}

fn resolve_local_source(
    root: &Path,
    value: &str,
    source_path_policy: SourcePathPolicy,
) -> Result<PluginSource> {
    let value = value.trim();
    if value.is_empty() {
        bail!("local plugin source path must not be empty");
    }
    let declared = Path::new(value);
    let candidate = if matches!(value, "." | "./") {
        // Marketplace authors may publish a plugin from the repository root.
        // Keep this exact exception local; nested paths still reject traversal.
        root.to_path_buf()
    } else if declared.is_absolute() {
        declared.to_path_buf()
    } else {
        let relative = value.strip_prefix("./").unwrap_or(value);
        validate_relative(Path::new(relative), "local plugin source path")?;
        root.join(relative)
    };
    let canonical = dunce::canonicalize(&candidate).context(
        "local plugin source path could not be resolved; verify that it exists and is accessible",
    )?;
    if source_path_policy == SourcePathPolicy::ConfinedSnapshot || !declared.is_absolute() {
        let canonical_root = dunce::canonicalize(root)
            .with_context(|| format!("failed to resolve marketplace root {}", root.display()))?;
        if !canonical.starts_with(&canonical_root) {
            bail!("local plugin source escapes the marketplace root");
        }
    }
    if !canonical.is_dir() {
        bail!("local plugin source is not a directory");
    }
    Ok(PluginSource::Local { path: canonical })
}

fn normalize_optional_relative(value: Option<String>, field: &str) -> Result<Option<String>> {
    value
        .map(|value| normalize_relative(&value, field))
        .transpose()
}

fn normalize_relative(value: &str, field: &str) -> Result<String> {
    let value = value.trim().strip_prefix("./").unwrap_or(value.trim());
    validate_relative(Path::new(value), field)?;
    Ok(value.to_string())
}

fn validate_relative(path: &Path, field: &str) -> Result<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || !path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        bail!("{field} must be a normalized relative path");
    }
    Ok(())
}

fn validate_npm_package(value: &str) -> Result<String> {
    let value = value.trim();
    let body = value.strip_prefix('@').unwrap_or(value);
    let parts = body.split('/').collect::<Vec<_>>();
    let expected = if value.starts_with('@') { 2 } else { 1 };
    if value.is_empty()
        || parts.len() != expected
        || parts.iter().any(|part| {
            part.is_empty()
                || matches!(*part, "." | "..")
                || !part.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
                })
        })
    {
        bail!("invalid npm package name {value:?}");
    }
    Ok(value.to_string())
}

fn trim_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn validate_git_url(value: &str) -> Result<String> {
    let value = value.trim();
    if value.starts_with("https://") {
        let url = url::Url::parse(value).context("invalid HTTPS Git source URL")?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("Git source URL may not contain credentials, query, or fragment");
        }
        return Ok(url.to_string());
    }
    if value.starts_with("file://") || Path::new(value).is_absolute() {
        return Ok(value.to_string());
    }
    bail!("Git source URL must use credential-free HTTPS, file://, or an absolute local path")
}

fn validate_registry_url(value: &str) -> Result<String> {
    let url = url::Url::parse(value).context("invalid npm registry URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("npm registry URL must be credential-free HTTP(S)");
    }
    Ok(url.to_string())
}

fn ensure_regular_file_without_symlink(path: &Path) -> Result<()> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        current.push(component.as_os_str());
        // Inspect a Windows volume/share only after RootDir completes its
        // prefix. A bare `C:` is drive-relative; `\\?\C:` is not a directory.
        if matches!(component, std::path::Component::Prefix(_)) {
            continue;
        }
        let metadata = fs::symlink_metadata(&current)
            .with_context(|| format!("failed to inspect marketplace path {}", current.display()))?;
        if metadata.file_type().is_symlink() {
            bail!("marketplace path may not traverse a symbolic link");
        }
    }
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect marketplace {}", path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("marketplace manifest must be an ordinary file");
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMarketplaceManifest {
    name: String,
    #[serde(default)]
    interface: Option<RawMarketplaceInterface>,
    plugins: Vec<RawMarketplacePlugin>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMarketplaceInterface {
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMarketplacePlugin {
    name: String,
    source: RawPluginSource,
    #[serde(default)]
    policy: RawPluginPolicy,
    #[serde(default = "default_strict")]
    strict: bool,
    #[serde(default, flatten)]
    manifest_fields: Map<String, Value>,
}

fn default_strict() -> bool {
    true
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPluginPolicy {
    #[serde(default)]
    installation: InstallPolicy,
    #[serde(default)]
    authentication: AuthPolicy,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawPluginSource {
    Path(String),
    Object(RawPluginSourceObject),
    GrokLocal(RawGrokLocalSource),
    Unsupported(serde::de::IgnoredAny),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawGrokLocalSource {
    #[serde(rename = "type")]
    _kind: GrokLocalKind,
    path: String,
}

#[derive(Debug, Deserialize)]
enum GrokLocalKind {
    #[serde(rename = "local")]
    Local,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "source", rename_all = "lowercase")]
enum RawPluginSourceObject {
    Trae {
        id: String,
        version: String,
    },
    Qoder {
        id: String,
    },
    Local {
        path: String,
    },
    Url {
        url: String,
        path: Option<String>,
        #[serde(rename = "ref")]
        ref_name: Option<String>,
        sha: Option<String>,
    },
    #[serde(rename = "git-subdir")]
    GitSubdir {
        url: String,
        path: String,
        #[serde(rename = "ref")]
        ref_name: Option<String>,
        sha: Option<String>,
    },
    Npm {
        package: String,
        version: Option<String>,
        registry: Option<String>,
        integrity: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn repository_root_plugin_source_does_not_allow_parent_traversal() {
        let temp = TempDir::new().unwrap();
        for source in [".", "./"] {
            let PluginSource::Local { path } =
                resolve_local_source(temp.path(), source, SourcePathPolicy::LocalCatalog).unwrap()
            else {
                panic!("expected local source")
            };
            assert_eq!(path, dunce::canonicalize(temp.path()).unwrap());
        }
        for source in ["", "../", "./../", "sub/../", "./sub/../../"] {
            assert!(
                resolve_local_source(temp.path(), source, SourcePathPolicy::LocalCatalog).is_err(),
                "{source}"
            );
        }
    }

    fn write_marketplace(root: &Path, source: Value) -> PathBuf {
        write_marketplace_entries(
            root,
            serde_json::json!([{"name": "outside", "source": source}]),
        )
    }

    fn write_marketplace_entries(root: &Path, plugins: Value) -> PathBuf {
        let path = root.join(".agents/plugins/marketplace.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            serde_json::json!({
                "name": "source-boundary",
                "plugins": plugins
            })
            .to_string(),
        )
        .unwrap();
        path
    }

    #[test]
    fn unsupported_source_diagnostics_do_not_echo_credentials_and_keep_valid_entries() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();
        write_local_plugin(root, "good");
        let userinfo = "https://catalog-user:catalog-password@example.invalid";
        let bearer = "Bearer catalog-literal-token";
        let manifest_path = write_marketplace_entries(
            root,
            serde_json::json!([
                {
                    "name": "future-source",
                    "source": {
                        "source": "future-kind",
                        "url": userinfo,
                        "authorization": bearer
                    }
                },
                {"name": "good", "source": "./plugins/good"}
            ]),
        );

        let manifest = load_marketplace_manifest(&manifest_path).unwrap();
        assert_eq!(manifest.plugins.len(), 1);
        assert_eq!(
            manifest.plugins[0].plugin_id.to_string(),
            "good@source-boundary"
        );
        assert_eq!(manifest.diagnostics.len(), 1);
        let manifest_diagnostic = &manifest.diagnostics[0];
        assert!(manifest_diagnostic.contains("unsupported marketplace plugin source format"));
        assert!(manifest_diagnostic.contains("supported local, Git, hosted, or npm source"));
        assert!(!manifest_diagnostic.contains(userinfo));
        assert!(!manifest_diagnostic.contains(bearer));

        let manager = crate::PluginManager::from_store(
            crate::PluginStore::open(&root.join("profile/plugin_store")).unwrap(),
        );
        let listing = manager.marketplace_list(root, true).unwrap();
        let projected = listing
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == "marketplace_entry_unavailable")
            .unwrap();
        assert_eq!(projected.message, *manifest_diagnostic);
        let serialized_listing = serde_json::to_string(&listing).unwrap();
        assert!(!serialized_listing.contains(userinfo));
        assert!(!serialized_listing.contains(bearer));
        assert!(
            listing
                .marketplaces
                .iter()
                .find(|marketplace| marketplace.id == "source-boundary")
                .is_some_and(|marketplace| marketplace
                    .plugins
                    .iter()
                    .any(|plugin| plugin.plugin_id.to_string() == "good@source-boundary"))
        );
    }

    #[test]
    fn url_like_local_source_diagnostics_do_not_echo_userinfo() {
        let temp = TempDir::new().unwrap();
        let userinfo = "https://catalog-user:catalog-password@example.invalid/x";
        for (case, layout, source) in [
            (
                "cursor-bare-url",
                ".cursor-plugin/marketplace.json",
                userinfo.to_string(),
            ),
            (
                "explicit-local-url",
                ".agents/plugins/marketplace.json",
                format!("./{userinfo}"),
            ),
        ] {
            let root = temp.path().join(case);
            let manifest_path = root.join(layout);
            fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
            fs::write(
                &manifest_path,
                serde_json::json!({
                    "name": case,
                    "plugins": [{"name": "credential-path", "source": source}]
                })
                .to_string(),
            )
            .unwrap();

            let manifest = load_marketplace_manifest(&manifest_path).unwrap();
            assert_eq!(manifest.diagnostics.len(), 1);
            let diagnostic = &manifest.diagnostics[0];
            assert!(diagnostic.contains("Plugin credential-path is unavailable"));
            assert!(diagnostic.contains("local plugin source path could not be resolved"));
            assert!(!diagnostic.contains(userinfo));

            let manager = crate::PluginManager::from_store(
                crate::PluginStore::open(&root.join("profile/plugin_store")).unwrap(),
            );
            let listing = manager.marketplace_list(&root, true).unwrap();
            let projected = listing
                .diagnostics
                .iter()
                .find(|entry| entry.code == "marketplace_entry_unavailable")
                .unwrap();
            assert!(
                projected
                    .message
                    .contains("Plugin credential-path is unavailable")
            );
            assert!(
                projected
                    .message
                    .contains("local plugin source path could not be resolved")
            );
            assert!(!projected.message.contains(userinfo));
            assert!(!serde_json::to_string(&listing).unwrap().contains(userinfo));
        }
    }

    #[test]
    fn managed_snapshots_confine_absolute_local_sources_but_local_catalogs_keep_them() {
        let temp = TempDir::new().unwrap();
        let store = temp.path().join("store");
        let managed_root = store.join("marketplaces/snapshot-one");
        let local_root = temp.path().join("local-catalog");
        let outside_root = temp.path().join("plugins/outside");
        write_local_plugin(temp.path(), "outside");
        fs::create_dir_all(&managed_root).unwrap();
        fs::create_dir_all(&local_root).unwrap();
        fs::create_dir_all(store.join("marketplaces")).unwrap();

        let source = serde_json::json!({
            "source": "local",
            "path": outside_root.to_string_lossy()
        });
        write_local_plugin(&managed_root, "good");
        let entries = serde_json::json!([
            {"name": "outside", "source": source.clone()},
            {"name": "good", "source": "./plugins/good"}
        ]);
        let managed_manifest = write_marketplace_entries(&managed_root, entries.clone());
        // Origin data is untrusted and must not grant the managed snapshot local-source access.
        fs::write(
            managed_root.join(".kcoder-marketplace-origin.json"),
            br#"{"type":"local","canonical_path":"/untrusted"}"#,
        )
        .unwrap();
        for loaded in [
            load_marketplace_manifest_for_store(&managed_manifest, &store).unwrap(),
            load_marketplace_manifest_confined(&managed_manifest).unwrap(),
        ] {
            assert_eq!(loaded.plugins.len(), 1);
            assert_eq!(
                loaded.plugins[0].plugin_id.to_string(),
                "good@source-boundary"
            );
            assert_eq!(loaded.diagnostics.len(), 1);
            assert!(loaded.diagnostics[0].contains("Plugin outside is unavailable"));
            assert!(loaded.diagnostics[0].contains("escapes the marketplace root"));
        }

        let local_manifest = write_marketplace(&local_root, source);
        let loaded = load_marketplace_manifest(&local_manifest).unwrap();
        assert!(matches!(
            &loaded.plugins[0].source,
            PluginSource::Local { path } if path == &outside_root
        ));
        let loaded = load_marketplace_manifest_for_store(&local_manifest, &store).unwrap();
        assert!(matches!(
            &loaded.plugins[0].source,
            PluginSource::Local { path } if path == &outside_root
        ));
        let empty_store = temp.path().join("empty-store");
        let loaded = load_marketplace_manifest_for_store(&local_manifest, &empty_store).unwrap();
        assert!(matches!(
            &loaded.plugins[0].source,
            PluginSource::Local { path } if path == &outside_root
        ));

        let in_root = managed_root.join("plugins/outside");
        write_local_plugin(&managed_root, "outside");
        let inside_manifest = write_marketplace(
            &managed_root,
            serde_json::json!({"source":"local", "path":in_root.to_string_lossy()}),
        );
        let loaded = load_marketplace_manifest_confined(&inside_manifest).unwrap();
        assert!(matches!(
            &loaded.plugins[0].source,
            PluginSource::Local { path } if path == &dunce::canonicalize(in_root).unwrap()
        ));
    }

    #[test]
    fn confined_marketplaces_reject_file_and_absolute_local_git_sources() {
        let temp = TempDir::new().unwrap();
        let store = temp.path().join("store");
        fs::create_dir_all(store.join("marketplaces")).unwrap();
        let repository = temp.path().join("repo.git");
        let file_url = url::Url::from_file_path(&repository).unwrap().to_string();
        for (index, url) in [
            ("file-url", file_url),
            ("absolute-url", repository.display().to_string()),
        ] {
            let root = store.join("marketplaces").join(index);
            fs::create_dir_all(&root).unwrap();
            write_local_plugin(&root, "good");
            let manifest = write_marketplace_entries(
                &root,
                serde_json::json!([
                    {"name":"blocked", "source":{"source":"url", "url":url}},
                    {"name":"good", "source":"./plugins/good"}
                ]),
            );
            let loaded = load_marketplace_manifest_for_store(&manifest, &store).unwrap();
            assert_eq!(loaded.plugins.len(), 1);
            assert_eq!(
                loaded.plugins[0].plugin_id.to_string(),
                "good@source-boundary"
            );
            assert_eq!(loaded.diagnostics.len(), 1);
            assert!(loaded.diagnostics[0].contains("Plugin blocked is unavailable"));
            assert!(
                loaded.diagnostics[0].contains("managed marketplace Git sources must use HTTPS")
            );

            let local_catalog = load_marketplace_manifest(&manifest).unwrap();
            assert_eq!(local_catalog.plugins.len(), 2);
            assert!(matches!(
                &local_catalog.plugins[0].source,
                PluginSource::Git { .. }
            ));
        }
    }

    fn write_local_plugin(root: &Path, name: &str) {
        let manifest = root.join("plugins").join(name).join(".codex-plugin");
        fs::create_dir_all(&manifest).unwrap();
        fs::write(
            manifest.join("plugin.json"),
            serde_json::json!({"name": name, "version": "1.0.0", "interface": {"displayName": "Demo tool", "shortDescription": "A useful plugin"}}).to_string(),
        )
        .unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_marketplace_simplifies_existing_verbatim_paths() {
        use std::path::{Component, Prefix};

        let temp = TempDir::new().unwrap();
        write_local_plugin(temp.path(), "demo");
        let manifest = temp.path().join(".agents/plugins/marketplace.json");
        fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        fs::write(
            &manifest,
            serde_json::json!({
                "name": "team-tools",
                "plugins": [{"name": "demo", "source": "./plugins/demo"}]
            })
            .to_string(),
        )
        .unwrap();
        let verbatim_root = temp.path().canonicalize().unwrap();
        ensure_regular_file_without_symlink(&manifest).unwrap();
        ensure_regular_file_without_symlink(&manifest.canonicalize().unwrap()).unwrap();

        let marketplace = load_marketplace_manifest(&verbatim_root).unwrap();

        for path in [
            &marketplace.path,
            match &marketplace.plugins[0].source {
                PluginSource::Local { path } => path,
                _ => panic!("expected local plugin source"),
            },
        ] {
            assert!(!matches!(
                path.components().next(),
                Some(Component::Prefix(prefix))
                    if matches!(
                        prefix.kind(),
                        Prefix::Verbatim(_)
                            | Prefix::VerbatimDisk(_)
                            | Prefix::VerbatimUNC(_, _)
                    )
            ));
        }
    }

    #[test]
    fn loads_agent_and_cursor_local_marketplace_layouts() {
        for (layout, source) in [
            (".agents/plugins/marketplace.json", "./plugins/demo"),
            (".cursor-plugin/marketplace.json", "plugins/demo"),
            (".grok-plugin/marketplace.json", "./plugins/demo"),
            (".codebuddy-plugin/marketplace.json", "./plugins/demo"),
        ] {
            let temp = TempDir::new().unwrap();
            write_local_plugin(temp.path(), "demo");
            let path = temp.path().join(layout);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(
                &path,
                serde_json::json!({
                    "name": "team-tools",
                    "plugins": [{
                        "name": "demo",
                        "source": source,
                        "policy": {"installation": "AVAILABLE"}
                    }]
                })
                .to_string(),
            )
            .unwrap();

            let marketplace = load_marketplace_manifest(temp.path()).unwrap();

            assert_eq!(marketplace.name, "team-tools");
            let display = marketplace.plugins[0].manifest_fallback.as_ref().unwrap();
            assert_eq!(display["displayName"], "Demo tool");
            assert_eq!(display["description"], "A useful plugin");
            assert_eq!(
                marketplace.plugins[0].plugin_id.to_string(),
                "demo@team-tools"
            );
            assert!(matches!(
                marketplace.plugins[0].source,
                PluginSource::Local { .. }
            ));
        }
    }

    #[test]
    fn local_marketplace_rejects_escape_duplicate_and_name_mismatch() {
        let temp = TempDir::new().unwrap();
        write_local_plugin(temp.path(), "actual");
        let path = temp.path().join(".agents/plugins/marketplace.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            serde_json::json!({
                "name": "team-tools",
                "plugins": [
                    {"name": "declared", "source": "./plugins/../plugins/actual"},
                    {"name": "declared", "source": "./plugins/actual"}
                ]
            })
            .to_string(),
        )
        .unwrap();

        assert!(load_marketplace_manifest(&path).is_err());
    }

    #[test]
    fn non_strict_metadata_entry_may_omit_plugin_manifest() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("plugins/clangd-lsp");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("README.md"), "metadata-only fixture").unwrap();
        let path = temp.path().join(".claude-plugin/marketplace.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            serde_json::json!({
                "name": "official-fixture",
                "plugins": [{
                    "name": "clangd-lsp",
                    "source": "./plugins/clangd-lsp",
                    "strict": false,
                    "lspServers": {"clangd": {"command": "clangd"}}
                }]
            })
            .to_string(),
        )
        .unwrap();

        let marketplace = load_marketplace_manifest(&path).unwrap();

        assert_eq!(marketplace.plugins.len(), 1);
        assert!(marketplace.plugins[0].manifest_fallback.is_some());
        assert_eq!(
            marketplace.plugins[0].install_policy,
            InstallPolicy::NotAvailable
        );
    }

    #[test]
    fn conventional_skill_bundle_without_manifest_is_listed_but_not_installable() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("plugins/receipts");
        fs::create_dir_all(source.join("skills/receipts")).unwrap();
        fs::write(
            source.join("skills/receipts/SKILL.md"),
            "---\nname: receipts\ndescription: fixture\n---\n",
        )
        .unwrap();
        let path = temp.path().join(".claude-plugin/marketplace.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            serde_json::json!({
                "name": "official-fixture",
                "plugins": [{
                    "name": "receipts",
                    "source": "./plugins/receipts"
                }]
            })
            .to_string(),
        )
        .unwrap();

        let marketplace = load_marketplace_manifest(&path).unwrap();

        assert_eq!(
            marketplace.plugins[0].install_policy,
            InstallPolicy::NotAvailable
        );
    }
}
