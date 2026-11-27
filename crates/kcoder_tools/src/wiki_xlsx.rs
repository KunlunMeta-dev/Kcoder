//! Bounded XLSX text extraction. Never evaluate formulas or external links.
use super::{MAX_EXTRACTED_BYTES, OfficeReadText, error};
use crate::DocumentParseError;
#[path = "wiki_xlsx_dates.rs"]
mod dates;
use quick_xml::{
    Reader,
    events::{BytesStart, Event},
};
use std::{collections::HashMap, io::Cursor};

pub(super) fn attr(e: &BytesStart<'_>, key: &[u8]) -> Result<String, DocumentParseError> {
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
) -> Result<String, DocumentParseError> {
    let bytes = super::read_archive_part(zip, name, 32 * 1024 * 1024)?
        .ok_or_else(|| error("Excel workbook part is missing"))?;
    super::decode_xml(&bytes)
}
fn text_event(event: &Event<'_>) -> Result<Option<String>, DocumentParseError> {
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
fn shared_strings(xml: &str) -> Result<Vec<String>, DocumentParseError> {
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
pub(super) fn extract(bytes: &[u8]) -> Result<String, DocumentParseError> {
    Ok(extract_with_units(bytes)?.0)
}

struct Workbook<'a> {
    zip: zip::ZipArchive<Cursor<&'a [u8]>>,
    shared: Vec<String>,
    formats: Vec<dates::Format>,
    paths: HashMap<String, String>,
}

struct SheetEntry<'a> {
    name: String,
    hidden: bool,
    xml: String,
    shared: &'a [String],
    formats: &'a [dates::Format],
    epoch_1904: bool,
}

fn open_workbook(bytes: &[u8]) -> Result<Workbook<'_>, DocumentParseError> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| error("Invalid or encrypted Excel file; save as unencrypted .xlsx"))?;
    super::check_archive(&mut zip, "Excel")?;
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
    Ok(Workbook {
        zip,
        shared,
        formats,
        paths,
    })
}

