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

fn error(message: &str) -> DocumentParseError {
    DocumentParseError(message.into())
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
