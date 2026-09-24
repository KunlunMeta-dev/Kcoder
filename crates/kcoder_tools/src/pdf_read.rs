//! Bounded PDF text extraction. No shell, source-path forwarding or OCR claims.
use crate::{ToolContext, ToolError, ToolOutput};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

const MAX_PDF_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 512 * 1024;
const MAX_PAGES: u32 = 20;

fn page_range(value: Option<&str>) -> Result<(u32, u32), ToolError> {
    let value = value.unwrap_or("1-10").trim();
    let (first, last) = value.split_once('-').unwrap_or((value, value));
    let parse = |s: &str| {
        s.trim().parse::<u32>().map_err(|_| {
            ToolError::InvalidInput("PDF pages must be a positive page or range such as 1-5".into())
        })
    };
    let (first, last) = (parse(first)?, parse(last)?);
    if first == 0 || last < first || last > i32::MAX as u32 || last - first >= MAX_PAGES {
        return Err(ToolError::InvalidInput(
            "PDF page range must be positive, ordered, and contain at most 20 pages".into(),
        ));
    }
    Ok((first, last))
}

async fn bounded_read(reader: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>, ToolError> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| ToolError::Execution("Failed to read PDF extraction stream".into()))?;
    if bytes.len() > limit {
        return Err(ToolError::Execution(
            "PDF extraction output limit exceeded; request fewer pages".into(),
        ));
    }
    Ok(bytes)
}

pub(crate) async fn read_pdf(
    path: &Path,
    pages: Option<&str>,
    ctx: &ToolContext,
) -> Result<ToolOutput, ToolError> {
    let range = page_range(pages)?;
    if ctx.is_aborted() {
        return Err(ToolError::Aborted);
    }
    let source = async {
        let resolved = tokio::fs::canonicalize(path)
            .await
            .map_err(|_| ToolError::Execution("Cannot resolve PDF file".into()))?;
        if let Some(sandbox) = &ctx.sandbox {
            sandbox
                .check_path(&resolved, false)
                .map_err(ToolError::Execution)?;
        }
        let mut options = tokio::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
        let file = options
            .open(&resolved)
            .await
            .map_err(|_| ToolError::Execution("Cannot open PDF file".into()))?;
        let metadata = file
            .metadata()
            .await
            .map_err(|_| ToolError::Execution("Cannot inspect PDF file".into()))?;
        if !metadata.is_file() || metadata.len() > MAX_PDF_BYTES {
            return Err(ToolError::Execution(
                "PDF must be a regular file of at most 32 MiB".into(),
            ));
        }
        bounded_read(file, MAX_PDF_BYTES as usize).await
    };
    let bytes = tokio::select! {
        _ = ctx.cancelled() => return Err(ToolError::Aborted),
        result = tokio::time::timeout(Duration::from_secs(20), source) => match result {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(error)) => return Ok(ToolOutput::error(error.to_string())),
            Err(_) => return Err(ToolError::Execution("PDF source read timed out".into())),
        },
    };
    if !bytes.starts_with(b"%PDF-") {
        return Ok(ToolOutput::error("Invalid PDF header"));
    }
    let runtime = match find_pdf_runtime() {
        Ok(Some(runtime)) => runtime,
        Ok(None) => {
            return Ok(ToolOutput::error(
                "PDF text extraction requires pdftotext on the execution host. Reinstall the full Windows Studio package for its bundled reader, or install Poppler pdftotext on the host. No OCR or visual inspection was performed.",
            ));
        }
        Err(error) => return Ok(ToolOutput::error(error)),
    };
    extract_configured(
        &runtime.executable,
        bytes,
        range,
        ctx,
        Duration::from_secs(20),
        runtime.configuration_dir.as_deref(),
    )
    .await
}

struct PdfRuntime {
    executable: std::path::PathBuf,
    configuration_dir: Option<std::path::PathBuf>,
}

fn bundled_pdf_runtime(executable: &Path, command: &str) -> Result<Option<PdfRuntime>, String> {
    let Some(bin) = executable.parent() else {
        return Ok(None);
    };
    for directory in [bin.join("pdf"), bin.join("../lib/kcoder/pdf")] {
        let program = directory.join(command);
        if !program.is_file() {
            continue;
        }
        if !directory.join("xpdfrc").is_file() || !directory.join(".kcoder-pdf.json").is_file() {
            return Err(
                "Bundled PDF reader resources are incomplete; reinstall the full Studio package"
                    .into(),
            );
        }
        return Ok(Some(PdfRuntime {
            executable: program,
            configuration_dir: Some(directory),
        }));
    }
    Ok(None)
}

