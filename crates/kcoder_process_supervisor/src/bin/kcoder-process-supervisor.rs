use anyhow::{Context, Result};
use kcoder_process_supervisor::protocol::{SpawnRequest, read_protocol_line};
use std::io::BufReader;

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
