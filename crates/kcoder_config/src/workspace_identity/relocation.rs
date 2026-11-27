use super::*;
use crate::profile_identity::ProfileIdentity;

impl WorkspaceIdentity {
    /// The existing managed owner supplies live, nonserializable source and
    /// publication facts. No workspace generation, domain owner or epoch changes.
    pub fn relocate(
        source_profile: &PrivateDirectory,
        target_profile: &PrivateDirectory,
        owner: &impl ManagedWorkspaceRelocationProof,
    ) -> Result<Self> {
        let (source_id, target_id) = verify_owner(owner)?;
        verify_profiles(source_profile, target_profile, owner.operation_id())?;
        if source_profile.directory_identity()? != target_profile.directory_identity()? {
            Self::rebind_profile(source_profile, target_profile, owner.operation_id())?;
        }
        let source = source_record(source_profile, &source_id, &target_id, owner.operation_id())?;
        let planned = relocated_record(
            source_profile,
            source.as_ref(),
            &source_id,
            &target_id,
            owner,
        )?;
        let index = read_index(target_profile)?;
        if let Some(index) = &index {
            if source_profile.directory_identity()? != target_profile.directory_identity()? {
                ensure!(
                    index.value.value.operation_id == owner.operation_id()
                        && index.value.value.source_profile_identity
                            == source_profile.directory_identity()?,
                    "WORKSPACE_IDENTITY_RELOCATION_CONFLICT"
                );
            }
        }
        let source_profile_identity = source_profile.directory_identity()?;
        let mut next = index.as_ref().map_or_else(
            || AddressIndex {
                operation_id: owner.operation_id().into(),
                source_profile_identity,
                source_index_sha256: None,
                current: BTreeSet::new(),
                addresses: BTreeMap::new(),
                moved: BTreeMap::new(),
            },
            |index| index.value.value.clone(),
        );
        ensure!(
            !next.moved.contains_key(&target_id),
            "WORKSPACE_IDENTITY_RELOCATION_CONFLICT"
        );
        for path in [owner.source_path(), owner.destination_path()] {
            ensure!(
                next.addresses
                    .get(path)
                    .is_none_or(|binding| binding.current_identity == source_id
                        || binding.current_identity == target_id),
                "WORKSPACE_IDENTITY_ADDRESS_CONFLICT"
            );
        }
        next.operation_id = owner.operation_id().into();
        next.current.remove(&source_id);
        next.current.insert(target_id.clone());
        for id in next
            .addresses
            .values_mut()
            .map(|binding| &mut binding.current_identity)
            .chain(next.moved.values_mut())
        {
            if *id == source_id {
                *id = target_id.clone();
            }
        }
        next.addresses
            .entry(owner.source_path().into())
            .or_insert_with(|| AddressBinding {
                current_identity: target_id.clone(),
                source_identity: source_id.clone(),
            });
        next.addresses.insert(
            owner.destination_path().into(),
            AddressBinding {
                current_identity: target_id.clone(),
                source_identity: target_id.clone(),
            },
        );
        next.moved.insert(source_id.clone(), target_id.clone());
        validate_index(&next)?;
        storage::check_budget(&next, MAX_INDEX_BYTES)?;
        let existing =
            storage::raw::<Record>(target_profile, &record_name(&target_id), MAX_RECORD_BYTES)?;
        if let Some(existing) = &existing {
            let actual = read_record(target_profile, &target_id)?
                .context("WORKSPACE_IDENTITY_RECORD_REQUIRED")?;
            ensure!(
                actual.value.value == planned && actual.bytes == existing.bytes,
                "WORKSPACE_IDENTITY_RELOCATION_CONFLICT"
            );
        }
        verify_owner(owner)?;
        verify_source_snapshot(
            source_profile,
            &source_id,
            &target_id,
            owner.operation_id(),
            source.as_ref(),
        )?;
        storage::publish(
            target_profile,
            &record_name(&target_id),
            &planned,
            owner.operation_id(),
            existing.as_ref(),
            MAX_RECORD_BYTES,
        )?;
        verify_owner(owner)?;
        verify_source_snapshot(
            source_profile,
            &source_id,
            &target_id,
            owner.operation_id(),
            source.as_ref(),
        )?;
        storage::publish(
            target_profile,
            INDEX,
            &next,
            owner.operation_id(),
            index.as_ref(),
            MAX_INDEX_BYTES,
        )?;
        // The source profile can be the target profile. Its retained old cwd is
        // deliberately Moved now, so never recapture it as an ordinary scope.
        Self::verify_relocation(source_profile, target_profile, owner)
    }

