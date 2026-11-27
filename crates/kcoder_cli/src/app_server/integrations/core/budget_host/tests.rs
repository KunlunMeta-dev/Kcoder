use super::*;
use kcoder_config::PrivateDirectory;

#[test]
fn one_actual_profile_journal_is_shared_across_workspaces_and_read_does_not_create_it() -> Result<()>
{
    let root = kcoder_config::create_private_temp_dir("budget-native-host-test")?;
    let directory = PrivateDirectory::open_existing(root.path())?;
    directory.create_private_child(OsStr::new("profile"))?;
    directory.create_private_child(OsStr::new("workspace-a"))?;
    directory.create_private_child(OsStr::new("workspace-b"))?;
    let first = NativeIntegrationContext::capture(
        &root.path().join("profile"),
        &root.path().join("workspace-a"),
        "first",
        "config-1",
    )?;
    let second = NativeIntegrationContext::capture(
        &root.path().join("profile"),
        &root.path().join("workspace-b"),
        "second",
        "config-1",
    )?;
    assert_ne!(first.scope().workspace_id, second.scope().workspace_id);
    assert!(NativeBudgetService::load(&first)?.is_none());
    let a = NativeBudgetService::initialize(&first, "actual-verified-source-operation")?;
    let b = NativeBudgetService::load(&second)?.unwrap();
    assert_eq!(a.namespace_id(), b.namespace_id());
    assert_eq!(
        a.accounting_store().storage_directory_identity()?,
        b.accounting_store().storage_directory_identity()?
    );
    a.verify(&second)?;
    Ok(())
}

#[test]
fn committed_journal_loss_is_not_reinitialized_or_given_a_second_namespace() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("budget-native-loss-test")?;
    let directory = PrivateDirectory::open_existing(root.path())?;
    directory.create_private_child(OsStr::new("profile"))?;
    directory.create_private_child(OsStr::new("workspace"))?;
    let context = NativeIntegrationContext::capture(
        &root.path().join("profile"),
        &root.path().join("workspace"),
        "original",
        "config-1",
    )?;
    let service = NativeBudgetService::initialize(&context, "verified-original")?;
    let ledger = root
        .path()
        .join("profile")
        .join(service.namespace_id())
        .join("ledger");
    std::fs::remove_dir_all(&ledger)?;
    assert!(NativeBudgetService::load(&context).is_err());
    assert!(NativeBudgetService::initialize(&context, "must-not-reset").is_err());
    assert!(!ledger.exists());
    Ok(())
}
