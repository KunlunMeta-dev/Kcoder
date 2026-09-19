//! Storage and debug-recorder diagnostics for Studio (`diagnostics/*` RPCs).

use anyhow::{Context, Result, bail};
use kcoder_app_protocol::{
    DebugLogDisableResult, DevDebugStatus, StorageBucket, StorageCleanResult, StorageReport,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Cleanup targets that `diagnostics/storage/clean` accepts.
const TARGET_DEBUG_LOGS: &str = "debug-logs";
const TARGET_TURN_SNAPSHOTS: &str = "turn-snapshots";

pub(super) fn read_report() -> Result<StorageReport> {
    report_for(&config_root()?)
}

fn config_root() -> Result<PathBuf> {
    Ok(kcoder_config::Settings::config_dir()?)
}

fn report_for(root: &Path) -> Result<StorageReport> {
    let mut buckets = vec![
        StorageBucket {
            id: "debug-logs".into(),
            bytes: 0,
            files: 0,
            cleanable: true,
        },
        StorageBucket {
            id: "turn-snapshots".into(),
            bytes: 0,
            files: 0,
            cleanable: true,
        },
        StorageBucket {
            id: "session-data".into(),
            bytes: 0,
            files: 0,
            cleanable: false,
        },
        StorageBucket {
            id: "plugins-and-skills".into(),
            bytes: 0,
            files: 0,
            cleanable: false,
        },
        StorageBucket {
            id: "other".into(),
            bytes: 0,
            files: 0,
            cleanable: false,
        },
    ];
    let mut total_bytes = 0u64;
    let mut total_files = 0usize;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or_default();
            total_bytes += size;
            total_files += 1;
            let relative = path.strip_prefix(root).unwrap_or(&path);
            let id = bucket_for(relative);
            if let Some(bucket) = buckets.iter_mut().find(|bucket| bucket.id == id) {
                bucket.bytes += size;
                bucket.files += 1;
            }
        }
    }
    let log_root = root.join("logs").join("llm-request");
    let usage = kcoder_api::providers::debug_log::debug_log_usage_at(&log_root);
    let dev_debug = DevDebugStatus {
        enabled: kcoder_api::providers::debug_log::dev_debug_enabled(),
        env_set: std::env::var("DEV_DEBUG").is_ok(),
        dotenv_lines: count_debug_switches_in_dotenv(&root.join(".env"))?,
        retention_days: kcoder_api::providers::debug_log::DEBUG_LOG_RETENTION_DAYS,
        log_bytes: usage.bytes,
        log_files: usage.files,
        oldest_day: usage.oldest_day,
    };
    Ok(StorageReport {
        config_root: root.display().to_string(),
        total_bytes,
        total_files,
        buckets,
        dev_debug,
        credentials: credentials_status(root)?,
    })
}

/// Credential store location, permissions and `.env` exposure.
fn credentials_status(root: &Path) -> Result<kcoder_app_protocol::CredentialsStatus> {
    let path = root.join("credentials.json");
    let present = path.is_file();
    let document = fs::read_to_string(&path)
        .ok()
        .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok());
    let providers = document
        .as_ref()
        .and_then(|value| value.as_object().map(|object| object.len()))
        .unwrap_or(0);
    let (keyring_providers, plaintext_providers) = classify_stored_credentials(document.as_ref());
    let backend = kcoder_config::OsCredentialBackend::new();
    Ok(kcoder_app_protocol::CredentialsStatus {
        path: path.display().to_string(),
        present,
        user_only: kcoder_config::is_user_only_file(&path),
        providers,
        dotenv_credential_lines: credential_lines_in_dotenv(&root.join(".env"))?,
        keyring_available: kcoder_config::CredentialBackend::available(&backend),
        keyring_backend: kcoder_config::CredentialBackend::describe(&backend),
        keyring_providers,
        plaintext_providers,
    })
}

