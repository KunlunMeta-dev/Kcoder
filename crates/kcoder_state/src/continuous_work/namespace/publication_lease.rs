//! Per-publication owner lease. The durable intent, not this lock file or a
//! matching filename, establishes which original operation may use it.
use super::*;

pub(in crate::continuous_work) struct PublicationLease {
    name: String,
    identity: PortableLeaseIdentity,
    lease: VerifiedPrivateLease,
}
impl PublicationLease {
    pub(in crate::continuous_work) fn name(&self) -> &str {
        &self.name
    }
    pub(in crate::continuous_work) fn identity(&self) -> &PortableLeaseIdentity {
        &self.identity
    }

    /// This check is bounded local metadata only; retain the actual lease
    /// until after the intent/receipt transaction has committed.
    pub(in crate::continuous_work) fn revalidate(&self, namespace: &Namespace) -> Result<()> {
        namespace.verify()?;
        ensure!(
            namespace
                .directory
                .portable_regular_handle_identity(self.lease.file())?
                == self.identity
                && namespace
                    .directory
                    .portable_regular_identity(OsStr::new(&self.name))?
                    == self.identity,
            "CONTINUOUS_WORK_PUBLICATION_LEASE_CHANGED"
        );
        Ok(())
    }
}

fn valid_name(name: &str) -> bool {
    name.strip_prefix("publication-")
        .and_then(|rest| rest.strip_suffix(".lease"))
        .and_then(|id| uuid::Uuid::parse_str(id).ok())
        .is_some()
}

impl Namespace {
    /// Prepare bytes in an owned kernel object without publishing a name.
    /// This may perform bounded file I/O and must run without the global
    /// State transaction lock held.
    pub(crate) fn prepare_publication_object(
        &self,
        name: &str,
        bytes: &[u8],
    ) -> Result<crate::prepared_immutable::PreparedImmutable> {
        self.verify()?;
        let prepared = crate::prepared_immutable::PreparedImmutable::prepare(
            &self.directory,
            OsStr::new(name),
            &mut std::io::Cursor::new(bytes),
            bytes.len() as u64,
        )?;
        self.verify()?;
        Ok(prepared)
    }

    /// Inspect only a still-held original published object. A serialized file
    /// identity cannot recreate this proof after a crash or handle loss.
    pub(crate) fn read_live_publication(
        &self,
        published: &crate::prepared_immutable::PublishedImmutable,
        max_bytes: u64,
    ) -> Result<crate::prepared_immutable::VerifiedImmutableRead> {
        self.verify()?;
        ensure!(
            published.directory_identity() == self.directory.directory_identity()?,
            "CONTINUOUS_WORK_PUBLICATION_SCOPE_MISMATCH"
        );
        let result = published.read_verified(max_bytes)?;
        self.verify()?;
        Ok(result)
    }

    /// Local metadata check for the next short transaction; None is not an
    /// ownership proof and must be combined with the original exclusive lease.
    pub(crate) fn publication_name_absent(&self, name: &str) -> Result<bool> {
        self.verify()?;
        match self.directory.open_entry_handle(OsStr::new(name)) {
            Ok(_) => Ok(false),
            Err(error) if is_not_found(&error) => Ok(true),
            Err(error) => Err(error),
        }
    }

    /// Call while holding the namespace transaction lock, then persist this
    /// exact lease identity together with the original publication intent.
    pub(in crate::continuous_work) fn create_publication_lease(&self) -> Result<PublicationLease> {
        self.verify()?;
        let name = format!("publication-{}.lease", uuid::Uuid::new_v4());
        let file = self
            .directory
            .open_read_write_file(OsStr::new(&name), true)?;
        let identity = self.directory.portable_regular_handle_identity(&file)?;
        let lease = self
            .directory
            .try_existing_portable_lock(OsStr::new(&name), &identity, PrivateLeaseMode::Exclusive)?
            .context("CONTINUOUS_WORK_PUBLICATION_LEASE_BUSY")?;
        let publication = PublicationLease {
            name,
            identity,
            lease,
        };
        publication.revalidate(self)?;
        Ok(publication)
    }

    /// None means the original owner still holds this exact lease. Missing,
    /// replaced, linked or unsafe lease leaves are errors, not permission to
    /// create another lease or assume the prior operation did not execute.
    pub(in crate::continuous_work) fn try_publication_lease(
        &self,
        name: &str,
        identity: &PortableLeaseIdentity,
    ) -> Result<Option<PublicationLease>> {
        ensure!(
            valid_name(name),
            "CONTINUOUS_WORK_PUBLICATION_LEASE_INVALID"
        );
        self.verify()?;
        let Some(lease) = self.directory.try_existing_portable_lock(
            OsStr::new(name),
            identity,
            PrivateLeaseMode::Exclusive,
        )?
        else {
            return Ok(None);
        };
        let publication = PublicationLease {
            name: name.into(),
            identity: identity.clone(),
            lease,
        };
        publication.revalidate(self)?;
        Ok(Some(publication))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn original_lease_excludes_peer_and_rejects_replaced_file() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("continuous-publication-lease")?;
        let first = Namespace::open_or_create(temp.path(), b"{}")?;
        let second = Namespace::open_existing(temp.path())?.unwrap();
        let lease = first.update(|_| Ok((None, first.create_publication_lease()?)))?;
        assert!(
            second
                .try_publication_lease(lease.name(), lease.identity())?
                .is_none()
        );
        let name = lease.name().to_owned();
        let identity = lease.identity().clone();
        lease.revalidate(&first)?;
        drop(lease);
        let reacquired = second.try_publication_lease(&name, &identity)?.unwrap();
        reacquired.revalidate(&second)?;
        let directory = temp.path().join("continuous-work.v1");
        std::fs::rename(directory.join(&name), directory.join("renamed-original"))?;
        std::fs::write(directory.join(&name), b"")?;
        assert!(reacquired.revalidate(&second).is_err());
        assert!(first.try_publication_lease(&name, &identity).is_err());
        Ok(())
    }
}
