use anyhow::{Context, Result, anyhow, bail};
use arboard::Clipboard;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use image::{
    DynamicImage, GenericImageView, ImageFormat, ImageReader, Limits, RgbaImage,
    imageops::FilterType,
};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{Cursor, Read, Seek};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use wait_timeout::ChildExt;

pub(crate) const MAX_IMAGE_DIMENSION: u32 = 2_000;
pub(crate) const TARGET_IMAGE_BYTES: usize = 3_750_000;
const MAX_CLIPBOARD_SOURCE_BYTES: usize = 50 * 1024 * 1024;
const MAX_DECODED_IMAGE_BYTES: u64 = 128 * 1024 * 1024;
const CLIPBOARD_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "linux")]
const MAX_MIME_LIST_BYTES: usize = 64 * 1024;
const MAX_COMMAND_ERROR_BYTES: usize = 32 * 1024;
const MAX_BASE64_IMAGE_BYTES: usize = (MAX_CLIPBOARD_SOURCE_BYTES * 4 / 3) + 4096;

#[derive(Debug)]
struct TemporaryImageFile {
    path: PathBuf,
}

impl Drop for TemporaryImageFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// A private clipboard image file shared by the composer, kill buffer, and
/// queued-message state. The file disappears when its last attachment does.
#[derive(Clone, Debug)]
pub(crate) struct ClipboardImage {
    file: Arc<TemporaryImageFile>,
}

impl ClipboardImage {
    pub(crate) fn path(&self) -> &Path {
        &self.file.path
    }
}

impl PartialEq for ClipboardImage {
    fn eq(&self, other: &Self) -> bool {
        self.path() == other.path()
    }
}

impl Eq for ClipboardImage {}

pub(crate) fn read_clipboard_image() -> Result<ClipboardImage> {
    if let Some(bytes) = read_tui_lab_fixture()? {
        return process_and_persist(&bytes);
    }

    let mut failures = Vec::new();

    match read_with_arboard() {
        Ok(bytes) => return process_and_persist(&bytes),
        Err(error) => failures.push(format!("native clipboard: {error:#}")),
    }

    #[cfg(target_os = "linux")]
    {
        match read_with_linux_commands() {
            Ok(bytes) => return process_and_persist(&bytes),
            Err(error) => failures.push(format!("Wayland/X11 clipboard: {error:#}")),
        }
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        match read_with_powershell() {
            Ok(bytes) => return process_and_persist(&bytes),
            Err(error) => failures.push(format!("PowerShell clipboard: {error:#}")),
        }
    }

    bail!(
        "no readable image was found in this machine's clipboard ({})",
        failures.join("; ")
    )
}

fn read_tui_lab_fixture() -> Result<Option<Vec<u8>>> {
    let enabled = std::env::var("KCODER_TUI_LAB").ok().as_deref() == Some("1");
    let fixture_path = std::env::var_os("KCODER_TUI_LAB_CLIPBOARD_IMAGE_PATH").map(PathBuf::from);
    let run_dir = std::env::var_os("KCODER_TUI_LAB_RUN_DIR").map(PathBuf::from);
    let Some(path) =
        validated_tui_lab_fixture_path(enabled, fixture_path.as_deref(), run_dir.as_deref())?
    else {
        return Ok(None);
    };
    read_source_file(&path).map(Some)
}

fn validated_tui_lab_fixture_path(
    enabled: bool,
    fixture_path: Option<&Path>,
    run_dir: Option<&Path>,
) -> Result<Option<PathBuf>> {
    if !enabled || fixture_path.is_none() {
        return Ok(None);
    }
    let fixture_path = fixture_path.expect("checked above");
    let run_dir = run_dir.context("TUI Lab clipboard fixture requires a run directory")?;
    let canonical_run_dir = run_dir
        .canonicalize()
        .context("failed to resolve TUI Lab run directory")?;
    let canonical_fixture = fixture_path
        .canonicalize()
        .context("failed to resolve TUI Lab clipboard fixture")?;
    if !canonical_fixture.starts_with(&canonical_run_dir) {
        bail!("TUI Lab clipboard fixture must be inside its run directory");
    }
    Ok(Some(canonical_fixture))
}

