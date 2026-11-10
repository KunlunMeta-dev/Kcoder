//! Fixed authenticated-SSH observer. It opens existing native records and starts no runtime.
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PrivateDirectory, Settings, SettingsLoader, integrations::remotes::RemoteIntegrationSettings,
};
use kcoder_integration_storage::turn_attempt_store::TurnAttemptStore;
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus, integrations::core::*};
use std::{
    ffi::{OsStr, OsString},
    io::{BufRead, Read, Write},
    path::PathBuf,
};

const MAX_READ_BYTES: u64 = 32 * 1024;

pub fn entry(args: &[OsString]) -> Result<()> {
    let mut cwd = None;
    let mut settings_file = None;
    let mut profile_selection = None;
    let mut fields = args.iter().skip(2);
    while let Some(name) = fields.next() {
        let value = fields
            .next()
            .context("REMOTE_ORIGINAL_READ_ARGUMENT_INVALID")?;
        if name == "--profile" {
            ensure!(
                profile_selection.is_none(),
                "REMOTE_ORIGINAL_READ_ARGUMENT_INVALID"
            );
            profile_selection = Some(
                value
                    .to_str()
                    .context("REMOTE_ORIGINAL_READ_PROVIDER_INVALID")?
                    .to_owned(),
            );
            continue;
        }
        let destination = match name.to_str() {
            Some("--cwd") => &mut cwd,
            Some("--settings-file") => &mut settings_file,
            _ => anyhow::bail!("REMOTE_ORIGINAL_READ_ARGUMENT_INVALID"),
        };
        ensure!(
            destination.is_none(),
            "REMOTE_ORIGINAL_READ_ARGUMENT_INVALID"
        );
        *destination = Some(PathBuf::from(value));
    }
    let workspace = cwd.context("REMOTE_ORIGINAL_READ_WORKSPACE_REQUIRED")?;
    ensure!(
        workspace.is_absolute(),
        "REMOTE_ORIGINAL_READ_WORKSPACE_REQUIRED"
    );
    let workspace = workspace
        .canonicalize()
        .context("REMOTE_ORIGINAL_READ_WORKSPACE_REQUIRED")?;
    let profile_path = Settings::config_dir()?;
    ensure!(
        profile_path.is_absolute(),
        "REMOTE_ORIGINAL_READ_PROFILE_REQUIRED"
    );
    let profile = PrivateDirectory::open_existing(&profile_path)?;
    profile.verify_private_directory()?;
    if let Some(path) = settings_file.as_ref() {
        // This is the fixed target's explicit read-only overlay, not a config
        // root. Native identity and PDP still come from the actual user profile.
        ensure!(path.is_absolute(), "REMOTE_ORIGINAL_READ_SETTINGS_INVALID");
    }
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_READ_BYTES + 1)
        .read_until(b'\n', &mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_READ_BYTES && bytes.last() == Some(&b'\n'),
        "REMOTE_ORIGINAL_READ_FRAME_INVALID"
    );
    let request: NativeRemoteOriginalReadV1 = serde_json::from_slice(&bytes)?;
    let reply = observe(
        &profile_path,
        &workspace,
        &request,
        profile_selection.as_deref(),
        settings_file.as_deref(),
    )?;
    let bytes = serde_json::to_vec(&reply)?;
    ensure!(
        bytes.len() as u64 <= MAX_READ_BYTES,
        "REMOTE_ORIGINAL_READ_FRAME_INVALID"
    );
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(&bytes)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}

fn observe(
    profile_path: &std::path::Path,
    workspace_path: &std::path::Path,
    request: &NativeRemoteOriginalReadV1,
    provider_selection: Option<&str>,
    explicit_settings: Option<&std::path::Path>,
) -> Result<NativeRemoteOriginalReadReplyV1> {
    let directory = Settings::project_data_dir(workspace_path)?;
    observe_existing_history(
        profile_path,
        workspace_path,
        request,
        &directory,
        provider_selection,
        explicit_settings,
    )
}

