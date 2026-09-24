use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TextEncoding {
    Utf8 { bom: bool },
    Utf16Le { bom: bool },
    Gbk,
    Gb18030,
}

/// Explicit source encoding for existing files, or output encoding for new files.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize, schemars::JsonSchema)]
pub enum TextEncodingHint {
    #[default]
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-16le")]
    Utf16Le,
    #[serde(rename = "gbk")]
    Gbk,
    #[serde(rename = "gb18030")]
    Gb18030,
}

impl TextEncodingHint {
    pub(crate) fn cache_key(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Utf8 => "utf-8",
            Self::Utf16Le => "utf-16le",
            Self::Gbk => "gbk",
            Self::Gb18030 => "gb18030",
        }
    }

    pub(crate) fn new_file_encoding(self) -> TextEncoding {
        match self {
            Self::Auto | Self::Utf8 => TextEncoding::Utf8 { bom: false },
            Self::Utf16Le => TextEncoding::Utf16Le { bom: true },
            Self::Gbk => TextEncoding::Gbk,
            Self::Gb18030 => TextEncoding::Gb18030,
        }
    }
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
    read_text_file_with_encoding(path, TextEncodingHint::Auto).await
}

pub(crate) async fn read_text_file_with_encoding(
    path: &Path,
    encoding: TextEncodingHint,
) -> std::io::Result<TextFile> {
    let bytes = tokio::fs::read(path).await?;
    decode_text_bytes_with_encoding(&bytes, encoding)
}

fn decode_text_bytes_with_encoding(
    bytes: &[u8],
    hint: TextEncodingHint,
) -> std::io::Result<TextFile> {
    if hint == TextEncodingHint::Auto {
        return decode_text_bytes(bytes);
    }
    let bom = if bytes.starts_with(&[0xff, 0xfe]) {
        Some(TextEncodingHint::Utf16Le)
    } else if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        Some(TextEncodingHint::Utf8)
    } else {
        None
    };
    if bom.is_some_and(|encoding| encoding != hint) {
        return Err(invalid_data(
            "Explicit encoding conflicts with the file BOM",
        ));
    }
    let (content, encoding) = match hint {
        TextEncodingHint::Utf8 => (
            String::from_utf8(if bom.is_some() {
                bytes[3..].to_vec()
            } else {
                bytes.to_vec()
            })
            .map_err(|_| invalid_data("Invalid UTF-8; select the known source encoding"))?,
            TextEncoding::Utf8 { bom: bom.is_some() },
        ),
        TextEncodingHint::Utf16Le => (
            decode_utf16le(if bom.is_some() { &bytes[2..] } else { bytes })?,
            TextEncoding::Utf16Le { bom: bom.is_some() },
        ),
        TextEncodingHint::Gbk | TextEncodingHint::Gb18030 => {
            let codec = if hint == TextEncodingHint::Gbk {
                encoding_rs::GBK
            } else {
                encoding_rs::GB18030
            };
            let content = codec.decode_without_bom_handling_and_without_replacement(bytes).ok_or_else(|| invalid_data("Invalid bytes for the selected encoding; no replacement decoding is allowed"))?;
            let (encoded, _, errors) = codec.encode(&content);
            if errors || encoded.as_ref() != bytes {
                return Err(invalid_data(
                    "Selected encoding cannot round-trip these bytes exactly; refusing lossy decoding",
                ));
            }
            (
                content.into_owned(),
                if hint == TextEncodingHint::Gbk {
                    TextEncoding::Gbk
                } else {
                    TextEncoding::Gb18030
                },
            )
        }
        TextEncodingHint::Auto => unreachable!(),
    };
    Ok(TextFile {
        line_endings: detect_line_endings(&content),
        content: normalize_crlf(&content),
        encoding,
    })
}

