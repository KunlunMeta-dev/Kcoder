use super::*;
use std::io::Cursor;

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(width, height)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

fn page(number: u32, text: &str) -> PageText {
    PageText {
        number,
        text: text.into(),
    }
}

fn texts(output: &ToolOutput) -> String {
    output
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn image_count(output: &ToolOutput) -> usize {
    output
        .content
        .iter()
        .filter(|block| matches!(block, ContentBlock::Image { .. }))
        .count()
}

const TEXT: &str = "This page has a real text layer with plenty of characters.";

#[test]
fn text_layer_rule_counts_visible_characters_only() {
    assert!(!has_text_layer(""));
    assert!(!has_text_layer(" \n\t\r\n "));
    assert!(!has_text_layer("Scanned with CamScanner\n- 3 -"));
    assert!(!has_text_layer(&"x".repeat(MIN_TEXT_LAYER_CHARS - 1)));
    assert!(!has_text_layer(&"x \u{7}".repeat(MIN_TEXT_LAYER_CHARS - 1)));
    assert!(has_text_layer(&"x".repeat(MIN_TEXT_LAYER_CHARS)));
    assert!(has_text_layer(&"扫".repeat(MIN_TEXT_LAYER_CHARS)));
    assert!(has_text_layer(TEXT));
}

#[test]
fn pages_follow_form_feeds_and_never_exceed_the_requested_range() {
    assert_eq!(
        split_pages("one\x0ctwo\x0c", (3, 6)),
        vec![page(3, "one"), page(4, "two")]
    );
    assert_eq!(split_pages("", (1, 1)), vec![page(1, "")]);
    assert_eq!(
        split_pages("\x0c\x0cthree\x0c", (1, 3)),
        vec![page(1, ""), page(2, ""), page(3, "three")]
    );
    assert_eq!(
        split_pages("a\x0cb\x0cc\x0c", (1, 2)),
        vec![page(1, "a"), page(2, "b\x0cc")]
    );
}

#[test]
fn png_header_dimensions_are_read_without_decoding() {
    assert_eq!(png_dimensions(&png(64, 80)[..24]), Some((64, 80)));
    assert_eq!(png_dimensions(b"GIF89a not a png at all......"), None);
    assert_eq!(png_dimensions(&png(64, 80)[..23]), None);
}

#[test]
fn oversized_pages_are_rerendered_at_a_lower_resolution_or_reported() {
    // A4 at 150 DPI with a typical scan size fits.
    assert_eq!(assess(150, 1240, 1754, 900_000, false), Fit::Accept);
    // Over the pixel limit: retry below the proportional resolution.
    let Fit::Retry(dpi) = assess(150, 5000, 7000, 3_000_000, false) else {
        panic!("expected retry");
    };
    assert!((MIN_RENDER_DPI..150).contains(&dpi));
    assert!(u64::from(5000 * dpi / 150) * u64::from(7000 * dpi / 150) <= MAX_PIXELS);
    // Over the soft byte target but within hard limits: retry, then accept.
    assert!(matches!(
        assess(150, 1240, 1754, 6 * 1024 * 1024, false),
        Fit::Retry(_)
    ));
    assert_eq!(assess(150, 1240, 1754, 6 * 1024 * 1024, true), Fit::Accept);
    // Still over the hard limits at the lowest resolution: explicit reason.
    let Fit::Reject(reason) = assess(MIN_RENDER_DPI, 9000, 9000, 1_000, false) else {
        panic!("expected rejection");
    };
    assert!(reason.contains("9000x9000") && reason.contains("50 DPI"));
    assert!(matches!(assess(150, 0, 10, 10, false), Fit::Reject(_)));
}

#[test]
fn renderer_argv_is_explicit_for_xpdf_and_poppler() {
    let input = Path::new("/private dir/input.pdf");
    let root = Path::new("/private dir/page-2-attempt-1/page");
    let strings = |args: Vec<OsString>| {
        args.into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect::<Vec<_>>()
    };
    let bundled = PdfRenderer {
        kind: RendererKind::Xpdf,
        executable: "/app/bin/pdf/pdftopng".into(),
        configuration_dir: Some("/app/bin/pdf".into()),
    };
    assert_eq!(
        strings(render_args(&bundled, 2, 150, input, root)),
        [
            "-cfg",
            "xpdfrc",
            "-f",
            "2",
            "-l",
            "2",
            "-r",
            "150",
            "-q",
            "/private dir/input.pdf",
            "/private dir/page-2-attempt-1/page"
        ]
    );
    let host_xpdf = PdfRenderer {
        configuration_dir: None,
        ..bundled
    };
    assert_eq!(
        strings(render_args(&host_xpdf, 7, 72, input, root))[..7],
        ["-f", "7", "-l", "7", "-r", "72", "-q"]
    );
    let poppler = PdfRenderer {
        kind: RendererKind::Poppler,
        executable: "/usr/bin/pdftoppm".into(),
        configuration_dir: None,
    };
    assert_eq!(
        strings(render_args(&poppler, 3, 150, input, root)),
        [
            "-png",
            "-f",
            "3",
            "-l",
            "3",
            "-r",
            "150",
            "-singlefile",
            "-q",
            "/private dir/input.pdf",
            "/private dir/page-2-attempt-1/page"
        ]
    );
}

#[test]
fn renderer_lookup_prefers_bundled_then_host_xpdf_then_poppler() {
    let xpdf = command_name("pdftopng");
    let poppler = command_name("pdftoppm");
    let temp = tempfile::tempdir().unwrap();
    let bin = temp.path().join("安装 dir/bin");
    let bundle = bin.join("pdf");
    std::fs::create_dir_all(&bundle).unwrap();
    let current = bin.join("kcoder");
    let host = |names: &'static [&'static str]| {
        move |name: &str| {
            names
                .iter()
                .any(|candidate| command_name(candidate) == name)
                .then(|| PathBuf::from("/host").join(name))
        }
    };
    assert_eq!(locate_renderer(Some(&current), host(&[])).unwrap(), None);
    let found = locate_renderer(Some(&current), host(&["pdftoppm"]))
        .unwrap()
        .unwrap();
    assert_eq!(found.kind, RendererKind::Poppler);
    assert_eq!(found.executable, PathBuf::from("/host").join(&poppler));
    let found = locate_renderer(Some(&current), host(&["pdftoppm", "pdftopng"]))
        .unwrap()
        .unwrap();
    assert_eq!(
        (found.kind, found.configuration_dir),
        (RendererKind::Xpdf, None)
    );
    std::fs::write(bundle.join(&xpdf), b"fixture").unwrap();
    assert!(
        locate_renderer(Some(&current), host(&["pdftoppm"])).is_err(),
        "an incomplete bundle is reported, not hidden by PATH"
    );
    std::fs::write(bundle.join("xpdfrc"), b"textEncoding UTF-8").unwrap();
    std::fs::write(bundle.join(".kcoder-pdf.json"), b"{}").unwrap();
    let found = locate_renderer(Some(&current), host(&["pdftoppm", "pdftopng"]))
        .unwrap()
        .unwrap();
    assert_eq!(found.executable, bundle.join(&xpdf));
    assert_eq!(found.configuration_dir.as_deref(), Some(bundle.as_path()));
}

