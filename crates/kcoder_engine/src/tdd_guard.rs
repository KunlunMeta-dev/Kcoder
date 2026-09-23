//! TDD gate: block or warn on write/edit tool calls that lack a corresponding test file.
//!
//! Legacy spec-driven projects keep the historical hard gate. Enhanced
//! `spec-driven-superpowers` changes read `review.md` `Execution Mode`:
//! `standard` disables the gate, `tdd-preferred` warns without blocking, and
//! `tdd-required` blocks writes without a matching test file. `KCODER_TDD_GATE`
//! still overrides project state, and the settings-level `tdd_gate` option
//! (`off`/`preferred`/`required`) sits between the env var and project state:
//! it can exempt the gate entirely (like Luna mode), force warn-only, or
//! force hard blocking without editing any project files.

use kcoder_config::TddGateSetting;
use serde_json::Value;
use std::path::{Path, PathBuf};

const WRITE_TOOLS: &[&str] = &["write", "edit", "apply_patch"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TddGateMode {
    Off,
    Preferred,
    Required,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TddGateDecision {
    Allow,
    Warn(String),
    Block(String),
}

impl TddGateDecision {
    pub fn should_activate_skill(&self) -> bool {
        !matches!(self, TddGateDecision::Allow)
    }
}

/// Return true when a tool call is relevant to the TDD workflow. This is used
/// to activate the TDD skill before the model receives any gate result.
pub fn should_activate_tdd_skill(
    tool_name: &str,
    input: &Value,
    cwd: &Path,
    setting: TddGateSetting,
) -> bool {
    if gate_mode(cwd, setting) == TddGateMode::Off || !is_write_tool(tool_name) {
        return false;
    }
    let Some(file_path) = input.get("file_path").and_then(|v| v.as_str()) else {
        return false;
    };
    let target = normalize_path(file_path, cwd);
    is_test_file(&target) || !test_candidates(&target, cwd).is_empty()
}

/// Return the TDD gate decision for a tool call.
pub fn decision(
    tool_name: &str,
    input: &Value,
    cwd: &Path,
    setting: TddGateSetting,
) -> TddGateDecision {
    let mode = gate_mode(cwd, setting);
    if mode == TddGateMode::Off || !is_write_tool(tool_name) {
        return TddGateDecision::Allow;
    }
    let Some(message) = missing_test_message(tool_name, input, cwd) else {
        return TddGateDecision::Allow;
    };

    match mode {
        TddGateMode::Off => TddGateDecision::Allow,
        TddGateMode::Preferred => TddGateDecision::Warn(format!(
            "TDD preferred: {message}\nContinuing because Execution Mode is tdd-preferred."
        )),
        TddGateMode::Required => TddGateDecision::Block(message),
    }
}

/// Return a blocking error message if the tool call violates the TDD gate.
pub fn check(
    tool_name: &str,
    input: &Value,
    cwd: &Path,
    setting: TddGateSetting,
) -> Option<String> {
    match decision(tool_name, input, cwd, setting) {
        TddGateDecision::Block(message) => Some(message),
        TddGateDecision::Allow | TddGateDecision::Warn(_) => None,
    }
}

/// Return a non-blocking warning if the tool call violates a preferred TDD mode.
pub fn warning(
    tool_name: &str,
    input: &Value,
    cwd: &Path,
    setting: TddGateSetting,
) -> Option<String> {
    match decision(tool_name, input, cwd, setting) {
        TddGateDecision::Warn(message) => Some(message),
        TddGateDecision::Allow | TddGateDecision::Block(_) => None,
    }
}

fn missing_test_message(tool_name: &str, input: &Value, cwd: &Path) -> Option<String> {
    let file_path = input.get("file_path").and_then(|v| v.as_str())?;
    let target = normalize_path(file_path, cwd);
    if is_test_file(&target) {
        return None;
    }

    let candidates = test_candidates(&target, cwd);
    if candidates.is_empty() {
        return None;
    }
    if candidates.iter().any(|p| p.exists()) {
        return None;
    }

    // Rust files may carry inline #[cfg(test)] modules in the same file.
    if target.extension().and_then(|e| e.to_str()) == Some("rs")
        && target.exists()
        && file_contains(&target, "#[cfg(test)]")
    {
        return None;
    }

    let expected = candidates
        .iter()
        .map(|p| {
            p.strip_prefix(cwd)
                .unwrap_or(p)
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect::<Vec<_>>()
        .join("\n  - ");

    Some(format!(
        "TDD gate: {} cannot write/edit '{}' without a corresponding test file.\n\
         Create one of these test files first (or set KCODER_TDD_GATE=0 to disable):\n  - {}",
        tool_name,
        target.display(),
        expected
    ))
}

fn is_write_tool(tool_name: &str) -> bool {
    WRITE_TOOLS.contains(&tool_name)
}

fn gate_mode(cwd: &Path, setting: TddGateSetting) -> TddGateMode {
    if std::env::var("KCODER_TDD_GATE").is_ok_and(|v| v == "0" || v.eq_ignore_ascii_case("false")) {
        return TddGateMode::Off;
    }
    if std::env::var("KCODER_TDD_GATE").is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true")) {
        return TddGateMode::Required;
    }
    // The settings-level override sits between the env var and project state:
    // `off` exempts the gate like Luna mode, `preferred`/`required` force the
    // corresponding behavior, and `auto` falls through to project resolution.
    match setting {
        TddGateSetting::Off => return TddGateMode::Off,
        TddGateSetting::Preferred => return TddGateMode::Preferred,
        TddGateSetting::Required => return TddGateMode::Required,
        TddGateSetting::Auto => {}
    }
    let Some(specs_root) = project_specs_root(cwd) else {
        return TddGateMode::Off;
    };
    project_gate_mode(&specs_root)
}

fn project_specs_root(cwd: &Path) -> Option<PathBuf> {
    cwd.ancestors()
        .map(|dir| dir.join(".kcoder").join("specs"))
        .find(|specs| specs.is_dir())
}

fn project_gate_mode(specs_root: &Path) -> TddGateMode {
    let changes_root = specs_root.join("changes");
    let mut modes = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&changes_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() || path.file_name().is_some_and(|name| name == "archive") {
                continue;
            }
            let meta = std::fs::read_to_string(path.join(".spec.yaml")).unwrap_or_default();
            let schema = yaml_scalar(&meta, "schema")
                .unwrap_or_else(|| project_config_schema(specs_root).unwrap_or_default());
            if !is_superpowers_schema(&schema) {
                return TddGateMode::Required;
            }
            modes.push(execution_mode_for_change(&path));
        }
    }

    match modes.as_slice() {
        [] => {
            if project_config_schema(specs_root)
                .as_deref()
                .is_some_and(is_superpowers_schema)
            {
                TddGateMode::Off
            } else {
                TddGateMode::Required
            }
        }
        [mode] => *mode,
        modes if modes.iter().all(|mode| *mode == TddGateMode::Off) => TddGateMode::Off,
        modes if modes.iter().all(|mode| *mode != TddGateMode::Required) => TddGateMode::Preferred,
        _ => TddGateMode::Required,
    }
}

fn project_config_schema(specs_root: &Path) -> Option<String> {
    let config = std::fs::read_to_string(specs_root.join("config.yaml")).ok()?;
    yaml_scalar(&config, "schema")
}

fn is_superpowers_schema(schema: &str) -> bool {
    matches!(
        schema.trim().to_ascii_lowercase().as_str(),
        "spec-driven-superpowers" | "kcoder-spec-driven-superpowers"
    )
}

fn execution_mode_for_change(change_dir: &Path) -> TddGateMode {
    let review = std::fs::read_to_string(change_dir.join("review.md")).unwrap_or_default();
    match markdown_section_value(&review, "Execution Mode")
        .unwrap_or_else(|| "standard".to_string())
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "tdd-required" => TddGateMode::Required,
        "tdd-preferred" => TddGateMode::Preferred,
        "standard" | "" => TddGateMode::Off,
        _ => TddGateMode::Required,
    }
}