/// Split the credential document into keyring-backed and plaintext providers.
///
/// Both the current (`{"key": "..."}`) and the legacy (`api_keys`) shapes are understood; a
/// missing or unreadable document simply reports nothing.
fn classify_stored_credentials(document: Option<&serde_json::Value>) -> (Vec<String>, Vec<String>) {
    use kcoder_config::provider_from_marker;
    let Some(object) = document.and_then(serde_json::Value::as_object) else {
        return (Vec::new(), Vec::new());
    };
    let Some(entries) = object
        .get("api_keys")
        .and_then(serde_json::Value::as_object)
        .or_else(|| {
            // The current shape nests credentials per provider; drop the legacy wrapper if present.
            if object.contains_key("api_keys") {
                None
            } else {
                Some(object)
            }
        })
    else {
        return (Vec::new(), Vec::new());
    };
    let mut keyring = Vec::new();
    let mut plaintext = Vec::new();
    for (provider, value) in entries {
        let secret = value
            .get("key")
            .and_then(serde_json::Value::as_str)
            .or_else(|| value.as_str());
        match secret {
            Some(secret) if provider_from_marker(secret).is_some() => {
                keyring.push(provider.clone())
            }
            Some(_) => plaintext.push(provider.clone()),
            None => {}
        }
    }
    keyring.sort();
    plaintext.sort();
    (keyring, plaintext)
}

fn credential_lines_in_dotenv(path: &Path) -> Result<usize> {
    let Ok(contents) = fs::read_to_string(path) else {
        return Ok(0);
    };
    Ok(contents
        .lines()
        .filter(|line| {
            let body = line.trim();
            if body.is_empty() || body.starts_with('#') {
                return false;
            }
            body.split('=')
                .next()
                .is_some_and(kcoder_config::looks_like_credential_env_key)
        })
        .count())
}

/// Maps a config-relative path onto one of the report buckets.
fn bucket_for(relative: &Path) -> &'static str {
    let parts: Vec<String> = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    let joined_has = |needle: &str| parts.iter().any(|part| part == needle);
    if parts.first().map(String::as_str) == Some("logs") && joined_has("llm-request") {
        return "debug-logs";
    }
    if joined_has("turn-file-changes") {
        return "turn-snapshots";
    }
    match parts.first().map(String::as_str) {
        Some("projects") => "session-data",
        Some("plugin_store") | Some("skills") => "plugins-and-skills",
        _ => "other",
    }
}

fn count_debug_switches_in_dotenv(path: &Path) -> Result<usize> {
    let Ok(contents) = fs::read_to_string(path) else {
        return Ok(0);
    };
    Ok(contents
        .lines()
        .filter(|line| {
            let body = line.trim();
            !body.starts_with('#')
                && body
                    .split('=')
                    .next()
                    .map(|key| key.trim().eq_ignore_ascii_case("DEV_DEBUG"))
                    .unwrap_or(false)
        })
        .count())
}

pub(super) fn clean(target: &str, confirm: bool) -> Result<StorageCleanResult> {
    if !confirm {
        bail!("storage cleanup requires confirm=true");
    }
    let root = config_root()?;
    let (removed_bytes, removed_files) = match target {
        TARGET_DEBUG_LOGS => remove_directory(&root.join("logs").join("llm-request"))?,
        TARGET_TURN_SNAPSHOTS => {
            let mut bytes = 0u64;
            let mut files = 0usize;
            for dir in snapshot_repositories(&root)? {
                let (dir_bytes, dir_files) = directory_footprint(&dir);
                bytes += dir_bytes;
                files += dir_files;
                remove_directory(&dir)?;
            }
            (bytes, files)
        }
        other => bail!("unknown storage cleanup target: {other}"),
    };
    Ok(StorageCleanResult {
        removed_bytes,
        removed_files,
        report: report_for(&root)?,
    })
}

fn snapshot_repositories(root: &Path) -> Result<Vec<PathBuf>> {
    let projects = root.join("projects");
    let mut found = Vec::new();
    let mut stack = vec![projects];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("snapshot-repository-") {
                found.push(entry.path());
            } else {
                stack.push(entry.path());
            }
        }
    }
    Ok(found)
}

fn directory_footprint(path: &Path) -> (u64, usize) {
    let mut bytes = 0u64;
    let mut files = 0usize;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            match entry.file_type() {
                Ok(file_type) if file_type.is_dir() => stack.push(entry.path()),
                Ok(file_type) if file_type.is_file() => {
                    files += 1;
                    bytes += entry.metadata().map(|meta| meta.len()).unwrap_or_default();
                }
                _ => {}
            }
        }
    }
    (bytes, files)
}

