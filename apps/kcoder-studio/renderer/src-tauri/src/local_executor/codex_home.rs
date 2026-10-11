//! Existing isolated Codex home initialization, configuration and import behavior.

use super::*;

pub(super) fn wework_codex_home_path(executor_home: &str) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var(WEGENT_CODEX_HOME_ENV) {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    Ok(PathBuf::from(executor_home).join("codex"))
}

pub(super) fn native_codex_home_path() -> Result<PathBuf, String> {
    if std::env::var("VITE_KCODER_STUDIO_E2E").as_deref() == Ok("true") {
        if let Some(path) = non_empty_env(KCODER_STUDIO_E2E_NATIVE_CODEX_HOME_ENV) {
            return Ok(PathBuf::from(path));
        }
    }
    let home = dirs::home_dir().ok_or_else(|| "Home directory is not available".to_string())?;
    Ok(home.join(".codex"))
}

pub(super) fn link_native_codex_auth(
    native_codex_home: &Path,
    wework_codex_home: &Path,
) -> Result<(), String> {
    let source = native_codex_home.join("auth.json");
    let target = wework_codex_home.join("auth.json");
    if source == target || !source.is_file() {
        return Ok(());
    }

    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.file_type().is_symlink() && !target.exists() {
            fs::remove_file(&target).map_err(|error| {
                format!(
                    "failed to remove stale Codex auth link {}: {error}",
                    target.display()
                )
            })?;
        } else {
            return Ok(());
        }
    }

    fs::create_dir_all(wework_codex_home)
        .map_err(|error| format!("failed to create {}: {error}", wework_codex_home.display()))?;
    #[cfg(unix)]
    std::os::unix::fs::symlink(&source, &target).map_err(|error| {
        format!(
            "failed to link Codex auth {} -> {}: {error}",
            target.display(),
            source.display()
        )
    })?;
    #[cfg(not(unix))]
    fs::copy(&source, &target).map_err(|error| {
        format!(
            "failed to copy Codex auth {} to {}: {error}",
            source.display(),
            target.display()
        )
    })?;
    Ok(())
}

pub(super) fn prepare_local_executor_codex_auth(envs: &[(String, String)]) -> Result<(), String> {
    let Some(codex_home) = envs
        .iter()
        .find_map(|(key, value)| (key == CODEX_HOME_ENV).then_some(PathBuf::from(value)))
    else {
        return Ok(());
    };
    link_native_codex_auth(&native_codex_home_path()?, &codex_home)
}

pub(super) fn codex_home_migration_status() -> Result<CodexHomeMigrationStatus, String> {
    let executor_home = local_executor_home_path()?;
    let wework_codex_home = wework_codex_home_path(&executor_home.display().to_string())?;
    let wework_codex_config = wework_codex_home.join("config.toml");
    let native_codex_home = native_codex_home_path()?;
    let wework_codex_home_exists = wework_codex_home.exists();
    let wework_codex_config_exists = wework_codex_config.exists();
    let native_codex_home_exists = native_codex_home.exists();
    Ok(CodexHomeMigrationStatus {
        wework_codex_home: wework_codex_home.display().to_string(),
        native_codex_home: native_codex_home.display().to_string(),
        wework_codex_home_exists,
        native_codex_home_exists,
        should_prompt_migration: !wework_codex_config_exists && native_codex_home_exists,
    })
}

pub(super) fn wework_codex_config_path() -> Result<(PathBuf, PathBuf), String> {
    let executor_home = local_executor_home_path()?;
    let codex_home = wework_codex_home_path(&executor_home.display().to_string())?;
    let config_path = codex_home.join("config.toml");
    Ok((codex_home, config_path))
}

pub(super) fn read_remote_apps_enabled_from_config(content: &str) -> bool {
    let mut in_features = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_features = trimmed == "[features]";
            continue;
        }
        if !in_features || trimmed.starts_with('#') {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix("apps") else {
            continue;
        };
        if !rest.trim_start().starts_with('=') {
            continue;
        }
        return rest
            .trim_start()
            .trim_start_matches('=')
            .trim()
            .split('#')
            .next()
            .unwrap_or_default()
            .trim()
            == "true";
    }
    false
}

pub(super) fn read_codex_local_config() -> Result<CodexLocalConfig, String> {
    let (codex_home, config_path) = wework_codex_config_path()?;
    let content = fs::read_to_string(&config_path).unwrap_or_default();
    Ok(CodexLocalConfig {
        codex_home: codex_home.display().to_string(),
        config_path: config_path.display().to_string(),
        remote_apps_enabled: read_remote_apps_enabled_from_config(&content),
    })
}

