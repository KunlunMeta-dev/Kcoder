#![cfg_attr(windows, windows_subsystem = "windows")]

use anyhow::{Context, Result};
use kcoder_process_supervisor::protocol::{SpawnRequest, read_protocol_line};
use std::io::BufReader;

#[cfg(windows)]
mod gui_carrier;

fn main() {
    if let Err(error) = run() {
        #[cfg(not(windows))]
        {
            let error = error.to_string();
            let message = bounded_error(&error);
            eprintln!("kcoder-process-supervisor: {message}");
        }
        #[cfg(windows)]
        let _ = error;
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    #[cfg(windows)]
    if let Some(code) = gui_carrier::try_run()? {
        std::process::exit(code);
    }
    #[cfg(windows)]
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == kcoder_process_supervisor::protocol::INTERNAL_CLEANUP_OWNER_V2)
    {
        let stdin = std::io::stdin();
        let mut input = BufReader::new(stdin);
        let line = read_protocol_line(&mut input)?.context("cleanup spawn request missing")?;
        let request = serde_json::from_str(&line).context("invalid cleanup spawn request")?;
        let code = kcoder_process_supervisor::windows::run_with_cleanup_receipt(request, input)?;
        std::process::exit(code as i32);
    }
    #[cfg(target_os = "linux")]
    {
        let arguments = std::env::args_os().collect::<Vec<_>>();
        if arguments.get(1).is_some_and(|arg| {
            arg == kcoder_process_supervisor::linux_stdio::INTERNAL_STDIO_OWNER_V1
                || arg == kcoder_process_supervisor::linux_stdio::INTERNAL_COMMAND_OWNER_V1
                || arg == kcoder_process_supervisor::linux_stdio::INTERNAL_COMMAND_OWNER_RECEIPT_V1
        }) {
            let code = kcoder_process_supervisor::linux_stdio::entry(&arguments)?;
            std::process::exit(code);
        }
    }
    let stdin = std::io::stdin();
    let mut input = BufReader::new(stdin);
    let line = read_protocol_line(&mut input)?.context("spawn request is missing")?;
    let request: SpawnRequest = serde_json::from_str(&line).context("invalid spawn request")?;
    request.validate()?;
    #[cfg(windows)]
    {
        let exit_code = kcoder_process_supervisor::windows::run(request, input)?;
        std::process::exit(exit_code as i32);
    }
    #[cfg(not(windows))]
    anyhow::bail!("kcoder-process-supervisor is only available on Windows")
}

#[cfg(not(windows))]
fn bounded_error(message: &str) -> &str {
    let mut end = message.len().min(4096);
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    &message[..end]
}
