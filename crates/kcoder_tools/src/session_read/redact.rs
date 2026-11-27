//! Best-effort removal of credentials from conversation text before a model sees it.
//! Patterns favour formatting-preserving replacement; absence of a match is not proof
//! that a text contains no secret.
use regex::{Captures, Regex};
use std::sync::LazyLock;

pub const REDACTION_MARKER: &str = "[已省略敏感内容]";

static PRIVATE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?s:.*?)(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|\z)")
        .expect("valid private key pattern")
});
static KNOWN_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"\b(?:",
        r"sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_\-]{16,}",
        r"|sk_(?:live|test)_[A-Za-z0-9]{16,}",
        r"|gh[pousr]_[A-Za-z0-9]{20,}",
        r"|github_pat_[A-Za-z0-9_]{20,}",
        r"|glpat-[A-Za-z0-9_\-]{20,}",
        r"|xox[abprse]-[A-Za-z0-9\-]{10,}",
        r"|(?:AKIA|ASIA)[0-9A-Z]{16}",
        r"|AIza[0-9A-Za-z_\-]{35}",
        r"|eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
        r")"
    ))
    .expect("valid token pattern")
});
static BEARER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(bearer|basic)(\s+)[A-Za-z0-9\-._~+/]{8,}=*")
        .expect("valid authorization pattern")
});
static URL_CREDENTIALS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b([a-z][a-z0-9+.\-]*://)[^/\s:@]+:[^/\s@]+@")
        .expect("valid URL credential pattern")
});
static KEY_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)\b([A-Za-z0-9_.\-]*(?:password|passwd|passphrase|pwd|secret|token|api[_\-]?key|access[_\-]?key|private[_\-]?key|credential|authorization)[A-Za-z0-9_.\-]*)",
        r#"(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)"#
    ))
    .expect("valid key-value pattern")
});
static CHINESE_KEY_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(密码|口令|密钥|令牌|私钥|凭据)(\s*(?:[:：=]|是|为)\s*)([^\s，。；,;：:]*[A-Za-z0-9][^\s，。；,;]*)")
        .expect("valid Chinese key-value pattern")
});

/// Replace recognizable credentials with a visible marker. Returns whether anything changed.
pub fn redact_secrets(text: &str) -> (String, bool) {
    let mut value = PRIVATE_KEY.replace_all(text, REDACTION_MARKER).into_owned();
    value = URL_CREDENTIALS
        .replace_all(&value, |caps: &Captures| {
            format!("{}{REDACTION_MARKER}@", &caps[1])
        })
        .into_owned();
    value = BEARER
        .replace_all(&value, |caps: &Captures| {
            format!("{}{}{REDACTION_MARKER}", &caps[1], &caps[2])
        })
        .into_owned();
    value = KNOWN_TOKEN
        .replace_all(&value, REDACTION_MARKER)
        .into_owned();
    value = KEY_VALUE
        .replace_all(&value, |caps: &Captures| {
            let raw = caps[3].trim_matches(|c| c == '"' || c == '\'');
            let key = caps[1].to_ascii_lowercase();
            // Counters such as max_tokens=4096 are configuration, not credentials.
            let numeric_count = key.contains("token")
                && !raw.is_empty()
                && raw.len() <= 12
                && raw.chars().all(|c| c.is_ascii_digit());
            let scheme = raw.eq_ignore_ascii_case("bearer") || raw.eq_ignore_ascii_case("basic");
            if numeric_count || scheme || raw.is_empty() || raw.contains(REDACTION_MARKER) {
                caps[0].to_owned()
            } else {
                format!("{}{}{REDACTION_MARKER}", &caps[1], &caps[2])
            }
        })
        .into_owned();
    value = CHINESE_KEY_VALUE
        .replace_all(&value, |caps: &Captures| {
            format!("{}{}{REDACTION_MARKER}", &caps[1], &caps[2])
        })
        .into_owned();
    let changed = value != text;
    (value, changed)
}
