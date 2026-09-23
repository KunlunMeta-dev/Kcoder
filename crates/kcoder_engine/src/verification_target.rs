#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct VerificationCommandTarget {
    pub(super) key: String,
    pub(super) display: String,
}

pub(super) fn verification_command_label(command: &str) -> Option<&'static str> {
    let normalized = command.to_ascii_lowercase();
    let normalized = normalized.trim();
    if normalized.contains("cargo test") {
        Some("cargo test")
    } else if normalized.contains("cargo check") {
        Some("cargo check")
    } else if normalized.contains("cargo clippy") {
        Some("cargo clippy")
    } else if normalized.contains("pytest") {
        Some("pytest")
    } else if normalized.contains("npm test") {
        Some("npm test")
    } else if normalized.contains("pnpm test") {
        Some("pnpm test")
    } else if normalized.contains("yarn test") {
        Some("yarn test")
    } else {
        None
    }
}

pub(super) fn verification_command_target(command: &str) -> Option<VerificationCommandTarget> {
    let tokens = command.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() {
        return None;
    }
    if let Some(target) = cargo_verification_target(&tokens) {
        return Some(target);
    }
    if let Some(target) = pytest_verification_target(&tokens) {
        return Some(target);
    }
    package_manager_test_target(&tokens)
}

pub(super) fn verification_target_from_tool_input(
    tool_name: &str,
    input: &Value,
) -> Option<VerificationCommandTarget> {
    if !is_shell_tool_name(tool_name)
        || input
            .get("run_in_background")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return None;
    }
    let command = input.get("command").and_then(Value::as_str)?;
    verification_command_target(command)
}

fn cargo_verification_target(tokens: &[&str]) -> Option<VerificationCommandTarget> {
    let cargo_idx = tokens.iter().position(|token| *token == "cargo")?;
    let subcommand = *tokens.get(cargo_idx + 1)?;
    if !matches!(subcommand, "test" | "check" | "clippy") {
        return None;
    }

    let mut package = None;
    let mut filter = None;
    let mut idx = cargo_idx + 2;
    while idx < tokens.len() {
        let token = tokens[idx];
        if token == "--" || matches!(token, "&&" | ";" | "||") {
            break;
        }
        match token {
            "-p" | "--package" => {
                package = tokens.get(idx + 1).copied();
                idx += 2;
            }
            "--features" | "--target" | "--manifest-path" | "--test" | "--bin" | "--example" => {
                idx += 2;
            }
            token if token.starts_with("-p") && token.len() > 2 => {
                package = Some(&token[2..]);
                idx += 1;
            }
            token if token.starts_with('-') => {
                idx += 1;
            }
            token if subcommand == "test" && filter.is_none() => {
                filter = Some(token);
                idx += 1;
            }
            _ => {
                idx += 1;
            }
        }
    }

    let mut parts = vec!["cargo".to_string(), subcommand.to_string()];
    if let Some(package) = package {
        parts.push("-p".to_string());
        parts.push(package.to_string());
    }
    if subcommand == "test"
        && let Some(filter) = filter
    {
        parts.push(filter.to_string());
    }
    Some(verification_target(parts))
}

fn pytest_verification_target(tokens: &[&str]) -> Option<VerificationCommandTarget> {
    let pytest_idx = tokens
        .iter()
        .position(|token| matches!(*token, "pytest" | "python" | "python3"))?;
    let mut idx = pytest_idx;
    if matches!(tokens[pytest_idx], "python" | "python3") {
        if tokens.get(pytest_idx + 1) != Some(&"-m")
            || tokens.get(pytest_idx + 2) != Some(&"pytest")
        {
            return None;
        }
        idx = pytest_idx + 2;
    }

    let mut target = None;
    let mut cursor = idx + 1;
    while cursor < tokens.len() {
        let token = tokens[cursor];
        if matches!(token, "&&" | ";" | "||") {
            break;
        }
        if matches!(token, "-k" | "-m" | "--maxfail" | "--tb") {
            cursor += 2;
            continue;
        }
        if token.starts_with('-') {
            cursor += 1;
            continue;
        }
        target = Some(token);
        break;
    }

    let mut parts = vec!["pytest".to_string()];
    if let Some(target) = target {
        parts.push(target.to_string());
    }
    Some(verification_target(parts))
}

fn package_manager_test_target(tokens: &[&str]) -> Option<VerificationCommandTarget> {
    let first = tokens.first().copied()?;
    let second = tokens.get(1).copied();
    match (first, second) {
        ("npm", Some("test")) => Some(verification_target(vec!["npm".into(), "test".into()])),
        ("pnpm", Some("test")) => Some(verification_target(vec!["pnpm".into(), "test".into()])),
        ("yarn", Some("test")) => Some(verification_target(vec!["yarn".into(), "test".into()])),
        _ => None,
    }
}

fn verification_target(parts: Vec<String>) -> VerificationCommandTarget {
    let display = parts.join(" ");
    VerificationCommandTarget {
        key: display.to_ascii_lowercase(),
        display,
    }
}
use serde_json::Value;

use crate::tool_file_observation::is_shell_tool_name;
