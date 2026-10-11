//! Bounded XLSX text extraction. Never evaluate formulas or external links.
use super::{MAX_EXTRACTED_BYTES, error};
use crate::ToolError;
#[path = "wiki_xlsx_dates.rs"]
mod dates;
use quick_xml::{
    Reader,
    events::{BytesStart, Event},
};
use std::{
    collections::HashMap,
    io::{Cursor, Read},
};

pub(super) fn attr(e: &BytesStart<'_>, key: &[u8]) -> Result<String, ToolError> {
    for a in e.attributes() {
        let a = a.map_err(|_| error("Invalid Excel XML attribute"))?;
        if a.key.local_name().as_ref() == key {
            return a
                .unescape_value()
                .map(|v| v.into_owned())
                .map_err(|_| error("Invalid Excel XML attribute"));
        }
    }
    Ok(String::new())
}
pub(super) fn part(
    zip: &mut zip::ZipArchive<Cursor<&[u8]>>,
    name: &str,
) -> Result<String, ToolError> {
    let file = zip
        .by_name(name)
        .map_err(|_| error("Excel workbook part is missing"))?;
    let mut bytes = Vec::new();
    file.take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("Cannot decompress Excel workbook"))?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(error("Excel XML exceeds 32 MiB"));
    }
    super::decode_xml(&bytes)
}
fn text_event(event: &Event<'_>) -> Result<Option<String>, ToolError> {
    Ok(match event {
        Event::Text(e) => Some(
            e.decode()
                .map_err(|_| error("Invalid Excel text"))?
                .into_owned(),
        ),
        Event::CData(e) => Some(
            e.decode()
                .map_err(|_| error("Invalid Excel text"))?
                .into_owned(),
        ),
        Event::GeneralRef(e) => {
            let name = e.decode().map_err(|_| error("Invalid Excel entity"))?;
            Some(
                quick_xml::escape::unescape(&format!("&{name};"))
                    .map_err(|_| error("Unsupported Excel entity"))?
                    .into_owned(),
            )
        }
        Event::DocType(_) => return Err(error("Excel XML DTD is not supported")),
        _ => None,
    })
}
fn shared_strings(xml: &str) -> Result<Vec<String>, ToolError> {
    let mut reader = Reader::from_str(xml);
    let (mut strings, mut value, mut inside, mut total) = (Vec::new(), String::new(), false, 0);
    let mut phonetic_depth = 0usize;
    loop {
        let event = reader
            .read_event()
            .map_err(|_| error("Malformed Excel shared strings"))?;
        if let Some(s) = text_event(&event)?
            && inside
            && phonetic_depth == 0
        {
            value.push_str(&s);
        }
        match event {
            Event::Start(e) if e.local_name().as_ref() == b"rPh" => phonetic_depth += 1,
            Event::End(e) if e.local_name().as_ref() == b"rPh" => {
                phonetic_depth = phonetic_depth.saturating_sub(1)
            }
            Event::Start(e) if e.local_name().as_ref() == b"t" && phonetic_depth == 0 => {
                inside = true
            }
            Event::End(e) if e.local_name().as_ref() == b"t" && phonetic_depth == 0 => {
                inside = false
            }
            Event::End(e) if e.local_name().as_ref() == b"si" => {
                total += value.len();
                if strings.len() >= 200_000 || total > MAX_EXTRACTED_BYTES {
                    return Err(error("Excel shared strings exceed extraction limit"));
                }
                strings.push(std::mem::take(&mut value));
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(strings)
}
#[cfg(test)]
pub(super) fn extract(bytes: &[u8]) -> Result<String, ToolError> {
    Ok(extract_with_units(bytes)?.0)
}

pub(super) fn extract_with_units(bytes: &[u8]) -> Result<(String, usize, usize, bool), ToolError> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| error("Invalid or encrypted Excel file; save as unencrypted .xlsx"))?;
    if zip.len() > 4096 {
        return Err(error("Excel archive contains too many entries"));
    }
    let mut total = 0u64;
    for i in 0..zip.len() {
        let file = zip
            .by_index(i)
            .map_err(|_| error("Invalid Excel archive entry"))?;
        total = total.saturating_add(file.size());
        if total > 64 * 1024 * 1024 {
            return Err(error("Excel expanded workbook exceeds 64 MiB"));
        }
    }
    let shared = if zip.file_names().any(|n| n == "xl/sharedStrings.xml") {
        shared_strings(&part(&mut zip, "xl/sharedStrings.xml")?)?
    } else {
        Vec::new()
    };
    let formats = if zip.file_names().any(|name| name == "xl/styles.xml") {
        dates::styles(&part(&mut zip, "xl/styles.xml")?)?
    } else {
        Vec::new()
    };
    let rels = part(&mut zip, "xl/_rels/workbook.xml.rels")?;
    let mut reader = Reader::from_str(&rels);
    let mut paths = HashMap::new();
    loop {
        let event = reader
            .read_event()
            .map_err(|_| error("Malformed Excel relationships"))?;
        text_event(&event)?;
        match event {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"Relationship" => {
                if attr(&e, b"TargetMode")? == "External" {
                    continue;
                }
                let target = attr(&e, b"Target")?;
                let path = if target.starts_with("/xl/") {
                    target[1..].to_owned()
                } else {
                    format!("xl/{target}")
                };
                if path.split('/').any(|p| p == "..") || path.contains('\\') {
                    return Err(error("Invalid Excel part path"));
                }
                paths.insert(attr(&e, b"Id")?, path);
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let mut missing_cache = false;
    let workbook = part(&mut zip, "xl/workbook.xml")?;
    let mut reader = Reader::from_str(&workbook);
    let (mut output, mut cells, mut epoch_1904, mut sheets, mut extracted_sheets) =
        (String::new(), 0usize, false, 0usize, 0usize);
    loop {
        let event = reader
            .read_event()
            .map_err(|_| error("Malformed Excel workbook"))?;
        text_event(&event)?;
        match event {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"workbookPr" => {
                epoch_1904 = matches!(attr(&e, b"date1904")?.as_str(), "1" | "true");
            }
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"sheet" => {
                let id = attr(&e, b"id")?;
                let path = paths
                    .get(&id)
                    .ok_or_else(|| error("Excel worksheet relationship missing"))?;
                sheets += 1;
                output.push_str(&format!("\nSheet: {}\n", attr(&e, b"name")?));
                let before_cells = cells;
                worksheet_formatted(
                    &part(&mut zip, path)?,
                    &shared,
                    &formats,
                    epoch_1904,
                    &mut output,
                    &mut cells,
                    &mut missing_cache,
                )?;
                extracted_sheets += usize::from(cells > before_cells);
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if cells == 0 {
        return Err(error("Excel workbook has no extractable cells"));
    }
    Ok((output, extracted_sheets, sheets, missing_cache))
}
#[cfg(test)]
fn worksheet(
    xml: &str,
    shared: &[String],
    output: &mut String,
    cells: &mut usize,
) -> Result<(), ToolError> {
    worksheet_formatted(xml, shared, &[], false, output, cells, &mut false)
}
fn worksheet_formatted(
    xml: &str,
    shared: &[String],
    formats: &[dates::Format],
    epoch_1904: bool,
    output: &mut String,
    cells: &mut usize,
    missing_cache: &mut bool,
) -> Result<(), ToolError> {
    let mut reader = Reader::from_str(xml);
    let (mut address, mut kind, mut value, mut formula, mut field) = (
        String::new(),
        String::new(),
        String::new(),
        String::new(),
        String::new(),
    );
    let mut style = 0usize;
    let mut phonetic_depth = 0usize;
    loop {
        let event = reader
            .read_event()
            .map_err(|_| error("Malformed Excel worksheet"))?;
        if let Some(s) = text_event(&event)?
            && phonetic_depth == 0
        {
            match field.as_str() {
                "v" | "t" => value.push_str(&s),
                "f" => formula.push_str(&s),
                _ => {}
            }
        }
        match event {
            Event::Start(e) => match e.local_name().as_ref() {
                b"rPh" => phonetic_depth += 1,
                b"c" => {
                    address = attr(&e, b"r")?;
                    kind = attr(&e, b"t")?;
                    let index = attr(&e, b"s")?;
                    style = if index.is_empty() {
                        0
                    } else {
                        index
                            .parse()
                            .map_err(|_| error("Invalid Excel style index"))?
                    };
                    value.clear();
                    formula.clear();
                }
                b"v" | b"t" | b"f" => {
                    field = String::from_utf8_lossy(e.local_name().as_ref()).into_owned()
                }
                _ => {}
            },
            Event::End(e) => match e.local_name().as_ref() {
                b"rPh" => phonetic_depth = phonetic_depth.saturating_sub(1),
                b"v" | b"t" | b"f" => field.clear(),
                b"c" => {
                    if kind == "s" {
                        value = shared
                            .get(
                                value
                                    .parse::<usize>()
                                    .map_err(|_| error("Invalid Excel string index"))?,
                            )
                            .ok_or_else(|| error("Excel string index out of range"))?
                            .clone();
                    } else if value.is_empty() && !formula.is_empty() {
                        *missing_cache = true;
                        value = format!("={formula} [no cached value]");
                    } else if kind == "b" && !value.is_empty() {
                        value = match value.as_str() {
                            "1" | "true" => "true",
                            "0" | "false" => "false",
                            _ => return Err(error("Invalid Excel boolean cell")),
                        }
                        .into();
                    } else if kind.is_empty() || kind == "n" {
                        value = dates::render(
                            &value,
                            formats.get(style).copied().unwrap_or_default(),
                            epoch_1904,
                        )?;
                    }
                    if !value.is_empty() {
                        output.push_str(&format!("{address}: {value}\n"));
                        *cells += 1;
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        if output.len() > MAX_EXTRACTED_BYTES || *cells > 200_000 {
            return Err(error(
                "Excel extracted text exceeds limit; document was not truncated",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn phonetic_hint_is_not_part_of_shared_or_inline_cell_body() {
        let shared = shared_strings("<sst><si><t>日本</t><rPh sb='0' eb='2'><t>にほん</t></rPh></si><si><r><t>Rich</t></r><r><t> text</t></r><rPh sb='0' eb='4'><t>hint</t></rPh></si></sst>").unwrap();
        assert_eq!(shared, ["日本", "Rich text"]);
        let mut out = String::new();
        worksheet_formatted("<worksheet><c r='A1' t='inlineStr'><is><t>日本</t><rPh sb='0' eb='2'><t>にほん</t></rPh></is></c></worksheet>", &[], &[], false, &mut out, &mut 0, &mut false).unwrap();
        assert_eq!(out, "A1: 日本\n");
    }
    #[test]
    fn missing_formula_cache_warning_is_derived_from_cells_not_source_strings() {
        let mut missing = false;
        worksheet_formatted(
            "<worksheet><c r='A1' t='inlineStr'><is><t>[no cached value]</t></is></c></worksheet>",
            &[],
            &[],
            false,
            &mut String::new(),
            &mut 0,
            &mut missing,
        )
        .unwrap();
        assert!(!missing);
        worksheet_formatted(
            "<worksheet><c r='A1'><f>1+3</f></c></worksheet>",
            &[],
            &[],
            false,
            &mut String::new(),
            &mut 0,
            &mut missing,
        )
        .unwrap();
        assert!(missing);
    }

    #[test]
    fn reads_shared_inline_numeric_and_formula_cells() {
        let mut out = String::new();
        let mut count = 0;
        worksheet(r#"<worksheet><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>中文 &amp; 表格</t></is></c><c r="C1"><f>1+2</f><v>3</v></c><c r="D1"><f>1+3</f></c></row></worksheet>"#, &["标题".into()], &mut out, &mut count).unwrap();
        assert_eq!(count, 4);
        assert!(out.contains("A1: 标题"));
        assert!(out.contains("B1: 中文 & 表格"));
        assert!(out.contains("C1: 3"));
        assert!(out.contains("D1: =1+3 [no cached value]"));
    }
    #[test]
    fn rejects_bad_shared_string_and_dtd() {
        assert!(
            worksheet(
                "<w><c t='s'><v>5</v></c></w>",
                &[],
                &mut String::new(),
                &mut 0
            )
            .is_err()
        );
        assert!(shared_strings("<!DOCTYPE x SYSTEM 'file:///secret'><x/>").is_err());
        assert!(extract(b"invalid").is_err());
    }
}

#[cfg(test)]
mod archive_tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn workbook_names_and_shared_strings_are_resolved() {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, xml) in [
            (
                "xl/_rels/workbook.xml.rels",
                "<Relationships><Relationship Id='r1' Target='worksheets/sheet1.xml'/></Relationships>",
            ),
            (
                "xl/workbook.xml",
                "<workbook xmlns:r='r'><sheets><sheet name='统计表' sheetId='1' r:id='r1'/></sheets></workbook>",
            ),
            ("xl/sharedStrings.xml", "<sst><si><t>收入</t></si></sst>"),
            (
                "xl/worksheets/sheet1.xml",
                "<worksheet><sheetData><row><c r='A1' t='s'><v>0</v></c><c r='B1'><v>100</v></c></row></sheetData></worksheet>",
            ),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(xml.as_bytes()).unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        assert_eq!(extract_with_units(&bytes).unwrap().1, 1);
        assert_eq!(extract_with_units(&bytes).unwrap().2, 1);
        assert!(!extract_with_units(&bytes).unwrap().3);
        assert_eq!(
            extract(&bytes).unwrap(),
            "\nSheet: 统计表\nA1: 收入\nB1: 100\n"
        );
    }
}
