//! Only original source custody is observed; reads cannot repair missing births.
use super::private_credentials::{Backend, consent, offer, source};
use super::*;
use crate::source_transfer::private_credentials::*;
use kcoder_config::{CredentialStoreMode, PrivateLeaseMode};
use std::{collections::BTreeMap, ffi::OsStr};
fn files(root: &Path) -> BTreeMap<PathBuf, String> {
    let mut out = BTreeMap::new();
    fn visit(root: &Path, out: &mut BTreeMap<PathBuf, String>) {
        for entry in std::fs::read_dir(root).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                visit(&entry.path(), out);
            } else {
                use sha2::Digest;
                out.insert(
                    entry.path(),
                    format!(
                        "{:x}",
                        sha2::Sha256::digest(std::fs::read(entry.path()).unwrap())
                    ),
                );
            }
        }
    }
    visit(root, &mut out);
    out
}
#[test]
fn source_control_reopens_with_raw_source_gone_without_writing_or_creating_a_peer() {
    let f = Fixture::new();
    let (m, r, s) = source(&f, CredentialStoreMode::File);
    let backend = Backend::new(false);
    let offer = offer(&f, &m, &r, s, CredentialStoreMode::File, &backend);
    seal_private_credentials(&f.source, f.target.authority(), &offer, consent()).unwrap();
    std::fs::rename(&f.files, f.files.with_extension("offline")).unwrap();
    let before = files(&f.source_profile);
    let observed = observe_existing_source_private_credentials(
        &f.source_profile,
        &f.request,
        &offer.context.offer_id,
    )
    .unwrap();
    assert!(observed.control.ready && !observed.writer_running);
    assert_eq!(observed.offer, offer);
    assert_eq!(before, files(&f.source_profile));
}
#[test]
fn a_source_writer_stays_running_after_a_cancel_request_until_its_actual_lease_exits() {
    let f = Fixture::new();
    let (m, r, s) = source(&f, CredentialStoreMode::File);
    let backend = Backend::new(false);
    let offer = offer(&f, &m, &r, s, CredentialStoreMode::File, &backend);
    seal_private_credentials(&f.source, f.target.authority(), &offer, consent()).unwrap();
    let path = f
        .source_profile
        .join("migrations/source-transfer/private-credentials")
        .join(format!("source-{}", offer.context.offer_id));
    let directory = PrivateDirectory::open_existing(&path).unwrap();
    let identity = directory
        .portable_regular_identity(OsStr::new("writer.lock"))
        .unwrap();
    let writer = directory
        .try_existing_portable_lock(
            OsStr::new("writer.lock"),
            &identity,
            PrivateLeaseMode::Exclusive,
        )
        .unwrap()
        .unwrap();
    source_private_credential_control(&f.source, f.target.authority(), &offer)
        .unwrap()
        .cancel(&uuid::Uuid::new_v4().to_string())
        .unwrap();
    let observed = observe_existing_source_private_credentials(
        &f.source_profile,
        &f.request,
        &offer.context.offer_id,
    )
    .unwrap();
    assert!(observed.writer_running && observed.control.cancelled);
    drop(writer);
    let observed = observe_existing_source_private_credentials(
        &f.source_profile,
        &f.request,
        &offer.context.offer_id,
    )
    .unwrap();
    assert!(!observed.writer_running && observed.control.cancelled);
}
#[test]
fn missing_source_role_private_birth_or_born_ciphertext_remains_unknown_without_regeneration() {
    let f = Fixture::new();
    let original = files(&f.source_profile);
    assert!(
        observe_existing_source_private_credentials(
            &f.source_profile,
            &f.request,
            &uuid::Uuid::new_v4().to_string()
        )
        .is_err()
    );
    assert_eq!(original, files(&f.source_profile));
    let (m, r, s) = source(&f, CredentialStoreMode::File);
    let backend = Backend::new(false);
    let offer = offer(&f, &m, &r, s, CredentialStoreMode::File, &backend);
    seal_private_credentials(&f.source, f.target.authority(), &offer, consent()).unwrap();
    let envelope = f
        .source_profile
        .join("migrations/source-transfer/private-credentials")
        .join(format!("source-{}", offer.context.offer_id))
        .join("envelope.json");
    std::fs::rename(&envelope, envelope.with_extension("withheld")).unwrap();
    let original = files(&f.source_profile);
    assert!(
        observe_existing_source_private_credentials(
            &f.source_profile,
            &f.request,
            &offer.context.offer_id
        )
        .is_err()
    );
    assert_eq!(original, files(&f.source_profile));
    assert!(!envelope.exists());
    let identity = f
        .source_profile
        .join("migrations/source-transfer/native.json");
    std::fs::rename(&identity, identity.with_extension("withheld")).unwrap();
    let original = files(&f.source_profile);
    assert!(
        observe_existing_source_private_credentials(
            &f.source_profile,
            &f.request,
            &offer.context.offer_id
        )
        .is_err()
    );
    assert_eq!(original, files(&f.source_profile));
    assert!(!identity.exists());
}
