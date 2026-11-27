use kcoder_config::Settings;
use kcoder_engine::EngineEvent;
use std::backtrace::Backtrace;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub(super) fn init_tracing(interactive_tui: bool) {
    let default_filter = "warn";
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(default_filter));

    if interactive_tui
        && let Ok(log_path) = Settings::config_dir().map(|dir| dir.join("kcoder.log"))
    {
        install_panic_log_hook(log_path.clone());
        tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .with_writer(move || DiagnosticLogWriter::open(&log_path))
            .with_ansi(false)
            .init();
        return;
    }

    use tracing_subscriber::{Layer as _, layer::SubscriberExt as _, util::SubscriberInitExt as _};
    let stderr = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_filter(env_filter);
    // Protocol hosts discard unrecognized stderr. Persist the selected
    // runtime diagnostics whose fields are already sanitized at the producer.
    let runtime_log = Settings::config_dir().ok().map(|dir| {
        let log_path = dir.join("kcoder.log");
        tracing_subscriber::fmt::layer()
            .with_writer(move || DiagnosticLogWriter::open(&log_path))
            .with_ansi(false)
            .with_filter(
                tracing_subscriber::filter::Targets::new()
                    .with_target(kcoder_tools::peer_diagnostics::TARGET, tracing::Level::WARN)
                    .with_target("kcoder_native_task_authority", tracing::Level::WARN),
            )
    });
    tracing_subscriber::registry()
        .with(stderr)
        .with(runtime_log)
        .init();
}

struct DiagnosticLogWriter {
    file: Option<std::fs::File>,
}

impl DiagnosticLogWriter {
    fn open(path: &Path) -> Self {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok();
        Self { file }
    }
}

impl Write for DiagnosticLogWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self.file.as_mut() {
            Some(file) => file.write(buf),
            None => Ok(buf.len()),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.file.as_mut() {
            Some(file) => file.flush(),
            None => Ok(()),
        }
    }
}

fn install_panic_log_hook(log_path: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let mut writer = DiagnosticLogWriter::open(&log_path);
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("unnamed");
        let location = info
            .location()
            .map(|location| {
                format!(
                    "{}:{}:{}",
                    location.file(),
                    location.line(),
                    location.column()
                )
            })
            .unwrap_or_else(|| "unknown".to_string());
        let _ = writeln!(
            writer,
            "panic timestamp_ms={} pid={} thread={} location={} info={info}",
            current_timestamp_ms(),
            std::process::id(),
            thread_name,
            location
        );
        let _ = writeln!(writer, "backtrace:\n{}", Backtrace::force_capture());
        previous(info);
    }));
}

fn current_timestamp_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

pub(super) fn hook_startup_notice(events: &[EngineEvent]) -> Option<String> {
    let lines: Vec<String> = events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::HookMessage { text, is_error } => {
                let prefix = if *is_error {
                    "Hook error"
                } else {
                    "Hook message"
                };
                Some(format!("{prefix}: {text}"))
            }
            _ => None,
        })
        .collect();
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

pub(super) fn print_cli_build_identity() {
    use kcoder_cli_support::build_identity;
    println!(
        "version: {}",
        kcoder_cli_commands::build_identity::version()
    );
    if let Some(metadata) = kcoder_cli_commands::build_identity::release_metadata() {
        println!(
            "release commit: {}",
            metadata["release"]["commit"].as_str().unwrap_or("unknown")
        );
        println!("release time (unix): {}", metadata["release"]["timeUnix"]);
    }
    println!("build commit: {}", build_identity::current().commit);
    println!("build dirty: {}", build_identity::current().dirty);
    println!("build time (unix): {}", build_identity::current().time_unix);
    println!(
        "executable sha256: {}",
        build_identity::executable_sha256()
            .as_deref()
            .unwrap_or("unavailable")
    );
}
