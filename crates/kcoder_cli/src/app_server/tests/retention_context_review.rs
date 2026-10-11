// S2-A1 authority review for the private retention stdio boundary. These
// tests exercise the production capture/validation helpers without wiring any
// retention lifecycle RPC or making Provider requests.

#[cfg(target_os = "linux")]
fn retention_context_review_fixture_parent() -> std::path::PathBuf {
    let parent = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR")
        .expect("Cargo must provide the runtime manifest directory"))
        .join("../..").canonicalize().expect("resolve source workspace")
        .join("target/test/crates/kcoder_cli/retention-review-fixtures");
    kcoder_config::PrivateDirectory::open_or_create(&parent)
        .expect("create owned private retention review fixture parent");
    parent.canonicalize().expect("resolve owned retention review fixture parent")
}

#[cfg(target_os = "linux")]
fn retention_context_review_tempdir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("retention-context-review-")
        .tempdir_in(retention_context_review_fixture_parent())
        .expect("create private retention review fixture")
}

#[cfg(target_os = "linux")]
fn retention_context_review_engine(cwd: &std::path::Path) -> QueryEngine {
    let settings = kcoder_config::Settings { training_mode: true, ..Default::default() };
    // Keep this real client-mode Engine from scheduling even the mock
    // Provider's optional prewarm. The authority only needs its durable-root
    // fact and canonical workspace identity.
    let engine = QueryEngine::try_new_for_client_with_services(
        Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
            crate::tui_dev_mock::TuiDevScenario::FullTurn,
        )),
        kcoder_state::AppState::new(cwd),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        cwd.to_path_buf(),
        Some(true),
        kcoder_engine::WorkspaceRuntimeServices::new(cwd, "retention-context-review"),
    )
    .expect("construct durable client-mode test Engine");
    assert!(
        engine.durable_client_storage_root().is_some(),
        "authority capture requires a durable client-mode Engine"
    );
    engine
}

#[cfg(target_os = "linux")]
fn retention_context_review_account_root(fixture: &tempfile::TempDir) -> std::path::PathBuf {
    let root = fixture.path().join("account-config");
    kcoder_config::PrivateDirectory::open_or_create(&root)
        .expect("create private account config root");
    root
}

#[cfg(target_os = "linux")]
fn retention_context_review_local_context() -> kcoder_app_protocol::TrustedRetentionContextV1 {
    use kcoder_app_protocol::{RetentionPrincipalV1, TrustedRetentionContextV1};

    TrustedRetentionContextV1 {
        gateway_namespace_id: "review-gateway-namespace".into(),
        device_id: "review-device".into(),
        authorization_generation: "review-auth-generation".into(),
        target_fingerprint: "review-target-fingerprint".into(),
        principal: RetentionPrincipalV1::LocalOs,
    }
}

#[cfg(target_os = "linux")]
fn retention_context_review_account_context(
    principal_id: &str,
) -> kcoder_app_protocol::TrustedRetentionContextV1 {
    use kcoder_app_protocol::{RetentionPrincipalV1, TrustedRetentionContextV1};

    TrustedRetentionContextV1 {
        principal: RetentionPrincipalV1::VerifiedAccount {
            principal_id: principal_id.into(),
        },
        ..retention_context_review_local_context()
    }
}

#[cfg(target_os = "linux")]
fn retention_context_review_read_request(
    context: &kcoder_app_protocol::TrustedRetentionContextV1,
) -> kcoder_app_protocol::PrivateRetentionRequestV1 {
    use kcoder_app_protocol::{METHOD_ATTACHMENT_RETENTION_READ};

    serde_json::from_value(serde_json::json!({
        "jsonrpc": "2.0",
        "id": 41,
        "method": METHOD_ATTACHMENT_RETENTION_READ,
        "params": {
            "trustedContext": context,
            "selector": {
                "by": "clientRequestId",
                "clientRequestId": "review-request",
            },
        },
        "kcoderPrivateRetention": {
            "version": 1,
            "context": context,
        },
    }))
    .expect("construct valid typed private retention read request")
}