fn remove_directory(path: &Path) -> Result<(u64, usize)> {
    let (bytes, files) = directory_footprint(path);
    match fs::remove_dir_all(path) {
        Ok(()) => Ok((bytes, files)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((0, 0)),
        Err(error) => Err(error).with_context(|| format!("failed to remove {}", path.display())),
    }
}

/// Outcome of one snapshot-budget enforcement pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SnapshotGcOutcome {
    pub removed_snapshots: usize,
    pub removed_bytes: u64,
    pub remaining_bytes: u64,
}

/// Reclaims turn-file snapshots per `turn_file_changes` policy.
///
/// Age wins over size: snapshots older than `retention_days` go first, then the
/// oldest remaining snapshots are dropped until the footprint fits
/// `max_total_bytes`. Reclamation is independent of `enabled`: turning new
/// snapshots off must not keep stale bytes on disk forever.
/// Scratch repositories from an interrupted turn are reclaimed after this long without a touch;
/// a live turn updates its own repository continuously.
const ABANDONED_SNAPSHOT_REPOSITORY_AGE: Duration = Duration::from_secs(60 * 60);

pub(super) fn enforce_turn_snapshot_budget_at(
    projects_root: &Path,
    policy: &kcoder_config::TurnFileChangesSettings,
    now: SystemTime,
) -> SnapshotGcOutcome {
    enforce_turn_snapshot_budget_at_with(
        projects_root,
        policy,
        now,
        ABANDONED_SNAPSHOT_REPOSITORY_AGE,
    )
}

pub(super) fn enforce_turn_snapshot_budget_at_with(
    projects_root: &Path,
    policy: &kcoder_config::TurnFileChangesSettings,
    now: SystemTime,
    abandoned_age: Duration,
) -> SnapshotGcOutcome {
    let mut snapshots = Vec::new();
    let mut abandoned_snapshots = 0usize;
    let mut abandoned_bytes = 0u64;
    let mut stack = vec![projects_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("snapshot-repository-") || name.starts_with("revert-repository-") {
                // Read the age before repairing: writing HEAD/config into the directory bumps
                // its mtime, which would hide an old repository from the retention rules below.
                let modified = entry
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .unwrap_or(now);
                let (bytes, _) = directory_footprint(&entry.path());
                // Repositories written before the layout fix lack HEAD/config; repair them while
                // the budget walk already has the directory at hand.
                if let Err(error) = super::git::ensure_bare_snapshot_layout(&entry.path()) {
                    tracing::warn!(
                        %error,
                        path = %entry.path().display(),
                        "failed to repair snapshot repository layout"
                    );
                }
                // These repositories are scratch space for one turn: a finished turn removes its
                // own, so a directory nobody touched for a while is debris from an interrupted
                // session (the 27 repositories / 50 GB the audit found) and is reclaimed now.
                if now.duration_since(modified).unwrap_or_default() > abandoned_age {
                    if remove_directory(&entry.path()).is_ok() {
                        abandoned_snapshots += 1;
                        abandoned_bytes += bytes;
                    }
                    continue;
                }
                snapshots.push((modified, bytes, entry.path()));
            } else {
                stack.push(entry.path());
            }
        }
    }
    snapshots.sort_by(|left, right| left.0.cmp(&right.0));

    let mut removed_snapshots = abandoned_snapshots;
    let mut removed_bytes = abandoned_bytes;
    let mut kept = Vec::new();
    if policy.retention_days > 0 {
        let cutoff = now
            .checked_sub(Duration::from_secs(policy.retention_days * 24 * 60 * 60))
            .unwrap_or(UNIX_EPOCH);
        for (modified, bytes, path) in snapshots {
            if modified < cutoff {
                if remove_directory(&path).is_ok() {
                    removed_snapshots += 1;
                    removed_bytes += bytes;
                }
            } else {
                kept.push((modified, bytes, path));
            }
        }
    } else {
        kept = snapshots;
    }

    let mut remaining: u64 = kept.iter().map(|(_, bytes, _)| *bytes).sum();
    if policy.max_total_bytes > 0 {
        for (_, bytes, path) in &kept {
            if remaining <= policy.max_total_bytes {
                break;
            }
            if remove_directory(path).is_ok() {
                removed_snapshots += 1;
                removed_bytes += bytes;
                remaining = remaining.saturating_sub(*bytes);
            }
        }
    }
    SnapshotGcOutcome {
        removed_snapshots,
        removed_bytes,
        remaining_bytes: remaining,
    }
}

