//! Persistence stage of configuration loading.

use super::*;

pub fn read_scope(paths: &ConfigPaths, scope: ConfigScope) -> Result<Value> {
    Ok(read_optional_json_object(paths.for_scope(scope))?
        .unwrap_or_else(|| Value::Object(Map::new())))
}

pub fn write_scope(paths: &ConfigPaths, scope: ConfigScope, value: &Value) -> Result<()> {
    let path = paths.for_scope(scope);
    let _transaction_guard = provider_transaction::write_guard(path)?;
    let lock = lock_settings_path(path)?;
    let result = write_scope_unlocked(paths, scope, value);
    FileExt::unlock(&lock)
        .with_context(|| format!("failed to unlock settings {}", path.display()))?;
    result
}

pub(super) fn write_scope_unlocked(
    paths: &ConfigPaths,
    scope: ConfigScope,
    value: &Value,
) -> Result<()> {
    if !value.is_object() {
        bail!("settings root must be a JSON object");
    }
    // Validate the file as a partial Settings document. Serde defaults fill
    // omitted fields while still rejecting invalid values for present fields.
    validate_settings_document(value)
        .with_context(|| format!("invalid {} settings", scope.as_str()))?;
    write_json_atomic(paths.for_scope(scope), value, scope == ConfigScope::User)?;
    if matches!(scope, ConfigScope::Project | ConfigScope::Local) {
        ensure_project_gitignore(&paths.project_root)?;
    }
    Ok(())
}

/// Read, modify, and atomically write one configuration scope under the same file lock.
///
/// Every read-modify-write operation should use this function so processes neither share temporary files nor overwrite each other's updates.
pub fn update_scope<F>(paths: &ConfigPaths, scope: ConfigScope, update: F) -> Result<Value>
where
    F: FnOnce(&mut Value) -> Result<()>,
{
    let path = paths.for_scope(scope);
    let _transaction_guard = provider_transaction::write_guard(path)?;
    let lock = lock_settings_path(path)?;
    let result = (|| {
        let source = read_raw_optional_jsonc_object(path)?;
        let original = source
            .as_ref()
            .map(|document| document.value.clone())
            .unwrap_or_else(|| Value::Object(Map::new()));
        let mut value = original.clone();
        normalize_config_version(&mut value).map_err(|error| {
            anyhow::anyhow!("invalid settings version in {}: {error}", path.display())
        })?;
        normalize_legacy_settings_document(&mut value);
        update(&mut value)?;
        validate_settings_document(&value)
            .with_context(|| format!("invalid {} settings", scope.as_str()))?;
        write_jsonc_update_atomic(
            path,
            source.as_ref().map(|document| document.source.as_str()),
            &original,
            &value,
            scope == ConfigScope::User,
        )?;
        if matches!(scope, ConfigScope::Project | ConfigScope::Local) {
            ensure_project_gitignore(&paths.project_root)?;
        }
        Ok(value)
    })();
    FileExt::unlock(&lock)
        .with_context(|| format!("failed to unlock settings {}", path.display()))?;
    result
}

/// Update an explicit user-settings file from current on-disk content while holding its file lock.
///
/// This entry point does not merge product defaults, project configuration, or
/// read-only overlays first; callers always receive the JSON object declared by
/// the user file itself. The updated document is revalidated and atomically
/// replaced, allowing narrow field writes without materializing merged runtime state into the user layer.
pub fn update_settings_file<F>(path: &Path, update: F) -> Result<Value>
where
    F: FnOnce(&mut Value) -> Result<()>,
{
    let _transaction_guard = provider_transaction::write_guard(path)?;
    let lock = lock_settings_path(path)?;
    let result = (|| {
        let source = read_raw_optional_jsonc_object(path)?;
        let original = source
            .as_ref()
            .map(|document| document.value.clone())
            .unwrap_or_else(|| Value::Object(Map::new()));
        let mut value = original.clone();
        update(&mut value)?;
        validate_settings_document(&value)
            .with_context(|| format!("invalid user settings in {}", path.display()))?;
        write_jsonc_update_atomic(
            path,
            source.as_ref().map(|document| document.source.as_str()),
            &original,
            &value,
            true,
        )?;
        Ok(value)
    })();
    FileExt::unlock(&lock)
        .with_context(|| format!("failed to unlock settings {}", path.display()))?;
    result
}

/// Read an explicit user-settings file without home discovery, scope merging, or
/// writes. Treat a missing file as an empty object. JSONC comments participate in
/// parsing, while the read itself leaves file bytes unchanged.
pub fn read_settings_file(path: &Path) -> Result<Value> {
    let _transaction_guard = provider_transaction::read_guard(path)?;
    read_raw_optional_json_object(path)
        .map(|value| value.unwrap_or_else(|| Value::Object(Map::new())))
}