#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
struct RetentionContextReviewEntry {
    is_directory: bool,
    device: u64,
    inode: u64,
    length: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    content: Option<Vec<u8>>,
}

#[cfg(target_os = "linux")]
type RetentionContextReviewSnapshot =
    std::collections::BTreeMap<std::path::PathBuf, RetentionContextReviewEntry>;

#[cfg(target_os = "linux")]
fn retention_context_review_snapshot(root: &std::path::Path) -> RetentionContextReviewSnapshot {
    use std::os::unix::fs::MetadataExt;

    fn visit(
        root: &std::path::Path,
        current: &std::path::Path,
        snapshot: &mut RetentionContextReviewSnapshot,
    ) {
        let metadata = std::fs::symlink_metadata(current).unwrap();
        let file_type = metadata.file_type();
        let is_directory = file_type.is_dir();
        let content = if file_type.is_file() {
            Some(std::fs::read(current).unwrap())
        } else {
            assert!(
                is_directory,
                "unexpected symlink or special file in retention store: {current:?}"
            );
            None
        };
        snapshot.insert(
            current.strip_prefix(root).unwrap().to_path_buf(),
            RetentionContextReviewEntry {
                is_directory,
                device: metadata.dev(),
                inode: metadata.ino(),
                length: metadata.len(),
                modified_seconds: metadata.mtime(),
                modified_nanoseconds: metadata.mtime_nsec(),
                content,
            },
        );
        if is_directory {
            for entry in std::fs::read_dir(current).unwrap() {
                visit(root, &entry.unwrap().path(), snapshot);
            }
        }
    }

    let mut snapshot = RetentionContextReviewSnapshot::new();
    visit(root, root, &mut snapshot);
    snapshot
}

#[cfg(target_os = "linux")]
fn retention_context_review_request_with(
    method: &str,
    extension_context: &kcoder_app_protocol::TrustedRetentionContextV1,
    params: serde_json::Value,
) -> kcoder_app_protocol::PrivateRetentionRequestV1 {
    serde_json::from_value(serde_json::json!({
        "jsonrpc": "2.0",
        "id": 42,
        "method": method,
        "params": params,
        "kcoderPrivateRetention": {
            "version": 1,
            "context": extension_context,
        },
    }))
    .expect("construct typed private retention request")
}

#[test]
#[cfg(target_os = "linux")]
fn retention_context_review_capture_binds_account_parent_to_actual_effective_uid() {
    let fixture = retention_context_review_tempdir();
    let workspace = fixture.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let account_root = retention_context_review_account_root(&fixture);
    let engine = retention_context_review_engine(&workspace);
    let actual_uid = unsafe { libc::geteuid() };
    let wrong_uid = if actual_uid == 0 { 1 } else { actual_uid - 1 };
    let retention_root = account_root.join("attachment-retention-v1");

    let wrong_uid_capture = super::retention_context::VerifiedRetentionAuthority::capture(
        super::retention_context::RetentionLaunchConfiguration {
            parent: kcoder_app_protocol::RetentionParentLaunchV1::VerifiedAccount {
                principal_id: "review-account".into(),
                uid: wrong_uid,
            },
            account_root: account_root.clone(),
            optional: false,
        },
        &engine,
    );
    assert!(
        wrong_uid_capture.is_err(),
        "declared account UID must equal the process effective UID"
    );
    assert!(
        !retention_root.exists(),
        "UID mismatch must be rejected before opening or initializing the retention store"
    );

    let authority = super::retention_context::VerifiedRetentionAuthority::capture(
        super::retention_context::RetentionLaunchConfiguration {
            parent: kcoder_app_protocol::RetentionParentLaunchV1::VerifiedAccount {
                principal_id: "review-account".into(),
                uid: actual_uid,
            },
            account_root: account_root.clone(),
            optional: false,
        },
        &engine,
    )
    .expect("matching actual UID may capture the explicit account parent");
    let baseline = retention_context_review_snapshot(&retention_root);
    let exact_context = retention_context_review_account_context("review-account");
    assert_eq!(
        authority.validate(&retention_context_review_read_request(&exact_context)),
        Ok(()),
        "an exact account principal and current OS UID pass the private boundary"
    );

    let wrong_principal = retention_context_review_account_context("other-account");
    assert_eq!(
        authority.validate(&retention_context_review_read_request(&wrong_principal)),
        Err(-32001),
        "account principal mismatch must fail as unavailable authority"
    );
    assert_eq!(
        retention_context_review_snapshot(&retention_root),
        baseline,
        "valid authorization and principal rejection do not mutate retention records"
    );
}

