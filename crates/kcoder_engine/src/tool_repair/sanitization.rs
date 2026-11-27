use super::{
    MAX_ARRAY_ITEMS, MAX_ERROR_CHARS, MAX_JSON_CHARS, MAX_OBJECT_FIELDS, MAX_STRING_CHARS,
};
use serde_json::Value;

pub(super) fn failure_signature(error_summary: &str) -> String {
    sanitize_text(error_summary, MAX_ERROR_CHARS)
}

pub(super) fn sanitize_json(value: &Value) -> Value {
    sanitize_json_with_key(None, value)
}

fn sanitize_json_with_key(key: Option<&str>, value: &Value) -> Value {
    if key.is_some_and(is_sensitive_key) {
        return Value::String("<redacted>".to_string());
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(text) => Value::String(sanitize_text(text, MAX_STRING_CHARS)),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .take(MAX_ARRAY_ITEMS)
                .map(|value| sanitize_json_with_key(None, value))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .take(MAX_OBJECT_FIELDS)
                .map(|(key, value)| (key.clone(), sanitize_json_with_key(Some(key), value)))
                .collect(),
        ),
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "api_key",
        "apikey",
        "api-key",
        "token",
        "password",
        "passwd",
        "passphrase",
        "secret",
        "credential",
        "authorization",
        "auth",
        "cookie",
        "private_key",
        "privatekey",
        "access_key",
        "access-key",
        "ssh_key",
        "pwd",
    ]
    .iter()
    .any(|needle| key.contains(needle))
}

/// Best-effort scrubbing of credentials embedded in free-form text (shell
/// commands, error output). JSON key-based redaction alone misses secrets
/// passed as command-line flags or headers, e.g. `--api-key xyz` or
/// `Authorization: Bearer xyz`.
fn scrub_sensitive_text(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut redact_next = false;
    for token in text.split_whitespace() {
        if redact_next {
            // `Authorization: Bearer <token>` — keep the scheme word, redact
            // the actual credential that follows it.
            if token.eq_ignore_ascii_case("bearer") {
                out.push(token.to_string());
                continue;
            }
            redact_next = false;
            out.push("<redacted>".to_string());
            continue;
        }
        // `--api-key=xyz` / `password=xyz` forms: redact only the value.
        if let Some((key, value)) = token
            .split_once('=')
            .map(|(key, value)| (key.trim_start_matches('-'), value))
            && !value.is_empty()
            && is_sensitive_key(key)
        {
            let prefix_len = token.len() - value.len();
            out.push(format!("{}<redacted>", &token[..prefix_len]));
            continue;
        }
        // `--api-key xyz` / `Authorization: Bearer xyz` forms: the value is
        // the next whitespace-separated token.
        let bare = token.trim_start_matches('-').trim_end_matches(':');
        if is_sensitive_key(bare)
            || bare.eq_ignore_ascii_case("authorization")
            || bare.eq_ignore_ascii_case("bearer")
        {
            redact_next = true;
        }
        out.push(token.to_string());
    }
    out.join(" ")
}

pub(super) fn sanitize_text(text: &str, max_chars: usize) -> String {
    let scrubbed = scrub_sensitive_text(text);
    let collapsed = scrubbed.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&collapsed, max_chars)
}

pub(super) fn pretty_json_limited(value: &Value) -> String {
    let raw = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string());
    truncate_chars(&raw, MAX_JSON_CHARS)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let keep = max_chars.saturating_sub(3);
    let mut truncated = value.chars().take(keep).collect::<String>();
    truncated.push_str("...");
    truncated
}
