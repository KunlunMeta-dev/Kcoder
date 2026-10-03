//! Read bounded WordprocessingML without launching Word or following relationships.
use super::{MAX_EXTRACTED_BYTES, error};
use crate::ToolError;
use quick_xml::{Reader, events::Event};
use std::io::{Cursor, Read};

pub(super) fn extract(bytes: &[u8]) -> Result<String, ToolError> {
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
    let text = extract_xml(&xml)?;
    if text.trim().is_empty() {
        return Err(error(
            "Word document has no extractable body text; OCR was not performed",
        ));
    }
    Ok(text)
}

pub(super) fn extract_xml(xml: &str) -> Result<String, ToolError> {
    let mut reader = Reader::from_str(xml);
    let mut text = String::new();
    let mut in_text = false;
    let mut deleted = 0usize;
    loop {
        match reader
            .read_event()
            .map_err(|_| error("Malformed Word XML"))?
        {
            Event::DocType(_) => return Err(error("Word XML DTD is not supported")),
            Event::Start(e) => match e.local_name().as_ref() {
                b"del" => deleted += 1,
                b"t" => in_text = true,
                _ => {}
            },
            Event::End(e) => match e.local_name().as_ref() {
                b"del" => deleted = deleted.saturating_sub(1),
                b"t" => in_text = false,
                b"p" | b"tr" if deleted == 0 => text.push('\n'),
                b"tc" if deleted == 0 => text.push('\t'),
                _ => {}
            },
            Event::Empty(e) if deleted == 0 => match e.local_name().as_ref() {
                b"tab" => text.push('\t'),
                b"br" | b"cr" => text.push('\n'),
                _ => {}
            },
            Event::Text(e) if in_text && deleted == 0 => text.push_str(
                &e.decode()
                    .map_err(|_| error("Invalid Word text encoding"))?,
            ),
            Event::GeneralRef(e) if in_text && deleted == 0 => {
                let name = e.decode().map_err(|_| error("Invalid Word entity"))?;
                let entity = format!("&{name};");
                text.push_str(
                    &quick_xml::escape::unescape(&entity)
                        .map_err(|_| error("Unsupported Word XML entity"))?,
                );
            }
            Event::CData(e) if in_text && deleted == 0 => text.push_str(
                &e.decode()
                    .map_err(|_| error("Invalid Word text encoding"))?,
            ),
            Event::Eof => break,
            _ => {}
        }
        if text.len() > MAX_EXTRACTED_BYTES {
            return Err(error(
                "Wiki extracted text exceeds 8 MiB; document was not truncated",
            ));
        }
    }
    Ok(text)
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
    fn rejects_corrupt_empty_and_external_entity_documents() {
        assert!(extract(b"not a zip").is_err());
        assert!(extract(&document("<document/>")).is_err());
        assert!(extract(&document("<!DOCTYPE x SYSTEM 'file:///etc/passwd'><x/>")).is_err());
        assert!(extract(&document("<document><t>broken</document>")).is_err());
    }
}
