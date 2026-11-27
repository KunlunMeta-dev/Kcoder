//! Bounded, deduplicated warnings for transient peer-channel failures.
//!
//! Every field is closed: `operation` and `side` are static names, `code` and
//! `underlying` are snake_case error codes (anything else is recorded as
//! `unrecognized`), and `cause` is a fixed class. Message text, thread or
//! session ids, paths, account names and tokens never enter a field.
use crate::{ToolError, ToolOutput};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Tracing target of peer-channel warnings; the CLI also routes it to `kcoder.log`.
pub const TARGET: &str = "kcoder::peer_channel";
/// Identical warnings (same operation, side, cause and code) are emitted at most once per window.
pub const DEDUPE_WINDOW: Duration = Duration::from_secs(30);
const MAX_TRACKED_KEYS: usize = 128;
const MAX_CODE_BYTES: usize = 96;
const UNRECOGNIZED: &str = "unrecognized";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PeerFailureCause {
    Timeout,
    ConnectRefused,
    EndpointMissing,
    LeaseLost,
    Decode,
    Permission,
    Busy,
    Unavailable,
    Other,
}

impl PeerFailureCause {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::ConnectRefused => "connect_refused",
            Self::EndpointMissing => "endpoint_missing",
            Self::LeaseLost => "lease_lost",
            Self::Decode => "decode",
            Self::Permission => "permission",
            Self::Busy => "busy",
            Self::Unavailable => "unavailable",
            Self::Other => "other",
        }
    }

    /// Coarse class from a closed error code. Order matters: the most specific
    /// transport facts win over generic `unavailable`/`unconfirmed` suffixes.
    pub fn from_code(code: &str) -> Self {
        let has = |needles: &[&str]| needles.iter().any(|needle| code.contains(needle));
        if has(&["timeout", "deadline", "elapsed"]) {
            Self::Timeout
        } else if has(&["connect", "refused"]) {
            Self::ConnectRefused
        } else if has(&[
            "endpoint",
            "locator",
            "absent",
            "missing",
            "stale",
            "channel_closed",
            "registry",
        ]) {
            Self::EndpointMissing
        } else if has(&[
            "owner",
            "lease",
            "changed",
            "closed",
            "handoff",
            "generation",
        ]) {
            Self::LeaseLost
        } else if has(&[
            "invalid_response",
            "response_invalid",
            "invalid_result",
            "invalid_receipt",
            "decode",
            "frame",
        ]) {
            Self::Decode
        } else if has(&["permission", "denied", "policy", "authoriz", "disabled"]) {
            Self::Permission
        } else if has(&["busy", "rate_limited", "capacity"]) {
            Self::Busy
        } else if has(&["unconfirmed", "unavailable", "unknown"]) {
            Self::Unavailable
        } else {
            Self::Other
        }
    }
}

/// Returns `text` only when it is a compiled-style snake_case code.
pub fn closed_code(text: &str) -> Option<&str> {
    let text = text.trim();
    let valid = !text.is_empty()
        && text.len() <= MAX_CODE_BYTES
        && text.contains('_')
        && text.starts_with(|ch: char| ch.is_ascii_lowercase())
        && text
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_');
    valid.then_some(text)
}

/// Accepts a lowercase code or an UPPER_SNAKE router code (e.g. a Gateway
/// JSON-RPC error message) and returns it lowercased; raw text yields `None`.
pub fn normalized_code(text: &str) -> Option<String> {
    let text = text.trim();
    if let Some(code) = closed_code(text) {
        return Some(code.to_owned());
    }
    let upper = text.len() <= MAX_CODE_BYTES
        && text.contains('_')
        && text.starts_with(|ch: char| ch.is_ascii_uppercase())
        && text
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_');
    upper.then(|| text.to_ascii_lowercase())
}

/// Extracts the code of a tool error message: a bare code, `code: recovery`
/// text, or the JSON `{"code": ...}` object used by uncertain sends.
pub fn tool_error_code(message: &str) -> String {
    let message = message.trim();
    if message.starts_with('{') {
        let code = serde_json::from_str::<serde_json::Value>(message)
            .ok()
            .and_then(|value| value.get("code")?.as_str().map(str::to_owned));
        return code
            .as_deref()
            .and_then(closed_code)
            .unwrap_or(UNRECOGNIZED)
            .to_owned();
    }
    let head = message.split(':').next().unwrap_or_default();
    closed_code(head).unwrap_or(UNRECOGNIZED).to_owned()
}

type LimiterKey = (&'static str, &'static str, PeerFailureCause, String);

struct LimiterEntry {
    last_emitted: Instant,
    suppressed: u64,
}

/// Per-key dedupe with a bounded key table.
pub struct WarningLimiter {
    window: Duration,
    entries: Mutex<HashMap<LimiterKey, LimiterEntry>>,
}

impl WarningLimiter {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// `Some(suppressed)` when a warning may be emitted now, carrying how many
    /// identical warnings were dropped since the previous emission.
    fn admit(&self, key: LimiterKey, now: Instant) -> Option<u64> {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = entries.get_mut(&key) {
            if now.saturating_duration_since(entry.last_emitted) < self.window {
                entry.suppressed = entry.suppressed.saturating_add(1);
                return None;
            }
            entry.last_emitted = now;
            return Some(std::mem::take(&mut entry.suppressed));
        }
        if entries.len() >= MAX_TRACKED_KEYS {
            let window = self.window;
            entries.retain(|_, entry| now.saturating_duration_since(entry.last_emitted) < window);
            if entries.len() >= MAX_TRACKED_KEYS {
                return None;
            }
        }
        entries.insert(
            key,
            LimiterEntry {
                last_emitted: now,
                suppressed: 0,
            },
        );
        Some(0)
    }
}