/// Applies the budget to the active configuration directory.
pub(super) fn enforce_turn_snapshot_budget(
    policy: &kcoder_config::TurnFileChangesSettings,
) -> Result<SnapshotGcOutcome> {
    let root = config_root()?.join("projects");
    Ok(enforce_turn_snapshot_budget_at(
        &root,
        policy,
        SystemTime::now(),
    ))
}

/// Comments out `DEV_DEBUG` assignments so future launches stop recording.
pub(super) fn disable_debug_log() -> Result<DebugLogDisableResult> {
    let dotenv_path = config_root()?.join(".env");
    let Ok(contents) = fs::read_to_string(&dotenv_path) else {
        return Ok(DebugLogDisableResult {
            changed: false,
            dotenv_path: dotenv_path.display().to_string(),
            note: "no .env file in the configuration directory".into(),
        });
    };
    let (updated, changed_lines) = comment_out_dev_debug(&contents);
    if changed_lines > 0 {
        write_user_file(&dotenv_path, &updated)?;
    }
    let env_set = std::env::var("DEV_DEBUG").is_ok();
    let note = match (changed_lines, env_set) {
        (0, true) => {
            "DEV_DEBUG comes from the environment; unset it where the server is launched".into()
        }
        (0, false) => "DEV_DEBUG is not set in the environment or .env".into(),
        (_, true) => {
            "commented out in .env; also unset DEV_DEBUG in the launching environment".into()
        }
        (_, false) => "commented out in .env; restart the server to stop recording".into(),
    };
    Ok(DebugLogDisableResult {
        changed: changed_lines > 0,
        dotenv_path: dotenv_path.display().to_string(),
        note,
    })
}

/// Prefixes active `DEV_DEBUG` assignments with `#`, returning how many changed.
fn comment_out_dev_debug(contents: &str) -> (String, usize) {
    let mut changed = 0usize;
    let mut updated = String::with_capacity(contents.len());
    for line in contents.split_inclusive('\n') {
        let body = line.trim_end_matches(['\n', '\r']);
        let key = body.split('=').next().unwrap_or("").trim();
        if !body.trim_start().starts_with('#') && key.eq_ignore_ascii_case("DEV_DEBUG") {
            updated.push_str("# ");
            updated.push_str(line);
            changed += 1;
        } else {
            updated.push_str(line);
        }
    }
    (updated, changed)
}

