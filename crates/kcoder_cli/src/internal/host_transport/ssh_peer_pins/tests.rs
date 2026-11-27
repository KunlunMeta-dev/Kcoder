use super::*;

fn name(value: &str) -> PeerSshIdentityTextV1 {
    value.to_owned().try_into().unwrap()
}
struct Fixture {
    root: tempfile::TempDir,
    actual: PeerSshNativeProfileV1,
    pin: PeerSshEnrollmentV1,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let directory = PrivateDirectory::open_existing(root.path()).unwrap();
        directory.verify_private_directory().unwrap();
        #[cfg(unix)]
        let uid = unsafe { libc::geteuid() };
        #[cfg(not(unix))]
        let uid = 0;
        let actual = PeerSshNativeProfileV1 {
            account_uid: uid,
            profile_identity: name(&directory.directory_identity().unwrap()),
            target_id: name("native-profile"),
            workspace_id: name("original-workspace"),
            identity_epoch: name("original-profile-key-epoch"),
            public_key: [1; 32],
        };
        let pin = PeerSshEnrollmentV1 {
            version: 1,
            purpose: PeerSshEnrollmentPurposeV1::Enrollment,
            enrollment_id: name("explicit-pin"),
            generation: 1,
            gateway: PeerSshGatewayKeyV1 {
                gateway_id: name("original-gateway"),
                public_key: [2; 32],
                key_generation: 1,
            },
            target: PeerSshTargetBindingV1 {
                target_id: name("saved-ssh-target"),
                target_revision: "a".repeat(64).try_into().unwrap(),
                account_generation: name("original-account-generation"),
                ssh_host_key: name("ssh-ed25519 SHA256:expected-host-key"),
                ssh_user: name("expected-ssh-user"),
            },
            native: actual.clone(),
        };
        Self { root, actual, pin }
    }
    fn authorize(&self, id: &str, revision: u64, pin: PeerSshEnrollmentV1) -> PeerSshPinCommandV1 {
        PeerSshPinCommandV1 {
            version: 1,
            purpose: PeerSshPinCommandPurposeV1::ExplicitChange,
            operation_id: name(id),
            expected_revision: revision,
            action: PeerSshPinActionV1::Authorize {
                enrollment: Box::new(pin),
            },
        }
    }
    fn apply(&self, command: &PeerSshPinCommandV1) -> Result<PeerSshPinReceiptV1> {
        SshPeerPinStore::apply_explicit(self.root.path(), &self.actual, command)
    }
    fn store(&self) -> Arc<SshPeerPinStore> {
        SshPeerPinStore::open_existing(self.root.path())
            .unwrap()
            .unwrap()
    }
    fn data_path(&self) -> PathBuf {
        self.root.path().join(NAMESPACE).join(DATA)
    }
}

#[test]
fn absent_store_and_invalid_profile_do_not_initialize_or_enroll_any_key() {
    let fixture = Fixture::new();
    assert!(
        SshPeerPinStore::open_existing(fixture.root.path())
            .unwrap()
            .is_none()
    );
    assert_eq!(
        SshPeerPinStore::observed_revision(fixture.root.path()).unwrap(),
        0
    );
    assert_eq!(
        SshPeerPinStore::read_original_receipt(fixture.root.path(), &name("never-dispatched"))
            .unwrap(),
        None
    );
    assert_eq!(std::fs::read_dir(fixture.root.path()).unwrap().count(), 0);
    let mut actual = fixture.actual.clone();
    actual.profile_identity = name("self-reported-other-profile");
    let mut pin = fixture.pin.clone();
    pin.native = actual.clone();
    let command = fixture.authorize("original-op", 0, pin);
    assert_eq!(
        SshPeerPinStore::apply_explicit(fixture.root.path(), &actual, &command).unwrap_err(),
        SshPeerPinError::ScopeChanged
    );
    assert_eq!(std::fs::read_dir(fixture.root.path()).unwrap().count(), 0);
    let mut pin = fixture.pin.clone();
    pin.generation = 7;
    assert!(
        fixture
            .apply(&fixture.authorize("skipped-generation", 0, pin))
            .is_err()
    );
    assert_eq!(std::fs::read_dir(fixture.root.path()).unwrap().count(), 0);
}

