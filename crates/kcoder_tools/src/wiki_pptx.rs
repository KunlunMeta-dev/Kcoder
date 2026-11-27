//! Extract slide text in presentation order, without executing embedded content.
use super::{
    MAX_EXTRACTED_BYTES, OfficeReadText, docx, error, read_archive_part,
    xlsx::{attr, part},
};
use crate::DocumentParseError;
use quick_xml::{Reader, events::Event};
use std::{collections::HashMap, io::Cursor};

#[cfg(test)]
pub(super) fn extract(bytes: &[u8]) -> Result<String, DocumentParseError> {
    Ok(extract_with_units(bytes)?.0)
}

pub fn extract_with_units(bytes: &[u8]) -> Result<(String, usize, usize), DocumentParseError> {
    let mut zip = open(bytes)?;
    let (mut output, mut index, mut extracted) = (String::new(), 0, 0);
    for path in slide_paths(&mut zip)? {
        index += 1;
        let text = docx::extract_xml(&part(&mut zip, &path)?)?;
        extracted += usize::from(!text.trim().is_empty());
        output.push_str(&format!("\nSlide {index}\n{text}"));
        if output.len() > MAX_EXTRACTED_BYTES {
            return Err(error("PowerPoint extracted text exceeds 8 MiB"));
        }
    }
    if extracted == 0 {
        return Err(error(
            "PowerPoint has no extractable text; images are not OCRed",
        ));
    }
    Ok((output, extracted, index))
}

/// Per slide in presentation order: title, body text, tables and speaker notes.
pub fn extract_for_read(bytes: &[u8]) -> Result<OfficeReadText, DocumentParseError> {
    let mut zip = open(bytes)?;
    let mut result = OfficeReadText::default();
    let (mut extracted, mut missing_notes) = (0usize, 0usize);
    for (index, path) in slide_paths(&mut zip)?.into_iter().enumerate() {
        let number = index + 1;
        let xml = part(&mut zip, &path)?;
        let hidden = slide_hidden(&xml)?;
        let slide = docx::walk(&xml, docx::Layout::Read)?;
        let title = slide.title.split_whitespace().collect::<Vec<_>>().join(" ");
        let body = docx::tidy(&slide.text);
        let notes = match notes_path(&mut zip, &path)? {
            Some(notes) => match read_archive_part(&mut zip, &notes, 32 * 1024 * 1024)? {
                Some(bytes) => {
                    let xml = super::decode_xml(&bytes)?;
                    docx::tidy(&docx::walk(&xml, docx::Layout::Read)?.text)
                }
                None => {
                    missing_notes += 1;
                    String::new()
                }
            },
            None => String::new(),
        };
        let mut heading = format!("Slide {number}");
        if hidden {
            heading.push_str(" (hidden)");
        }
        if !title.is_empty() {
            heading.push_str(": ");
            heading.push_str(&title);
        }
        if !result.text.is_empty() {
            result.text.push('\n');
        }
        result.sections.push((result.text.len(), heading.clone()));
        result.text.push_str(&format!("## {heading}\n"));
        if body.trim().is_empty() && notes.trim().is_empty() && title.is_empty() {
            result
                .text
                .push_str("(no text on this slide; images are not OCRed)\n");
        } else {
            extracted += 1;
        }
        result.text.push_str(&body);
        if !notes.trim().is_empty() {
            result.text.push_str("Speaker notes:\n");
            result.text.push_str(&notes);
        }
        if result.text.len() > MAX_EXTRACTED_BYTES {
            return Err(error(
                "PowerPoint extracted text exceeds 8 MiB; document was not truncated",
            ));
        }
    }
    if extracted == 0 {
        return Err(error(
            "PowerPoint has no extractable text; images are not OCRed",
        ));
    }
    if missing_notes > 0 {
        result.notes.push(format!(
            "{missing_notes} slide(s) reference speaker notes that are missing from the file."
        ));
    }
    Ok(result)
}

fn open(bytes: &[u8]) -> Result<zip::ZipArchive<Cursor<&[u8]>>, DocumentParseError> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| error("Invalid or encrypted PowerPoint; save as unencrypted .pptx"))?;
    super::check_archive(&mut zip, "PowerPoint")?;
    Ok(zip)
}