fn read_with_arboard() -> Result<Vec<u8>> {
    let mut clipboard = Clipboard::new().context("failed to open clipboard")?;

    if let Ok(paths) = clipboard.get().file_list() {
        for path in paths {
            if crate::attachments::image_media_type(&path).is_some()
                && let Ok(bytes) = read_source_file(&path)
            {
                return Ok(bytes);
            }
        }
    }

    let image = clipboard
        .get_image()
        .context("clipboard does not contain image pixels or an image file")?;
    let width = u32::try_from(image.width).context("clipboard image width is too large")?;
    let height = u32::try_from(image.height).context("clipboard image height is too large")?;
    let expected_bytes = checked_rgba_bytes(width, height)?;
    if image.bytes.len() != expected_bytes {
        bail!(
            "clipboard returned {} RGBA bytes for {width}x{height}, expected {expected_bytes}",
            image.bytes.len()
        );
    }
    let rgba = RgbaImage::from_raw(width, height, image.bytes.into_owned())
        .ok_or_else(|| anyhow!("clipboard returned invalid RGBA pixel data"))?;
    encode_png(&DynamicImage::ImageRgba8(rgba))
}

fn read_source_file(path: &Path) -> Result<Vec<u8>> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("failed to inspect clipboard file {}", path.display()))?;
    if !metadata.is_file() {
        bail!("clipboard path is not a file: {}", path.display());
    }
    if metadata.len() > MAX_CLIPBOARD_SOURCE_BYTES as u64 {
        bail!("clipboard image source exceeds 50 MB");
    }
    std::fs::read(path).with_context(|| format!("failed to read {}", path.display()))
}

#[cfg(target_os = "linux")]
fn read_with_linux_commands() -> Result<Vec<u8>> {
    let mut failures = Vec::new();
    for (program, list_args, read_args) in [
        ("wl-paste", &["--list-types"][..], &["--type"][..]),
        (
            "xclip",
            &["-selection", "clipboard", "-t", "TARGETS", "-o"][..],
            &["-selection", "clipboard", "-t"][..],
        ),
    ] {
        let listed = match run_clipboard_command(
            program,
            list_args.iter().copied(),
            MAX_MIME_LIST_BYTES,
            CLIPBOARD_COMMAND_TIMEOUT,
        ) {
            Ok(output) if output.status.success() => output,
            Ok(output) => {
                failures.push(format!(
                    "{program} exited with {}{}",
                    output.status,
                    command_error_suffix(&output.stderr)
                ));
                continue;
            }
            Err(error) => {
                failures.push(format!("{program}: {error}"));
                continue;
            }
        };
        let offered = String::from_utf8_lossy(&listed.stdout);
        let Some(mime) = preferred_image_mime(&offered) else {
            failures.push(format!("{program} found no supported image MIME type"));
            continue;
        };
        let output = run_clipboard_command(
            program,
            read_args.iter().copied().chain(std::iter::once(mime)),
            MAX_CLIPBOARD_SOURCE_BYTES,
            CLIPBOARD_COMMAND_TIMEOUT,
        )
        .with_context(|| format!("failed to read image with {program}"))?;
        if output.status.success() && !output.stdout.is_empty() {
            return Ok(output.stdout);
        }
        failures.push(format!(
            "{program} could not read {mime}{}",
            command_error_suffix(&output.stderr)
        ));
    }
    bail!("{}", failures.join("; "))
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn read_with_powershell() -> Result<Vec<u8>> {
    const SCRIPT: &str = r#"Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $image = [Windows.Forms.Clipboard]::GetImage(); if ($null -eq $image) { exit 3 }; $stream = New-Object IO.MemoryStream; $image.Save($stream, [Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($stream.ToArray())"#;
    #[cfg(target_os = "windows")]
    let candidates = ["pwsh.exe", "powershell.exe"];
    #[cfg(target_os = "linux")]
    let candidates = ["powershell.exe", "pwsh"];

    let mut failures = Vec::new();
    for program in candidates {
        match run_clipboard_command(
            program,
            ["-NoProfile", "-NonInteractive", "-Sta", "-Command", SCRIPT],
            MAX_BASE64_IMAGE_BYTES,
            CLIPBOARD_COMMAND_TIMEOUT,
        ) {
            Ok(output) if output.status.success() => {
                let encoded = String::from_utf8_lossy(&output.stdout);
                return BASE64_STANDARD
                    .decode(encoded.trim().as_bytes())
                    .context("PowerShell returned invalid image data");
            }
            Ok(output) => failures.push(format!(
                "{program} exited with {}{}",
                output.status,
                command_error_suffix(&output.stderr)
            )),
            Err(error) => failures.push(format!("{program}: {error}")),
        }
    }
    bail!("{}", failures.join("; "))
}

#[cfg(any(target_os = "linux", test))]
fn preferred_image_mime(offered: &str) -> Option<&'static str> {
    const PREFERRED: [&str; 5] = [
        "image/png",
        "image/webp",
        "image/jpeg",
        "image/gif",
        "image/bmp",
    ];
    PREFERRED.into_iter().find(|wanted| {
        offered
            .lines()
            .map(str::trim)
            .any(|actual| actual.eq_ignore_ascii_case(wanted))
    })
}