#[test]
fn adopted_profile_never_reenables_kernel_lane_after_pin_namespace_loss() {
    let fixture = Fixture::new();
    assert!(may_attempt_legacy_kernel_capture(fixture.root.path()).unwrap());
    fixture
        .apply(&fixture.authorize("original-op", 0, fixture.pin.clone()))
        .unwrap();
    assert!(!may_attempt_legacy_kernel_capture(fixture.root.path()).unwrap());
    assert!(fixture.root.path().join(ADOPTED).exists());
    std::fs::remove_dir_all(fixture.root.path().join(NAMESPACE)).unwrap();
    assert!(
        SshPeerPinStore::open_existing(fixture.root.path())
            .unwrap()
            .is_none()
    );
    assert_eq!(
        SshPeerPinStore::observed_revision(fixture.root.path()).unwrap_err(),
        SshPeerPinError::Unavailable
    );
    assert_eq!(
        SshPeerPinStore::read_original_receipt(fixture.root.path(), &name("original-op"))
            .unwrap_err(),
        SshPeerPinError::Unavailable
    );
    assert_eq!(
        fixture
            .apply(&fixture.authorize("do-not-recreate-lost-ledger", 0, fixture.pin.clone()))
            .unwrap_err(),
        SshPeerPinError::Unavailable
    );
    assert!(!may_attempt_legacy_kernel_capture(fixture.root.path()).unwrap());
    assert_eq!(std::fs::read_dir(fixture.root.path()).unwrap().count(), 1);
    #[cfg(unix)]
    {
        std::fs::remove_file(fixture.root.path().join(ADOPTED)).unwrap();
        std::os::unix::fs::symlink(
            fixture.root.path().join("missing-marker-target"),
            fixture.root.path().join(ADOPTED),
        )
        .unwrap();
        assert!(!may_attempt_legacy_kernel_capture(fixture.root.path()).unwrap());
    }
}

#[test]
fn explicit_pin_is_durable_but_only_matches_its_actual_profile_and_workspace() {
    let fixture = Fixture::new();
    let command = fixture.authorize("original-op", 0, fixture.pin.clone());
    let receipt = fixture.apply(&command).unwrap();
    assert_eq!(receipt.revision, 1);
    assert_eq!(receipt.generation, 1);
    assert_eq!(receipt.status, PeerSshPinStatusV1::Pinned);
    let store = fixture.store();
    assert_eq!(
        store.original_receipt(&name("original-op")).unwrap(),
        Some(receipt)
    );
    let witness = store
        .current_pin(&fixture.pin.enrollment_id, &fixture.actual)
        .unwrap()
        .unwrap();
    assert_eq!(witness.expected(), &fixture.pin);
    witness.verify_current(&fixture.actual).unwrap();
    for field in [
        "uid",
        "profile",
        "workspace",
        "native-target",
        "native-key",
        "epoch",
    ] {
        let mut changed = fixture.actual.clone();
        match field {
            "uid" => changed.account_uid = changed.account_uid.wrapping_add(1),
            "profile" => changed.profile_identity = name("other-profile"),
            "workspace" => changed.workspace_id = name("other-workspace"),
            "native-target" => changed.target_id = name("other-native-target"),
            "native-key" => changed.public_key[0] ^= 1,
            _ => changed.identity_epoch = name("other-epoch"),
        }
        assert_eq!(
            witness.verify_current(&changed).unwrap_err(),
            SshPeerPinError::ScopeChanged,
            "{field}"
        );
    }
    let foreign = Fixture::new();
    PrivateDirectory::open_existing(foreign.root.path())
        .unwrap()
        .create_private_child(OsStr::new(NAMESPACE))
        .unwrap();
    for file in [HEADER, LOCK, DATA] {
        std::fs::copy(
            fixture.root.path().join(NAMESPACE).join(file),
            foreign.root.path().join(NAMESPACE).join(file),
        )
        .unwrap();
    }
    assert!(SshPeerPinStore::open_existing(foreign.root.path()).is_err());
}

