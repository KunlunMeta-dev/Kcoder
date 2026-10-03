//! Local link parsing, location suffixes, and display paths.

use super::*;

pub(super) fn is_local_path_like_link(destination: &str) -> bool {
    destination.starts_with("file://")
        || destination.starts_with('/')
        || destination.starts_with("~/")
        || destination.starts_with("./")
        || destination.starts_with("../")
        || destination.starts_with("\\\\")
        || matches!(
            destination.as_bytes(),
            [drive, b':', separator, ..]
                if drive.is_ascii_alphabetic() && matches!(separator, b'/' | b'\\')
        )
}

pub(super) fn render_local_link_target(destination: &str, cwd: Option<&Path>) -> Option<String> {
    let (path_text, suffix) = parse_local_link_target(destination)?;
    let mut rendered = display_local_link_path(&path_text, cwd);
    if let Some(suffix) = suffix {
        rendered.push_str(&suffix);
    }
    Some(rendered)
}

pub(super) fn parse_local_link_target(destination: &str) -> Option<(String, Option<String>)> {
    if destination.starts_with("file://") {
        let url = Url::parse(destination).ok()?;
        let path_text = file_url_to_local_path_text(&url)?;
        let suffix = url
            .fragment()
            .and_then(normalize_hash_location_suffix_fragment);
        return Some((path_text, suffix));
    }

    let mut path_text = destination;
    let mut suffix = None;
    if let Some((candidate_path, fragment)) = destination.rsplit_once('#')
        && let Some(normalized) = normalize_hash_location_suffix_fragment(fragment)
    {
        path_text = candidate_path;
        suffix = Some(normalized);
    }
    if suffix.is_none()
        && let Some(colon_suffix) = extract_colon_location_suffix(path_text)
    {
        path_text = &path_text[..path_text.len().saturating_sub(colon_suffix.len())];
        suffix = Some(colon_suffix.to_string());
    }

    Some((
        expand_local_link_path(&percent_decode_lossy(path_text)),
        suffix,
    ))
}

pub(super) fn normalize_hash_location_suffix_fragment(fragment: &str) -> Option<String> {
    if fragment.is_empty() {
        return None;
    }
    let (start, end) = fragment
        .split_once(['-', '–'])
        .map_or((fragment, None), |(a, b)| (a, Some(b)));
    let start = parse_hash_location_part(start)?;
    if let Some(end) = end {
        let end = parse_hash_location_part(end)?;
        Some(format!("{start}-{}", end.trim_start_matches(':')))
    } else {
        Some(start)
    }
}

pub(super) fn parse_hash_location_part(part: &str) -> Option<String> {
    let rest = part.strip_prefix('L')?;
    let (line, column) = rest
        .split_once('C')
        .map_or((rest, None), |(line, column)| (line, Some(column)));
    if line.is_empty() || !line.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    if let Some(column) = column {
        if column.is_empty() || !column.chars().all(|ch| ch.is_ascii_digit()) {
            return None;
        }
        Some(format!(":{line}:{column}"))
    } else {
        Some(format!(":{line}"))
    }
}

pub(super) fn extract_colon_location_suffix(path_text: &str) -> Option<&str> {
    path_text
        .char_indices()
        .rev()
        .filter(|(_, ch)| *ch == ':')
        .map(|(idx, _)| &path_text[idx..])
        .find(|suffix| is_colon_location_suffix(suffix))
}

pub(super) fn is_colon_location_suffix(suffix: &str) -> bool {
    let Some(rest) = suffix.strip_prefix(':') else {
        return false;
    };
    let (start, end) = rest
        .split_once(['-', '–'])
        .map_or((rest, None), |(a, b)| (a, Some(b)));
    parse_line_col_suffix_part(start) && end.map(parse_line_col_suffix_part).unwrap_or(true)
}

