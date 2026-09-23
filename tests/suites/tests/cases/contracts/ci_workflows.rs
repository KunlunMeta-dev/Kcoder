use std::path::PathBuf;
use std::process::Command;

fn workspace_root() -> PathBuf {
    kcoder_test_harness::workspace_root().expect("应解析当前 KCoder 工作区")
}

#[test]
fn every_github_workflow_is_valid_yaml() {
    let workspace = workspace_root();
    let workflows = workspace.join(".github/workflows");
    let mut paths = std::fs::read_dir(&workflows)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("yml" | "yaml")
            )
        })
        .collect::<Vec<PathBuf>>();
    paths.sort();
    assert!(!paths.is_empty(), "CI workflow 目录必须包含 YAML 文件");

    for path in paths {
        let source = std::fs::read_to_string(&path).unwrap();
        let document: serde_yaml::Value = serde_yaml::from_str(&source)
            .unwrap_or_else(|error| panic!("{} 不是合法 YAML: {error}", path.display()));
        assert!(
            document.is_mapping(),
            "{} 的 YAML 根必须是 mapping",
            path.display()
        );
    }
}

#[test]
fn public_documentation_excludes_host_specific_product_history() {
    let workspace = workspace_root();
    let output = Command::new("git")
        .args(["ls-files", "--", "*.md", "*.txt", "*.rst"])
        .current_dir(&workspace)
        .output()
        .expect("应能枚举受版本控制的公开文档");
    assert!(output.status.success(), "git ls-files 必须成功");

    let account = ["h", "yf"].concat();
    let historical_implementation = ["Go", "/", "Crush"].concat();
    let historical_config = ["Go", " ", "版"].concat();
    let forbidden = [
        account,
        historical_implementation,
        historical_config,
        ["/home/", "lrs"].concat(),
    ];
    let paths = String::from_utf8(output.stdout).expect("文档路径必须是 UTF-8");
    for relative in paths.lines().filter(|line| !line.is_empty()) {
        let path = workspace.join(relative);
        if !path.is_file() {
            continue;
        }
        let source = std::fs::read_to_string(path)
            .unwrap_or_else(|error| panic!("无法读取公开文档 {relative}: {error}"));
        for value in &forbidden {
            assert!(
                !source.contains(value),
                "公开文档 {relative} 不得包含部署主机历史信息"
            );
        }
    }
}

#[test]
fn public_documentation_uses_kcoder_as_its_product_identity() {
    let workspace = workspace_root();
    // The public snapshot's canonical product document is the root README.
    // Internal audit notes are not published, and runtime skills / third-party
    // attribution must retain truthful upstream and protocol references.
    let readme = std::fs::read_to_string(workspace.join("README.md"))
        .expect("canonical public README must exist");
    let title = readme.lines().find(|line| !line.trim().is_empty()).unwrap();
    assert_eq!(title.trim(), "# KCoder", "public product identity must be KCoder");
    assert!(readme.contains("KCoder Studio"));
    assert!(readme.contains("`kcoder`"), "public CLI entry must be kcoder");
    let attribution = std::fs::read_to_string(
        workspace.join("apps/kcoder-studio/renderer/UPSTREAM.md"),
    ).expect("packaged upstream attribution must be retained");
    assert!(attribution.contains("Apache License 2.0") && attribution.contains("LICENSE.upstream"),
        "branding must not erase third-party attribution");
}

#[test]
fn tracked_text_never_restores_retired_product_identifiers() {
    let workspace = workspace_root();
    let output = Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(&workspace)
        .output()
        .expect("应能枚举受版本控制的文件");
    assert!(output.status.success(), "git ls-files 必须成功");

    let retired_stem = String::from_utf8(vec![107, 117, 110, 108, 117, 110]).unwrap();
    let forbidden = [
        format!("{retired_stem}code"),
        format!("{retired_stem} code"),
        format!("{retired_stem}-code"),
        format!("{retired_stem}_code"),
        format!(".{retired_stem}/"),
        format!("{retired_stem}.md"),
    ];
    for relative in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        let Ok(relative) = std::str::from_utf8(relative) else {
            continue;
        };
        let path = workspace.join(relative);
        let Ok(source) = std::fs::read_to_string(&path) else {
            continue;
        };
        let normalized = source.to_lowercase();
        for value in &forbidden {
            assert!(
                !normalized.contains(value),
                "受版本控制的文本文件 {relative} 不得恢复已退役产品标识"
            );
        }
    }
}