#[test]
#[cfg(target_os = "linux")]
fn retention_context_review_rejects_bad_typed_scope_batch_and_method_without_store_writes() {
    use kcoder_app_protocol::{
        METHOD_ATTACHMENT_RETENTION_READ, METHOD_ATTACHMENT_RETENTION_RESERVE,
        RetentionParentLaunchV1,
    };

    let fixture = retention_context_review_tempdir();
    let workspace = fixture.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let account_root = retention_context_review_account_root(&fixture);
    let engine = retention_context_review_engine(&workspace);
    let authority = super::retention_context::VerifiedRetentionAuthority::capture(
        super::retention_context::RetentionLaunchConfiguration {
            parent: RetentionParentLaunchV1::LocalOs,
            account_root: account_root.clone(),
            optional: false,
        },
        &engine,
    )
    .expect("capture a real local-OS parent and service");
    let retention_root = account_root.join("attachment-retention-v1");
    let context = retention_context_review_local_context();
    let valid_request = retention_context_review_read_request(&context);
    assert_eq!(authority.validate(&valid_request), Ok(()));
    let baseline = retention_context_review_snapshot(&retention_root);

    let mut mismatched_params = serde_json::to_value(&valid_request).unwrap();
    mismatched_params["params"]["trustedContext"]["deviceId"] =
        serde_json::json!("different-device");
    let mismatched_params: kcoder_app_protocol::PrivateRetentionRequestV1 =
        serde_json::from_value(mismatched_params).unwrap();

    let mut unknown_param = serde_json::to_value(&valid_request).unwrap();
    unknown_param["params"]["unexpected"] = serde_json::json!("not part of the typed contract");
    let unknown_param: kcoder_app_protocol::PrivateRetentionRequestV1 =
        serde_json::from_value(unknown_param).unwrap();

    let stage_refs = (0..=kcoder_app_protocol::MAX_RETENTION_BATCH)
        .map(|index| {
            serde_json::json!({
                "rootNamespace": "11111111111111111111111111111111",
                "epoch": 1,
                "ownerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "entryId": format!("{index:032x}"),
                "revision": 1,
            })
        })
        .collect::<Vec<_>>();
    let oversized_batch = retention_context_review_request_with(
        METHOD_ATTACHMENT_RETENTION_RESERVE,
        &context,
        serde_json::json!({
            "trustedContext": context,
            "clientRequestId": "review-reserve",
            "threadId": "review-thread",
            "stageRefs": stage_refs,
        }),
    );
    let unsupported_method =
        retention_context_review_request_with("thread/start", &context, serde_json::json!({}));
    let wrong_principal = retention_context_review_read_request(
        &retention_context_review_account_context("untrusted-account"),
    );

    for (label, request, expected_code) in [
        (
            "params context differs from extension",
            mismatched_params,
            -32602,
        ),
        ("unknown typed parameter", unknown_param, -32602),
        ("oversized reserve batch", oversized_batch, -32602),
        (
            "method is not on retention allowlist",
            unsupported_method,
            -32602,
        ),
        ("launch principal differs", wrong_principal, -32001),
    ] {
        assert_eq!(
            authority.validate(&request),
            Err(expected_code),
            "unexpected validation result for {label}"
        );
        assert_eq!(
            retention_context_review_snapshot(&retention_root),
            baseline,
            "{label} must not create or mutate service records"
        );
    }

    assert_eq!(
        valid_request.method, METHOD_ATTACHMENT_RETENTION_READ,
        "positive control exercises the existing typed read contract"
    );
}