#[derive(Debug)]
struct CapturedCommandOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn run_clipboard_command<I, S>(
    program: &str,
    args: I,
    max_stdout_bytes: usize,
    timeout: Duration,
) -> Result<CapturedCommandOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut stdout_file = tempfile::tempfile().context("failed to create clipboard stdout file")?;
    let mut stderr_file = tempfile::tempfile().context("failed to create clipboard stderr file")?;
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(
            stdout_file
                .try_clone()
                .context("failed to clone clipboard stdout file")?,
        ))
        .stderr(Stdio::from(
            stderr_file
                .try_clone()
                .context("failed to clone clipboard stderr file")?,
        ));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .with_context(|| format!("failed to start {program}"))?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        let stdout_bytes = stdout_file
            .metadata()
            .context("failed to inspect clipboard command stdout")?
            .len();
        let stderr_bytes = stderr_file
            .metadata()
            .context("failed to inspect clipboard command stderr")?
            .len();
        if stdout_bytes > max_stdout_bytes as u64 {
            terminate_command_tree(&mut child);
            bail!("clipboard command output exceeds {max_stdout_bytes} bytes");
        }
        if stderr_bytes > MAX_COMMAND_ERROR_BYTES as u64 {
            terminate_command_tree(&mut child);
            bail!("clipboard command error output exceeds {MAX_COMMAND_ERROR_BYTES} bytes");
        }

        let now = Instant::now();
        if now >= deadline {
            terminate_command_tree(&mut child);
            bail!("{program} timed out after {}s", timeout.as_secs_f32());
        }
        let poll_for = deadline
            .saturating_duration_since(now)
            .min(Duration::from_millis(10));
        if let Some(status) = child
            .wait_timeout(poll_for)
            .with_context(|| format!("failed while waiting for {program}"))?
        {
            break status;
        }
    };

    let stdout = read_bounded_file(&mut stdout_file, max_stdout_bytes)
        .with_context(|| format!("failed to read {program} stdout"))?;
    let stderr = read_bounded_file(&mut stderr_file, MAX_COMMAND_ERROR_BYTES)
        .with_context(|| format!("failed to read {program} stderr"))?;
    Ok(CapturedCommandOutput {
        status,
        stdout,
        stderr,
    })
}