    /// Reconcile only this original owner and operation, without publishing or
    /// opening the old cwd as a new runtime scope.
    pub fn verify_relocation(
        source_profile: &PrivateDirectory,
        target_profile: &PrivateDirectory,
        owner: &impl ManagedWorkspaceRelocationProof,
    ) -> Result<Self> {
        let (source_id, target_id) = verify_owner(owner)?;
        verify_profiles(source_profile, target_profile, owner.operation_id())?;
        let source = source_record(source_profile, &source_id, &target_id, owner.operation_id())?;
        let planned = relocated_record(
            source_profile,
            source.as_ref(),
            &source_id,
            &target_id,
            owner,
        )?;
        let current = read_record(target_profile, &target_id)?
            .context("WORKSPACE_IDENTITY_RELOCATION_UNCONFIRMED")?;
        let index =
            read_index(target_profile)?.context("WORKSPACE_IDENTITY_RELOCATION_UNCONFIRMED")?;
        ensure!(
            current.value.value == planned
                && index.value.value.operation_id == owner.operation_id()
                && index.value.value.current.contains(&target_id)
                && index.value.value.moved.get(&source_id) == Some(&target_id)
                && index.value.value.addresses.get(owner.source_path())
                    == Some(&AddressBinding {
                        current_identity: target_id.clone(),
                        source_identity: source_id.clone(),
                    })
                && index.value.value.addresses.get(owner.destination_path())
                    == Some(&AddressBinding {
                        current_identity: target_id.clone(),
                        source_identity: target_id.clone(),
                    }),
            "WORKSPACE_IDENTITY_RELOCATION_CONFLICT"
        );
        let result = Self::observe(target_profile, owner.target_directory())?;
        result.verify(target_profile, owner.target_directory())?;
        verify_owner(owner)?;
        Ok(result)
    }

    /// Rebind only existing facts after a formal profile relocation. Unchanged
    /// workspace addresses/identities and historical project keys are retained.
    /// No missing workspace is created or granted authority by this operation.
    pub fn rebind_profile(
        source_profile: &PrivateDirectory,
        target_profile: &PrivateDirectory,
        operation_id: &str,
    ) -> Result<usize> {
        verify_profiles(source_profile, target_profile, operation_id)?;
        if source_profile.directory_identity()? == target_profile.directory_identity()? {
            return Ok(
                read_index(source_profile)?.map_or(0, |index| index.value.value.current.len())
            );
        }
        let source = read_index(source_profile)?;
        let target = storage::raw::<AddressIndex>(target_profile, INDEX, MAX_INDEX_BYTES)?;
        if read_index(target_profile).is_ok_and(|index| index.is_some()) {
            return Self::verify_profile_rebinding(source_profile, target_profile, operation_id);
        }
        let Some(source) = source else {
            ensure!(target.is_none(), "WORKSPACE_IDENTITY_RELOCATION_CONFLICT");
            return Ok(0);
        };
        ensure!(
            target
                .as_ref()
                .is_some_and(|target| target.bytes == source.bytes),
            "WORKSPACE_IDENTITY_RELOCATION_CONFLICT"
        );
        let mut value = source.value.value.clone();
        value.operation_id = operation_id.into();
        value.source_profile_identity = source_profile.directory_identity()?;
        value.source_index_sha256 = Some(digest(&source.bytes));
        storage::check_budget(&value, MAX_INDEX_BYTES)?;
        for identity in &source.value.value.current {
            let old = read_record(source_profile, identity)?
                .context("WORKSPACE_IDENTITY_RECORD_REQUIRED")?;
            let mut value = old.value.value.clone();
            value.operation_id = operation_id.into();
            value.source_profile_identity = source_profile.directory_identity()?;
            value.source_workspace_identity = identity.clone();
            value.source_record_sha256 = Some(digest(&old.bytes));
            let current =
                storage::raw::<Record>(target_profile, &record_name(identity), MAX_RECORD_BYTES)?
                    .context("WORKSPACE_IDENTITY_RECORD_REQUIRED")?;
            if current.bytes != old.bytes {
                ensure!(
                    read_record(target_profile, identity)?
                        .is_some_and(|record| record.value.value == value),
                    "WORKSPACE_IDENTITY_RELOCATION_CONFLICT"
                );
            }
            old.verify_anchor()?;
            storage::publish(
                target_profile,
                &record_name(identity),
                &value,
                operation_id,
                Some(&current),
                MAX_RECORD_BYTES,
            )?;
        }
        source.verify_anchor()?;
        verify_profiles(source_profile, target_profile, operation_id)?;
        storage::publish(
            target_profile,
            INDEX,
            &value,
            operation_id,
            target.as_ref(),
            MAX_INDEX_BYTES,
        )?;
        Self::verify_profile_rebinding(source_profile, target_profile, operation_id)
    }

