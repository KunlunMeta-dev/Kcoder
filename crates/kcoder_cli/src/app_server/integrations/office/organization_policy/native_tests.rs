//! Actual authenticated Linux UID and live Root PDP acceptance, without model calls.
use super::*;
use crate::app_server::integrations::{
    core::{NativeDomain, NativeDomainGuard},
    office::{
        installed_resources::{
            NativeOfficeLaunchAuthority, NativeOfficeRuntimeAuthority, OfficeNodeRuntimeMode,
        },
        native_assets::{NativeOfficeFileAssets, NativeOfficeTransfers},
        native_host::{
            NativeOfficeAcceptedTurnAuthority, NativeOfficeAssets, NativeOfficeComposition,
            NativeOfficeProviders,
        },
    },
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_app_protocol::{AttachmentReadChunkParams, AttachmentSaveParams};
use kcoder_state::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
use kcoder_types::{
    TurnAttemptIdentity, TurnAttemptStatus,
    integrations::{core::*, office::*},
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, Write},
    path::PathBuf,
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

fn phase(name: &str) -> Result<()> {
    println!("ORG_OFFICE_HOST_PHASE:{name}");
    std::io::stdout().flush()?;
    let mut line = String::new();
    ensure!(
        std::io::stdin().lock().read_line(&mut line)? > 0 && line.trim() == "continue",
        "owned Office fixture continuation required"
    );
    Ok(())
}
fn request(
    native: &NativeIntegrationContext,
    operation: Option<&str>,
    payload: Value,
) -> IntegrationRequest {
    IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: operation.unwrap_or("office-read").into(),
        scope: native.scope().clone(),
        operation_id: operation.map(str::to_owned),
        expected_revision: None,
        timeout_ms: 60_000,
        cancellation_ref: None,
        payload: payload.as_object().unwrap().clone(),
    }
}
async fn dispatch(
    host: &NativeOfficeComposition,
    native: &NativeIntegrationContext,
    method: &str,
    request: &IntegrationRequest,
) -> Result<IntegrationReply> {
    host.dispatch(native, method, request, &CancellationToken::new())
        .await
}
fn generate(
    native: &NativeIntegrationContext,
    task: &OfficeTaskRef,
    operation: &str,
) -> IntegrationRequest {
    request(
        native,
        Some(operation),
        json!({"task":task,"sourceRefs":[],"specification":{
        "schemaVersion":1,"kind":"docx","title":"Authorized original Office result",
        "paragraphs":[{"text":"Controlled real Native Office output; no private source body."}]}}),
    )
}

