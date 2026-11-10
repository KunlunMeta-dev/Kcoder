use super::*;
const PAYLOAD_NOT_YET_PUBLISHED: &str = "external_history_payload_not_yet_published";
fn open_tree(guard: &ArchiveReadGuard, create: bool) -> Result<Option<(PrivateDirectory, Header)>> {
    let store = guard.store()?;
    let mut catalog = if create {
        Catalog::open(&store.directory, false)?
    } else {
        Catalog::open_readonly(&store.directory)?
    }
    .context("external_history_lifecycle_missing")?;
    let (id, generation, raw) = guard.binding(&catalog.document.scope)?;
    let archive = catalog
        .document
        .archives
        .get(id)
        .context("external_history_lifecycle_changed")?
        .clone();
    ensure!(
        archive.generation == generation
            && archive.directory.as_deref() == Some(raw)
            && archive.phase == ArchivePhase::Active,
        "external_history_lifecycle_changed"
    );
    let control = catalog.directory.open_child(OsStr::new(id), false)?;
    let mut anchor = archive.payload_tree.clone();
    if anchor.is_none() {
        if !create {
            return Ok(None);
        }
        catalog.ensure_writer()?;
        match control.open_child(OsStr::new("payload-tree"), false) {
            Err(error) if missing(&error) => {}
            Err(error) => return Err(error),
            Ok(_) => anyhow::bail!("external_history_payload_ownership_unknown"),
        }
        let staging = format!("tree-birth-{}", uuid::Uuid::new_v4());
        let born = control.create_private_child(OsStr::new(&staging))?;
        let _writer = born
            .try_exclusive_lock(OsStr::new("tree.lock"))?
            .context("external_history_payload_busy")?;
        let value = PayloadAnchor {
            directory: born.directory_identity()?,
            staging,
            published: false,
            lease: born.portable_regular_identity(OsStr::new("tree.lock"))?,
        };
        let header = Header {
            version: 1,
            scope: catalog.document.scope.clone(),
            archive: id.into(),
            generation: generation.into(),
            directory: value.directory.clone(),
            lease: value.lease.clone(),
        };
        born.atomic_replace(OsStr::new("owner.json"), &encode(&header, META)?)?;
        catalog.document.archives.get_mut(id).unwrap().payload_tree = Some(value.clone());
        catalog.save()?;
        anchor = Some(value);
    }
    let anchor = anchor.unwrap();
    // A writer publishes the tree only after creating it; until then a reader
    // must not see it, and only a writer may run recovery on it.
    ensure!(create || anchor.published, PAYLOAD_NOT_YET_PUBLISHED);
    let directory = match control.open_child(OsStr::new("payload-tree"), false) {
        Ok(directory) => directory,
        Err(error) if create && !anchor.published && missing(&error) => {
            let born = control.open_child(OsStr::new(&anchor.staging), false)?;
            ensure!(
                born.directory_identity()? == anchor.directory,
                "external_history_payload_changed"
            );
            control.rename_no_replace(OsStr::new(&anchor.staging), OsStr::new("payload-tree"))?;
            born
        }
        Err(error) => return Err(error),
    };
    ensure!(
        directory.directory_identity()? == anchor.directory,
        "external_history_payload_changed"
    );
    directory.verify_private_directory()?;
    let header: Header = load(&directory, "owner.json", META)?;
    ensure!(
        header.version == 1
            && header.scope == catalog.document.scope
            && header.archive == archive.id
            && header.generation == archive.generation
            && header.directory == anchor.directory
            && header.lease == anchor.lease,
        "external_history_payload_changed"
    );
    if !anchor.published {
        ensure!(create, "external_history_payload_recovery_required");
        catalog.ensure_writer()?;
        catalog
            .document
            .archives
            .get_mut(id)
            .unwrap()
            .payload_tree
            .as_mut()
            .unwrap()
            .published = true;
        catalog.save()?;
    }
    Ok(Some((directory, header)))
}
fn optional_node(tree: &PrivateDirectory, header: &Header, path: &str) -> Result<Option<Node>> {
    let name = format!("{}.json", node_key(path));
    let node: Node = match load(tree, &name, META) {
        Ok(value) => value,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    node.validate(header, path)?;
    Ok(Some(node))
}
fn directory_for(
    reader: &ExternalHistoryReader,
    parent: &PrivateDirectory,
    path: &str,
    writable: bool,
) -> Result<Option<PayloadDirectory>> {
    valid_path(path)?;
    let name = path.rsplit('/').next().unwrap();
    let existing = match parent.open_child(OsStr::new(name), false) {
        Ok(directory) => Some(directory),
        Err(error) if missing(&error) => None,
        Err(error) => return Err(error),
    };
    if !reader.lifecycle.is_managed() {
        return match existing {
            Some(directory) => Ok(Some(PayloadDirectory {
                directory,
                node: None,
            })),
            None if !writable => Ok(None),
            None => Ok(Some(PayloadDirectory {
                directory: parent.create_private_child(OsStr::new(name))?,
                node: None,
            })),
        };
    }
    let opened = match open_tree(&reader.lifecycle, writable) {
        Err(error) if !writable && error.to_string() == PAYLOAD_NOT_YET_PUBLISHED => {
            return Ok(None);
        }
        opened => opened?,
    };
    let Some((tree, header)) = opened else {
        return Ok(existing.map(|directory| PayloadDirectory {
            directory,
            node: None,
        }));
    };
    let mut node = optional_node(&tree, &header, path)?;
    if node.is_none() && existing.is_some() {
        return Ok(existing.map(|directory| PayloadDirectory {
            directory,
            node: None,
        }));
    }
    if node.is_none() && !writable {
        return Ok(None);
    }
    if node.is_none() {
        let _catalog = tree
            .try_existing_portable_lock(
                OsStr::new("tree.lock"),
                &header.lease,
                PrivateLeaseMode::Exclusive,
            )?
            .context("external_history_payload_busy")?;
        node = optional_node(&tree, &header, path)?;
        if node.is_none() {
            let mut count = 0;
            tree.visit_entry_names_bounded(MAX_NODES * 2 + 4, |name| {
                if name
                    .to_str()
                    .is_some_and(|name| name.starts_with("node-") && name.ends_with(".json"))
                {
                    count += 1;
                }
                Ok(())
            })?;
            ensure!(
                count < MAX_NODES,
                "external_history_payload_count_budget_exceeded"
            );
            let staging = format!("payload-birth-{}", uuid::Uuid::new_v4());
            let born = parent.create_private_child(OsStr::new(&staging))?;
            let key = node_key(path);
            let lock_name = format!("{key}.lock");
            let _node_lock = tree
                .try_exclusive_lock(OsStr::new(&lock_name))?
                .context("external_history_payload_busy")?;
            let mut value = Node {
                version: 1,
                scope: header.scope.clone(),
                archive: header.archive.clone(),
                generation: header.generation.clone(),
                path: path.into(),
                directory: born.directory_identity()?,
                staging,
                published: false,
                lease: tree.portable_regular_identity(OsStr::new(&lock_name))?,
                controls: BTreeMap::new(),
                files: BTreeMap::new(),
                restored_metadata: Vec::new(),
                seal: None,
                sequence: 0,
            };
            for control in controls(path) {
                let lock = born
                    .try_exclusive_lock(OsStr::new(control))?
                    .context("external_history_payload_busy")?;
                let identity = born.portable_regular_handle_identity(&lock)?;
                let mut proof = file_digest(&born, &lock, &mut || true)?;
                proof.name = (*control).into();
                value.controls.insert((*control).into(), identity);
                value.files.insert((*control).into(), vec![proof]);
            }
            tree.atomic_replace(OsStr::new(&format!("{key}.json")), &encode(&value, META)?)?;
            node = Some(value);
        }
    }
    let mut node = node.unwrap();
    if !writable && !node.published {
        // Still being born by its writer: absent to a reader.
        return Ok(None);
    }
    let key = node_key(path);
    let _guard = if writable {
        Some(
            tree.try_existing_portable_lock(
                OsStr::new(&format!("{key}.lock")),
                &node.lease,
                PrivateLeaseMode::Exclusive,
            )?
            .context("external_history_payload_busy")?,
        )
    } else {
        None
    };
    let directory = match parent.open_child(OsStr::new(name), false) {
        Ok(directory) => directory,
        Err(error) if writable && !node.published && missing(&error) => {
            let born = parent.open_child(OsStr::new(&node.staging), false)?;
            ensure!(
                born.directory_identity()? == node.directory,
                "external_history_payload_changed"
            );
            parent.rename_no_replace(OsStr::new(&node.staging), OsStr::new(name))?;
            born
        }
        Err(error) => return Err(error),
    };
    ensure!(
        directory.directory_identity()? == node.directory,
        "external_history_payload_changed"
    );
    directory.verify_private_directory()?;
    if !node.published {
        ensure!(writable, "external_history_payload_recovery_required");
        node.published = true;
        tree.atomic_replace(OsStr::new(&format!("{key}.json")), &encode(&node, META)?)?;
    }
    let directory_identity = node.directory.clone();
    let owner = PayloadNode {
        _guard: reader.lifecycle.clone(),
        tree,
        header,
        key,
        path: path.into(),
        directory: directory_identity,
        lease: node.lease,
    };
    owner.verify_controls(&directory, &node.controls)?;
    Ok(Some(PayloadDirectory {
        directory,
        node: Some(owner),
    }))
}
impl ExternalHistoryReader {
    pub(crate) fn payload_root(
        &self,
        family: &str,
        writable: bool,
    ) -> Result<Option<PayloadDirectory>> {
        ensure!(
            matches!(family, "attachments-v1" | "local-attachments-v1"),
            "external_history_payload_invalid_path"
        );
        directory_for(self, &self.directory, family, writable)
    }
    pub(crate) fn payload_child(
        &self,
        parent: &PayloadDirectory,
        name: &str,
        writable: bool,
    ) -> Result<Option<PayloadDirectory>> {
        let Some(owner) = &parent.node else {
            return match parent.directory.open_child(OsStr::new(name), writable) {
                Ok(directory) => Ok(Some(PayloadDirectory {
                    directory,
                    node: None,
                })),
                Err(error) if !writable && missing(&error) => Ok(None),
                Err(error) => Err(error),
            };
        };
        ensure!(
            !owner.path.contains('/'),
            "external_history_payload_invalid_path"
        );
        directory_for(
            self,
            &parent.directory,
            &format!("{}/{}", owner.path, name),
            writable,
        )
    }
}
impl PayloadNode {
    pub(super) fn verify_controls(
        &self,
        directory: &PrivateDirectory,
        controls: &BTreeMap<String, PortableLeaseIdentity>,
    ) -> Result<()> {
        ensure!(
            directory.directory_identity()? == self.directory,
            "external_history_payload_changed"
        );
        for (name, identity) in controls {
            ensure!(
                directory.portable_regular_identity(OsStr::new(name))? == *identity,
                "external_history_payload_control_changed"
            );
        }
        Ok(())
    }
    pub(super) fn read(&self) -> Result<Node> {
        ensure!(
            self.tree.directory_identity()? == self.header.directory,
            "external_history_payload_changed"
        );
        let node = optional_node(&self.tree, &self.header, &self.path)?
            .context("external_history_payload_changed")?;
        ensure!(
            node.directory == self.directory && node.lease == self.lease && node.published,
            "external_history_payload_changed"
        );
        Ok(node)
    }
    pub(super) fn lock(&self) -> Result<VerifiedPrivateLease> {
        self.tree
            .try_existing_portable_lock(
                OsStr::new(&format!("{}.lock", self.key)),
                &self.lease,
                PrivateLeaseMode::Exclusive,
            )?
            .context("external_history_payload_busy")
    }
    pub(super) fn save(&self, node: &mut Node) -> Result<()> {
        node.sequence = node
            .sequence
            .checked_add(1)
            .context("external_history_lifecycle_sequence_exhausted")?;
        node.validate(&self.header, &self.path)?;
        self.tree.atomic_replace(
            OsStr::new(&format!("{}.json", self.key)),
            &encode(node, META)?,
        )
    }
    pub fn lock_control(&self, directory: &PrivateDirectory, name: &str) -> Result<PayloadLease> {
        let node = self.read()?;
        self.verify_controls(directory, &node.controls)?;
        let identity = node
            .controls
            .get(name)
            .context("external_history_payload_control_changed")?;
        Ok(PayloadLease::Managed(Box::new(
            directory
                .try_existing_portable_lock(
                    OsStr::new(name),
                    identity,
                    PrivateLeaseMode::Exclusive,
                )?
                .context("history_attachment_busy")?,
        )))
    }
}