pub(crate) async fn write_text_file(
    path: &Path,
    content: &str,
    encoding: TextEncoding,
    line_endings: LineEndings,
) -> std::io::Result<()> {
    // Encode completely before opening/truncating the destination.
    let bytes = encode_text(content, encoding, line_endings)?;
    tokio::fs::write(path, bytes).await
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
                .map_err(|e| invalid_data(format!("invalid UTF-8 text: {e}; select encoding=gbk, gb18030, or utf-16le explicitly when appropriate")))?,
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
                .map_err(|e| invalid_data(format!("invalid UTF-8 text: {e}; select encoding=gbk, gb18030, or utf-16le explicitly when appropriate")))?,
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

    // Non-ASCII BOM-less UTF-16 is ambiguous with legacy multibyte encodings.
    // Never guess: explicit encoding is required for such inputs.
    false
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

fn encode_text(
    content: &str,
    encoding: TextEncoding,
    line_endings: LineEndings,
) -> std::io::Result<Vec<u8>> {
    let content = match line_endings {
        LineEndings::Lf => content.to_string(),
        LineEndings::Crlf => normalize_crlf(content)
            .split('\n')
            .collect::<Vec<_>>()
            .join("\r\n"),
    };

    let bytes = match encoding {
        TextEncoding::Gbk | TextEncoding::Gb18030 => {
            let codec = if encoding == TextEncoding::Gbk {
                encoding_rs::GBK
            } else {
                encoding_rs::GB18030
            };
            let (bytes, _, errors) = codec.encode(&content);
            if errors {
                return Err(invalid_data(
                    "Text cannot be represented in the selected encoding; file was not modified",
                ));
            }
            bytes.into_owned()
        }
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
    };
    Ok(bytes)
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
        )
        .unwrap();
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

#[cfg(test)]
mod legacy_encoding_tests {
    use super::*;
    #[test]
    fn ambiguous_gbk_is_never_inferred_as_utf16() {
        let bytes = [0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4];
        assert!(decode_text_bytes(&bytes).is_err());
        let file = decode_text_bytes_with_encoding(&bytes, TextEncodingHint::Gbk).unwrap();
        assert_eq!(file.content, "中文测试");
        assert_eq!(
            encode_text(&file.content, file.encoding, file.line_endings).unwrap(),
            bytes
        );
        assert!(decode_text_bytes_with_encoding(&bytes, TextEncodingHint::Utf8).is_err());
    }
    #[test]
    fn explicit_unicode_and_gb18030_round_trip() {
        for (text, encoding, hint) in [
            ("中文\n第二行\n", TextEncoding::Gbk, TextEncodingHint::Gbk),
            (
                "中文😀\n第二行\n",
                TextEncoding::Gb18030,
                TextEncodingHint::Gb18030,
            ),
            (
                "中文\n",
                TextEncoding::Utf16Le { bom: false },
                TextEncodingHint::Utf16Le,
            ),
        ] {
            let bytes = encode_text(text, encoding, LineEndings::Crlf).unwrap();
            let decoded = decode_text_bytes_with_encoding(&bytes, hint).unwrap();
            assert_eq!(decoded.content, text);
            assert_eq!(decoded.encoding, encoding);
            assert_eq!(decoded.line_endings, LineEndings::Crlf);
            assert_eq!(
                encode_text(&decoded.content, decoded.encoding, decoded.line_endings).unwrap(),
                bytes
            );
        }
        assert!(
            decode_text_bytes_with_encoding(&[0xff, 0xfe, 65, 0], TextEncodingHint::Gbk).is_err()
        );
        assert!(decode_text_bytes_with_encoding(&[0x81], TextEncodingHint::Gbk).is_err());
    }
    #[tokio::test]
    async fn unrepresentable_write_preserves_original_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.txt");
        let original = encode_text("中文\n", TextEncoding::Gbk, LineEndings::Crlf).unwrap();
        tokio::fs::write(&path, &original).await.unwrap();
        assert!(
            write_text_file(&path, "不能编码😀", TextEncoding::Gbk, LineEndings::Crlf)
                .await
                .is_err()
        );
        assert_eq!(tokio::fs::read(&path).await.unwrap(), original);
    }
    #[tokio::test]
    async fn cached_reads_are_bound_to_the_selected_encoding() {
        use crate::{Tool, ToolContext};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cached.txt");
        tokio::fs::write(&path, [0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4])
            .await
            .unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(dir.path()));
        let input = serde_json::json!({"file_path":path,"encoding":"gbk"});
        assert!(
            !crate::file::FileReadTool
                .call(input.clone(), &ctx)
                .await
                .unwrap()
                .is_error
        );
        let repeated = crate::file::FileReadTool.call(input, &ctx).await.unwrap();
        assert!(repeated.content.iter().any(|b| matches!(b, kcoder_types::ContentBlock::Text {text} if text.contains("File unchanged"))));
        assert!(
            crate::file::FileReadTool
                .call(serde_json::json!({"file_path":path}), &ctx)
                .await
                .is_err()
        );
        let alternate = crate::file::FileReadTool
            .call(
                serde_json::json!({"file_path":path,"encoding":"utf-16le"}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(!alternate.content.iter().any(|b| matches!(b, kcoder_types::ContentBlock::Text {text} if text.contains("File unchanged"))));
    }

    #[tokio::test]
    async fn read_edit_write_tools_preserve_legacy_encoding() {
        use crate::{Tool, ToolContext};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.txt");
        let ctx = ToolContext::new(kcoder_state::AppState::new(dir.path()));
        let original = encode_text("中文\n测试\n", TextEncoding::Gbk, LineEndings::Crlf).unwrap();
        tokio::fs::write(&path, &original).await.unwrap();
        assert!(
            crate::file::FileReadTool
                .call(serde_json::json!({"file_path":path}), &ctx)
                .await
                .is_err()
        );
        let result = crate::file::FileReadTool
            .call(serde_json::json!({"file_path":path,"encoding":"gbk"}), &ctx)
            .await
            .unwrap();
        assert!(!result.is_error);
        let result=crate::edit::FileEditTool.call(serde_json::json!({"file_path":path,"encoding":"gbk","old_string":"测试","new_string":"替换"}),&ctx).await.unwrap();
        assert!(!result.is_error);
        assert_eq!(
            tokio::fs::read(&path).await.unwrap(),
            encode_text("中文\n替换\n", TextEncoding::Gbk, LineEndings::Crlf).unwrap()
        );
        let before = tokio::fs::read(&path).await.unwrap();
        assert!(crate::edit::FileEditTool.call(serde_json::json!({"file_path":path,"encoding":"gbk","old_string":"替换","new_string":"😀"}),&ctx).await.is_err());
        assert_eq!(tokio::fs::read(&path).await.unwrap(), before);
        let result = crate::write::FileWriteTool
            .call(
                serde_json::json!({"file_path":path,"encoding":"gbk","content":"重写\n"}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(!result.is_error);
        assert_eq!(
            tokio::fs::read(&path).await.unwrap(),
            encode_text("重写\n", TextEncoding::Gbk, LineEndings::Crlf).unwrap()
        );
        let newpath = dir.path().join("new.txt");
        let result = crate::write::FileWriteTool
            .call(
                serde_json::json!({"file_path":newpath,"encoding":"gb18030","content":"中文😀"}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(!result.is_error);
        assert_eq!(
            read_text_file_with_encoding(&newpath, TextEncodingHint::Gb18030)
                .await
                .unwrap()
                .content,
            "中文😀"
        );
    }
}