    pub fn verify_profile_rebinding(
        source_profile: &PrivateDirectory,
        target_profile: &PrivateDirectory,
        operation_id: &str,
    ) -> Result<usize> {
        verify_profiles(source_profile, target_profile, operation_id)?;
        let source = read_index(source_profile)?;
        if source_profile.directory_identity()? == target_profile.directory_identity()? {
            return Ok(source.map_or(0, |index| index.value.value.current.len()));
        }
        let target = read_index(target_profile)?;
        let Some(source) = source else {
            if let Some(target) = target {
                ensure!(
                    target.value.value.operation_id == operation_id
                        && target.value.value.source_profile_identity
                            == source_profile.directory_identity()?
                        && target.value.value.source_index_sha256.is_none(),
                    "WORKSPACE_IDENTITY_RELOCATION_CONFLICT"
                );
            }
            return Ok(0);
        };
        let target = target.context("WORKSPACE_IDENTITY_RELOCATION_UNCONFIRMED")?;
        ensure!(
            target.value.value.operation_id == operation_id
                && target.value.value.source_profile_identity
                    == source_profile.directory_identity()?
                && target.value.value.source_index_sha256 == Some(digest(&source.bytes)),
            "WORKSPACE_IDENTITY_RELOCATION_CONFLICT"
        );
        for identity in &source.value.value.current {
            let current_id = route(&target.value.value, identity)?;
            let old = read_record(source_profile, identity)?
                .context("WORKSPACE_IDENTITY_RECORD_REQUIRED")?;
            let current = read_record(target_profile, current_id)?
                .context("WORKSPACE_IDENTITY_RECORD_REQUIRED")?;
            let source_record_sha256 = digest(&old.bytes);
            let (old, current) = (&old.value.value, &current.value.value);
            ensure!(
                old.logical_seed == current.logical_seed
                    && old.worktree_id == current.worktree_id
                    && old.project_storage_key == current.project_storage_key
                    && old.storage_workspace_path == current.storage_workspace_path
                    && current.operation_id == operation_id
                    && current.source_profile_identity == source_profile.directory_identity()?
                    && current.source_workspace_identity == *identity
                    && current.source_record_sha256 == Some(source_record_sha256),
                "WORKSPACE_IDENTITY_RELOCATION_CONFLICT"
            );
        }
        for (address, original) in &source.value.value.addresses {
            ensure!(
                target.value.value.addresses.get(address)
                    == Some(&AddressBinding {
                        current_identity: route(&target.value.value, &original.current_identity)?
                            .clone(),
                        source_identity: original.source_identity.clone(),
                    }),
                "WORKSPACE_IDENTITY_ADDRESS_CHANGED"
            );
        }
        for (old, original_id) in &source.value.value.moved {
            ensure!(
                target.value.value.moved.get(old) == Some(route(&target.value.value, original_id)?),
                "WORKSPACE_IDENTITY_ADDRESS_CHANGED"
            );
        }
        source.verify_anchor()?;
        Ok(source.value.value.current.len())
    }
}

fn route<'a>(index: &'a AddressIndex, identity: &'a str) -> Result<&'a String> {
    index
        .current
        .get(identity)
        .or_else(|| index.moved.get(identity))
        .context("WORKSPACE_IDENTITY_RELOCATION_UNCONFIRMED")
}

fn source_record(
    profile: &PrivateDirectory,
    source: &str,
    target: &str,
    operation_id: &str,
) -> Result<Option<HeldDocument<Record>>> {
    let index = read_index(profile)?;
    if let Some(index) = &index {
        if let Some(current) = index.value.value.moved.get(source) {
            ensure!(
                current == target && index.value.value.operation_id == operation_id,
                "WORKSPACE_IDENTITY_RELOCATION_CONFLICT"
            );
        }
    }
    let record = read_record(profile, source)?;
    ensure!(
        record.is_some()
            == index.as_ref().is_some_and(|index| {
                index.value.value.current.contains(source)
                    || index.value.value.moved.contains_key(source) && record.is_some()
            }),
        "WORKSPACE_IDENTITY_INDEX_CHANGED"
    );
    Ok(record)
}

