use super::private_credentials::{API, TOKEN, source};
use super::*;
use crate::source_transfer::private_credentials::*;
use kcoder_config::CredentialStoreMode;
use serde_json::json;
#[test]
fn received_private_candidates_are_paginated_original_metadata_without_secret_or_key_birth() {
    let f = Fixture::new();
    let (manifest, receipt, _) = source(&f, CredentialStoreMode::File);
    let native = f
        .target_profile
        .join("migrations/source-transfer/native.json");
    let before = std::fs::read(&native).unwrap();
    std::fs::rename(&f.files, f.files.with_extension("withheld")).unwrap();
    let page = private_credential_candidates(
        &f.target,
        f.source.authority(),
        &f.request,
        &receipt,
        &manifest.entries[0].id,
        0,
    )
    .unwrap();
    assert_eq!(page.total_items, 2);
    assert_eq!(page.items.len(), 2);
    assert!(page.next_page.is_none());
    let value = serde_json::to_value(&page).unwrap();
    assert!(!value.to_string().contains(API));
    assert!(!value.to_string().contains(TOKEN));
    for row in value["items"].as_array().unwrap() {
        assert_eq!(row["sourceVerificationRequired"], true);
    }
    let mcp = value["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "mcp")
        .unwrap();
    assert_eq!(
        mcp["fields"],
        json!([{"kind":"environment","name":"TOKEN"}])
    );
    assert_eq!(mcp["definitionSha256"].as_str().unwrap().len(), 64);
    assert_eq!(std::fs::read(&native).unwrap(), before);
    assert!(
        !f.target_profile
            .join("migrations/source-transfer/private-credentials")
            .exists()
    );
    assert!(
        private_credential_candidates(
            &f.target,
            f.source.authority(),
            &f.request,
            &receipt,
            &manifest.entries[0].id,
            1
        )
        .is_err()
    );
    let mut wrong = f.source.authority().clone();
    wrong.account_id = "a".repeat(64);
    assert!(
        private_credential_candidates(
            &f.target,
            &wrong,
            &f.request,
            &receipt,
            &manifest.entries[0].id,
            0
        )
        .is_err()
    );
}
