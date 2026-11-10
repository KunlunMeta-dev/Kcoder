//! Native Office resources exercised with an explicit real launcher.

use super::*;
use crate::app_server::integrations::office::native_host::{
    NativeOfficeAcceptedTurnAuthority, NativeOfficeComposition, NativeOfficeProviders,
};
#[cfg(target_os = "linux")]
use anyhow::Result;
#[cfg(target_os = "linux")]
use async_trait::async_trait;
#[cfg(target_os = "linux")]
use kcoder_office_worker::node_generator::{
    NativeOfficeNodeLaunch, NativeOfficeResourceVerifier, OfficeNodeGenerator,
};
use kcoder_state::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
use kcoder_types::{
    TurnAttemptIdentity, TurnAttemptStatus,
    integrations::{core::*, office::*},
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;
#[path = "resource_test_context.rs"]
mod resource_test_context;
use resource_test_context::native_context;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchFixture {
    component_root: PathBuf,
    manifest_sha256: String,
    runtime: RuntimeFixture,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeFixture {
    program: PathBuf,
    sha256: String,
    mode: String,
    node_version: String,
    electron_version: Option<String>,
}
fn launch_fixture(name: &str) -> LaunchFixture {
    let file = std::env::var_os(name).expect("explicit native-launch observation fixture");
    serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap()
}
fn runtime(value: &RuntimeFixture) -> NativeOfficeRuntimeAuthority {
    NativeOfficeRuntimeAuthority::from_native_launcher(
        &value.program,
        &value.sha256,
        match value.mode.as_str() {
            "standalone_node" => OfficeNodeRuntimeMode::StandaloneNode,
            "electron_as_node" => OfficeNodeRuntimeMode::ElectronAsNode,
            _ => panic!("explicit mode"),
        },
        &value.node_version,
        value.electron_version.as_deref(),
    )
    .unwrap()
}
#[tokio::test]
#[ignore = "Requires actual staged resources, explicit Node runtime and current owned KCoder program"]
async fn actual_native_resource_resolver_probes_plain_node_and_generates_real_file() {
    actual("KCODER_OFFICE_NATIVE_NODE_LAUNCH").await;
}
#[tokio::test]
#[ignore = "Requires actual cached/installed Electron with RunAsNode enabled and current owned KCoder program"]
async fn actual_native_resource_resolver_probes_electron_as_node_and_generates_real_file() {
    actual("KCODER_OFFICE_NATIVE_ELECTRON_LAUNCH").await;
}
async fn actual(name: &str) {
    let launch = launch_fixture(name);
    let (_temp, context, profile, workspace) = native_context();
    let owner = PathBuf::from(
        std::env::var_os("KCODER_OFFICE_RESOURCE_OWNER_BIN").expect("current native owner binary"),
    );
    let installed = NativeOfficeLaunchAuthority::from_native_launch(
        &context,
        &launch.component_root,
        &launch.manifest_sha256,
        runtime(&launch.runtime),
    )
    .unwrap()
    .with_owned_test_program(&owner)
    .resolve(&CancellationToken::new())
    .await
    .unwrap();
    let engine = crate::app_server::tests::catalog_list_test_engine(&workspace)
        .with_settings_persistence_path(profile.join("settings.json"));
    engine.settings.write().unwrap().integrations.office.enabled = true;
    let task = OfficeTaskRef {
        thread_id: engine.session_id(),
        turn_id: "actual-resource-turn".into(),
        run_id: None,
    };
    TurnAttemptStore::open(
        &engine.session_storage_dir_for(&task.thread_id),
        &task.thread_id,
    )
    .unwrap()
    .begin(TurnAttemptRecord {
        version: 1,
        identity: TurnAttemptIdentity {
            thread_id: task.thread_id.clone(),
            turn_id: task.turn_id.clone(),
            attempt_id: "actual-resource-attempt".into(),
        },
        client_presentation: None,
        parent_attempt_id: None,
        retry_operation_id: None,
        accepted_at_ms: 1,
        input_context_hash: "a".repeat(64),
        request_fingerprint: Some("b".repeat(64)),
        retained_input: None,
        status: TurnAttemptStatus::Accepted,
        completion: None,
    })
    .unwrap();
    let host = NativeOfficeComposition::initialize(
        &context,
        &engine,
        installed,
        NativeOfficeProviders {
            tasks: Some(Arc::new(NativeOfficeAcceptedTurnAuthority)),
            ..Default::default()
        },
        "resource-native-initialize",
    )
    .unwrap();
    let request=IntegrationRequest{contract_version:IntegrationContractVersion::ParallelV1,request_id:"resource-generate-call".into(),scope:context.scope().clone(),operation_id:Some("resource-actual-generate".into()),expected_revision:None,timeout_ms:60000,cancellation_ref:None,payload:json!({"task":task,"sourceRefs":[],"specification":{"schemaVersion":1,"kind":"docx","title":"Actual native resource mode","paragraphs":[{"text":"Real controlled Node/Electron resource execution; layout not claimed."}]}}).as_object().unwrap().clone()};
    let result = host
        .dispatch(
            &context,
            "integrations/office/generate",
            &request,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.status, IntegrationStatus::Completed, "{result:?}");
    let artifact: OfficeArtifactManifest =
        serde_json::from_value(result.result.as_ref().unwrap()["manifest"].clone()).unwrap();
    let (bytes, total) = host
        .service()
        .store
        .read_artifact_chunk(
            &OfficeArtifactRef {
                id: artifact.id,
                revision: artifact.revision,
            },
            0,
            65536,
        )
        .unwrap();
    assert_eq!(&bytes[..2], b"PK");
    assert_eq!(total, artifact.bytes);
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), artifact.sha256);
    let wrong =
        runtime(&launch.runtime).with_test_runtime_mode(match launch.runtime.mode.as_str() {
            "standalone_node" => OfficeNodeRuntimeMode::ElectronAsNode,
            _ => OfficeNodeRuntimeMode::StandaloneNode,
        });
    assert!(
        NativeOfficeLaunchAuthority::from_native_launch(
            &context,
            &launch.component_root,
            &launch.manifest_sha256,
            wrong
        )
        .unwrap()
        .with_owned_test_program(&owner)
        .resolve(&CancellationToken::new())
        .await
        .is_err(),
        "wrong runtime mode must fail before running it as a different product"
    );
    assert!(
        NativeOfficeLaunchAuthority::from_native_launch(
            &context,
            &launch.component_root,
            &"0".repeat(64),
            runtime(&launch.runtime)
        )
        .unwrap()
        .with_owned_test_program(&owner)
        .resolve(&CancellationToken::new())
        .await
        .is_err()
    );
}

