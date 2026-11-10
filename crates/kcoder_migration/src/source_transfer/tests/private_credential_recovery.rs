//! Recovery uses the original private catalog; no source contents or new keys are needed.
use super::private_credentials::{Backend, consent, offer, source};
use super::*;
use crate::source_transfer::private_credentials::*;
use kcoder_config::CredentialStoreMode;

#[test]
fn private_recovery_reopens_original_offer_cipher_and_received_binding_without_replay() {
    let f = Fixture::new();
    let (m, r, s) = source(&f, CredentialStoreMode::File);
    let b = Backend::new(false);
    let o = offer(&f, &m, &r, s, CredentialStoreMode::File, &b);
    let before = read_target_private_credentials(
        &f.target,
        f.source.authority(),
        &f.request,
        &o.context.offer_id,
        &b,
    )
    .unwrap();
    assert_eq!(before.offer, o);
    assert!(!before.control.ready);
    assert!(!before.writer_running);
    assert!(before.received.is_none());
    let e = seal_private_credentials(&f.source, f.target.authority(), &o, consent()).unwrap();
    let sealed = read_source_private_credentials(
        &f.source,
        f.target.authority(),
        &f.request,
        &o.context.offer_id,
    )
    .unwrap();
    assert_eq!(sealed.envelope.as_ref(), Some(&e));
    assert!(sealed.control.ready);
    let received = accept_private_credential_envelope(
        &f.target,
        f.source.authority(),
        &r,
        &o,
        &e,
        consent(),
        &b,
    )
    .unwrap();
    std::fs::rename(&f.files, f.files.with_extension("withheld")).unwrap();
    let reopened = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    let saved = read_target_private_credentials(
        &reopened,
        f.source.authority(),
        &f.request,
        &o.context.offer_id,
        &b,
    )
    .unwrap();
    assert!(saved.control.ready);
    assert_eq!(saved.received.as_ref(), Some(&received));
    received.verify_material(&f.target_profile, &b).unwrap();
    let changed_request = uuid::Uuid::new_v4().to_string();
    assert!(
        read_target_private_credentials(
            &reopened,
            f.source.authority(),
            &changed_request,
            &o.context.offer_id,
            &b
        )
        .is_err()
    );
    let mut wrong_peer = f.source.authority().clone();
    wrong_peer.account_id = "a".repeat(64);
    assert!(
        read_target_private_credentials(
            &reopened,
            &wrong_peer,
            &f.request,
            &o.context.offer_id,
            &b
        )
        .is_err()
    );
}

#[test]
fn rejected_ciphertext_is_not_a_verified_receive_and_observation_never_recreates_a_key() {
    let f = Fixture::new();
    let (m, r, s) = source(&f, CredentialStoreMode::File);
    let b = Backend::new(false);
    let o = offer(&f, &m, &r, s, CredentialStoreMode::File, &b);
    let mut e = seal_private_credentials(&f.source, f.target.authority(), &o, consent()).unwrap();
    e.ciphertext = "AAAA".into();
    assert!(
        accept_private_credential_envelope(
            &f.target,
            f.source.authority(),
            &r,
            &o,
            &e,
            consent(),
            &b
        )
        .is_err()
    );
    let error = read_target_private_credentials(
        &f.target,
        f.source.authority(),
        &f.request,
        &o.context.offer_id,
        &b,
    )
    .err()
    .expect("rejected ciphertext must remain unconfirmed");
    assert_eq!(error.to_string(), "private_credentials_receive_unconfirmed");
    let root = f
        .target_profile
        .join("migrations/source-transfer/private-credentials");
    let key = root.join(format!("target-{}/private-key.bin", o.context.offer_id));
    std::fs::remove_file(&key).unwrap();
    // A missing born key is unknown; observation must never repair it.
    assert!(
        read_target_private_credentials(
            &f.target,
            f.source.authority(),
            &f.request,
            &o.context.offer_id,
            &b
        )
        .is_err()
    );
    assert!(!key.exists());
    assert!(
        prepare_private_credential_offer(
            &f.target,
            PrivateCredentialOfferInput {
                request: &f.request,
                authenticated_source: f.source.authority(),
                receipt: &r,
                entry: &m.entries[0].id,
                offer_id: &o.context.offer_id,
                selections: o.context.selections.clone(),
                consent: consent(),
                policy: CredentialStoreMode::File,
            },
            &b
        )
        .is_err()
    );
    assert!(!key.exists());
}

