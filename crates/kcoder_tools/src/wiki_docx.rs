//! Read bounded WordprocessingML without launching Word or following relationships.
use super::{MAX_EXTRACTED_BYTES, OfficeReadText, error};
use crate::DocumentParseError;
use quick_xml::{
    events::{BytesStart, Event},
    name::{QName, ResolveResult},
    reader::NsReader,
};
use std::io::{Cursor, Read};

#[cfg(test)]
pub(super) fn extract(bytes: &[u8]) -> Result<String, DocumentParseError> {
    Ok(extract_with_warnings(bytes)?.0)
}

pub fn extract_with_warnings(
    bytes: &[u8],
) -> Result<(String, Vec<&'static str>), DocumentParseError> {
    let xml = document_xml(bytes)?;
    let (text, warnings) = extract_xml_report(&xml)?;
    if text.trim().is_empty() {
        return Err(error(
            "Word document has no extractable body text; OCR was not performed",
        ));
    }
    Ok((text, warnings))
}

/// Body paragraphs and tables in reading order, with tables as Markdown rows.
pub fn extract_for_read(bytes: &[u8]) -> Result<OfficeReadText, DocumentParseError> {
    let xml = document_xml(bytes)?;
    let walked = walk(&xml, Layout::Read)?;
    let text = tidy(&walked.text);
    if text.trim().is_empty() {
        return Err(error(
            "Word document has no extractable body text; images are not OCRed",
        ));
    }
    if text.len() > MAX_EXTRACTED_BYTES {
        return Err(error(
            "Extracted text exceeds 8 MiB; document was not truncated",
        ));
    }
    let notes = walked
        .warnings
        .iter()
        .map(|warning| match *warning {
            "docx_unsupported_alternate_choice" => {
                "Some compatibility content was read from its fallback representation."
            }
            _ => "Some alternate content had no supported representation and was omitted.",
        })
        .map(str::to_owned)
        .collect();
    Ok(OfficeReadText {
        text,
        sections: Vec::new(),
        notes,
    })
}

fn document_xml(bytes: &[u8]) -> Result<String, DocumentParseError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| error("Invalid or encrypted Word document; save as unencrypted .docx"))?;
    if archive.len() > super::MAX_ARCHIVE_ENTRIES {
        return Err(error("Word document contains too many archive entries"));
    }
    super::check_archive(&mut archive, "Word document")?;
    let limit = 32 * 1024 * 1024;
    let mut part = archive
        .by_name("word/document.xml")
        .map_err(|_| error("Word document is missing word/document.xml"))?;
    let declared = part.size();
    if declared > limit {
        return Err(error("Word document XML exceeds 32 MiB"));
    }
    let mut xml = Vec::new();
    part.by_ref()
        .take(declared + 1)
        .read_to_end(&mut xml)
        .map_err(|_| error("Cannot decompress Word document"))?;
    if xml.len() as u64 != declared {
        return Err(error(
            "Word document XML size does not match its archive header; the file is corrupt",
        ));
    }
    super::decode_xml(&xml)
}

pub(super) fn extract_xml(xml: &str) -> Result<String, DocumentParseError> {
    Ok(extract_xml_report(xml)?.0)
}

fn extract_xml_report(xml: &str) -> Result<(String, Vec<&'static str>), DocumentParseError> {
    let walked = walk(xml, Layout::Wiki)?;
    Ok((walked.text, walked.warnings))
}

/// Wiki keeps its historical tab/newline text; Read renders tables as rows
/// and separates DrawingML slide titles from body text.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Layout {
    Wiki,
    Read,
}

pub(super) struct Walked {
    pub text: String,
    pub title: String,
    pub warnings: Vec<&'static str>,
}

#[derive(Default)]
struct Frame {
    suppressed: bool,
    in_text: bool,
    alternate: Option<bool>,
    // Read layout only: structure flags for frames this walker opened.
    shape: bool,
    title: bool,
    table: bool,
    row: bool,
    cell: bool,
}

#[derive(Default)]
struct Table {
    rows: Vec<Vec<String>>,
    row: Vec<String>,
    cell: Option<String>,
}

struct Writer {
    layout: Layout,
    text: String,
    title: String,
    tables: Vec<Table>,
    written: usize,
}

