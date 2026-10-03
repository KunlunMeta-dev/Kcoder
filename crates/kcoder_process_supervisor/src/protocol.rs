use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::BufRead;
use std::path::Path;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_PROTOCOL_LINE_BYTES: usize = 1024 * 1024;
pub const MAX_NONCE_BYTES: usize = 128;
pub const MAX_PATH_BYTES: usize = 32 * 1024;
pub const MAX_ARGUMENTS: usize = 4096;
pub const MAX_ARGUMENT_BYTES: usize = 64 * 1024;
pub const MAX_ENVIRONMENT_ENTRIES: usize = 8192;
pub const MAX_ENVIRONMENT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpawnRequest {
    pub version: u32,
    pub nonce: String,
    pub executable: String,
    pub cwd: String,
    pub status_file: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command", deny_unknown_fields)]
pub enum ControlRequest {
    #[serde(rename = "START")]
    Start { version: u32, nonce: String },
    #[serde(rename = "KILL")]
    Kill { version: u32, nonce: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "event")]
pub enum SupervisorEvent<'a> {
    #[serde(rename = "READY")]
    Ready {
        version: u32,
        nonce: &'a str,
        pid: u32,
    },
    #[serde(rename = "EXIT")]
    Exit { code: u32 },
    #[serde(rename = "ERROR")]
    Error { code: &'a str, message: &'a str },
}

impl SpawnRequest {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.version == PROTOCOL_VERSION,
            "unsupported protocol version"
        );
        validate_nonce(&self.nonce)?;
        validate_absolute_path("executable", &self.executable)?;
        validate_absolute_path("cwd", &self.cwd)?;
        validate_absolute_path("status_file", &self.status_file)?;
        anyhow::ensure!(self.args.len() <= MAX_ARGUMENTS, "too many arguments");
        for argument in &self.args {
            validate_text("argument", argument, MAX_ARGUMENT_BYTES)?;
        }
        anyhow::ensure!(
            self.env.len() <= MAX_ENVIRONMENT_ENTRIES,
            "too many environment entries"
        );
        let mut environment_bytes = 0usize;
        let mut normalized_names = std::collections::BTreeSet::new();
        for (name, value) in &self.env {
            anyhow::ensure!(!name.is_empty(), "invalid environment name");
            // Windows hidden drive-current-directory variables such as `=C:` are internal
            // system state. Accept only ordinary explicit environment entries so callers cannot forge or leak that state.
            anyhow::ensure!(
                !name.starts_with('='),
                "hidden drive environment is forbidden"
            );
            anyhow::ensure!(!name.contains('='), "invalid environment name");
            validate_text("environment name", name, MAX_ARGUMENT_BYTES)?;
            validate_text("environment value", value, MAX_ARGUMENT_BYTES)?;
            anyhow::ensure!(
                normalized_names.insert(windows_environment_key(name)),
                "duplicate environment name under Windows case-insensitive rules"
            );
            environment_bytes = environment_bytes
                .saturating_add(name.len())
                .saturating_add(value.len())
                .saturating_add(2);
        }
        anyhow::ensure!(
            environment_bytes <= MAX_ENVIRONMENT_BYTES,
            "environment is too large"
        );
        Ok(())
    }
}

pub(crate) fn windows_environment_key(name: &str) -> String {
    name.chars().flat_map(char::to_uppercase).collect()
}

impl ControlRequest {
    pub fn validate(&self, expected_nonce: &str) -> Result<()> {
        let (version, nonce) = match self {
            Self::Start { version, nonce } | Self::Kill { version, nonce } => (version, nonce),
        };
        anyhow::ensure!(*version == PROTOCOL_VERSION, "unsupported protocol version");
        validate_nonce(nonce)?;
        anyhow::ensure!(nonce == expected_nonce, "control nonce mismatch");
        Ok(())
    }
}

pub fn read_protocol_line<R: BufRead>(reader: &mut R) -> Result<Option<String>> {
    let available = reader.fill_buf()?;
    if available.is_empty() {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            break;
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let payload = newline.map_or(available, |index| &available[..index]);
        anyhow::ensure!(
            bytes.len().saturating_add(payload.len()) <= MAX_PROTOCOL_LINE_BYTES,
            "protocol line is too large"
        );
        bytes.extend_from_slice(payload);
        reader.consume(consumed);
        if newline.is_some() {
            break;
        }
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    String::from_utf8(bytes)
        .map(Some)
        .context("protocol line is not valid UTF-8")
}

fn validate_nonce(nonce: &str) -> Result<()> {
    validate_text("nonce", nonce, MAX_NONCE_BYTES)?;
    anyhow::ensure!(
        !nonce.is_empty()
            && nonce
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
        "invalid nonce"
    );
    Ok(())
}

fn validate_absolute_path(label: &str, value: &str) -> Result<()> {
    validate_text(label, value, MAX_PATH_BYTES)?;
    anyhow::ensure!(Path::new(value).is_absolute(), "{label} must be absolute");
    Ok(())
}

fn validate_text(label: &str, value: &str, max_bytes: usize) -> Result<()> {
    anyhow::ensure!(!value.contains('\0'), "{label} contains NUL");
    anyhow::ensure!(value.len() <= max_bytes, "{label} is too long");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_request() -> SpawnRequest {
        SpawnRequest {
            version: 1,
            nonce: "nonce-1".into(),
            executable: if cfg!(windows) {
                r"C:\tool.exe"
            } else {
                "/tool"
            }
            .into(),
            cwd: if cfg!(windows) {
                r"C:\workspace"
            } else {
                "/workspace"
            }
            .into(),
            status_file: if cfg!(windows) {
                r"C:\private\status.jsonl"
            } else {
                "/private/status.jsonl"
            }
            .into(),
            args: vec!["你好 world".into()],
            env: BTreeMap::from([("UNICODE_VALUE".into(), "昆仑".into())]),
        }
    }

    #[test]
    fn request_validation_rejects_unknown_fields_nul_and_relative_paths() {
        assert!(valid_request().validate().is_ok());
        let unknown = r#"{"version":1,"nonce":"n","executable":"/x","cwd":"/","status_file":"/s","args":[],"env":{},"extra":true}"#;
        assert!(serde_json::from_str::<SpawnRequest>(unknown).is_err());
        let mut request = valid_request();
        request.executable = "relative".into();
        assert!(request.validate().is_err());
        request.executable = if cfg!(windows) {
            r"C:\tool.exe"
        } else {
            "/tool"
        }
        .into();
        request.args = vec!["bad\0argument".into()];
        assert!(request.validate().is_err());
    }

    #[test]
    fn bounded_reader_handles_split_lines_and_rejects_large_input() {
        let mut split = std::io::BufReader::with_capacity(2, &b"abc\ndef\n"[..]);
        assert_eq!(
            read_protocol_line(&mut split).unwrap().as_deref(),
            Some("abc")
        );
        assert_eq!(
            read_protocol_line(&mut split).unwrap().as_deref(),
            Some("def")
        );
        let input = vec![b'x'; MAX_PROTOCOL_LINE_BYTES + 1];
        assert!(read_protocol_line(&mut std::io::BufReader::new(input.as_slice())).is_err());
    }

    #[test]
    fn environment_rejects_windows_case_duplicates_and_hidden_drive_entries() {
        let mut request = valid_request();
        request.env = BTreeMap::from([
            ("PATH".into(), "first".into()),
            ("Path".into(), "second".into()),
        ]);
        assert!(request.validate().is_err());

        request.env = BTreeMap::from([("=C:".into(), r"C:\workspace".into())]);
        assert!(request.validate().is_err());
    }
}
