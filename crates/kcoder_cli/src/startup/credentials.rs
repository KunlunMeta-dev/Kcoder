//! Credentials for the shared CLI composition root.

use super::*;

pub(crate) fn canonicalize_cli_cwd(cwd: PathBuf) -> PathBuf {
    dunce::canonicalize(&cwd).unwrap_or(cwd)
}

pub(crate) fn load_unified_user_dotenv(config_dir: &Path) -> Result<PathBuf> {
    let dotenv_path = ensure_default_user_dotenv(config_dir)?;
    dotenvy::from_path(&dotenv_path).with_context(|| {
        format!(
            "failed to load unified user environment from {}",
            dotenv_path.display()
        )
    })?;
    Ok(dotenv_path)
}

pub(crate) fn ensure_default_user_settings(cwd: &Path, config_dir: &Path) -> Result<PathBuf> {
    let paths = ConfigPaths::with_config_dir(cwd, config_dir.to_path_buf());
    let value = initial_config_scope_document(ConfigScope::User);
    write_scope_if_missing(&paths, ConfigScope::User, &value)?;
    Ok(paths.user_settings)
}

pub(crate) fn apply_credential_env_file(settings: &mut Settings, path: &Path) -> Result<()> {
    let values = dotenvy::from_path_iter(path)
        .with_context(|| format!("failed to read credential dotenv {}", path.display()))?
        .collect::<std::result::Result<HashMap<_, _>, _>>()
        .with_context(|| format!("failed to parse credential dotenv {}", path.display()))?;
    let find = |names: &[String]| {
        names
            .iter()
            .find_map(|name| values.get(name))
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let mut credentials = settings
        .provider_credential(None)
        .into_iter()
        .collect::<Vec<_>>();
    credentials.extend(
        settings
            .providers
            .iter()
            .map(|(id, provider)| provider.credential(id)),
    );
    credentials.extend(builtin_provider_credentials());
    for credential in credentials {
        if let Some(value) = find(&credential.env) {
            settings
                .credential_overrides
                .entry(credential.id)
                .or_insert(value);
        }
    }
    Ok(())
}

pub(crate) fn run_auth_action(
    action: AuthAction,
    cli: &Cli,
    settings: &Settings,
    paths: &ConfigPaths,
) -> Result<()> {
    match action {
        AuthAction::Status => run_auth_status(cli, settings, paths),
        AuthAction::Login {
            provider,
            api_key,
            env_file,
            store,
        } => {
            let credential = settings
                .provider_credential(Some(&provider))
                .ok_or_else(|| anyhow::anyhow!("invalid provider credential id '{provider}'"))?;
            let (api_key, source) = if let Some(value) = non_empty(api_key) {
                (value, "command line".to_string())
            } else if let Some(path) = env_file {
                let value = read_dotenv_api_key(&path, &credential)?.ok_or_else(|| {
                    anyhow::anyhow!(
                        "{} does not define {}",
                        path.display(),
                        credential.env.join(" or ")
                    )
                })?;
                (value, path.display().to_string())
            } else if let Some(value) = provider_process_environment_key(&credential) {
                (value, "environment".to_string())
            } else {
                (
                    rpassword::prompt_password(format!("API key for {}: ", credential.id))?,
                    "interactive input".to_string(),
                )
            };
            let api_key = api_key.trim();
            if api_key.is_empty() {
                bail!("API key cannot be empty");
            }
            let requested = store
                .as_deref()
                .map(CredentialStoreMode::parse)
                .transpose()?
                .unwrap_or(settings.credential_store);
            let backend = OsCredentialBackend::new();
            let keyring_available = backend.available();
            let use_keyring = match requested {
                CredentialStoreMode::Keyring => true,
                CredentialStoreMode::Auto => keyring_available,
                CredentialStoreMode::File => false,
            };
            if use_keyring && !keyring_available {
                bail!(
                    "the operating-system credential store is unavailable ({}); \
                     retry with --store file to keep the secret in {}{}",
                    backend.describe(),
                    paths.credentials.display(),
                    credential_store_reason(&backend, keyring_available),
                );
            }
            if use_keyring {
                CredentialStore::update_file(&paths.credentials, |credentials| {
                    backend.set(&credential.id, api_key)?;
                    credentials.set_api_key(&credential.id, marker_for_provider(&credential.id))
                })?;
                println!(
                    "Stored {} credentials from {} in {}; {} keeps only the reference",
                    credential.id,
                    source,
                    backend.describe(),
                    paths.credentials.display()
                );
            } else {
                CredentialStore::update_file(&paths.credentials, |credentials| {
                    credentials.set_api_key(&credential.id, api_key.to_string())
                })?;
                println!(
                    "Stored {} credentials from {} in {}",
                    credential.id,
                    source,
                    paths.credentials.display()
                );
                if requested == CredentialStoreMode::Auto {
                    println!(
                        "note: {} is unavailable, so the secret stays in plaintext; \
                         use --store keyring once the store is reachable",
                        backend.describe()
                    );
                }
            }
            Ok(())
        }
        AuthAction::Migrate { to } => migrate_provider_credentials(paths, &to),
        AuthAction::Import { env_file } => {
            let imported = import_dotenv_credentials(settings, paths, &env_file)?;
            if imported.is_empty() {
                println!(
                    "No configured provider credentials were found in {}",
                    env_file.display()
                );
            } else {
                println!(
                    "Imported {} provider credential(s) from {} into {}: {}",
                    imported.len(),
                    env_file.display(),
                    paths.credentials.display(),
                    imported.join(", ")
                );
            }
            Ok(())
        }
        AuthAction::Logout { provider } => {
            let backend = OsCredentialBackend::new();
            let outcome = logout_provider_credential(paths, &provider, settings, &backend)?;
            if let Some(note) = &outcome.store_note {
                eprintln!("{note}");
            }
            println!(
                "Removed stored {} credentials{}.",
                outcome.credential_id,
                if outcome.removed_from_store {
                    " and the entry in the operating-system credential store"
                } else {
                    ""
                }
            );
            Ok(())
        }
    }
}

pub(crate) fn import_dotenv_credentials(
    settings: &Settings,
    paths: &ConfigPaths,
    env_file: &Path,
) -> Result<Vec<String>> {
    let values = dotenvy::from_path_iter(env_file)
        .with_context(|| format!("failed to parse {}", env_file.display()))?
        .collect::<std::result::Result<HashMap<_, _>, _>>()
        .with_context(|| format!("failed to parse {}", env_file.display()))?;
    let mut available = builtin_provider_credentials()
        .into_iter()
        .map(|credential| (credential.id.clone(), credential))
        .collect::<BTreeMap<_, _>>();
    for (id, provider) in &settings.providers {
        let credential = provider.credential(id);
        available.insert(credential.id.clone(), credential);
    }

    let mut imports = Vec::new();
    let mut imported = Vec::new();
    for (id, credential) in available {
        let Some(api_key) = credential
            .env
            .iter()
            .find_map(|name| values.get(name))
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        imports.push((id.clone(), api_key.to_string()));
        imported.push(id);
    }
    if !imports.is_empty() {
        CredentialStore::update_file(&paths.credentials, |credentials| {
            for (id, api_key) in imports {
                credentials.set_api_key(&id, api_key)?;
            }
            Ok(())
        })?;
    }
    Ok(imported)
}

pub(crate) fn provider_process_environment_key(credential: &ProviderCredential) -> Option<String> {
    credential
        .env
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .and_then(|value| non_empty(Some(value)))
}

pub(crate) fn read_dotenv_api_key(
    path: &std::path::Path,
    credential: &ProviderCredential,
) -> Result<Option<String>> {
    if credential.env.is_empty() {
        return Ok(None);
    }
    let values = dotenvy::from_path_iter(path)
        .with_context(|| format!("failed to parse {}", path.display()))?
        .map(|entry| entry.with_context(|| format!("failed to parse {}", path.display())))
        .collect::<Result<std::collections::HashMap<_, _>>>()?;
    Ok(credential.env.iter().find_map(|name| {
        values
            .get(name)
            .cloned()
            .and_then(|value| non_empty(Some(value)))
    }))
}

/// Remove a stored credential from the document, and from the operating-system store when the
/// document only held a reference to it.
///
/// The id is first resolved through settings, but an id that only exists in the credential
/// document is accepted as-is: entries left behind by an older profile would otherwise be
/// impossible to remove.
pub(crate) fn logout_provider_credential(
    paths: &ConfigPaths,
    provider: &str,
    settings: &Settings,
    backend: &dyn CredentialBackend,
) -> Result<LogoutOutcome> {
    let credential_id = settings
        .provider_credential(Some(provider))
        .map(|credential| credential.id.clone())
        .unwrap_or_else(|| provider.to_string());
    let mut stored = None;
    CredentialStore::update_file(&paths.credentials, |credentials| {
        stored = credentials.credentials.get(&credential_id).cloned();
        let already_revoked = credentials.revoked.contains(&credential_id);
        if !credentials.remove_api_key(&credential_id)?
            && !already_revoked
            && settings
                .resolve_provider_api_key(Some(&credential_id), None)
                .is_none()
        {
            bail!("no stored credentials for {credential_id}");
        }
        Ok(())
    })?;
    let Some(account) = stored
        .as_deref()
        .and_then(kcoder_config::provider_from_marker)
    else {
        return Ok(LogoutOutcome {
            credential_id,
            removed_from_store: false,
            store_note: None,
        });
    };
    match backend.delete(account) {
        Ok(()) => Ok(LogoutOutcome {
            credential_id,
            removed_from_store: true,
            store_note: None,
        }),
        Err(error) => Ok(LogoutOutcome {
            credential_id,
            removed_from_store: false,
            store_note: Some(format!(
                "warning: the stored credential could not be deleted ({}: {error:#})",
                backend.describe()
            )),
        }),
    }
}

/// Suffix explaining why the operating-system credential store is unreachable.
pub(crate) fn credential_store_reason(backend: &OsCredentialBackend, available: bool) -> String {
    if available {
        return String::new();
    }
    match CredentialBackend::unavailable_reason(backend) {
        Some(reason) => format!(": {reason}"),
        None => String::new(),
    }
}

pub(crate) fn migrate_provider_credentials(paths: &ConfigPaths, to: &str) -> Result<()> {
    let direction = match to {
        "keyring" => MigrationDirection::ToKeyring,
        "file" => MigrationDirection::ToFile,
        other => bail!("invalid migration destination '{other}'"),
    };
    let backend = OsCredentialBackend::new();
    let keyring_available = CredentialBackend::available(&backend);
    if direction == MigrationDirection::ToKeyring && !keyring_available {
        bail!(
            "the operating-system credential store is unavailable ({}); no credential was moved{}",
            backend.describe(),
            credential_store_reason(&backend, keyring_available),
        );
    }
    let mut migration_report = None;
    CredentialStore::update_file(&paths.credentials, |credentials| {
        let (rewritten, report) =
            migrate_stored_credentials_wrapper(&credentials.credentials, &backend, direction);
        for moved in &report.moved {
            if let Some(value) = rewritten.get(moved) {
                credentials.set_api_key(moved, value.clone())?;
            }
        }
        migration_report = Some(report);
        Ok(())
    })?;
    let report = migration_report.context("credential migration produced no report")?;
    println!(
        "Migrated {} credential(s) to {to}: {}{}",
        report.moved.len(),
        if report.moved.is_empty() {
            "none".to_string()
        } else {
            report.moved.join(", ")
        },
        if report.skipped.is_empty() {
            String::new()
        } else {
            format!(" (already {to}: {})", report.skipped.join(", "))
        }
    );
    for failure in &report.failures {
        eprintln!("warning: {failure}");
    }
    ensure!(
        report.failures.is_empty(),
        "{} credential(s) could not be migrated",
        report.failures.len()
    );
    Ok(())
}

pub(crate) fn migrate_stored_credentials_wrapper(
    stored: &std::collections::BTreeMap<String, String>,
    backend: &dyn CredentialBackend,
    direction: MigrationDirection,
) -> (
    std::collections::BTreeMap<String, String>,
    kcoder_config::MigrationReport,
) {
    kcoder_config::migrate_stored_credentials(stored, backend, direction)
}

pub(crate) fn run_auth_status(cli: &Cli, settings: &Settings, paths: &ConfigPaths) -> Result<()> {
    let backend = OsCredentialBackend::new();
    let keyring_available = CredentialBackend::available(&backend);
    let stored = CredentialStore::load_from(&paths.credentials)?;
    let mut credentials = builtin_provider_credentials()
        .into_iter()
        .map(|credential| (credential.id.clone(), credential))
        .collect::<BTreeMap<_, _>>();
    for (id, provider) in &settings.providers {
        let credential = provider.credential(id);
        credentials.insert(credential.id.clone(), credential);
    }
    let mut rows = Vec::new();
    for (id, _) in credentials {
        let stored_value = stored.credentials.get(&id).map(String::as_str);
        let source = match stored_value {
            Some(value) if kcoder_config::provider_from_marker(value).is_some() => {
                format!("keyring ({})", backend.describe())
            }
            Some(_) => "file (plaintext)".to_string(),
            None => {
                if settings.resolve_provider_api_key(Some(&id), None).is_some() {
                    "environment".to_string()
                } else {
                    "not configured".to_string()
                }
            }
        };
        let configured = settings.resolve_provider_api_key(Some(&id), None).is_some();
        rows.push(serde_json::json!({"id":id,"configured":configured,"source":source}));
    }
    if cli.json {
        println!("{}", serde_json::json!({"providers":rows}));
    } else {
        println!("kcoder auth");
        println!("==============");
        println!("credential store: {}", paths.credentials.display());
        println!(
            "credential store mode: {} ({}: {}{})",
            settings.credential_store.as_str(),
            backend.describe(),
            if keyring_available {
                "available".to_string()
            } else {
                "unavailable".to_string()
            },
            credential_store_reason(&backend, keyring_available),
        );
        for row in rows {
            println!(
                "{}: {}",
                row["id"].as_str().unwrap_or_default(),
                row["source"].as_str().unwrap_or_default()
            );
        }
    }
    Ok(())
}

pub(crate) fn first_non_empty(values: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
}

pub(crate) fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
pub(crate) fn plaintext_settings_secret_warning(settings: &Settings) -> Option<String> {
    let fields = settings.plaintext_secret_setting_names();
    if fields.is_empty() {
        return None;
    }
    Some(format!(
        "warning: settings.json contains plaintext secret field(s): {}. Move API keys to environment variables, CLI arguments, or an OS keyring, then remove them from settings.json.",
        fields.join(", ")
    ))
}

pub(crate) fn emit_plaintext_settings_secret_warning_names(fields: &[String]) {
    if !fields.is_empty() {
        eprintln!(
            "warning: settings.json contains plaintext secret field(s): {}. Move API keys to `kcoder auth login`, environment variables, or CLI arguments, then remove them from settings.json.",
            fields.join(", ")
        );
    }
}