pub(super) fn lock_settings_path(path: &Path) -> Result<fs::File> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create config directory {}", parent.display()))?;
    }
    let lock_path = path.with_extension("json.lock");
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .with_context(|| format!("failed to open settings lock {}", lock_path.display()))?;
    FileExt::lock_exclusive(&lock)
        .with_context(|| format!("failed to lock settings {}", lock_path.display()))?;
    Ok(lock)
}

/// Create a settings scope only when it does not already exist.
///
/// Returns `true` when the file was created. Concurrent creators are safe: an
/// existing file always wins and is never replaced.
pub fn write_scope_if_missing(
    paths: &ConfigPaths,
    scope: ConfigScope,
    value: &Value,
) -> Result<bool> {
    if !value.is_object() {
        bail!("settings root must be a JSON object");
    }
    validate_settings_document(value)
        .with_context(|| format!("invalid {} settings", scope.as_str()))?;
    let path = paths.for_scope(scope);
    let _transaction_guard = provider_transaction::write_guard(path)?;
    let lock = lock_settings_path(path)?;
    let result = if path.exists() {
        Ok(false)
    } else {
        // Write a complete temporary file before atomic publication. All cooperating
        // writers for one scope hold the same lock, so readers never observe a settings.json
        // that was created but not fully written.
        write_json_atomic(path, value, scope == ConfigScope::User).map(|()| true)
    };
    FileExt::unlock(&lock)
        .with_context(|| format!("failed to unlock settings {}", path.display()))?;
    let created = result?;
    if created && matches!(scope, ConfigScope::Project | ConfigScope::Local) {
        ensure_project_gitignore(&paths.project_root)?;
    }
    Ok(created)
}

/// Ensure project-local KCoder state is ignored without hiding shared project
/// settings, specs, skills, or plugins from version control.
pub fn ensure_project_gitignore(project_root: &Path) -> Result<PathBuf> {
    let kcoder_dir = project_root.join(".kcoder");
    fs::create_dir_all(&kcoder_dir)
        .with_context(|| format!("failed to create {}", kcoder_dir.display()))?;

    let path = kcoder_dir.join(".gitignore");
    let existing = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {}", path.display()));
        }
    };
    let existing_lines = existing.lines().map(str::trim).collect::<BTreeSet<_>>();
    let has_header = existing_lines.contains(PROJECT_GITIGNORE_HEADER);
    let missing_rules = PROJECT_GITIGNORE_RULES
        .iter()
        .copied()
        .filter(|rule| !existing_lines.contains(rule))
        .collect::<Vec<_>>();
    if missing_rules.is_empty() {
        return Ok(path);
    }

    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    if !updated.is_empty() {
        updated.push('\n');
    }
    if !has_header {
        updated.push_str(PROJECT_GITIGNORE_HEADER);
        updated.push('\n');
    }
    for rule in missing_rules {
        updated.push_str(rule);
        updated.push('\n');
    }
    fs::write(&path, updated).with_context(|| format!("failed to update {}", path.display()))?;
    Ok(path)
}

pub(super) fn read_optional_json_object(path: &Path) -> Result<Option<Value>> {
    let Some(mut value) = read_raw_optional_json_object(path)? else {
        return Ok(None);
    };
    normalize_config_version(&mut value).map_err(|error| {
        anyhow::anyhow!("invalid settings version in {}: {error}", path.display())
    })?;
    normalize_legacy_settings_document(&mut value);
    Ok(Some(value))
}

pub(super) fn read_raw_optional_json_object(path: &Path) -> Result<Option<Value>> {
    Ok(read_raw_optional_jsonc_object(path)?.map(|document| document.value))
}

pub(super) fn read_raw_optional_jsonc_object(path: &Path) -> Result<Option<RawJsoncObject>> {
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path)
        .with_context(|| format!("failed to read settings from {}", path.display()))?;
    let value: Value = if content.trim().is_empty() {
        Value::Object(Map::new())
    } else {
        jsonc_parser::parse_to_serde_value(&content, &Default::default())
            .with_context(|| format!("failed to parse settings from {}", path.display()))?
    };
    if !value.is_object() {
        bail!(
            "settings file {} must contain a JSON object",
            path.display()
        );
    }
    Ok(Some(RawJsoncObject {
        source: content,
        value,
    }))
}

pub(super) fn write_json_atomic(path: &Path, value: &Value, require_user_only: bool) -> Result<()> {
    let content = serde_json::to_string_pretty(value).context("failed to serialize JSON")?;
    write_bytes_atomic(path, format!("{content}\n").as_bytes(), require_user_only)
}

