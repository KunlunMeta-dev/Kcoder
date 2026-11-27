use super::{StorageConsumer, StorageResolveInput};
use anyhow::{Result, bail, ensure};
use kcoder_types::{
    STORAGE_LOCATION_MAX_REVISION, STORAGE_LOCATION_VERSION, StorageLayout, StorageLocationRecord,
    StorageLocationSource as Source, StoragePathSources, StoragePaths,
};
use std::path::{Component, Path, PathBuf};

pub fn storage_location_file(home: &Path) -> PathBuf {
    home.join(".config").join("kcoder-storage.json")
}

pub(super) fn absolute(path: &Path) -> Result<PathBuf> {
    let text = path.as_os_str().as_encoded_bytes();
    ensure!(
        path.is_absolute()
            && text.len() <= 32767
            && !text.iter().any(|byte| [0, b'\r', b'\n'].contains(byte)),
        "STORAGE_PATH_INVALID"
    );
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            other => result.push(other.as_os_str()),
        }
    }
    Ok(result)
}

fn compared(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_owned()
    }
}

pub(super) fn valid_operation_id(id: &str) -> bool {
    if id.is_empty()
        || id.len() > 128
        || id.ends_with('.')
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return false;
    }
    // Receipts use this ID as a directory name on every supported platform.
    let stem = id
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(*prefix).is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
        })
}

pub fn validate_storage_location_record(record: &StorageLocationRecord) -> Result<()> {
    ensure!(
        record.version == STORAGE_LOCATION_VERSION,
        "STORAGE_RECORD_VERSION_UNSUPPORTED"
    );
    ensure!(
        record.revision > 0 && record.revision <= STORAGE_LOCATION_MAX_REVISION,
        "STORAGE_RECORD_INVALID"
    );
    if let Some(id) = &record.operation_id {
        ensure!(valid_operation_id(id), "STORAGE_RECORD_INVALID");
    }
    let data = compared(&absolute(&record.data_root)?);
    let cache = compared(&absolute(&record.cache_root)?);
    ensure!(
        !data.starts_with(&cache) && !cache.starts_with(&data),
        "STORAGE_ROOTS_OVERLAP"
    );
    Ok(())
}

/// Initial managed selection; callers supply the actual user's OS cache directory.
/// Existing installations keep legacy resolution until an offline operation commits.
pub fn default_storage_location(
    home: &Path,
    platform_cache: &Path,
) -> Result<StorageLocationRecord> {
    let cache = absolute(platform_cache)?.join("kcoder");
    // LocalAppData also contains retained installation backups and diagnostics.
    // Only the cache child belongs to a new managed Windows cache selection.
    #[cfg(windows)]
    let cache = cache.join("cache");
    let record = StorageLocationRecord {
        version: STORAGE_LOCATION_VERSION,
        revision: 1,
        data_root: absolute(home)?.join(".config").join("kcoder"),
        cache_root: cache,
        operation_id: None,
    };
    validate_storage_location_record(&record)?;
    Ok(record)
}

fn home(input: &StorageResolveInput) -> Result<PathBuf> {
    match &input.home {
        Some(home) => absolute(home),
        None => bail!("STORAGE_HOME_UNAVAILABLE"),
    }
}

pub fn resolve_storage_paths(input: &StorageResolveInput) -> Result<StoragePaths> {
    input.validate_environment(cfg!(windows))?;
    let record = if input.ignores_personal_selection() {
        None
    } else {
        input.record.as_ref()
    };
    if let Some(record) = record {
        validate_storage_location_record(record)?;
    }
    let (data_root, data_source) = if let Some(path) = input.value("KCODER_CONFIG_DIR") {
        (absolute(Path::new(path))?, Source::ConfigOverride)
    } else if let Some(path) = input.value("KCODER_HOME") {
        (absolute(Path::new(path))?, Source::HomeOverride)
    } else if input.development {
        (
            home(input)?.join(".config").join("kcoder-dev"),
            Source::Development,
        )
    } else if let Some(record) = record {
        (absolute(&record.data_root)?, Source::Selection)
    } else {
        (home(input)?.join(".config").join("kcoder"), Source::Default)
    };
    let (cache_root, cache_source, temporary_root) =
        if let Some(path) = input.value("KCODER_CACHE_DIR") {
            let root = absolute(Path::new(path))?;
            (root.clone(), Source::CacheOverride, root.join("tmp"))
        } else if let Some(record) = record {
            let root = absolute(&record.cache_root)?;
            (root.clone(), Source::Selection, root.join("tmp"))
        } else {
            let root = data_root.join("tmp");
            (root.clone(), data_source, root)
        };
    let (desktop_root, desktop_source) =
        if let Some(path) = input.value("KCODER_STUDIO_DESKTOP_USER_DATA_DIR") {
            (absolute(Path::new(path))?, Source::DesktopOverride)
        } else if record.is_some() {
            (data_root.join("studio").join("desktop"), Source::Selection)
        } else {
            let config = match &input.platform_config {
                Some(path) => absolute(path)?,
                None => home(input)?.join(".config"),
            };
            (config.join("kcoder-studio"), Source::Default)
        };
    let (gateway_root, gateway_source) = if let Some(path) = input.value("KCODER_STUDIO_DATA_DIR") {
        (absolute(Path::new(path))?, Source::DataOverride)
    } else if let Some(path) = input.value("KCODER_STUDIO_SERVERS_STORE") {
        let path = absolute(Path::new(path))?;
        (
            path.parent()
                .ok_or_else(|| anyhow::anyhow!("STORAGE_PATH_INVALID"))?
                .to_owned(),
            Source::ServersStoreOverride,
        )
    } else if record.is_some() {
        (data_root.join("studio").join("gateway"), Source::Selection)
    } else if input.consumer == StorageConsumer::Desktop {
        (desktop_root.clone(), desktop_source)
    } else {
        (
            home(input)?.join(".config").join("kcoder-studio"),
            Source::Default,
        )
    };
    let externally_configured = input.development
        || super::OVERRIDE_NAMES
            .iter()
            .any(|name| input.value(name).is_some());
    Ok(StoragePaths {
        data_root,
        cache_root,
        gateway_root,
        desktop_root,
        temporary_root,
        location_file: input.home.as_deref().map(storage_location_file),
        layout: if externally_configured {
            StorageLayout::Custom
        } else if record.is_some() {
            StorageLayout::Unified
        } else {
            StorageLayout::Legacy
        },
        sources: StoragePathSources {
            data_root: data_source,
            cache_root: cache_source,
            gateway_root: gateway_source,
            desktop_root: desktop_source,
        },
        externally_configured,
        selection_revision: record.map(|value| value.revision),
        operation_id: record.and_then(|value| value.operation_id.clone()),
    })
}