#[test]
fn original_operation_reconciliation_never_reenables_a_revoked_pin() {
    let fixture = Fixture::new();
    let original = fixture.authorize("original-op", 0, fixture.pin.clone());
    let first = fixture.apply(&original).unwrap();
    let store = fixture.store();
    let witness = store
        .current_pin(&fixture.pin.enrollment_id, &fixture.actual)
        .unwrap()
        .unwrap();
    let revoke = PeerSshPinCommandV1 {
        version: 1,
        purpose: PeerSshPinCommandPurposeV1::ExplicitChange,
        operation_id: name("revoke-op"),
        expected_revision: 1,
        action: PeerSshPinActionV1::Revoke {
            enrollment_id: fixture.pin.enrollment_id.clone(),
            expected_generation: 1,
        },
    };
    let revoked = fixture.apply(&revoke).unwrap();
    assert_eq!(revoked.generation, 2);
    let bytes = std::fs::read(fixture.data_path()).unwrap();
    assert_eq!(fixture.apply(&original).unwrap(), first);
    assert_eq!(std::fs::read(fixture.data_path()).unwrap(), bytes);
    assert_eq!(
        witness.verify_current(&fixture.actual).unwrap_err(),
        SshPeerPinError::Revoked
    );
    let mut changed = original.clone();
    if let PeerSshPinActionV1::Authorize { enrollment } = &mut changed.action {
        enrollment.target.ssh_user = name("different-user");
    }
    assert_eq!(
        fixture.apply(&changed).unwrap_err(),
        SshPeerPinError::OperationConflict
    );
    let mut pin = fixture.pin.clone();
    pin.generation = 2;
    assert_eq!(
        fixture
            .apply(&fixture.authorize("bad-new-op", 2, pin.clone()))
            .unwrap_err(),
        SshPeerPinError::GenerationChanged
    );
    pin.generation = 3;
    fixture
        .apply(&fixture.authorize("new-explicit-op", 2, pin))
        .unwrap();
    assert_eq!(
        witness.verify_current(&fixture.actual).unwrap_err(),
        SshPeerPinError::GenerationChanged
    );
}

#[test]
fn revision_conflict_and_gateway_key_rollback_leave_the_original_state_unchanged() {
    let fixture = Fixture::new();
    fixture
        .apply(&fixture.authorize("original-op", 0, fixture.pin.clone()))
        .unwrap();
    let store = fixture.store();
    let witness = store
        .current_pin(&fixture.pin.enrollment_id, &fixture.actual)
        .unwrap()
        .unwrap();
    let mut next_pin = fixture.pin.clone();
    next_pin.enrollment_id = name("second-explicit-pin");
    next_pin.gateway.key_generation = 2;
    next_pin.gateway.public_key = [3; 32];
    let command = fixture.authorize("rotate-key-op", 1, next_pin.clone());
    fixture.apply(&command).unwrap();
    assert_eq!(
        witness.verify_current(&fixture.actual).unwrap_err(),
        SshPeerPinError::GenerationChanged
    );
    let original = std::fs::read(fixture.data_path()).unwrap();
    let mut rollback = fixture.pin.clone();
    rollback.enrollment_id = name("rollback-pin");
    assert_eq!(
        fixture
            .apply(&fixture.authorize("rollback-op", 2, rollback))
            .unwrap_err(),
        SshPeerPinError::GenerationChanged
    );
    next_pin.enrollment_id = name("another-pin");
    assert_eq!(
        fixture
            .apply(&fixture.authorize("stale-revision-op", 0, next_pin))
            .unwrap_err(),
        SshPeerPinError::RevisionConflict
    );
    assert_eq!(std::fs::read(fixture.data_path()).unwrap(), original);
}

#[test]
fn real_writer_contention_blocks_the_original_witness_without_repair_or_fallback() {
    let fixture = Fixture::new();
    fixture
        .apply(&fixture.authorize("original-op", 0, fixture.pin.clone()))
        .unwrap();
    let store = fixture.store();
    let witness = store
        .current_pin(&fixture.pin.enrollment_id, &fixture.actual)
        .unwrap()
        .unwrap();
    let writer = store
        .directory
        .try_existing_portable_lock(
            OsStr::new(LOCK),
            &store.header.lock_identity,
            PrivateLeaseMode::Exclusive,
        )
        .unwrap()
        .unwrap();
    let before = std::fs::read(fixture.data_path()).unwrap();
    assert_eq!(
        witness.verify_current(&fixture.actual).unwrap_err(),
        SshPeerPinError::Busy
    );
    assert_eq!(std::fs::read(fixture.data_path()).unwrap(), before);
    drop(writer);
    witness.verify_current(&fixture.actual).unwrap();
}

