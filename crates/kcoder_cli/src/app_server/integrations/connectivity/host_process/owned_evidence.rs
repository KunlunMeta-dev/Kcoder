//! Bounded observations of this fixture's original Main process, never a lifecycle override.
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use std::{ffi::OsStr, path::Path, process::ExitStatus};

fn write(name: &str, bytes: &[u8]) -> Result<()> {
    let Some(path) = std::env::var_os("KCODER_CHANNEL_MAIN_EVIDENCE") else {
        return Ok(());
    };
    ensure!(bytes.len() <= 256 * 1024, "OWNED_MAIN_EVIDENCE_LIMIT");
    PrivateDirectory::open_existing(Path::new(&path))?.atomic_replace(OsStr::new(name), bytes)?;
    Ok(())
}
pub fn stderr(pid: u32, bytes: &[u8]) {
    if write(&format!("main-{pid}-stderr.bin"), bytes).is_err() {
        eprintln!("OWNED_MAIN_STDERR_EVIDENCE_UNCONFIRMED");
    }
}
pub fn exit(pid: u32, trigger: &str, result: &std::io::Result<ExitStatus>, cancelled: bool) {
    #[cfg(unix)]
    let signal = result.as_ref().ok().and_then(|status| {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    });
    #[cfg(not(unix))]
    let signal: Option<i32> = None;
    let value = serde_json::json!({"pid":pid,"trigger":trigger,"waitSucceeded":result.is_ok(),
        "exitCode":result.as_ref().ok().and_then(ExitStatus::code),"signal":signal,"rpcCancelled":cancelled});
    eprintln!("OWNED_ORIGINAL_MAIN_EXIT {}", value);
    let _ = write(
        &format!("main-{pid}-exit.json"),
        &serde_json::to_vec_pretty(&value).unwrap(),
    );
}
pub fn pipe(pid: u32, stage: &str, result: &anyhow::Result<()>) {
    use sha2::{Digest, Sha256};
    let value = serde_json::json!({"pid":pid,"stage":stage,"succeeded":result.is_ok(),
        "errorSha256":result.as_ref().err().map(|error|format!("{:x}",Sha256::digest(error.to_string().as_bytes())))});
    eprintln!("OWNED_ORIGINAL_MAIN_PIPE {}", value);
    let _ = write(
        &format!("main-{pid}-{stage}.json"),
        &serde_json::to_vec_pretty(&value).unwrap(),
    );
}
