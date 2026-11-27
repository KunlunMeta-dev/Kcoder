use super::{ArchiveReferenceKind, ArchiveReferenceOwner, Catalog};
use kcoder_config::PrivateDirectory;
use std::ffi::OsStr;

fn fresh() -> (tempfile::TempDir, PrivateDirectory) {
    let root = tempfile::tempdir().unwrap();
    let directory = PrivateDirectory::open_or_create(root.path()).unwrap();
    (root, directory)
}
fn active(catalog: &mut Catalog, base: &PrivateDirectory, operation: &str) -> super::Reservation {
    let reservation = catalog.reserve(operation, &"a".repeat(64)).unwrap();
    let data = base
        .create_private_child(OsStr::new(&reservation.archive))
        .unwrap();
    catalog.attach(&reservation, &data).unwrap();
    catalog.activate(&reservation, &"b".repeat(64)).unwrap();
    reservation
}

#[test]
fn stable_requests_and_reopen_select_only_the_same_owned_generation() {
    let (_root, base) = fresh();
    let mut catalog = Catalog::open(&base, true).unwrap().unwrap();
    let operation = uuid::Uuid::new_v4().to_string();
    let first = active(&mut catalog, &base, &operation);
    assert!(first.owns_archive);
    drop(catalog);
    let mut reopened = Catalog::open(&base, false).unwrap().unwrap();
    let recovered = reopened.reserve(&operation, &"a".repeat(64)).unwrap();
    assert_eq!(recovered.archive, first.archive);
    assert_eq!(recovered.generation, first.generation);
    assert!(recovered.owns_archive);
    assert!(reopened.reserve(&operation, &"c".repeat(64)).is_err());
    let alias = reopened
        .reserve(&uuid::Uuid::new_v4().to_string(), &"a".repeat(64))
        .unwrap();
    assert_eq!(alias.archive, first.archive);
    assert!(!alias.owns_archive);
}

#[test]
fn durable_pins_reconcile_the_same_owner_without_borrowing_or_resurrecting_a_released_receipt() {
    let (_root, base) = fresh();
    let mut catalog = Catalog::open(&base, true).unwrap().unwrap();
    let reservation = active(&mut catalog, &base, &uuid::Uuid::new_v4().to_string());
    let guard = catalog.guard(&reservation.archive).unwrap();
    let operation = uuid::Uuid::new_v4().to_string();
    let owner = ArchiveReferenceOwner::new(
        ArchiveReferenceKind::Preparation,
        &operation,
        &"d".repeat(64),
    )
    .unwrap();
    let receipt = catalog
        .pin(owner.clone(), std::slice::from_ref(&guard))
        .unwrap();
    assert_eq!(
        catalog
            .pin(owner.clone(), std::slice::from_ref(&guard))
            .unwrap(),
        receipt
    );
    let changed = ArchiveReferenceOwner::new(
        ArchiveReferenceKind::Preparation,
        &operation,
        &"e".repeat(64),
    )
    .unwrap();
    assert!(catalog.pin(changed, std::slice::from_ref(&guard)).is_err());
    drop(catalog);
    let mut reopened = Catalog::open(&base, false).unwrap().unwrap();
    reopened.release(&receipt).unwrap();
    reopened.release(&receipt).unwrap();
    assert!(reopened.pin(owner, &[guard]).is_err());
}

#[test]
fn independent_catalogs_require_identity_order_without_changing_either_catalog() {
    let (first_root, first) = fresh();
    let (second_root, second) = fresh();
    drop(Catalog::open(&first, true).unwrap().unwrap());
    drop(Catalog::open(&second, true).unwrap().unwrap());

    let first_identity = first.directory_identity().unwrap();
    let second_identity = second.directory_identity().unwrap();
    assert_ne!(first_identity, second_identity);
    let (lower_root, lower, higher_root, higher) = if first_identity < second_identity {
        (&first_root, &first, &second_root, &second)
    } else {
        (&second_root, &second, &first_root, &first)
    };
    let lower_metadata = lower_root.path().join("managed-v2/lifecycle.json");
    let higher_metadata = higher_root.path().join("managed-v2/lifecycle.json");
    let lower_before = std::fs::read(&lower_metadata).unwrap();
    let higher_before = std::fs::read(&higher_metadata).unwrap();

    // The reversed nested acquisition must fail rather than wait on an AB/BA cycle.
    let higher_catalog = Catalog::open(higher, false).unwrap().unwrap();
    let error = Catalog::open(lower, false)
        .err()
        .expect("reverse identity order must be rejected");
    assert_eq!(error.to_string(), "external_history_lifecycle_busy");
    assert_eq!(std::fs::read(&lower_metadata).unwrap(), lower_before);
    assert_eq!(std::fs::read(&higher_metadata).unwrap(), higher_before);
    drop(higher_catalog);

    // The same two actual catalogs can be held in the supported order.
    let lower_catalog = Catalog::open(lower, false).unwrap().unwrap();
    let higher_catalog = Catalog::open(higher, false).unwrap().unwrap();
    drop(higher_catalog);
    drop(lower_catalog);
    assert_eq!(std::fs::read(&lower_metadata).unwrap(), lower_before);
    assert_eq!(std::fs::read(&higher_metadata).unwrap(), higher_before);
}