#[test]
fn repeated_current_checks_keep_all_private_files_and_receipts_unchanged() {
    let fixture = Fixture::new();
    fixture
        .apply(&fixture.authorize("original-op", 0, fixture.pin.clone()))
        .unwrap();
    let store = fixture.store();
    let witness = store
        .current_pin(&fixture.pin.enrollment_id, &fixture.actual)
        .unwrap()
        .unwrap();
    let before: Vec<_> = [HEADER, LOCK, DATA]
        .into_iter()
        .map(|name| {
            (
                store
                    .directory
                    .portable_regular_identity(OsStr::new(name))
                    .unwrap(),
                std::fs::read(fixture.root.path().join(NAMESPACE).join(name)).unwrap(),
            )
        })
        .collect();
    for _ in 0..32 {
        witness.verify_current(&fixture.actual).unwrap();
    }
    let after: Vec<_> = [HEADER, LOCK, DATA]
        .into_iter()
        .map(|name| {
            (
                store
                    .directory
                    .portable_regular_identity(OsStr::new(name))
                    .unwrap(),
                std::fs::read(fixture.root.path().join(NAMESPACE).join(name)).unwrap(),
            )
        })
        .collect();
    assert_eq!(before, after);
    assert_eq!(store.revision().unwrap(), 1);
    assert_eq!(
        std::fs::read_dir(fixture.root.path().join(NAMESPACE))
            .unwrap()
            .count(),
        3
    );
}

#[test]
fn malformed_oversized_or_duplicate_ledger_fails_closed_without_empty_defaults() {
    for kind in ["json", "oversized", "duplicate"] {
        let fixture = Fixture::new();
        fixture
            .apply(&fixture.authorize("original-op", 0, fixture.pin.clone()))
            .unwrap();
        let store = fixture.store();
        let witness = store
            .current_pin(&fixture.pin.enrollment_id, &fixture.actual)
            .unwrap()
            .unwrap();
        let bytes = match kind {
            "json" => b"{".to_vec(),
            "oversized" => vec![b' '; MAX_BYTES as usize + 1],
            _ => {
                let mut data = store.read_data().unwrap();
                let row = encoded(
                    data.pins
                        .remove(fixture.pin.enrollment_id.as_str())
                        .as_ref()
                        .unwrap(),
                )
                .unwrap();
                let text = String::from_utf8(std::fs::read(fixture.data_path()).unwrap()).unwrap();
                text.replacen(
                    "\"pins\":{",
                    &format!(
                        "\"pins\":{{\"explicit-pin\":{},",
                        String::from_utf8(row).unwrap()
                    ),
                    1,
                )
                .into_bytes()
            }
        };
        std::fs::write(fixture.data_path(), &bytes).unwrap();
        assert_eq!(
            witness.verify_current(&fixture.actual).unwrap_err(),
            SshPeerPinError::Unavailable,
            "{kind}"
        );
        assert!(SshPeerPinStore::open_existing(fixture.root.path()).is_err());
        assert_eq!(std::fs::read(fixture.data_path()).unwrap(), bytes);
    }
}

#[cfg(unix)]
#[test]
fn replaced_lock_linked_state_and_namespace_redirection_are_rejected() {
    for kind in ["lock", "hardlink", "symlink", "namespace"] {
        let fixture = Fixture::new();
        fixture
            .apply(&fixture.authorize("original-op", 0, fixture.pin.clone()))
            .unwrap();
        let store = fixture.store();
        let witness = store
            .current_pin(&fixture.pin.enrollment_id, &fixture.actual)
            .unwrap()
            .unwrap();
        match kind {
            "lock" => {
                let path = fixture.root.path().join(NAMESPACE).join(LOCK);
                std::fs::rename(&path, path.with_extension("retired")).unwrap();
                store
                    .directory
                    .open_read_write_file(OsStr::new(LOCK), true)
                    .unwrap();
            }
            "hardlink" => {
                std::fs::hard_link(
                    fixture.data_path(),
                    fixture.root.path().join("linked-state"),
                )
                .unwrap();
            }
            "symlink" => {
                let path = fixture.data_path();
                let actual = path.with_extension("retired");
                std::fs::rename(&path, &actual).unwrap();
                std::os::unix::fs::symlink(actual, path).unwrap();
            }
            _ => {
                let path = fixture.root.path().join(NAMESPACE);
                let actual = path.with_extension("retired");
                std::fs::rename(&path, &actual).unwrap();
                std::os::unix::fs::symlink(actual, path).unwrap();
            }
        }
        assert!(witness.verify_current(&fixture.actual).is_err(), "{kind}");
        assert!(
            SshPeerPinStore::open_existing(fixture.root.path()).is_err(),
            "{kind}"
        );
    }
}
