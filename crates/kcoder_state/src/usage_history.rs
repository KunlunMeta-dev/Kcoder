//! Profile-scoped, metadata-only rolling usage counters, independent of transcript retention.

use anyhow::{Context, Result, ensure};
use chrono::{Days, NaiveDate, Utc};
use fs2::FileExt;
use kcoder_config::PrivateDirectory;
use kcoder_types::Usage;
pub use kcoder_types::usage_history::{UsageCounters, UsageHistory};
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::io::Read;
use std::path::Path;

const FILE: &str = "usage.json";
// Leave room for the app-server envelope below its 2 MiB frame limit.
const MAX_BYTES: u64 = 1024 * 1024;

fn increment(value: &mut u64, amount: u64) -> Result<()> {
    *value = value
        .checked_add(amount)
        .context("usage counter overflow")?;
    Ok(())
}

fn add(counter: &mut UsageCounters, usage: Option<&Usage>) -> Result<()> {
    increment(&mut counter.requests, 1)?;
    let Some(usage) = usage else {
        return increment(&mut counter.unreported_requests, 1);
    };
    increment(&mut counter.input_tokens, u64::from(usage.input_tokens))?;
    increment(&mut counter.output_tokens, u64::from(usage.output_tokens))?;
    increment(
        &mut counter.cache_read_tokens,
        u64::from(usage.cache_read_input_tokens.unwrap_or(0)),
    )?;
    increment(
        &mut counter.cache_creation_tokens,
        u64::from(usage.cache_creation_input_tokens.unwrap_or(0)),
    )?;
    let total = if let Some(total) = usage.total_tokens {
        u64::from(total)
    } else {
        increment(&mut counter.estimated_total_requests, 1)?;
        // Providers disagree on whether cached tokens are included in input. Never add
        // caches speculatively; expose this fallback as an estimate to the client.
        u64::from(usage.input_tokens) + u64::from(usage.output_tokens)
    };
    increment(&mut counter.total_tokens, total)
}

fn empty_history(now: u64) -> UsageHistory {
    UsageHistory {
        version: 1,
        tracked_since_ms: now,
        last_recorded_at_ms: now,
        days: BTreeMap::new(),
    }
}

fn read(directory: &PrivateDirectory) -> Result<Option<UsageHistory>> {
    let file = match directory.open_regular_file(OsStr::new(FILE)) {
        Ok(file) => file,
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error).context("failed to open usage history"),
    };
    ensure!(
        file.metadata()?.len() <= MAX_BYTES,
        "usage history exceeds its size limit"
    );
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_BYTES,
        "usage history exceeds its size limit"
    );
    let history: UsageHistory = serde_json::from_slice(&bytes).context("invalid usage history")?;
    ensure!(history.version == 1, "unsupported usage history version");
    for day in history.days.keys() {
        NaiveDate::parse_from_str(day, "%Y-%m-%d").context("invalid usage day")?;
    }
    Ok(Some(history))
}

fn day_at(timestamp_ms: u64) -> Result<NaiveDate> {
    let timestamp_ms = i64::try_from(timestamp_ms).context("invalid usage timestamp")?;
    Ok(chrono::DateTime::from_timestamp_millis(timestamp_ms)
        .context("invalid usage timestamp")?
        .date_naive())
}

fn retain_window(history: &mut UsageHistory, today: NaiveDate) {
    let start = today
        .checked_sub_days(Days::new(29))
        .unwrap_or(today)
        .to_string();
    let end = today.to_string();
    history.days.retain(|day, _| day >= &start && day <= &end);
}

