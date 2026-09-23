use kcoder_tools::{ToolInputFormat, ToolRegistryRevision};
use std::collections::HashMap;

const MAX_ENTRIES: usize = 128;
const MAX_ENTRY_BYTES: usize = 16 * 1024;
const MAX_STRING_BYTES: usize = 256 * 1024;

#[derive(Default)]
pub(super) struct ToolInputHints {
    revision: ToolRegistryRevision,
    entries: HashMap<String, (ToolInputFormat, String)>,
    retained_bytes: usize,
}

impl ToolInputHints {
    pub(super) fn new(revision: ToolRegistryRevision) -> Self {
        Self {
            revision,
            ..Self::default()
        }
    }

    pub(super) fn insert(&mut self, name: &str, format: &ToolInputFormat, suffix: String) {
        let format_bytes = match format {
            ToolInputFormat::Json => 0,
            ToolInputFormat::Freeform { syntax, example } => {
                syntax.len().saturating_add(example.len())
            }
        };
        let bytes = name
            .len()
            .saturating_add(format_bytes)
            .saturating_add(suffix.capacity());
        if bytes > MAX_ENTRY_BYTES
            || self.retained_bytes.saturating_add(bytes) > MAX_STRING_BYTES
            || self.entries.len() >= MAX_ENTRIES
            || self.entries.contains_key(name)
        {
            return;
        }
        let name = name.to_owned();
        let format = format.clone();
        let format_capacity = match &format {
            ToolInputFormat::Json => 0,
            ToolInputFormat::Freeform { syntax, example } => {
                syntax.capacity().saturating_add(example.capacity())
            }
        };
        let bytes = name
            .capacity()
            .saturating_add(format_capacity)
            .saturating_add(suffix.capacity());
        if bytes > MAX_ENTRY_BYTES || self.retained_bytes.saturating_add(bytes) > MAX_STRING_BYTES {
            return;
        }
        self.entries.insert(name, (format, suffix));
        self.retained_bytes += bytes;
    }

    pub(super) fn render(
        &self,
        revision: &ToolRegistryRevision,
        name: &str,
        format: &ToolInputFormat,
        description: &str,
    ) -> Option<String> {
        if &self.revision != revision {
            return None;
        }
        let (cached_format, suffix) = self.entries.get(name)?;
        if cached_format != format {
            return None;
        }
        let description = description.trim();
        let mut output = String::with_capacity(description.len().saturating_add(suffix.len()));
        output.push_str(description);
        output.push_str(suffix);
        Some(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool_schema_runtime::description_for_model_with_input_format;

    #[test]
    fn hints_preserve_dynamic_prefixes_and_invalidate_format_or_registry_changes() {
        let revision = ToolRegistryRevision::default();
        let schema = serde_json::json!({"type":"object","properties":{"paths":{"type":"array","items":{"type":"string"}}},"required":["paths"]});
        for format in [
            ToolInputFormat::Json,
            ToolInputFormat::Freeform {
                syntax: "patch".into(),
                example: "sample".into(),
            },
        ] {
            let mut hints = ToolInputHints::new(revision.clone());
            hints.insert(
                "tool",
                &format,
                description_for_model_with_input_format("", &schema, &format),
            );
            for description in ["first", " changed ", "中文\n", ""] {
                assert_eq!(
                    hints
                        .render(&revision, "tool", &format, description)
                        .unwrap(),
                    description_for_model_with_input_format(description, &schema, &format)
                );
            }
            assert!(
                hints
                    .render(&ToolRegistryRevision::default(), "tool", &format, "first")
                    .is_none()
            );
            let changed = ToolInputFormat::Freeform {
                syntax: "other".into(),
                example: "different".into(),
            };
            assert!(hints.render(&revision, "tool", &changed, "first").is_none());
        }
    }

    #[test]
    fn hints_have_fixed_entry_and_string_capacity_limits() {
        let mut hints = ToolInputHints::default();
        hints.insert(
            "oversized",
            &ToolInputFormat::Json,
            "x".repeat(MAX_ENTRY_BYTES + 1),
        );
        assert!(hints.entries.is_empty());
        for index in 0..1000 {
            hints.insert(&index.to_string(), &ToolInputFormat::Json, "x".repeat(4096));
        }
        assert!(hints.entries.len() <= MAX_ENTRIES);
        assert!(hints.retained_bytes <= MAX_STRING_BYTES);
    }
}
