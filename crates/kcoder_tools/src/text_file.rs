use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TextEncoding {
    Utf8 { bom: bool },
    Utf16Le { bom: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LineEndings {
    Lf,
    Crlf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TextFile {
    pub content: String,
    pub encoding: TextEncoding,
    pub line_endings: LineEndings,
}

pub(crate) fn resolve_path(path: &str, cwd: &Path) -> PathBuf {
    let expanded = expand_home(path);
    let p = PathBuf::from(expanded);
    if p.is_absolute() { p } else { cwd.join(p) }
}

pub(crate) async fn read_text_file(path: &Path) -> std::io::Result<TextFile> {
    let bytes = tokio::fs::read(path).await?;
    decode_text_bytes(&bytes)
}

pub(crate) async fn write_text_file(
    path: &Path,
    content: &str,
    encoding: TextEncoding,
    line_endings: LineEndings,
) -> std::io::Result<()> {
    tokio::fs::write(path, encode_text(content, encoding, line_endings)).await
}

fn expand_home(path: &str) -> String {
    let Some(rest) = path.strip_prefix('~') else {
        return path.to_string();
    };
    if !rest.is_empty() && !rest.starts_with('/') && !rest.starts_with('\\') {
        return path.to_string();
    }
    let Some(home) = home_dir() else {
        return path.to_string();
    };
    if rest.is_empty() {
        return home.to_string_lossy().into_owned();
    }
    home.join(rest.trim_start_matches(['/', '\\']))
        .to_string_lossy()
        .into_owned()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

fn decode_text_bytes(bytes: &[u8]) -> std::io::Result<TextFile> {
    let (content, encoding) = if bytes.starts_with(&[0xff, 0xfe]) {
        (
            decode_utf16le(&bytes[2..])?,
            TextEncoding::Utf16Le { bom: true },
        )
    } else if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        (
            String::from_utf8(bytes[3..].to_vec())
                .map_err(|e| invalid_data(format!("invalid UTF-8 text: {e}")))?,
            TextEncoding::Utf8 { bom: true },
        )
    } else if looks_like_utf16le(bytes) {
        // BOM-less UTF-16LE (some Windows tools emit it): NUL is a valid
        // UTF-8 codepoint, so without this probe the bytes decode into
        // "H\0e\0l\0l\0o\0" garbage that later writes bake back into the file.
        (decode_utf16le(bytes)?, TextEncoding::Utf16Le { bom: false })
    } else {
        (
            String::from_utf8(bytes.to_vec())
                .map_err(|e| invalid_data(format!("invalid UTF-8 text: {e}")))?,
            TextEncoding::Utf8 { bom: false },
        )
    };
    let line_endings = detect_line_endings(&content);
    Ok(TextFile {
        content: normalize_crlf(&content),
        encoding,
        line_endings,
    })
}

fn looks_like_utf16le(bytes: &[u8]) -> bool {
    if bytes.len() < 4 || !bytes.len().is_multiple_of(2) {
        return false;
    }
    let sample = &bytes[..bytes.len().min(512)];
    let pairs = sample.len() / 2;
    let nul_odd = sample
        .iter()
        .skip(1)
        .step_by(2)
        .filter(|b| **b == 0)
        .count();
    let nul_even = sample.iter().step_by(2).filter(|b| **b == 0).count();
    // UTF-16LE ASCII-ish text: high bytes (odd index) are mostly NUL while
    // low bytes (even index) are almost never NUL. Binary data with NULs in
    // both positions and plain UTF-8 (no NULs) both fail this probe.
    if nul_odd * 2 > pairs && nul_even * 10 < pairs {
        return true;
    }

    // Non-ASCII UTF-16LE (for example Chinese text) has no useful NUL-byte
    // pattern. Only use this fallback when the bytes are not valid UTF-8,
    // decode as well-formed UTF-16LE, and produce text without NULs or an
    // implausibly high control-character ratio. Valid UTF-8 always wins.
    if std::str::from_utf8(bytes).is_ok() {
        return false;
    }
    let Ok(decoded) = decode_utf16le(bytes) else {
        return false;
    };
    let mut chars = decoded.chars();
    let mut total = 0usize;
    let mut controls = 0usize;
    for ch in chars.by_ref().take(512) {
        if ch == '\0' {
            return false;
        }
        total += 1;
        if ch.is_control() && !matches!(ch, '\n' | '\r' | '\t') {
            controls += 1;
        }
    }
    total > 0 && controls * 10 <= total
}

#[cfg(test)]
mod decode_tests {
    use super::*;

    #[test]
    fn decodes_bomless_utf16le() {
        let bytes: Vec<u8> = "Hello world"
            .encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect();
        let file = decode_text_bytes(&bytes).unwrap();
        assert_eq!(file.content, "Hello world");
        assert!(matches!(
            file.encoding,
            TextEncoding::Utf16Le { bom: false }
        ));
    }

    #[test]
    fn decodes_bomless_utf16le_without_ascii_nul_pattern() {
        let bytes: Vec<u8> = "KCoder"
            .encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect();

        let file = decode_text_bytes(&bytes).unwrap();

        assert_eq!(file.content, "KCoder");
        assert!(matches!(
            file.encoding,
            TextEncoding::Utf16Le { bom: false }
        ));
    }

    #[test]
    fn plain_utf8_is_not_misdetected_as_utf16le() {
        let file = decode_text_bytes("plain ascii text".as_bytes()).unwrap();
        assert_eq!(file.content, "plain ascii text");
        assert!(matches!(file.encoding, TextEncoding::Utf8 { bom: false }));
    }
}

fn decode_utf16le(bytes: &[u8]) -> std::io::Result<String> {
    if !bytes.len().is_multiple_of(2) {
        return Err(invalid_data("invalid UTF-16LE text: odd byte length"));
    }
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]));
    std::char::decode_utf16(units)
        .map(|result| result.map_err(|e| invalid_data(format!("invalid UTF-16LE text: {e}"))))
        .collect()
}