fn find_pdf_runtime() -> Result<Option<PdfRuntime>, String> {
    let command = if cfg!(windows) {
        "pdftotext.exe"
    } else {
        "pdftotext"
    };
    if let Ok(executable) = std::env::current_exe() {
        if let Some(runtime) = bundled_pdf_runtime(&executable, command)? {
            return Ok(Some(runtime));
        }
    }
    Ok(which::which(command).ok().map(|executable| PdfRuntime {
        executable,
        configuration_dir: None,
    }))
}

#[cfg(test)]
async fn extract(
    executable: &Path,
    bytes: Vec<u8>,
    range: (u32, u32),
    ctx: &ToolContext,
    budget: Duration,
) -> Result<ToolOutput, ToolError> {
    extract_configured(executable, bytes, range, ctx, budget, None).await
}

async fn extract_configured(
    executable: &Path,
    bytes: Vec<u8>,
    (first, last): (u32, u32),
    ctx: &ToolContext,
    budget: Duration,
    configuration_dir: Option<&Path>,
) -> Result<ToolOutput, ToolError> {
    // Official Xpdf reads a seekable file, unlike Poppler's stdin interface.
    // Only a private copy of the already-authorized bounded bytes is forwarded.
    let (private_input, stdin_bytes) = if configuration_dir.is_some() {
        let prepare = tokio::task::spawn_blocking(move || -> Result<_, ToolError> {
            let directory = kcoder_config::create_private_temp_dir("kcoder-pdf").map_err(|_| {
                ToolError::Execution("Cannot create private PDF staging directory".into())
            })?;
            let private = kcoder_config::PrivateDirectory::open_or_create(directory.path())
                .map_err(|_| ToolError::Execution("Cannot secure PDF staging directory".into()))?;
            private
                .atomic_replace(std::ffi::OsStr::new("input.pdf"), &bytes)
                .map_err(|_| ToolError::Execution("Cannot stage private PDF input".into()))?;
            Ok(directory)
        });
        let directory = tokio::select! {
            _ = ctx.cancelled() => return Err(ToolError::Aborted),
            result = tokio::time::timeout(budget, prepare) => result
                .map_err(|_| ToolError::Execution("PDF staging timed out".into()))?
                .map_err(|_| ToolError::Execution("PDF staging worker failed".into()))??,
        };
        (Some(directory), Vec::new())
    } else {
        (None, bytes)
    };
    let mut command = tokio::process::Command::new(executable);
    // Bundled Xpdf uses a relative, packaged configuration so installation paths
    // containing spaces or non-ASCII characters never enter its config syntax.
    if let Some(directory) = configuration_dir {
        command.current_dir(directory).args(["-cfg", "xpdfrc"]);
    }

    command.args([
        "-f",
        &first.to_string(),
        "-l",
        &last.to_string(),
        "-enc",
        "UTF-8",
    ]);
    if let Some(directory) = &private_input {
        command.arg(directory.path().join("input.pdf"));
    } else {
        command.arg("-");
    }
    command
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child_cwd = configuration_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| ctx.state.cwd());
    command.current_dir(&child_cwd);
    crate::process::configure_isolated_process_environment(&mut command, &child_cwd);
    #[cfg(target_os = "linux")]
    if let Some(mut spec) = ctx.sandbox.as_ref().and_then(|sandbox| sandbox.os_spec()) {
        spec.rw_paths.clear();
        // The helper receives only already-authorized bytes on stdin and writes to pipes.
        unsafe {
            command
                .pre_exec(move || crate::os_sandbox::apply(&spec).map_err(std::io::Error::other));
        }
    }
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            let memory = libc::rlimit {
                rlim_cur: 512 * 1024 * 1024,
                rlim_max: 512 * 1024 * 1024,
            };
            let cpu = libc::rlimit {
                rlim_cur: 15,
                rlim_max: 15,
            };
            if libc::setrlimit(libc::RLIMIT_AS, &memory) != 0
                || libc::setrlimit(libc::RLIMIT_CPU, &cpu) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|_| ToolError::Execution("Cannot start pdftotext on the execution host".into()))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let work = async {
        let write = async {
            // Invalid/encrypted PDFs may close stdin before consuming all bytes.
            if let Err(error) = stdin.write_all(&stdin_bytes).await {
                if error.kind() != std::io::ErrorKind::BrokenPipe {
                    return Err(ToolError::Execution("Cannot send PDF to extractor".into()));
                }
            }
            drop(stdin);
            Ok::<_, ToolError>(())
        };
        let wait = async {
            child
                .wait()
                .await
                .map_err(|_| ToolError::Execution("Cannot wait for PDF extractor".into()))
        };
        let (_, text, _, status) = tokio::try_join!(
            write,
            bounded_read(stdout, MAX_TEXT_BYTES),
            bounded_read(stderr, 8192),
            wait
        )?;
        if !status.success() {
            return Ok(ToolOutput::error(
                "PDF text extraction failed: the file may be damaged, encrypted, or the requested pages may not exist. No visual inspection was performed.",
            ));
        }
        let text = String::from_utf8_lossy(&text);
        if text.trim().is_empty() {
            return Ok(ToolOutput::text(format!(
                "[PDF text extraction, requested pages {first}-{last}] No extractable text in the selected pages; scanned pages may require OCR. This is not a visual inspection."
            )));
        }
        Ok(ToolOutput::text(format!(
            "[PDF text extraction, requested pages {first}-{last}; source may end earlier. Text only, not OCR or a screenshot.]\n{text}"
        )))
    };
    let result = tokio::select! {
        _ = ctx.cancelled() => Err(ToolError::Aborted),
        result = tokio::time::timeout(budget, work) => result.unwrap_or_else(|_| Err(ToolError::Execution("PDF extraction timed out after its execution budget".into()))),
    };
    // Reap before deleting the staging file, including timeout/cancel paths.
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    drop(private_input);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_page_ranges_without_unbounded_expansion() {
        assert_eq!(page_range(None).unwrap(), (1, 10));
        assert_eq!(page_range(Some("2-4")).unwrap(), (2, 4));
        for invalid in ["0", "4-2", "1-21", "1-2-3", "all", "4294967295"] {
            assert!(page_range(Some(invalid)).is_err(), "{invalid}");
        }
    }
    #[tokio::test]
    async fn caps_streams_before_unbounded_allocation() {
        assert!(bounded_read(&b"12345"[..], 4).await.is_err());
        assert_eq!(bounded_read(&b"1234"[..], 4).await.unwrap(), b"1234");
    }
}