/// Persist one completed or failed provider attempt. No prompts, keys or responses are stored.
pub fn record_usage(
    root: &Path,
    model: &str,
    usage: Option<&Usage>,
    timestamp_ms: u64,
) -> Result<()> {
    ensure!(
        model.len() <= 1024,
        "usage model name exceeds its size limit"
    );
    let today = day_at(timestamp_ms)?;
    let directory = PrivateDirectory::open_or_create(&std::path::absolute(root)?)?;
    directory.append(OsStr::new("usage.lock"), b"")?;
    let lock = directory.open_regular_file(OsStr::new("usage.lock"))?;
    lock.lock_exclusive()
        .context("failed to lock usage history")?;
    let mut history = read(&directory)?.unwrap_or_else(|| empty_history(timestamp_ms));
    let latest = timestamp_ms.max(history.last_recorded_at_ms);
    retain_window(&mut history, day_at(latest)?);
    add(
        history
            .days
            .entry(today.to_string())
            .or_default()
            .entry(model.to_owned())
            .or_default(),
        usage,
    )?;
    history.last_recorded_at_ms = latest;
    history.tracked_since_ms = history.tracked_since_ms.min(timestamp_ms);
    retain_window(&mut history, day_at(latest)?);
    let bytes = serde_json::to_vec(&history)?;
    ensure!(
        bytes.len() as u64 <= MAX_BYTES,
        "usage history exceeds its size limit"
    );
    directory.atomic_replace(OsStr::new(FILE), &bytes)?;
    Ok(())
}

/// Read the current UTC day and previous 29 days without creating a store or changing it.
pub fn read_usage(root: &Path) -> Result<Option<UsageHistory>> {
    read_usage_at(root, Utc::now().date_naive())
}

fn read_usage_at(root: &Path, today: NaiveDate) -> Result<Option<UsageHistory>> {
    if !root.try_exists()? {
        return Ok(None);
    }
    let directory = PrivateDirectory::open_existing(&std::path::absolute(root)?)?;
    let mut history = read(&directory)?;
    if let Some(history) = &mut history {
        retain_window(history, today);
    }
    Ok(history)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage() -> Usage {
        Usage {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: Some(120),
            cache_read_input_tokens: Some(80),
            cache_creation_input_tokens: None,
            iterations: None,
        }
    }

    #[test]
    fn survives_reopen_and_concurrent_writers_without_counting_caches_twice() {
        let dir = tempfile::tempdir().unwrap();
        let timestamp = 1_788_883_200_000;
        std::thread::scope(|scope| {
            for _ in 0..16 {
                let root = dir.path();
                scope
                    .spawn(move || record_usage(root, "model", Some(&usage()), timestamp).unwrap());
            }
        });
        let history = read_usage_at(dir.path(), day_at(timestamp).unwrap())
            .unwrap()
            .unwrap();
        let counter = &history.days.values().next().unwrap()["model"];
        assert_eq!(counter.requests, 16);
        assert_eq!(counter.total_tokens, 16 * 120);
        assert_eq!(counter.cache_read_tokens, 16 * 80);
        assert_eq!(counter.estimated_total_requests, 0);
    }

    #[test]
    fn retains_thirty_utc_days_and_marks_missing_usage_and_estimates() {
        let dir = tempfile::tempdir().unwrap();
        let start = 1_788_883_200_000;
        for day in 0..35 {
            record_usage(dir.path(), "model", None, start + day * 86_400_000).unwrap();
        }
        let now = start + 34 * 86_400_000;
        let mut estimated = usage();
        estimated.total_tokens = None;
        record_usage(dir.path(), "model", Some(&estimated), now).unwrap();
        let history = read_usage_at(dir.path(), day_at(now).unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(history.days.len(), 30);
        assert_eq!(history.tracked_since_ms, start);
        let last = &history.days.last_key_value().unwrap().1["model"];
        assert_eq!(last.unreported_requests, 1);
        assert_eq!(last.estimated_total_requests, 1);
        assert_eq!(last.total_tokens, 120);
    }

    #[test]
    fn reads_do_not_create_and_corruption_is_not_an_empty_success() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("usage");
        assert!(read_usage(&root).unwrap().is_none());
        assert!(!root.exists());
        record_usage(&root, "model", None, 1_788_883_200_000).unwrap();
        std::fs::write(root.join(FILE), b"invalid").unwrap();
        assert!(read_usage(&root).is_err());
        assert!(record_usage(&root, "model", None, 1_788_883_200_001).is_err());
        assert_eq!(std::fs::read(root.join(FILE)).unwrap(), b"invalid");
    }
}