#[test]
fn observation_creates_neither_a_catalog_nor_a_missing_coordinator_and_foreign_guards_are_rejected()
{
    let (root, base) = fresh();
    assert!(Catalog::open(&base, false).unwrap().is_none());
    assert!(!root.path().join("mutation.lock").exists());
    let mut catalog = Catalog::open(&base, true).unwrap().unwrap();
    let reservation = active(&mut catalog, &base, &uuid::Uuid::new_v4().to_string());
    let guard = catalog.guard(&reservation.archive).unwrap();
    // The guard retains the original read lease; the first catalog need not hold
    // a writer while an unrelated catalog checks its authority.
    drop(catalog);
    let (other_root, other) = fresh();
    let mut foreign = Catalog::open(&other, true).unwrap().unwrap();
    let foreign_metadata = other_root.path().join("managed-v2/lifecycle.json");
    let before = std::fs::read(&foreign_metadata).unwrap();
    let error = foreign
        .pin(
            ArchiveReferenceOwner::new(
                ArchiveReferenceKind::Continuation,
                &uuid::Uuid::new_v4().to_string(),
                &"f".repeat(64),
            )
            .unwrap(),
            &[guard],
        )
        .expect_err("a foreign guard must not authorize a reference");
    assert_eq!(error.to_string(), "external_history_lifecycle_wrong_scope");
    assert_eq!(std::fs::read(&foreign_metadata).unwrap(), before);
    drop(foreign);
    std::fs::rename(
        root.path().join("mutation.lock"),
        root.path().join("saved.lock"),
    )
    .unwrap();
    let error = Catalog::open(&base, false)
        .err()
        .expect("a missing coordinator must not be recreated");
    assert!(
        super::missing(&error),
        "expected missing coordinator: {error:#}"
    );
    assert!(!root.path().join("mutation.lock").exists());
}

#[test]
fn read_catalogues_share_the_verified_coordinator_and_cannot_create_mutation_storage() {
    let (root, base) = fresh();
    drop(Catalog::open(&base, true).unwrap().unwrap());
    let mut first = Catalog::open_readonly(&base).unwrap().unwrap();
    let second = Catalog::open_readonly(&base).unwrap().unwrap();
    let before = std::fs::read(root.path().join("managed-v2/lifecycle.json")).unwrap();
    let names = std::fs::read_dir(root.path().join("managed-v2"))
        .unwrap()
        .count();
    assert!(
        first
            .reserve("readonly-cannot-birth", &"a".repeat(64))
            .is_err()
    );
    assert_eq!(
        std::fs::read_dir(root.path().join("managed-v2"))
            .unwrap()
            .count(),
        names
    );
    assert_eq!(
        std::fs::read(root.path().join("managed-v2/lifecycle.json")).unwrap(),
        before
    );
    assert!(Catalog::open(&base, false).is_err());
    drop(second);
    drop(first);
    let ready = std::sync::mpsc::sync_channel(1);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let reader = Catalog::open_readonly(&base).unwrap().unwrap();
            ready.0.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(10));
            drop(reader);
        });
        ready.1.recv().unwrap();
        let mut writer = Catalog::open(&base, false).unwrap().unwrap();
        let reservation = writer
            .reserve("single-owned-birth", &"a".repeat(64))
            .unwrap();
        assert_eq!(reservation.operation, "single-owned-birth");
    });
    assert_eq!(
        Catalog::open_readonly(&base)
            .unwrap()
            .unwrap()
            .document
            .requests
            .len(),
        1
    );
}