fn observe_existing_history(
    profile_path: &std::path::Path,
    workspace_path: &std::path::Path,
    request: &NativeRemoteOriginalReadV1,
    directory: &std::path::Path,
    provider_selection: Option<&str>,
    explicit_settings: Option<&std::path::Path>,
) -> Result<NativeRemoteOriginalReadReplyV1> {
    request.validate().map_err(anyhow::Error::msg)?;
    let expected = request
        .receiver_accepted
        .receiver_scope
        .as_ref()
        .context("REMOTE_ORIGINAL_READ_SCOPE_REQUIRED")?;
    ensure!(
        expected.organization_id.is_none() && request.source_scope.organization_id.is_none(),
        "REMOTE_ORIGINAL_READ_ORGANIZATION_UNAVAILABLE"
    );
    let profile = PrivateDirectory::open_existing(profile_path)?;
    profile.verify_private_directory()?;
    let workspace = PrivateDirectory::open_existing(workspace_path)?;
    let verify = || -> Result<()> {
        ensure!(
            PrivateDirectory::open_existing(profile_path)?.directory_identity()?
                == profile.directory_identity()?
                && PrivateDirectory::open_existing(workspace_path)?.directory_identity()?
                    == workspace.directory_identity()?,
            "REMOTE_ORIGINAL_READ_OWNER_CHANGED"
        );
        // This existing read primitive derives the actual native account from
        // held directories and observes its existing identity epoch. It cannot
        // initialize identity, namespaces, sessions, turns or model services.
        let (mut current, identity) = NativeIntegrationContext::observe_existing_data_scope(
            &profile,
            &workspace,
            &IntegrationOwner::from(expected),
            "original-remote-read-v1",
        )?;
        let snapshot = profile.read_source_document_snapshot(
            OsStr::new("settings.json"),
            8 * 1024 * 1024,
            || profile.verify_private_directory().is_ok(),
        )?;
        ensure!(
            snapshot.sha256 == request.receiver_accepted.receiver_settings_sha256,
            "REMOTE_ORIGINAL_READ_SETTINGS_CHANGED"
        );
        if provider_selection.is_some() || explicit_settings.is_some() {
            let loaded = SettingsLoader::new(workspace_path)
                .with_config_dir(profile_path)
                .with_overlay_files(
                    explicit_settings
                        .into_iter()
                        .map(std::path::Path::to_path_buf),
                )
                .load_read_only_configuration()
                .map_err(|_| anyhow::anyhow!("REMOTE_ORIGINAL_READ_PROVIDER_INVALID"))?;
            if let Some(selected) = provider_selection {
                RemoteIntegrationSettings::validate_native_read_provider_from_settings(
                    &loaded.settings,
                    selected,
                )?;
            }
        }
        RemoteIntegrationSettings::admit_native_sender(
            snapshot.bytes(),
            &request.source_scope.account_id,
        )?;
        current.target_revision = snapshot.sha256;
        ensure!(
            &current == expected && identity.snapshot(&profile)?.enabled,
            "REMOTE_ORIGINAL_READ_IDENTITY_CHANGED"
        );
        Ok(())
    };
    verify()?;
    ensure!(
        directory.parent() == Some(profile_path.join("projects").as_path()),
        "REMOTE_ORIGINAL_READ_HISTORY_ROOT_CHANGED"
    );
    let projects = profile.open_child(OsStr::new("projects"), false)?;
    let project = projects.open_child(
        directory
            .file_name()
            .context("REMOTE_ORIGINAL_READ_HISTORY_REQUIRED")?,
        false,
    )?;
    let root = project.open_child(OsStr::new("client-sessions"), false)?;
    let identity = TurnAttemptIdentity {
        thread_id: request.receiver_accepted.identity.thread_id.clone(),
        turn_id: request.receiver_accepted.identity.turn_id.clone(),
        attempt_id: request.receiver_accepted.identity.attempt_id.clone(),
    };
    identity.validate().map_err(anyhow::Error::msg)?;
    let session = root.open_child(OsStr::new(&identity.thread_id), false)?;
    let attempts = session.open_child(OsStr::new("turn-attempts"), false)?;
    // Normal persisted history ancestors can be 0755 inside the strict 0700
    // profile. Preserve their producer modes while refusing other-user writes.
    for directory in [&projects, &project, &root, &session, &attempts] {
        directory.verify_trusted_config_directory()?;
    }
    let store = TurnAttemptStore::open_existing(
        &directory.join("client-sessions").join(&identity.thread_id),
        &identity.thread_id,
    )?
    .context("REMOTE_ORIGINAL_READ_ATTEMPT_REQUIRED")?;
    let actual = store
        .load(&identity)?
        .context("REMOTE_ORIGINAL_READ_ATTEMPT_REQUIRED")?;
    let mut accepted = actual.clone();
    accepted.status = TurnAttemptStatus::Accepted;
    accepted.completion = None;
    ensure!(
        crate::digest(&accepted)? == request.receiver_accepted.accepted_receipt_sha256,
        "REMOTE_ORIGINAL_READ_ACCEPTED_CHANGED"
    );
    let outcome = match actual.status {
        TurnAttemptStatus::Completed => Some(NativeRemoteCallOutcomeV1::Completed),
        TurnAttemptStatus::Failed => Some(NativeRemoteCallOutcomeV1::Failed),
        TurnAttemptStatus::Interrupted => Some(NativeRemoteCallOutcomeV1::Interrupted),
        _ => None,
    };
    ensure!(
        outcome.is_none() || actual.completion.is_some(),
        "REMOTE_ORIGINAL_READ_TERMINAL_REQUIRED"
    );
    // Reopen every component after the atomic record read. A swapped path is
    // rejected even when it contains a copy of the expected JSON receipt.
    let current_projects = profile.open_child(OsStr::new("projects"), false)?;
    let current_project = current_projects.open_child(directory.file_name().unwrap(), false)?;
    let current_root = current_project.open_child(OsStr::new("client-sessions"), false)?;
    let current_session = current_root.open_child(OsStr::new(&identity.thread_id), false)?;
    let current_attempts = current_session.open_child(OsStr::new("turn-attempts"), false)?;
    for (before, after) in [
        (&projects, &current_projects),
        (&project, &current_project),
        (&root, &current_root),
        (&session, &current_session),
        (&attempts, &current_attempts),
    ] {
        ensure!(
            before.directory_identity()? == after.directory_identity()?,
            "REMOTE_ORIGINAL_READ_HISTORY_CHANGED"
        );
        after.verify_trusted_config_directory()?;
    }
    verify()?;
    Ok(NativeRemoteOriginalReadReplyV1 {
        original: request.clone(),
        outcome,
        finished_at_ms: actual
            .completion
            .map(|completion| completion.finished_at_ms),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_integration_storage::turn_attempt_store::{
        TurnAttemptCompletion, TurnAttemptRecord,
    };
    use serde_json::json;

    #[test]
    fn original_receiver_observer_reads_canonical_terminal_without_runtime_and_rejects_changed_identity_or_settings()
     {
        let temp = tempfile::tempdir().unwrap();
        let parent = PrivateDirectory::open_existing(temp.path()).unwrap();
        let profile = parent.create_private_child(OsStr::new("profile")).unwrap();
        let workspace = parent
            .create_private_child(OsStr::new("workspace"))
            .unwrap();
        let profile_path = temp.path().join("profile");
        let workspace_path = temp.path().join("workspace");
        let settings = serde_json::to_vec(&json!({"active_provider":"OwnedReadProvider", "model":"owned-model",
            "providers":{"OwnedReadProvider":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},
                "endpoint":"http://127.0.0.1:1/v1","default_model":"owned-model","context_window_tokens":8192,
                "max_output_tokens":64,"output_headroom_tokens":1024}},
            "integrations":{"remotes":{"receiver":{
            "enabled":true,"allowedSenderAccounts":["actual-source"],"maximumTotalTokens":1000,
            "maximumModelCalls":1,"maximumDurationSeconds":60}}}}))
        .unwrap();
        profile
            .atomic_replace(OsStr::new("settings.json"), &settings)
            .unwrap();
        let revision = profile
            .read_source_document_snapshot(OsStr::new("settings.json"), 8192, || true)
            .unwrap()
            .sha256;
        let native = NativeIntegrationContext::capture(
            &profile_path,
            &workspace_path,
            "fixture-owned-original",
            &revision,
        )
        .unwrap();
        let mut source_scope = native.scope().clone();
        source_scope.account_id = "actual-source".into();
        let identity = TurnAttemptIdentity {
            thread_id: "actual-thread".into(),
            turn_id: "actual-turn".into(),
            attempt_id: "actual-attempt".into(),
        };
        let projects = profile
            .create_private_child(OsStr::new("projects"))
            .unwrap();
        let derived = Settings::project_data_dir(&workspace_path).unwrap();
        let project_key = derived.file_name().unwrap();
        let project = projects.create_private_child(project_key).unwrap();
        let root = project
            .create_private_child(OsStr::new("client-sessions"))
            .unwrap();
        root.create_private_child(OsStr::new(&identity.thread_id))
            .unwrap();
        let directory = profile_path.join("projects").join(project_key);
        let session = directory.join("client-sessions").join(&identity.thread_id);
        let store = TurnAttemptStore::open(&session, &identity.thread_id).unwrap();
        let accepted = TurnAttemptRecord {
            client_presentation: None,
            version: 1,
            identity: identity.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "a".repeat(64),
            request_fingerprint: None,
            retained_input: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        };
        store.begin(accepted.clone()).unwrap();
        store
            .finish(
                &identity,
                TurnAttemptCompletion {
                    status: TurnAttemptStatus::Completed,
                    finished_at_ms: 2,
                    error: None,
                    provider_failure: None,
                    partial_output: String::new(),
                    partial_output_truncated: false,
                    committed_history_uuid: None,
                },
            )
            .unwrap();
        let request = NativeRemoteOriginalReadV1 {
            version: 1,
            request_id: "current-read".into(),
            operation_id: "original-operation".into(),
            endpoint_instance_id: "original-endpoint".into(),
            source_scope,
            receiver_accepted: NativeRemoteAcceptedFactsV1 {
                identity: (&identity).into(),
                accepted_input_sha256: "b".repeat(64),
                accepted_receipt_sha256: crate::digest(&accepted).unwrap(),
                receiver_settings_sha256: revision,
                receiver_scope: Some(native.scope().clone()),
            },
        };
        let before = std::fs::read_dir(session.join("turn-attempts"))
            .unwrap()
            .count();
        let reply = observe_existing_history(
            &profile_path,
            &workspace_path,
            &request,
            &directory,
            None,
            None,
        )
        .unwrap();
        assert_eq!(reply.outcome, Some(NativeRemoteCallOutcomeV1::Completed));
        assert_eq!(reply.finished_at_ms, Some(2));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&workspace_path, std::fs::Permissions::from_mode(0o755))
                .unwrap();
            let normal_workspace = observe_existing_history(
                &profile_path,
                &workspace_path,
                &request,
                &directory,
                None,
                None,
            )
            .unwrap();
            assert_eq!(
                normal_workspace, reply,
                "Ordinary non-private workspaces retain the same frozen native data scope"
            );
            assert_eq!(
                std::fs::metadata(&workspace_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o755
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let history = [
                profile_path.join("projects"),
                directory.clone(),
                directory.join("client-sessions"),
                session.clone(),
                session.join("turn-attempts"),
            ];
            for path in &history {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            let normal = observe_existing_history(
                &profile_path,
                &workspace_path,
                &request,
                &directory,
                None,
                None,
            )
            .unwrap();
            assert_eq!(
                normal, reply,
                "Producer-owned nonwritable history paths stay readable inside a private profile"
            );
            for path in &history {
                assert_eq!(
                    std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    0o755
                );
            }
            let shared = directory.join("client-sessions");
            std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o770)).unwrap();
            assert!(
                observe_existing_history(
                    &profile_path,
                    &workspace_path,
                    &request,
                    &directory,
                    None,
                    None
                )
                .is_err()
            );
            assert_eq!(
                std::fs::metadata(&shared).unwrap().permissions().mode() & 0o777,
                0o770,
                "A readonly denial cannot repair permissions"
            );
            std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        if let Some(binary) = std::env::var_os("KCODER_TEST_ORIGINAL_READ_BINARY") {
            // Explicit protocol fixture only: this seeded record is not an
            // actual model task. The normal child exercises the fixed entry.
            use std::io::Write;
            for mode in [0o700, 0o755] {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    for path in [
                        profile_path.join("projects"),
                        directory.clone(),
                        directory.join("client-sessions"),
                        session.clone(),
                    ] {
                        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
                            .unwrap();
                    }
                }
                let mut child = std::process::Command::new(&binary)
                    .arg("--internal-native-remote-read-v1")
                    .arg("--cwd")
                    .arg(&workspace_path)
                    .arg("--settings-file")
                    .arg(profile_path.join("settings.json"))
                    .arg("--profile")
                    .arg("OwnedReadProvider")
                    .env_clear()
                    .env("KCODER_CONFIG_DIR", &profile_path)
                    .current_dir(&workspace_path)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .unwrap();
                let mut frame = serde_json::to_vec(&request).unwrap();
                frame.push(b'\n');
                child.stdin.take().unwrap().write_all(&frame).unwrap();
                let output = child.wait_with_output().unwrap();
                eprintln!(
                    "fixed_entry_protocol_fixture mode={mode:o} success={} stderr={}",
                    output.status.success(),
                    String::from_utf8_lossy(&output.stderr).trim()
                );
                if mode == 0o700 {
                    assert!(
                        output.status.success(),
                        "fixed-entry baseline must work before a permission probe"
                    );
                    let actual: NativeRemoteOriginalReadReplyV1 =
                        serde_json::from_slice(&output.stdout).unwrap();
                    assert_eq!(actual, reply);
                }
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                for path in [
                    profile_path.join("projects"),
                    directory.clone(),
                    directory.join("client-sessions"),
                    session.clone(),
                ] {
                    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
                }
            }
        }
        profile
            .atomic_replace(OsStr::new("credentials.json"), b"not-a-credential-document")
            .unwrap();
        let selected = observe_existing_history(
            &profile_path,
            &workspace_path,
            &request,
            &directory,
            Some("OwnedReadProvider"),
            None,
        )
        .unwrap();
        assert_eq!(
            selected, reply,
            "Provider selection cannot change native namespace, scope or original facts"
        );
        let project_config = workspace
            .create_private_child(OsStr::new(".kcoder"))
            .unwrap();
        project_config.atomic_replace(OsStr::new("settings.json"), &serde_json::to_vec(&json!({
            "providers":{"OwnedProjectProvider":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},
                "endpoint":"http://127.0.0.1:1/v1","default_model":"project-model","context_window_tokens":8192,
                "max_output_tokens":64,"output_headroom_tokens":1024}},
            "integrations":{"remotes":{"receiver":{"allowedSenderAccounts":["project-only-sender"]}}}
        })).unwrap()).unwrap();
        let project_selected = observe_existing_history(
            &profile_path,
            &workspace_path,
            &request,
            &directory,
            Some("OwnedProjectProvider"),
            Some(&profile_path.join("settings.json")),
        )
        .unwrap();
        assert_eq!(
            project_selected, reply,
            "Normal layered Provider catalogs cannot replace native namespace or original PDP"
        );
        let external_overlay = temp.path().join("current-target-overlay.json");
        std::fs::write(&external_overlay, serde_json::to_vec(&json!({
            "providers":{"OwnedOverlayProvider":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},
                "endpoint":"http://127.0.0.1:1/v1","default_model":"overlay-model","context_window_tokens":8192,
                "max_output_tokens":64,"output_headroom_tokens":1024}},
            "history_directory":temp.path().join("must-not-be-opened-history"),
            "integrations":{"remotes":{"receiver":{"allowedSenderAccounts":["overlay-only-sender"]}}}
        })).unwrap()).unwrap();
        let overlay_selected = observe_existing_history(
            &profile_path,
            &workspace_path,
            &request,
            &directory,
            Some("OwnedOverlayProvider"),
            Some(&external_overlay),
        )
        .unwrap();
        assert_eq!(
            overlay_selected, reply,
            "A fixed explicit overlay is configuration data, never a replacement native profile/PDP"
        );
        assert!(!temp.path().join("must-not-be-opened-history").exists());
        let mut project_sender = request.clone();
        project_sender.source_scope.account_id = "project-only-sender".into();
        assert!(
            observe_existing_history(
                &profile_path,
                &workspace_path,
                &project_sender,
                &directory,
                Some("OwnedProjectProvider"),
                None
            )
            .is_err(),
            "Project configuration cannot grant original sender access"
        );
        assert!(
            observe_existing_history(
                &profile_path,
                &workspace_path,
                &request,
                &directory,
                Some("missing-provider"),
                None,
            )
            .is_err()
        );
        assert_eq!(
            std::fs::read_dir(session.join("turn-attempts"))
                .unwrap()
                .count(),
            before
        );
        let mut changed = request.clone();
        changed.receiver_accepted.accepted_receipt_sha256 = "f".repeat(64);
        assert!(
            observe_existing_history(
                &profile_path,
                &workspace_path,
                &changed,
                &directory,
                None,
                None
            )
            .is_err()
        );
        changed = request.clone();
        changed
            .receiver_accepted
            .receiver_scope
            .as_mut()
            .unwrap()
            .identity_generation = "replaced-identity".into();
        assert!(
            observe_existing_history(
                &profile_path,
                &workspace_path,
                &changed,
                &directory,
                None,
                None
            )
            .is_err()
        );
        let mut missing = request.clone();
        missing.receiver_accepted.identity.thread_id = "never-created".into();
        assert!(
            observe_existing_history(
                &profile_path,
                &workspace_path,
                &missing,
                &directory,
                None,
                None
            )
            .is_err()
        );
        assert!(!directory.join("client-sessions/never-created").exists());
        profile
            .atomic_replace(OsStr::new("settings.json"), b"{}")
            .unwrap();
        assert!(
            observe_existing_history(
                &profile_path,
                &workspace_path,
                &request,
                &directory,
                None,
                None
            )
            .is_err()
        );
        assert_eq!(
            workspace.directory_identity().unwrap(),
            PrivateDirectory::open_existing(&workspace_path)
                .unwrap()
                .directory_identity()
                .unwrap()
        );
    }
}
