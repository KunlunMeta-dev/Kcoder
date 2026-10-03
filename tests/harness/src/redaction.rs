use anyhow::Result;
use serde_json::Value;

const REDACTED: &str = "[REDACTED]";

#[derive(Debug, Clone, Default)]
pub struct SecretRedactor {
    secrets: Vec<String>,
}

impl SecretRedactor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, secret: impl Into<String>) -> Result<()> {
        let secret = secret.into();
        // Extremely short values such as the common approval marker "1" would corrupt
        // every log and numeric datum, so they cannot be registered as literal replacement secrets.
        anyhow::ensure!(secret.chars().count() >= 8, "secret 长度不能少于 8 个字符");
        if self.secrets.iter().any(|known| known == &secret) {
            return Ok(());
        }
        self.secrets.push(secret);
        self.secrets
            .sort_by_key(|value| std::cmp::Reverse(value.len()));
        Ok(())
    }

    pub fn redact_text(&self, text: &str) -> String {
        self.secrets
            .iter()
            .fold(text.to_string(), |redacted, secret| {
                redacted.replace(secret, REDACTED)
            })
    }

    pub fn redact_value(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.redact_text(text)),
            Value::Array(values) => Value::Array(
                values
                    .iter()
                    .map(|value| self.redact_value(value))
                    .collect(),
            ),
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .map(|(key, value)| {
                        let value = if sensitive_key(key) {
                            Value::String(REDACTED.to_string())
                        } else {
                            self.redact_value(value)
                        };
                        (key.clone(), value)
                    })
                    .collect(),
            ),
            _ => value.clone(),
        }
    }

    pub fn streaming(&self) -> StreamingRedactor {
        StreamingRedactor {
            redactor: self.clone(),
            pending: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct StreamingRedactor {
    redactor: SecretRedactor,
    pending: Vec<u8>,
}

impl StreamingRedactor {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut boundary = self
            .pending
            .len()
            .saturating_sub(self.overlap().saturating_sub(1));
        boundary = self.move_before_crossing_secret(boundary);
        boundary = complete_utf8_prefix(&self.pending[..boundary]);
        boundary = self.move_before_crossing_secret(boundary);
        if boundary == 0 {
            return String::new();
        }
        let raw = self.pending.drain(..boundary).collect::<Vec<_>>();
        self.redact_bytes(&raw)
    }

    pub fn finish(&mut self) -> String {
        let raw = std::mem::take(&mut self.pending);
        self.redact_bytes(&raw)
    }

    fn overlap(&self) -> usize {
        self.redactor
            .secrets
            .iter()
            .map(String::len)
            .max()
            .unwrap_or(0)
    }

    fn move_before_crossing_secret(&self, mut boundary: usize) -> usize {
        loop {
            let previous = boundary;
            for secret in &self.redactor.secrets {
                let secret = secret.as_bytes();
                let search_start = boundary.saturating_sub(secret.len().saturating_sub(1));
                let mut offset = search_start;
                while offset < boundary && offset + secret.len() <= self.pending.len() {
                    let Some(relative) = find_bytes(&self.pending[offset..], secret) else {
                        break;
                    };
                    let start = offset + relative;
                    if start >= boundary {
                        break;
                    }
                    if start + secret.len() > boundary {
                        boundary = boundary.min(start);
                        break;
                    }
                    offset = start + 1;
                }
            }
            if boundary == previous {
                return boundary;
            }
        }
    }

    fn redact_bytes(&self, bytes: &[u8]) -> String {
        let mut redacted = Vec::with_capacity(bytes.len());
        let mut offset = 0;
        while offset < bytes.len() {
            if let Some(secret) = self
                .redactor
                .secrets
                .iter()
                .map(String::as_bytes)
                .find(|secret| bytes[offset..].starts_with(secret))
            {
                redacted.extend_from_slice(REDACTED.as_bytes());
                offset += secret.len();
            } else {
                redacted.push(bytes[offset]);
                offset += 1;
            }
        }
        String::from_utf8_lossy(&redacted).into_owned()
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|candidate| candidate == needle)
}

fn complete_utf8_prefix(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        Err(_) => bytes.len(),
    }
}

fn sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['-', '.'], "_");
    normalized.contains("password")
        || normalized.contains("secret")
        || normalized.contains("token")
        || normalized.contains("api_key")
        || normalized == "authorization"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_redactor_hides_long_unicode_secret_across_arbitrary_boundaries() {
        let secret = format!("密钥-{}-结束", "x".repeat(70 * 1024));
        let mut redactor = SecretRedactor::new();
        redactor.register(&secret).unwrap();
        let bytes = format!("before\n{secret}\nafter").into_bytes();
        let first = "before\n密".len();
        let second = first + 33 * 1024;
        let mut stream = redactor.streaming();
        let output = [
            stream.push(&bytes[..first]),
            stream.push(&bytes[first..second]),
            stream.push(&bytes[second..]),
            stream.finish(),
        ]
        .concat();

        assert_eq!(output, "before\n[REDACTED]\nafter");
        assert!(!output.contains(&secret));
    }

    #[test]
    fn streaming_redactor_preserves_unicode_split_between_input_bytes() {
        let mut redactor = SecretRedactor::new();
        redactor.register("秘密凭据-abcdefgh").unwrap();
        let bytes = "前缀-秘密凭据-abcdefgh-后缀".as_bytes();
        let mut stream = redactor.streaming();
        let output = [
            stream.push(&bytes[..8]),
            stream.push(&bytes[8..13]),
            stream.push(&bytes[13..]),
            stream.finish(),
        ]
        .concat();
        assert_eq!(output, "前缀-[REDACTED]-后缀");
    }
}
