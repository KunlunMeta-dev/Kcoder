//! Page rendering for PDF pages without a meaningful text layer.
//!
//! Pages are rendered by Xpdf `pdftopng` (bundled next to `pdftotext`, or on
//! PATH) or Poppler `pdftoppm` into a private directory owned by one `read`
//! call, then returned as PNG image blocks for the model's native vision. No
//! OCR engine runs here and this module sends nothing anywhere.
use super::{bundled_pdf_runtime, confine_helper};
use crate::image_input::{MAX_BYTES, MAX_EDGE, MAX_PIXELS};
use crate::{ToolContext, ToolError, ToolOutput};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use kcoder_types::{ContentBlock, ImageSource};
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A page whose extracted text has fewer non-whitespace, non-control
/// characters than this has no meaningful text layer and is rendered.
pub(super) const MIN_TEXT_LAYER_CHARS: usize = 32;
/// First rendering resolution: A4 is 1240x1754 and Letter 1275x1650 pixels.
pub(super) const RENDER_DPI: u32 = 150;
/// Lowest resolution used when a page must be scaled down to fit the limits.
pub(super) const MIN_RENDER_DPI: u32 = 50;
/// Resolution for the single retry after a renderer failure (e.g. memory).
const FAILURE_RETRY_DPI: u32 = 72;
/// Soft per-page target that keeps one image within common provider
/// per-image limits; the hard limits are the shared `read` image limits.
pub(super) const PAGE_IMAGE_TARGET_BYTES: u64 = 4 * 1024 * 1024;
/// Per-call image budget. Remaining pages are named in a continuation note.
pub(super) const MAX_RENDERED_PAGES_PER_CALL: usize = 5;
pub(super) const MAX_RENDERED_BYTES_PER_CALL: usize = 12 * 1024 * 1024;
pub(super) const RENDER_CALL_BUDGET: Duration = Duration::from_secs(60);
const MAX_RENDER_ATTEMPTS: usize = 3;
const RENDER_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(20);
/// RLIMIT_FSIZE for the renderer: bounds disk use of one output file.
const RENDER_OUTPUT_FILE_LIMIT: u64 = 64 * 1024 * 1024;
const STAGING_TIMEOUT: Duration = Duration::from_secs(20);
const MEDIA_TYPE: &str = "image/png";
pub(super) const MISSING_RENDERER: &str = "no bundled pdftopng next to pdftotext, and neither Xpdf pdftopng nor Poppler pdftoppm was found on PATH";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PageText {
    pub number: u32,
    pub text: String,
}

/// The no-text-layer rule: at least `MIN_TEXT_LAYER_CHARS` visible characters.
pub(super) fn has_text_layer(text: &str) -> bool {
    text.chars()
        .filter(|c| !c.is_whitespace() && !c.is_control())
        .take(MIN_TEXT_LAYER_CHARS)
        .count()
        >= MIN_TEXT_LAYER_CHARS
}

/// Split pdftotext output on its form-feed page terminators. The page count
/// is what the extractor produced, never more than the requested range.
pub(super) fn split_pages(text: &str, (first, last): (u32, u32)) -> Vec<PageText> {
    let requested = (last - first + 1) as usize;
    let mut segments: Vec<&str> = text.split('\x0c').collect();
    if segments.len() > 1 && segments.last().is_some_and(|tail| tail.trim().is_empty()) {
        segments.pop();
    }
    let mut pages: Vec<PageText> = segments
        .iter()
        .take(requested)
        .enumerate()
        .map(|(index, text)| PageText {
            number: first + index as u32,
            text: (*text).to_owned(),
        })
        .collect();
    if segments.len() > requested
        && let Some(page) = pages.last_mut()
    {
        // A stray form feed inside page text must not invent extra pages.
        for extra in &segments[requested..] {
            page.text.push('\x0c');
            page.text.push_str(extra);
        }
    }
    pages
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RendererKind {
    /// Xpdf `pdftopng`: `<root>-NNNNNN.png`, needs a seekable input file.
    Xpdf,
    /// Poppler `pdftoppm -png -singlefile`: `<root>.png`.
    Poppler,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PdfRenderer {
    pub kind: RendererKind,
    pub executable: PathBuf,
    /// Bundled Xpdf resource directory (cwd plus `-cfg xpdfrc`).
    pub configuration_dir: Option<PathBuf>,
}

fn command_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_owned()
    }
}

