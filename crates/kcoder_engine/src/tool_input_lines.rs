use kcoder_types::tool_ui::ToolInputLineProgress;

#[derive(Clone, Copy, Default)]
enum Field {
    #[default]
    Ignore,
    Generated,
    Replaced,
    Patch,
}

#[derive(Default)]
struct Lines {
    seen: bool,
    count: usize,
    previous_cr: bool,
    started: bool,
}

impl Lines {
    fn character(&mut self, ch: char) {
        if !self.started {
            self.count = self.count.saturating_add(1);
            self.started = true;
        }
        if ch == '\r' || (ch == '\n' && !self.previous_cr) {
            self.count = self.count.saturating_add(1);
        }
        self.previous_cr = ch == '\r';
    }
}

#[derive(Default)]
struct PatchLines {
    seen: bool,
    prefix: String,
    added: usize,
    removed: usize,
    counted: bool,
}

impl PatchLines {
    fn character(&mut self, ch: char) {
        if ch == '\n' || ch == '\r' {
            self.finish_line();
            return;
        }
        if self.prefix.len() < 4 {
            self.prefix.push(ch);
        }
        if self.prefix.len() >= 4 && !self.counted {
            self.count_line();
        }
    }
    fn count_line(&mut self) {
        if !self.prefix.starts_with("+++ ") && !self.prefix.starts_with("--- ") {
            if self.prefix.starts_with('+') {
                self.added = self.added.saturating_add(1);
            }
            if self.prefix.starts_with('-') {
                self.removed = self.removed.saturating_add(1);
            }
        }
        self.counted = true;
    }
    fn finish_line(&mut self) {
        if !self.counted {
            self.count_line();
        }
        self.prefix.clear();
        self.counted = false;
    }
}

/// Single-pass metadata counter. File bodies and paths are never retained here.
#[derive(Default)]
pub(crate) struct ToolInputLines {
    freeform_patch: bool,
    raw_patch: bool,
    started: bool,
    containers: Vec<bool>,
    in_string: bool,
    is_key: bool,
    expect_key: bool,
    escaped: bool,
    unicode: Option<(u16, u8)>,
    key: String,
    field: Field,
    generated: Lines,
    replaced: Lines,
    patch: PatchLines,
    invalid: bool,
}

pub(crate) struct ToolInputProgress {
    lines: ToolInputLines,
    chars: usize,
    reported: Option<(usize, Option<ToolInputLineProgress>)>,
}

impl ToolInputProgress {
    pub(crate) fn new(name: &str) -> Self {
        Self {
            lines: ToolInputLines::new(name),
            chars: 0,
            reported: None,
        }
    }

    pub(crate) fn chars(&self) -> usize {
        self.chars
    }

    pub(crate) fn push(&mut self, delta: &str) -> Option<(usize, Option<ToolInputLineProgress>)> {
        self.lines.push(delta);
        self.chars = self.chars.saturating_add(delta.chars().count());
        self.take_update(false)
    }

    pub(crate) fn finish(mut self) -> Option<(usize, Option<ToolInputLineProgress>)> {
        self.take_update(true)
    }

    fn take_update(&mut self, force: bool) -> Option<(usize, Option<ToolInputLineProgress>)> {
        if self.chars == 0 {
            return None;
        }
        let lines = self.lines.snapshot();
        let changed = self.reported.as_ref().is_none_or(|(chars, previous)| {
            lines != *previous
                || self.chars.saturating_sub(*chars) >= crate::TOOL_INPUT_PROGRESS_STEP_CHARS
                || (force && self.chars != *chars)
        });
        if !changed {
            return None;
        }
        let update = (self.chars, lines);
        self.reported = Some(update.clone());
        Some(update)
    }
}

impl ToolInputLines {
    pub(crate) fn new(name: &str) -> Self {
        Self {
            freeform_patch: name.to_ascii_lowercase().contains("patch"),
            ..Self::default()
        }
    }

