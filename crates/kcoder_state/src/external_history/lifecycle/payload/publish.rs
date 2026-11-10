use super::*;
impl PayloadNode {
    pub fn verified_file(
        &self,
        directory: &PrivateDirectory,
        name: &str,
        missing_receipt: bool,
    ) -> Result<bool> {
        let node = self.read()?;
        let proofs = node.files.get(name);
        let file = match directory.open_single_link_regular_file(OsStr::new(name)) {
            Ok(file) => file,
            Err(error)
                if missing(&error)
                    && (proofs.is_none() || missing_receipt && name == "receipt.json") =>
            {
                return Ok(false);
            }
            Err(error) => return Err(error),
        };
        let proofs = proofs.context("external_history_payload_ownership_unknown")?;
        let actual = file_digest(directory, &file, &mut || true)?;
        ensure!(
            proofs.iter().any(|proof| proof.identity == actual.identity
                && proof.bytes == actual.bytes
                && proof.sha256 == actual.sha256),
            "external_history_payload_changed"
        );
        Ok(true)
    }
    fn restore_missing_metadata(
        &self,
        directory: &PrivateDirectory,
        name: &str,
        bytes: &[u8],
        check: &mut impl FnMut() -> bool,
    ) -> Result<()> {
        let _lease = self.lock()?;
        let mut node = self.read()?;
        let Some(prior) = node.files.get(name).cloned() else {
            return Ok(());
        };
        ensure!(
            matches!(name, "binding.json" | "receipt.json" | "intent.json")
                && prior.iter().any(|proof| proof.bytes == bytes.len() as u64
                    && proof.sha256 == crate::external_history::hash(bytes)),
            "external_history_payload_publication_unknown"
        );
        match directory.open_single_link_regular_file(OsStr::new(name)) {
            Err(error) if missing(&error) => {}
            Err(error) => return Err(error),
            Ok(_) => anyhow::bail!("external_history_payload_changed"),
        }
        node.files.remove(name);
        self.selected_files(directory, &node, check)?;
        ensure!(
            node.restored_metadata.len() + prior.len() <= 32,
            "external_history_payload_metadata_budget_exceeded"
        );
        node.restored_metadata.extend(prior);
        node.seal = None;
        self.save(&mut node)
    }
    fn selected_files(
        &self,
        directory: &PrivateDirectory,
        node: &Node,
        check: &mut impl FnMut() -> bool,
    ) -> Result<BTreeMap<String, FileProof>> {
        self.verify_controls(directory, &node.controls)?;
        let mut selected = BTreeMap::new();
        directory.visit_entry_names_bounded(MAX_NODES + 8, |name| {
            ensure!(check(), "external_history_lifecycle_cancelled");
            let name = name
                .to_str()
                .context("external_history_payload_unknown_entry")?;
            if !node.path.contains('/') && !allowed(&node.path, name) {
                // This is not ownership admission. The collection planner must separately
                // match every child directory against its original node birth.
                ensure!(
                    directory.entry_metadata(OsStr::new(name))?.is_dir(),
                    "external_history_payload_unknown_entry"
                );
                return Ok(());
            }
            let proofs = node
                .files
                .get(name)
                .context("external_history_payload_ownership_unknown")?;
            let file = directory.open_single_link_regular_file(OsStr::new(name))?;
            let identity = directory.portable_regular_handle_identity(&file)?;
            let expected = proofs
                .iter()
                .find(|proof| proof.identity == identity)
                .context("external_history_payload_changed")?;
            let mut actual = file_digest(directory, &file, check)?;
            actual.name = name.into();
            ensure!(
                actual.bytes == expected.bytes && actual.sha256 == expected.sha256,
                "external_history_payload_changed"
            );
            selected.insert(name.into(), actual);
            Ok(())
        })?;
        ensure!(
            node.files.keys().all(|name| selected.contains_key(name)),
            "external_history_payload_publication_unknown"
        );
        Ok(selected)
    }
    /// Persist exact descriptor identity and bytes before the destination appears.
    /// Interrupted publication is reconciled from these proofs, never from equal bytes alone.
    pub fn publish(
        &self,
        directory: &PrivateDirectory,
        name: &str,
        input: &mut impl Read,
        replace: bool,
        mut check: impl FnMut() -> bool,
    ) -> Result<u64> {
        ensure!(
            allowed(&self.path, name) && !controls(&self.path).contains(&name),
            "external_history_payload_invalid_file"
        );
        let _lease = self.lock()?;
        let mut node = self.read()?;
        let current = self.selected_files(directory, &node, &mut check)?;
        node.files = current
            .into_iter()
            .map(|(name, proof)| (name, vec![proof]))
            .collect();
        node.seal = None;
        self.save(&mut node)?;
        let bytes = directory.atomic_publish_observed_from_reader(
            OsStr::new(name),
            input,
            replace,
            || Ok(None),
            |file| {
                let mut proof = file_digest(directory, file, &mut check)?;
                proof.name = name.into();
                let versions = node.files.entry(name.into()).or_default();
                versions.push(proof);
                ensure!(versions.len() <= 2, "external_history_payload_changed");
                self.save(&mut node)
            },
        )?;
        let identity = directory.portable_regular_identity(OsStr::new(name))?;
        let proof = node
            .files
            .get(name)
            .and_then(|proofs| proofs.iter().find(|proof| proof.identity == identity))
            .cloned()
            .context("external_history_payload_changed")?;
        ensure!(proof.bytes == bytes, "external_history_payload_changed");
        node.files.insert(name.into(), vec![proof]);
        self.save(&mut node)?;
        Ok(bytes)
    }
    pub fn exact(
        &self,
        directory: &PrivateDirectory,
        name: &str,
        bytes: &[u8],
        maximum: u64,
        mut check: impl FnMut() -> bool,
    ) -> Result<()> {
        ensure!(
            bytes.len() as u64 <= maximum,
            "external_history_payload_budget_exceeded"
        );
        if let Some(existing) = crate::external_history::read_optional(directory, name, maximum)? {
            ensure!(existing == bytes, "external_history_payload_changed");
            ensure!(
                self.verified_file(directory, name, false)?,
                "external_history_payload_ownership_unknown"
            );
            return Ok(());
        }
        self.restore_missing_metadata(directory, name, bytes, &mut check)?;
        self.publish(
            directory,
            name,
            &mut std::io::Cursor::new(bytes),
            false,
            check,
        )?;
        Ok(())
    }
    pub fn replace(
        &self,
        directory: &PrivateDirectory,
        name: &str,
        bytes: &[u8],
        maximum: u64,
    ) -> Result<()> {
        ensure!(
            bytes.len() as u64 <= maximum,
            "external_history_payload_budget_exceeded"
        );
        self.publish(
            directory,
            name,
            &mut std::io::Cursor::new(bytes),
            true,
            || true,
        )?;
        Ok(())
    }
    pub fn seal(
        &self,
        directory: &PrivateDirectory,
        mut check: impl FnMut() -> bool,
    ) -> Result<()> {
        let _lease = self.lock()?;
        let mut node = self.read()?;
        let files = self.selected_files(directory, &node, &mut check)?;
        let seal = hash(&files)?;
        if let Some(prior) = &node.seal {
            ensure!(*prior == seal, "external_history_payload_changed");
            return Ok(());
        }
        node.files = files
            .into_iter()
            .map(|(name, proof)| (name, vec![proof]))
            .collect();
        node.seal = Some(seal);
        self.save(&mut node)
    }
}
