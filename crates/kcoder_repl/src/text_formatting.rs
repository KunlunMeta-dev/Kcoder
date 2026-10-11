//! Text formatting helpers for TUI rendering.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::windows_compat::UI_ELLIPSIS;

pub(crate) fn capitalize_first(input: &str) -> String {
    let mut chars = input.chars();
    match chars.next() {
        Some(first) => {
            let mut capitalized = first.to_uppercase().collect::<String>();
            capitalized.push_str(chars.as_str());
            capitalized
        }
        None => String::new(),
    }
}

/// Truncate a tool result to fit within the given height and width. If the
/// text is valid JSON, compact it first so Ratatui has better wrap points.
#[allow(dead_code)]
pub(crate) fn format_and_truncate_tool_result(
    text: &str,
    max_lines: usize,
    line_width: usize,
) -> String {
    let max_graphemes = (max_lines * line_width).saturating_sub(max_lines);

    if let Some(formatted_json) = format_json_compact(text) {
        truncate_text(&formatted_json, max_graphemes)
    } else {
        truncate_text(text, max_graphemes)
    }
}

/// Format JSON text in a compact single-line form with spaces after `:` and
/// `,` so Ratatui has useful wrap points without expanding the payload across
/// many rows.
pub(crate) fn format_json_compact(text: &str) -> Option<String> {
    let json = serde_json::from_str::<serde_json::Value>(text).ok()?;
    let json_pretty = serde_json::to_string_pretty(&json).unwrap_or_else(|_| json.to_string());

    let mut result = String::new();
    let mut chars = json_pretty.chars().peekable();
    let mut in_string = false;
    let mut escape_next = false;

    while let Some(ch) = chars.next() {
        match ch {
            '"' if !escape_next => {
                in_string = !in_string;
                result.push(ch);
            }
            '\\' if in_string => {
                escape_next = !escape_next;
                result.push(ch);
            }
            '\n' | '\r' if !in_string => {}
            ' ' | '\t' if !in_string => {
                if let Some(&next_ch) = chars.peek()
                    && let Some(last_ch) = result.chars().last()
                    && (last_ch == ':' || last_ch == ',')
                    && !matches!(next_ch, '}' | ']')
                {
                    result.push(' ');
                }
            }
            _ => {
                if escape_next && in_string {
                    escape_next = false;
                }
                result.push(ch);
            }
        }
    }

    Some(result)
}

/// Truncate `text` to `max_graphemes` graphemes without splitting a
/// multi-codepoint character.
pub(crate) fn truncate_text(text: &str, max_graphemes: usize) -> String {
    let mut graphemes = text.grapheme_indices(true);

    if let Some((byte_index, _)) = graphemes.nth(max_graphemes) {
        if max_graphemes >= 3 {
            let mut truncate_graphemes = text.grapheme_indices(true);
            if let Some((truncate_byte_index, _)) = truncate_graphemes.nth(max_graphemes - 3) {
                let truncated = &text[..truncate_byte_index];
                format!("{truncated}...")
            } else {
                text.to_string()
            }
        } else {
            text[..byte_index].to_string()
        }
    } else {
        text.to_string()
    }
}