/// Rewrite only JSONC nodes whose semantics changed, preserving user comments and adjacent formatting during incremental persistence.
pub(super) fn write_jsonc_update_atomic(
    path: &Path,
    source: Option<&str>,
    original: &Value,
    updated: &Value,
    require_user_only: bool,
) -> Result<()> {
    if original == updated {
        return Ok(());
    }

    let Some(source) = source else {
        return write_json_atomic(path, updated, require_user_only);
    };
    let root = CstRootNode::parse(source, &Default::default())
        .with_context(|| format!("failed to parse JSONC syntax tree from {}", path.display()))?;
    let object = root.object_value_or_create().ok_or_else(|| {
        anyhow::anyhow!(
            "settings file {} must contain a JSON object",
            path.display()
        )
    })?;
    reconcile_jsonc_object(
        &object,
        original
            .as_object()
            .context("original settings root is not a JSON object")?,
        updated
            .as_object()
            .context("updated settings root is not a JSON object")?,
        "",
    )?;

    let rendered = root.to_string();
    let reparsed: Value = jsonc_parser::parse_to_serde_value(&rendered, &Default::default())
        .with_context(|| {
            format!(
                "failed to verify updated JSONC document for {}",
                path.display()
            )
        })?;
    if &reparsed != updated {
        bail!(
            "refusing to write {} because the JSONC edit did not reproduce the requested settings",
            path.display()
        );
    }
    write_bytes_atomic(path, rendered.as_bytes(), require_user_only)
}

pub(super) fn reconcile_jsonc_object(
    object: &CstObject,
    original: &Map<String, Value>,
    updated: &Map<String, Value>,
    prefix: &str,
) -> Result<()> {
    for key in original.keys().filter(|key| !updated.contains_key(*key)) {
        let path = dotted_child(prefix, key);
        single_jsonc_property(object, key, &path)?.remove();
    }

    for (key, updated_value) in updated {
        let path = dotted_child(prefix, key);
        let Some(original_value) = original.get(key) else {
            object.append(key, json_value_to_cst(updated_value));
            continue;
        };
        if original_value == updated_value {
            continue;
        }

        let property = single_jsonc_property(object, key, &path)?;
        match (original_value.as_object(), updated_value.as_object()) {
            (Some(original_object), Some(updated_object)) => {
                let nested = property.object_value().ok_or_else(|| {
                    anyhow::anyhow!(
                        "cannot safely update JSONC property '{path}' because its syntax is not an object"
                    )
                })?;
                reconcile_jsonc_object(&nested, original_object, updated_object, &path)?;
            }
            // Arrays lack stable element identities; replace the whole array on semantic changes instead of guessing moves or removals.
            _ => property.set_value(json_value_to_cst(updated_value)),
        }
    }
    Ok(())
}

pub(super) fn single_jsonc_property(
    object: &CstObject,
    key: &str,
    path: &str,
) -> Result<CstObjectProp> {
    let mut matches = Vec::new();
    for property in object.properties() {
        let name = property
            .name()
            .ok_or_else(|| anyhow::anyhow!("JSONC property in '{path}' has no name"))?;
        let decoded = name.decoded_value().map_err(|error| {
            anyhow::anyhow!("failed to decode JSONC property name near '{path}': {error:?}")
        })?;
        if decoded == key {
            matches.push(property);
        }
    }
    match matches.len() {
        1 => Ok(matches.pop().expect("one JSONC property was counted")),
        0 => bail!("cannot safely update missing JSONC property '{path}'"),
        _ => bail!("cannot safely update duplicate JSONC property '{path}'"),
    }
}

pub(super) fn dotted_child(prefix: &str, key: &str) -> String {
    if prefix.is_empty() {
        key.to_string()
    } else {
        format!("{prefix}.{key}")
    }
}

pub(super) fn json_value_to_cst(value: &Value) -> CstInputValue {
    match value {
        Value::Null => CstInputValue::Null,
        Value::Bool(value) => CstInputValue::Bool(*value),
        Value::Number(value) => CstInputValue::Number(value.to_string()),
        Value::String(value) => CstInputValue::String(value.clone()),
        Value::Array(values) => {
            CstInputValue::Array(values.iter().map(json_value_to_cst).collect())
        }
        Value::Object(values) => CstInputValue::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), json_value_to_cst(value)))
                .collect(),
        ),
    }
}

pub(crate) fn write_bytes_atomic(
    path: &Path,
    content: &[u8],
    require_user_only: bool,
) -> Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create config directory {}", parent.display()))?;
    }
    let parent = fs::canonicalize(
        path.parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new(".")),
    )?;
    let name = path
        .file_name()
        .context("Configuration filename is missing")?;
    let directory = crate::private_files::PrivateDirectory::open_existing(&parent)?;
    let _ = require_user_only;
    directory.atomic_replace(name, content)
}

/// Atomically validate, journal, and recover a Provider settings/credential pair.
pub fn update_settings_and_credentials<F>(path: &Path, update: F) -> Result<Value>
where
    F: FnOnce(&mut Value, &mut CredentialStore) -> Result<()>,
{
    provider_transaction::update(path, update)
}

pub(super) fn sync_parent(path: &Path) -> Result<()> {
    #[cfg(unix)]
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::File::open(parent)?.sync_all()?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
