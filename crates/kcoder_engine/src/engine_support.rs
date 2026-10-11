//! Engine support within the shared engine ownership boundary.

use super::*;

pub(super) fn doom_loop_limit_for_tool(
    tool_name: &str,
    settings: &DoomLoopSettings,
) -> Option<usize> {
    let repetitions = settings
        .tools
        .get(tool_name)
        .copied()
        .unwrap_or(settings.default_repetitions);
    if repetitions < 0 {
        None
    } else {
        Some((repetitions as usize).max(1))
    }
}

pub(super) fn recover_read_lock<'a, T>(
    lock: &'a RwLock<T>,
    name: &str,
) -> std::sync::RwLockReadGuard<'a, T> {
    match lock.read() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!(lock = name, "recovering poisoned read lock");
            poisoned.into_inner()
        }
    }
}

pub(super) fn recover_write_lock<'a, T>(
    lock: &'a RwLock<T>,
    name: &str,
) -> std::sync::RwLockWriteGuard<'a, T> {
    match lock.write() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!(lock = name, "recovering poisoned write lock");
            poisoned.into_inner()
        }
    }
}

pub(super) fn effective_max_concurrent_subagents(settings: &Settings) -> usize {
    if settings.max_concurrent_subagents == 0 {
        MAX_CONCURRENT_SUBAGENTS
    } else {
        settings
            .max_concurrent_subagents
            .min(MAX_CONCURRENT_SUBAGENTS)
    }
}

pub(super) fn monotonic_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

pub(super) fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(super) fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let keep = max_chars.saturating_sub(3);
    let mut truncated = value.chars().take(keep).collect::<String>();
    truncated.push_str("...");
    truncated
}
