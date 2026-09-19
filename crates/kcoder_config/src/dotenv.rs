use crate::{set_user_only_dir_permissions, set_user_only_file_permissions};
use anyhow::{Context, Result, bail};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const USER_DOTENV_FILENAME: &str = ".env";
pub const DEFAULT_USER_DOTENV: &str = include_str!("../../../.env.example");

pub fn user_dotenv_path(config_dir: &Path) -> PathBuf {
    config_dir.join(USER_DOTENV_FILENAME)
}

pub fn write_user_dotenv_if_missing(config_dir: &Path, contents: &str) -> Result<bool> {
    fs::create_dir_all(config_dir).with_context(|| {
        format!(
            "failed to create user configuration directory {}",
            config_dir.display()
        )
    })?;
    set_user_only_dir_permissions(config_dir)?;

    let path = user_dotenv_path(config_dir);
    let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(&path)
                .with_context(|| format!("failed to inspect user dotenv {}", path.display()))?;
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                bail!("user dotenv is not a regular file: {}", path.display());
            }
            set_user_only_file_permissions(&path)?;
            return Ok(false);
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to create user dotenv {}", path.display()));
        }
    };

    if let Err(error) = set_user_only_file_permissions(&path)
        .and_then(|_| {
            file.write_all(contents.as_bytes())
                .with_context(|| format!("failed to write user dotenv {}", path.display()))
        })
        .and_then(|_| {
            file.sync_all()
                .with_context(|| format!("failed to sync user dotenv {}", path.display()))
        })
    {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(true)
}

pub fn ensure_default_user_dotenv(config_dir: &Path) -> Result<PathBuf> {
    write_user_dotenv_if_missing(config_dir, DEFAULT_USER_DOTENV)?;
    Ok(user_dotenv_path(config_dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn default_dotenv_is_created_from_embedded_example() {
        let temp = TempDir::new().unwrap();
        let config_dir = temp.path().join("config");

        let path = ensure_default_user_dotenv(&config_dir).unwrap();

        assert_eq!(path, config_dir.join(".env"));
        assert_eq!(fs::read_to_string(path).unwrap(), DEFAULT_USER_DOTENV);
    }

    #[test]
    fn existing_dotenv_is_never_replaced() {
        let temp = TempDir::new().unwrap();
        let config_dir = temp.path().join("config");
        fs::create_dir_all(&config_dir).unwrap();
        let path = config_dir.join(".env");
        fs::write(&path, "MINIMAX_API_KEY=existing\n").unwrap();

        assert!(!write_user_dotenv_if_missing(&config_dir, "replacement\n").unwrap());
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "MINIMAX_API_KEY=existing\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn dotenv_permissions_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempDir::new().unwrap();
        let path = ensure_default_user_dotenv(&temp.path().join("config")).unwrap();

        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

/// True for credential-shaped environment keys (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, ...).
///
/// Shared by the bundled-dotenv sanitizer and the storage diagnostics report so
/// both agree on what counts as a secret.
pub fn looks_like_credential_env_key(key: &str) -> bool {
    let key = key.trim().to_ascii_uppercase();
    const SUFFIXES: [&str; 6] = [
        "_API_KEY",
        "_TOKEN",
        "_SECRET",
        "_PASSWORD",
        "_PASSWD",
        "_CREDENTIAL",
    ];
    const EXACT: [&str; 5] = ["API_KEY", "TOKEN", "SECRET", "PASSWORD", "AUTHORIZATION"];
    SUFFIXES.iter().any(|suffix| key.ends_with(suffix)) || EXACT.contains(&key.as_str())
}

#[cfg(test)]
mod credential_key_tests {
    use super::*;

    #[test]
    fn credential_env_keys_are_detected_case_insensitively() {
        for key in [
            "KUNLUNMETA_BASE_API_KEY",
            "gateway_token",
            "My_Secret",
            "DB_PASSWORD",
            "API_KEY",
        ] {
            assert!(looks_like_credential_env_key(key), "{key}");
        }
        for key in ["HTTPS_PROXY", "NO_PROXY", "KCODER_CONFIG_DIR", "DEV_DEBUG"] {
            assert!(!looks_like_credential_env_key(key), "{key}");
        }
    }
}
