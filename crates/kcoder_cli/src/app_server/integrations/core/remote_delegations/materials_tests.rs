//! Real original OfficeStore bytes; selectors and declared hashes are never upload authority.
use super::*;
use crate::app_server::integrations::core::remote_delegations::source_budget::tests::Fixture;
use kcoder_native_journal::NativeOperations;
use kcoder_native_scope::{NativeDomain, NativeDomainGuard};
use kcoder_state::integrations::office::{OfficeInputMetadata, OfficeStore};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use tokio_util::sync::CancellationToken;
#[path = "materials_ssh_tests.rs"]
mod ssh_tests;

fn accept(f: &Fixture, bytes: &[u8]) -> OfficeArtifactRef {
    let (_, store) = NativeDomainGuard::initialize(
        f.native.profile().unwrap(),
        f.native.scope(),
        NativeDomain::Office,
        "actual-material-upload",
        |directory| {
            OfficeStore::create_in(
                directory,
                OsStr::new("data"),
                kcoder_types::integrations::core::IntegrationOwner::from(f.native.scope()),
            )
        },
    )
    .unwrap();
    let id = "actual-original-material";
    store
        .begin_input_attempt(
            "actual-material-upload",
            id,
            OfficeInputMetadata {
                filename: "original-literal.txt".into(),
                media_type: "text/plain".into(),
                expected_bytes: bytes.len() as u64,
                expected_sha256: format!("{:x}", Sha256::digest(bytes)),
            },
        )
        .unwrap();
    store
        .complete_stored_input(
            "actual-material-upload",
            id,
            &mut std::io::Cursor::new(bytes),
            || true,
        )
        .unwrap();
    OfficeArtifactRef {
        id: id.into(),
        revision: 1,
    }
}

#[tokio::test]
async fn freezes_all_original_material_bytes_and_rejects_revisions_without_new_namespace_or_task() {
    let f = Fixture::new();
    let bytes = "原材料正文，不是授权。\n".repeat(8192).into_bytes();
    let reference = accept(&f, &bytes);
    f.engine
        .state
        .history_attempt_scope(f.attempt.clone())
        .unwrap()
        .run(async {
            let actual = ToolContext::new(f.engine.state.clone())
                .with_tool_call_id("actual-material-tool-call");
            let frozen = capture(&f.native, &f.engine, &f.attempt, &actual, &reference).unwrap();
            assert_eq!(frozen.bytes(), bytes);
            assert_eq!(frozen.descriptor().bytes, bytes.len() as u64);
            assert_eq!(
                frozen.descriptor().sha256,
                format!("{:x}", Sha256::digest(&bytes))
            );
            frozen.verify(&CancellationToken::new()).unwrap();
            let cancel = CancellationToken::new();
            cancel.cancel();
            assert!(frozen.verify(&cancel).is_err());
            assert!(
                capture(
                    &f.native,
                    &f.engine,
                    &f.attempt,
                    &actual,
                    &OfficeArtifactRef {
                        id: reference.id,
                        revision: 2
                    }
                )
                .is_err()
            );
            assert!(NativeOperations::load(&f.native).unwrap().is_none());
            assert!(
                super::super::super::budget_host::NativeBudgetService::load(&f.native)
                    .unwrap()
                    .is_none()
            );
        })
        .await;
    f.close().await;
}

#[tokio::test]
async fn missing_native_office_input_cannot_be_supplied_by_a_selector_or_hash() {
    let f = Fixture::new();
    f.engine
        .state
        .history_attempt_scope(f.attempt.clone())
        .unwrap()
        .run(async {
            let actual = ToolContext::new(f.engine.state.clone())
                .with_tool_call_id("actual-material-tool-call");
            assert!(
                capture(
                    &f.native,
                    &f.engine,
                    &f.attempt,
                    &actual,
                    &OfficeArtifactRef {
                        id: "model-claims-existing-material".into(),
                        revision: 1
                    }
                )
                .is_err()
            );
            assert!(
                NativeDomainGuard::observe(
                    f.native.profile().unwrap(),
                    f.native.scope(),
                    NativeDomain::Office
                )
                .unwrap()
                .is_none()
            );
            assert!(NativeOperations::load(&f.native).unwrap().is_none());
        })
        .await;
    f.close().await;
}