#[cfg(target_os = "linux")]
struct OwnedProcessFixtureVerifier;
#[cfg(target_os = "linux")]
#[async_trait]
impl NativeOfficeResourceVerifier for OwnedProcessFixtureVerifier {
    async fn verify(&self, _: &CancellationToken) -> Result<()> {
        Ok(())
    }
}
#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "Requires actual explicit Node and current KCoder owner binary; process lifecycle fixture only"]
async fn actual_owned_node_closed_stdout_timeout_and_cancel_stop_the_complete_tree() {
    let launch = launch_fixture("KCODER_OFFICE_NATIVE_NODE_LAUNCH");
    let owner = PathBuf::from(
        std::env::var_os("KCODER_OFFICE_RESOURCE_OWNER_BIN").expect("actual owner program"),
    );
    for cancelled in [false, true] {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("src")).unwrap();
        let marker = root.path().join("started.json");
        let script = format!(
            "import {{spawn}} from 'node:child_process';import {{writeFileSync,readFileSync}} from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{{}},1000)'],{{stdio:'ignore'}});writeFileSync({},JSON.stringify([process.pid,child.pid].map(pid=>({{pid,stat:readFileSync('/proc/'+pid+'/stat','utf8')}}))));process.stdout.end();setInterval(()=>{{}},1000);",
            serde_json::to_string(&marker).unwrap()
        );
        std::fs::write(root.path().join("src/cli.mjs"), script).unwrap();
        let generator = OfficeNodeGenerator::from_verified_native_launch(
            &launch.runtime.program,
            root.path(),
            NativeOfficeNodeLaunch {
                mode: OfficeNodeRuntimeMode::StandaloneNode,
                owner_program: owner.clone(),
                verify: Arc::new(OwnedProcessFixtureVerifier),
            },
        )
        .unwrap();
        let token = CancellationToken::new();
        let copied = token.clone();
        let work = tokio::spawn(async move {
            generator
                .generate(
                    &json!({"controlled":"owner lifecycle fixture, not production generation"}),
                    if cancelled { 10000 } else { 1000 },
                    &copied,
                )
                .await
        });
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while !marker.exists() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "owned fixture did not start"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let processes: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
        if cancelled {
            token.cancel();
        }
        let error = work
            .await
            .unwrap()
            .err()
            .expect("owned fixture must stop without an output")
            .to_string();
        assert!(
            error.contains(if cancelled {
                "OFFICE_CANCELLED"
            } else {
                "OFFICE_TIMEOUT"
            }),
            "{error}"
        );
        for process in processes {
            let pid = process["pid"].as_u64().unwrap();
            let current = std::fs::read_to_string(format!("/proc/{pid}/stat"));
            if let Ok(current) = current {
                let start = |value: &str| {
                    value
                        .rsplit_once(')')
                        .unwrap()
                        .1
                        .split_whitespace()
                        .nth(19)
                        .unwrap()
                        .parse::<u64>()
                        .unwrap()
                };
                assert_ne!(
                    start(process["stat"].as_str().unwrap()),
                    start(&current),
                    "original owned process remains after settlement"
                );
            }
        }
    }
}
