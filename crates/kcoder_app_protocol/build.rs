use sha2::{Digest, Sha256};
use std::{env, fs, io, path::Path};

fn walk(directory: &Path, root: &Path, files: &mut Vec<String>, extension: &str) -> io::Result<()> {
    println!("cargo:rerun-if-changed={}", directory.display());
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            walk(&entry.path(), root, files, extension)?;
        } else if kind.is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|value| value == extension)
        {
            let relative = entry
                .path()
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if extension == "rs" || entry.file_name().to_string_lossy().starts_with("fixtures") {
                files.push(relative);
            }
        }
    }
    Ok(())
}

fn main() -> io::Result<()> {
    println!("cargo:rerun-if-changed=build.rs");
    if env::var_os("CARGO_FEATURE_JSON_SCHEMA").is_none() {
        return Ok(());
    }
    let manifest = env::var_os("CARGO_MANIFEST_DIR").unwrap();
    let root = Path::new(&manifest).parent().unwrap().parent().unwrap();
    let mut files: Vec<String> = [
        "Cargo.toml",
        "Cargo.lock",
        "crates/kcoder_app_protocol/Cargo.toml",
        "crates/kcoder_app_protocol/build.rs",
        "crates/kcoder_app_protocol/internal/channel_protocol/Cargo.toml",
        "crates/kcoder_app_protocol/internal/integration_protocol/Cargo.toml",
        "crates/kcoder_types/Cargo.toml",
        "crates/kcoder_types/internal/common_types/Cargo.toml",
        "crates/kcoder_types/internal/session_types/Cargo.toml",
        "crates/kcoder_types/internal/integration_types/Cargo.toml",
        "crates/kcoder_app_protocol/examples/export_contracts.rs",
        "scripts/contracts/source-receipt.mjs",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    walk(
        &root.join("crates/kcoder_app_protocol/src"),
        root,
        &mut files,
        "rs",
    )?;
    walk(
        &root.join("crates/kcoder_app_protocol/examples"),
        root,
        &mut files,
        "rs",
    )?;
    walk(
        &root.join("crates/kcoder_types/src"),
        root,
        &mut files,
        "rs",
    )?;
    walk(&root.join("scripts/contracts"), root, &mut files, "json")?;
    files.sort();
    files.dedup();
    let mut hash = Sha256::new();
    for file in files {
        let path = root.join(&file);
        println!("cargo:rerun-if-changed={}", path.display());
        let bytes = fs::read(path)?;
        hash.update(file.as_bytes());
        hash.update([0]);
        hash.update(bytes.len().to_string().as_bytes());
        hash.update([0]);
        hash.update(bytes);
    }
    println!(
        "cargo:rustc-env=KCODER_PROTOCOL_SOURCE_RECEIPT=protocol-source/v1:{:x}",
        hash.finalize()
    );
    Ok(())
}