pub(super) fn set_remote_apps_enabled_in_config(content: &str, enabled: bool) -> String {
    let apps_line = format!("apps = {enabled}");
    let mut lines = content.lines().map(str::to_string).collect::<Vec<_>>();
    let mut features_start = None;
    let mut features_end = lines.len();

    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if features_start.is_some() {
                features_end = index;
                break;
            }
            if trimmed == "[features]" {
                features_start = Some(index);
            }
        }
    }

    if let Some(start) = features_start {
        for line in lines.iter_mut().take(features_end).skip(start + 1) {
            let trimmed = line.trim_start();
            let Some(rest) = trimmed.strip_prefix("apps") else {
                continue;
            };
            if rest.trim_start().starts_with('=') {
                let indent_len = line.len() - trimmed.len();
                *line = format!("{}{}", " ".repeat(indent_len), apps_line);
                return format!("{}\n", lines.join("\n"));
            }
        }
        lines.insert(start + 1, apps_line);
        return format!("{}\n", lines.join("\n"));
    }

    let mut next = content.trim_end().to_string();
    if !next.is_empty() {
        next.push_str("\n\n");
    }
    next.push_str("[features]\n");
    next.push_str(&apps_line);
    next.push('\n');
    next
}

pub(super) fn write_codex_remote_apps_enabled(enabled: bool) -> Result<CodexLocalConfig, String> {
    let (codex_home, config_path) = wework_codex_config_path()?;
    fs::create_dir_all(&codex_home)
        .map_err(|error| format!("failed to create {}: {error}", codex_home.display()))?;
    let content = fs::read_to_string(&config_path).unwrap_or_default();
    let next_content = set_remote_apps_enabled_in_config(&content, enabled);
    fs::write(&config_path, next_content)
        .map_err(|error| format!("failed to write {}: {error}", config_path.display()))?;
    read_codex_local_config()
}

pub(super) fn copy_codex_initialization_entry(
    source: &Path,
    destination: &Path,
) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    if destination.exists() {
        if let (Ok(source_path), Ok(destination_path)) =
            (fs::canonicalize(source), fs::canonicalize(destination))
        {
            if source_path == destination_path {
                return Ok(());
            }
        }
    }
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("failed to inspect {}: {error}", source.display()))?;
    if metadata.is_dir() {
        copy_directory_recursive(source, destination)
    } else if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
        }
        fs::copy(source, destination).map_err(|error| {
            format!(
                "failed to copy {} to {}: {error}",
                source.display(),
                destination.display()
            )
        })?;
        Ok(())
    } else {
        Ok(())
    }
}

pub(super) fn copy_codex_initialization_files(
    source: &Path,
    destination: &Path,
) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("failed to create {}: {error}", destination.display()))?;

    let entries = [
        "config.toml",
        "auth.json",
        "AGENTS.md",
        "models_cache.json",
        "plugins",
        "skills",
        "cache",
        "vendor_imports",
    ];
    for entry in entries {
        let source_path = source.join(entry);
        let destination_path = destination.join(entry);
        log::info!(
            "Codex home initialization copying entry: source={}, destination={}",
            source_path.display(),
            destination_path.display()
        );
        copy_codex_initialization_entry(&source_path, &destination_path)?;
    }
    Ok(())
}

pub(super) fn import_external_content(source: &str) -> Result<ExternalContentImportResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory is not available".to_string())?;
    let executor_home = local_executor_home_path()?;
    let destination = wework_codex_home_path(&executor_home.display().to_string())?;
    import_external_content_from_paths(source, &home, &destination)
}

pub(super) fn import_external_content_from_paths(
    source: &str,
    home: &Path,
    destination: &Path,
) -> Result<ExternalContentImportResult, String> {
    let (source_path, entries): (PathBuf, Vec<(&str, &str)>) = match source {
        "codex" => (
            home.join(".codex"),
            vec![
                ("config.toml", "config.toml"),
                ("auth.json", "auth.json"),
                ("AGENTS.md", "AGENTS.md"),
                ("models_cache.json", "models_cache.json"),
                ("plugins", "plugins"),
                ("skills", "skills"),
                ("cache", "cache"),
                ("vendor_imports", "vendor_imports"),
            ],
        ),
        "claude-code" => (
            home.join(".claude"),
            vec![("CLAUDE.md", "AGENTS.md"), ("skills", "skills")],
        ),
        _ => return Err(format!("Unsupported import source: {source}")),
    };
    if !source_path.is_dir() {
        return Err(format!(
            "Import source does not exist: {}",
            source_path.display()
        ));
    }

    fs::create_dir_all(destination)
        .map_err(|error| format!("failed to create {}: {error}", destination.display()))?;
    let mut imported_entries = Vec::new();
    for (source_entry, destination_entry) in entries {
        let entry_path = source_path.join(source_entry);
        if !entry_path.exists() {
            continue;
        }
        copy_codex_initialization_entry(&entry_path, &destination.join(destination_entry))?;
        imported_entries.push(source_entry.to_string());
    }
    if imported_entries.is_empty() {
        return Err(format!(
            "No supported content was found in {}",
            source_path.display()
        ));
    }
    Ok(ExternalContentImportResult {
        source: source.to_string(),
        source_path: source_path.display().to_string(),
        destination_path: destination.display().to_string(),
        imported_entries,
    })
}

pub(super) fn copy_directory_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("failed to create {}: {error}", destination.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("failed to read {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect {}: {error}", source_path.display()))?;
        if file_type.is_dir() {
            copy_directory_recursive(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
            }
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "failed to copy {} to {}: {error}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        }
    }
    Ok(())
}