fn yaml_scalar(content: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    for line in content.lines() {
        let trimmed = line.trim_start();
        let Some(rest) = trimmed.strip_prefix(&prefix) else {
            continue;
        };
        let value = rest.trim().trim_matches('"').trim_matches('\'').to_string();
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

fn markdown_section_value(content: &str, title: &str) -> Option<String> {
    let wanted = format!("## {}", title);
    let mut collecting = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case(&wanted) {
            collecting = true;
            continue;
        }
        if collecting && trimmed.starts_with("## ") {
            break;
        }
        if collecting
            && !trimmed.is_empty()
            && !trimmed.starts_with("<!--")
            && !trimmed.starts_with("-->")
        {
            return Some(
                trimmed
                    .trim_start_matches("- ")
                    .trim_start_matches("* ")
                    .trim()
                    .to_string(),
            );
        }
    }
    None
}

fn normalize_path(raw: &str, cwd: &Path) -> PathBuf {
    let p = Path::new(raw);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        cwd.join(p)
    }
}

fn is_test_file(path: &Path) -> bool {
    let lossy = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    if lossy.contains("/test/")
        || lossy.contains("/tests/")
        || lossy.contains("/__tests__/")
        || lossy.contains(".test.")
        || lossy.contains("_test.")
        || lossy.contains(".spec.")
        || lossy.contains("_spec.")
    {
        return true;
    }
    let name = path
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    name.starts_with("test_") || name.starts_with("tests_")
}