#[test]
#[cfg(target_os = "linux")]
fn retention_context_review_rejects_account_root_replacement_after_capture() {
    use kcoder_app_protocol::{
        METHOD_ATTACHMENT_RETENTION_READ, METHOD_ATTACHMENT_RETENTION_RESERVE,
        RetentionParentLaunchV1,
    };

    let fixture = retention_context_review_tempdir();
    let workspace = fixture.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let account_root = retention_context_review_account_root(&fixture);
    let engine = retention_context_review_engine(&workspace);
    let authority = super::retention_context::VerifiedRetentionAuthority::capture(
        super::retention_context::RetentionLaunchConfiguration {
            parent: RetentionParentLaunchV1::LocalOs,
            account_root: account_root.clone(),
            optional: false,
        },
        &engine,
    )
    .expect("capture the original private account root");
    let request = retention_context_review_read_request(&retention_context_review_local_context());

    let retained_original = fixture.path().join("original-account-config");
    std::fs::rename(&account_root, &retained_original).unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&account_root)
        .expect("create replacement account root with a new filesystem identity");
    std::fs::write(
        account_root.join("foreign-owner.txt"),
        b"preserve this replacement",
    )
    .unwrap();
    let replacement_baseline = retention_context_review_snapshot(&account_root);

    let context = retention_context_review_local_context();
    let malformed_typed_params = retention_context_review_request_with(
        METHOD_ATTACHMENT_RETENTION_READ,
        &context,
        serde_json::json!({}),
    );
    let unsupported_method =
        retention_context_review_request_with("thread/start", &context, serde_json::json!({}));
    let stage_refs = (0..=kcoder_app_protocol::MAX_RETENTION_BATCH)
        .map(|index| {
            serde_json::json!({
                "rootNamespace": "11111111111111111111111111111111",
                "epoch": 1,
                "ownerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "entryId": format!("{index:032x}"),
                "revision": 1,
            })
        })
        .collect::<Vec<_>>();
    let oversized_batch = retention_context_review_request_with(
        METHOD_ATTACHMENT_RETENTION_RESERVE,
        &context,
        serde_json::json!({
            "trustedContext": context,
            "clientRequestId": "review-reserve-after-root-change",
            "threadId": "review-thread",
            "stageRefs": stage_refs,
        }),
    );
    let mut mismatched_context_params = serde_json::to_value(&request).unwrap();
    mismatched_context_params["params"]["trustedContext"]["deviceId"] =
        serde_json::json!("different-device");
    let mismatched_context_params: kcoder_app_protocol::PrivateRetentionRequestV1 =
        serde_json::from_value(mismatched_context_params).unwrap();

    for (label, invalid_request) in [
        ("unsupported method", unsupported_method),
        ("malformed typed params", malformed_typed_params),
        ("oversized batch", oversized_batch),
        ("params context mismatch", mismatched_context_params),
    ] {
        assert_eq!(
            authority.validate(&invalid_request),
            Err(-32602),
            "pure request validation takes precedence over the replaced root: {label}"
        );
        assert_eq!(
            retention_context_review_snapshot(&account_root),
            replacement_baseline,
            "invalid request must not touch the replacement root: {label}"
        );
    }

    assert_eq!(
        authority.validate(&request),
        Err(-32001),
        "a captured authority must reject a config path replaced with a new inode"
    );
    assert_eq!(
        retention_context_review_snapshot(&account_root),
        replacement_baseline,
        "rejected authority must leave the replacement root and its foreign bytes untouched"
    );
    assert_eq!(
        std::fs::read(account_root.join("foreign-owner.txt")).unwrap(),
        b"preserve this replacement"
    );
}