#[test]
fn a_missing_verified_receive_receipt_is_unknown_and_is_never_republished() {
    let f = Fixture::new();
    let (m, r, s) = source(&f, CredentialStoreMode::File);
    let b = Backend::new(false);
    let o = offer(&f, &m, &r, s, CredentialStoreMode::File, &b);
    let e = seal_private_credentials(&f.source, f.target.authority(), &o, consent()).unwrap();
    accept_private_credential_envelope(&f.target, f.source.authority(), &r, &o, &e, consent(), &b)
        .unwrap();
    let receipt = f
        .target_profile
        .join("migrations/source-transfer/private-credentials")
        .join(format!(
            "target-{}/received-binding.json",
            o.context.offer_id
        ));
    std::fs::remove_file(&receipt).unwrap();
    assert!(
        read_target_private_credentials(
            &f.target,
            f.source.authority(),
            &f.request,
            &o.context.offer_id,
            &b
        )
        .is_err()
    );
    assert!(
        accept_private_credential_envelope(
            &f.target,
            f.source.authority(),
            &r,
            &o,
            &e,
            consent(),
            &b
        )
        .is_err()
    );
    assert!(!receipt.exists());
}

#[test]
fn custody_observes_the_actual_writer_and_a_cancel_request_does_not_mean_it_stopped() {
    let f = Fixture::new();
    let (m, r, s) = source(&f, CredentialStoreMode::File);
    let b = Backend::new(false);
    let o = offer(&f, &m, &r, s, CredentialStoreMode::File, &b);
    let path = f
        .target_profile
        .join("migrations/source-transfer/private-credentials")
        .join(format!("target-{}", o.context.offer_id));
    let directory = PrivateDirectory::open_existing(&path).unwrap();
    let identity = directory
        .portable_regular_identity(OsStr::new("writer.lock"))
        .unwrap();
    let held = directory
        .try_existing_portable_lock(
            OsStr::new("writer.lock"),
            &identity,
            kcoder_config::PrivateLeaseMode::Exclusive,
        )
        .unwrap()
        .unwrap();
    let observation = read_target_private_credentials(
        &f.target,
        f.source.authority(),
        &f.request,
        &o.context.offer_id,
        &b,
    )
    .unwrap();
    assert!(observation.writer_running);
    let cancelled = observation
        .controller()
        .cancel(&uuid::Uuid::new_v4().to_string())
        .unwrap();
    assert!(cancelled.cancelled);
    assert!(
        read_target_private_credentials(
            &f.target,
            f.source.authority(),
            &f.request,
            &o.context.offer_id,
            &b
        )
        .unwrap()
        .writer_running
    );
    assert!(
        observation
            .controller()
            .resume(cancelled.sequence, cancelled.cancel_watermark)
            .is_err()
    );
    drop(held);
    assert!(
        !read_target_private_credentials(
            &f.target,
            f.source.authority(),
            &f.request,
            &o.context.offer_id,
            &b
        )
        .unwrap()
        .writer_running
    );
    assert!(
        !observation
            .controller()
            .resume(cancelled.sequence, cancelled.cancel_watermark)
            .unwrap()
            .cancelled
    );
    assert!(
        !f.source
            .state(&f.request, &f.destination)
            .unwrap()
            .cancelled
    );
}

