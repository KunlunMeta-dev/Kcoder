use super::super::FileReadTool;
use super::MAX_OFFICE_SOURCE_BYTES;
use crate::{Tool, ToolContext, ToolError};
use serde_json::{Value, json};
use std::io::Write;
use std::path::Path;

const W: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""#;
const P: &str = r#"xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main""#;

fn package(entries: &[(&str, String)]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, body) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn paragraph(text: &str) -> String {
    format!("<w:p><w:r><w:t>{text}</w:t></w:r></w:p>")
}

fn cell(paragraphs: &[&str]) -> String {
    let body: String = paragraphs.iter().map(|text| paragraph(text)).collect();
    format!("<w:tc>{body}</w:tc>")
}

fn docx(body: &str) -> Vec<u8> {
    package(&[(
        "word/document.xml",
        format!("<w:document {W}><w:body>{body}</w:body></w:document>"),
    )])
}

fn shape(placeholder: &str, text: &str) -> String {
    format!(
        r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>{placeholder}</p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>"#
    )
}

fn workbook(sheets: &[(&str, &str, String)], shared: &str) -> Vec<u8> {
    let rels: String = (1..=sheets.len())
        .map(|i| format!("<Relationship Id='r{i}' Target='worksheets/sheet{i}.xml'/>"))
        .collect();
    let entries: String = sheets
        .iter()
        .enumerate()
        .map(|(i, (name, state, _))| {
            format!(
                "<sheet name='{name}' sheetId='{}' {state} r:id='r{}'/>",
                i + 1,
                i + 1
            )
        })
        .collect();
    let mut parts = vec![
        (
            "xl/_rels/workbook.xml.rels",
            format!("<Relationships>{rels}</Relationships>"),
        ),
        (
            "xl/workbook.xml",
            format!("<workbook xmlns:r='r'><sheets>{entries}</sheets></workbook>"),
        ),
        ("xl/sharedStrings.xml", format!("<sst>{shared}</sst>")),
    ];
    let names: Vec<String> = (1..=sheets.len())
        .map(|i| format!("xl/worksheets/sheet{i}.xml"))
        .collect();
    for (name, (_, _, xml)) in names.iter().zip(sheets) {
        parts.push((name.as_str(), xml.clone()));
    }
    package(&parts)
}

fn context(root: &Path) -> ToolContext {
    ToolContext::new(kcoder_state::AppState::new(root.to_path_buf()))
}