#[tokio::test]
#[ignore = "requires explicit authenticated Linux UID, live Root peer and sealed actual Node resources"]
async fn actual_uid_live_root_office_host_enforces_dedicated_action_grants() -> Result<()> {
    ensure!(
        std::env::var("KCODER_TEST_ORGANIZATION_OFFICE_HOST").as_deref() == Ok("1"),
        "explicit owned Office host fixture required"
    );
    let profile = PathBuf::from(std::env::var_os("KCODER_CONFIG_DIR").context("profile missing")?);
    let workspace = std::env::current_dir()?;
    let engine = crate::app_server::tests::catalog_list_test_engine(&workspace)
        .with_settings_persistence_path(profile.join("settings.json"));
    engine.settings.write().unwrap().integrations.office.enabled = true;
    let native = NativeIntegrationContext::capture_existing(
        &profile,
        &workspace,
        "owned-office-host",
        &engine.active_model_configuration_summary()?.revision,
    )?;
    ensure!(verify(&native)?.is_some());
    let resource = resource_id(&IntegrationOwner::from(native.scope()))?;
    println!(
        "ORG_OFFICE_HOST_SCOPE:{}",
        serde_json::to_string(native.scope())?
    );
    std::io::stdout().flush()?;
    ensure!(authorize(&native, "read", "missing-office-read").is_err());
    ensure!(
        NativeOfficeComposition::initialize_metadata(
            &native,
            &engine,
            NativeOfficeProviders::default(),
            "missing-office-write"
        )
        .is_err()
    );
    ensure!(
        NativeDomainGuard::observe(native.profile()?, native.scope(), NativeDomain::Office)?
            .is_none()
    );
    if std::env::var("KCODER_TEST_OFFICE_HOST_MODE").as_deref() == Ok("manager") {
        let foreign: IntegrationScope =
            serde_json::from_str(&std::env::var("KCODER_TEST_FOREIGN_OFFICE_SCOPE")?)?;
        ensure!(native.validate_scope(&foreign).is_err());
        let foreign_file = PathBuf::from(
            std::env::var_os("KCODER_TEST_PRIVATE_OFFICE_FILE")
                .context("private witness missing")?,
        );
        ensure!(std::fs::read(&foreign_file).is_err());
        println!("ORG_OFFICE_HOST_EVIDENCE:manager-other-scope-and-private-os-read-denied");
        return Ok(());
    }
    let assets = Arc::new(NativeOfficeFileAssets::capture(
        &native,
        &engine,
        Arc::new(NativeOfficeTransfers::default()),
        None,
    )?);
    let input_bytes = b"Owned original private Office upload";
    let mut staging = crate::app_server::attachments::AttachmentDirectories::default();
    let saved = crate::app_server::attachments::attachment_save(
        &engine.session_id(),
        &AttachmentSaveParams {
            retention: None,
            filename: "owned-material.txt".into(),
            content_base64: STANDARD.encode(input_bytes),
        },
        &mut staging,
    )?;
    let input_request = request(
        &native,
        Some("owned-material-write"),
        json!({
        "filename":"owned-material.txt","mediaType":"text/plain","expectedBytes":input_bytes.len(),
        "expectedSha256":format!("{:x}",Sha256::digest(input_bytes))}),
    );
    ensure!(
        assets
            .prepare_finished_input(
                &native,
                &staging,
                &saved,
                &input_request,
                &CancellationToken::new()
            )
            .is_err()
    );
    phase("grant-read-write-use")?;
    let prepared = assets.prepare_finished_input(
        &native,
        &staging,
        &saved,
        &input_request,
        &CancellationToken::new(),
    )?;
    let material = assets.commit_finished_input(&native, prepared, &CancellationToken::new())?;
    let read_input = request(&native, None, json!({"inputId":material.input_id}));
    ensure!(
        assets
            .prepare_input(&native, &read_input, &CancellationToken::new())
            .await?
            .sha256
            == Some(material.sha256.clone())
    );
    let metadata = NativeOfficeComposition::initialize_metadata(
        &native,
        &engine,
        NativeOfficeProviders::default(),
        "authorized-office-initialize",
    )?;
    ensure!(authorize(&native, "execute", "execute-not-granted").is_err());
    let identity = TurnAttemptIdentity {
        thread_id: engine.session_id(),
        turn_id: "owned-office-turn".into(),
        attempt_id: "owned-office-attempt".into(),
    };
    TurnAttemptStore::open(
        &engine.session_storage_dir_for(&identity.thread_id),
        &identity.thread_id,
    )?
    .begin(TurnAttemptRecord {
        version: 1,
        identity: identity.clone(),
        client_presentation: None,
        parent_attempt_id: None,
        retry_operation_id: None,
        accepted_at_ms: 1,
        input_context_hash: "a".repeat(64),
        request_fingerprint: Some("b".repeat(64)),
        retained_input: None,
        status: TurnAttemptStatus::Accepted,
        completion: None,
    })?;
    let task = OfficeTaskRef {
        thread_id: identity.thread_id.clone(),
        turn_id: identity.turn_id.clone(),
        run_id: None,
    };
    let blocked = generate(&native, &task, "generation-without-execute");
    ensure!(
        dispatch(&metadata, &native, "integrations/office/generate", &blocked)
            .await?
            .status
            == IntegrationStatus::Rejected
    );
    ensure!(
        metadata
            .service()
            .store
            .read_action("generation-without-execute")?
            .is_none()
    );
    phase("grant-all")?;
    let selector: Value = serde_json::from_slice(&std::fs::read(
        std::env::var_os("KCODER_OFFICE_NATIVE_NODE_LAUNCH").context("sealed launch missing")?,
    )?)?;
    let runtime = &selector["runtime"];
    let installed = NativeOfficeLaunchAuthority::from_native_launch(
        &native,
        &PathBuf::from(
            selector["componentRoot"]
                .as_str()
                .context("component root missing")?,
        ),
        selector["manifestSha256"]
            .as_str()
            .context("manifest hash missing")?,
        NativeOfficeRuntimeAuthority::from_native_launcher(
            &PathBuf::from(runtime["program"].as_str().context("Node missing")?),
            runtime["sha256"].as_str().context("Node hash missing")?,
            OfficeNodeRuntimeMode::StandaloneNode,
            runtime["nodeVersion"]
                .as_str()
                .context("Node version missing")?,
            None,
        )?,
    )?
    .with_owned_test_program(&PathBuf::from(
        std::env::var_os("KCODER_OFFICE_RESOURCE_OWNER_BIN").context("owner runtime missing")?,
    ))
    .resolve(&CancellationToken::new())
    .await?;
    let host = NativeOfficeComposition::observe(
        &native,
        &engine,
        installed,
        NativeOfficeProviders {
            tasks: Some(Arc::new(NativeOfficeAcceptedTurnAuthority)),
            assets: Some(assets.clone()),
            ports: None,
        },
    )?
    .context("Office namespace missing")?;
    let mut fake = task.clone();
    fake.turn_id = "invented-task".into();
    let refused_task = dispatch(
        &host,
        &native,
        "integrations/office/generate",
        &generate(&native, &fake, "fake-task"),
    )
    .await?;
    ensure!(
        refused_task.status != IntegrationStatus::Completed
            && refused_task.result.as_ref().is_none()
    );
    ensure!(
        host.service()
            .host
            .validate_task(native.scope(), &fake)
            .is_err()
    );
    ensure!(host.service().store.read_action("fake-task")?.is_none());
    let generated = generate(&native, &task, "authorized-generation");
    let reply = dispatch(&host, &native, "integrations/office/generate", &generated).await?;
    ensure!(reply.status == IntegrationStatus::Completed, "{reply:?}");
    let manifest: OfficeArtifactManifest =
        serde_json::from_value(reply.result.as_ref().unwrap()["manifest"].clone())?;
    let reference = OfficeArtifactRef {
        id: manifest.id.clone(),
        revision: manifest.revision,
    };
    TurnAttemptStore::open_existing(
        &engine.session_storage_dir_for(&identity.thread_id),
        &identity.thread_id,
    )?
    .unwrap()
    .finish(
        &identity,
        kcoder_state::turn_attempt_store::TurnAttemptCompletion {
            status: TurnAttemptStatus::Completed,
            finished_at_ms: 2,
            error: None,
            provider_failure: None,
            partial_output: String::new(),
            partial_output_truncated: false,
            committed_history_uuid: None,
        },
    )?;
    let export = request(
        &native,
        Some("authorized-export"),
        json!({"reference":reference,"format":"docx"}),
    );
    let reply = dispatch(&host, &native, "integrations/artifact/export", &export).await?;
    ensure!(reply.status == IntegrationStatus::Completed, "{reply:?}");
    let receipt: OfficeExportReceipt =
        serde_json::from_value(reply.result.as_ref().unwrap()["export"].clone())?;
    let chunk = AttachmentReadChunkParams {
        thread_id: task.thread_id.clone(),
        path: NativeOfficeFileAssets::export_locator(&receipt),
        offset: 0,
        length: 512 * 1024,
    };
    let downloaded = assets
        .read_attachment_chunk(&native, &chunk, &CancellationToken::new())
        .await?;
    let bytes = STANDARD.decode(downloaded.content_base64)?;
    ensure!(bytes.starts_with(b"PK") && downloaded.eof && bytes.len() as u64 == receipt.bytes);
    ensure!(format!("{:x}", Sha256::digest(&bytes)) == receipt.sha256);
    let read = request(&native, None, json!({"reference":reference}));
    phase("revoke-export")?;
    ensure!(
        dispatch(&host, &native, "integrations/artifact/read", &read)
            .await?
            .status
            == IntegrationStatus::Completed
    );
    ensure!(
        dispatch(&host, &native, "integrations/artifact/export", &export)
            .await?
            .status
            == IntegrationStatus::Rejected
    );
    ensure!(
        assets
            .read_attachment_chunk(&native, &chunk, &CancellationToken::new())
            .await
            .is_err()
    );
    phase("revoke-read")?;
    ensure!(
        assets
            .prepare_input(&native, &read_input, &CancellationToken::new())
            .await
            .is_err()
    );
    ensure!(
        dispatch(&host, &native, "integrations/artifact/read", &read)
            .await?
            .status
            == IntegrationStatus::Rejected
    );
    ensure!(
        assets
            .prepare_export(
                &native,
                &export,
                &manifest,
                bytes.clone(),
                &CancellationToken::new()
            )
            .await
            .is_err()
    );
    ensure!(
        assets
            .read_attachment_chunk(&native, &chunk, &CancellationToken::new())
            .await
            .is_err()
    );
    phase("restore-all")?;
    let uncertain = generate(&native, &task, "revoked-during-generation");
    let reply = dispatch(&host, &native, "integrations/office/generate", &uncertain).await?;
    ensure!(
        reply.status == IntegrationStatus::Unknown && reply.result.as_ref().is_none(),
        "{reply:?}"
    );
    let original = host
        .service()
        .store
        .read_action("revoked-during-generation")?
        .context("original operation missing")?;
    ensure!(original.phase != "completed");
    phase("restore-after-generated")?;
    let retry = dispatch(&host, &native, "integrations/office/generate", &uncertain).await?;
    ensure!(retry.status == IntegrationStatus::Unknown && retry.result.as_ref().is_none());
    ensure!(
        host.service()
            .store
            .read_action("revoked-during-generation")?
            .unwrap()
            == original
    );
    ensure!(
        host.service()
            .store
            .generation_publication("revoked-during-generation")?
            .is_none()
    );
    ensure!(
        assets
            .read_attachment_chunk(&native, &chunk, &CancellationToken::new())
            .await?
            .eof
    );
    println!(
        "ORG_OFFICE_HOST_EVIDENCE:{}",
        json!({"resource":resource,
        "actualUid":unsafe {libc::geteuid()},"dedicatedScopeLivePdp":true,"actualDocxSha256":receipt.sha256,
        "completedAcceptedProvenance":true,"directLeaseReadExportRevoked":true,
        "generatedThenRevokedOriginalUnknownNoReplay":true,"providerCalls":0,"paidCalls":0})
    );
    Ok(())
}