#[test]
fn unknown_private_material_does_not_block_original_grant_cancellation_or_clear_snapshot_cancel() {
    let f = Fixture::new();
    let (m, r, s) = source(&f, CredentialStoreMode::File);
    let b = Backend::new(false);
    let o = offer(&f, &m, &r, s, CredentialStoreMode::File, &b);
    let e = seal_private_credentials(&f.source, f.target.authority(), &o, consent()).unwrap();
    accept_private_credential_envelope(&f.target, f.source.authority(), &r, &o, &e, consent(), &b)
        .unwrap();
    let target_root = f
        .target_profile
        .join("migrations/source-transfer/private-credentials")
        .join(format!("target-{}", o.context.offer_id));
    let source_root = f
        .source_profile
        .join("migrations/source-transfer/private-credentials")
        .join(format!("source-{}", o.context.offer_id));
    for file in [
        target_root.join("private-key.bin"),
        target_root.join("offer.json"),
        source_root.join("envelope.json"),
    ] {
        std::fs::remove_file(file).unwrap();
    }
    assert!(
        read_target_private_credentials(
            &f.target,
            f.source.authority(),
            &f.request,
            &o.context.offer_id,
            &b
        )
        .is_err()
    );
    assert!(
        read_source_private_credentials(
            &f.source,
            f.target.authority(),
            &f.request,
            &o.context.offer_id
        )
        .is_err()
    );
    let target = target_private_credential_watermark(
        &f.target,
        f.source.authority(),
        &f.request,
        &o.context.offer_id,
    )
    .unwrap();
    let source = source_private_credential_watermark(
        &f.source,
        f.target.authority(),
        &f.request,
        &o.context.offer_id,
    )
    .unwrap();
    let command = uuid::Uuid::new_v4().to_string();
    let first = target.cancel(&command).unwrap();
    assert!(first.cancelled);
    assert!(target.cancel(&command).unwrap() == first);
    let later = target.cancel(&uuid::Uuid::new_v4().to_string()).unwrap();
    assert!(
        target
            .resume(first.sequence, first.cancel_watermark)
            .is_err()
    );
    assert!(
        !target
            .resume(later.sequence, later.cancel_watermark)
            .unwrap()
            .cancelled
    );
    f.source
        .cancel(
            &f.request,
            &f.destination,
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    let cancelled = source.cancel(&uuid::Uuid::new_v4().to_string()).unwrap();
    assert!(cancelled.cancelled);
    source
        .resume(cancelled.sequence, cancelled.cancel_watermark)
        .unwrap();
    assert!(
        f.source
            .state(&f.request, &f.destination)
            .unwrap()
            .cancelled
    );
    assert!(!target_root.join("private-key.bin").exists());
    assert!(!target_root.join("offer.json").exists());
    assert!(!source_root.join("envelope.json").exists());
    let mut wrong = f.source.authority().clone();
    wrong.account_id = "f".repeat(64);
    assert!(
        target_private_credential_watermark(&f.target, &wrong, &f.request, &o.context.offer_id)
            .is_err()
    );
    assert!(
        target_private_credential_watermark(
            &f.target,
            f.source.authority(),
            &uuid::Uuid::new_v4().to_string(),
            &o.context.offer_id
        )
        .is_err()
    );
}

#[test]
fn a_verified_receive_intent_without_its_receipt_is_pending_only_while_the_original_writer_runs() {
    let f = Fixture::new();
    let (m, r, s) = source(&f, CredentialStoreMode::File);
    let b = Backend::new(false);
    let o = offer(&f, &m, &r, s, CredentialStoreMode::File, &b);
    let root = f
        .target_profile
        .join("migrations/source-transfer/private-credentials");
    let mut catalog: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("catalog.json")).unwrap()).unwrap();
    let record = &mut catalog["operations"][format!("target-{}", o.context.offer_id)]["milestones"];
    record["receive_started"] = serde_json::json!(true);
    record["receive_verified"] = serde_json::json!(true);
    std::fs::write(
        root.join("catalog.json"),
        serde_json::to_vec(&catalog).unwrap(),
    )
    .unwrap();
    let directory =
        PrivateDirectory::open_existing(&root.join(format!("target-{}", o.context.offer_id)))
            .unwrap();
    let identity = directory
        .portable_regular_identity(OsStr::new("writer.lock"))
        .unwrap();
    let writer = directory
        .try_existing_portable_lock(
            OsStr::new("writer.lock"),
            &identity,
            kcoder_config::PrivateLeaseMode::Exclusive,
        )
        .unwrap()
        .unwrap();
    let pending = read_target_private_credentials(
        &f.target,
        f.source.authority(),
        &f.request,
        &o.context.offer_id,
        &b,
    )
    .unwrap();
    assert!(pending.writer_running && !pending.control.ready && pending.received.is_none());
    drop(writer);
    assert_eq!(
        read_target_private_credentials(
            &f.target,
            f.source.authority(),
            &f.request,
            &o.context.offer_id,
            &b
        )
        .err()
        .expect("the lost receive receipt must be unknown")
        .to_string(),
        "private_credentials_publication_unknown"
    );
    let control = target_private_credential_watermark(
        &f.target,
        f.source.authority(),
        &f.request,
        &o.context.offer_id,
    )
    .unwrap();
    assert!(
        control
            .cancel(&uuid::Uuid::new_v4().to_string())
            .unwrap()
            .cancelled
    );
    assert!(
        !root
            .join(format!(
                "target-{}/received-binding.json",
                o.context.offer_id
            ))
            .exists()
    );
}

