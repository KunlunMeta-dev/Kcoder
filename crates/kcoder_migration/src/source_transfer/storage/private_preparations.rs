//! A pure optional secret birth lookup; missing acknowledged namespace is unknown.
use super::*;
impl Store {
    pub(in crate::source_transfer) fn existing_private_credentials_if_born(
        profile: &Path,
    ) -> Result<Option<Self>> {
        ensure!(profile.is_absolute(), "source_transfer_invalid_profile");
        let directory = PrivateDirectory::open_existing(profile)?;
        directory.verify_private_directory()?;
        let identity = directory.directory_identity()?;
        let namespace = directory
            .open_child(OsStr::new("migrations"), false)?
            .open_child(OsStr::new("source-transfer"), false)?;
        namespace.verify_private_directory()?;
        let native: NativeIdentity =
            load(&namespace, "native.json")?.context("private_credentials_owner_unknown")?;
        ensure!(
            native.directory == identity && native.account == current_account()?,
            "private_credentials_owner_unknown"
        );
        valid_uuid(&native.instance)?;
        if native.private_credentials_birth.is_none() {
            match namespace.open_child(OsStr::new("private-credentials"), false) {
                Err(error) if missing(&error) => return Ok(None),
                _ => anyhow::bail!("private_credentials_owner_unknown"),
            }
        }
        let authority = TransferAuthority {
            instance_id: native.instance,
            account_id: digest(&("source-transfer.account/1", &native.account, &identity))?,
        };
        Self::reopen_private_credentials(profile, &identity, &authority).map(Some)
    }
}