fn terminate_command_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        let process_group = i32::try_from(child.id()).unwrap_or(i32::MAX);
        // The child is placed in its own process group above, so a negative PID
        // terminates helper grandchildren as well as the clipboard command.
        unsafe {
            libc::kill(-process_group, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn read_bounded_file(file: &mut File, max_bytes: usize) -> Result<Vec<u8>> {
    file.rewind()?;
    let limit = u64::try_from(max_bytes)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        bail!("clipboard command output exceeds {max_bytes} bytes");
    }
    Ok(bytes)
}

fn command_error_suffix(stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        String::new()
    } else {
        format!(": {stderr}")
    }
}

fn process_and_persist(bytes: &[u8]) -> Result<ClipboardImage> {
    let processed = process_image_bytes(bytes)?;
    persist_processed_png(&processed)
}

fn checked_rgba_bytes(width: u32, height: u32) -> Result<usize> {
    let bytes = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .context("clipboard image dimensions overflow")?;
    if bytes > MAX_DECODED_IMAGE_BYTES {
        bail!(
            "clipboard image requires more than {} MB when decoded",
            MAX_DECODED_IMAGE_BYTES / 1024 / 1024
        );
    }
    usize::try_from(bytes).context("clipboard image is too large for this platform")
}

fn decode_image_with_limits(bytes: &[u8]) -> Result<DynamicImage> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .context("failed to detect clipboard image format")?;
    let format = reader
        .format()
        .context("clipboard image format is not supported")?;
    let (width, height) = reader
        .into_dimensions()
        .context("failed to inspect clipboard image dimensions")?;
    checked_rgba_bytes(width, height)?;

    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODED_IMAGE_BYTES);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    reader
        .decode()
        .context("failed to decode clipboard image within memory limits")
}

fn process_image_bytes(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.is_empty() {
        bail!("clipboard image is empty");
    }
    if bytes.len() > MAX_CLIPBOARD_SOURCE_BYTES {
        bail!("clipboard image source exceeds 50 MB");
    }
    let mut image = decode_image_with_limits(bytes)?;
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        bail!("clipboard image has invalid dimensions");
    }
    if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        image = image.resize(
            MAX_IMAGE_DIMENSION,
            MAX_IMAGE_DIMENSION,
            FilterType::Lanczos3,
        );
    }

    for _ in 0..8 {
        let encoded = encode_png(&image)?;
        if encoded.len() <= TARGET_IMAGE_BYTES {
            return Ok(encoded);
        }
        let (width, height) = image.dimensions();
        if width <= 64 || height <= 64 {
            bail!("clipboard image could not be compressed below the attachment limit");
        }
        let ratio = (TARGET_IMAGE_BYTES as f64 / encoded.len() as f64).sqrt() * 0.9;
        let next_width = ((width as f64 * ratio) as u32).clamp(64, width - 1);
        let next_height = ((height as f64 * ratio) as u32).clamp(64, height - 1);
        image = image.resize_exact(next_width, next_height, FilterType::Lanczos3);
    }
    bail!("clipboard image could not be compressed below the attachment limit")
}

fn encode_png(image: &DynamicImage) -> Result<Vec<u8>> {
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .context("failed to encode clipboard image as PNG")?;
    Ok(output.into_inner())
}