pub(super) fn parse_line_col_suffix_part(part: &str) -> bool {
    let mut pieces = part.split(':');
    let Some(line) = pieces.next() else {
        return false;
    };
    if line.is_empty() || !line.chars().all(|ch| ch.is_ascii_digit()) {
        return false;
    }
    if let Some(column) = pieces.next()
        && (column.is_empty() || !column.chars().all(|ch| ch.is_ascii_digit()))
    {
        return false;
    }
    pieces.next().is_none()
}

pub(super) fn expand_local_link_path(path_text: &str) -> String {
    if let Some(rest) = path_text.strip_prefix("~/")
        && let Some(home) = std::env::var_os("HOME")
    {
        let expanded = Path::new(&home).join(rest);
        return normalize_local_link_path_text(&expanded.to_string_lossy());
    }
    normalize_local_link_path_text(path_text)
}

pub(super) fn file_url_to_local_path_text(url: &Url) -> Option<String> {
    // `url::Url::to_file_path` can panic on Windows for an authority-only
    // file URL (`file://server`). Build the UNC form directly first.
    if let Some(host) = url.host_str()
        && !host.is_empty()
        && host != "localhost"
    {
        let path = if url.path().is_empty() {
            "/"
        } else {
            url.path()
        };
        return Some(normalize_local_link_path_text(&format!("//{host}{path}")));
    }
    if let Ok(path) = url.to_file_path() {
        return Some(normalize_local_link_path_text(&path.to_string_lossy()));
    }

    let mut path_text = url.path().to_string();
    if matches!(
        path_text.as_bytes(),
        [b'/', drive, b':', b'/', ..] if drive.is_ascii_alphabetic()
    ) {
        path_text.remove(0);
    }

    Some(normalize_local_link_path_text(&path_text))
}

pub(super) fn normalize_local_link_path_text(path_text: &str) -> String {
    if let Some(rest) = path_text.strip_prefix("\\\\") {
        format!("//{}", rest.replace('\\', "/").trim_start_matches('/'))
    } else {
        path_text.replace('\\', "/")
    }
}

pub(super) fn is_absolute_local_link_path(path_text: &str) -> bool {
    path_text.starts_with('/')
        || path_text.starts_with("//")
        || matches!(
            path_text.as_bytes(),
            [drive, b':', b'/', ..] if drive.is_ascii_alphabetic()
        )
}

pub(super) fn display_local_link_path(path_text: &str, cwd: Option<&Path>) -> String {
    let path_text = normalize_local_link_path_text(path_text);
    if !is_absolute_local_link_path(&path_text) {
        return path_text;
    }

    if let Some(cwd) = cwd {
        let cwd_text = normalize_local_link_path_text(&cwd.to_string_lossy());
        if let Some(stripped) = strip_local_path_prefix(&path_text, &cwd_text) {
            return stripped.to_string();
        }
    }

    path_text
}

pub(super) fn strip_local_path_prefix<'a>(path_text: &'a str, cwd_text: &str) -> Option<&'a str> {
    let path_text = trim_trailing_local_path_separator(path_text);
    let cwd_text = trim_trailing_local_path_separator(cwd_text);
    if path_text == cwd_text {
        return None;
    }
    if cwd_text == "/" || cwd_text == "//" {
        return path_text.strip_prefix('/');
    }
    path_text
        .strip_prefix(cwd_text)
        .and_then(|rest| rest.strip_prefix('/'))
}

pub(super) fn trim_trailing_local_path_separator(path_text: &str) -> &str {
    if path_text == "/" || path_text == "//" {
        return path_text;
    }
    if matches!(path_text.as_bytes(), [drive, b':', b'/'] if drive.is_ascii_alphabetic()) {
        return path_text;
    }
    path_text.trim_end_matches('/')
}

pub(super) fn percent_decode_lossy(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut idx = 0usize;
    while idx < bytes.len() {
        if bytes[idx] == b'%'
            && idx + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex_value(bytes[idx + 1]), hex_value(bytes[idx + 2]))
        {
            decoded.push((hi << 4) | lo);
            idx += 3;
            continue;
        }
        decoded.push(bytes[idx]);
        idx += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

pub(super) fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