fn verify_source_snapshot(
    profile: &PrivateDirectory,
    source: &str,
    target: &str,
    operation_id: &str,
    expected: Option<&HeldDocument<Record>>,
) -> Result<()> {
    let current = source_record(profile, source, target, operation_id)?;
    ensure!(
        current.as_ref().map(|record| &record.bytes) == expected.map(|record| &record.bytes),
        "WORKSPACE_IDENTITY_SOURCE_CHANGED"
    );
    if let Some(expected) = expected {
        expected.verify_anchor()?;
    }
    Ok(())
}

fn relocated_record(
    source_profile: &PrivateDirectory,
    source: Option<&HeldDocument<Record>>,
    source_id: &str,
    target_id: &str,
    owner: &impl ManagedWorkspaceRelocationProof,
) -> Result<Record> {
    if let Some(source) = source {
        source.verify_anchor()?;
        ensure!(
            source.value.value.worktree_id == owner.worktree_id(),
            "WORKSPACE_IDENTITY_OWNER_CHANGED"
        );
    }
    Ok(Record {
        operation_id: owner.operation_id().into(),
        worktree_id: owner.worktree_id().into(),
        logical_seed: source.map_or_else(
            || source_id.into(),
            |source| source.value.value.logical_seed.clone(),
        ),
        workspace_identity: target_id.into(),
        workspace_path: owner.destination_path().into(),
        project_storage_key: source.map_or_else(
            || crate::project_key_for_path(owner.source_path()),
            |source| source.value.value.project_storage_key.clone(),
        ),
        storage_workspace_path: source.map_or_else(
            || owner.source_path().into(),
            |source| source.value.value.storage_workspace_path.clone(),
        ),
        source_profile_identity: source_profile.directory_identity()?,
        source_workspace_identity: source_id.into(),
        source_record_sha256: source.map(|source| digest(&source.bytes)),
    })
}

fn verify_profiles(
    source: &PrivateDirectory,
    target: &PrivateDirectory,
    operation_id: &str,
) -> Result<()> {
    ensure!(
        valid_operation(operation_id),
        "WORKSPACE_IDENTITY_OPERATION_INVALID"
    );
    source.verify_config_root_directory()?;
    target.verify_config_root_directory()?;
    let logical = ProfileIdentity::observe(source)?;
    if source.directory_identity()? != target.directory_identity()? {
        logical.verify_relocation(source, target, operation_id)?;
    } else {
        logical.verify(source)?;
    }
    Ok(())
}

fn verify_owner(owner: &impl ManagedWorkspaceRelocationProof) -> Result<(String, String)> {
    owner.verify()?;
    let published = owner.published_component();
    published.verify()?;
    validate_path(owner.source_path())?;
    validate_path(owner.destination_path())?;
    let relative = owner.relative_path();
    ensure!(
        valid_operation(owner.operation_id())
            && text(owner.worktree_id(), 256)
            && published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN
            && published.operation_id() == owner.operation_id()
            && !relative.as_os_str().is_empty()
            && relative.components().count() <= 128
            && relative
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            && owner.source_path().strip_prefix(published.source_path())? == relative
            && owner
                .destination_path()
                .strip_prefix(published.destination_path())?
                == relative,
        "WORKSPACE_IDENTITY_PUBLICATION_MISMATCH"
    );
    let source_root = PrivateDirectory::open_existing(published.source_path())?;
    ensure!(
        source_root.directory_identity()? == published.source_identity(),
        "WORKSPACE_IDENTITY_DIRECTORY_CHANGED"
    );
    let source = open_relative(&source_root, relative)?;
    let target = open_relative(published.directory(), relative)?;
    let source_id = source.directory_identity()?;
    let target_id = target.directory_identity()?;
    ensure!(
        source_id != target_id
            && owner.source_directory().directory_identity()? == source_id
            && owner.target_directory().directory_identity()? == target_id
            && PrivateDirectory::open_existing(owner.source_path())?.directory_identity()?
                == source_id
            && PrivateDirectory::open_existing(owner.destination_path())?.directory_identity()?
                == target_id,
        "WORKSPACE_IDENTITY_DIRECTORY_CHANGED"
    );
    Ok((source_id, target_id))
}

fn open_relative(root: &PrivateDirectory, relative: &Path) -> Result<PrivateDirectory> {
    let mut parts = relative.components();
    let Component::Normal(first) = parts.next().context("WORKSPACE_IDENTITY_PATH_INVALID")? else {
        anyhow::bail!("WORKSPACE_IDENTITY_PATH_INVALID")
    };
    let mut directory = root.open_child(first, false)?;
    for part in parts {
        let Component::Normal(name) = part else {
            anyhow::bail!("WORKSPACE_IDENTITY_PATH_INVALID")
        };
        directory = directory.open_child(name, false)?;
    }
    Ok(directory)
}
