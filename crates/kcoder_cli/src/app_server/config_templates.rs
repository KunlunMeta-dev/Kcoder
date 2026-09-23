//! Session-level settings template store (`<config_dir>/templates`).
//!
//! A template is a JSONC settings overlay bound to one conversation at
//! `thread/start`; the store owns CRUD, import, validation, and the
//! default-template pointer used by new-session pickers.

use super::private_files::hex_sha256;
use anyhow::{Context, Result, bail};
use kcoder_app_protocol::{
    SettingsTemplateBinding, SettingsTemplateReadResult, SettingsTemplateSaveParams,
    SettingsTemplateSaveResult, SettingsTemplateSummary, SettingsTemplatesListResult,
    SettingsTemplatesMutationResult,
};
use kcoder_config::SettingsLoader;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Content cap for a single template; keeps overlays reviewable by hand.
pub(super) const MAX_TEMPLATE_BYTES: usize = 256 * 1024;
const MAX_ID_LEN: usize = 64;
const INDEX_FILE: &str = "index.json";
/// Keys that would smuggle credentials into a session overlay; a template
/// may select endpoints/models but never secrets or credential indirection.
const FORBIDDEN_CREDENTIAL_KEYS: &[&str] = &[
    "apikey",
    "credentials",
    "credential",
    "password",
    "authtoken",
    "bearertoken",
    "secret",
    "clientsecret",
    "credentialenv",
    "credentialenvfile",
    "accesstoken",
    "refreshtoken",
];

