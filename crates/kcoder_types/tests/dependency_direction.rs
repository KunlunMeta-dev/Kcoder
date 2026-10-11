//! Inspect Cargo's resolved manifest declarations, including renamed dependencies
//! and target/dev/build tables, rather than guessing TOML with a line scanner.
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Command,
};

const CONTRACT_CRATES: &[&str] = &["kcoder_types", "kcoder_config", "kcoder_app_protocol"];
const FORBIDDEN: &[&str] = &["kcoder_engine", "kcoder_repl", "kcoder_cli", "kcoder_query"];

fn metadata(manifest: &Path) -> Value {
    let output = Command::new(env!("CARGO"))
        .args([
            "metadata",
            "--offline",
            "--no-deps",
            "--format-version",
            "1",
            "--manifest-path",
        ])
        .arg(manifest)
        .output()
        .expect("Cargo metadata must run");
    assert!(
        output.status.success(),
        "Cargo metadata failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("valid Cargo metadata")
}

fn violations(metadata: &Value) -> Vec<String> {
    let mut result = Vec::new();
    for package in metadata["packages"].as_array().expect("metadata packages") {
        let name = package["name"].as_str().expect("package name");
        if !CONTRACT_CRATES.contains(&name) {
            continue;
        }
        for dependency in package["dependencies"].as_array().expect("dependencies") {
            // `name` is the actual package, `rename` is the optional local alias.
            let dependency = dependency["name"]
                .as_str()
                .expect("dependency package name");
            if FORBIDDEN.contains(&dependency) {
                result.push(format!("{name} -> {dependency}"));
            }
        }
    }
    result
}

#[test]
fn contract_crates_never_depend_back_on_engine_or_ui() {
    let root = PathBuf::from(std::env::var_os("KCODER_WORKSPACE_ROOT").expect("workspace root"));
    assert_eq!(
        violations(&metadata(&root.join("Cargo.toml"))),
        Vec::<String>::new()
    );
}

#[test]
fn real_cargo_alias_and_expanded_target_dependency_mutations_are_detected() {
    let root = std::env::temp_dir().join(format!(
        "kcoder-dependency-guard-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(root.clone());
    for name in ["kcoder_types", "kcoder_engine", "safe_contract"] {
        let dir = root.join(name);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/lib.rs"), "").unwrap();
        std::fs::write(
            dir.join("Cargo.toml"),
            format!("[package]\nname = '{name}'\nversion = '0.0.0'\nedition = '2021'\n"),
        )
        .unwrap();
    }
    let manifest = root.join("kcoder_types/Cargo.toml");
    let base = std::fs::read_to_string(&manifest).unwrap();
    let cases = [
        (
            "[dependencies]\nalias = { package = 'safe_contract', path = '../safe_contract' }\n",
            false,
        ),
        (
            "[dependencies]\nalias = { package = 'kcoder_engine', path = '../kcoder_engine' }\n",
            true,
        ),
        (
            "[dev-dependencies.alias]\npackage = 'kcoder_engine'\npath = '../kcoder_engine'\n",
            true,
        ),
        (
            "[target.'cfg(windows)'.build-dependencies.alias]\npackage = 'kcoder_engine'\npath = '../kcoder_engine'\n",
            true,
        ),
    ];
    for (mutation, forbidden) in cases {
        std::fs::write(&manifest, format!("{base}{mutation}")).unwrap();
        assert_eq!(
            !violations(&metadata(&manifest)).is_empty(),
            forbidden,
            "{mutation}"
        );
    }
}
