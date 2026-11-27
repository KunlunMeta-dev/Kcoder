use super::*;
use kcoder_types::integrations::core::{IntegrationNullable, IntegrationScope};

fn scope() -> IntegrationScope {
    IntegrationScope {
        account_id: "native-account-service".into(),
        target_id: "native-profile".into(),
        workspace_id: IntegrationNullable::Null,
        organization_id: None,
        identity_generation: "1".into(),
        target_revision: "1".into(),
    }
}
fn principal() -> NativeBudgetPrincipal {
    NativeBudgetPrincipal::from_native_facts(
        "member".into(),
        Some("organization".into()),
        Some("workspace".into()),
        Some("subscription".into()),
    )
    .unwrap()
}
fn policy(
    id: &str,
    scope: BudgetScope,
    version: u64,
    start: u64,
    end: u64,
    window: &str,
) -> NativeBudgetPolicy {
    NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
        id: id.into(),
        version,
        revision: format!("revision-{version}"),
        scope,
        window: BudgetWindow {
            id: window.into(),
            starts_at_ms: start,
            ends_at_ms: end,
        },
        limits: BudgetLimits {
            tokens: Some(1000),
            ..Default::default()
        },
        currency: None,
    })
    .unwrap()
}
fn store() -> (kcoder_config::PrivateTempDir, NativeBudgetStore) {
    let temp = kcoder_config::create_private_temp_dir("budget-observation-test").unwrap();
    let parent = PrivateDirectory::open_existing(temp.path()).unwrap();
    let store =
        NativeBudgetStore::create_in(&parent, OsStr::new("original-journal"), &scope()).unwrap();
    (temp, store)
}

#[test]
fn observes_all_actual_applicable_families_and_never_creates_a_second_journal() {
    let (temp, store) = store();
    let policies = vec![
        policy(
            "org",
            BudgetScope::Organization("organization".into()),
            1,
            0,
            100,
            "first",
        ),
        policy(
            "account",
            BudgetScope::Account("member".into()),
            1,
            0,
            100,
            "first",
        ),
        policy(
            "workspace",
            BudgetScope::Workspace("workspace".into()),
            1,
            0,
            100,
            "first",
        ),
        policy(
            "subscription",
            BudgetScope::Subscription("subscription".into()),
            1,
            0,
            100,
            "first",
        ),
        policy(
            "task",
            BudgetScope::Task("original-task".into()),
            1,
            0,
            100,
            "first",
        ),
        policy(
            "foreign",
            BudgetScope::Account("other-member".into()),
            1,
            0,
            100,
            "first",
        ),
    ];
    store.install_policies(&policies).unwrap();
    let path = temp.path().join("original-journal/ledger.json");
    let before = std::fs::read(&path).unwrap();
    let epoch = store.observation_epoch().unwrap();
    let current = store
        .current_applicable_policies(&principal(), "original-task", 10)
        .unwrap();
    let mut ids = current
        .iter()
        .map(|policy| policy.record.id.as_str())
        .collect::<Vec<_>>();
    ids.sort();
    assert_eq!(
        ids,
        vec!["account", "org", "subscription", "task", "workspace"]
    );
    assert_eq!(std::fs::read(path).unwrap(), before);
    assert_eq!(store.observation_epoch().unwrap(), epoch);
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
}

#[test]
fn expired_latest_or_not_yet_current_family_is_an_error_not_an_absent_quota() {
    let (_temp, store) = store();
    store
        .install_policies(&[policy(
            "account",
            BudgetScope::Account("member".into()),
            1,
            0,
            100,
            "first",
        )])
        .unwrap();
    store
        .install_policies(&[policy(
            "account",
            BudgetScope::Account("member".into()),
            1,
            100,
            200,
            "second",
        )])
        .unwrap();
    assert_eq!(
        store
            .current_applicable_policies(&principal(), "task", 99)
            .unwrap()[0]
            .record
            .window
            .id,
        "first"
    );
    assert_eq!(
        store
            .current_applicable_policies(&principal(), "task", 100)
            .unwrap()[0]
            .record
            .window
            .id,
        "second"
    );
    assert!(
        store
            .current_applicable_policies(&principal(), "task", 200)
            .is_err()
    );
    store
        .install_policies(&[policy(
            "account",
            BudgetScope::Account("member".into()),
            2,
            300,
            400,
            "new-version",
        )])
        .unwrap();
    assert!(
        store
            .current_applicable_policies(&principal(), "task", 150)
            .is_err()
    );
    assert_eq!(
        store
            .current_applicable_policies(&principal(), "task", 300)
            .unwrap()[0]
            .record
            .version,
        2
    );
}

#[test]
fn overlapping_latest_windows_are_unavailable_instead_of_selecting_a_more_permissive_window() {
    let (_temp, store) = store();
    store
        .install_policies(&[policy(
            "account",
            BudgetScope::Account("member".into()),
            1,
            0,
            100,
            "first",
        )])
        .unwrap();
    store
        .install_policies(&[policy(
            "account",
            BudgetScope::Account("member".into()),
            1,
            50,
            150,
            "second",
        )])
        .unwrap();
    assert_eq!(
        store
            .current_applicable_policies(&principal(), "task", 75)
            .unwrap_err()
            .to_string(),
        "BUDGET_POLICY_WINDOW_AMBIGUOUS"
    );
    assert_eq!(
        store
            .current_applicable_policies(&principal(), "task", 25)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .current_applicable_policies(&principal(), "task", 125)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn epoch_changes_on_the_original_atomic_journal_write_but_is_not_a_policy_or_admission_proof() {
    let (temp, store) = store();
    let initial = store.observation_epoch().unwrap();
    store
        .install_policies(&[policy(
            "account",
            BudgetScope::Account("member".into()),
            1,
            0,
            100,
            "first",
        )])
        .unwrap();
    let published = store.observation_epoch().unwrap();
    assert_ne!(initial, published);
    store
        .directory
        .atomic_replace(OsStr::new(DATA), b"invalid ledger data")
        .unwrap();
    assert_ne!(store.observation_epoch().unwrap(), published);
    assert!(
        store
            .current_applicable_policies(&principal(), "task", 10)
            .is_err()
    );
    assert!(
        std::fs::read(temp.path().join("original-journal/ledger.json"))
            .unwrap()
            .starts_with(b"invalid")
    );
}

#[test]
fn missing_or_replaced_native_storage_does_not_become_an_empty_policy_set() {
    let (temp, store) = store();
    std::fs::remove_file(temp.path().join("original-journal/ledger.json")).unwrap();
    assert!(store.observation_epoch().is_err());
    assert!(
        store
            .current_applicable_policies(&principal(), "task", 10)
            .is_err()
    );
    assert!(!temp.path().join("original-journal/ledger.json").exists());
}

#[cfg(unix)]
#[test]
fn a_hardlinked_data_file_cannot_supply_an_epoch_or_quota() {
    let (temp, store) = store();
    std::fs::hard_link(
        temp.path().join("original-journal/ledger.json"),
        temp.path().join("shared-data"),
    )
    .unwrap();
    assert!(store.observation_epoch().is_err());
    assert!(
        store
            .current_applicable_policies(&principal(), "task", 10)
            .is_err()
    );
}