pub(crate) fn persist_processed_png(bytes: &[u8]) -> Result<ClipboardImage> {
    let file = tempfile::Builder::new()
        .prefix("kcoder-clipboard-")
        .suffix(".png")
        .tempfile()
        .context("failed to create clipboard image temp file")?;
    std::fs::write(file.path(), bytes).context("failed to write clipboard image temp file")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o600))
            .context("failed to secure clipboard image temp file")?;
    }
    let (_handle, path) = file
        .keep()
        .context("failed to retain clipboard image temp file")?;
    Ok(ClipboardImage {
        file: Arc::new(TemporaryImageFile { path }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, GenericImageView, ImageFormat, RgbaImage};
    use std::io::Cursor;

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            width,
            height,
            image::Rgba([35, 90, 180, 255]),
        ));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    #[test]
    fn processed_clipboard_image_is_png_and_fits_dimension_limit() {
        let processed = process_image_bytes(&png_bytes(2400, 1200)).unwrap();
        let decoded = image::load_from_memory_with_format(&processed, ImageFormat::Png).unwrap();

        assert_eq!(decoded.dimensions(), (MAX_IMAGE_DIMENSION, 1000));
        assert!(processed.len() <= TARGET_IMAGE_BYTES);
    }

    #[test]
    fn decoded_image_memory_limit_rejects_oversized_rgba_dimensions() {
        let error = checked_rgba_bytes(20_000, 20_000).unwrap_err();
        assert!(error.to_string().contains("when decoded"));
    }

    #[cfg(unix)]
    #[test]
    fn clipboard_helper_timeout_kills_the_process_group() {
        let temp = tempfile::tempdir().unwrap();
        let pid_path = temp.path().join("grandchild.pid");
        let pid_path_arg = pid_path.to_string_lossy().into_owned();
        let started = std::time::Instant::now();
        let error = run_clipboard_command(
            "/bin/sh",
            [
                "-c",
                "sleep 10 & child=$!; printf '%s' \"$child\" > \"$1\"; wait",
                "clipboard-timeout-test",
                &pid_path_arg,
            ],
            1024,
            Duration::from_millis(100),
        )
        .unwrap_err();

        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(2));
        let grandchild_pid = std::fs::read_to_string(pid_path)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let reap_deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let alive = unsafe { libc::kill(grandchild_pid, 0) } == 0;
            if !alive {
                break;
            }
            assert!(
                Instant::now() < reap_deadline,
                "clipboard helper grandchild {grandchild_pid} survived cancellation"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    #[test]
    fn clipboard_helper_is_killed_as_soon_as_output_exceeds_the_cap() {
        let started = Instant::now();
        let error = run_clipboard_command(
            "/bin/sh",
            ["-c", "while :; do printf '0123456789abcdef'; done"],
            1024,
            Duration::from_secs(2),
        )
        .unwrap_err();

        assert!(error.to_string().contains("exceeds 1024 bytes"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn clipboard_mime_preference_chooses_supported_lossless_format_first() {
        let offered = "text/plain\nimage/jpeg\nimage/png\nimage/webp\n";
        assert_eq!(preferred_image_mime(offered), Some("image/png"));
        assert_eq!(
            preferred_image_mime("text/plain\nimage/jpeg\n"),
            Some("image/jpeg")
        );
        assert_eq!(preferred_image_mime("text/plain\n"), None);
    }

    #[test]
    fn temporary_clipboard_file_is_removed_after_last_reference() {
        let image = persist_processed_png(&png_bytes(8, 8)).unwrap();
        let path = image.path().to_path_buf();
        let clone = image.clone();
        assert!(path.exists());

        drop(image);
        assert!(path.exists());
        drop(clone);
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn temporary_clipboard_file_is_private() {
        use std::os::unix::fs::PermissionsExt;

        let image = persist_processed_png(&png_bytes(8, 8)).unwrap();
        let mode = std::fs::metadata(image.path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn tui_lab_fixture_is_only_available_inside_enabled_run_directory() {
        let run_dir = tempfile::tempdir().unwrap();
        let fixture = run_dir.path().join("fixture.png");
        std::fs::write(&fixture, png_bytes(8, 8)).unwrap();

        assert_eq!(
            validated_tui_lab_fixture_path(false, Some(&fixture), Some(run_dir.path())).unwrap(),
            None
        );
        assert_eq!(
            validated_tui_lab_fixture_path(true, Some(&fixture), Some(run_dir.path())).unwrap(),
            Some(fixture.canonicalize().unwrap())
        );
    }

    #[test]
    fn tui_lab_fixture_rejects_paths_outside_the_run_directory() {
        let run_dir = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();

        let error =
            validated_tui_lab_fixture_path(true, Some(outside.path()), Some(run_dir.path()))
                .unwrap_err();

        assert!(error.to_string().contains("inside its run directory"));
    }
}
