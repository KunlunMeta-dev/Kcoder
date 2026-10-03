//! External editor integration for editing the current composer draft.

use anyhow::{Context, Result};
use std::env;
use std::error::Error;
use std::fmt;
use std::fs;
use std::path::Path;
use std::process::Stdio;
use tempfile::Builder;
use tokio::process::Command;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum EditorError {
    MissingEditor,
    ParseFailed,
    EmptyCommand,
}

impl fmt::Display for EditorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingEditor => write!(f, "neither VISUAL nor EDITOR is set"),
            Self::ParseFailed => write!(f, "failed to parse editor command"),
            Self::EmptyCommand => write!(f, "editor command is empty"),
        }
    }
}

impl Error for EditorError {}

pub(crate) fn resolve_editor_command() -> std::result::Result<Vec<String>, EditorError> {
    let visual = env::var("VISUAL").ok();
    let editor = env::var("EDITOR").ok();
    resolve_editor_command_from(visual.as_deref(), editor.as_deref())
}

pub(crate) fn resolve_editor_command_from(
    visual: Option<&str>,
    editor: Option<&str>,
) -> std::result::Result<Vec<String>, EditorError> {
    let raw = visual.or(editor).ok_or(EditorError::MissingEditor)?;
    let parts = split_editor_command(raw)?;
    if parts.is_empty() {
        return Err(EditorError::EmptyCommand);
    }
    Ok(parts)
}

fn split_editor_command(raw: &str) -> std::result::Result<Vec<String>, EditorError> {
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum Quote {
        None,
        Single,
        Double,
    }

    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote = Quote::None;
    let mut escaped = false;
    let mut in_token = false;

    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if escaped {
            current.push(ch);
            escaped = false;
            in_token = true;
            continue;
        }

        match quote {
            Quote::None => match ch {
                '\\' => {
                    if cfg!(windows)
                        && !chars
                            .peek()
                            .is_some_and(|next| next.is_whitespace() || matches!(next, '\'' | '"'))
                    {
                        // Backslashes are path separators in Windows editor
                        // commands unless they quote whitespace or a quote.
                        current.push(ch);
                    } else {
                        escaped = true;
                    }
                    in_token = true;
                }
                '\'' => {
                    quote = Quote::Single;
                    in_token = true;
                }
                '"' => {
                    quote = Quote::Double;
                    in_token = true;
                }
                ch if ch.is_whitespace() => {
                    if in_token {
                        parts.push(std::mem::take(&mut current));
                        in_token = false;
                    }
                }
                _ => {
                    current.push(ch);
                    in_token = true;
                }
            },
            Quote::Single => {
                if ch == '\'' {
                    quote = Quote::None;
                } else {
                    current.push(ch);
                }
            }
            Quote::Double => match ch {
                '\\' => {
                    if cfg!(windows) && chars.peek() != Some(&'"') {
                        current.push(ch);
                    } else {
                        escaped = true;
                    }
                    in_token = true;
                }
                '"' => {
                    quote = Quote::None;
                }
                _ => {
                    current.push(ch);
                }
            },
        }
    }

    if escaped || quote != Quote::None {
        return Err(EditorError::ParseFailed);
    }
    if in_token {
        parts.push(current);
    }

    Ok(parts)
}

pub(crate) async fn run_editor(seed: &str, editor_cmd: &[String]) -> Result<String> {
    if editor_cmd.is_empty() {
        anyhow::bail!("editor command is empty");
    }

    let temp_path = Builder::new()
        .suffix(".md")
        .tempfile()
        .context("failed to create editor temp file")?
        .into_temp_path();
    fs::write(&temp_path, seed)
        .with_context(|| format!("failed to write editor temp file {}", temp_path.display()))?;

    let mut cmd = Command::new(&editor_cmd[0]);
    if editor_cmd.len() > 1 {
        cmd.args(&editor_cmd[1..]);
    }
    let path: &Path = temp_path.as_ref();
    let status = cmd
        .arg(path)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .await
        .with_context(|| format!("failed to launch editor {}", editor_cmd[0]))?;
    if !status.success() {
        anyhow::bail!("editor exited with status {status}");
    }

    fs::read_to_string(&temp_path)
        .with_context(|| format!("failed to read editor temp file {}", temp_path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_prefers_visual_over_editor() {
        assert_eq!(
            resolve_editor_command_from(Some("code --wait"), Some("vim")).unwrap(),
            vec!["code", "--wait"]
        );
    }

    #[test]
    fn resolve_uses_editor_fallback() {
        assert_eq!(
            resolve_editor_command_from(None, Some("vim")).unwrap(),
            vec!["vim"]
        );
    }

    #[test]
    fn resolve_reports_missing_and_empty() {
        assert_eq!(
            resolve_editor_command_from(None, None),
            Err(EditorError::MissingEditor)
        );
        assert_eq!(
            resolve_editor_command_from(Some("  \t"), Some("vim")),
            Err(EditorError::EmptyCommand)
        );
    }

    #[test]
    fn split_supports_quotes_and_escapes() {
        assert_eq!(
            resolve_editor_command_from(
                Some("code --wait 'single arg' \"double arg\" escaped\\ space"),
                None,
            )
            .unwrap(),
            vec![
                "code",
                "--wait",
                "single arg",
                "double arg",
                "escaped space"
            ]
        );
    }

    #[test]
    fn split_reports_unclosed_quote() {
        assert_eq!(
            resolve_editor_command_from(Some("vim 'draft"), None),
            Err(EditorError::ParseFailed)
        );
    }

    #[cfg(windows)]
    #[test]
    fn split_preserves_windows_editor_path_backslashes() {
        assert_eq!(
            resolve_editor_command_from(
                Some(r#""C:\Program Files\Windows Editor\editor.exe" --wait"#),
                None,
            )
            .unwrap(),
            vec![r"C:\Program Files\Windows Editor\editor.exe", "--wait"]
        );
        assert_eq!(
            resolve_editor_command_from(Some(r"C:\Tools\editor.exe --wait"), None).unwrap(),
            vec![r"C:\Tools\editor.exe", "--wait"]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_editor_returns_updated_content() {
        let cmd = vec![
            "sh".to_string(),
            "-c".to_string(),
            "printf '%s\n' 'edited body' > \"$1\"".to_string(),
            "kcoder-editor-test".to_string(),
        ];

        let edited = run_editor("seed body", &cmd).await.unwrap();

        assert_eq!(edited, "edited body\n");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn run_editor_returns_updated_content_on_windows() {
        let editor_script = Builder::new()
            .suffix(".ps1")
            .tempfile()
            .unwrap()
            .into_temp_path();
        fs::write(
            &editor_script,
            "param([string]$Path)\n[IO.File]::WriteAllText($Path, 'edited windows body', [Text.UTF8Encoding]::new($false))\n",
        )
        .unwrap();
        let cmd = vec![
            "powershell.exe".to_string(),
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-File".to_string(),
            editor_script.to_string_lossy().into_owned(),
        ];

        let edited = run_editor("seed body", &cmd).await.unwrap();

        assert_eq!(edited, "edited windows body");
    }
}