/// Resolve slide parts in presentation order without following external targets.
fn slide_paths(
    zip: &mut zip::ZipArchive<Cursor<&[u8]>>,
) -> Result<Vec<String>, DocumentParseError> {
    let xml = part(zip, "ppt/_rels/presentation.xml.rels")?;
    let mut reader = Reader::from_str(&xml);
    let mut paths = HashMap::new();
    loop {
        match reader
            .read_event()
            .map_err(|_| error("Malformed PowerPoint relationships"))?
        {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"Relationship" => {
                if attr(&e, b"TargetMode")? == "External" {
                    continue;
                }
                let target = attr(&e, b"Target")?;
                let path = if target.starts_with("/ppt/") {
                    target[1..].to_owned()
                } else {
                    format!("ppt/{target}")
                };
                if path.split('/').any(|p| p == "..") || path.contains('\\') {
                    return Err(error("Invalid PowerPoint part path"));
                }
                paths.insert(attr(&e, b"Id")?, path);
            }
            Event::DocType(_) => return Err(error("PowerPoint XML DTD is not supported")),
            Event::Eof => break,
            _ => {}
        }
    }
    let xml = part(zip, "ppt/presentation.xml")?;
    let mut reader = Reader::from_str(&xml);
    let mut slides = Vec::new();
    loop {
        match reader
            .read_event()
            .map_err(|_| error("Malformed PowerPoint presentation"))?
        {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"sldId" => {
                // r:id is the relationship, while unprefixed id is only a slide number.
                let id = e
                    .attributes()
                    .find_map(|a| a.ok().filter(|a| a.key.as_ref().ends_with(b":id")))
                    .ok_or_else(|| error("PowerPoint slide relationship missing"))?
                    .unescape_value()
                    .map_err(|_| error("Invalid slide relationship"))?
                    .into_owned();
                let path = paths
                    .get(&id)
                    .ok_or_else(|| error("PowerPoint slide is missing"))?;
                slides.push(path.clone());
            }
            Event::DocType(_) => return Err(error("PowerPoint XML DTD is not supported")),
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(slides)
}

/// `<p:sld show="0">` marks a slide hidden during the show.
fn slide_hidden(xml: &str) -> Result<bool, DocumentParseError> {
    let mut reader = Reader::from_str(xml);
    loop {
        match reader
            .read_event()
            .map_err(|_| error("Malformed PowerPoint slide"))?
        {
            Event::Start(e) | Event::Empty(e) => {
                return Ok(e.local_name().as_ref() == b"sld"
                    && matches!(attr(&e, b"show")?.as_str(), "0" | "false"));
            }
            Event::DocType(_) => return Err(error("PowerPoint XML DTD is not supported")),
            Event::Eof => return Ok(false),
            _ => {}
        }
    }
}

/// Find the internal notes slide referenced by a slide's relationships.
fn notes_path(
    zip: &mut zip::ZipArchive<Cursor<&[u8]>>,
    slide: &str,
) -> Result<Option<String>, DocumentParseError> {
    let (directory, file) = slide.rsplit_once('/').unwrap_or(("", slide));
    let rels = format!("{directory}/_rels/{file}.rels");
    let Some(bytes) = read_archive_part(zip, &rels, 32 * 1024 * 1024)? else {
        return Ok(None);
    };
    let xml = super::decode_xml(&bytes)?;
    let mut reader = Reader::from_str(&xml);
    loop {
        match reader
            .read_event()
            .map_err(|_| error("Malformed PowerPoint slide relationships"))?
        {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"Relationship" => {
                if attr(&e, b"TargetMode")? == "External"
                    || !attr(&e, b"Type")?.ends_with("/notesSlide")
                {
                    continue;
                }
                return resolve_part(directory, &attr(&e, b"Target")?).map(Some);
            }
            Event::DocType(_) => return Err(error("PowerPoint XML DTD is not supported")),
            Event::Eof => return Ok(None),
            _ => {}
        }
    }
}

fn resolve_part(directory: &str, target: &str) -> Result<String, DocumentParseError> {
    if target.contains('\\') {
        return Err(error("Invalid PowerPoint part path"));
    }
    let (mut segments, relative) = match target.strip_prefix('/') {
        Some(absolute) => (Vec::new(), absolute),
        None => (
            directory
                .split('/')
                .filter(|segment| !segment.is_empty())
                .collect::<Vec<_>>(),
            target,
        ),
    };
    for segment in relative.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments
                    .pop()
                    .ok_or_else(|| error("Invalid PowerPoint part path"))?;
            }
            segment => segments.push(segment),
        }
    }
    Ok(segments.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn presentation_order_and_empty_slides_are_preserved() {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, xml) in [
            (
                "ppt/_rels/presentation.xml.rels",
                "<Relationships><Relationship Id='b' Target='slides/slide2.xml'/><Relationship Id='a' Target='slides/slide1.xml'/></Relationships>",
            ),
            (
                "ppt/presentation.xml",
                "<p:presentation xmlns:p='p' xmlns:r='r'><p:sldIdLst><p:sldId id='9' r:id='b'/><p:sldId id='8' r:id='a'/></p:sldIdLst></p:presentation>",
            ),
            (
                "ppt/slides/slide2.xml",
                "<slide><p><t>第二张先显示</t></p></slide>",
            ),
            ("ppt/slides/slide1.xml", "<slide/>"),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(xml.as_bytes()).unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        assert_eq!(extract_with_units(&bytes).unwrap().1, 1);
        assert_eq!(extract_with_units(&bytes).unwrap().2, 2);
        assert_eq!(
            extract(&bytes).unwrap(),
            "\nSlide 1\n第二张先显示\n\nSlide 2\n"
        );
    }
}
