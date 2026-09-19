use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn git_output(workspace: &PathBuf, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(workspace)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn main() {
    println!("cargo:rerun-if-env-changed=KCODER_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=KCODER_BUILD_DIRTY");
    println!("cargo:rerun-if-env-changed=KCODER_BUILD_TIME_UNIX");

    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let workspace = manifest.join("../..");
    let git_dir = workspace.join(".git");
    if git_dir.is_dir() {
        println!("cargo:rerun-if-changed={}", git_dir.join("HEAD").display());
        println!("cargo:rerun-if-changed={}", git_dir.join("index").display());
    }

    let commit = std::env::var("KCODER_BUILD_COMMIT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| git_output(&workspace, &["rev-parse", "HEAD"]))
        .unwrap_or_else(|| "unknown".to_string());
    let dirty = std::env::var("KCODER_BUILD_DIRTY")
        .ok()
        .map(|value| value.trim().eq_ignore_ascii_case("true") || value.trim() == "1")
        .unwrap_or_else(|| {
            git_output(
                &workspace,
                &["status", "--porcelain", "--untracked-files=no"],
            )
            .map(|status| !status.is_empty())
            .unwrap_or(true)
        });
    let build_time_unix = std::env::var("KCODER_BUILD_TIME_UNIX")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        });

    println!("cargo:rustc-env=KCODER_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=KCODER_BUILD_DIRTY={dirty}");
    println!("cargo:rustc-env=KCODER_BUILD_TIME_UNIX={build_time_unix}");
}