/// Scripted page renderer for budget and ordering tests.
struct Fake {
    results: std::collections::VecDeque<PageRender>,
    calls: Vec<u32>,
}

#[async_trait::async_trait]
impl RenderPage for Fake {
    async fn render(&mut self, page: u32) -> Result<PageRender, ToolError> {
        self.calls.push(page);
        Ok(self.results.pop_front().expect("scripted result"))
    }
}

fn rendered(bytes: usize) -> PageRender {
    let mut png = png(40, 50);
    png.resize(bytes.max(png.len()), 0);
    PageRender::Rendered(RenderedPage {
        png,
        width: 40,
        height: 50,
        dpi: RENDER_DPI,
    })
}

#[tokio::test]
async fn mixed_pages_keep_order_and_text_pages_stay_text_only() {
    let mut fake = Fake {
        results: [rendered(100), PageRender::Failed("broken page".into())].into(),
        calls: Vec::new(),
    };
    let pages = vec![page(4, TEXT), page(5, "  \n"), page(6, TEXT), page(7, "p7")];
    let output = compose(pages, (4, 8), Ok(&mut fake)).await.unwrap();
    assert!(!output.is_error);
    assert_eq!(fake.calls, [5, 7]);
    assert_eq!(image_count(&output), 1);
    let kinds: Vec<_> = output
        .content
        .iter()
        .map(|block| matches!(block, ContentBlock::Image { .. }))
        .collect();
    assert_eq!(kinds, [false, true, false]);
    let all = texts(&output);
    assert!(all.contains("the document ends at page 7"));
    assert!(all.contains("no OCR engine is used"));
    let order = [
        "--- Page 4 ---",
        "--- Page 5: no text layer; rendered at 150 DPI",
        "--- Page 6 ---",
        "--- Page 7: no text layer; rendering failed: broken page",
    ];
    let positions: Vec<_> = order
        .iter()
        .map(|marker| all.find(marker).unwrap())
        .collect();
    assert!(positions.windows(2).all(|pair| pair[0] < pair[1]), "{all}");
    assert!(all.contains("Text layer fragment on this page: p7"));
}

