//! Extract slide text in presentation order, without executing embedded content.
use super::{
    MAX_EXTRACTED_BYTES, docx, error,
    xlsx::{attr, part},
};
use crate::ToolError;
use quick_xml::{Reader, events::Event};
use std::{collections::HashMap, io::Cursor};

#[cfg(test)]
pub(super) fn extract(bytes: &[u8]) -> Result<String, ToolError> {
    Ok(extract_with_units(bytes)?.0)
}

pub(super) fn extract_with_units(bytes: &[u8]) -> Result<(String, usize, usize), ToolError> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| error("Invalid or encrypted PowerPoint; save as unencrypted .pptx"))?;
    if zip.len() > 4096 {
        return Err(error("PowerPoint archive contains too many entries"));
    }
    let mut total = 0u64;
    for i in 0..zip.len() {
        total = total.saturating_add(
            zip.by_index(i)
                .map_err(|_| error("Invalid PowerPoint archive"))?
                .size(),
        );
        if total > 64 * 1024 * 1024 {
            return Err(error("PowerPoint expanded archive exceeds 64 MiB"));
        }
    }
    let xml = part(&mut zip, "ppt/_rels/presentation.xml.rels")?;
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
    let xml = part(&mut zip, "ppt/presentation.xml")?;
    let mut reader = Reader::from_str(&xml);
    let (mut output, mut index, mut extracted) = (String::new(), 0, 0);
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
                index += 1;
                let text = docx::extract_xml(&part(&mut zip, path)?)?;
                extracted += usize::from(!text.trim().is_empty());
                output.push_str(&format!("\nSlide {index}\n{text}"));
                if output.len() > MAX_EXTRACTED_BYTES {
                    return Err(error("PowerPoint extracted text exceeds 8 MiB"));
                }
            }
            Event::DocType(_) => return Err(error("PowerPoint XML DTD is not supported")),
            Event::Eof => break,
            _ => {}
        }
    }
    if extracted == 0 {
        return Err(error(
            "PowerPoint has no extractable text; images are not OCRed",
        ));
    }
    Ok((output, extracted, index))
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
