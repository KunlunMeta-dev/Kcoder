//! Bounded byte-to-text parsers for Wiki documents and web responses.

#[path = "../../wiki_docx.rs"]
mod docx;
#[path = "../../wiki_html.rs"]
mod html;
#[path = "../../wiki_pptx.rs"]
mod pptx;
#[path = "../../web_content.rs"]
pub mod web_content;
#[path = "../../wiki_xlsx.rs"]
mod xlsx;

pub use docx::extract_with_warnings as extract_docx;
pub use html::extract as extract_html;
pub use pptx::extract_with_units as extract_pptx;
pub use xlsx::extract_with_units as extract_xlsx;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct DocumentParseError(pub String);

pub const MAX_EXTRACTED_BYTES: usize = 8 * 1024 * 1024;

pub use docx::extract_for_read as extract_docx_for_read;
pub use pptx::extract_for_read as extract_pptx_for_read;
pub use xlsx::extract_for_read as extract_xlsx_for_read;

/// OOXML archive guards shared by every Office converter.
pub const MAX_ARCHIVE_ENTRIES: usize = 4096;
pub const MAX_ARCHIVE_EXPANDED_BYTES: u64 = 64 * 1024 * 1024;
/// Entries above this declared size must stay under the compression ratio limit.
pub const SMALL_ARCHIVE_ENTRY_BYTES: u64 = 256 * 1024;
pub const MAX_ARCHIVE_COMPRESSION_RATIO: u64 = 100;

/// Model-readable Office text with section starts for continuation hints.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OfficeReadText {
    pub text: String,
    /// Byte offsets into `text` where a sheet or slide heading starts.
    pub sections: Vec<(usize, String)>,
    /// Extraction facts the reader must know, such as uncalculated formulas.
    pub notes: Vec<String>,
}

fn error(message: &str) -> DocumentParseError {
    DocumentParseError(message.into())
}

/// Validate archive metadata before any part is decompressed. Declared sizes
/// bound the total expansion; `read_archive_part` rejects entries that lie.
fn check_archive(
    zip: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
    label: &str,
) -> Result<(), DocumentParseError> {
    if zip.len() > MAX_ARCHIVE_ENTRIES {
        return Err(DocumentParseError(format!(
            "{label} archive contains too many entries"
        )));
    }
    let mut total = 0u64;
    for index in 0..zip.len() {
        let file = zip
            .by_index_raw(index)
            .map_err(|_| DocumentParseError(format!("Invalid {label} archive entry")))?;
        if file.encrypted() {
            return Err(DocumentParseError(format!(
                "{label} contains encrypted archive entries; remove the password and save it again"
            )));
        }
        let size = file.size();
        total = total.saturating_add(size);
        if total > MAX_ARCHIVE_EXPANDED_BYTES {
            return Err(DocumentParseError(format!(
                "{label} expanded archive exceeds 64 MiB"
            )));
        }
        if size > SMALL_ARCHIVE_ENTRY_BYTES
            && size
                > file
                    .compressed_size()
                    .max(1)
                    .saturating_mul(MAX_ARCHIVE_COMPRESSION_RATIO)
        {
            return Err(DocumentParseError(format!(
                "{label} archive entry exceeds the 100:1 compression ratio limit (possible zip bomb)"
            )));
        }
    }
    Ok(())
}

/// Read one part up to `limit` bytes; the actual expansion must match the
/// declared size so a forged header cannot bypass `check_archive`.
fn read_archive_part(
    zip: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
    name: &str,
    limit: u64,
) -> Result<Option<Vec<u8>>, DocumentParseError> {
    use std::io::Read;
    let Some(index) = zip.index_for_name(name) else {
        return Ok(None);
    };
    let file = zip
        .by_index(index)
        .map_err(|_| error("Cannot open Office archive part"))?;
    let declared = file.size();
    if declared > limit {
        return Err(DocumentParseError(format!(
            "Office XML part exceeds {} MiB",
            limit / 1024 / 1024
        )));
    }
    let mut bytes = Vec::new();
    file.take(declared + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("Cannot decompress Office archive part"))?;
    if bytes.len() as u64 != declared {
        return Err(error(
            "Office archive part size does not match its header; the file is corrupt",
        ));
    }
    Ok(Some(bytes))
}

pub fn decode_text(bytes: &[u8]) -> Result<String, DocumentParseError> {
    let text = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if !bytes.len().is_multiple_of(2) {
            return Err(error("Invalid UTF-16: odd byte length"));
        }
        let little = bytes[0] == 0xff;
        let units: Vec<_> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| {
                if little {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        String::from_utf16(&units).map_err(|_| error("Invalid UTF-16: malformed surrogate"))?
    } else {
        let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
        std::str::from_utf8(bytes)
            .map_err(|_| error("Unknown encoding: expected strict UTF-8 or BOM-marked UTF-16"))?
            .to_owned()
    };
    if text.contains('\0') {
        return Err(error("Unsupported binary or unknown text encoding"));
    }
    Ok(text)
}

/// OOXML permits UTF-16 XML parts; decode bytes before namespace/text parsing.
fn decode_xml(bytes: &[u8]) -> Result<String, DocumentParseError> {
    decode_text(bytes)
}

impl From<DocumentParseError> for kcoder_tool_error::ToolError {
    fn from(error: DocumentParseError) -> Self {
        Self::Execution(error.0)
    }
}