#[tokio::test]
async fn page_budget_stops_with_an_explicit_continuation() {
    let mut fake = Fake {
        results: (0..MAX_RENDERED_PAGES_PER_CALL)
            .map(|_| rendered(100))
            .collect(),
        calls: Vec::new(),
    };
    let pages = (1..=8).map(|number| page(number, "")).collect();
    let output = compose(pages, (1, 8), Ok(&mut fake)).await.unwrap();
    assert_eq!(image_count(&output), MAX_RENDERED_PAGES_PER_CALL);
    assert_eq!(fake.calls, [1, 2, 3, 4, 5]);
    let all = texts(&output);
    assert!(
        all.contains("Pages 6-8 were not returned; call read again with pages=\"6-8\""),
        "{all}"
    );
    assert!(all.contains("at most 5 rendered pages per call"));
}

#[tokio::test]
async fn byte_and_time_budgets_name_the_next_page() {
    let five_mib = 5 * 1024 * 1024;
    let mut fake = Fake {
        results: [rendered(five_mib), rendered(five_mib), rendered(five_mib)].into(),
        calls: Vec::new(),
    };
    let pages = (1..=3).map(|number| page(number, "")).collect();
    let output = compose(pages, (1, 3), Ok(&mut fake)).await.unwrap();
    assert_eq!(image_count(&output), 2);
    let all = texts(&output);
    assert!(
        all.contains("pages=\"3\"") && all.contains("12 MiB"),
        "{all}"
    );

    let mut fake = Fake {
        results: [rendered(100), PageRender::OutOfTime].into(),
        calls: Vec::new(),
    };
    let pages = vec![page(1, ""), page(2, TEXT), page(3, ""), page(4, TEXT)];
    let output = compose(pages, (1, 4), Ok(&mut fake)).await.unwrap();
    let all = texts(&output);
    assert!(
        all.contains("pages=\"3-4\"") && all.contains("60 seconds"),
        "{all}"
    );
    assert!(all.contains("--- Page 2 ---") && !all.contains("--- Page 4 ---"));
}

#[tokio::test]
async fn missing_renderer_keeps_text_and_names_what_is_missing() {
    let pages = vec![page(1, TEXT), page(2, "")];
    let output = compose(pages, (1, 2), Err(MISSING_RENDERER.into()))
        .await
        .unwrap();
    assert!(!output.is_error);
    assert_eq!(image_count(&output), 0);
    let all = texts(&output);
    assert!(all.contains(TEXT));
    assert!(all.contains(
        "--- Page 2: no text layer; page rendering is unavailable on this host (no bundled pdftopng next to pdftotext, and neither Xpdf pdftopng nor Poppler pdftoppm was found on PATH)"
    ));
}

#[cfg(unix)]
mod process {
    use super::*;

    fn helper(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        // Never hold a writable descriptor in this process: a concurrent fork
        // would inherit it and the later exec would fail with ETXTBSY.
        crate::test_executable::write_executable(&path, format!("#!/bin/sh\n{body}\n"), 0o700);
        path
    }

    fn renderer(kind: RendererKind, executable: PathBuf) -> PdfRenderer {
        PdfRenderer {
            kind,
            executable,
            configuration_dir: None,
        }
    }

