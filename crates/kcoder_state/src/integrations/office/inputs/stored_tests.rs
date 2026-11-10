use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

fn setup() -> (tempfile::TempDir, OfficeStore) {
    let temp = tempfile::tempdir().unwrap();
    let owner = IntegrationOwner {
        account_id: "owned-account".into(),
        target_id: "owned-target".into(),
        workspace_id: kcoder_types::integrations::core::IntegrationNullable::Value(
            "owned-workspace".into(),
        ),
        organization_id: None,
    };
    let store = OfficeStore::create(&temp.path().join("office"), owner).unwrap();
    (temp, store)
}
fn begin(store: &OfficeStore, bytes: &[u8]) {
    store
        .begin_input(
            "operation",
            "material",
            OfficeInputMetadata {
                filename: "material.txt".into(),
                media_type: "text/plain".into(),
                expected_bytes: bytes.len() as u64,
                expected_sha256: digest(bytes),
            },
        )
        .unwrap();
}
#[test]
fn stored_material_reopens_without_native_path_and_is_immutable() {
    let (temp, store) = setup();
    let bytes = b"actual durable material bytes";
    begin(&store, bytes);
    let receipt = store
        .complete_stored_input("operation", "material", &mut bytes.as_slice(), || true)
        .unwrap();
    let private = store.read_input("material").unwrap().unwrap();
    assert!(private.stored_content.is_some());
    assert_eq!(private.native.unwrap().path, "office-input:material:1");
    let owner = store.owner().clone();
    drop(store);
    let reopened = OfficeStore::open_existing(&temp.path().join("office"), owner)
        .unwrap()
        .unwrap();
    let (again, actual) = reopened
        .read_stored_input("material", 1024, || true)
        .unwrap()
        .unwrap();
    assert_eq!(again, receipt);
    assert_eq!(actual, bytes);
    assert_eq!(
        reopened
            .complete_stored_input("operation", "material", &mut bytes.as_slice(), || true)
            .unwrap(),
        receipt
    );
    assert!(reopened.read_stored_input("material", 3, || true).is_err());
}
#[test]
fn failed_hash_or_cancel_never_publishes_an_accepted_receipt() {
    for cancel in [false, true] {
        let (temp, store) = setup();
        let bytes = vec![7u8; 1024 * 1024 + 31];
        begin(&store, &bytes);
        let polls = AtomicUsize::new(0);
        let changed = vec![8u8; bytes.len()];
        let mut source: &[u8] = if cancel {
            bytes.as_slice()
        } else {
            changed.as_slice()
        };
        assert!(
            store
                .complete_stored_input("operation", "material", &mut source, || !cancel
                    || polls.fetch_add(1, Ordering::SeqCst) < 3)
                .is_err()
        );
        let record = store.read_input("material").unwrap().unwrap();
        assert_eq!(record.receipt.status, "pending");
        assert!(record.stored_content.is_none());
        let path = temp
            .path()
            .join("office")
            .join(format!("input-content-{}.blob", digest(&bytes)));
        assert!(!path.exists());
        assert!(
            std::fs::read_dir(temp.path().join("office"))
                .unwrap()
                .all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".tmp"))
        );
    }
}
#[test]
fn missing_or_changed_promised_blob_does_not_fallback_to_native_mapping() {
    for missing in [false, true] {
        let (temp, store) = setup();
        let bytes = b"immutable real bytes";
        begin(&store, bytes);
        store
            .complete_stored_input("operation", "material", &mut bytes.as_slice(), || true)
            .unwrap();
        let path = temp
            .path()
            .join("office")
            .join(format!("input-content-{}.blob", digest(bytes)));
        if missing {
            std::fs::remove_file(path).unwrap();
        } else {
            std::fs::write(path, b"corrupt").unwrap();
        }
        assert!(store.validate_stored_input("material", || true).is_err());
        assert!(store.read_stored_input("material", 1024, || true).is_err());
    }
}