#[cfg(test)]
mod extraction_tests {
    use super::*;
    fn sample_pdf() -> Vec<u8> {
        let stream = "BT /F1 12 Tf 20 100 Td (KCoder PDF fixture) Tj ET";
        let objects = ["<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".into(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into(),
            format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len())];
        let mut pdf = "%PDF-1.4\n".to_owned();
        let mut offsets = vec![0];
        for (i, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf += &format!("{} 0 obj\n{object}\nendobj\n", i + 1);
        }
        let xref = pdf.len();
        pdf += "xref\n0 6\n0000000000 65535 f \n";
        for offset in offsets.iter().skip(1) {
            pdf += &format!("{offset:010} 00000 n \n");
        }
        pdf += &format!("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n");
        pdf.into_bytes()
    }
    #[tokio::test]
    async fn real_pdf_extraction_and_invalid_page_have_distinct_results() {
        let Ok(executable) = which::which("pdftotext") else {
            eprintln!("NOT RUN: pdftotext unavailable");
            return;
        };
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
        let result = extract(
            &executable,
            sample_pdf(),
            (1, 1),
            &ctx,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert!(!result.is_error);
        assert!(result.content.iter().any(|b| matches!(b, kcoder_types::ContentBlock::Text {text} if text.contains("KCoder PDF fixture") && text.contains("not OCR"))));
        let result = extract(
            &executable,
            sample_pdf(),
            (2, 2),
            &ctx,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert!(result.is_error);
        let result = extract(
            &executable,
            b"%PDF-invalid".to_vec(),
            (1, 1),
            &ctx,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert!(result.is_error);
    }
    #[tokio::test]
    async fn file_tool_routes_pdf_text_without_line_semantics() {
        use crate::Tool;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("sample.pdf");
        std::fs::write(&path, sample_pdf()).unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
        let result = crate::file::FileReadTool
            .call(serde_json::json!({"file_path":path,"pages":"1"}), &ctx)
            .await
            .unwrap();
        if which::which("pdftotext").is_ok() {
            assert!(!result.is_error);
        } else {
            assert!(result.is_error);
        }
        assert!(matches!(
            crate::file::FileReadTool
                .call(
                    serde_json::json!({"file_path":path,"pages":"1","offset":1}),
                    &ctx
                )
                .await,
            Err(ToolError::InvalidInput(_))
        ));
        let large = std::fs::File::create(temp.path().join("large.pdf")).unwrap();
        large.set_len(MAX_PDF_BYTES + 1).unwrap();
        assert!(
            read_pdf(&temp.path().join("large.pdf"), None, &ctx)
                .await
                .unwrap()
                .is_error
        );
    }

    #[tokio::test]
    async fn already_cancelled_read_does_not_open_source_or_spawn() {
        let token = tokio_util::sync::CancellationToken::new();
        token.cancel();
        let ctx = ToolContext::new(kcoder_state::AppState::new("/tmp")).with_abort_token(token);
        assert!(matches!(
            read_pdf(Path::new("/missing.pdf"), None, &ctx).await,
            Err(ToolError::Aborted)
        ));
    }
}

#[cfg(all(test, unix))]
mod process_limit_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn helper(dir: &Path, body: &str) -> std::path::PathBuf {
        let path = dir.join("pdf-fixture-helper");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }
    #[tokio::test]
    async fn live_process_timeout_and_cancellation_are_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let executable = helper(temp.path(), "exec /bin/sleep 10");
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
        let started = std::time::Instant::now();
        let result = extract(
            &executable,
            Vec::new(),
            (1, 1),
            &ctx,
            Duration::from_millis(50),
        )
        .await;
        assert!(matches!(result, Err(ToolError::Execution(ref e)) if e.contains("timed out")));
        assert!(started.elapsed() < Duration::from_secs(2));
        let token = tokio_util::sync::CancellationToken::new();
        let ctx = ctx.with_abort_token(token.clone());
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            token.cancel();
        };
        let (result, _) = tokio::join!(
            extract(
                &executable,
                Vec::new(),
                (1, 1),
                &ctx,
                Duration::from_secs(10)
            ),
            cancel
        );
        assert!(matches!(result, Err(ToolError::Aborted)));
    }
    #[tokio::test]
    async fn configured_reader_uses_private_copy_and_cleans_it() {
        let temp = tempfile::tempdir().unwrap();
        let executable = helper(
            temp.path(),
            "for arg in \"$@\"; do case \"$arg\" in */input.pdf) printf '%s' \"$arg\" > input-path; cat \"$arg\";; esac; done",
        );
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
        let result = extract_configured(
            &executable,
            b"PRIVATE_PDF_BYTES".to_vec(),
            (1, 1),
            &ctx,
            Duration::from_secs(2),
            Some(temp.path()),
        )
        .await
        .unwrap();
        assert!(!result.is_error);
        assert!(result.content.iter().any(|block| matches!(block, kcoder_types::ContentBlock::Text { text } if text.contains("PRIVATE_PDF_BYTES"))));
        let path = std::fs::read_to_string(temp.path().join("input-path")).unwrap();
        assert!(
            !Path::new(&path).exists(),
            "private input must be removed after helper completion"
        );
    }

