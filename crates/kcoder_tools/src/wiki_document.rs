//! Bounded extraction for host-authorized Wiki attachments, without OCR.
use crate::{ToolContext, ToolError};
#[path = "wiki_docx.rs"]
mod docx;
#[path = "wiki_html.rs"]
mod html;
#[path = "wiki_pptx.rs"]
mod pptx;
#[path = "wiki_xlsx.rs"]
mod xlsx;
use std::{ops::Range, path::Path, time::Duration};
use tokio::io::AsyncReadExt;

pub const MAX_DOCUMENT_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_EXTRACTED_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_CHUNK_BYTES: usize = 8192;
pub const MAX_DOCUMENT_CHUNKS: usize = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentFormat {
    Text,
    Markdown,
    Html,
    Pdf,
    Docx,
    Xlsx,
    Pptx,
}

/// Target-owned upload rules used by file, replacement and directory entry points.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCapability {
    pub format: &'static str,
    pub extensions: &'static [&'static str],
    pub mime_types: &'static [&'static str],
    pub max_file_bytes: usize,
    pub max_extracted_bytes: usize,
    pub requires_vision: bool,
    pub warnings: &'static [&'static str],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<&'static str>,
}

pub fn file_capabilities() -> Vec<FileCapability> {
    let document = |format, extensions, mime_types, warnings| FileCapability {
        format,
        extensions,
        mime_types,
        max_file_bytes: MAX_DOCUMENT_BYTES,
        max_extracted_bytes: MAX_EXTRACTED_BYTES,
        requires_vision: false,
        warnings,
        available: None,
        unavailable_reason: None,
    };
    vec![
        document("text", &["txt"], &["text/plain"], &[]),
        document("markdown", &["md"], &["text/markdown"], &[]),
        document("html", &["html", "htm"], &["text/html"], &["html_offline"]),
        document("pdf", &["pdf"], &["application/pdf"], &["pdf_text_only"]),
        document(
            "docx",
            &["docx"],
            &["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
            &["docx_body_only", "docx_final_revision_view"],
        ),
        document(
            "xlsx",
            &["xlsx"],
            &["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
            &["xlsx_cached_values"],
        ),
        document(
            "pptx",
            &["pptx"],
            &["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
            &["pptx_text_only"],
        ),
        FileCapability {
            format: "image",
            extensions: &["png", "jpg", "jpeg", "webp"],
            mime_types: &["image/png", "image/jpeg", "image/webp"],
            max_file_bytes: crate::image_input::MAX_BYTES,
            max_extracted_bytes: MAX_EXTRACTED_BYTES,
            requires_vision: true,
            warnings: &["vision_uncertain"],
            available: None,
            unavailable_reason: None,
        },
    ]
}

/// Target deployment facts augment the format contract; image availability remains model-specific.
pub fn runtime_file_capabilities() -> Vec<FileCapability> {
    let mut items = file_capabilities();
    let (available, reason) = crate::pdf_read::runtime_availability();
    for item in &mut items {
        if item.format == "pdf" {
            item.available = available;
            item.unavailable_reason = reason;
        } else if !item.requires_vision {
            item.available = Some(true);
        }
    }
    items
}

pub fn file_capability(title: &str) -> Option<FileCapability> {
    let extension = Path::new(title).extension()?.to_str()?.to_ascii_lowercase();
    file_capabilities()
        .into_iter()
        .find(|capability| capability.extensions.contains(&extension.as_str()))
}

pub fn format_for_file(title: &str) -> Result<(DocumentFormat, FileCapability), ToolError> {
    let capability = file_capability(title).ok_or_else(|| error("unsupported_format: select TXT, Markdown, HTML, PDF, DOCX, XLSX, PPTX, PNG, JPEG or WebP; convert legacy .doc/.xls/.ppt first"))?;
    let format = match capability.format {
        "markdown" => DocumentFormat::Markdown,
        "html" => DocumentFormat::Html,
        "pdf" => DocumentFormat::Pdf,
        "docx" => DocumentFormat::Docx,
        "xlsx" => DocumentFormat::Xlsx,
        "pptx" => DocumentFormat::Pptx,
        _ => DocumentFormat::Text,
    };
    Ok((format, capability))
}

#[derive(Debug, Clone)]
pub struct DocumentChunk {
    pub text: String,
    /// One-based physical PDF page; absent for text documents.
    pub page: Option<u32>,
    /// UTF-8 byte offsets in the decoded document or extracted physical page.
    /// These are not byte offsets in the original UTF-16/PDF file.
    pub byte_range: Range<usize>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionReport {
    pub format: String,
    pub text_bytes: usize,
    pub chunk_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extracted_units: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_units: Option<usize>,
    pub warnings: Vec<String>,
}

pub struct ExtractedDocument {
    pub chunks: Vec<DocumentChunk>,
    pub report: ExtractionReport,
}

fn reported(
    chunks: Vec<DocumentChunk>,
    format: &str,
    unit: Option<&str>,
    extracted_units: Option<usize>,
    total_units: Option<usize>,
    additional: &[&str],
) -> ExtractedDocument {
    let mut warnings = file_capabilities()
        .into_iter()
        .find(|capability| capability.format == format)
        .map(|capability| {
            capability
                .warnings
                .iter()
                .map(|value| (*value).to_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    warnings.extend(additional.iter().map(|value| (*value).to_owned()));
    let report = ExtractionReport {
        format: format.into(),
        text_bytes: chunks.iter().map(|chunk| chunk.text.len()).sum(),
        chunk_count: chunks.len(),
        unit: unit.map(str::to_owned),
        extracted_units,
        total_units,
        warnings,
    };
    ExtractedDocument { chunks, report }
}

/// The host must authorize the attachment before calling this adapter.
/// No arbitrary model-supplied path should reach this API.
/// UTF-16 requires a BOM; other legacy encodings are rejected.
pub async fn extract_document(
    path: &Path,
    format: DocumentFormat,
    ctx: &ToolContext,
) -> Result<Vec<DocumentChunk>, ToolError> {
    Ok(extract_document_report(path, format, ctx).await?.chunks)
}

pub async fn extract_document_report(
    path: &Path,
    format: DocumentFormat,
    ctx: &ToolContext,
) -> Result<ExtractedDocument, ToolError> {
    let work = async {
        let mut options = tokio::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
        let file = options
            .open(path)
            .await
            .map_err(|_| error("Cannot open Wiki attachment"))?;
        let meta = file
            .metadata()
            .await
            .map_err(|_| error("Cannot inspect Wiki attachment"))?;
        if !meta.is_file() || meta.len() > MAX_DOCUMENT_BYTES as u64 {
            return Err(error(
                "Wiki attachment must be a regular file of at most 32 MiB",
            ));
        }
        let mut bytes = Vec::new();
        file.take(MAX_DOCUMENT_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| error("Cannot read Wiki attachment"))?;
        if bytes.len() > MAX_DOCUMENT_BYTES {
            return Err(error("Wiki attachment exceeds 32 MiB"));
        }
        match format {
            DocumentFormat::Html => {
                let text = tokio::task::spawn_blocking(move || html::extract(&bytes))
                    .await
                    .map_err(|_| error("HTML extraction worker failed"))??;
                Ok(reported(
                    bounded_chunks(&text, false)?,
                    "html",
                    None,
                    None,
                    None,
                    &[],
                ))
            }
            DocumentFormat::Xlsx | DocumentFormat::Pptx => {
                let (text, extracted, total, missing_cache) =
                    tokio::task::spawn_blocking(move || match format {
                        DocumentFormat::Xlsx => xlsx::extract_with_units(&bytes),
                        _ => pptx::extract_with_units(&bytes)
                            .map(|(text, extracted, total)| (text, extracted, total, false)),
                    })
                    .await
                    .map_err(|_| error("Office extraction worker failed"))??;
                let (name, unit) = if format == DocumentFormat::Xlsx {
                    ("xlsx", "sheet")
                } else {
                    ("pptx", "slide")
                };
                let additional = if missing_cache {
                    vec!["xlsx_missing_cache"]
                } else {
                    vec![]
                };
                Ok(reported(
                    bounded_chunks(&text, false)?,
                    name,
                    Some(unit),
                    Some(extracted),
                    Some(total),
                    &additional,
                ))
            }
            DocumentFormat::Docx => {
                let (text, warnings) =
                    tokio::task::spawn_blocking(move || docx::extract_with_warnings(&bytes))
                        .await
                        .map_err(|_| error("Word extraction worker failed"))??;
                Ok(reported(
                    bounded_chunks(&text, false)?,
                    "docx",
                    None,
                    None,
                    None,
                    &warnings,
                ))
            }
            DocumentFormat::Pdf => {
                if !bytes.starts_with(b"%PDF-") {
                    return Err(error("Invalid PDF header"));
                }
                let bytes =
                    crate::pdf_read::extract_all_text(bytes, ctx, MAX_EXTRACTED_BYTES).await?;
                let text = String::from_utf8(bytes)
                    .map_err(|_| error("Invalid UTF-8 from PDF extractor"))?;
                let pages: Vec<_> = text.split('\u{c}').collect();
                let total =
                    pages.len() - usize::from(pages.last().is_some_and(|page| page.is_empty()));
                let extracted = pages
                    .iter()
                    .take(total)
                    .filter(|page| !page.trim().is_empty())
                    .count();
                let additional = if extracted < total {
                    vec!["pdf_empty_pages"]
                } else {
                    vec![]
                };
                Ok(reported(
                    pdf_chunks(&text)?,
                    "pdf",
                    Some("page"),
                    Some(extracted),
                    Some(total),
                    &additional,
                ))
            }
            DocumentFormat::Text | DocumentFormat::Markdown => {
                let text = decode_text(&bytes)?;
                Ok(reported(
                    bounded_chunks(&text, false)?,
                    if format == DocumentFormat::Markdown {
                        "markdown"
                    } else {
                        "text"
                    },
                    None,
                    None,
                    None,
                    &[],
                ))
            }
        }
    };
    if ctx.is_aborted() {
        return Err(ToolError::Aborted);
    }
    tokio::select! {
        _ = ctx.cancelled() => Err(ToolError::Aborted),
        result = tokio::time::timeout(Duration::from_secs(45), work) => result.map_err(|_| error("Wiki document extraction timed out"))?,
    }
}

fn error(message: &str) -> ToolError {
    ToolError::Execution(message.into())
}

fn decode_text(bytes: &[u8]) -> Result<String, ToolError> {
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
pub(super) fn decode_xml(bytes: &[u8]) -> Result<String, ToolError> {
    decode_text(bytes)
}

fn pdf_chunks(text: &str) -> Result<Vec<DocumentChunk>, ToolError> {
    if text.trim().is_empty() {
        return Err(error(
            "needs_vision: PDF has no extractable text layer; OCR was not performed",
        ));
    }
    bounded_chunks(text, true)
}

pub fn chunk_text(text: &str) -> Result<Vec<DocumentChunk>, ToolError> {
    bounded_chunks(text, false)
}

fn bounded_chunks(text: &str, pdf: bool) -> Result<Vec<DocumentChunk>, ToolError> {
    if text.len() > MAX_EXTRACTED_BYTES {
        return Err(error(
            "Wiki extracted text exceeds 8 MiB; document was not truncated",
        ));
    }
    let mut chunks = Vec::new();
    let pages = text.split(|character| pdf && character == '\u{c}');
    for (index, page_text) in pages.enumerate() {
        let mut start = 0;
        while start < page_text.len() {
            let mut end = (start + MAX_CHUNK_BYTES).min(page_text.len());
            while !page_text.is_char_boundary(end) {
                end -= 1;
            }
            if chunks.len() >= MAX_DOCUMENT_CHUNKS {
                return Err(error(
                    "Wiki document exceeds 8192 chunks; document was not truncated",
                ));
            }
            chunks.push(DocumentChunk {
                text: page_text[start..end].to_owned(),
                page: pdf.then_some(index as u32 + 1),
                byte_range: start..end,
            });
            start = end;
        }
    }
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_supported_file_uses_the_same_authoritative_limit() {
        for capability in file_capabilities() {
            for extension in capability.extensions {
                let title = format!("中文.{}", extension.to_ascii_uppercase());
                let (_, actual) = format_for_file(&title).unwrap();
                assert_eq!(actual.format, capability.format);
                assert_eq!(
                    actual.max_file_bytes,
                    if actual.requires_vision {
                        crate::image_input::MAX_BYTES
                    } else {
                        MAX_DOCUMENT_BYTES
                    }
                );
                assert_eq!(actual.max_extracted_bytes, MAX_EXTRACTED_BYTES);
            }
        }
        for title in ["legacy.doc", "legacy.xls", "legacy.ppt", "image.svg"] {
            assert!(format_for_file(title).is_err());
        }
    }

    #[test]
    fn strict_decoding_rejects_unknown_and_malformed_input() {
        assert_eq!(decode_text(b"hello").unwrap(), "hello");
        assert_eq!(decode_text(&[0xff, 0xfe, 0x2d, 0x4e]).unwrap(), "中");
        assert_eq!(decode_text(&[0xfe, 0xff, 0x4e, 0x2d]).unwrap(), "中");
        for invalid in [
            &[0x80][..],
            &[0xff, 0xfe, 0][..],
            &[0xff, 0xfe, 0, 0xd8][..],
            b"a\0b",
        ] {
            assert!(decode_text(invalid).is_err());
        }
    }

    #[test]
    fn physical_pages_include_empty_pages_and_pages_after_twenty() {
        let text = (1..=25)
            .map(|page| {
                if page == 2 {
                    String::new()
                } else {
                    format!("page {page}")
                }
            })
            .collect::<Vec<_>>()
            .join("\u{c}")
            + "\u{c}";
        let chunks = pdf_chunks(&text).unwrap();
        assert_eq!(chunks[1].page, Some(3));
        assert_eq!(chunks.last().unwrap().page, Some(25));
        assert_eq!(chunks.last().unwrap().text, "page 25");
        assert!(
            pdf_chunks(" \n\u{c}\u{c}")
                .unwrap_err()
                .to_string()
                .contains("needs_vision")
        );
    }

    #[test]
    fn chunks_preserve_unicode_and_exact_offsets_without_truncation() {
        let text = "中".repeat(MAX_CHUNK_BYTES);
        let chunks = bounded_chunks(&text, false).unwrap();
        assert_eq!(
            chunks
                .iter()
                .map(|chunk| chunk.text.as_str())
                .collect::<String>(),
            text
        );
        for chunk in chunks {
            assert!(chunk.text.len() <= MAX_CHUNK_BYTES);
            assert_eq!(&text[chunk.byte_range], chunk.text);
        }
        assert!(bounded_chunks(&"a".repeat(MAX_EXTRACTED_BYTES + 1), false).is_err());
        assert!(pdf_chunks(&"x\u{c}".repeat(MAX_DOCUMENT_CHUNKS + 1)).is_err());
    }

    #[tokio::test]
    async fn real_pdf_import_reads_all_twenty_five_pages() {
        if which::which("pdftotext").is_err() {
            eprintln!("NOT RUN: pdftotext unavailable");
            return;
        }
        let kids = (0..25)
            .map(|i| format!("{} 0 R", 4 + 2 * i))
            .collect::<Vec<_>>()
            .join(" ");
        let mut objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            format!("<< /Type /Pages /Kids [{kids}] /Count 25 >>"),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
        ];
        for page in 0..25 {
            let stream = format!("BT /F1 12 Tf 20 100 Td (Physical page {}) Tj ET", page + 1);
            objects.push(format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents {} 0 R >>", 5 + 2 * page));
            objects.push(format!(
                "<< /Length {} >>\nstream\n{stream}\nendstream",
                stream.len()
            ));
        }
        let mut pdf = "%PDF-1.4\n".to_owned();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf += &format!("{} 0 obj\n{object}\nendobj\n", index + 1);
        }
        let xref = pdf.len();
        pdf += &format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1);
        for offset in offsets {
            pdf += &format!("{offset:010} 00000 n \n");
        }
        pdf += &format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("all.pdf");
        std::fs::write(&path, pdf).unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(dir.path()));
        let result = extract_document_report(&path, DocumentFormat::Pdf, &ctx)
            .await
            .unwrap();
        assert_eq!(result.report.total_units, Some(25));
        assert_eq!(result.report.extracted_units, Some(25));
        assert_eq!(result.report.unit.as_deref(), Some("page"));
        assert_eq!(result.report.warnings, vec!["pdf_text_only"]);
        let chunks = result.chunks;
        assert_eq!(chunks.len(), 25);
        assert_eq!(chunks.last().unwrap().page, Some(25));
        assert!(chunks.last().unwrap().text.contains("Physical page 25"));
    }

    #[tokio::test]
    async fn rejects_oversize_file_before_reading() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.txt");
        std::fs::File::create(&path)
            .unwrap()
            .set_len(MAX_DOCUMENT_BYTES as u64 + 1)
            .unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(dir.path()));
        assert!(
            extract_document(&path, DocumentFormat::Text, &ctx)
                .await
                .unwrap_err()
                .to_string()
                .contains("32 MiB")
        );
    }
}
