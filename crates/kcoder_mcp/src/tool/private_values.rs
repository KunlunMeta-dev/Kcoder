//! Scope-bound private values. No credential names, files or global environment lookup.
use anyhow::{Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::{collections::BTreeSet, fmt, sync::Arc};
#[derive(Default)]
pub struct PrivateValues {
    patterns: Vec<String>,
}
impl fmt::Debug for PrivateValues {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PrivateValues")
            .field("pattern_count", &self.patterns.len())
            .finish()
    }
}
impl PrivateValues {
    pub fn new(values: impl IntoIterator<Item = String>) -> Result<Arc<Self>> {
        let values = values.into_iter().collect::<Vec<_>>();
        ensure!(values.len() <= 32, "private MCP value count exceeds limit");
        let mut patterns = BTreeSet::new();
        for value in values {
            if value.is_empty() {
                continue;
            }
            ensure!(
                value.len() <= 16384,
                "private MCP value length exceeds limit"
            );
            let encoded = serde_urlencoded::to_string([("", &value)])?;
            let encoded = encoded.strip_prefix('=').unwrap_or(&encoded).to_owned();
            patterns.insert(encoded.clone());
            patterns.insert(encoded.replace('+', "%20"));
            patterns.insert(lower_percent_hex(&encoded));
            for prefix in [
                "https://redaction.invalid/?value=",
                "https://redaction.invalid/",
            ] {
                if let Ok(url) = reqwest::Url::parse(&format!("{prefix}{value}"))
                    && let Some(encoded) = url.as_str().strip_prefix(prefix)
                {
                    patterns.insert(encoded.to_owned());
                    patterns.insert(lower_percent_hex(encoded));
                }
            }
            if let Ok(url) = reqwest::Url::parse(&value) {
                patterns.insert(url.to_string());
            }
            let escaped = serde_json::to_string(&value)?;
            patterns.insert(escaped[1..escaped.len() - 1].to_owned());
            patterns.insert(STANDARD.encode(&value));
            patterns.insert(value);
        }
        let mut patterns = patterns
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        patterns.sort_by_key(|value| std::cmp::Reverse(value.len()));
        Ok(Arc::new(Self { patterns }))
    }
    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }
    pub fn contains(&self, text: &str) -> bool {
        self.patterns.iter().any(|value| text.contains(value))
    }
    /// One pass never searches its own replacement marker.
    pub fn text(&self, text: &str) -> String {
        if self.patterns.is_empty() {
            return text.to_owned();
        }
        let mut result = String::new();
        let mut rest = text;
        loop {
            let next = self
                .patterns
                .iter()
                .filter_map(|pattern| rest.find(pattern).map(|offset| (offset, pattern.len())))
                .min_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.cmp(&a.1)));
            let Some((offset, length)) = next else {
                result.push_str(rest);
                break;
            };
            result.push_str(&rest[..offset]);
            result.push_str(if self.contains("[private]") {
                ""
            } else {
                "[private]"
            });
            rest = &rest[offset + length..];
        }
        result
    }
    pub fn json(&self, value: &mut Value) {
        match value {
            Value::String(text) => *text = self.text(text),
            Value::Array(values) => values.iter_mut().for_each(|value| self.json(value)),
            Value::Object(values) => {
                let original = std::mem::take(values);
                for (key, mut value) in original {
                    self.json(&mut value);
                    values.insert(self.text(&key), value);
                }
            }
            _ => {}
        }
    }
}
fn lower_percent_hex(text: &str) -> String {
    let mut result = text.as_bytes().to_vec();
    let mut index = 0;
    while index + 2 < result.len() {
        if result[index] == b'%' {
            result[index + 1].make_ascii_lowercase();
            result[index + 2].make_ascii_lowercase();
            index += 3;
        } else {
            index += 1;
        }
    }
    // Only ASCII hex digits were changed, preserving the original UTF-8 boundaries.
    String::from_utf8(result).unwrap_or_default()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn masks_raw_url_json_and_structured_values_without_reprocessing_markers() {
        let secret = "synthetic /private+值";
        let values = PrivateValues::new([secret.to_owned(), "d".into()]).unwrap();
        let raw = format!(
            "failure {secret}; URL {}",
            serde_urlencoded::to_string([("", secret)]).unwrap()
        );
        let safe = values.text(&raw);
        assert!(!safe.contains(secret));
        assert!(!safe.contains("%2Fprivate"));
        assert!(!format!("{values:?}").contains(secret));
        let mut body = serde_json::json!({"custom":{"FOO":secret},"items":[secret]});
        values.json(&mut body);
        assert!(!body.to_string().contains(secret));
        assert_eq!(
            PrivateValues::new([String::new()])
                .unwrap()
                .text("ordinary"),
            "ordinary"
        );
        assert!(PrivateValues::new(["x".repeat(16385)]).is_err());
    }
}