#[test]
fn retention_context_review_raw_decoder_rejects_duplicate_authority_fields() {
    let raw = r#"{"jsonrpc":"2.0","id":1,"method":"attachment/retention/read","params":{"trustedContext":{"gatewayNamespaceId":"review-gateway","deviceId":"first","deviceId":"second","authorizationGeneration":"review-generation","targetFingerprint":"review-target","principal":{"kind":"localOs"}},"selector":{"by":"clientRequestId","clientRequestId":"review-request"}},"kcoderPrivateRetention":{"version":1,"context":{"gatewayNamespaceId":"review-gateway","deviceId":"review-device","authorizationGeneration":"review-generation","targetFingerprint":"review-target","principal":{"kind":"localOs"}}}}"#;
    assert!(
        kcoder_app_protocol::decode_private_retention_request(raw).is_err(),
        "the decoder must inspect raw JSON and reject duplicate keys before Value can erase them"
    );

    assert!(
        super::retention_context::has_private_authority(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "thread/start",
            "params": {},
            "kcoderPrivateRetention": {"version": 1},
        })),
        "the reserved top-level extension must enter private-frame validation"
    );
    assert!(
        super::retention_context::has_private_authority(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 8,
            "method": "attachment/retention/read",
            "params": {"nested": {"trustedContext": {}}},
        })),
        "ordinary attachment methods cannot smuggle a reserved trusted-context field"
    );
    assert!(
        !super::retention_context::has_private_authority(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "thread/list",
            "params": {"ordinary": true},
        })),
        "ordinary legacy RPC frames retain their existing dispatch path"
    );
}

#[cfg(target_os = "linux")]
fn retention_parent_environment_review_encode(raw_json: &str) -> std::ffi::OsString {
    use base64::Engine as _;

    format!(
        "v1.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw_json.as_bytes())
    )
    .into()
}

#[test]
#[cfg(target_os = "linux")]
fn retention_parent_environment_review_absence_and_valid_facts_are_typed() {
    use kcoder_app_protocol::RetentionParentLaunchV1;

    assert_eq!(crate::retention_parent_environment::decode(None).unwrap(), None);
    assert_eq!(
        crate::retention_parent_environment::decode(Some(
            retention_parent_environment_review_encode(r#"{"version":1,"mode":"localOs"}"#)
        ))
        .unwrap(),
        Some(RetentionParentLaunchV1::LocalOs)
    );

    let uid = unsafe { libc::geteuid() };
    let account = format!(
        r#"{{"version":1,"mode":"verifiedAccount","principalId":"review-account","uid":{uid}}}"#
    );
    assert_eq!(
        crate::retention_parent_environment::decode(Some(
            retention_parent_environment_review_encode(&account)
        ))
        .unwrap(),
        Some(RetentionParentLaunchV1::VerifiedAccount {
            principal_id: "review-account".into(),
            uid,
        })
    );
}

#[test]
#[cfg(target_os = "linux")]
fn retention_parent_environment_review_malformed_or_wrong_uid_never_becomes_optional() {
    let malformed = [
        "not-v1".to_owned(),
        retention_parent_environment_review_encode(
            r#"{"version":1,"version":1,"mode":"localOs"}"#,
        )
        .to_string_lossy()
        .into_owned(),
        retention_parent_environment_review_encode(
            r#"{"version":1,"mode":"localOs","unexpected":true}"#,
        )
        .to_string_lossy()
        .into_owned()
    ];
    for raw in malformed {
        let error = crate::retention_parent_environment::decode(Some(raw.into()))
            .expect_err("malformed inherited facts must fail before optional capture handling");
        assert_eq!(error.to_string(), "invalid private parent launch declaration");
    }

    let actual_uid = unsafe { libc::geteuid() };
    let wrong_uid = if actual_uid == 0 { 1 } else { actual_uid - 1 };
    let account = format!(
        r#"{{"version":1,"mode":"verifiedAccount","principalId":"do-not-echo-this","uid":{wrong_uid}}}"#
    );
    let error = crate::retention_parent_environment::decode(Some(
        retention_parent_environment_review_encode(&account),
    ))
    .expect_err("UID identity conflicts are hard errors, not optional capability misses");
    assert_eq!(error.to_string(), "private parent launch identity mismatch");
    assert!(!error.to_string().contains("do-not-echo-this"));

    let encoded_limit = 3 + kcoder_app_protocol::PRIVATE_RETENTION_PARENT_JSON_LIMIT_V1.div_ceil(3) * 4;
    let oversized = format!("v1.{}", "A".repeat(encoded_limit));
    let error = crate::retention_parent_environment::decode(Some(oversized.into()))
        .expect_err("encoded declaration size is bounded before decode");
    assert_eq!(error.to_string(), "invalid private parent launch declaration");
}