/// Truncate a path-like string to the given display width, keeping leading and
/// trailing segments where possible and inserting a single Unicode ellipsis
/// between them. If an individual segment cannot fit, it is front-truncated
/// with an ellipsis.
pub(crate) fn center_truncate_path(path: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    if UnicodeWidthStr::width(path) <= max_width {
        return path.to_string();
    }

    let sep = std::path::MAIN_SEPARATOR;
    let has_leading_sep = path.starts_with(sep);
    let has_trailing_sep = path.ends_with(sep);
    let mut raw_segments: Vec<&str> = path.split(sep).collect();
    if has_leading_sep && !raw_segments.is_empty() && raw_segments[0].is_empty() {
        raw_segments.remove(0);
    }
    if has_trailing_sep
        && !raw_segments.is_empty()
        && raw_segments.last().is_some_and(|last| last.is_empty())
    {
        raw_segments.pop();
    }

    if raw_segments.is_empty() {
        if has_leading_sep {
            let root = sep.to_string();
            if UnicodeWidthStr::width(root.as_str()) <= max_width {
                return root;
            }
        }
        return UI_ELLIPSIS.to_string();
    }

    struct Segment<'a> {
        original: &'a str,
        text: String,
        truncatable: bool,
        is_suffix: bool,
    }

    let assemble = |leading: bool, segments: &[Segment<'_>]| -> String {
        let mut result = String::new();
        if leading {
            result.push(sep);
        }
        for segment in segments {
            if !result.is_empty() && !result.ends_with(sep) {
                result.push(sep);
            }
            result.push_str(segment.text.as_str());
        }
        result
    };

    let front_truncate = |original: &str, allowed_width: usize| -> String {
        if allowed_width == 0 {
            return String::new();
        }
        if UnicodeWidthStr::width(original) <= allowed_width {
            return original.to_string();
        }
        if allowed_width == 1 {
            return UI_ELLIPSIS.to_string();
        }

        let mut kept: Vec<char> = Vec::new();
        let mut used_width = 1;
        for ch in original.chars().rev() {
            let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
            if used_width + ch_width > allowed_width {
                break;
            }
            used_width += ch_width;
            kept.push(ch);
        }
        kept.reverse();
        let mut truncated = String::from(UI_ELLIPSIS);
        for ch in kept {
            truncated.push(ch);
        }
        truncated
    };

    let mut combos: Vec<(usize, usize)> = Vec::new();
    let segment_count = raw_segments.len();
    for left in 1..=segment_count {
        let min_right = if left == segment_count { 0 } else { 1 };
        for right in min_right..=(segment_count - left) {
            combos.push((left, right));
        }
    }

    let desired_suffix = if segment_count > 1 {
        std::cmp::min(2, segment_count - 1)
    } else {
        0
    };
    let mut prioritized: Vec<(usize, usize)> = Vec::new();
    let mut fallback: Vec<(usize, usize)> = Vec::new();
    for combo in combos {
        if combo.1 >= desired_suffix {
            prioritized.push(combo);
        } else {
            fallback.push(combo);
        }
    }
    let sort_combos = |items: &mut Vec<(usize, usize)>| {
        items.sort_by(|(left_a, right_a), (left_b, right_b)| {
            left_b
                .cmp(left_a)
                .then_with(|| right_b.cmp(right_a))
                .then_with(|| (left_b + right_b).cmp(&(left_a + right_a)))
        });
    };
    sort_combos(&mut prioritized);
    sort_combos(&mut fallback);

    let fit_segments =
        |segments: &mut Vec<Segment<'_>>, allow_front_truncate: bool| -> Option<String> {
            loop {
                let candidate = assemble(has_leading_sep, segments);
                let width = UnicodeWidthStr::width(candidate.as_str());
                if width <= max_width {
                    return Some(candidate);
                }

                if !allow_front_truncate {
                    return None;
                }

                let mut indices: Vec<usize> = Vec::new();
                for (idx, seg) in segments.iter().enumerate().rev() {
                    if seg.truncatable && seg.is_suffix {
                        indices.push(idx);
                    }
                }
                for (idx, seg) in segments.iter().enumerate().rev() {
                    if seg.truncatable && !seg.is_suffix {
                        indices.push(idx);
                    }
                }

                if indices.is_empty() {
                    return None;
                }

                let mut changed = false;
                for idx in indices {
                    let original_width = UnicodeWidthStr::width(segments[idx].original);
                    if original_width <= max_width && segment_count > 2 {
                        continue;
                    }
                    let seg_width = UnicodeWidthStr::width(segments[idx].text.as_str());
                    let other_width = width.saturating_sub(seg_width);
                    let allowed_width = max_width.saturating_sub(other_width).max(1);
                    let new_text = front_truncate(segments[idx].original, allowed_width);
                    if new_text != segments[idx].text {
                        segments[idx].text = new_text;
                        changed = true;
                        break;
                    }
                }

                if !changed {
                    return None;
                }
            }
        };

    for (left_count, right_count) in prioritized.into_iter().chain(fallback) {
        let mut segments: Vec<Segment<'_>> = raw_segments[..left_count]
            .iter()
            .map(|seg| Segment {
                original: seg,
                text: (*seg).to_string(),
                truncatable: true,
                is_suffix: false,
            })
            .collect();

        let need_ellipsis = left_count + right_count < segment_count;
        if need_ellipsis {
            segments.push(Segment {
                original: UI_ELLIPSIS,
                text: UI_ELLIPSIS.to_string(),
                truncatable: false,
                is_suffix: false,
            });
        }

        if right_count > 0 {
            segments.extend(
                raw_segments[segment_count - right_count..]
                    .iter()
                    .map(|seg| Segment {
                        original: seg,
                        text: (*seg).to_string(),
                        truncatable: true,
                        is_suffix: true,
                    }),
            );
        }

        let allow_front_truncate = need_ellipsis || segment_count <= 2;
        if let Some(candidate) = fit_segments(&mut segments, allow_front_truncate) {
            return candidate;
        }
    }

    front_truncate(path, max_width)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capitalize_first_uppercases_first_character_only() {
        assert_eq!(capitalize_first("running cargo test"), "Running cargo test");
        assert_eq!(capitalize_first(""), "");
    }

    #[test]
    fn format_and_truncate_tool_result_compacts_json_before_truncating() {
        assert_eq!(
            format_and_truncate_tool_result(r#"{ "items": ["x", "y"] }"#, 1, 80),
            r#"{"items": ["x", "y"]}"#
        );
    }

    #[test]
    fn format_json_compact_spaces_nested_objects() {
        assert_eq!(
            format_json_compact(r#"{ "user": { "name": "Ada", "details": { "age": 30 } } }"#)
                .as_deref(),
            Some(r#"{"user": {"details": {"age": 30}, "name": "Ada"}}"#)
        );
    }

    #[test]
    fn format_json_compact_keeps_string_whitespace() {
        assert_eq!(
            format_json_compact(r#"{ "message": "a, b: c", "items": ["x", "y"] }"#).as_deref(),
            Some(r#"{"items": ["x", "y"], "message": "a, b: c"}"#)
        );
    }

    #[test]
    fn format_json_compact_returns_none_for_invalid_json() {
        assert_eq!(format_json_compact("{invalid"), None);
    }

    #[test]
    fn truncate_text_keeps_complete_graphemes() {
        assert_eq!(truncate_text("👨‍👩‍👧‍👦abcd", 4), "👨‍👩‍👧‍👦...");
    }

    #[test]
    fn truncate_text_handles_small_limits() {
        assert_eq!(truncate_text("Hello, world!", 0), "");
        assert_eq!(truncate_text("Hello, world!", 1), "H");
        assert_eq!(truncate_text("Hello, world!", 2), "He");
        assert_eq!(truncate_text("Hello, world!", 3), "...");
        assert_eq!(truncate_text("Hello, world!", 4), "H...");
    }

    #[test]
    fn center_truncate_path_preserves_prefix_and_suffix_segments() {
        let sep = std::path::MAIN_SEPARATOR;
        let path = format!("{sep}home{sep}alex{sep}projects{sep}kcoder{sep}crates{sep}kcoder_repl");

        assert_eq!(
            center_truncate_path(&path, 32),
            format!("{sep}home{sep}alex{sep}{UI_ELLIPSIS}{sep}crates{sep}kcoder_repl")
        );
    }

    #[test]
    fn center_truncate_path_front_truncates_single_long_segment() {
        let truncated = center_truncate_path("supercalifragilisticexpialidocious", 10);

        assert!(truncated.starts_with(UI_ELLIPSIS));
        assert!(truncated.ends_with("idocious"));
        assert!(UnicodeWidthStr::width(truncated.as_str()) <= 10);
    }

    #[test]
    fn center_truncate_path_returns_empty_for_zero_width() {
        assert_eq!(center_truncate_path("/repo", 0), "");
    }
}
