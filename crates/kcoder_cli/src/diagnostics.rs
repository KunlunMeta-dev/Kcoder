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

    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_writer(std::io::stderr)
        .with_ansi(false)
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