/// Visit worksheets in workbook order; formulas and external links are never evaluated.
fn for_each_sheet(
    workbook: &mut Workbook<'_>,
    mut visit: impl FnMut(SheetEntry<'_>) -> Result<(), DocumentParseError>,
) -> Result<(), DocumentParseError> {
    let xml = part(&mut workbook.zip, "xl/workbook.xml")?;
    let mut reader = Reader::from_str(&xml);
    let mut epoch_1904 = false;
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
                let path = workbook
                    .paths
                    .get(&id)
                    .ok_or_else(|| error("Excel worksheet relationship missing"))?;
                let xml = part(&mut workbook.zip, path)?;
                visit(SheetEntry {
                    name: attr(&e, b"name")?,
                    hidden: matches!(attr(&e, b"state")?.as_str(), "hidden" | "veryHidden"),
                    xml,
                    shared: &workbook.shared,
                    formats: &workbook.formats,
                    epoch_1904,
                })?;
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(())
}

pub fn extract_with_units(
    bytes: &[u8],
) -> Result<(String, usize, usize, bool), DocumentParseError> {
    let mut workbook = open_workbook(bytes)?;
    let (mut output, mut cells, mut sheets, mut extracted_sheets, mut missing_cache) =
        (String::new(), 0usize, 0usize, 0usize, false);
    for_each_sheet(&mut workbook, |sheet| {
        sheets += 1;
        output.push_str(&format!("\nSheet: {}\n", sheet.name));
        let before_cells = cells;
        worksheet_formatted(
            &sheet.xml,
            sheet.shared,
            sheet.formats,
            sheet.epoch_1904,
            &mut output,
            &mut cells,
            &mut missing_cache,
        )?;
        extracted_sheets += usize::from(cells > before_cells);
        Ok(())
    })?;
    if cells == 0 {
        return Err(error("Excel workbook has no extractable cells"));
    }
    Ok((output, extracted_sheets, sheets, missing_cache))
}

const MAX_CELLS: usize = 200_000;

/// Per worksheet: heading, used range, then one line per row of `ADDRESS: value` cells.
pub fn extract_for_read(bytes: &[u8]) -> Result<OfficeReadText, DocumentParseError> {
    let mut workbook = open_workbook(bytes)?;
    let mut result = OfficeReadText::default();
    let (mut sheets, mut cells, mut formulas, mut uncached) = (0usize, 0usize, 0usize, 0usize);
    for_each_sheet(&mut workbook, |sheet| {
        sheets += 1;
        let mut rows = String::new();
        let mut current_row = None;
        let mut range: Option<(u32, u32, u32, u32)> = None;
        let mut sheet_cells = 0usize;
        scan_worksheet(
            &sheet.xml,
            sheet.shared,
            sheet.formats,
            sheet.epoch_1904,
            &mut |cell| {
                let rendered = match cell.value {
                    CellValue::Value { text, formula } => {
                        formulas += usize::from(formula);
                        escape_cell(text)
                    }
                    CellValue::Uncached { formula } => {
                        formulas += 1;
                        uncached += 1;
                        if formula.is_empty() {
                            "[shared formula; no cached value]".to_owned()
                        } else {
                            format!("={} [no cached value]", escape_cell(formula))
                        }
                    }
                };
                if current_row != Some(cell.row) {
                    if current_row.is_some() {
                        rows.push('\n');
                    }
                    current_row = Some(cell.row);
                } else {
                    rows.push_str(" | ");
                }
                let address = if cell.address.is_empty() {
                    format!("{}{}", column_name(cell.column), cell.row)
                } else {
                    cell.address.to_owned()
                };
                rows.push_str(&format!("{address}: {rendered}"));
                let (row, column) = (cell.row, cell.column);
                range = Some(match range {
                    None => (row, column, row, column),
                    Some((r0, c0, r1, c1)) => {
                        (r0.min(row), c0.min(column), r1.max(row), c1.max(column))
                    }
                });
                sheet_cells += 1;
                cells += 1;
                if cells > MAX_CELLS
                    || result.text.len().saturating_add(rows.len()) > MAX_EXTRACTED_BYTES
                {
                    return Err(error(
                        "Excel extracted text exceeds 8 MiB or 200000 cells; document was not truncated",
                    ));
                }
                Ok(())
            },
        )?;
        let mut heading = format!("Sheet {sheets}: {}", sheet.name);
        if sheet.hidden {
            heading.push_str(" (hidden)");
        }
        if !result.text.is_empty() {
            result.text.push('\n');
        }
        result.sections.push((result.text.len(), heading.clone()));
        result.text.push_str(&format!("## {heading}\n"));
        match range {
            Some((r0, c0, r1, c1)) => {
                result.text.push_str(&format!(
                    "Used range {}{r0}:{}{r1}; {sheet_cells} non-empty cell(s)\n",
                    column_name(c0),
                    column_name(c1)
                ));
                result.text.push_str(&rows);
                result.text.push('\n');
            }
            None => result.text.push_str("(no non-empty cells)\n"),
        }
        if result.text.len() > MAX_EXTRACTED_BYTES {
            return Err(error(
                "Excel extracted text exceeds 8 MiB; document was not truncated",
            ));
        }
        Ok(())
    })?;
    if cells == 0 {
        return Err(error("Excel workbook has no extractable cells"));
    }
    if formulas > 0 {
        result.notes.push(format!(
            "Workbook has {formulas} formula cell(s); shown values are the cached results saved in the file (formulas are not recalculated)."
        ));
    }
    if uncached > 0 {
        result.notes.push(format!(
            "{uncached} formula cell(s) have no cached value (uncalculated) and are shown as =FORMULA [no cached value]; recalculate and save the workbook in Excel or LibreOffice to get their values."
        ));
    }
    Ok(result)
}

/// Keep one row per line: escape line breaks and the cell separator.
fn escape_cell(value: &str) -> String {
    value
        .replace('|', "\\|")
        .replace("\r\n", "\\n")
        .replace(['\n', '\r'], "\\n")
}

fn column_name(mut column: u32) -> String {
    let mut name = Vec::new();
    while column > 0 {
        column -= 1;
        name.push(b'A' + (column % 26) as u8);
        column /= 26;
    }
    name.reverse();
    String::from_utf8(name).unwrap_or_default()
}

/// Split an A1 reference into 1-based (column, row).
fn parse_address(address: &str) -> Option<(u32, u32)> {
    let split = address.find(|c: char| c.is_ascii_digit())?;
    let (letters, digits) = address.split_at(split);
    if letters.is_empty() || letters.len() > 3 || !letters.bytes().all(|b| b.is_ascii_uppercase()) {
        return None;
    }
    let column = letters
        .bytes()
        .fold(0u32, |sum, b| sum * 26 + u32::from(b - b'A' + 1));
    Some((column, digits.parse().ok()?))
}

enum CellValue<'a> {
    Value {
        text: &'a str,
        formula: bool,
    },
    /// A formula without a cached value; `formula` is empty for shared-formula children.
    Uncached {
        formula: &'a str,
    },
}

