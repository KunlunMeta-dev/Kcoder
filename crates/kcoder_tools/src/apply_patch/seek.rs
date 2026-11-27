/// Find `pattern` in `lines` starting at or after `start`, matching with
/// decreasing strictness: exact → trailing-whitespace-insensitive →
/// fully-trimmed. With `eof`, ONLY the end-of-file position is tried
/// (修订 D4：codex NormalizeToLf 语义——`*** End of File` 是约束不是提示，
/// 末尾匹配失败必须让 patch 失败，不得回退到文件中部应用). Mirrors codex
/// `seek_sequence` minus the Unicode-normalization pass (v1 scope).
pub(crate) fn seek_sequence(
    lines: &[String],
    pattern: &[String],
    start: usize,
    eof: bool,
) -> Option<usize> {
    if pattern.is_empty() {
        return Some(start);
    }
    if pattern.len() > lines.len() {
        return None;
    }
    let last = lines.len() - pattern.len();
    let try_from = |from: usize| -> Option<usize> {
        if from > last {
            return None;
        }
        for i in from..=last {
            if lines[i..i + pattern.len()] == *pattern {
                return Some(i);
            }
        }
        for i in from..=last {
            if (0..pattern.len())
                .all(|offset| lines[i + offset].trim_end() == pattern[offset].trim_end())
            {
                return Some(i);
            }
        }
        for i in from..=last {
            if (0..pattern.len()).all(|offset| lines[i + offset].trim() == pattern[offset].trim()) {
                return Some(i);
            }
        }
        None
    };
    if eof {
        // 修订 D4：只试末尾位置（codex：search_start = eof_start，三个 pass
        // 都只检查该位置）。回退搜索会把标记了 EOF 的块静默应用到文件中部。
        return try_from(last);
    }
    try_from(start)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn exact_match_wins_from_start() {
        let hay = lines(&["a", "b", "c"]);
        assert_eq!(seek_sequence(&hay, &lines(&["b", "c"]), 0, false), Some(1));
        assert_eq!(seek_sequence(&hay, &lines(&["b", "c"]), 2, false), None);
    }

    #[test]
    fn fuzzy_passes_ignore_trailing_then_both_whitespace() {
        let hay = lines(&["foo   ", "   bar\t"]);
        assert_eq!(
            seek_sequence(&hay, &lines(&["foo", "bar"]), 0, false),
            Some(0)
        );
    }

    #[test]
    fn eof_pattern_prefers_file_end() {
        let hay = lines(&["only-at-end", "dup", "only-at-end"]);
        assert_eq!(
            seek_sequence(&hay, &lines(&["dup", "only-at-end"]), 0, true),
            Some(1)
        );
        let hay = lines(&["dup", "mid", "dup"]);
        assert_eq!(seek_sequence(&hay, &lines(&["dup"]), 0, true), Some(2));
    }

    #[test]
    fn eof_pattern_that_cannot_match_at_file_end_fails() {
        // 修订 D4：EOF 是约束——末尾匹配失败必须返回 None（patch 报错），
        // 不得回退到文件中部应用。
        let hay = lines(&["dup", "mid", "other"]);
        assert_eq!(seek_sequence(&hay, &lines(&["dup"]), 0, true), None);
    }

    #[test]
    fn empty_pattern_and_oversize_guard() {
        let hay = lines(&["a"]);
        assert_eq!(seek_sequence(&hay, &[], 0, false), Some(0));
        assert_eq!(seek_sequence(&hay, &lines(&["a", "a"]), 0, false), None);
    }
}
