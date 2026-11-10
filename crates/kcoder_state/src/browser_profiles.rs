//! Private browser account metadata. The host owns selection and execution authorization.
mod store;
pub use store::{BrowserProfileStore, BrowserProfileUse};

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use kcoder_config::PrivateDirectory;
    use kcoder_types::{
        browser_profiles::*,
        integrations::core::{IntegrationNullable, IntegrationScope},
    };
    use std::ffi::OsStr;
    fn scope(account: &str) -> IntegrationScope {
        IntegrationScope {
            account_id: account.into(),
            target_id: "native-target".into(),
            workspace_id: IntegrationNullable::Null,
            identity_generation: "principal-1".into(),
            target_revision: "config-1".into(),
            organization_id: None,
        }
    }
    fn draft(id: &str) -> BrowserAccountProfileDraft {
        BrowserAccountProfileDraft {
            id: id.into(),
            label: "Office browser".into(),
            account_label: Some("Department account (user label)".into()),
            purpose: BrowserProfilePurpose::Business,
        }
    }
    #[test]
    fn missing_catalog_is_a_pure_read_and_profiles_reopen_without_cookie_or_path_fields()
    -> Result<()> {
        let root = kcoder_config::create_private_temp_dir("browser-profile-state")?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        assert!(
            BrowserProfileStore::open_in(&parent, OsStr::new("catalog"), &scope("alice"))?
                .is_none()
        );
        assert!(!root.path().join("catalog").exists());
        let store =
            BrowserProfileStore::create_in(&parent, OsStr::new("catalog"), &scope("alice"))?;
        let profile = store.save("explicit-create", draft("office"), 0)?;
        assert_eq!(profile.revision, 1);
        drop(store);
        let reopened =
            BrowserProfileStore::open_in(&parent, OsStr::new("catalog"), &scope("alice"))?.unwrap();
        assert_eq!(reopened.list(None, false)?.items, [profile]);
        let public = serde_json::to_string(&reopened.list(None, false)?)?;
        assert!(
            !public.contains(root.path().to_str().unwrap())
                && !public.contains("cookie")
                && !public.contains("password")
        );
        assert!(
            BrowserProfileStore::open_in(&parent, OsStr::new("catalog"), &scope("bob")).is_err()
        );
        Ok(())
    }
    #[test]
    fn stable_operations_reconcile_once_and_stale_revisions_do_not_overwrite_profiles() -> Result<()>
    {
        let root = kcoder_config::create_private_temp_dir("browser-profile-cas")?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let store =
            BrowserProfileStore::create_in(&parent, OsStr::new("catalog"), &scope("alice"))?;
        let first = store.save("save-1", draft("office"), 0)?;
        assert_eq!(store.save("save-1", draft("office"), 0)?, first);
        let mut changed = draft("office");
        changed.label = "Another label".into();
        assert!(store.save("save-1", changed.clone(), 0).is_err());
        let second = store.save("save-2", changed, 1)?;
        assert_eq!(second.revision, 2);
        assert!(store.save("stale-save", draft("office"), 1).is_err());
        let archived = store.set_archived("archive", "office", 2, true)?;
        assert!(archived.archived);
        assert!(store.list(None, false)?.items.is_empty());
        assert_eq!(store.list(None, true)?.items.len(), 1);
        Ok(())
    }

    #[test]
    fn pages_are_bounded_and_cursors_bind_revision_and_filter() -> Result<()> {
        let root = kcoder_config::create_private_temp_dir("browser-profile-pages")?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let store =
            BrowserProfileStore::create_in(&parent, OsStr::new("catalog"), &scope("alice"))?;
        for index in 0..11 {
            let id = format!("profile-{index:02}");
            store.save(&format!("create-{index}"), draft(&id), 0)?;
        }
        let page = store.list(None, false)?;
        assert_eq!(page.items.len(), 10);
        let cursor = page.next_cursor.unwrap();
        assert!(store.list(Some(&cursor), true).is_err());
        let next = store.list(Some(&cursor), false)?;
        assert_eq!(next.items[0].draft.id, "profile-10");
        assert_eq!(next.items.len(), 1);
        assert!(next.next_cursor.is_none());
        store.set_archived("archive-0", "profile-00", 1, true)?;
        assert!(store.list(Some(&cursor), false).is_err());
        assert_eq!(store.list(None, false)?.items.len(), 10);
        Ok(())
    }

    #[test]
    fn duplicate_initialization_and_damaged_data_never_reset_existing_profiles() -> Result<()> {
        let root = kcoder_config::create_private_temp_dir("browser-profile-damage")?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let store =
            BrowserProfileStore::create_in(&parent, OsStr::new("catalog"), &scope("alice"))?;
        store.save("create", draft("original"), 0)?;
        assert!(
            BrowserProfileStore::create_in(&parent, OsStr::new("catalog"), &scope("alice"))
                .is_err()
        );
        assert_eq!(store.list(None, false)?.items[0].draft.id, "original");
        let directory = parent
            .open_entry_handle(OsStr::new("catalog"))?
            .open_child_directory()?;
        directory.atomic_replace(OsStr::new("profiles.json"), b"{broken")?;
        assert!(store.list(None, false).is_err());
        assert!(
            BrowserProfileStore::open_in(&parent, OsStr::new("catalog"), &scope("alice")).is_err()
        );
        assert_eq!(
            std::fs::read(root.path().join("catalog/profiles.json"))?,
            b"{broken"
        );
        Ok(())
    }

    #[test]
    fn independent_handles_reject_stale_writes_and_replaced_lock_files() -> Result<()> {
        let root = kcoder_config::create_private_temp_dir("browser-profile-handles")?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let first =
            BrowserProfileStore::create_in(&parent, OsStr::new("catalog"), &scope("alice"))?;
        first.save("create", draft("original"), 0)?;
        let second =
            BrowserProfileStore::open_in(&parent, OsStr::new("catalog"), &scope("alice"))?.unwrap();
        second.set_archived("archive", "original", 1, true)?;
        assert!(first.save("stale", draft("original"), 1).is_err());
        let directory = parent
            .open_entry_handle(OsStr::new("catalog"))?
            .open_child_directory()?;
        directory.atomic_replace(OsStr::new("profiles.lock"), b"")?;
        assert!(first.list(None, false).is_err());
        assert!(second.list(None, false).is_err());
        assert!(
            BrowserProfileStore::open_in(&parent, OsStr::new("catalog"), &scope("alice")).is_err()
        );
        Ok(())
    }

    #[test]
    fn simultaneous_writers_commit_only_one_revision() -> Result<()> {
        let root = kcoder_config::create_private_temp_dir("browser-profile-race")?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let first =
            BrowserProfileStore::create_in(&parent, OsStr::new("catalog"), &scope("alice"))?;
        first.save("create", draft("original"), 0)?;
        let second =
            BrowserProfileStore::open_in(&parent, OsStr::new("catalog"), &scope("alice"))?.unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let child_barrier = barrier.clone();
        let worker = std::thread::spawn(move || {
            child_barrier.wait();
            second.set_archived("writer-2", "original", 1, true)
        });
        barrier.wait();
        let current = first.set_archived("writer-1", "original", 1, false);
        let peer = worker.join().unwrap();
        assert_eq!(usize::from(current.is_ok()) + usize::from(peer.is_ok()), 1);
        assert_eq!(first.list(None, true)?.items[0].revision, 2);
        Ok(())
    }

    #[test]
    fn active_use_is_exclusive_blocks_edits_and_drop_never_claims_cleanup() -> Result<()> {
        let root = kcoder_config::create_private_temp_dir("browser-profile-use")?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let first =
            BrowserProfileStore::create_in(&parent, OsStr::new("catalog"), &scope("alice"))?;
        first.save("create", draft("original"), 0)?;
        let second =
            BrowserProfileStore::open_in(&parent, OsStr::new("catalog"), &scope("alice"))?.unwrap();
        let usage = first.begin_use("original", 1)?;
        assert!(second.begin_use("original", 1).is_err());
        assert!(second.save("edit", draft("original"), 1).is_err());
        assert!(second.set_archived("archive", "original", 1, true).is_err());
        first.finish_use_after_owned_cleanup(&usage)?;
        first.finish_use_after_owned_cleanup(&usage)?;
        let abandoned = second.begin_use("original", 1)?;
        assert!(first.finish_use_after_owned_cleanup(&usage).is_err());
        drop(abandoned);
        drop(first);
        drop(second);
        let reopened =
            BrowserProfileStore::open_in(&parent, OsStr::new("catalog"), &scope("alice"))?.unwrap();
        assert!(reopened.begin_use("original", 1).is_err());
        assert_eq!(reopened.list(None, false)?.items[0].draft.id, "original");
        Ok(())
    }

    #[test]
    fn cookie_directories_are_separate_persistent_and_replacement_is_not_adopted() -> Result<()> {
        let root = kcoder_config::create_private_temp_dir("browser-profile-data")?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let store =
            BrowserProfileStore::create_in(&parent, OsStr::new("catalog"), &scope("alice"))?;
        store.save("create-personal", draft("personal"), 0)?;
        store.save("create-business", draft("business"), 0)?;
        let personal = store.begin_use("personal", 1)?;
        let business = store.begin_use("business", 1)?;
        let first = store.user_data_directory(&personal)?;
        let second = store.user_data_directory(&business)?;
        assert_ne!(first.directory_identity()?, second.directory_identity()?);
        first.atomic_replace(OsStr::new("sentinel"), b"personal private data")?;
        let identity = first.directory_identity()?;
        store.finish_use_after_owned_cleanup(&personal)?;
        let reopened = store.begin_use("personal", 1)?;
        assert_eq!(
            store.user_data_directory(&reopened)?.directory_identity()?,
            identity
        );
        let directory = root
            .path()
            .join("catalog")
            .join(store.user_data_name(&reopened)?);
        std::fs::rename(&directory, root.path().join("original-data"))?;
        let catalog = parent
            .open_entry_handle(OsStr::new("catalog"))?
            .open_child_directory()?;
        catalog.create_private_child(&store.user_data_name(&reopened)?)?;
        assert!(store.user_data_directory(&reopened).is_err());
        assert_eq!(
            std::fs::read(root.path().join("original-data/sentinel"))?,
            b"personal private data"
        );
        Ok(())
    }

    #[test]
    fn launch_intents_survive_reopen_and_are_not_replayed_after_confirmed_release() -> Result<()> {
        let root = kcoder_config::create_private_temp_dir("browser-profile-original-launch")?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let store =
            BrowserProfileStore::create_in(&parent, OsStr::new("catalog"), &scope("alice"))?;
        store.save("create", draft("office"), 0)?;
        let hash = "a".repeat(64);
        assert!(
            store
                .begin_use_operation("office", 1, "create", &hash)
                .is_err()
        );
        let usage = store.begin_use_operation("office", 1, "original-launch", &hash)?;
        assert!(
            store
                .begin_use_operation("office", 1, "original-launch", &hash)
                .is_err()
        );
        store.finish_use_after_owned_cleanup(&usage)?;
        assert!(store.save("original-launch", draft("office"), 1).is_err());
        drop(store);
        let store =
            BrowserProfileStore::open_in(&parent, OsStr::new("catalog"), &scope("alice"))?.unwrap();
        assert!(
            store
                .begin_use_operation("office", 1, "original-launch", &hash)
                .is_err()
        );
        assert!(
            store
                .begin_use_operation("office", 1, "original-launch", &"b".repeat(64))
                .is_err()
        );
        let next = store.begin_use_operation("office", 1, "new-explicit-launch", &hash)?;
        store.finish_use_after_owned_cleanup(&next)?;
        Ok(())
    }

    #[test]
    fn missing_original_launch_receipt_cannot_be_reported_as_confirmed_release() -> Result<()> {
        let root = kcoder_config::create_private_temp_dir("browser-profile-lost-launch-receipt")?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let store =
            BrowserProfileStore::create_in(&parent, OsStr::new("catalog"), &scope("alice"))?;
        store.save("create", draft("office"), 0)?;
        let usage = store.begin_use_operation("office", 1, "original-launch", &"a".repeat(64))?;
        store.finish_use_after_owned_cleanup(&usage)?;
        let path = root.path().join("catalog/profiles.json");
        let mut data: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        data.as_object_mut().unwrap().remove("useOperations");
        let catalog = parent
            .open_entry_handle(OsStr::new("catalog"))?
            .open_child_directory()?;
        catalog.atomic_replace(OsStr::new("profiles.json"), &serde_json::to_vec(&data)?)?;
        assert!(store.finish_use_after_owned_cleanup(&usage).is_err());
        Ok(())
    }

    #[test]
    fn recovery_waits_for_original_complete_receipt_and_never_replays_old_launch() -> Result<()> {
        use std::io::Write;
        let root = kcoder_config::create_private_temp_dir("browser-profile-recovery")?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let store =
            BrowserProfileStore::create_in(&parent, OsStr::new("catalog"), &scope("alice"))?;
        store.save("create", draft("office"), 0)?;
        let usage = store.begin_use_operation("office", 1, "original-launch", &"a".repeat(64))?;
        let mut receipt = store.prepare_cleanup_receipt(&usage)?;
        drop(usage);
        drop(store);
        let store =
            BrowserProfileStore::open_in(&parent, OsStr::new("catalog"), &scope("alice"))?.unwrap();
        assert_eq!(store.reconcile_cleanup_receipts()?, 0);
        assert!(store.begin_use("office", 1).is_err());
        receipt.write_all(b"kcoder-owned-cleanup/v1\n")?;
        receipt.sync_all()?;
        assert_eq!(store.reconcile_cleanup_receipts()?, 0);
        receipt.write_all(b"confirmed\n")?;
        receipt.sync_all()?;
        assert_eq!(store.reconcile_cleanup_receipts()?, 1);
        assert!(
            store
                .begin_use_operation("office", 1, "original-launch", &"a".repeat(64))
                .is_err()
        );
        let next = store.begin_use_operation("office", 1, "new-user-action", &"b".repeat(64))?;
        store.finish_use_after_owned_cleanup(&next)?;
        Ok(())
    }

    #[test]
    fn replaced_cleanup_receipt_cannot_release_an_abandoned_profile() -> Result<()> {
        let root = kcoder_config::create_private_temp_dir("browser-profile-receipt-replaced")?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let store =
            BrowserProfileStore::create_in(&parent, OsStr::new("catalog"), &scope("alice"))?;
        store.save("create", draft("office"), 0)?;
        let usage = store.begin_use("office", 1)?;
        let receipt = store.prepare_cleanup_receipt(&usage)?;
        let names = std::fs::read_dir(root.path().join("catalog"))?
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        let name = names
            .iter()
            .find(|name| name.to_string_lossy().starts_with("cleanup-"))
            .unwrap();
        let catalog = parent
            .open_entry_handle(OsStr::new("catalog"))?
            .open_child_directory()?;
        catalog.atomic_replace(name, b"kcoder-owned-cleanup/v1\nconfirmed\n")?;
        assert!(store.reconcile_cleanup_receipts().is_err());
        assert!(store.begin_use("office", 1).is_err());
        drop(receipt);
        Ok(())
    }

    #[test]
    fn exact_use_receipt_observation_is_readonly_and_does_not_release_or_replay() -> Result<()> {
        use std::io::Write;
        let root = kcoder_config::create_private_temp_dir("browser-receipt-observe")?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let store =
            BrowserProfileStore::create_in(&parent, OsStr::new("catalog"), &scope("alice"))?;
        store.save("create", draft("office"), 0)?;
        let usage = store.begin_use_operation("office", 1, "original", &"a".repeat(64))?;
        let mut receipt = store.prepare_cleanup_receipt(&usage)?;
        let data_path = root.path().join("catalog/profiles.json");
        let before = std::fs::read(&data_path)?;
        assert!(!store.cleanup_receipt_confirmed(&usage)?);
        receipt.write_all(b"kcoder-owned-cleanup/v1\nconfirmed\n")?;
        receipt.sync_all()?;
        assert!(store.cleanup_receipt_confirmed(&usage)?);
        assert_eq!(std::fs::read(&data_path)?, before);
        assert!(store.begin_use("office", 1).is_err());
        store.finish_use_after_owned_cleanup(&usage)?;
        assert!(store.cleanup_receipt_confirmed(&usage)?);
        assert!(
            store
                .begin_use_operation("office", 1, "original", &"a".repeat(64))
                .is_err()
        );
        Ok(())
    }
}
