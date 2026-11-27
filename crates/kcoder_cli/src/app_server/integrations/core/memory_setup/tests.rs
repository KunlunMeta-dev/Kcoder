use super::*;
use crate::app_server::integrations::core::{NativeDomain, NativeDomainGuard};
use kcoder_config::PrivateDirectory;
use std::ffi::OsStr;

fn fixture() -> (tempfile::TempDir, NativeIntegrationContext) {
    let root = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_existing(root.path()).unwrap();
    parent.create_private_child(OsStr::new("profile")).unwrap();
    parent
        .create_private_child(OsStr::new("workspace"))
        .unwrap();
    let context = NativeIntegrationContext::capture(
        &root.path().join("profile"),
        &root.path().join("workspace"),
        "memory-setup-fixture",
        "fixture-revision",
    )
    .unwrap();
    (root, context)
}

#[test]
fn enabled_memory_setup_establishes_one_real_source_and_reconnect_preserves_it() {
    let (_root, context) = fixture();
    assert!(NativeMemoryService::load(&context).unwrap().is_none());
    NativeMemoryService::prepare_enabled(&context).unwrap();
    let guard = NativeDomainGuard::observe(
        context.profile().unwrap(),
        context.scope(),
        NativeDomain::Memory,
    )
    .unwrap()
    .unwrap();
    let source = context
        .profile_path()
        .unwrap()
        .join(guard.namespace_id())
        .join("data/memory-review.json");
    let bytes = std::fs::read(&source).unwrap();
    let identity = guard
        .directory(context.profile().unwrap())
        .unwrap()
        .directory_identity()
        .unwrap();
    let reconnected = context.recapture_for_owned_service().unwrap();
    NativeMemoryService::prepare_enabled(&reconnected).unwrap();
    assert_eq!(std::fs::read(source).unwrap(), bytes);
    assert_eq!(
        guard
            .directory(reconnected.profile().unwrap())
            .unwrap()
            .directory_identity()
            .unwrap(),
        identity
    );
    assert!(NativeMemoryService::load(&reconnected).unwrap().is_some());
}

#[test]
fn enabled_memory_setup_never_recreates_a_missing_committed_source() {
    let (_root, context) = fixture();
    NativeMemoryService::prepare_enabled(&context).unwrap();
    let namespace =
        NativeDomainGuard::expected_namespace_id(context.scope(), NativeDomain::Memory).unwrap();
    let path = context.profile_path().unwrap().join(namespace);
    let held = context.profile_path().unwrap().join("held-original-memory");
    std::fs::rename(&path, &held).unwrap();
    let original = std::fs::read(held.join("data/memory-review.json")).unwrap();
    assert!(NativeMemoryService::prepare_enabled(&context).is_err());
    assert!(!path.exists());
    assert_eq!(
        std::fs::read(held.join("data/memory-review.json")).unwrap(),
        original
    );
}

#[test]
fn enabled_memory_setup_detects_loss_of_both_domain_marker_and_namespace() {
    let (_root, context) = fixture();
    NativeMemoryService::prepare_enabled(&context).unwrap();
    let namespace =
        NativeDomainGuard::expected_namespace_id(context.scope(), NativeDomain::Memory).unwrap();
    let profile = context.profile_path().unwrap();
    let path = profile.join(&namespace);
    let marker = profile.join(format!(".{namespace}.jsonl"));
    std::fs::rename(&path, profile.join("held-memory-data")).unwrap();
    std::fs::rename(&marker, profile.join("held-memory-control")).unwrap();
    assert!(NativeMemoryService::load(&context).unwrap().is_none());
    assert_eq!(
        NativeMemoryService::prepare_enabled(&context)
            .unwrap_err()
            .to_string(),
        "MEMORY_SETUP_SOURCE_MISSING"
    );
    assert!(!path.exists() && !marker.exists());
}

#[test]
fn enabled_memory_setup_does_not_adopt_an_orphan_namespace() {
    let (_root, context) = fixture();
    let namespace =
        NativeDomainGuard::expected_namespace_id(context.scope(), NativeDomain::Memory).unwrap();
    let orphan = context
        .profile()
        .unwrap()
        .create_private_child(OsStr::new(&namespace))
        .unwrap();
    assert!(NativeMemoryService::prepare_enabled(&context).is_err());
    assert!(orphan.open_entry_handle(OsStr::new("data")).is_err());
}

#[test]
fn enabled_memory_setup_does_not_retry_an_unconfirmed_first_setup() {
    let (_root, context) = fixture();
    let namespace =
        NativeDomainGuard::expected_namespace_id(context.scope(), NativeDomain::Memory).unwrap();
    let witness_name = format!(".memory-setup-{namespace}.json");
    context
        .profile()
        .unwrap()
        .atomic_replace(OsStr::new(&witness_name), b"{")
        .unwrap();
    assert!(NativeMemoryService::prepare_enabled(&context).is_err());
    assert!(!context.profile_path().unwrap().join(namespace).exists());
    assert_eq!(
        std::fs::read(context.profile_path().unwrap().join(witness_name)).unwrap(),
        b"{"
    );
}

#[test]
fn memory_diagnostics_report_only_known_static_codes() {
    let unsafe_error = anyhow::anyhow!("private path, memory body, token must not be logged");
    assert_eq!(
        safe_memory_code(&unsafe_error),
        "MEMORY_TURN_CONTEXT_UNAVAILABLE"
    );
    let known = anyhow::anyhow!("MEMORY_BUSY").context("private context");
    assert_eq!(safe_memory_code(&known), "MEMORY_BUSY");
    let spoofed = anyhow::anyhow!("MEMORY_BUSY private body");
    assert_eq!(
        safe_memory_code(&spoofed),
        "MEMORY_TURN_CONTEXT_UNAVAILABLE"
    );
}