async fn read(ctx: &ToolContext, input: Value) -> (bool, String) {
    let output = FileReadTool.call(input, ctx).await.unwrap();
    let text = output
        .content
        .iter()
        .filter_map(|block| match block {
            kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    (output.is_error, text)
}

#[tokio::test]
async fn docx_paragraphs_and_tables_follow_reading_order() {
    let root = tempfile::tempdir().unwrap();
    let table = format!(
        "<w:tbl><w:tr>{}{}</w:tr><w:tr>{}{}</w:tr></w:tbl>",
        cell(&["Name"]),
        cell(&["Value"]),
        cell(&["Alpha"]),
        cell(&["1", "a|b"])
    );
    let body = format!(
        "{}<w:p><w:del><w:r><w:t>Deleted</w:t></w:r></w:del></w:p>{table}{}",
        paragraph("Intro paragraph"),
        paragraph("Closing paragraph")
    );
    std::fs::write(root.path().join("contract.docx"), docx(&body)).unwrap();
    let ctx = context(root.path());
    let (error, text) = read(&ctx, json!({"file_path":"contract.docx"})).await;
    assert!(!error, "{text}");
    assert!(text.contains("Word document:"), "{text}");
    assert!(text.contains("Showing lines 1-"), "{text}");
    let intro = text.find("Intro paragraph").unwrap();
    let header = text.find("| Name | Value |").unwrap();
    let row = text.find("| Alpha | 1<br>a\\|b |").unwrap();
    let closing = text.find("Closing paragraph").unwrap();
    assert!(intro < header && header < row && row < closing, "{text}");
    assert!(text.contains("| --- | --- |"));
    assert!(!text.contains("Deleted"));
    assert!(!text.contains("[Continuation"));
}

#[tokio::test]
async fn xlsx_reports_sheets_ranges_cached_and_uncalculated_formulas() {
    let root = tempfile::tempdir().unwrap();
    let revenue = r#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>100</v></c><c r="C1"><f>1+2</f><v>3</v></c><c r="D1"><f>SUM(B1:C1)</f></c></row><row r="2"><c r="C2"><f t="shared" ref="C2:C3" si="0">B2*2</f><v>8</v></c></row><row r="3"><c r="C3"><f t="shared" si="0"/></c></row><row r="4"><c t="inlineStr"><is><t>No ref</t></is></c><c t="inlineStr"><is><t>Line1
Line2</t></is></c></row></sheetData></worksheet>"#;
    let costs =
        r#"<worksheet><sheetData><row r="1"><c r="A1"><v>5</v></c></row></sheetData></worksheet>"#;
    let bytes = workbook(
        &[
            ("Revenue", "", revenue.into()),
            ("Costs", "state='hidden'", costs.into()),
        ],
        "<si><t>Item</t></si>",
    );
    std::fs::write(root.path().join("book.xlsx"), &bytes).unwrap();
    let ctx = context(root.path());
    let (error, text) = read(&ctx, json!({"file_path":"book.xlsx"})).await;
    assert!(!error, "{text}");
    for expected in [
        "## Sheet 1: Revenue",
        "Used range A1:D4; 8 non-empty cell(s)",
        "A1: Item | B1: 100 | C1: 3 | D1: =SUM(B1:C1) [no cached value]",
        "C2: 8",
        "C3: [shared formula; no cached value]",
        "A4: No ref | B4: Line1\\nLine2",
        "## Sheet 2: Costs (hidden)",
        "Workbook has 4 formula cell(s); shown values are the cached results",
        "2 formula cell(s) have no cached value (uncalculated)",
    ] {
        assert!(text.contains(expected), "missing {expected:?} in {text}");
    }
    // Wiki keeps its historical rendering for the same workbook.
    let (wiki, _, _, missing) = kcoder_document_parsers::extract_xlsx(&bytes).unwrap();
    assert!(missing);
    assert!(wiki.contains("\nSheet: Revenue\nA1: Item\nB1: 100\nC1: 3\nD1: =SUM(B1:C1) [no cached value]\nC2: 8\n: No ref\n"));
}

#[tokio::test]
async fn pptx_reads_titles_text_tables_and_notes_per_slide() {
    let root = tempfile::tempdir().unwrap();
    let slide1 = format!(
        "<p:sld {P}><p:cSld><p:spTree>{}{}{}</p:spTree></p:cSld></p:sld>",
        shape(r#"<p:ph type="title"/>"#, "Quarterly review"),
        shape(r#"<p:ph idx="1"/>"#, "Revenue grew"),
        shape(r#"<p:ph type="sldNum"/>"#, "SLIDE-NUMBER")
    );
    let notes = format!(
        "<p:notes {P}><p:cSld><p:spTree>{}{}</p:spTree></p:cSld></p:notes>",
        shape(r#"<p:ph type="body" idx="1"/>"#, "Mention churn"),
        shape(r#"<p:ph type="sldNum"/>"#, "NOTES-NUMBER")
    );
    let tc = |text: &str| {
        format!("<a:tc><a:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></a:txBody></a:tc>")
    };
    let slide2 = format!(
        r#"<p:sld show="0" {P}><p:cSld><p:spTree><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr>{}{}</a:tr><a:tr>{}{}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>"#,
        tc("Q1"),
        tc("Q2"),
        tc("10"),
        tc("20")
    );
    let bytes = package(&[
        ("ppt/_rels/presentation.xml.rels", "<Relationships><Relationship Id='a' Target='slides/slide1.xml'/><Relationship Id='b' Target='slides/slide2.xml'/><Relationship Id='c' Target='slides/slide3.xml'/></Relationships>".into()),
        ("ppt/presentation.xml", "<p:presentation xmlns:p='p' xmlns:r='r'><p:sldIdLst><p:sldId id='1' r:id='a'/><p:sldId id='2' r:id='b'/><p:sldId id='3' r:id='c'/></p:sldIdLst></p:presentation>".into()),
        ("ppt/slides/slide1.xml", slide1),
        ("ppt/slides/_rels/slide1.xml.rels", "<Relationships><Relationship Id='n' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide' Target='../notesSlides/notesSlide1.xml'/></Relationships>".into()),
        ("ppt/notesSlides/notesSlide1.xml", notes),
        ("ppt/slides/slide2.xml", slide2),
        ("ppt/slides/slide3.xml", format!("<p:sld {P}><p:cSld><p:spTree/></p:cSld></p:sld>")),
    ]);
    std::fs::write(root.path().join("deck.pptx"), bytes).unwrap();
    let ctx = context(root.path());
    let (error, text) = read(&ctx, json!({"file_path":"deck.pptx"})).await;
    assert!(!error, "{text}");
    let order = [
        "## Slide 1: Quarterly review",
        "Revenue grew",
        "Speaker notes:",
        "Mention churn",
        "## Slide 2 (hidden)",
        "| Q1 | Q2 |",
        "| --- | --- |",
        "| 10 | 20 |",
        "## Slide 3",
        "(no text on this slide",
    ];
    let mut last = 0;
    for expected in order {
        let found = text[last..]
            .find(expected)
            .unwrap_or_else(|| panic!("missing {expected:?} after {last} in {text}"));
        last += found;
    }
    assert!(!text.contains("SLIDE-NUMBER") && !text.contains("NOTES-NUMBER"));
    // The slide title appears once, in the heading.
    assert_eq!(text.matches("Quarterly review").count(), 1);
}

#[tokio::test]
async fn offset_and_limit_continue_large_documents_without_silent_truncation() {
    let root = tempfile::tempdir().unwrap();
    let body: String = (1..=30)
        .map(|i| paragraph(&format!("Paragraph {i}")))
        .collect();
    std::fs::write(root.path().join("long.docx"), docx(&body)).unwrap();
    let ctx = context(root.path());
    let (_, first) = read(&ctx, json!({"file_path":"long.docx","limit":10})).await;
    assert!(first.contains("Showing lines 1-10 of 30."), "{first}");
    assert!(first.contains("Paragraph 10") && !first.contains("Paragraph 11"));
    assert!(first.contains("[Continuation: lines 11-30 were not shown. Call read with the same file_path and offset=11 to continue.]"), "{first}");
    let (_, rest) = read(&ctx, json!({"file_path":"long.docx","offset":11})).await;
    assert!(rest.contains("Showing lines 11-30 of 30."), "{rest}");
    assert!(rest.contains("    11\tParagraph 11") && rest.contains("Paragraph 30"));
    assert!(!rest.contains("[Continuation"));
    let (_, beyond) = read(&ctx, json!({"file_path":"long.docx","offset":99})).await;
    assert!(beyond.contains("shorter than the provided offset (99). It has 30 lines."));

    // A small output budget stops at a line boundary and says how to continue.
    let mut small = context(root.path());
    small.max_output_bytes = 1200;
    let body: String = (1..=200)
        .map(|i| paragraph(&format!("Budget line {i} {}", "x".repeat(40))))
        .collect();
    std::fs::write(root.path().join("budget.docx"), docx(&body)).unwrap();
    let (_, page) = read(&small, json!({"file_path":"budget.docx"})).await;
    assert!(page.len() <= 1200, "{}", page.len());
    assert!(
        page.contains("(stopped at the tool output size budget)"),
        "{page}"
    );
    let next = page
        .rsplit_once("offset=")
        .and_then(|(_, tail)| tail.split(' ').next())
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap();
    assert!(page.contains(&format!("Budget line {} ", next - 1)));
    assert!(!page.contains(&format!("Budget line {next} ")));
    let (_, following) = read(&small, json!({"file_path":"budget.docx","offset":next})).await;
    assert!(
        following.contains(&format!("Budget line {next} ")),
        "{following}"
    );

    // Partial workbook reads list sheet start lines for jumping.
    let sheet = |v: u32| {
        let rows: String = (1..=5)
            .map(|r| format!("<row r='{r}'><c r='A{r}'><v>{v}</v></c></row>"))
            .collect();
        format!("<worksheet><sheetData>{rows}</sheetData></worksheet>")
    };
    let bytes = workbook(
        &[
            ("S1", "", sheet(1)),
            ("S2", "", sheet(2)),
            ("S3", "", sheet(3)),
        ],
        "",
    );
    std::fs::write(root.path().join("multi.xlsx"), bytes).unwrap();
    let (_, part) = read(&ctx, json!({"file_path":"multi.xlsx","limit":4})).await;
    assert!(
        part.contains("Sections (start line): Sheet 1: S1 L1; Sheet 2: S2 L9; Sheet 3: S3 L17"),
        "{part}"
    );
    let (_, jumped) = read(&ctx, json!({"file_path":"multi.xlsx","offset":17})).await;
    assert!(jumped.contains("    17\t## Sheet 3: S3"), "{jumped}");
}

#[tokio::test]
async fn oversized_bomb_corrupt_encrypted_and_legacy_files_fail_clearly() {
    let root = tempfile::tempdir().unwrap();
    let ctx = context(root.path());

    std::fs::File::create(root.path().join("huge.xlsx"))
        .unwrap()
        .set_len(MAX_OFFICE_SOURCE_BYTES + 1)
        .unwrap();
    let (error, text) = read(&ctx, json!({"file_path":"huge.xlsx"})).await;
    assert!(
        error && text.contains("over the 32 MiB Office extraction limit"),
        "{text}"
    );

    let bomb = docx(&paragraph(&"a".repeat(4 * 1024 * 1024)));
    assert!(bomb.len() < 64 * 1024);
    std::fs::write(root.path().join("bomb.docx"), bomb).unwrap();
    let (error, text) = read(&ctx, json!({"file_path":"bomb.docx"})).await;
    assert!(error && text.contains("compression ratio limit"), "{text}");

    std::fs::write(
        root.path().join("corrupt.pptx"),
        b"PK\x03\x04 not really a zip",
    )
    .unwrap();
    let (error, text) = read(&ctx, json!({"file_path":"corrupt.pptx"})).await;
    assert!(
        error && text.contains("Invalid or encrypted PowerPoint"),
        "{text}"
    );

    let mut truncated = docx(&paragraph("cut"));
    truncated.truncate(truncated.len() / 2);
    std::fs::write(root.path().join("truncated.docx"), truncated).unwrap();
    let (error, text) = read(&ctx, json!({"file_path":"truncated.docx"})).await;
    assert!(error && text.contains("Cannot extract text"), "{text}");

    let mut ole = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    ole.extend([0u8; 512]);
    std::fs::write(root.path().join("locked.xlsx"), ole).unwrap();
    let (error, text) = read(&ctx, json!({"file_path":"locked.xlsx"})).await;
    assert!(
        error && text.contains("password-protected (encrypted)"),
        "{text}"
    );

    std::fs::write(root.path().join("old.doc"), [0xD0, 0xCF, 0x11, 0xE0]).unwrap();
    let (error, text) = read(&ctx, json!({"file_path":"old.doc"})).await;
    assert!(error, "{text}");
    assert!(text.contains("legacy Word 97-2003 .doc") && text.contains("--convert-to docx"));
    for (name, expected) in [
        ("old.xls", "--convert-to xlsx"),
        ("old.ppt", "--convert-to pptx"),
        ("doc.odt", "--convert-to docx"),
    ] {
        std::fs::write(root.path().join(name), [0u8; 4]).unwrap();
        let (error, text) = read(&ctx, json!({"file_path":name})).await;
        assert!(error && text.contains(expected), "{name}: {text}");
    }

    std::fs::write(root.path().join("ok.docx"), docx(&paragraph("ok"))).unwrap();
    for input in [
        json!({"file_path":"ok.docx","format":"raw"}),
        json!({"file_path":"ok.docx","pages":"1-2"}),
        json!({"file_path":"ok.docx","encoding":"gbk"}),
        json!({"file_path":"ok.docx","limit":0}),
    ] {
        let result = FileReadTool.call(input.clone(), &ctx).await;
        assert!(
            matches!(result, Err(ToolError::InvalidInput(_))),
            "{input}: {result:?}"
        );
    }
}