static STAGING_COUNTER: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TemplateIndex {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_id: Option<String>,
    #[serde(default)]
    templates: Vec<TemplateIndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TemplateIndexEntry {
    id: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    created_at: String,
    updated_at: String,
    revision_sha256: String,
    size_bytes: u64,
}

/// File-backed template store rooted at `<config_dir>/templates`.
pub(super) struct ConfigTemplates {
    config_dir: PathBuf,
    root: PathBuf,
}

impl ConfigTemplates {
    pub(super) fn new(config_dir: PathBuf) -> Self {
        let root = config_dir.join("templates");
        Self { config_dir, root }
    }

    #[cfg(test)]
    pub(super) fn root(&self) -> &Path {
        &self.root
    }

    pub(super) fn list(&self) -> Result<SettingsTemplatesListResult> {
        let index = self.read_index()?;
        let mut templates = Vec::new();
        for entry in &index.templates {
            let Ok(bytes) = fs::read(self.root.join(format!("{}.jsonc", entry.id))) else {
                continue;
            };
            templates.push(summary_from(entry, &bytes));
        }
        templates.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let default_id = index
            .default_id
            .filter(|id| templates.iter().any(|summary| &summary.id == id));
        Ok(SettingsTemplatesListResult {
            templates,
            default_id,
        })
    }

    pub(super) fn read(&self, id: &str) -> Result<SettingsTemplateReadResult> {
        validate_id(id)?;
        let index = self.read_index()?;
        let entry = self.entry(&index, id)?.clone();
        let bytes = self.read_template_bytes(id)?;
        let content = String::from_utf8(bytes.clone())
            .with_context(|| format!("settings template {id} is not valid UTF-8"))?;
        Ok(SettingsTemplateReadResult {
            summary: summary_from(&entry, &bytes),
            content,
            default_id: index.default_id,
        })
    }

    pub(super) fn save(
        &self,
        params: &SettingsTemplateSaveParams,
    ) -> Result<SettingsTemplateSaveResult> {
        let name = params.name.trim();
        if name.is_empty() {
            bail!("invalid settings template name: template name must not be blank");
        }
        if params.content.len() > MAX_TEMPLATE_BYTES {
            bail!(
                "settings template is too large: {} bytes (max {} bytes)",
                params.content.len(),
                MAX_TEMPLATE_BYTES
            );
        }
        let mut index = self.read_index()?;
        let id = match params.id.as_deref() {
            Some(id) => {
                validate_id(id)?;
                id.to_string()
            }
            None => derive_id(name, &index),
        };
        self.validate_content(&params.content)?;

        let now = now_rfc3339();
        let created_at = index
            .templates
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.created_at.clone())
            .unwrap_or_else(|| now.clone());
        write_bytes_atomic(
            &self.root.join(format!("{id}.jsonc")),
            params.content.as_bytes(),
        )?;

        let entry = TemplateIndexEntry {
            id: id.clone(),
            name: name.to_string(),
            description: params
                .description
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            created_at,
            updated_at: now,
            revision_sha256: hex_sha256(params.content.as_bytes()),
            size_bytes: params.content.len() as u64,
        };
        match index.templates.iter_mut().find(|slot| slot.id == id) {
            Some(slot) => *slot = entry.clone(),
            None => index.templates.push(entry.clone()),
        }
        self.write_index(&index)?;
        Ok(SettingsTemplateSaveResult {
            template: summary_from(&entry, params.content.as_bytes()),
            default_id: index.default_id,
        })
    }

    pub(super) fn delete(&self, id: &str) -> Result<SettingsTemplatesMutationResult> {
        validate_id(id)?;
        let mut index = self.read_index()?;
        if !index.templates.iter().any(|entry| entry.id == id) {
            bail!("unknown settings template: {id}");
        }
        let path = self.root.join(format!("{id}.jsonc"));
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("failed to remove {}", path.display()));
            }
        }
        index.templates.retain(|entry| entry.id != id);
        if index.default_id.as_deref() == Some(id) {
            index.default_id = None;
        }
        self.write_index(&index)?;
        self.mutation_result()
    }

    pub(super) fn set_default(&self, id: Option<&str>) -> Result<SettingsTemplatesMutationResult> {
        let mut index = self.read_index()?;
        if let Some(id) = id {
            validate_id(id)?;
            if !index.templates.iter().any(|entry| entry.id == id) {
                bail!("unknown settings template: {id}");
            }
        }
        index.default_id = id.map(str::to_string);
        self.write_index(&index)?;
        self.mutation_result()
    }

    #[cfg(test)]
    pub(super) fn import_file(
        &self,
        path: &Path,
        name: Option<String>,
    ) -> Result<SettingsTemplateSaveResult> {
        let content = fs::read_to_string(path).with_context(|| {
            format!("failed to read settings template import {}", path.display())
        })?;
        let name = name
            .or_else(|| {
                path.file_stem()
                    .map(|stem| stem.to_string_lossy().into_owned())
            })
            .unwrap_or_else(|| "imported".to_string());
        self.save(&SettingsTemplateSaveParams {
            id: None,
            name,
            description: None,
            content,
        })
    }

    /// Validates content as a JSONC settings overlay before it is persisted.
    pub(super) fn validate_content(&self, content: &str) -> Result<()> {
        let value = jsonc_parser::parse_to_serde_value(content, &Default::default())
            .map_err(|error| anyhow::anyhow!("invalid settings template content: {error}"))?;
        if let Some(key) = first_credential_key(&value) {
            bail!("settings template must not declare credential field `{key}`");
        }

        fs::create_dir_all(&self.root)
            .with_context(|| format!("failed to create {}", self.root.display()))?;
        let staged = self.root.join(format!(
            ".staging-{}-{}.jsonc",
            std::process::id(),
            STAGING_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&staged, content)
            .with_context(|| format!("failed to stage {}", staged.display()))?;
        let loaded = SettingsLoader::new(&self.root)
            .with_config_dir(self.config_dir.clone())
            .with_overlay_files([staged.clone()])
            .load();
        let _ = fs::remove_file(&staged);
        loaded.map_err(|error| anyhow::anyhow!("invalid settings template content: {error}"))?;
        Ok(())
    }

    /// Resolves the overlay path for a frozen session binding.
    pub(super) fn template_path(&self, id: &str) -> Result<PathBuf> {
        validate_id(id)?;
        let index = self.read_index()?;
        self.entry(&index, id)?;
        Ok(self.root.join(format!("{id}.jsonc")))
    }

    /// Revision of the template as currently stored on disk.
    pub(super) fn binding(&self, id: &str) -> Result<SettingsTemplateBinding> {
        let path = self.template_path(id)?;
        let bytes =
            fs::read(&path).with_context(|| format!("failed to read settings template {id}"))?;
        Ok(SettingsTemplateBinding {
            id: id.to_string(),
            revision_sha256: hex_sha256(&bytes),
        })
    }

    fn mutation_result(&self) -> Result<SettingsTemplatesMutationResult> {
        let listed = self.list()?;
        Ok(SettingsTemplatesMutationResult {
            templates: listed.templates,
            default_id: listed.default_id,
        })
    }

    fn entry<'a>(&self, index: &'a TemplateIndex, id: &str) -> Result<&'a TemplateIndexEntry> {
        index
            .templates
            .iter()
            .find(|entry| entry.id == id)
            .with_context(|| format!("unknown settings template: {id}"))
    }

    fn read_template_bytes(&self, id: &str) -> Result<Vec<u8>> {
        let path = self.root.join(format!("{id}.jsonc"));
        fs::read(&path).with_context(|| format!("failed to read settings template {id}"))
    }

    fn read_index(&self) -> Result<TemplateIndex> {
        let path = self.root.join(INDEX_FILE);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(TemplateIndex::default());
            }
            Err(error) => {
                return Err(error).with_context(|| format!("failed to read {}", path.display()));
            }
        };
        serde_json::from_slice(&bytes)
            .with_context(|| format!("failed to parse {}", path.display()))
    }

    fn write_index(&self, index: &TemplateIndex) -> Result<()> {
        let mut bytes = serde_json::to_vec_pretty(index)?;
        bytes.push(b'\n');
        write_bytes_atomic(&self.root.join(INDEX_FILE), &bytes)
    }
}