    fn quoted(path: &Path) -> String {
        format!("'{}'", path.display())
    }

    #[tokio::test]
    async fn poppler_output_is_returned_and_owned_directories_are_removed() {
        let temp = tempfile::tempdir().unwrap();
        let fixture = temp.path().join("fixture.png");
        std::fs::write(&fixture, png(64, 80)).unwrap();
        let record = temp.path().join("argv");
        let executable = helper(
            temp.path(),
            "pdftoppm",
            &format!(
                "printf '%s\\n' \"$@\" > {}\nfor last; do :; done\n/bin/cp {} \"$last.png\"",
                quoted(&record),
                quoted(&fixture)
            ),
        );
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
        let mut process = ProcessRenderer::new(
            renderer(RendererKind::Poppler, executable),
            Arc::new(b"%PDF-1.4 fixture".to_vec()),
            &ctx,
        );
        let PageRender::Rendered(image) = process.render(2).await.unwrap() else {
            panic!("expected a rendered page");
        };
        assert_eq!((image.width, image.height, image.dpi), (64, 80, 150));
        let argv: Vec<String> = std::fs::read_to_string(&record)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(
            argv[..9],
            [
                "-png",
                "-f",
                "2",
                "-l",
                "2",
                "-r",
                "150",
                "-singlefile",
                "-q"
            ]
        );
        let input = PathBuf::from(&argv[9]);
        assert!(input.ends_with("input.pdf"));
        let output_dir = PathBuf::from(&argv[10]).parent().unwrap().to_path_buf();
        assert!(
            !output_dir.exists(),
            "attempt output must be removed after collection"
        );
        let staging = input.parent().unwrap().to_path_buf();
        assert!(staging.exists());
        drop(process);
        assert!(
            !staging.exists(),
            "the call-owned staging directory is removed"
        );
    }

    #[tokio::test]
    async fn xpdf_oversized_output_is_rerendered_at_lower_resolution() {
        let temp = tempfile::tempdir().unwrap();
        let small = temp.path().join("small.png");
        std::fs::write(&small, png(30, 40)).unwrap();
        // Header-only PNG over the pixel limit; never decoded.
        let mut huge = png(1, 1)[..24].to_vec();
        huge[16..20].copy_from_slice(&5000_u32.to_be_bytes());
        huge[20..24].copy_from_slice(&7000_u32.to_be_bytes());
        let big = temp.path().join("big.png");
        std::fs::write(&big, huge).unwrap();
        let executable = helper(
            temp.path(),
            "pdftopng",
            &format!(
                "dpi=150; prev=; for arg; do [ \"$prev\" = -r ] && dpi=$arg; prev=$arg; done\nfor last; do :; done\nif [ \"$dpi\" = 150 ]; then /bin/cp {} \"$last-000003.png\"; else /bin/cp {} \"$last-000003.png\"; fi",
                quoted(&big),
                quoted(&small)
            ),
        );
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
        let mut process = ProcessRenderer::new(
            renderer(RendererKind::Xpdf, executable),
            Arc::new(b"%PDF-1.4 fixture".to_vec()),
            &ctx,
        );
        let PageRender::Rendered(image) = process.render(3).await.unwrap() else {
            panic!("expected a rendered page");
        };
        assert_eq!((image.width, image.height), (30, 40));
        assert!((MIN_RENDER_DPI..RENDER_DPI).contains(&image.dpi));
        assert_eq!(process.attempts, 2);
    }

    #[tokio::test]
    async fn renderer_failure_is_reported_for_the_page_after_one_retry() {
        let temp = tempfile::tempdir().unwrap();
        let executable = helper(temp.path(), "pdftoppm", "exit 3");
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
        let mut process = ProcessRenderer::new(
            renderer(RendererKind::Poppler, executable),
            Arc::new(b"%PDF-1.4 fixture".to_vec()),
            &ctx,
        );
        let PageRender::Failed(reason) = process.render(1).await.unwrap() else {
            panic!("expected failure");
        };
        assert!(reason.contains("72 DPI"), "{reason}");
        assert_eq!(process.attempts, 2);

        let mut missing = ProcessRenderer::new(
            renderer(RendererKind::Poppler, temp.path().join("absent-pdftoppm")),
            Arc::new(b"%PDF-1.4 fixture".to_vec()),
            &ctx,
        );
        let PageRender::Failed(reason) = missing.render(1).await.unwrap() else {
            panic!("expected failure");
        };
        assert!(
            reason.contains("cannot start the page renderer absent-pdftoppm"),
            "{reason}"
        );
        assert_eq!(missing.attempts, 1);
    }