#[test]
fn tests_resolve_workspace_paths_at_runtime() {
    let workspace = workspace_root();
    let compile_time_lookup = ["env!(\"CARGO_", "MANIFEST_DIR\")"].concat();
    let allowed = "apps/kcoder-studio/renderer/src-tauri/src/lib.rs";
    let output = Command::new("git")
        .args(["ls-files", "-z", "--", "*.rs"])
        .current_dir(&workspace)
        .output()
        .expect("应能枚举 Rust 源文件");
    assert!(output.status.success(), "git ls-files 必须成功");

    for relative in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        let relative = std::str::from_utf8(relative).expect("Rust 路径必须是 UTF-8");
        let path = workspace.join(relative);
        if !path.is_file() {
            continue;
        }
        let source = std::fs::read_to_string(path).unwrap();
        if relative == allowed {
            assert!(
                source.contains(&compile_time_lookup),
                "Tauri include_bytes 仍应在编译期嵌入图标"
            );
        } else {
            assert!(
                !source.contains(&compile_time_lookup),
                "测试路径不得把 checkout 绝对路径缓存进编译产物: {relative}"
            );
        }
    }
}

#[test]
fn build_identity_ignores_untracked_workspace_files() {
    let workspace = workspace_root();
    let source = std::fs::read_to_string(workspace.join("crates/kcoder_cli/build.rs"))
        .expect("应能读取 CLI build script");
    assert!(
        source.contains("\"--untracked-files=no\""),
        "build identity 只应由受版本控制文件的差异标记为 dirty"
    );
    assert!(
        !source.contains("\"--untracked-files=normal\""),
        "未跟踪的本机配置和缓存不得污染 release build identity"
    );
}

#[test]
fn release_publishes_only_the_windows_studio_installer() {
    let root = workspace_root();
    let source = std::fs::read_to_string(root.join(".github/workflows/release.yml")).unwrap();
    let workflow: serde_yaml::Value = serde_yaml::from_str(&source).unwrap();
    let jobs = workflow["jobs"].as_mapping().unwrap();
    assert_eq!(jobs.len(), 2, "release only builds Windows Studio and publishes it");
    assert_eq!(workflow["jobs"]["publish"]["needs"].as_str(), Some("studio-windows"));
    let steps = workflow["jobs"]["publish"]["steps"].as_sequence().unwrap();
    let publish = steps.iter().find(|step| step["uses"].as_str().unwrap_or("").starts_with("softprops/action-gh-release@")).unwrap();
    assert_eq!(publish["with"]["files"].as_str(), Some("artifacts/KCoder-Studio-Setup-*-win-x64.exe"));
    assert_eq!(publish["with"]["fail_on_unmatched_files"].as_bool(), Some(true));
    assert!(source.contains("target/packages/kcoder-studio/windows/win-unpacked"));
    assert!(!source.contains("apps/kcoder-studio/dist/win-unpacked"));
    assert!(!source.contains("desktop:remote:pack:win"));
    assert!(!source.contains("mobile:pack:web"));
}

#[test]
fn studio_dependency_build_policies_are_explicit_booleans() {
    let root = workspace_root();
    for path in ["apps/kcoder-studio/pnpm-workspace.yaml", "apps/kcoder-studio/renderer/pnpm-workspace.yaml"] {
        let source = std::fs::read_to_string(root.join(path)).unwrap();
        let policy: serde_yaml::Value = serde_yaml::from_str(&source).unwrap();
        for (name, allowed) in policy["allowBuilds"].as_mapping().expect("explicit build policy") {
            assert!(allowed.as_bool().is_some(), "{path}: {name:?} must not be an unanswered build policy");
        }
    }
}