fn encode_text(content: &str, encoding: TextEncoding, line_endings: LineEndings) -> Vec<u8> {
    let content = match line_endings {
        LineEndings::Lf => content.to_string(),
        LineEndings::Crlf => normalize_crlf(content)
            .split('\n')
            .collect::<Vec<_>>()
            .join("\r\n"),
    };

    match encoding {
        TextEncoding::Utf8 { bom } => {
            let mut bytes = Vec::with_capacity(content.len() + if bom { 3 } else { 0 });
            if bom {
                bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
            }
            bytes.extend_from_slice(content.as_bytes());
            bytes
        }
        TextEncoding::Utf16Le { bom } => {
            let mut bytes = Vec::with_capacity(content.len() * 2 + if bom { 2 } else { 0 });
            if bom {
                bytes.extend_from_slice(&[0xff, 0xfe]);
            }
            for unit in content.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            bytes
        }
    }
}

fn detect_line_endings(content: &str) -> LineEndings {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let bytes = content.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            if index > 0 && bytes[index - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    if crlf > lf {
        LineEndings::Crlf
    } else {
        LineEndings::Lf
    }
}

fn normalize_crlf(content: &str) -> String {
    content.replace("\r\n", "\n")
}

fn invalid_data(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16le_round_trip_preserves_bom_and_crlf() {
        let encoded = encode_text(
            "alpha\nbeta\n",
            TextEncoding::Utf16Le { bom: true },
            LineEndings::Crlf,
        );
        assert!(encoded.starts_with(&[0xff, 0xfe]));

        let decoded = decode_text_bytes(&encoded).unwrap();
        assert_eq!(decoded.content, "alpha\nbeta\n");
        assert_eq!(decoded.encoding, TextEncoding::Utf16Le { bom: true });
        assert_eq!(decoded.line_endings, LineEndings::Crlf);
    }

    #[test]
    fn expands_current_user_home_prefix_only() {
        let cwd = std::env::temp_dir();
        let expected = home_dir()
            .map(|home| home.join("file.txt"))
            .unwrap_or_else(|| cwd.join("~/file.txt"));
        assert_eq!(resolve_path("~/file.txt", &cwd), expected);
        assert_eq!(
            resolve_path("~other/file.txt", &cwd),
            cwd.join("~other/file.txt")
        );
    }
}