impl Writer {
    fn push(&mut self, title: bool, value: &str) -> Result<(), DocumentParseError> {
        self.written = self.written.saturating_add(value.len());
        if self.written > MAX_EXTRACTED_BYTES {
            return Err(error(match self.layout {
                Layout::Wiki => "Wiki extracted text exceeds 8 MiB; document was not truncated",
                Layout::Read => "Extracted text exceeds 8 MiB; document was not truncated",
            }));
        }
        self.push_unbudgeted(title, value);
        Ok(())
    }

    fn push_unbudgeted(&mut self, title: bool, value: &str) {
        if let Some(cell) = self.tables.last_mut().and_then(|table| table.cell.as_mut()) {
            cell.push_str(value);
        } else if title {
            self.title.push_str(value);
        } else {
            self.text.push_str(value);
        }
    }

    fn close_table(&mut self) {
        let Some(table) = self.tables.pop() else {
            return;
        };
        let nested = self
            .tables
            .last()
            .is_some_and(|parent| parent.cell.is_some());
        let mut rendered = String::new();
        for (index, row) in table.rows.iter().enumerate() {
            rendered.push_str("| ");
            rendered.push_str(&row.join(" | "));
            rendered.push_str(" |\n");
            if index == 0 && !nested && table.rows.len() > 1 {
                rendered.push('|');
                rendered.push_str(&" --- |".repeat(row.len()));
                rendered.push('\n');
            }
        }
        if nested {
            self.push_unbudgeted(false, &rendered);
        } else {
            self.text.push('\n');
            self.text.push_str(&rendered);
            self.text.push('\n');
        }
    }
}

/// One table cell on one line: paragraphs become `<br>` and pipes are escaped.
fn cell_text(raw: &str) -> String {
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.replace('|', "\\|"))
        .collect::<Vec<_>>()
        .join("<br>")
}

/// Trim trailing spaces and collapse repeated blank lines in Read output.
pub(super) fn tidy(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank = true;
    for line in text.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            if !blank {
                out.push('\n');
                blank = true;
            }
        } else {
            out.push_str(line);
            out.push('\n');
            blank = false;
        }
    }
    while out.ends_with("\n\n") {
        out.pop();
    }
    out
}