    pub(crate) fn push(&mut self, delta: &str) {
        if self.invalid {
            return;
        }
        for ch in delta.chars() {
            if !self.started && !ch.is_whitespace() {
                self.started = true;
                self.raw_patch = self.freeform_patch && !matches!(ch, '{' | '"');
            }
            if self.raw_patch {
                self.patch.seen = true;
                self.patch.character(ch);
                continue;
            }
            if self.in_string {
                if let Some((value, digits)) = self.unicode {
                    let Some(hex) = ch.to_digit(16) else {
                        self.invalid = true;
                        return;
                    };
                    let value = (value << 4) | hex as u16;
                    self.unicode = (digits < 3).then_some((value, digits + 1));
                    if digits == 3 {
                        self.string_character(
                            char::from_u32(u32::from(value)).unwrap_or('\u{fffd}'),
                        );
                    }
                } else if self.escaped {
                    self.escaped = false;
                    match ch {
                        'u' => self.unicode = Some((0, 0)),
                        'n' => self.string_character('\n'),
                        'r' => self.string_character('\r'),
                        't' => self.string_character('\t'),
                        'b' => self.string_character('\u{0008}'),
                        'f' => self.string_character('\u{000c}'),
                        '"' | '\\' | '/' => self.string_character(ch),
                        _ => {
                            self.invalid = true;
                            return;
                        }
                    }
                } else {
                    match ch {
                        '\\' => self.escaped = true,
                        '"' => {
                            if matches!(self.field, Field::Patch) {
                                self.patch.finish_line();
                            }
                            self.in_string = false;
                            self.is_key = false;
                        }
                        ch if ch.is_control() => {
                            self.invalid = true;
                            return;
                        }
                        _ => self.string_character(ch),
                    }
                }
                continue;
            }
            match ch {
                '{' | '[' => {
                    self.containers.push(ch == '{');
                    if self.containers.len() > 32 {
                        self.invalid = true;
                        return;
                    }
                    self.expect_key = ch == '{';
                }
                '}' | ']' => {
                    self.containers.pop();
                    self.expect_key = false;
                }
                ',' => self.expect_key = self.containers.last() == Some(&true),
                ':' => self.expect_key = false,
                '"' => {
                    self.in_string = true;
                    self.is_key = self.containers.last() == Some(&true) && self.expect_key;
                    self.field = Field::Ignore;
                    if self.is_key {
                        self.key.clear();
                    } else {
                        self.field = match self.key.as_str() {
                            "content" | "file_content" | "new_string" | "new_text" | "newText"
                            | "new_content" | "replacement" | "new_source" | "markdown" => {
                                Field::Generated
                            }
                            "old_string" | "old_text" | "oldText" | "old_content"
                            | "old_source" => Field::Replaced,
                            "patch" | "patch_text" | "patchText" | "diff" => Field::Patch,
                            "description" | "input" | "text"
                                if self.freeform_patch && self.containers.len() == 1 =>
                            {
                                Field::Patch
                            }
                            _ if self.containers.is_empty() && self.freeform_patch => Field::Patch,
                            _ => Field::Ignore,
                        };
                        match self.field {
                            Field::Generated => {
                                self.generated.seen = true;
                                self.generated.started = false;
                                self.generated.previous_cr = false;
                            }
                            Field::Replaced => {
                                self.replaced.seen = true;
                                self.replaced.started = false;
                                self.replaced.previous_cr = false;
                            }
                            Field::Patch => self.patch.seen = true,
                            Field::Ignore => {}
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn string_character(&mut self, ch: char) {
        if self.is_key {
            if self.key.len() < 64 {
                self.key.push(ch);
            }
        } else {
            match self.field {
                Field::Generated => self.generated.character(ch),
                Field::Replaced => self.replaced.character(ch),
                Field::Patch => self.patch.character(ch),
                Field::Ignore => {}
            }
        }
    }

    pub(crate) fn snapshot(&self) -> Option<ToolInputLineProgress> {
        (!self.invalid && (self.generated.seen || self.replaced.seen || self.patch.seen)).then(
            || ToolInputLineProgress {
                generated_lines: self.generated.count.saturating_add(self.patch.added),
                replaced_lines: (self.replaced.seen || self.patch.seen)
                    .then_some(self.replaced.count.saturating_add(self.patch.removed)),
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_escaped_newlines_across_every_chunk_boundary_without_counting_json_formatting() {
        let input = "{\n\"path\":\"ignored\\npath\",\"content\":\"一\\n二\\u000a三\\r\\n四\\\\n\"}";
        let mut counter = ToolInputLines::new("write");
        for ch in input.chars() {
            counter.push(&ch.to_string());
        }
        assert_eq!(counter.snapshot().unwrap().generated_lines, 4);
        assert!(counter.snapshot().unwrap().replaced_lines.is_none());
    }

    #[test]
    fn edit_counts_original_and_generated_fragments_separately_and_ignores_unrelated_fields() {
        let mut counter = ToolInputLines::new("Edit");
        counter.push(
            r#"{"nested":{"note":"not\ncounted"},"old_string":"a\nb","new_string":"x\ny\nz"}"#,
        );
        assert_eq!(
            counter.snapshot(),
            Some(ToolInputLineProgress {
                generated_lines: 3,
                replaced_lines: Some(2)
            })
        );
    }

    #[test]
    fn only_reports_observed_file_fields_and_empty_content_is_zero_lines() {
        let mut counter = ToolInputLines::new("write");
        counter.push(r#"{"path":"file.txt","content":""#);
        assert_eq!(counter.snapshot().unwrap().generated_lines, 0);
        let mut other = ToolInputLines::new("shell");
        other.push(r#"{"command":"not\na\nfile"}"#);
        assert!(other.snapshot().is_none());
    }

    #[test]
    fn counts_nested_batch_edits_without_requiring_a_particular_tool_name() {
        let mut counter = ToolInputLines::new("vendor.batch_update");
        counter.push(r#"{"edits":[{"oldText":"a\nb","newText":"c"},{"old_string":"d","new_string":"e\nf"}]}"#);
        assert_eq!(
            counter.snapshot(),
            Some(ToolInputLineProgress {
                generated_lines: 3,
                replaced_lines: Some(3)
            })
        );
    }

    #[test]
    fn counts_streamed_patches_in_json_and_freeform_without_including_headers() {
        let patch = "--- a/demo\n+++ b/demo\n@@ -1 +1 @@\n-old\n+new\n+next\n";
        for input in [
            serde_json::json!({"patch":patch}).to_string(),
            patch.to_string(),
            serde_json::to_string(patch).unwrap(),
            serde_json::json!({"description":patch}).to_string(),
            serde_json::json!({"input":patch}).to_string(),
            serde_json::json!({"text":patch}).to_string(),
        ] {
            let mut counter = ToolInputLines::new("apply_patch");
            for ch in input.chars() {
                counter.push(&ch.to_string());
            }
            assert_eq!(
                counter.snapshot(),
                Some(ToolInputLineProgress {
                    generated_lines: 2,
                    replaced_lines: Some(1)
                })
            );
        }
    }

    #[test]
    fn patch_transport_wrapper_reports_real_line_changes_while_json_is_incomplete() {
        let mut state = ToolInputProgress::new("apply_patch");
        let mut updates = Vec::new();
        for fragment in [
            r#"{"description":""#,
            "-old\\n",
            "+new\\n",
            "+next\\n",
            r#""}"#,
        ] {
            if let Some((_, Some(lines))) = state.push(fragment) {
                updates.push((lines.generated_lines, lines.replaced_lines));
            }
        }
        updates.dedup();
        assert_eq!(
            updates,
            [(0, Some(0)), (0, Some(1)), (1, Some(1)), (2, Some(1))]
        );
        let final_update = state.finish().unwrap();
        assert_eq!(final_update.1.unwrap().generated_lines, 2);
        let mut other = ToolInputLines::new("unrelated_tool");
        other.push(r#"{"description":"+not a file\n"}"#);
        assert!(other.snapshot().is_none());
    }
}
