//! Complete-line incremental highlighting that retains Syntect state only at newline boundaries.
//! Markdown remains parsed as a whole; the cache is independent of fence position, indentation, terminal width, and message role.

use super::{can_highlight, find_syntax, highlighted_line_spans, syntax_set};
use ratatui::text::Span;
use std::cell::RefCell;
use std::collections::VecDeque;
use syntect::easy::HighlightLines;
use syntect::highlighting::{HighlightState, Theme};
use syntect::parsing::ParseState;
use syntect::util::LinesWithEndings;

type LineSpans = Vec<Vec<Span<'static>>>;
const MAX_CACHED_BLOCKS: usize = 4;
const MAX_CACHED_SOURCE_BYTES: usize = 512 * 1024;

thread_local! {
    // Historical and current blocks may alternate during rendering. A bounded LRU prevents mutual eviction without accumulating streaming versions.
    static CACHE: RefCell<VecDeque<CodeHighlightCache>> = const { RefCell::new(VecDeque::new()) };
}

struct CodeHighlightCache {
    source: String,
    language: String,
    theme: &'static Theme,
    state: (HighlightState, ParseState),
    lines: LineSpans,
    #[cfg(test)]
    parsed_lines: usize,
}

pub(super) fn highlight_cached(
    code: &str,
    language: &str,
    theme: &'static Theme,
) -> Option<LineSpans> {
    CACHE.with_borrow_mut(|caches| {
        if !can_highlight(code) {
            // Over-limit blocks return entirely plain text and never append a previously cached colored prefix.
            caches.retain(|cache| !cache.matches(code, language, theme));
            return None;
        }
        let syntax = find_syntax(language)?;
        // One language may have several similar code blocks; the longest complete-line prefix is the best reusable state.
        let index = caches
            .iter()
            .enumerate()
            .filter(|(_, cache)| cache.matches(code, language, theme))
            .max_by_key(|(_, cache)| cache.source.len())
            .map(|(index, _)| index);
        let previous = index.and_then(|index| caches.remove(index));
        let mut cache = previous.unwrap_or_else(|| CodeHighlightCache {
            source: String::new(),
            language: language.to_owned(),
            theme,
            state: HighlightLines::new(syntax, theme).state(),
            lines: Vec::new(),
            #[cfg(test)]
            parsed_lines: 0,
        });
        let complete_end = code.rfind('\n').map_or(0, |index| index + 1);
        let (highlight, parse) = cache.state;
        let mut highlighter = HighlightLines::from_state(theme, highlight, parse);
        for line in LinesWithEndings::from(&code[cache.source.len()..complete_end]) {
            let ranges = highlighter.highlight_line(line, syntax_set()).ok()?;
            cache.lines.push(highlighted_line_spans(ranges));
            #[cfg(test)]
            {
                cache.parsed_lines += 1;
            }
        }
        cache
            .source
            .push_str(&code[cache.source.len()..complete_end]);
        cache.state = highlighter.state();
        let mut rendered = cache.lines.clone();
        if complete_end < code.len() {
            // An incomplete line changes with each token; preview it with cloned state so the next append remains clean.
            let (highlight, parse) = cache.state.clone();
            let mut preview = HighlightLines::from_state(theme, highlight, parse);
            let ranges = preview
                .highlight_line(&code[complete_end..], syntax_set())
                .ok()?;
            rendered.push(highlighted_line_spans(ranges));
        }
        caches.push_back(cache);
        while caches.len() > MAX_CACHED_BLOCKS
            || caches.iter().map(|cache| cache.source.len()).sum::<usize>()
                > MAX_CACHED_SOURCE_BYTES
        {
            caches.pop_front();
        }
        Some(rendered)
    })
}

