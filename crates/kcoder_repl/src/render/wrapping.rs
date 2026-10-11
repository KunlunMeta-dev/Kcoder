//! Display-width aware word wrapping for compact TUI surfaces.
//!
//! The wrapper is intentionally compact. Widgets ask `render` for wrapping
//! instead of each carrying its own word-splitting loop.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WrapOptions {
    width: usize,
    break_words: bool,
}

impl WrapOptions {
    pub(crate) fn new(width: usize) -> Self {
        Self {
            width,
            break_words: true,
        }
    }

    pub(crate) fn break_words(mut self, break_words: bool) -> Self {
        self.break_words = break_words;
        self
    }
}

impl From<usize> for WrapOptions {
    fn from(width: usize) -> Self {
        Self::new(width)
    }
}

pub(crate) fn display_width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

pub(crate) fn word_wrap_plain_line<O>(line: &str, options: O) -> Vec<String>
where
    O: Into<WrapOptions>,
{
    let options = options.into();
    let width = options.width.max(1);
    if line.is_empty() {
        return vec![String::new()];
    }

    let mut out = Vec::new();
    let mut current = String::new();
    for word in line.split_whitespace() {
        let sep_width = usize::from(!current.is_empty());
        let candidate_width = display_width(&current)
            .saturating_add(sep_width)
            .saturating_add(display_width(word));
        if candidate_width <= width {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
            continue;
        }

        if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }

        if display_width(word) <= width || !options.break_words {
            current.push_str(word);
        } else {
            let pieces = hard_wrap_word(word, width);
            let mut iter = pieces.into_iter().peekable();
            while let Some(piece) = iter.next() {
                if iter.peek().is_some() {
                    out.push(piece);
                } else {
                    current = piece;
                }
            }
        }
    }

    if !current.is_empty() || out.is_empty() {
        out.push(current);
    }
    out
}

pub(crate) fn adaptive_word_wrap_plain_line<O>(line: &str, options: O) -> Vec<String>
where
    O: Into<WrapOptions>,
{
    let options = options.into();
    if !text_contains_url_like(line) {
        return word_wrap_plain_line(line, options);
    }

    if text_has_mixed_url_and_non_url_tokens(line) {
        mixed_url_wrap_plain_line(line, options)
    } else {
        word_wrap_plain_line(line, options.break_words(false))
    }
}

pub(crate) fn text_contains_url_like(text: &str) -> bool {
    text.split_ascii_whitespace().any(is_url_like_token)
}

