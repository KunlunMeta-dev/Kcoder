//! Owned test adapter: preserve the actual Windows OpenSSH client and its pipes.
use std::{
    fs,
    path::PathBuf,
    process::{Command, Stdio},
};
fn main() -> std::io::Result<()> {
    let root = std::env::current_exe()?.parent().unwrap().to_path_buf();
    let real = PathBuf::from(fs::read_to_string(root.join("real-ssh-path.txt"))?.trim());
    let result = Command::new(real)
        .arg("-F")
        .arg(root.join("ssh-config"))
        .args(std::env::args_os().skip(1))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()?;
    std::process::exit(result.code().unwrap_or(1));
}
