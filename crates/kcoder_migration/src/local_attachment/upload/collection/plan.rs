use super::*;
impl Operation<'_> {
    fn registered_temporary(&self, parent: &str, name: &str) -> Result<bool> {
        if !name.starts_with('.') || canonical_leaf(name).is_none() {
            return Ok(false);
        }
        let logical = if parent.is_empty() {
            logical_name(name)?
        } else {
            logical_name(&format!("{parent}/{name}"))?
        };
        Ok(self.file_proofs(&logical)?.is_some_and(|proofs| {
            proofs
                .values
                .iter()
                .any(|proof| proof.temporary_name == name)
        }))
    }
    fn collection_inventory(&self) -> Result<Vec<String>> {
        let mut names = Vec::new();
        self.clean_assembly_with(|name| {
            let name = name
                .to_str()
                .context("local_upload_collection_unknown_entry")?;
            if self.registered_temporary("", name)? {
                names.push(name.into());
                Ok(true)
            } else {
                Ok(false)
            }
        })?;
        match self
            .directory
            .open_single_link_regular_file(OsStr::new("payload.bin"))
        {
            Ok(_) => names.push("payload.bin".into()),
            Err(error) if missing(&error) => {}
            Err(error) => return Err(error),
        }
        let manifest = self.manifest()?;
        let parts = self.parts_dir()?;
        parts.visit_entry_names_bounded(MAX_FILES * 5 + 1, |name| {
            let name = name
                .to_str()
                .context("local_upload_collection_unknown_entry")?;
            if self.registered_temporary("parts", name)? {
                names.push(format!("parts/{name}"));
                return Ok(());
            }
            let valid = [".bin", ".intent.json", ".receipt.json", ".bin.proof.json"]
                .iter()
                .any(|suffix| {
                    name.strip_prefix("part-")
                        .and_then(|name| name.strip_suffix(suffix))
                        .is_some_and(|index| {
                            index.len() == 4
                                && index.parse::<u32>().is_ok_and(|index| {
                                    manifest
                                        .as_ref()
                                        .is_some_and(|manifest| index < parts::count(manifest))
                                })
                        })
                });
            ensure!(valid, "local_upload_collection_unknown_entry");
            if name.ends_with(".bin") {
                names.push(format!("parts/{name}"));
            }
            Ok(())
        })?;
        Ok(names)
    }
    pub(super) fn capture_collection_plan(
        &self,
        sequence: u64,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<Plan> {
        self.collection_birth()?;
        let manifest = self.manifest()?;
        let mut names = self.collection_inventory()?;
        ensure!(
            names.len() <= MAX_FILES,
            "local_upload_collection_budget_exceeded"
        );
        names.sort();
        let mut leaves = Vec::new();
        let mut bytes = 0u64;
        for name in names {
            ensure!(check(bytes), "local_upload_collection_cancelled");
            let proof = self.verify_owned_file(&name, &mut |value| check(bytes + value))?;
            bytes = bytes
                .checked_add(proof.bytes)
                .context("local_upload_collection_budget_exceeded")?;
            leaves.push(Leaf { name, proof });
        }
        let logical = leaves
            .iter()
            .map(|leaf| logical_name(&leaf.name))
            .collect::<Result<std::collections::BTreeSet<_>>>()?;
        // A published receipt without its original data is not a never-written reservation.
        // Missing data is only reconcilable after the original deletion intent exists.
        if let Some(manifest) = &manifest {
            let parts = self.parts_dir()?;
            for index in 0..parts::count(manifest) {
                let intent = load::<Part>(&parts, &format!("part-{index:04}.intent.json"))?;
                if let Some(intent) = &intent {
                    ensure!(
                        intent.index == index
                            && intent.manifest == hash(manifest)?
                            && intent.bytes == parts::expected_size(manifest, index)?
                            && valid_sha(&intent.sha256),
                        "local_upload_collection_metadata_changed"
                    );
                }
                let receipt =
                    load::<PartReceipt>(&parts, &format!("part-{index:04}.receipt.json"))?;
                if let Some(receipt) = &receipt {
                    ensure!(
                        intent.as_ref() == Some(&receipt.part),
                        "local_upload_collection_metadata_changed"
                    );
                }
                let canonical = format!("parts/part-{index:04}.bin");
                if load::<PartReceipt>(&parts, &format!("part-{index:04}.receipt.json"))?.is_some()
                {
                    ensure!(
                        leaves.iter().any(|leaf| leaf.name == canonical),
                        "local_upload_collection_missing_owned_data"
                    );
                } else if self.file_proofs(&canonical)?.is_some() {
                    ensure!(
                        logical.contains(&canonical),
                        "local_upload_collection_missing_owned_data"
                    );
                }
            }
        }
        if load::<Assembled>(&self.directory, "assembled.json")?.is_some() {
            ensure!(
                leaves.iter().any(|leaf| leaf.name == "payload.bin"),
                "local_upload_collection_missing_owned_data"
            );
        }
        if self.file_proofs("payload.bin")?.is_some() {
            ensure!(
                logical.contains("payload.bin"),
                "local_upload_collection_missing_owned_data"
            );
        }
        ensure!(
            bytes <= manifest.as_ref().map_or(0, |manifest| manifest.bytes * 2),
            "local_upload_collection_budget_exceeded"
        );
        Ok(Plan {
            version: 1,
            binding: self.collection_binding()?,
            collection_id: self.collection_id()?,
            upload_sequence: sequence,
            manifest: manifest.as_ref().map(hash).transpose()?,
            reserved_bytes: manifest.as_ref().map_or(0, |manifest| manifest.bytes * 2),
            leaves,
        })
    }
    pub(super) fn load_collection_plan(&self, record: &Record) -> Result<Plan> {
        let digest = record
            .plan
            .as_ref()
            .context("local_upload_collection_plan_missing")?;
        let plan: Plan = read_json(
            &self.directory,
            &format!("collection-plan-{digest}.json"),
            PLAN_BYTES,
        )?
        .context("local_upload_collection_plan_missing")?;
        ensure!(
            plan.version == 1
                && plan.binding == record.binding
                && plan.collection_id == record.collection_id
                && plan.upload_sequence == record.upload_sequence
                && plan.leaves.len() <= MAX_FILES
                && plan.manifest == self.manifest()?.as_ref().map(hash).transpose()?
                && plan.reserved_bytes == self.manifest()?.map_or(0, |value| value.bytes * 2)
                && record.plan.as_deref() == Some(hash(&plan)?.as_str()),
            "local_upload_collection_plan_changed"
        );
        let mut previous = None;
        for leaf in &plan.leaves {
            slot(&leaf.name)?;
            ensure!(
                previous.is_none_or(|name: &str| name < leaf.name.as_str())
                    && leaf.proof.bytes <= HISTORICAL_LOCAL_UPLOAD_MAX_BYTES
                    && valid_sha(&leaf.proof.sha256),
                "local_upload_collection_plan_changed"
            );
            previous = Some(leaf.name.as_str());
        }
        ensure!(
            record
                .removed
                .iter()
                .all(|name| plan.leaves.iter().any(|leaf| &leaf.name == name)),
            "local_upload_collection_plan_changed"
        );
        let removed_bytes = plan
            .leaves
            .iter()
            .filter(|leaf| record.removed.contains(&leaf.name))
            .map(|leaf| leaf.proof.bytes)
            .sum::<u64>();
        ensure!(
            record.deleted_bytes == removed_bytes
                && plan.leaves.iter().map(|leaf| leaf.proof.bytes).sum::<u64>()
                    <= plan.reserved_bytes,
            "local_upload_collection_progress_changed"
        );
        ensure!(
            record
                .pending
                .as_ref()
                .is_none_or(|name| plan.leaves.iter().any(|leaf| &leaf.name == name)),
            "local_upload_collection_pending_changed"
        );
        Ok(plan)
    }
    pub(super) fn verify_remaining_collection(
        &self,
        plan: &Plan,
        record: &Record,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<()> {
        for name in self.collection_inventory()? {
            ensure!(
                plan.leaves.iter().any(|leaf| leaf.name == name),
                "local_upload_collection_unknown_entry"
            );
        }
        let mut total = 0;
        for leaf in &plan.leaves {
            ensure!(check(total), "local_upload_collection_cancelled");
            let (parent, name) = self.target_directory(&leaf.name)?;
            if record.removed.contains(&leaf.name) {
                match parent.open_single_link_regular_file(OsStr::new(&name)) {
                    Err(error) if missing(&error) => {}
                    Err(error) => return Err(error),
                    Ok(_) => anyhow::bail!("local_upload_collection_removed_name_reoccupied"),
                }
            } else {
                let proof =
                    self.verify_owned_file(&leaf.name, &mut |bytes| check(total + bytes))?;
                ensure!(
                    proof == leaf.proof,
                    "local_upload_collection_content_changed"
                );
                total += proof.bytes;
            }
        }
        Ok(())
    }
}