fn supported_choice(
    reader: &NsReader<&[u8]>,
    element: &BytesStart<'_>,
) -> Result<bool, DocumentParseError> {
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

fn placeholder_type(element: &BytesStart<'_>) -> Result<String, DocumentParseError> {
    for attribute in element.attributes() {
        let attribute = attribute.map_err(|_| error("Invalid Office XML attribute"))?;
        if attribute.key.as_ref() == b"type" {
            return attribute
                .unescape_value()
                .map(|value| value.into_owned())
                .map_err(|_| error("Invalid Office placeholder type"));
        }
    }
    Ok(String::new())
}

pub(super) fn walk(xml: &str, layout: Layout) -> Result<Walked, DocumentParseError> {
    let read = layout == Layout::Read;
    let mut reader = NsReader::from_str(xml);
    let mut out = Writer {
        layout,
        text: String::new(),
        title: String::new(),
        tables: Vec::new(),
        written: 0,
    };
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
                // DrawingML placeholders (sp > nvSpPr > nvPr > ph) classify the shape.
                if read && !suppressed && name == b"ph" && frames.len() >= 3 {
                    let kind = placeholder_type(&element)?;
                    let shape = frames.len() - 3;
                    if frames[shape].shape {
                        match kind.as_str() {
                            "title" | "ctrTitle" => frames[shape].title = true,
                            "sldNum" | "dt" | "ftr" | "hdr" | "sldImg" => {
                                frames[shape].suppressed = true
                            }
                            _ => {}
                        }
                    }
                }
                let title = frames.last().is_some_and(|frame| frame.title);
                if !suppressed && empty {
                    match name {
                        b"tab" => out.push(title, "\t")?,
                        b"br" | b"cr" => out.push(title, "\n")?,
                        _ => {}
                    }
                }
                if !empty {
                    if frames.len() >= 256 {
                        return Err(error("Word XML nesting exceeds limit"));
                    }
                    let mut frame = Frame {
                        suppressed,
                        in_text: name == b"t",
                        alternate: (compatibility && name == b"AlternateContent").then_some(false),
                        title,
                        ..Frame::default()
                    };
                    if read && !suppressed {
                        match name {
                            b"sp" => frame.shape = true,
                            b"tbl" => {
                                out.tables.push(Table::default());
                                frame.table = true;
                            }
                            b"tr" if !out.tables.is_empty() => frame.row = true,
                            b"tc" => {
                                if let Some(table) = out.tables.last_mut() {
                                    table.cell = Some(String::new());
                                    frame.cell = true;
                                }
                            }
                            _ => {}
                        }
                    }
                    frames.push(frame);
                }
            }
            Event::End(element) => {
                let frame = frames.pop().ok_or_else(|| error("Malformed Word XML"))?;
                if !frame.suppressed {
                    match (layout, element.local_name().as_ref()) {
                        (_, b"p") | (Layout::Wiki, b"tr") => out.push(frame.title, "\n")?,
                        (Layout::Wiki, b"tc") => out.push(frame.title, "\t")?,
                        _ => {}
                    }
                    if frame.cell
                        && let Some(table) = out.tables.last_mut()
                        && let Some(cell) = table.cell.take()
                    {
                        table.row.push(cell_text(&cell));
                    }
                    if frame.row
                        && let Some(table) = out.tables.last_mut()
                    {
                        let row = std::mem::take(&mut table.row);
                        if !row.is_empty() {
                            table.rows.push(row);
                        }
                    }
                    if frame.table {
                        out.close_table();
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
                let title = frames.last().is_some_and(|frame| frame.title);
                out.push(
                    title,
                    &element
                        .decode()
                        .map_err(|_| error("Invalid Word text encoding"))?,
                )?;
            }
            Event::GeneralRef(element)
                if frames
                    .last()
                    .is_some_and(|frame| frame.in_text && !frame.suppressed) =>
            {
                let title = frames.last().is_some_and(|frame| frame.title);
                let name = element.decode().map_err(|_| error("Invalid Word entity"))?;
                out.push(
                    title,
                    &quick_xml::escape::unescape(&format!("&{name};"))
                        .map_err(|_| error("Unsupported Word XML entity"))?,
                )?;
            }
            Event::CData(element)
                if frames
                    .last()
                    .is_some_and(|frame| frame.in_text && !frame.suppressed) =>
            {
                let title = frames.last().is_some_and(|frame| frame.title);
                out.push(
                    title,
                    &element
                        .decode()
                        .map_err(|_| error("Invalid Word text encoding"))?,
                )?;
            }
            Event::Eof => {
                if !frames.is_empty() {
                    return Err(error("Malformed Word XML"));
                }
                break;
            }
            _ => {}
        }
    }
    Ok(Walked {
        text: out.text,
        title: out.title,
        warnings,
    })
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
    #[test]
    fn read_layout_renders_nested_tables_while_wiki_text_is_unchanged() {
        let cell = |text: &str| format!("<w:tc><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:tc>");
        let inner = format!("<w:tbl><w:tr>{}{}</w:tr></w:tbl>", cell("x"), cell("y"));
        let xml = format!(
            r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tr>{}{}</w:tr><w:tr><w:tc>{inner}</w:tc>{}</w:tr></w:tbl></w:body></w:document>"#,
            cell("H1"),
            cell("H2"),
            cell("v")
        );
        let read = extract_for_read(&document(&xml)).unwrap();
        assert_eq!(
            read.text,
            "| H1 | H2 |\n| --- | --- |\n| \\| x \\| y \\| | v |\n"
        );
        assert_eq!(
            extract(&document(&xml)).unwrap(),
            "H1\n\tH2\n\t\nx\n\ty\n\t\n\tv\n\t\n"
        );
    }
    #[test]
    fn forged_part_size_is_rejected_before_overreading() {
        let body = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>forged</w:t></w:r></w:p></w:body></w:document>"#;
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        archive.start_file("word/document.xml", options).unwrap();
        archive.write_all(body.as_bytes()).unwrap();
        let mut bytes = archive.finish().unwrap().into_inner();
        let forged = (body.len() as u32 - 10).to_le_bytes();
        for (signature, field) in [(0x0403_4b50u32, 22), (0x0201_4b50, 24)] {
            let at = bytes
                .windows(4)
                .position(|window| window == signature.to_le_bytes())
                .unwrap();
            bytes[at + field..at + field + 4].copy_from_slice(&forged);
        }
        let error = extract(&bytes).unwrap_err().to_string();
        assert!(
            error.contains("corrupt") || error.contains("decompress"),
            "{error}"
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
