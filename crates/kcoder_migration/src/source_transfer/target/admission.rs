//! Destination admission remains revocable before the operation manifest exists.
use super::*;

impl IncomingTransfers {
    fn admission_name(request: &str) -> String {
        format!("{request}.admission")
    }
    pub(super) fn grant(
        &self,
        request: &str,
    ) -> Result<(PrivateDirectory, String, DestinationGrant)> {
        valid_uuid(request)?;
        let root = self.store.root()?;
        let name = format!("grant-{request}.json");
        let grant: DestinationGrant =
            load(&root, &name)?.context("source_transfer_destination_unavailable")?;
        grant.source.validate()?;
        ensure!(
            grant.destination.grant_id == request
                && grant.destination.authority == self.store.authority
                && grant.destination.scope == self.scope()?,
            "source_transfer_authority_changed"
        );
        Ok((root, name, grant))
    }
    pub(super) fn ensure_admission(
        &self,
        root: &PrivateDirectory,
        name: &str,
        grant: &mut DestinationGrant,
    ) -> Result<()> {
        if grant.admission_required {
            self.admission_directory(root, grant)?;
            return Ok(());
        }
        ensure!(
            grant.admission.is_none(),
            "source_transfer_recovery_required"
        );
        let child = Self::admission_name(&grant.destination.grant_id);
        match root.open_child(OsStr::new(&child), false) {
            Err(error) if missing(&error) => {}
            _ => anyhow::bail!("source_transfer_recovery_required"),
        }
        // Only this explicit mutation may upgrade a legacy grant. Once published,
        // missing born metadata is unknown and may never be initialized again.
        grant.admission_required = true;
        save(root, name, grant)?;
        let directory = root.create_private_child(OsStr::new(&child))?;
        let _writer = lease(&directory, "writer.lock")?;
        let _controller = lease(&directory, "control.lock")?;
        let anchor = Anchor {
            owner: self.store.identity.clone(),
            directory: directory.directory_identity()?,
            request: grant.destination.grant_id.clone(),
            binding: digest(&(&grant.destination, &grant.source))?,
            writer: directory.portable_regular_identity(OsStr::new("writer.lock"))?,
            controller: directory.portable_regular_identity(OsStr::new("control.lock"))?,
        };
        exact(&directory, "binding.json", &anchor)?;
        exact(&directory, "control.json", &Control::default())?;
        grant.admission = Some(anchor);
        save(root, name, grant)?;
        Ok(())
    }
    pub(super) fn admission_directory(
        &self,
        root: &PrivateDirectory,
        grant: &DestinationGrant,
    ) -> Result<Option<PrivateDirectory>> {
        if !grant.admission_required {
            ensure!(
                grant.admission.is_none(),
                "source_transfer_recovery_required"
            );
            return match root.open_child(
                OsStr::new(&Self::admission_name(&grant.destination.grant_id)),
                false,
            ) {
                Err(error) if missing(&error) => Ok(None),
                _ => anyhow::bail!("source_transfer_recovery_required"),
            };
        }
        let expected = grant
            .admission
            .as_ref()
            .context("source_transfer_recovery_required")?;
        let directory = root.open_child(
            OsStr::new(&Self::admission_name(&grant.destination.grant_id)),
            false,
        )?;
        directory.verify_private_directory()?;
        let anchor: Anchor =
            load(&directory, "binding.json")?.context("source_transfer_recovery_required")?;
        ensure!(
            &anchor == expected
                && anchor.owner == self.store.identity
                && anchor.request == grant.destination.grant_id
                && anchor.directory == directory.directory_identity()?
                && anchor.binding == digest(&(&grant.destination, &grant.source))?,
            "source_transfer_owner_changed"
        );
        control(&directory)?;
        // Both the free and busy branches verify the original lock identities.
        drop(try_operation_lease(&directory, "writer.lock")?);
        drop(try_operation_lease(&directory, "control.lock")?);
        Ok(Some(directory))
    }
    pub(super) fn admission(&self, request: &str) -> Result<Option<PrivateDirectory>> {
        let (root, _, grant) = self.grant(request)?;
        self.admission_directory(&root, &grant)
    }
    pub fn admission_state(&self, request: &str) -> Result<Option<TransferState>> {
        self.admission(request)?
            .as_ref()
            .map(|directory| control(directory).map(|value| value.state(false)))
            .transpose()
    }
    pub(super) fn admission_active(&self, request: &str) -> Result<()> {
        if let Some(directory) = self.admission(request)? {
            active(&directory)?;
        }
        Ok(())
    }
    pub fn cancel_target(
        &self,
        request: &str,
        source: &TransferAuthority,
        command: &str,
    ) -> Result<()> {
        valid_uuid(command)?;
        let (root, name, grant) = self.grant(request)?;
        ensure!(grant.source == *source, "source_transfer_authority_changed");
        let _lease = lease(&root, "grants.lock")?;
        // Reload under the shared publication lease before any legacy upgrade.
        let (_, _, mut grant) = self.grant(request)?;
        ensure!(grant.source == *source, "source_transfer_authority_changed");
        self.ensure_admission(&root, &name, &mut grant)?;
        let directory = self
            .admission_directory(&root, &grant)?
            .context("source_transfer_recovery_required")?;
        cancel(&directory, command)?;
        let admission = control(&directory)?;
        let active_command = admission
            .commands
            .iter()
            .position(|existing| existing == command)
            .is_some_and(|index| index as u64 + 1 > admission.acknowledged);
        if active_command && self.store.has_operation(request)? {
            cancel(&self.existing(request, source)?.0, command)?;
        }
        Ok(())
    }
    pub fn resume_target(
        &self,
        request: &str,
        source: &TransferAuthority,
        expected_admission: &TransferState,
        expected_operation: Option<&TransferState>,
    ) -> Result<()> {
        let grant = self.recover_target(request)?;
        ensure!(
            grant.source_authority() == source,
            "source_transfer_authority_changed"
        );
        let directory = self
            .admission(request)?
            .context("source_transfer_admission_control_required")?;
        let _writer = operation_lease(&directory, "writer.lock")?;
        let _controller = operation_lease(&directory, "control.lock")?;
        let mut admission = control(&directory)?;
        ensure!(
            admission.state(false) == *expected_admission,
            "source_transfer_revision_conflict"
        );
        let current = self.state_if_exists(request, source)?;
        ensure!(
            current.as_ref() == expected_operation,
            "source_transfer_revision_conflict"
        );
        if let Some(current) = current {
            // Clear the operation first. A crash still leaves admission revoked.
            resume(
                &self.existing(request, source)?.0,
                current.sequence,
                current.cancel_watermark,
            )?;
        }
        admission.acknowledged = admission.cancelled;
        admission.sequence = admission
            .sequence
            .checked_add(1)
            .context("source_transfer_revision_exhausted")?;
        save(&directory, "control.json", &admission)
    }
    pub(super) fn admission_busy(&self, request: &str) -> Result<bool> {
        self.admission(request)?
            .as_ref()
            .map(|directory| {
                try_operation_lease(directory, "writer.lock").map(|lease| lease.is_none())
            })
            .transpose()
            .map(|value| value.unwrap_or(false))
    }
}