impl CodeHighlightCache {
    fn matches(&self, code: &str, language: &str, theme: &Theme) -> bool {
        self.language == language
            && std::ptr::eq(self.theme, theme)
            && code.starts_with(&self.source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::highlight::{highlight_to_line_spans_with_theme, theme};

    fn reset() {
        CACHE.with_borrow_mut(VecDeque::clear);
    }

    fn assert_canonical(code: &str, language: &str, theme_name: &str) {
        let selected = theme(theme_name);
        assert_eq!(
            highlight_cached(code, language, selected),
            highlight_to_line_spans_with_theme(code, language, selected),
            "增量高亮必须与完整高亮逐 span 一致"
        );
    }

    #[test]
    fn growing_partial_lines_preserve_multiline_syntax() {
        reset();
        let source = "/* 中文注释\n仍在注释 */\nfn main() {\n    println!(\"hello\");\n}\n";
        for end in source
            .char_indices()
            .map(|(index, _)| index)
            .chain([source.len()])
        {
            assert_canonical(&source[..end], "rust", "catppuccin-mocha");
        }
        CACHE.with_borrow(|cache| {
            assert_eq!(cache.back().unwrap().parsed_lines, source.lines().count());
        });
    }

    #[test]
    fn large_append_reuses_the_styled_prefix() {
        reset();
        let mut code = "let value = \"color\"; // streaming\n".repeat(2200);
        assert!(code.len() > 64 * 1024);
        assert_canonical(&code, "rust", "catppuccin-mocha");
        let prefix = CACHE.with_borrow(|cache| cache.back().unwrap().lines[0][0].content.as_ptr());
        code.push_str("let next = 42;\n");
        assert_canonical(&code, "rust", "catppuccin-mocha");
        CACHE.with_borrow(|cache| {
            let cache = cache.back().unwrap();
            assert_eq!(cache.parsed_lines, 2201, "前缀不能从头高亮");
            assert_eq!(cache.lines[0][0].content.as_ptr(), prefix);
        });
    }

    #[test]
    fn source_language_theme_and_crlf_changes_match_full_rendering() {
        reset();
        for (source, language, selected) in [
            (
                "let value = 1;\r\n/* comment\r\n",
                "rust",
                "catppuccin-mocha",
            ),
            (
                "let value = 1;\r\n/* comment\r\n*/",
                "rust",
                "catppuccin-mocha",
            ),
            ("let value = 2;\n", "rust", "catppuccin-mocha"),
            ("let value = 2;\n", "rust", "catppuccin-latte"),
            ("let value = 2;\n", "javascript", "catppuccin-latte"),
            ("let", "rust", "catppuccin-mocha"),
            ("unknown\n", "not-a-language", "catppuccin-mocha"),
            ("\n\n", "rust", "catppuccin-mocha"),
        ] {
            assert_canonical(source, language, selected);
        }
    }

    #[test]
    fn crossing_codex_limits_discards_cached_colors() {
        for oversized in [
            format!("{}\n", "x".repeat(4097)),
            "x\n".repeat(10_001),
            format!("{}\n", "x".repeat(1024)).repeat(512),
        ] {
            reset();
            assert_canonical("let value = 1;\n", "rust", "catppuccin-mocha");
            let code = format!("let value = 1;\n{oversized}");
            assert!(highlight_cached(&code, "rust", theme("catppuccin-mocha")).is_none());
            CACHE.with_borrow(|cache| assert!(cache.is_empty()));
            assert_canonical("let value = 1;\n", "rust", "catppuccin-mocha");
        }
    }

    #[test]
    fn historical_and_active_blocks_do_not_evict_each_other() {
        reset();
        let history = "let previous = 1;\n".repeat(100);
        let mut active = String::new();
        for _ in 0..20 {
            assert_canonical(&history, "rust", "catppuccin-mocha");
            active.push_str("let current = 2;\n");
            assert_canonical(&active, "rust", "catppuccin-mocha");
        }
        CACHE.with_borrow(|cache| {
            assert_eq!(cache.len(), 2);
            assert_eq!(
                cache.iter().map(|entry| entry.parsed_lines).sum::<usize>(),
                120
            );
        });
        for index in 0..10 {
            assert_canonical(
                &format!("let unique_{index} = 3;\n"),
                "rust",
                "catppuccin-mocha",
            );
        }
        CACHE.with_borrow(|cache| assert_eq!(cache.len(), MAX_CACHED_BLOCKS));
    }

    #[test]
    fn language_specific_multiline_states_match_complete_highlighting() {
        for (language, source) in [
            (
                "python",
                "value = \"\"\"中文\nmultiline\"\"\"\nprint(value)\n",
            ),
            ("bash", "cat <<'EOF'\nhello $USER\nEOF\necho done\n"),
            (
                "javascript",
                "const value = `hello\n${42}`;\nconsole.log(value);\n",
            ),
            ("json", "{\n  \"enabled\": true,\n  \"count\": 42\n}\n"),
        ] {
            reset();
            for end in source
                .char_indices()
                .map(|(index, _)| index)
                .chain([source.len()])
            {
                assert_canonical(&source[..end], language, "catppuccin-mocha");
            }
        }
    }

    #[test]
    fn cache_source_budget_is_shared_across_blocks() {
        reset();
        let body = format!("// {}\n", "x".repeat(1024)).repeat(160);
        for index in 0..4 {
            let code = format!("// block {index}\n{body}");
            highlight_cached(&code, "rust", theme("catppuccin-mocha")).unwrap();
        }
        CACHE.with_borrow(|cache| {
            assert_eq!(cache.len(), 3);
            assert!(
                cache.iter().map(|entry| entry.source.len()).sum::<usize>()
                    <= MAX_CACHED_SOURCE_BYTES
            );
        });
    }
}