    #[tokio::test]
    async fn time_budget_and_cancellation_reap_the_renderer() {
        let temp = tempfile::tempdir().unwrap();
        let executable = helper(temp.path(), "pdftoppm", "exec /bin/sleep 10");
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
        let mut process = ProcessRenderer::new(
            renderer(RendererKind::Poppler, executable.clone()),
            Arc::new(b"%PDF-1.4 fixture".to_vec()),
            &ctx,
        );
        process.deadline = Instant::now() + Duration::from_millis(200);
        let started = Instant::now();
        assert!(matches!(
            process.render(1).await.unwrap(),
            PageRender::OutOfTime
        ));
        assert!(started.elapsed() < Duration::from_secs(5));

        let token = tokio_util::sync::CancellationToken::new();
        let ctx = ctx.with_abort_token(token.clone());
        let mut process = ProcessRenderer::new(
            renderer(RendererKind::Poppler, executable),
            Arc::new(b"%PDF-1.4 fixture".to_vec()),
            &ctx,
        );
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            token.cancel();
        };
        let started = Instant::now();
        let (result, _) = tokio::join!(process.render(1), cancel);
        assert!(matches!(result, Err(ToolError::Aborted)));
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}

/// Two pages: a Helvetica text page and a page whose only content is an
/// image XObject, i.e. a scanned page without a text layer.
fn mixed_pdf() -> Vec<u8> {
    let text =
        "BT /F1 12 Tf 20 150 Td (KCoder PDF fixture: this page has a real text layer.) Tj ET";
    let draw = "q 300 0 0 300 0 0 cm /Im1 Do Q";
    let pixels = "00FFFF00>";
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".into(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into(),
        format!("<< /Length {} >>\nstream\n{text}\nendstream", text.len()),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Im1 7 0 R >> >> /Contents 8 0 R >>".into(),
        format!("<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length {} >>\nstream\n{pixels}\nendstream", pixels.len()),
        format!("<< /Length {} >>\nstream\n{draw}\nendstream", draw.len()),
    ];
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
    pdf.into_bytes()
}

#[tokio::test]
async fn real_host_renderer_returns_scanned_page_as_image() {
    use crate::Tool;
    if which::which(command_name("pdftotext")).is_err() {
        eprintln!("NOT RUN: pdftotext unavailable");
        return;
    }
    if !matches!(find_renderer(), Ok(Some(_))) {
        eprintln!("NOT RUN: renderer unavailable (pdftopng/pdftoppm)");
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("mixed scan.pdf");
    std::fs::write(&path, mixed_pdf()).unwrap();
    let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
    let output = crate::file::FileReadTool
        .call(serde_json::json!({"file_path": path, "pages": "1-2"}), &ctx)
        .await
        .unwrap();
    assert!(!output.is_error, "{}", texts(&output));
    let all = texts(&output);
    assert!(
        all.contains("--- Page 1 ---") && all.contains("KCoder PDF fixture"),
        "{all}"
    );
    assert!(
        all.contains("--- Page 2: no text layer; rendered at 150 DPI"),
        "{all}"
    );
    assert_eq!(image_count(&output), 1);
    let Some(ContentBlock::Image { source }) = output
        .content
        .iter()
        .find(|block| matches!(block, ContentBlock::Image { .. }))
    else {
        unreachable!()
    };
    assert_eq!(source.media_type, MEDIA_TYPE);
    let data = BASE64_STANDARD.decode(&source.data).unwrap();
    let info = crate::image_input::inspect(&data, MEDIA_TYPE).unwrap();
    // 300 pt at 150 DPI is 625 pixels; renderers may round by one.
    assert!(info.width.abs_diff(625) <= 1 && info.height.abs_diff(625) <= 1);
}
