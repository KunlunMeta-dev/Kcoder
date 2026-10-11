//! Read bounded WordprocessingML without launching Word or following relationships.
use super::{MAX_EXTRACTED_BYTES, error};
use crate::ToolError;
use quick_xml::{
    events::{BytesStart, Event},
    name::{QName, ResolveResult},
    reader::NsReader,
};
use std::io::{Cursor, Read};

#[cfg(test)]
pub(super) fn extract(bytes: &[u8]) -> Result<String, ToolError> {
    Ok(extract_with_warnings(bytes)?.0)
}

pub(super) fn extract_with_warnings(
    bytes: &[u8],
) -> Result<(String, Vec<&'static str>), ToolError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| error("Invalid or encrypted Word document; save as unencrypted .docx"))?;
    if archive.len() > 4096 {
        return Err(error("Word document contains too many archive entries"));
    }
    let mut part = archive
        .by_name("word/document.xml")
        .map_err(|_| error("Word document is missing word/document.xml"))?;
    let limit = 32 * 1024 * 1024;
    if part.size() > limit {
        return Err(error("Word document XML exceeds 32 MiB"));
    }
    let mut xml = Vec::new();
    part.by_ref()
        .take(limit + 1)
        .read_to_end(&mut xml)
        .map_err(|_| error("Cannot decompress Word document"))?;
    if xml.len() as u64 > limit {
        return Err(error("Word document XML exceeds 32 MiB"));
    }
    let xml = super::decode_xml(&xml)?;
    let (text, warnings) = extract_xml_report(&xml)?;
    if text.trim().is_empty() {
        return Err(error(
            "Word document has no extractable body text; OCR was not performed",
        ));
    }
    Ok((text, warnings))
}

pub(super) fn extract_xml(xml: &str) -> Result<String, ToolError> {
    Ok(extract_xml_report(xml)?.0)
}

#[derive(Default)]
struct Frame {
    suppressed: bool,
    in_text: bool,
    alternate: Option<bool>,
}

fn supported_choice(reader: &NsReader<&[u8]>, element: &BytesStart<'_>) -> Result<bool, ToolError> {
    let requires = element
        .attributes()
        .find_map(|attribute| match attribute {
            Ok(attribute) if attribute.key.as_ref() == b"Requires" => Some(
                attribute
                    .unescape_value()
                    .map(|value| value.into_owned())
                    .map_err(|_| error("Invalid Word compatibility requirement")),
            ),
            Err(_) => Some(Err(error("Invalid Word XML attribute"))),
            _ => None,
        })
        .transpose()?
        .ok_or_else(|| error("Word compatibility Choice is missing Requires"))?;
    if requires.trim().is_empty() {
        return Err(error("Word compatibility Choice has empty Requires"));
    }
    Ok(requires.split_whitespace().all(|prefix| {
        let qualified = format!("{prefix}:_");
        match reader
            .resolver()
            .resolve_element(QName(qualified.as_bytes()))
            .0
        {
            ResolveResult::Bound(namespace) => matches!(
                namespace.as_ref(),
                b"http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                    | b"http://purl.oclc.org/ooxml/wordprocessingml/main"
                    | b"http://schemas.openxmlformats.org/drawingml/2006/main"
                    | b"http://purl.oclc.org/ooxml/drawingml/main"
            ),
            _ => false,
        }
    }))
}