struct CellEvent<'a> {
    address: &'a str,
    row: u32,
    column: u32,
    value: CellValue<'a>,
}

#[cfg(test)]
fn worksheet(
    xml: &str,
    shared: &[String],
    output: &mut String,
    cells: &mut usize,
) -> Result<(), DocumentParseError> {
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
) -> Result<(), DocumentParseError> {
    scan_worksheet(xml, shared, formats, epoch_1904, &mut |cell| {
        match cell.value {
            CellValue::Uncached { formula } if !formula.is_empty() => {
                *missing_cache = true;
                output.push_str(&format!("{}: ={formula} [no cached value]\n", cell.address));
                *cells += 1;
            }
            CellValue::Uncached { .. } => {}
            CellValue::Value { text, .. } => {
                output.push_str(&format!("{}: {text}\n", cell.address));
                *cells += 1;
            }
        }
        if output.len() > MAX_EXTRACTED_BYTES || *cells > MAX_CELLS {
            return Err(error(
                "Excel extracted text exceeds limit; document was not truncated",
            ));
        }
        Ok(())
    })
}
fn scan_worksheet(
    xml: &str,
    shared: &[String],
    formats: &[dates::Format],
    epoch_1904: bool,
    on_cell: &mut dyn FnMut(CellEvent<'_>) -> Result<(), DocumentParseError>,
) -> Result<(), DocumentParseError> {
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
    let (mut row, mut column, mut formula_seen) = (0u32, 0u32, false);
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
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"row" => {
                row = attr(&e, b"r")?.parse().unwrap_or(row.saturating_add(1));
                column = 0;
            }
            Event::Empty(e) if e.local_name().as_ref() == b"c" => {
                // Empty cells still advance positions for cells without `r`.
                match parse_address(&attr(&e, b"r")?) {
                    Some((c, r)) => (column, row) = (c, r),
                    None => column = column.saturating_add(1),
                }
            }
            Event::Empty(e) if e.local_name().as_ref() == b"f" => formula_seen = true,
            Event::Start(e) => match e.local_name().as_ref() {
                b"rPh" => phonetic_depth += 1,
                b"c" => {
                    address = attr(&e, b"r")?;
                    match parse_address(&address) {
                        Some((c, r)) => (column, row) = (c, r),
                        None => column = column.saturating_add(1),
                    }
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
                    formula_seen = false;
                }
                b"v" | b"t" | b"f" => {
                    formula_seen |= e.local_name().as_ref() == b"f";
                    field = String::from_utf8_lossy(e.local_name().as_ref()).into_owned()
                }
                _ => {}
            },
            Event::End(e) => match e.local_name().as_ref() {
                b"rPh" => phonetic_depth = phonetic_depth.saturating_sub(1),
                b"v" | b"t" | b"f" => field.clear(),
                b"c" => {
                    let uncached = kind != "s" && value.is_empty() && formula_seen;
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
                        on_cell(CellEvent {
                            address: &address,
                            row,
                            column,
                            value: CellValue::Uncached { formula: &formula },
                        })?;
                        continue;
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
                    if uncached {
                        on_cell(CellEvent {
                            address: &address,
                            row,
                            column,
                            value: CellValue::Uncached { formula: "" },
                        })?;
                    } else if !value.is_empty() {
                        on_cell(CellEvent {
                            address: &address,
                            row,
                            column,
                            value: CellValue::Value {
                                text: &value,
                                formula: formula_seen,
                            },
                        })?;
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
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
