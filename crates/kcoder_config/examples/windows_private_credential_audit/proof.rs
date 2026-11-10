use anyhow::{Result, ensure};
use kcoder_config::imported_credentials::{CredentialImportRef, ImportStorage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub(super) const PROFILE: &str = "private-target-profile";
pub(super) const PROOF: &str = "private-keyring-proof.json";
pub(super) const INTENT: &str = "private-keyring-intent.json";
pub(super) const ADMISSION: &str = "private-keyring-admission.json";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Admission {
    pub owner: String,
    pub root_identity: String,
    pub profile_identity: String,
    pub baseline: Value,
    pub write_dispatched: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Intent {
    pub version: u32,
    pub owner: String,
    pub request_id: String,
    pub offers: Vec<String>,
    pub source_sha256: Vec<String>,
    pub provider_names: Vec<String>,
    pub mcp_names: Vec<String>,
    pub write_dispatched: bool,
    pub original_intent: Option<Value>,
    pub job_id: Option<String>,
    pub apply_request_id: String,
    pub apply_sequence: Option<u64>,
    pub undo_request_id: String,
    pub undo_sequence: Option<u64>,
    pub undo_dispatched: bool,
    pub phase: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Proof {
    pub version: u32,
    pub owner: String,
    pub root_identity: String,
    pub profile_identity: String,
    pub request_id: String,
    pub offers: Vec<String>,
    pub source_sha256: Vec<String>,
    pub provider_names: Vec<String>,
    pub mcp_names: Vec<String>,
    pub baseline: Value,
    pub references: Option<Vec<CredentialImportRef>>,
    pub group: Option<String>,
    pub recipient_sha256: Option<Vec<String>>,
}

pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(at, byte)| {
            if [8, 13, 18, 23].contains(&at) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            }
        })
}
pub(super) fn validate_intent(value: &Intent, owner: &str) -> Result<()> {
    ensure!(
        value.version == 1 && value.owner == owner && uuid(owner),
        "private_audit_intent"
    );
    ensure!(
        uuid(&value.request_id)
            && uuid(&value.apply_request_id)
            && uuid(&value.undo_request_id)
            && [value.apply_sequence, value.undo_sequence]
                .into_iter()
                .flatten()
                .all(|n| n <= 9_007_199_254_740_991),
        "private_audit_request"
    );
    ensure!(
        value.offers.len() == 2
            && value.offers.iter().all(|v| uuid(v))
            && value.offers[0] < value.offers[1],
        "private_audit_offers"
    );
    ensure!(
        value.source_sha256.len() == 4
            && value.source_sha256.iter().collect::<BTreeSet<_>>().len() == 4
            && value.source_sha256.iter().all(|v| v.len() == 64
                && v.bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())),
        "private_audit_digests"
    );
    ensure!(
        value.provider_names == ["WindowsPrivateProvider0", "WindowsPrivateProvider1"]
            && value.mcp_names == ["windows-private-notes-2", "windows-private-notes-3"],
        "private_audit_names"
    );
    Ok(())
}
pub(super) fn recipient_accounts(offers: &[String]) -> Vec<String> {
    offers
        .iter()
        .map(|offer| format!("migration-private-{}", offer.replace('-', "")))
        .collect()
}
pub(super) fn validate_references(proof: &Proof, refs: &[CredentialImportRef]) -> Result<()> {
    ensure!(
        refs.len() == 4
            && refs
                .iter()
                .map(|r| &r.account)
                .collect::<BTreeSet<_>>()
                .len()
                == 4,
        "private_audit_reference_count"
    );
    let mut providers = BTreeSet::new();
    let mut mcps = BTreeSet::new();
    for r in refs {
        ensure!(
            r.storage == ImportStorage::Keyring
                && r.predecessor.is_none()
                && r.profile_identity == proof.profile_identity
                && r.operation_id.len() == 37
                && r.operation_id.starts_with("cred-")
                && r.operation_id[5..].bytes().all(|b| b.is_ascii_hexdigit())
                && r.account.len() == 39
                && r.account.starts_with("import-")
                && r.account[7..].bytes().all(|b| b.is_ascii_hexdigit()),
            "private_audit_reference"
        );
        match &r.subject {
            kcoder_config::imported_credentials::mcp::CredentialSubject::Provider => {
                ensure!(
                    proof.provider_names.contains(&r.provider) && providers.insert(&r.provider),
                    "private_audit_subject"
                );
            }
            kcoder_config::imported_credentials::mcp::CredentialSubject::Mcp {
                env,
                headers,
                ..
            } => {
                ensure!(
                    proof.mcp_names.contains(&r.provider)
                        && mcps.insert(&r.provider)
                        && env == &["TOKEN"]
                        && headers.is_empty(),
                    "private_audit_subject"
                );
            }
        }
    }
    ensure!(
        providers.len() == 2 && mcps.len() == 2,
        "private_audit_subject_count"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn intent() -> Intent {
        Intent {
            version: 1,
            owner: "10000000-0000-4000-8000-000000000000".into(),
            request_id: "10000000-0000-4000-8000-000000000001".into(),
            undo_request_id: "10000000-0000-4000-8000-000000000002".into(),
            apply_request_id: "10000000-0000-4000-8000-000000000005".into(),
            apply_sequence: None,
            undo_sequence: None,
            offers: vec![
                "10000000-0000-4000-8000-000000000003".into(),
                "10000000-0000-4000-8000-000000000004".into(),
            ],
            source_sha256: ['a', 'b', 'c', 'd']
                .into_iter()
                .map(|c| c.to_string().repeat(64))
                .collect(),
            provider_names: vec![
                "WindowsPrivateProvider0".into(),
                "WindowsPrivateProvider1".into(),
            ],
            mcp_names: vec![
                "windows-private-notes-2".into(),
                "windows-private-notes-3".into(),
            ],
            write_dispatched: false,
            original_intent: None,
            job_id: None,
            undo_dispatched: false,
            phase: "preparing".into(),
        }
    }
    #[test]
    fn only_original_sorted_two_offer_accounts_are_derived() {
        let ids = vec![
            "10000000-0000-4000-8000-000000000001".into(),
            "10000000-0000-4000-8000-000000000002".into(),
        ];
        assert_eq!(
            recipient_accounts(&ids),
            [
                "migration-private-10000000000040008000000000000001",
                "migration-private-10000000000040008000000000000002"
            ]
        );
        assert!(!uuid("arbitrary-account"));
    }
    #[test]
    fn changed_or_duplicate_original_intent_is_rejected_before_backend_reads() {
        let value = intent();
        validate_intent(&value, &value.owner).unwrap();
        let mut bad = value.clone();
        bad.offers.reverse();
        assert!(validate_intent(&bad, &bad.owner).is_err());
        let mut bad = value.clone();
        bad.offers[1] = bad.offers[0].clone();
        assert!(validate_intent(&bad, &bad.owner).is_err());
        let mut bad = value.clone();
        bad.provider_names[0] = "personal-provider".into();
        assert!(validate_intent(&bad, &bad.owner).is_err());
        let mut bad = value;
        bad.source_sha256.pop();
        assert!(validate_intent(&bad, &bad.owner).is_err());
    }
    #[test]
    fn six_entry_scope_rejects_foreign_profile_file_fallback_and_duplicate_refs() {
        use kcoder_config::imported_credentials::mcp::CredentialSubject;
        let i = intent();
        let proof = Proof {
            version: 1,
            owner: i.owner,
            root_identity: "root".into(),
            profile_identity: "profile".into(),
            request_id: i.request_id,
            offers: i.offers,
            source_sha256: i.source_sha256,
            provider_names: i.provider_names,
            mcp_names: i.mcp_names,
            baseline: serde_json::json!({}),
            references: None,
            group: None,
            recipient_sha256: None,
        };
        let refs: Vec<_> = (0..4)
            .map(|n| CredentialImportRef {
                subject: if n < 2 {
                    CredentialSubject::Provider
                } else {
                    CredentialSubject::Mcp {
                        binding: "b".repeat(64),
                        env: vec!["TOKEN".into()],
                        headers: vec![],
                    }
                },
                operation_id: format!("cred-{n:032x}"),
                provider: if n < 2 {
                    proof.provider_names[n].clone()
                } else {
                    proof.mcp_names[n - 2].clone()
                },
                storage: ImportStorage::Keyring,
                account: format!("import-{n:032x}"),
                profile_identity: "profile".into(),
                predecessor: None,
            })
            .collect();
        validate_references(&proof, &refs).unwrap();
        let mut bad = refs.clone();
        bad[1].profile_identity = "peer-profile".into();
        assert!(validate_references(&proof, &bad).is_err());
        let mut bad = refs.clone();
        bad[1].storage = ImportStorage::File;
        assert!(validate_references(&proof, &bad).is_err());
        let mut bad = refs;
        bad[1].account = bad[0].account.clone();
        assert!(validate_references(&proof, &bad).is_err());
    }
}