/// Resolves the overlay path plus the frozen binding for a session start.
pub(super) fn resolve_session_template(id: &str) -> Result<(PathBuf, SettingsTemplateBinding)> {
    let store = user_template_store()?;
    Ok((store.template_path(id)?, store.binding(id)?))
}

/// Resolves the store's default template for new sessions, if one is set.
///
/// A default that disappeared from disk falls back to the baseline settings so
/// thread creation is never blocked by a stale pointer.
pub(super) fn default_session_template() -> Option<(PathBuf, SettingsTemplateBinding)> {
    let store = user_template_store().ok()?;
    let default_id = store.list().ok()?.default_id?;
    match resolve_session_template(&default_id) {
        Ok(resolved) => Some(resolved),
        Err(error) => {
            tracing::warn!(
                template = %default_id,
                %error,
                "default settings template is unavailable; starting with baseline settings"
            );
            None
        }
    }
}

/// Store backed by the active profile's config directory.
pub(super) fn user_template_store() -> Result<ConfigTemplates> {
    Ok(ConfigTemplates::new(kcoder_config::Settings::config_dir()?))
}

fn validate_id(id: &str) -> Result<()> {
    let valid = !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
        && !id.ends_with('-')
        && !id.contains("--");
    if !valid {
        bail!("invalid settings template id: {id}");
    }
    Ok(())
}

fn derive_id(name: &str, index: &TemplateIndex) -> String {
    let mut base: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    while base.contains("--") {
        base = base.replace("--", "-");
    }
    let mut base: String = base.trim_matches('-').chars().take(MAX_ID_LEN).collect();
    base = base.trim_end_matches('-').to_string();
    if base.is_empty() {
        base = "template".to_string();
    }
    if !index.templates.iter().any(|entry| entry.id == base) {
        return base;
    }
    for suffix in 2..10_000u32 {
        let tail = format!("-{suffix}");
        let head: String = base
            .chars()
            .take(MAX_ID_LEN.saturating_sub(tail.len()))
            .collect();
        let candidate = format!("{}{}", head.trim_end_matches('-'), tail);
        if !index.templates.iter().any(|entry| entry.id == candidate) {
            return candidate;
        }
    }
    format!("template-{}", now_millis())
}

fn summary_from(entry: &TemplateIndexEntry, bytes: &[u8]) -> SettingsTemplateSummary {
    SettingsTemplateSummary {
        id: entry.id.clone(),
        name: entry.name.clone(),
        description: entry.description.clone(),
        updated_at: entry.updated_at.clone(),
        size_bytes: bytes.len() as u64,
        revision_sha256: hex_sha256(bytes),
    }
}