#[test]
fn an_oversized_offer_is_rejected_before_a_recipient_key_or_private_namespace_is_born() {
    let f = Fixture::new();
    std::fs::write(
        f.target_profile.join("settings.json"),
        "{\"credential_store\":\"file\",\"providers\":{},\"mcp_servers\":[]}",
    )
    .unwrap();
    let names = (0..32)
        .map(|index| format!("OWNED_{index:02}_{}", "A".repeat(119)))
        .collect::<Vec<_>>();
    let env = names
        .iter()
        .map(|name| (name.clone(), serde_json::json!("SYNTHETIC_BUDGET_VALUE")))
        .collect::<serde_json::Map<_, _>>();
    std::fs::write(
        f.files.join("settings.json"),
        serde_json::json!({"model":"fixture",
        "mcpServers":{"notes":{"command":"must-not-run", "env":env}}})
        .to_string(),
    )
    .unwrap();
    let binding =
        ConfigurationBinding::capture_selected(&f.files.join("settings.json"), Kind::ClaudeCode)
            .unwrap();
    let inventory = binding.inventory().unwrap();
    let item = inventory
        .items
        .iter()
        .find(|item| item.mcp.is_some())
        .unwrap();
    let definition = super::super::model::digest(&item.mcp.as_ref().unwrap().config).unwrap();
    let fields = names
        .into_iter()
        .map(kcoder_types::migration::MigrationMcpPrivateField::Environment)
        .collect::<Vec<_>>();
    let selections = (0..64)
        .map(|index| PrivateCredentialSelection::Mcp {
            source_name: item.preview.source_name.clone(),
            target_name: format!("owned-{index}"),
            fields: fields.clone(),
            definition_sha256: definition.clone(),
        })
        .collect();
    let manifest = f.export(ExportSelection::Configuration(binding));
    let receipt = f.copy(&manifest);
    let result = prepare_private_credential_offer(
        &f.target,
        PrivateCredentialOfferInput {
            request: &f.request,
            authenticated_source: f.source.authority(),
            receipt: &receipt,
            entry: &manifest.entries[0].id,
            offer_id: &uuid::Uuid::new_v4().to_string(),
            selections,
            consent: consent(),
            policy: CredentialStoreMode::File,
        },
        &Backend::new(false),
    );
    assert_eq!(
        result
            .expect_err("encoded metadata must be admitted before generating the recipient key")
            .to_string(),
        "private_credentials_budget_exceeded"
    );
    assert!(
        !f.target_profile
            .join("migrations/source-transfer/private-credentials")
            .exists()
    );
}