static LIMITER: LazyLock<WarningLimiter> = LazyLock::new(|| WarningLimiter::new(DEDUPE_WINDOW));

/// One failed peer-channel operation.
pub struct PeerFailure<'a> {
    /// Tool or host operation, e.g. `ListSessions`.
    pub operation: &'static str,
    /// `tool` for the model-facing boundary, or the host/channel kind.
    pub side: &'static str,
    /// Code returned to the caller.
    pub code: &'a str,
    /// Closed code of the underlying cause, when one is known.
    pub underlying: Option<&'a str>,
    pub cause: PeerFailureCause,
    pub elapsed: Duration,
    /// The call reconciles an earlier attempt under its original identity.
    pub retry: bool,
}

pub fn report(failure: PeerFailure<'_>) {
    let code = closed_code(failure.code).unwrap_or(UNRECOGNIZED);
    let underlying = failure
        .underlying
        .map(|code| closed_code(code).unwrap_or(UNRECOGNIZED))
        .unwrap_or("none");
    let key = (
        failure.operation,
        failure.side,
        failure.cause,
        format!("{code}/{underlying}"),
    );
    let Some(suppressed) = LIMITER.admit(key, Instant::now()) else {
        return;
    };
    tracing::warn!(
        target: TARGET,
        operation = failure.operation,
        side = failure.side,
        code,
        underlying,
        cause = failure.cause.as_str(),
        elapsed_ms = failure.elapsed.as_millis().min(u64::MAX as u128) as u64,
        retry = failure.retry,
        suppressed,
        "peer channel operation failed"
    );
}

/// Reports an execution failure at the model-facing tool boundary. Input
/// errors and cancellation are caller outcomes, not channel failures.
pub(crate) fn observe_tool_result(
    operation: &'static str,
    started: Instant,
    retry: bool,
    result: &Result<ToolOutput, ToolError>,
) {
    let Err(ToolError::Execution(message)) = result else {
        return;
    };
    let code = tool_error_code(message);
    if code.contains("cancelled") {
        return;
    }
    report(PeerFailure {
        operation,
        side: "tool",
        code: &code,
        underlying: None,
        cause: PeerFailureCause::from_code(&code),
        elapsed: started.elapsed(),
        retry,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_closed_and_classified_without_raw_text() {
        assert_eq!(
            tool_error_code("peer_message_receipt_list_unconfirmed"),
            "peer_message_receipt_list_unconfirmed"
        );
        assert_eq!(
            tool_error_code(
                r#"{"code":"peer_gateway_receipt_unconfirmed","status":"unknown","clientMessageId":"x"}"#
            ),
            "peer_gateway_receipt_unconfirmed"
        );
        assert_eq!(
            tool_error_code("session_not_readable: copy threadId exactly"),
            "session_not_readable"
        );
        assert_eq!(
            normalized_code("AGENT_MESSAGES_ENDPOINT_UNAVAILABLE").as_deref(),
            Some("agent_messages_endpoint_unavailable")
        );
        assert_eq!(normalized_code("Mixed_Case_text"), None);
        for raw in [
            "/home/alice/.kcoder/peer.sock: No such file",
            "Bearer secret-token",
            r#"{"code":"/private/path"}"#,
        ] {
            assert_eq!(tool_error_code(raw), UNRECOGNIZED, "{raw}");
        }
        for (code, cause) in [
            ("peer_source_response_timeout", PeerFailureCause::Timeout),
            (
                "peer_source_connect_unavailable",
                PeerFailureCause::ConnectRefused,
            ),
            (
                "peer_source_endpoint_absent",
                PeerFailureCause::EndpointMissing,
            ),
            (
                "peer_message_current_owner_unavailable",
                PeerFailureCause::LeaseLost,
            ),
            ("peer_gateway_response_invalid", PeerFailureCause::Decode),
            (
                "peer_source_permission_denied",
                PeerFailureCause::Permission,
            ),
            ("peer_session_directory_busy", PeerFailureCause::Busy),
            (
                "peer_message_source_history_unconfirmed",
                PeerFailureCause::Unavailable,
            ),
        ] {
            assert_eq!(PeerFailureCause::from_code(code), cause, "{code}");
        }
    }

    #[test]
    fn limiter_emits_once_per_window_and_counts_suppressed_repeats() {
        let limiter = WarningLimiter::new(Duration::from_secs(30));
        let start = Instant::now();
        let key = || {
            (
                "ListSessions",
                "tool",
                PeerFailureCause::Timeout,
                "a/none".to_string(),
            )
        };
        assert_eq!(limiter.admit(key(), start), Some(0));
        assert_eq!(limiter.admit(key(), start + Duration::from_secs(1)), None);
        assert_eq!(limiter.admit(key(), start + Duration::from_secs(29)), None);
        // A different cause is a different warning.
        let other = (
            "ListSessions",
            "tool",
            PeerFailureCause::Busy,
            "a/none".to_string(),
        );
        assert_eq!(limiter.admit(other, start), Some(0));
        assert_eq!(
            limiter.admit(key(), start + Duration::from_secs(31)),
            Some(2)
        );
        // The key table stays bounded under many distinct codes.
        for index in 0..(MAX_TRACKED_KEYS * 2) {
            limiter.admit(
                (
                    "ListSessions",
                    "tool",
                    PeerFailureCause::Other,
                    format!("code_{index}/none"),
                ),
                start + Duration::from_secs(31),
            );
        }
        assert!(limiter.entries.lock().unwrap().len() <= MAX_TRACKED_KEYS);
    }
}
