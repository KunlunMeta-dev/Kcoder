use super::*;

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|cause| cause.kind() == std::io::ErrorKind::NotFound)
    })
}
fn read_json<T: serde::de::DeserializeOwned>(
    directory: &PrivateDirectory,
    name: &str,
    max: u64,
) -> Result<T> {
    let mut file = directory.open_single_link_regular_file(OsStr::new(name))?;
    ensure!(
        file.metadata()?.len() <= max,
        "imported_project_budget_exceeded"
    );
    let mut bytes = Vec::new();
    (&mut file).take(max + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= max,
        "imported_project_budget_exceeded"
    );
    serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("imported_project_store_invalid"))
}
fn publish(
    directory: &PrivateDirectory,
    name: &str,
    value: &impl Serialize,
    replace: bool,
) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(
        bytes.len() as u64 <= MAX_BYTES,
        "imported_project_budget_exceeded"
    );
    directory.atomic_publish_from_reader(
        OsStr::new(name),
        &mut bytes.as_slice(),
        replace,
        || Ok(None),
    )?;
    Ok(())
}
fn birth_valid(
    parent: &PrivateDirectory,
    directory: &PrivateDirectory,
    birth: &Birth,
) -> Result<()> {
    ensure!(
        birth.version == 1
            && validation::sha(&birth.epoch)
            && birth.profile_identity == parent.directory_identity()?
            && birth.directory_identity == directory.directory_identity()?,
        "imported_project_wrong_profile"
    );
    Ok(())
}
pub(super) fn open(profile: &Path) -> Result<ImportedProjectAssociationsStore> {
    let parent = PrivateDirectory::open_existing(profile)?;
    parent.verify_trusted_config_directory()?;
    let profile = dunce::canonicalize(profile)?;
    ensure!(
        PrivateDirectory::open_existing(&profile)?.directory_identity()?
            == parent.directory_identity()?,
        "imported_project_wrong_profile"
    );
    let (directory, created) = match parent.create_private_child(OsStr::new(DIRECTORY)) {
        Ok(directory) => (directory, true),
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|cause| cause.kind() == std::io::ErrorKind::AlreadyExists)
            }) =>
        {
            (parent.open_child(OsStr::new(DIRECTORY), false)?, false)
        }
        Err(error) => return Err(error),
    };
    directory.verify_private_directory()?;
    let birth = if created {
        let mut random = [0; 32];
        getrandom::fill(&mut random)
            .map_err(|_| anyhow::anyhow!("imported_project_birth_unavailable"))?;
        let lock = directory.open_read_write_file(OsStr::new(LOCK), true)?;
        lock.sync_all()?;
        let lock_identity = directory.portable_regular_handle_identity(&lock)?;
        let birth = Birth {
            version: 1,
            epoch: random.iter().map(|byte| format!("{byte:02x}")).collect(),
            profile_identity: parent.directory_identity()?,
            directory_identity: directory.directory_identity()?,
            lock_identity,
            stage: BirthStage::Initializing,
        };
        publish(&directory, BIRTH, &birth, false)?;
        birth
    } else {
        read_json::<Birth>(&directory, BIRTH, 32 * 1024)
            .map_err(|_| anyhow::anyhow!("imported_project_birth_unknown"))?
    };
    birth_valid(&parent, &directory, &birth)?;
    let mut store = ImportedProjectAssociationsStore {
        profile,
        parent,
        directory,
        birth,
    };
    {
        let _lease = store.lock(PrivateLeaseMode::Exclusive)?;
        let mut birth: Birth = read_json(&store.directory, BIRTH, 32 * 1024)?;
        birth_valid(&store.parent, &store.directory, &birth)?;
        ensure!(
            birth.epoch == store.birth.epoch && birth.lock_identity == store.birth.lock_identity,
            "imported_project_birth_unknown"
        );
        if birth.stage == BirthStage::Initializing {
            // No caller can publish associations until the initial empty state and seal exist.
            match read_json::<State>(&store.directory, STATE, MAX_BYTES) {
                Ok(state) => ensure!(
                    state.version == 1
                        && state.epoch == birth.epoch
                        && state.generation == 0
                        && state.records.is_empty()
                        && state.receipts.is_empty(),
                    "imported_project_birth_unknown"
                ),
                Err(error) if missing(&error) => {
                    publish(&store.directory, STATE, &State::new(&birth.epoch), false)?
                }
                Err(_) => anyhow::bail!("imported_project_birth_unknown"),
            }
            birth.stage = BirthStage::Sealed;
            publish(&store.directory, BIRTH, &birth, true)?;
        }
        store.birth = birth;
        store.read()?;
    }
    Ok(store)
}
impl ImportedProjectAssociationsStore {
    fn verify_namespace(&self) -> Result<()> {
        ensure!(
            PrivateDirectory::open_existing(&self.profile)?.directory_identity()?
                == self.birth.profile_identity
                && self.parent.directory_identity()? == self.birth.profile_identity
                && self
                    .parent
                    .open_child(OsStr::new(DIRECTORY), false)?
                    .directory_identity()?
                    == self.birth.directory_identity,
            "imported_project_wrong_profile"
        );
        self.directory.verify_private_directory()?;
        let birth: Birth = read_json(&self.directory, BIRTH, 32 * 1024)?;
        birth_valid(&self.parent, &self.directory, &birth)?;
        ensure!(
            birth.epoch == self.birth.epoch && birth.lock_identity == self.birth.lock_identity,
            "imported_project_birth_unknown"
        );
        Ok(())
    }
    pub(super) fn lock(&self, mode: PrivateLeaseMode) -> Result<VerifiedPrivateLease> {
        self.verify_namespace()?;
        let deadline = Instant::now() + Duration::from_millis(250);
        loop {
            if let Some(lease) = self.directory.try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.birth.lock_identity,
                mode,
            )? {
                self.verify_namespace()?;
                return Ok(lease);
            }
            ensure!(Instant::now() < deadline, "imported_project_busy");
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    pub(super) fn read(&self) -> Result<State> {
        self.verify_namespace()?;
        let state: State = read_json(&self.directory, STATE, MAX_BYTES)
            .map_err(|_| anyhow::anyhow!("imported_project_publication_unknown"))?;
        ensure!(
            state.version == 1
                && state.epoch == self.birth.epoch
                && state.records.len() <= MAX_RECORDS
                && state.receipts.len() <= MAX_RECEIPTS,
            "imported_project_store_invalid"
        );
        for (id, record) in &state.records {
            validation::record(record)?;
            ensure!(id == &record.id, "imported_project_store_invalid");
            let receipt = state
                .receipts
                .get(&receipt_key(&record.owner))
                .ok_or_else(|| anyhow::anyhow!("imported_project_store_invalid"))?;
            ensure!(
                receipt.stage == ImportedProjectReceiptStage::Associated
                    && receipt.record_sha256 == hash(record)?
                    && receipt.record_revision == record.revision
                    && receipt.association_id == record.id,
                "imported_project_store_invalid"
            );
        }
        for (key, receipt) in &state.receipts {
            validation::owner(&receipt.owner)?;
            ensure!(
                key == &receipt_key(&receipt.owner)
                    && validation::sha(&receipt.record_sha256)
                    && validation::identifier(&receipt.association_id)
                    && receipt.record_revision > 0,
                "imported_project_store_invalid"
            );
            match receipt.stage {
                ImportedProjectReceiptStage::Associated => {
                    let record = state
                        .records
                        .get(&receipt.association_id)
                        .ok_or_else(|| anyhow::anyhow!("imported_project_publication_unknown"))?;
                    ensure!(
                        record.owner == receipt.owner
                            && hash(record)? == receipt.record_sha256
                            && record.revision == receipt.record_revision,
                        "imported_project_publication_unknown"
                    );
                }
                ImportedProjectReceiptStage::Removed => ensure!(
                    !state.records.contains_key(&receipt.association_id),
                    "imported_project_publication_unknown"
                ),
            }
        }
        Ok(state)
    }
    pub(super) fn save(&self, state: &mut State) -> Result<()> {
        let expected_generation = state.generation;
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("imported_project_budget_exceeded"))?;
        let bytes = serde_json::to_vec(state)?;
        ensure!(
            bytes.len() as u64 <= MAX_BYTES,
            "imported_project_budget_exceeded"
        );
        // The verified coordinator is the namespace mutation fence. This is a conservative
        // Native CAS under that fence, not a claim that stat followed by rename is a kernel CAS.
        self.directory.atomic_publish_from_reader(
            OsStr::new(STATE),
            &mut bytes.as_slice(),
            true,
            || {
                ensure!(
                    self.read()?.generation == expected_generation,
                    "imported_project_revision_conflict"
                );
                Ok(None)
            },
        )?;
        self.verify_namespace()?;
        Ok(())
    }
}