fn extract_xml_report(xml: &str) -> Result<(String, Vec<&'static str>), ToolError> {
    let mut reader = NsReader::from_str(xml);
    let mut text = String::new();
    let mut frames: Vec<Frame> = Vec::new();
    let mut warnings = Vec::new();
    loop {
        match reader
            .read_event()
            .map_err(|_| error("Malformed Word XML"))?
        {
            Event::DocType(_) => return Err(error("Word XML DTD is not supported")),
            event @ (Event::Start(_) | Event::Empty(_)) => {
                let empty = matches!(event, Event::Empty(_));
                let element = match event {
                    Event::Start(element) | Event::Empty(element) => element,
                    _ => unreachable!(),
                };
                let name = element.local_name();
                let name = name.as_ref();
                let compatibility = matches!(reader.resolver().resolve_element(element.name()).0,
                    ResolveResult::Bound(namespace) if namespace.as_ref() == b"http://schemas.openxmlformats.org/markup-compatibility/2006");
                let mut suppressed = frames.last().is_some_and(|frame| frame.suppressed);
                // The final revision view excludes deleted and moved-from text.
                suppressed |= matches!(name, b"del" | b"moveFrom");
                if compatibility && matches!(name, b"Choice" | b"Fallback") {
                    let supported = name == b"Fallback" || supported_choice(&reader, &element)?;
                    if !suppressed
                        && !supported
                        && !warnings.contains(&"docx_unsupported_alternate_choice")
                    {
                        warnings.push("docx_unsupported_alternate_choice");
                    }
                    let selected = frames
                        .last_mut()
                        .and_then(|frame| frame.alternate.as_mut())
                        .ok_or_else(|| {
                            error("Word compatibility branch is outside AlternateContent")
                        })?;
                    suppressed |= *selected || !supported;
                    if !suppressed {
                        *selected = true;
                    }
                }
                if !suppressed && empty {
                    match name {
                        b"tab" => text.push('\t'),
                        b"br" | b"cr" => text.push('\n'),
                        _ => {}
                    }
                }
                if !empty {
                    if frames.len() >= 256 {
                        return Err(error("Word XML nesting exceeds limit"));
                    }
                    frames.push(Frame {
                        suppressed,
                        in_text: name == b"t",
                        alternate: (compatibility && name == b"AlternateContent").then_some(false),
                    });
                }
            }
            Event::End(element) => {
                let frame = frames.pop().ok_or_else(|| error("Malformed Word XML"))?;
                if !frame.suppressed {
                    match element.local_name().as_ref() {
                        b"p" | b"tr" => text.push('\n'),
                        b"tc" => text.push('\t'),
                        _ => {}
                    }
                    if frame.alternate == Some(false)
                        && !warnings.contains(&"docx_alternate_content_without_supported_branch")
                    {
                        warnings.push("docx_alternate_content_without_supported_branch");
                    }
                }
            }
            Event::Text(element)
                if frames
                    .last()
                    .is_some_and(|frame| frame.in_text && !frame.suppressed) =>
            {
                text.push_str(
                    &element
                        .decode()
                        .map_err(|_| error("Invalid Word text encoding"))?,
                );
            }
            Event::GeneralRef(element)
                if frames
                    .last()
                    .is_some_and(|frame| frame.in_text && !frame.suppressed) =>
            {
                let name = element.decode().map_err(|_| error("Invalid Word entity"))?;
                text.push_str(
                    &quick_xml::escape::unescape(&format!("&{name};"))
                        .map_err(|_| error("Unsupported Word XML entity"))?,
                );
            }
            Event::CData(element)
                if frames
                    .last()
                    .is_some_and(|frame| frame.in_text && !frame.suppressed) =>
            {
                text.push_str(
                    &element
                        .decode()
                        .map_err(|_| error("Invalid Word text encoding"))?,
                );
            }
            Event::Eof => {
                if !frames.is_empty() {
                    return Err(error("Malformed Word XML"));
                }
                break;
            }
            _ => {}
        }
        if text.len() > MAX_EXTRACTED_BYTES {
            return Err(error(
                "Wiki extracted text exceeds 8 MiB; document was not truncated",
            ));
        }
    }
    Ok((text, warnings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn document(xml: &str) -> Vec<u8> {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file(
                "word/document.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive.write_all(xml.as_bytes()).unwrap();
        archive.finish().unwrap().into_inner()
    }
    #[test]
    fn reads_chinese_paragraphs_tables_and_entities_without_deleted_text() {
        let bytes = document(
            r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>中文 &amp; &#65;</w:t><w:tab/><w:t>正文</w:t></w:r><w:del><w:r><w:t>已删除</w:t></w:r></w:del></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>"#,
        );
        let text = extract(&bytes).unwrap();
        assert!(text.contains("中文 & A\t正文\n"));
        assert!(text.contains("表格\n\t\n"));
        assert!(!text.contains("已删除"));
    }
    #[test]
    fn final_revision_view_excludes_moved_source_and_keeps_insertions() {
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:moveFrom w:id="1"><w:r><w:t>Moved fact</w:t></w:r></w:moveFrom></w:p><w:p><w:moveTo w:id="2"><w:r><w:t>Moved fact</w:t></w:r></w:moveTo><w:ins><w:r><w:t> New fact</w:t></w:r></w:ins></w:p></w:body></w:document>"#;
        let text = extract(&document(xml)).unwrap();
        assert_eq!(text.matches("Moved fact").count(), 1);
        assert!(text.contains("New fact"));
    }
    #[test]
    fn alternate_content_uses_one_supported_branch_or_fallback() {
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><w:body><mc:AlternateContent><mc:Choice Requires="wps"><w:p><w:r><w:t>Unknown shape</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>Visible note</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent><mc:AlternateContent><mc:Choice Requires="w"><w:p><w:r><w:t>Supported choice</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>Duplicate fallback</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent></w:body></w:document>"#;
        let text = extract(&document(xml)).unwrap();
        assert_eq!(text.matches("Visible note").count(), 1);
        assert!(text.contains("Supported choice"));
        assert!(!text.contains("Unknown shape"));
        assert!(!text.contains("Duplicate fallback"));
        let (_, warnings) = extract_with_warnings(&document(xml)).unwrap();
        assert_eq!(warnings, vec!["docx_unsupported_alternate_choice"]);
    }
    #[tokio::test]
    async fn unsupported_alternate_content_is_reported_without_duplicating_or_hiding_body() {
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x="urn:unknown"><w:body><mc:AlternateContent><mc:Choice Requires="x"><w:p><w:r><w:t>Unknown fact</w:t></w:r></w:p></mc:Choice></mc:AlternateContent><w:p><w:r><w:t>Final body</w:t></w:r></w:p></w:body></w:document>"#;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("alternate.docx");
        std::fs::write(&path, document(xml)).unwrap();
        let ctx = crate::ToolContext::new(kcoder_state::AppState::new(dir.path()));
        let result =
            super::super::extract_document_report(&path, super::super::DocumentFormat::Docx, &ctx)
                .await
                .unwrap();
        assert_eq!(result.chunks[0].text.trim(), "Final body");
        assert!(
            result
                .report
                .warnings
                .iter()
                .any(|warning| warning == "docx_final_revision_view")
        );
        assert!(
            result
                .report
                .warnings
                .iter()
                .any(|warning| warning == "docx_unsupported_alternate_choice")
        );
        assert!(
            result
                .report
                .warnings
                .iter()
                .any(|warning| warning == "docx_alternate_content_without_supported_branch")
        );
    }
    #[test]
    fn rejects_corrupt_empty_and_external_entity_documents() {
        assert!(extract(b"not a zip").is_err());
        assert!(extract(&document("<document/>")).is_err());
        assert!(extract(&document("<!DOCTYPE x SYSTEM 'file:///etc/passwd'><x/>")).is_err());
        assert!(extract(&document("<document><t>broken</document>")).is_err());
    }
}
