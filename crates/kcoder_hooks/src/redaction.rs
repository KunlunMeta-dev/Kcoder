pub fn hook_bytes_preview(bytes: &[u8]) -> String {
    hook_text_preview(&String::from_utf8_lossy(bytes))
}

pub fn hook_text_preview(text: &str) -> String {
    const MAX_CHARS: usize = 4096;
    let redacted = redact_hook_text(text);
    if redacted.chars().count() <= MAX_CHARS {
        redacted
    } else {
        format!(
            "{}…[truncated, {} chars]",
            redacted.chars().take(MAX_CHARS).collect::<String>(),
            text.chars().count()
        )
    }
}

fn redact_hook_text(text: &str) -> String {
    let mut redact_next = false;
    let mut parts = Vec::new();
    for token in text.split_whitespace() {
        let trimmed =
            token.trim_matches(|c: char| c == '\'' || c == '"' || c == '`' || c == ',' || c == ';');
        let lower = trimmed.to_ascii_lowercase();
        if redact_next {
            parts.push("[redacted]".to_string());
            redact_next = false;
            continue;
        }
        if lower == "bearer" {
            parts.push(token.to_string());
            redact_next = true;
            continue;
        }
        if is_sensitive_token(&lower) {
            parts.push("[redacted]".to_string());
            if sensitive_label_needs_next_value_redacted(&lower) {
                redact_next = true;
            }
        } else {
            parts.push(token.to_string());
        }
    }
    parts.join(" ")
}

fn is_sensitive_token(lower: &str) -> bool {
    let normalized = lower.replace(['-', '.'], "_");
    normalized.contains("api_key")
        || normalized.contains("apikey")
        || normalized.contains("authorization")
        || normalized.contains("password")
        || normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("sk-")
        || normalized.contains("sk_")
}

fn sensitive_label_needs_next_value_redacted(lower: &str) -> bool {
    let normalized = lower
        .trim_end_matches(':')
        .replace(['-', '.'], "_")
        .trim_matches('_')
        .to_string();
    (normalized.ends_with("api_key")
        || normalized.ends_with("apikey")
        || normalized.ends_with("authorization")
        || normalized.ends_with("password")
        || normalized.ends_with("token")
        || normalized.ends_with("secret"))
        && !lower.contains('=')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_text_preview_redacts_sensitive_tokens() {
        let preview = hook_text_preview(
            "OPENAI_API_KEY=sk-secret curl -H 'Authorization: Bearer token-value' https://example.test",
        );

        assert!(preview.contains("[redacted]"));
        assert!(!preview.contains("sk-secret"));
        assert!(!preview.contains("token-value"));
        assert!(!preview.contains("OPENAI_API_KEY=sk-secret"));
    }

    #[test]
    fn hook_text_preview_redacts_values_after_sensitive_labels() {
        let preview = hook_text_preview(
            "X-API-Key: opaque-value password hunter2 Authorization: opaque-token",
        );

        assert!(preview.contains("[redacted]"));
        assert!(!preview.contains("opaque-value"));
        assert!(!preview.contains("hunter2"));
        assert!(!preview.contains("opaque-token"));
    }
}