    #[tokio::test]
    async fn runaway_output_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let executable = helper(temp.path(), "exec /bin/cat");
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()));
        let result = extract(
            &executable,
            vec![b'x'; MAX_TEXT_BYTES + 1024],
            (1, 1),
            &ctx,
            Duration::from_secs(2),
        )
        .await;
        assert!(matches!(result, Err(ToolError::Execution(ref e)) if e.contains("output limit")));
    }
}

#[cfg(test)]
mod bundle_tests {
    use super::*;
    #[test]
    fn finds_complete_sibling_bundle_and_rejects_partial_installation() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("Program Files 中文/resources/bin");
        let pdf = bin.join("pdf");
        std::fs::create_dir_all(&pdf).unwrap();
        let current = bin.join("kcoder.exe");
        assert!(
            bundled_pdf_runtime(&current, "pdftotext.exe")
                .unwrap()
                .is_none()
        );
        std::fs::write(pdf.join("pdftotext.exe"), b"fixture").unwrap();
        assert!(bundled_pdf_runtime(&current, "pdftotext.exe").is_err());
        std::fs::write(pdf.join("xpdfrc"), b"textEncoding UTF-8").unwrap();
        std::fs::write(pdf.join(".kcoder-pdf.json"), b"{}").unwrap();
        let runtime = bundled_pdf_runtime(&current, "pdftotext.exe")
            .unwrap()
            .unwrap();
        assert_eq!(runtime.executable, pdf.join("pdftotext.exe"));
        assert_eq!(runtime.configuration_dir.as_deref(), Some(pdf.as_path()));
    }
}