fn test_candidates(target: &Path, cwd: &Path) -> Vec<PathBuf> {
    let ext = target.extension().and_then(|e| e.to_str()).unwrap_or("");
    let stem = target.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let parent = target.parent().unwrap_or(Path::new(""));
    let rel_parent = parent.strip_prefix(cwd).unwrap_or(parent);
    let absolute_parent = if parent.is_absolute() {
        parent.to_path_buf()
    } else {
        cwd.join(parent)
    };

    let mut candidates = Vec::new();
    match ext {
        "rs" => {
            candidates.push(rel_parent.join(format!("{}.test.rs", stem)));
            candidates.push(Path::new("tests").join(format!("{}.rs", stem)));
            candidates.push(Path::new("tests").join(format!("{}_test.rs", stem)));
            candidates.push(
                rel_parent
                    .join("__tests__")
                    .join(format!("{}.test.rs", stem)),
            );
            // Cargo integration tests live beside the nearest Cargo.toml.
            // Locate the actual crate root: a fixed ancestor limit misses
            // deeply nested modules, while accepting every ancestor can let
            // an unrelated workspace-level test falsely satisfy the guard.
            if let Some(crate_root) = absolute_parent
                .ancestors()
                .take_while(|ancestor| ancestor.starts_with(cwd))
                .find(|ancestor| ancestor.join("Cargo.toml").is_file())
            {
                candidates.push(crate_root.join("tests").join(format!("{}.rs", stem)));
                candidates.push(crate_root.join("tests").join(format!("{}_test.rs", stem)));
            }
        }
        "ts" | "tsx" | "js" | "jsx" => {
            candidates.push(
                rel_parent
                    .join("__tests__")
                    .join(format!("{}.test.{}", stem, ext)),
            );
            candidates.push(
                rel_parent
                    .join("__tests__")
                    .join(format!("{}.spec.{}", stem, ext)),
            );
            candidates.push(Path::new("tests").join(format!("{}.test.{}", stem, ext)));
            candidates.push(Path::new("tests").join(format!("{}.spec.{}", stem, ext)));
        }
        "py" => {
            candidates.push(rel_parent.join(format!("test_{}.py", stem)));
            candidates.push(rel_parent.join(format!("{}_test.py", stem)));
            candidates.push(Path::new("tests").join(format!("test_{}.py", stem)));
        }
        "go" => {
            candidates.push(rel_parent.join(format!("{}_test.go", stem)));
        }
        "java" | "kt" => {
            candidates.push(
                rel_parent
                    .join("__tests__")
                    .join(format!("{}Test.{}", stem, ext)),
            );
            candidates.push(
                Path::new("src/test")
                    .join("java")
                    .join(format!("{}Test.java", stem)),
            );
        }
        _ => {}
    }
    candidates.into_iter().map(|p| cwd.join(p)).collect()
}

fn file_contains(path: &Path, needle: &str) -> bool {
    std::fs::read_to_string(path)
        .map(|s| s.contains(needle))
        .unwrap_or(false)
}

#[cfg(test)]
#[path = "tdd_guard/tests.rs"]
mod tests;