fn first_credential_key(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let normalized: String = key
                    .chars()
                    .filter(char::is_ascii_alphanumeric)
                    .map(|c| c.to_ascii_lowercase())
                    .collect();
                if FORBIDDEN_CREDENTIAL_KEYS.contains(&normalized.as_str()) {
                    return Some(key.clone());
                }
                if let Some(found) = first_credential_key(child) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(first_credential_key),
        _ => None,
    }
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .context("settings template path has no parent directory")?;
    fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?;
    let temp = parent.join(format!(
        ".staging-{}-{}.tmp",
        std::process::id(),
        STAGING_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&temp, bytes).with_context(|| format!("failed to write {}", temp.display()))?;
    kcoder_config::set_user_only_file_permissions(&temp)?;
    fs::rename(&temp, path).with_context(|| format!("failed to persist {}", path.display()))?;
    Ok(())
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_app_protocol::SettingsTemplateSaveParams;

    struct Fixture {
        dir: tempfile::TempDir,
        store: ConfigTemplates,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigTemplates::new(dir.path().to_path_buf());
        Fixture { dir, store }
    }

    fn save(store: &ConfigTemplates, name: &str, content: &str) -> SettingsTemplateSaveResult {
        store
            .save(&SettingsTemplateSaveParams {
                id: None,
                name: name.into(),
                description: None,
                content: content.into(),
            })
            .unwrap()
    }

    fn persisted_files(store: &ConfigTemplates) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(store.root()) else {
            return Vec::new();
        };
        entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| !name.starts_with(".staging-"))
            .collect()
    }

    #[test]
    fn save_derives_slug_and_read_round_trips_content() {
        let fixture = fixture();
        let saved = save(
            &fixture.store,
            "Fast Local",
            "{ \"permission_mode\": \"auto\" }\n",
        );
        assert_eq!(saved.template.id, "fast-local");
        assert_eq!(saved.template.name, "Fast Local");
        assert!(saved.default_id.is_none());
        assert!(fixture.store.root().join("fast-local.jsonc").is_file());
        assert!(fixture.store.root().join("index.json").is_file());

        let read = fixture.store.read("fast-local").unwrap();
        assert_eq!(read.content, "{ \"permission_mode\": \"auto\" }\n");
        assert_eq!(read.summary.size_bytes, read.content.len() as u64);
        assert!(read.default_id.is_none());
        assert_eq!(
            read.summary.revision_sha256,
            hex_sha256(read.content.as_bytes())
        );

        let list = fixture.store.list().unwrap();
        assert_eq!(list.templates.len(), 1);
        assert_eq!(list.templates[0].id, "fast-local");
        assert_eq!(
            list.templates[0].revision_sha256,
            read.summary.revision_sha256
        );
    }

    #[test]
    fn overwrite_in_place_keeps_one_entry_and_refreshes_revision() {
        let fixture = fixture();
        let first = save(
            &fixture.store,
            "Fast Local",
            "{ \"permission_mode\": \"auto\" }\n",
        );
        let second = fixture
            .store
            .save(&SettingsTemplateSaveParams {
                id: Some("fast-local".into()),
                name: "Fast Local v2".into(),
                description: Some("tightened".into()),
                content: "{ \"permission_mode\": \"ask\" }\n".into(),
            })
            .unwrap();
        assert_eq!(second.template.id, "fast-local");
        assert_eq!(second.template.name, "Fast Local v2");
        assert_eq!(second.template.description.as_deref(), Some("tightened"));
        assert_ne!(
            second.template.revision_sha256,
            first.template.revision_sha256
        );
        assert!(second.template.updated_at >= first.template.updated_at);
        assert_eq!(fixture.store.list().unwrap().templates.len(), 1);
        assert_eq!(
            fixture.store.read("fast-local").unwrap().content,
            "{ \"permission_mode\": \"ask\" }\n"
        );
    }

    #[test]
    fn duplicate_name_gets_a_distinct_id() {
        let fixture = fixture();
        save(&fixture.store, "Fast Local", "{}\n");
        let second = save(&fixture.store, "Fast Local", "{}\n");
        assert_eq!(second.template.id, "fast-local-2");
        assert_eq!(fixture.store.list().unwrap().templates.len(), 2);
    }

    #[test]
    fn invalid_id_and_blank_name_are_rejected() {
        let fixture = fixture();
        for id in [
            "Fast Local",
            "fast_local",
            "-fast",
            "fast-",
            "fast--local",
            "",
        ] {
            let err = fixture
                .store
                .save(&SettingsTemplateSaveParams {
                    id: Some(id.into()),
                    name: "Fast Local".into(),
                    description: None,
                    content: "{}\n".into(),
                })
                .unwrap_err();
            assert!(
                err.to_string().contains("invalid settings template id"),
                "{id}: {err}"
            );
        }
        let err = fixture
            .store
            .save(&SettingsTemplateSaveParams {
                id: None,
                name: "   ".into(),
                description: None,
                content: "{}\n".into(),
            })
            .unwrap_err();
        assert!(
            err.to_string().contains("invalid settings template name"),
            "{err}"
        );
        assert!(persisted_files(&fixture.store).is_empty());
    }

    #[test]
    fn oversized_content_is_rejected_before_validation() {
        let fixture = fixture();
        let content = format!("{{ \"note\": \"{}\" }}", "x".repeat(MAX_TEMPLATE_BYTES));
        let err = fixture
            .store
            .save(&SettingsTemplateSaveParams {
                id: None,
                name: "Fast Local".into(),
                description: None,
                content,
            })
            .unwrap_err();
        assert!(err.to_string().contains("too large"), "{err}");
        assert!(persisted_files(&fixture.store).is_empty());
        assert!(fixture.store.list().unwrap().templates.is_empty());
    }

    #[test]
    fn credential_fields_are_rejected_and_never_persisted() {
        let fixture = fixture();
        for content in [
            "{ \"api_key\": \"secret\" }\n",
            "{ \"providers\": { \"local\": { \"apiKey\": \"secret\" } } }\n",
            "{ \"credentials\": {} }\n",
            "{ \"active_provider\": \"local\", \"credential_env\": \"LOCAL_KEY\" }\n",
        ] {
            let err = fixture
                .store
                .save(&SettingsTemplateSaveParams {
                    id: None,
                    name: "Fast Local".into(),
                    description: None,
                    content: content.into(),
                })
                .unwrap_err();
            assert!(err.to_string().contains("credential"), "{content} => {err}");
        }
        assert!(persisted_files(&fixture.store).is_empty());
        assert!(fixture.store.list().unwrap().templates.is_empty());
    }

    #[test]
    fn invalid_jsonc_and_unknown_keys_are_rejected() {
        let fixture = fixture();
        for content in [
            "{ \"permission_mode\": \"auto\"\n",
            "{ \"bogus_key\": 1 }\n",
        ] {
            let err = fixture
                .store
                .save(&SettingsTemplateSaveParams {
                    id: None,
                    name: "Fast Local".into(),
                    description: None,
                    content: content.into(),
                })
                .unwrap_err();
            assert!(
                err.to_string()
                    .contains("invalid settings template content"),
                "{content} => {err}"
            );
        }
        assert!(persisted_files(&fixture.store).is_empty());
        assert!(fixture.store.list().unwrap().templates.is_empty());
    }

    #[test]
    fn delete_removes_entry_file_and_default_pointer() {
        let fixture = fixture();
        let saved = save(&fixture.store, "Fast Local", "{}\n");
        fixture.store.set_default(Some(&saved.template.id)).unwrap();

        let after = fixture.store.delete("fast-local").unwrap();
        assert!(after.templates.is_empty());
        assert!(after.default_id.is_none());
        assert!(!fixture.store.root().join("fast-local.jsonc").is_file());
        assert!(
            fixture
                .store
                .read("fast-local")
                .unwrap_err()
                .to_string()
                .contains("unknown settings template")
        );

        let index: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(fixture.store.root().join("index.json")).unwrap(),
        )
        .unwrap();
        assert!(
            index
                .get("default_id")
                .map_or(true, serde_json::Value::is_null)
        );
        assert!(index["templates"].as_array().unwrap().is_empty());
    }

    #[test]
    fn unknown_ids_are_rejected_but_clearing_an_absent_default_is_fine() {
        let fixture = fixture();
        for err in [
            fixture.store.read("nope").unwrap_err(),
            fixture.store.delete("nope").unwrap_err(),
            fixture.store.set_default(Some("nope")).unwrap_err(),
        ] {
            assert!(
                err.to_string().contains("unknown settings template"),
                "{err}"
            );
        }
        assert!(
            fixture
                .store
                .set_default(None)
                .unwrap()
                .default_id
                .is_none()
        );
    }

    #[test]
    fn default_pointer_persists_across_store_reloads() {
        let fixture = fixture();
        save(&fixture.store, "Alpha", "{}\n");
        save(&fixture.store, "Beta", "{}\n");
        let set = fixture.store.set_default(Some("beta")).unwrap();
        assert_eq!(set.default_id.as_deref(), Some("beta"));
        assert_eq!(
            fixture.store.read("beta").unwrap().default_id.as_deref(),
            Some("beta")
        );

        let reloaded = ConfigTemplates::new(fixture.dir.path().to_path_buf());
        assert_eq!(reloaded.list().unwrap().default_id.as_deref(), Some("beta"));
        assert!(reloaded.set_default(None).unwrap().default_id.is_none());
        let reloaded = ConfigTemplates::new(fixture.dir.path().to_path_buf());
        assert!(reloaded.list().unwrap().default_id.is_none());
    }

    #[test]
    fn template_path_and_binding_expose_revision_for_sessions() {
        let fixture = fixture();
        let saved = save(
            &fixture.store,
            "Fast Local",
            "{ \"permission_mode\": \"auto\" }\n",
        );
        let path = fixture.store.template_path("fast-local").unwrap();
        assert_eq!(path, fixture.store.root().join("fast-local.jsonc"));

        let binding = fixture.store.binding("fast-local").unwrap();
        assert_eq!(binding.id, "fast-local");
        assert_eq!(binding.revision_sha256, saved.template.revision_sha256);

        assert!(fixture.store.binding("nope").is_err());
        assert!(fixture.store.template_path("Bad Id").is_err());
    }

    #[test]
    fn list_reports_live_revisions_and_drops_files_deleted_on_disk() {
        let fixture = fixture();
        save(&fixture.store, "Fast Local", "{}\n");
        std::fs::write(
            fixture.store.root().join("fast-local.jsonc"),
            "{ \"permission_mode\": \"ask\" }\n",
        )
        .unwrap();
        let list = fixture.store.list().unwrap();
        assert_eq!(list.templates.len(), 1);
        assert_eq!(
            list.templates[0].revision_sha256,
            hex_sha256(b"{ \"permission_mode\": \"ask\" }\n")
        );
        assert_eq!(
            list.templates[0].size_bytes,
            b"{ \"permission_mode\": \"ask\" }\n".len() as u64
        );

        std::fs::remove_file(fixture.store.root().join("fast-local.jsonc")).unwrap();
        assert!(fixture.store.list().unwrap().templates.is_empty());
    }

    #[test]
    fn import_file_uses_the_stem_and_rejects_credentials() {
        let fixture = fixture();
        let good = fixture.dir.path().join("imported.jsonc");
        std::fs::write(&good, "{ \"permission_mode\": \"auto\" }\n").unwrap();
        let imported = fixture.store.import_file(&good, None).unwrap();
        assert_eq!(imported.template.id, "imported");
        assert_eq!(imported.template.name, "imported");

        let bad = fixture.dir.path().join("bad.jsonc");
        std::fs::write(&bad, "{ \"api_key\": \"secret\" }\n").unwrap();
        assert!(
            fixture
                .store
                .import_file(&bad, None)
                .unwrap_err()
                .to_string()
                .contains("credential")
        );

        let missing = fixture.dir.path().join("nope.jsonc");
        assert!(fixture.store.import_file(&missing, None).is_err());
        assert_eq!(fixture.store.list().unwrap().templates.len(), 1);
    }
}