pub(crate) fn hard_wrap_word(word: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut out = Vec::new();
    let mut current = String::new();
    let mut used = 0usize;
    for grapheme in word.graphemes(true) {
        let grapheme_width = UnicodeWidthStr::width(grapheme);
        if used > 0 && used.saturating_add(grapheme_width) > width {
            out.push(std::mem::take(&mut current));
            used = 0;
        }
        current.push_str(grapheme);
        used = used.saturating_add(grapheme_width);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

pub(crate) fn truncate_to_display_width(text: &str, max_width: usize) -> String {
    let mut out = String::new();
    let mut used = 0usize;
    for grapheme in text.graphemes(true) {
        let grapheme_width = UnicodeWidthStr::width(grapheme);
        if used.saturating_add(grapheme_width) > max_width {
            break;
        }
        out.push_str(grapheme);
        used = used.saturating_add(grapheme_width);
    }
    out
}

fn is_url_like_token(raw_token: &str) -> bool {
    let token = trim_url_token(raw_token);
    !token.is_empty() && (is_absolute_url_like(token) || is_bare_url_like(token))
}

pub(crate) fn text_has_mixed_url_and_non_url_tokens(text: &str) -> bool {
    let mut saw_url = false;
    let mut saw_non_url = false;

    for raw_token in text.split_ascii_whitespace() {
        if is_url_like_token(raw_token) {
            saw_url = true;
        } else if is_substantive_non_url_token(raw_token) {
            saw_non_url = true;
        }

        if saw_url && saw_non_url {
            return true;
        }
    }

    false
}

fn is_substantive_non_url_token(raw_token: &str) -> bool {
    let token = trim_url_token(raw_token);
    if token.is_empty() || is_decorative_marker_token(raw_token, token) {
        return false;
    }

    token.chars().any(char::is_alphanumeric)
}

fn is_decorative_marker_token(raw_token: &str, token: &str) -> bool {
    let raw = raw_token.trim();
    matches!(
        raw,
        "-" | "*"
            | "+"
            | "•"
            | "◦"
            | "▪"
            | ">"
            | "|"
            | "│"
            | "┆"
            | "└"
            | "├"
            | "┌"
            | "┐"
            | "┘"
            | "┼"
    ) || is_ordered_list_marker(raw, token)
}

fn is_ordered_list_marker(raw_token: &str, token: &str) -> bool {
    token.chars().all(|ch| ch.is_ascii_digit())
        && (raw_token.ends_with('.') || raw_token.ends_with(')'))
}

fn mixed_url_wrap_plain_line(line: &str, options: WrapOptions) -> Vec<String> {
    let width = options.width.max(1);
    if line.is_empty() {
        return vec![String::new()];
    }

    let mut out = Vec::new();
    let mut current = String::new();
    for word in line.split_whitespace() {
        let is_url = is_url_like_token(word);
        let sep_width = usize::from(!current.is_empty());
        let candidate_width = display_width(&current)
            .saturating_add(sep_width)
            .saturating_add(display_width(word));
        if candidate_width <= width {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
            continue;
        }

        if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }

        if is_url || display_width(word) <= width || !options.break_words {
            current.push_str(word);
        } else {
            let pieces = hard_wrap_word(word, width);
            let mut iter = pieces.into_iter().peekable();
            while let Some(piece) = iter.next() {
                if iter.peek().is_some() {
                    out.push(piece);
                } else {
                    current = piece;
                }
            }
        }
    }

    if !current.is_empty() || out.is_empty() {
        out.push(current);
    }
    out
}

fn trim_url_token(token: &str) -> &str {
    token.trim_matches(|ch: char| {
        matches!(
            ch,
            '(' | ')'
                | '['
                | ']'
                | '{'
                | '}'
                | '<'
                | '>'
                | ','
                | '.'
                | ';'
                | ':'
                | '!'
                | '\''
                | '"'
        )
    })
}

fn is_absolute_url_like(token: &str) -> bool {
    let Some((scheme, rest)) = token.split_once("://") else {
        return false;
    };
    if !is_valid_scheme(scheme) || rest.is_empty() {
        return false;
    }

    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(rest);
    !host.is_empty()
}

fn is_valid_scheme(scheme: &str) -> bool {
    let mut chars = scheme.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphabetic()
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
}

fn is_bare_url_like(token: &str) -> bool {
    let (host_port, has_trailer) = split_host_port_and_trailer(token);
    if host_port.is_empty() {
        return false;
    }

    if !has_trailer && !host_port.to_ascii_lowercase().starts_with("www.") {
        return false;
    }

    let (host, port) = split_host_and_port(host_port);
    if host.is_empty() {
        return false;
    }
    if let Some(port) = port
        && !is_valid_port(port)
    {
        return false;
    }

    host.eq_ignore_ascii_case("localhost") || is_ipv4(host) || is_domain_name(host)
}

fn split_host_port_and_trailer(token: &str) -> (&str, bool) {
    if let Some(idx) = token.find(['/', '?', '#']) {
        (&token[..idx], true)
    } else {
        (token, false)
    }
}

fn split_host_and_port(host_port: &str) -> (&str, Option<&str>) {
    if host_port.starts_with('[') {
        return (host_port, None);
    }

    if let Some((host, port)) = host_port.rsplit_once(':')
        && !host.is_empty()
        && !port.is_empty()
        && port.chars().all(|ch| ch.is_ascii_digit())
    {
        return (host, Some(port));
    }

    (host_port, None)
}

fn is_valid_port(port: &str) -> bool {
    !port.is_empty()
        && port.len() <= 5
        && port.chars().all(|ch| ch.is_ascii_digit())
        && port.parse::<u16>().is_ok()
}

fn is_ipv4(host: &str) -> bool {
    let mut count = 0usize;
    for part in host.split('.') {
        count = count.saturating_add(1);
        if part.is_empty() || part.parse::<u8>().is_err() {
            return false;
        }
    }
    count == 4
}

fn is_domain_name(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    if !host.contains('.') {
        return false;
    }

    let mut labels = host.split('.');
    let Some(tld) = labels.next_back() else {
        return false;
    };
    is_tld(tld) && labels.all(is_domain_label)
}

fn is_tld(label: &str) -> bool {
    (2..=63).contains(&label.len()) && label.chars().all(|ch| ch.is_ascii_alphabetic())
}

fn is_domain_label(label: &str) -> bool {
    if label.is_empty() || label.len() > 63 {
        return false;
    }

    let Some(first) = label.chars().next() else {
        return false;
    };
    let Some(last) = label.chars().next_back() else {
        return false;
    };

    first.is_ascii_alphanumeric()
        && last.is_ascii_alphanumeric()
        && label
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_on_word_boundaries() {
        assert_eq!(
            word_wrap_plain_line("one two three four", 8),
            vec!["one two", "three", "four"]
        );
    }

    #[test]
    fn hard_wraps_overlong_words_by_default() {
        assert_eq!(word_wrap_plain_line("abcdef", 2), vec!["ab", "cd", "ef"]);
    }

    #[test]
    fn hard_wrap_keeps_grapheme_clusters_intact() {
        let family = "👨‍👩‍👧‍👦";
        let wrapped = hard_wrap_word(&format!("{family}abc"), UnicodeWidthStr::width(family));

        assert_eq!(wrapped.first().map(String::as_str), Some(family));
        assert!(
            wrapped
                .iter()
                .all(|line| !line.contains('\u{200d}') || line == family)
        );
    }

    #[test]
    fn can_preserve_overlong_words() {
        assert_eq!(
            word_wrap_plain_line(
                "prefix abcdef suffix",
                WrapOptions::new(4).break_words(false)
            ),
            vec!["prefix", "abcdef", "suffix"]
        );
    }

    #[test]
    fn truncates_by_display_width() {
        assert_eq!(truncate_to_display_width("ab界c", 4), "ab界");
    }

    #[test]
    fn truncate_to_display_width_keeps_grapheme_clusters_intact() {
        let family = "👨‍👩‍👧‍👦";

        assert_eq!(
            truncate_to_display_width(&format!("{family}abc"), UnicodeWidthStr::width(family)),
            family
        );
    }

    #[test]
    fn adaptive_wrap_preserves_absolute_url_tokens() {
        let url = "https://example.com/path-with-dashes/and/slashes";
        assert_eq!(
            adaptive_word_wrap_plain_line(&format!("see {url} now"), 12),
            vec!["see", url, "now"]
        );
    }

    #[test]
    fn adaptive_wrap_preserves_bare_url_tokens() {
        let url = "localhost:3000/api/health";
        assert_eq!(
            adaptive_word_wrap_plain_line(&format!("open {url}"), 10),
            vec!["open", url]
        );
    }

    #[test]
    fn adaptive_wrap_only_preserves_url_tokens_in_mixed_lines() {
        let url = "https://example.com/path-with-dashes/and/slashes";
        assert_eq!(
            adaptive_word_wrap_plain_line(&format!("see {url} abcdefghij"), 6),
            vec!["see", url, "abcdef", "ghij"]
        );
    }

    #[test]
    fn url_detection_rejects_plain_file_paths() {
        assert!(!text_contains_url_like("src/main.rs"));
        assert!(!text_contains_url_like("foo/bar"));
    }
}