fn write_user_file(path: &Path, contents: &str) -> Result<()> {
    let parent = path.parent().context("dotenv path has no parent")?;
    let temp = parent.join(format!(".env.tmp-{}", std::process::id()));
    fs::write(&temp, contents).with_context(|| format!("failed to write {}", temp.display()))?;
    kcoder_config::set_user_only_file_permissions(&temp)?;
    fs::rename(&temp, path).with_context(|| format!("failed to replace {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_route_config_paths_to_their_slices() {
        assert_eq!(
            bucket_for(Path::new("logs/llm-request/20260918/a/request.json")),
            "debug-logs"
        );
        assert_eq!(
            bucket_for(Path::new(
                "projects/demo/client-sessions/s1/turn-file-changes/snapshot-repository-ab/objects/aa"
            )),
            "turn-snapshots"
        );
        assert_eq!(
            bucket_for(Path::new(
                "projects/demo/client-sessions/s1/transcript.jsonl"
            )),
            "session-data"
        );
        assert_eq!(
            bucket_for(Path::new("plugin_store/state.json")),
            "plugins-and-skills"
        );
        assert_eq!(
            bucket_for(Path::new("skills/demo/SKILL.md")),
            "plugins-and-skills"
        );
        assert_eq!(bucket_for(Path::new("settings.json")), "other");
    }

    fn seed_snapshot(root: &Path, session: &str, bytes: usize) -> PathBuf {
        let dir = root
            .join("demo")
            .join("client-sessions")
            .join(session)
            .join("turn-file-changes")
            .join(format!("snapshot-repository-{session}"))
            .join("objects");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("blob"), vec![b'x'; bytes]).unwrap();
        dir.parent().unwrap().to_path_buf()
    }

    /// Disables the abandoned-repository sweep for tests that isolate the budget rules.
    const ONE_YEAR: Duration = Duration::from_secs(365 * 24 * 60 * 60);

    fn touch_age(path: &Path, days_ago: u64, now: SystemTime) {
        let stamp = now - Duration::from_secs(days_ago * 24 * 60 * 60);
        let _ = filetime_set(path, stamp);
    }

    /// Minimal mtime update via `touch -d` so the test stays dependency free.
    fn filetime_set(path: &Path, when: SystemTime) -> std::io::Result<()> {
        let secs = when
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or_default();
        let status = std::process::Command::new("touch")
            .arg("-d")
            .arg(format!("@{secs}"))
            .arg(path)
            .status()?;
        assert!(status.success(), "touch failed for {}", path.display());
        Ok(())
    }

    #[test]
    fn retention_reclaims_only_expired_snapshots() {
        let root = std::env::temp_dir().join(format!("kcoder-snapshot-gc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let now = SystemTime::now();
        let old = seed_snapshot(&root, "old", 1024);
        let fresh = seed_snapshot(&root, "fresh", 2048);
        touch_age(&old, 30, now);
        touch_age(&fresh, 1, now);

        let policy = kcoder_config::TurnFileChangesSettings {
            retention_days: 14,
            max_total_bytes: 0,
            ..kcoder_config::TurnFileChangesSettings::default()
        };
        // Scratch repositories are ephemeral in practice; keep the debris sweep out of this
        // test so it isolates the retention rule.
        let outcome = enforce_turn_snapshot_budget_at_with(&root, &policy, now, ONE_YEAR);
        assert_eq!(outcome.removed_snapshots, 1);
        assert_eq!(outcome.removed_bytes, 1024);
        assert_eq!(outcome.remaining_bytes, 2048);
        assert!(!old.exists());
        assert!(fresh.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn size_budget_reclaims_the_oldest_snapshots_first() {
        let root =
            std::env::temp_dir().join(format!("kcoder-snapshot-budget-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let now = SystemTime::now();
        let oldest = seed_snapshot(&root, "a", 1024);
        let middle = seed_snapshot(&root, "b", 1024);
        let newest = seed_snapshot(&root, "c", 1024);
        touch_age(&oldest, 3, now);
        touch_age(&middle, 2, now);
        touch_age(&newest, 1, now);

        let policy = kcoder_config::TurnFileChangesSettings {
            retention_days: 0,
            max_total_bytes: 2048,
            ..kcoder_config::TurnFileChangesSettings::default()
        };
        let outcome = enforce_turn_snapshot_budget_at_with(&root, &policy, now, ONE_YEAR);
        assert_eq!(outcome.removed_snapshots, 1, "only the oldest slides out");
        assert_eq!(outcome.remaining_bytes, 2048);
        assert!(!oldest.exists());
        assert!(middle.exists());
        assert!(newest.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn credential_status_reports_permissions_and_dotenv_exposure() {
        let root = std::env::temp_dir().join(format!("kcoder-credentials-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("credentials.json"),
            r#"{"kunlunmeta": "secret-a", "local": "secret-b"}"#,
        )
        .unwrap();
        fs::write(
            root.join(".env"),
            "KUNLUNMETA_BASE_API_KEY=x\nHTTPS_PROXY=http://proxy\n# GATEWAY_TOKEN=y\n",
        )
        .unwrap();

        let status = credentials_status(&root).unwrap();
        assert!(status.present);
        assert_eq!(status.providers, 2);
        assert_eq!(
            status.dotenv_credential_lines, 1,
            "commented lines do not count"
        );
        assert_eq!(status.user_only, Some(false), "0644 stays exposed");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn comment_out_dev_debug_only_touches_active_assignments() {
        let (updated, changed) = comment_out_dev_debug(
            "DEV_DEBUG=1\nKUNLUNMETA_BASE_API_KEY=secret\n# DEV_DEBUG=0\ndev_debug = 1\n",
        );
        assert_eq!(changed, 2);
        assert!(updated.contains("# DEV_DEBUG=1"));
        assert!(updated.contains("KUNLUNMETA_BASE_API_KEY=secret"));
        assert!(updated.contains("# dev_debug = 1"));
        assert!(
            updated.contains("# DEV_DEBUG=0"),
            "already commented lines stay untouched"
        );
    }
}