/// Lookup order: bundled pdftopng, host pdftopng (Xpdf), host pdftoppm (Poppler).
pub(super) fn locate_renderer(
    current_exe: Option<&Path>,
    lookup: impl Fn(&str) -> Option<PathBuf>,
) -> Result<Option<PdfRenderer>, String> {
    let xpdf = command_name("pdftopng");
    if let Some(current_exe) = current_exe
        && let Some(runtime) = bundled_pdf_runtime(current_exe, &xpdf)?
    {
        return Ok(Some(PdfRenderer {
            kind: RendererKind::Xpdf,
            executable: runtime.executable,
            configuration_dir: runtime.configuration_dir,
        }));
    }
    if let Some(executable) = lookup(&xpdf) {
        return Ok(Some(PdfRenderer {
            kind: RendererKind::Xpdf,
            executable,
            configuration_dir: None,
        }));
    }
    Ok(
        lookup(&command_name("pdftoppm")).map(|executable| PdfRenderer {
            kind: RendererKind::Poppler,
            executable,
            configuration_dir: None,
        }),
    )
}

fn find_renderer() -> Result<Option<PdfRenderer>, String> {
    locate_renderer(std::env::current_exe().ok().as_deref(), |name| {
        which::which(name).ok()
    })
}

/// Argument vector for rendering exactly one page. Paths are separate argv
/// entries; no shell is involved.
pub(super) fn render_args(
    renderer: &PdfRenderer,
    page: u32,
    dpi: u32,
    input: &Path,
    output_root: &Path,
) -> Vec<OsString> {
    let page = page.to_string();
    let dpi = dpi.to_string();
    let mut args: Vec<OsString> = Vec::new();
    match renderer.kind {
        RendererKind::Xpdf if renderer.configuration_dir.is_some() => {
            args.extend(["-cfg", "xpdfrc"].map(OsString::from));
        }
        RendererKind::Xpdf => {}
        RendererKind::Poppler => args.push("-png".into()),
    }
    args.extend(["-f", &page, "-l", &page, "-r", &dpi].map(OsString::from));
    if renderer.kind == RendererKind::Poppler {
        args.push("-singlefile".into());
    }
    args.push("-q".into());
    args.push(input.as_os_str().to_owned());
    args.push(output_root.as_os_str().to_owned());
    args
}

/// Width and height from a PNG signature plus IHDR chunk (first 24 bytes).
pub(super) fn png_dimensions(header: &[u8]) -> Option<(u32, u32)> {
    if header.len() < 24 || &header[..8] != b"\x89PNG\r\n\x1a\n" || &header[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(header[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(header[20..24].try_into().ok()?);
    Some((width, height))
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Fit {
    Accept,
    Retry(u32),
    Reject(String),
}

/// Decide whether a rendered page is usable, should be re-rendered at a
/// lower resolution, or cannot fit the shared image limits at all.
pub(super) fn assess(dpi: u32, width: u32, height: u32, bytes: u64, final_attempt: bool) -> Fit {
    if width == 0 || height == 0 || bytes == 0 {
        return Fit::Reject("the renderer produced an empty image".into());
    }
    let pixels = u64::from(width) * u64::from(height);
    let edge = width.max(height);
    let within_limits = edge <= MAX_EDGE && pixels <= MAX_PIXELS && bytes <= MAX_BYTES as u64;
    if within_limits && bytes <= PAGE_IMAGE_TARGET_BYTES {
        return Fit::Accept;
    }
    let mut scale = 1.0_f64;
    if edge > MAX_EDGE {
        scale = scale.min(f64::from(MAX_EDGE) / f64::from(edge));
    }
    if pixels > MAX_PIXELS {
        scale = scale.min((MAX_PIXELS as f64 / pixels as f64).sqrt());
    }
    if bytes > PAGE_IMAGE_TARGET_BYTES {
        scale = scale.min((PAGE_IMAGE_TARGET_BYTES as f64 / bytes as f64).sqrt());
    }
    // Ten percent headroom: PNG size does not scale exactly with area.
    let next = ((f64::from(dpi) * scale * 0.9).floor() as u32).max(MIN_RENDER_DPI);
    if !final_attempt && next < dpi {
        return Fit::Retry(next);
    }
    if within_limits {
        return Fit::Accept;
    }
    Fit::Reject(format!(
        "at {dpi} DPI the page is {width}x{height} pixels and {bytes} bytes, beyond the image limits ({MAX_EDGE} pixels per edge, {MAX_PIXELS} total pixels, {MAX_BYTES} bytes) even at the lowest rendering resolution"
    ))
}

pub(super) struct RenderedPage {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
}

pub(super) enum PageRender {
    Rendered(RenderedPage),
    Failed(String),
    /// The per-call rendering time budget ran out before this page finished.
    OutOfTime,
}

#[async_trait::async_trait]
pub(super) trait RenderPage: Send {
    async fn render(&mut self, page: u32) -> Result<PageRender, ToolError>;
}

fn page_range(first: u32, last: u32) -> String {
    if first == last {
        first.to_string()
    } else {
        format!("{first}-{last}")
    }
}

fn append_fragment(text: &mut String, page: &PageText) {
    let fragment = page.text.trim();
    if !fragment.is_empty() {
        text.push_str("\nText layer fragment on this page: ");
        text.push_str(fragment);
    }
}

/// Build the mixed output. `renderer` is `Err(reason)` when no renderer is
/// available; pages without a text layer are then reported, never dropped.
pub(super) async fn compose(
    pages: Vec<PageText>,
    (first, last): (u32, u32),
    renderer: Result<&mut dyn RenderPage, String>,
) -> Result<ToolOutput, ToolError> {
    let present_last = pages.last().map_or(first, |page| page.number);
    let ended = if present_last < last {
        format!("; the document ends at page {present_last}")
    } else {
        String::new()
    };
    let mut text = format!(
        "[PDF read, requested pages {first}-{last}{ended}. Pages with a text layer are extracted text, not OCR or a screenshot. Pages without a text layer (fewer than {MIN_TEXT_LAYER_CHARS} non-whitespace characters) are rendered to PNG images for the model's native vision; no OCR engine is used, and a model without image input cannot read them.]"
    );
    let mut content = Vec::new();
    let (mut images, mut image_bytes) = (0usize, 0usize);
    let mut stop = None;
    let mut renderer = renderer;
    for page in &pages {
        if has_text_layer(&page.text) {
            text.push_str(&format!(
                "\n--- Page {} ---\n{}",
                page.number,
                page.text.trim_end()
            ));
            continue;
        }
        let render = match &mut renderer {
            Ok(render) => render,
            Err(reason) => {
                text.push_str(&format!(
                    "\n--- Page {}: no text layer; page rendering is unavailable on this host ({reason}). The page content was not read. ---",
                    page.number
                ));
                append_fragment(&mut text, page);
                continue;
            }
        };
        if images >= MAX_RENDERED_PAGES_PER_CALL {
            stop = Some((
                page.number,
                format!("at most {MAX_RENDERED_PAGES_PER_CALL} rendered pages per call"),
            ));
            break;
        }
        match render.render(page.number).await? {
            PageRender::OutOfTime => {
                stop = Some((
                    page.number,
                    format!(
                        "at most {} seconds of page rendering per call",
                        RENDER_CALL_BUDGET.as_secs()
                    ),
                ));
                break;
            }
            PageRender::Failed(reason) => {
                text.push_str(&format!(
                    "\n--- Page {}: no text layer; rendering failed: {reason}. The page content was not read. ---",
                    page.number
                ));
                append_fragment(&mut text, page);
            }
            PageRender::Rendered(image) => {
                if image_bytes + image.png.len() > MAX_RENDERED_BYTES_PER_CALL {
                    stop = Some((
                        page.number,
                        format!(
                            "at most {} MiB of rendered PNG data per call",
                            MAX_RENDERED_BYTES_PER_CALL / 1024 / 1024
                        ),
                    ));
                    break;
                }
                images += 1;
                image_bytes += image.png.len();
                text.push_str(&format!(
                    "\n--- Page {}: no text layer; rendered at {} DPI to the {}x{} PNG image that follows, for native vision (no OCR) ---",
                    page.number, image.dpi, image.width, image.height
                ));
                append_fragment(&mut text, page);
                content.push(ContentBlock::Text {
                    text: std::mem::take(&mut text),
                });
                content.push(ContentBlock::Image {
                    source: ImageSource::base64(MEDIA_TYPE, BASE64_STANDARD.encode(&image.png)),
                });
            }
        }
    }
    if let Some((next, reason)) = stop {
        let remaining = page_range(next, present_last);
        text.push_str(&format!(
            "\n[Page image budget reached ({reason}). Pages {remaining} were not returned; call read again with pages=\"{remaining}\" to continue.]"
        ));
    }
    if !text.is_empty() {
        content.push(ContentBlock::Text { text });
    }
    Ok(ToolOutput {
        content,
        is_error: false,
        execution_metadata: Vec::new(),
        user_context: Vec::new(),
    })
}

/// Entry point from `read_pdf` once some page lacks a text layer.
pub(super) async fn compose_with_rendering(
    pages: Vec<PageText>,
    range: (u32, u32),
    bytes: Arc<Vec<u8>>,
    ctx: &ToolContext,
) -> Result<ToolOutput, ToolError> {
    match find_renderer() {
        Ok(Some(renderer)) => {
            let mut process = ProcessRenderer::new(renderer, bytes, ctx);
            compose(pages, range, Ok(&mut process)).await
        }
        Ok(None) => compose(pages, range, Err(MISSING_RENDERER.into())).await,
        Err(reason) => compose(pages, range, Err(reason)).await,
    }
}

/// Run blocking filesystem work off the async runtime with cancellation and
/// a bound. Cancellation is a lifecycle outcome; other failures are reasons.
async fn blocking<T: Send + 'static>(
    ctx: &ToolContext,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<Result<T, String>, ToolError> {
    tokio::select! {
        _ = ctx.cancelled() => Err(ToolError::Aborted),
        result = tokio::time::timeout(STAGING_TIMEOUT, tokio::task::spawn_blocking(work)) => Ok(match result {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("the private rendering worker failed".into()),
            Err(_) => Err("private rendering file operations timed out".into()),
        }),
    }
}

struct Staging {
    /// Owns the private temporary directory; dropping it removes only it.
    _owner: kcoder_config::PrivateTempDir,
    directory: Arc<kcoder_config::PrivateDirectory>,
    root: PathBuf,
}

enum RunOutcome {
    Success,
    Failed,
    TimedOut,
    NotStarted,
}

struct Collected {
    width: u32,
    height: u32,
    len: u64,
    bytes: Option<Vec<u8>>,
}

pub(super) struct ProcessRenderer<'a> {
    renderer: PdfRenderer,
    bytes: Arc<Vec<u8>>,
    ctx: &'a ToolContext,
    staging: Option<Result<Staging, String>>,
    deadline: Instant,
    attempts: u32,
}

impl<'a> ProcessRenderer<'a> {
    pub(super) fn new(renderer: PdfRenderer, bytes: Arc<Vec<u8>>, ctx: &'a ToolContext) -> Self {
        Self {
            renderer,
            bytes,
            ctx,
            staging: None,
            deadline: Instant::now() + RENDER_CALL_BUDGET,
            attempts: 0,
        }
    }

    /// Stage the already-authorized bounded bytes once per call.
    async fn staging(&mut self) -> Result<Result<&Staging, String>, ToolError> {
        if self.staging.is_none() {
            let bytes = self.bytes.clone();
            let staged = blocking(self.ctx, move || {
                let owner = kcoder_config::create_private_temp_dir("kcoder-pdf-render")
                    .map_err(|_| "cannot create a private rendering directory".to_owned())?;
                let directory = kcoder_config::PrivateDirectory::open_or_create(owner.path())
                    .map_err(|_| "cannot secure the private rendering directory".to_owned())?;
                directory
                    .atomic_replace(OsStr::new("input.pdf"), &bytes)
                    .map_err(|_| "cannot stage the private rendering input".to_owned())?;
                let root = owner.path().to_path_buf();
                Ok(Staging {
                    _owner: owner,
                    directory: Arc::new(directory),
                    root,
                })
            })
            .await?;
            self.staging = Some(staged);
        }
        Ok(match self.staging.as_ref().expect("staging initialized") {
            Ok(staging) => Ok(staging),
            Err(reason) => Err(reason.clone()),
        })
    }

    async fn run(
        &self,
        args: &[OsString],
        timeout: Duration,
        writable: &Path,
        staging_root: &Path,
    ) -> Result<RunOutcome, ToolError> {
        let mut command = tokio::process::Command::new(&self.renderer.executable);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let cwd = self
            .renderer
            .configuration_dir
            .clone()
            .unwrap_or_else(|| staging_root.to_path_buf());
        confine_helper(
            &mut command,
            self.ctx,
            &cwd,
            Some(writable),
            Some(RENDER_OUTPUT_FILE_LIMIT),
        );
        let Ok(mut child) = command.spawn() else {
            return Ok(RunOutcome::NotStarted);
        };
        let outcome = tokio::select! {
            _ = self.ctx.cancelled() => Err(ToolError::Aborted),
            result = tokio::time::timeout(timeout, child.wait()) => Ok(match result {
                Ok(Ok(status)) if status.success() => RunOutcome::Success,
                Ok(_) => RunOutcome::Failed,
                Err(_) => RunOutcome::TimedOut,
            }),
        };
        // Reap before the attempt directory is removed, including cancellation.
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        outcome
    }
}

/// Read the single PNG an attempt produced, without following links.
fn collect_png(directory: &kcoder_config::PrivateDirectory) -> Result<Collected, String> {
    let names = directory
        .entry_names_bounded(8)
        .map_err(|_| "cannot list the rendering output".to_owned())?;
    let pngs: Vec<&OsString> = names
        .iter()
        .filter(|name| Path::new(name).extension().is_some_and(|ext| ext == "png"))
        .collect();
    let [name] = pngs.as_slice() else {
        return Err(format!(
            "the renderer produced {} PNG files instead of one",
            pngs.len()
        ));
    };
    let mut file = directory
        .open_single_link_regular_file(name.as_os_str())
        .map_err(|_| "the rendering output is not a private regular file".to_owned())?;
    let len = file
        .metadata()
        .map_err(|_| "cannot inspect the rendering output".to_owned())?
        .len();
    let mut header = [0_u8; 24];
    file.read_exact(&mut header)
        .map_err(|_| "the rendering output is not a PNG image".to_owned())?;
    let (width, height) = png_dimensions(&header)
        .ok_or_else(|| "the rendering output is not a PNG image".to_owned())?;
    let bytes = if len <= MAX_BYTES as u64 {
        let mut bytes = header.to_vec();
        file.take(MAX_BYTES as u64 + 1 - header.len() as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "cannot read the rendering output".to_owned())?;
        if bytes.len() as u64 != len {
            return Err("the rendering output changed while it was read".into());
        }
        Some(bytes)
    } else {
        None
    };
    Ok(Collected {
        width,
        height,
        len,
        bytes,
    })
}

#[async_trait::async_trait]
impl RenderPage for ProcessRenderer<'_> {
    async fn render(&mut self, page: u32) -> Result<PageRender, ToolError> {
        if self.ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let (directory, root) = match self.staging().await? {
            Ok(staging) => (staging.directory.clone(), staging.root.clone()),
            Err(reason) => return Ok(PageRender::Failed(reason)),
        };
        let input = root.join("input.pdf");
        let mut dpi = RENDER_DPI;
        for attempt in 1..=MAX_RENDER_ATTEMPTS {
            let remaining = self.deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(PageRender::OutOfTime);
            }
            let timeout = remaining.min(RENDER_ATTEMPT_TIMEOUT);
            self.attempts += 1;
            let name = OsString::from(format!("page-{page}-attempt-{}", self.attempts));
            let parent = directory.clone();
            let child_name = name.clone();
            let output = match blocking(self.ctx, move || {
                parent
                    .create_private_child(&child_name)
                    .map_err(|_| "cannot create a private rendering output directory".to_owned())
            })
            .await?
            {
                Ok(output) => Arc::new(output),
                Err(reason) => return Ok(PageRender::Failed(reason)),
            };
            let output_dir = root.join(&name);
            let args = render_args(&self.renderer, page, dpi, &input, &output_dir.join("page"));
            let outcome = self.run(&args, timeout, &output_dir, &root).await;
            let collected = match outcome {
                Ok(RunOutcome::Success) => {
                    let output = output.clone();
                    Some(blocking(self.ctx, move || collect_png(&output)).await)
                }
                _ => None,
            };
            // Remove only this attempt's owned output; the staging owner
            // removes the rest when the call ends.
            let parent = directory.clone();
            drop(output);
            let _ = blocking(self.ctx, move || {
                parent
                    .remove_child_tree(&name)
                    .map_err(|_| "cleanup failed".to_owned())
            })
            .await;
            match outcome? {
                RunOutcome::TimedOut if timeout < RENDER_ATTEMPT_TIMEOUT => {
                    return Ok(PageRender::OutOfTime);
                }
                RunOutcome::TimedOut => {
                    return Ok(PageRender::Failed(format!(
                        "rendering timed out after {} seconds",
                        RENDER_ATTEMPT_TIMEOUT.as_secs()
                    )));
                }
                RunOutcome::Failed if dpi > FAILURE_RETRY_DPI && attempt < MAX_RENDER_ATTEMPTS => {
                    dpi = FAILURE_RETRY_DPI;
                    continue;
                }
                RunOutcome::Failed => {
                    return Ok(PageRender::Failed(format!(
                        "the renderer could not render this page at {dpi} DPI; the page may be damaged or too complex"
                    )));
                }
                RunOutcome::NotStarted => {
                    let name = self
                        .renderer
                        .executable
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    return Ok(PageRender::Failed(format!(
                        "cannot start the page renderer {name} on the execution host"
                    )));
                }
                RunOutcome::Success => {}
            }
            let collected = match collected.expect("collected after success")? {
                Ok(collected) => collected,
                Err(reason) => return Ok(PageRender::Failed(reason)),
            };
            match assess(
                dpi,
                collected.width,
                collected.height,
                collected.len,
                attempt == MAX_RENDER_ATTEMPTS,
            ) {
                Fit::Retry(next) => dpi = next,
                Fit::Reject(reason) => return Ok(PageRender::Failed(reason)),
                Fit::Accept => {
                    let Some(png) = collected.bytes else {
                        return Ok(PageRender::Failed(
                            "the rendering output exceeds the image byte limit".into(),
                        ));
                    };
                    let checked = blocking(self.ctx, move || {
                        crate::image_input::inspect(&png, MEDIA_TYPE).map(|info| (png, info))
                    })
                    .await?;
                    return Ok(match checked {
                        Ok((png, info)) => PageRender::Rendered(RenderedPage {
                            png,
                            width: info.width,
                            height: info.height,
                            dpi,
                        }),
                        Err(reason) => PageRender::Failed(reason),
                    });
                }
            }
        }
        Ok(PageRender::Failed(
            "the page could not be rendered within the image limits".into(),
        ))
    }
}

#[cfg(test)]
#[path = "render_tests.rs"]
mod tests;
