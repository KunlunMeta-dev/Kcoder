//! Collection snapshots use only original node births and pre-publication file proofs.
use super::*;
use serde::{Deserialize, Serialize};
const PLAN_META: usize = 64 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PlannedNode {
    pub logical: String,
    pub actual: String,
    pub source_sha256: String,
    pub manifest: gc::Manifest,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::external_history::lifecycle) struct PayloadPlanAnchor {
    pub generation: String,
    pub directory: String,
    pub digest: String,
    pub nodes: u32,
    pub metadata_bytes: u64,
    pub published: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanHeader {
    version: u8,
    scope: String,
    archive: String,
    generation: String,
    operation: String,
    directory: String,
    tree: String,
    digest: String,
    nodes: u32,
    metadata_bytes: u64,
}
pub(in crate::external_history::lifecycle) struct PayloadSnapshot {
    tree: PrivateDirectory,
    header: Header,
    nodes: Vec<PlannedNode>,
    metadata_bytes: u64,
    digest: String,
    _lease: VerifiedPrivateLease,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeProgress {
    version: u8,
    plan: String,
    position: u32,
    removed: Vec<String>,
    pending: Option<String>,
    directory_removed: bool,
}
pub(in crate::external_history::lifecycle) struct PayloadCollection {
    _tree: PrivateDirectory,
    directory: PrivateDirectory,
    header: PlanHeader,
    nodes: Vec<PlannedNode>,
    roots: BTreeMap<String, gc::Manifest>,
    _lease: VerifiedPrivateLease,
}
fn plan_name(operation: &str, generation: &str) -> String {
    format!(
        "retirement-{}-{generation}",
        crate::external_history::hash(operation.as_bytes())
    )
}
fn open_relative(raw: &PrivateDirectory, path: &str) -> Result<PrivateDirectory> {
    let parts = path.split('/').collect::<Vec<_>>();
    ensure!(
        (1..=2).contains(&parts.len()),
        "external_history_payload_invalid_path"
    );
    for part in &parts {
        ensure!(
            !part.is_empty()
                && !matches!(*part, "." | "..")
                && !part.contains('\\')
                && part.len() <= 128,
            "external_history_payload_invalid_path"
        );
    }
    let mut directory = raw.open_child(OsStr::new(parts[0]), false)?;
    if parts.len() == 2 {
        directory = directory.open_child(OsStr::new(parts[1]), false)?;
    }
    Ok(directory)
}
fn actual_name(parent: &PrivateDirectory, node: &Node) -> Result<String> {
    let name = node.path.rsplit('/').next().unwrap();
    match parent.open_child(OsStr::new(name), false) {
        Ok(directory) => {
            ensure!(
                directory.directory_identity()? == node.directory,
                "external_history_payload_changed"
            );
            Ok(name.into())
        }
        Err(error) if !node.published && missing(&error) => {
            let born = parent.open_child(OsStr::new(&node.staging), false)?;
            ensure!(
                born.directory_identity()? == node.directory,
                "external_history_payload_changed"
            );
            Ok(node.staging.clone())
        }
        Err(error) => Err(error),
    }
}
#[cfg(any(target_os = "linux", windows))]
fn manifest(
    directory: &PrivateDirectory,
    node: &Node,
    children: &[String],
    check: &mut impl FnMut() -> bool,
) -> Result<gc::Manifest> {
    let mut leaves = Vec::new();
    directory.visit_entry_names_bounded(children.len() + 7, |name| {
        ensure!(check(), "external_history_lifecycle_cancelled");
        let name = name
            .to_str()
            .context("external_history_payload_unknown_entry")?;
        if children.iter().any(|child| child == name) {
            directory.open_child(OsStr::new(name), false)?;
            return Ok(());
        }
        let versions = node
            .files
            .get(name)
            .context("external_history_payload_unknown_entry")?;
        let file = directory.open_single_link_regular_file(OsStr::new(name))?;
        let actual = file_digest(directory, &file, check)?;
        let expected = versions
            .iter()
            .find(|proof| proof.identity == actual.identity)
            .context("external_history_payload_changed")?;
        ensure!(
            actual.bytes == expected.bytes && actual.sha256 == expected.sha256,
            "external_history_payload_changed"
        );
        let identity = directory.portable_retention_regular_handle_identity(&file)?;
        leaves.push(gc::Leaf {
            name: name.into(),
            identity,
            bytes: actual.bytes,
            sha256: actual.sha256,
        });
        Ok(())
    })?;
    ensure!(
        node.files
            .keys()
            .all(|name| leaves.iter().any(|leaf| &leaf.name == name)),
        "external_history_payload_publication_unknown"
    );
    leaves.sort_by(|left, right| left.name.cmp(&right.name));
    let manifest = gc::Manifest {
        directory: directory.portable_retention_identity()?,
        leaves,
    };
    manifest.validate()?;
    Ok(manifest)
}
#[cfg(not(any(target_os = "linux", windows)))]
fn manifest(
    _directory: &PrivateDirectory,
    _node: &Node,
    _children: &[String],
    _check: &mut impl FnMut() -> bool,
) -> Result<gc::Manifest> {
    anyhow::bail!("external_history_payload_gc_unsupported")
}
pub(in crate::external_history::lifecycle) fn snapshot(
    control: &PrivateDirectory,
    archive: &Archive,
    scope: &str,
    raw: &PrivateDirectory,
    check: &mut impl FnMut() -> bool,
) -> Result<Option<PayloadSnapshot>> {
    let Some(anchor) = &archive.payload_tree else {
        return Ok(None);
    };
    let tree = match control.open_child(OsStr::new("payload-tree"), false) {
        Ok(tree) => tree,
        Err(error) if !anchor.published && missing(&error) => {
            control.open_child(OsStr::new(&anchor.staging), false)?
        }
        Err(error) => return Err(error),
    };
    ensure!(
        tree.directory_identity()? == anchor.directory,
        "external_history_payload_changed"
    );
    let header: Header = load(&tree, "owner.json", META)?;
    ensure!(
        header.version == 1
            && header.scope == scope
            && header.archive == archive.id
            && header.generation == archive.generation
            && header.directory == anchor.directory
            && header.lease == anchor.lease,
        "external_history_payload_changed"
    );
    let lease = tree
        .try_existing_portable_lock(
            OsStr::new("tree.lock"),
            &header.lease,
            PrivateLeaseMode::Exclusive,
        )?
        .context("external_history_payload_busy")?;
    let mut records = BTreeMap::new();
    let mut metadata = 0;
    tree.visit_entry_names_bounded(MAX_NODES * 2 + 40, |name| {
        ensure!(check(), "external_history_lifecycle_cancelled");
        let Some(name) = name.to_str() else {
            anyhow::bail!("external_history_payload_unknown_entry")
        };
        if !name.starts_with("node-") || !name.ends_with(".json") {
            return Ok(());
        }
        let value: Node = load(&tree, name, META)?;
        value.validate(&header, &value.path)?;
        ensure!(
            name == format!("{}.json", node_key(&value.path)) && !records.contains_key(&value.path),
            "external_history_payload_changed"
        );
        metadata += encode(&value, META)?.len();
        ensure!(
            records.len() < MAX_NODES && metadata <= PLAN_META,
            "external_history_payload_metadata_budget_exceeded"
        );
        records.insert(value.path.clone(), value);
        Ok(())
    })?;
    let mut actual = BTreeMap::new();
    for family in ["attachments-v1", "local-attachments-v1"] {
        if let Some(node) = records.get(family) {
            actual.insert(family.to_owned(), actual_name(raw, node)?);
        }
    }
    for (path, node) in &records {
        if let Some((family, _)) = path.split_once('/') {
            let root = actual
                .get(family)
                .context("external_history_payload_changed")?;
            let parent = raw.open_child(OsStr::new(root), false)?;
            actual.insert(
                path.clone(),
                format!("{root}/{}", actual_name(&parent, node)?),
            );
        }
    }
    let mut plans = Vec::new();
    let mut bytes = 0;
    for (path, node) in &records {
        ensure!(check(), "external_history_lifecycle_cancelled");
        let actual_path = actual
            .get(path)
            .context("external_history_payload_changed")?;
        let directory = open_relative(raw, actual_path)?;
        ensure!(
            directory.directory_identity()? == node.directory,
            "external_history_payload_changed"
        );
        let children = if path.contains('/') {
            Vec::new()
        } else {
            actual
                .iter()
                .filter_map(|(child, actual)| {
                    child
                        .strip_prefix(&format!("{path}/"))
                        .filter(|rest| !rest.contains('/'))
                        .map(|_| actual.rsplit('/').next().unwrap().to_owned())
                })
                .collect::<Vec<_>>()
        };
        let manifest = manifest(&directory, node, &children, check)?;
        let plan = PlannedNode {
            logical: path.clone(),
            actual: actual_path.clone(),
            source_sha256: hash(node)?,
            manifest,
        };
        bytes += encode(&plan, META)?.len();
        ensure!(
            bytes <= PLAN_META,
            "external_history_payload_metadata_budget_exceeded"
        );
        plans.push(plan);
    }
    plans.sort_by(|left, right| {
        right
            .actual
            .matches('/')
            .count()
            .cmp(&left.actual.matches('/').count())
            .then(left.actual.cmp(&right.actual))
    });
    let digest = plan_digest(&plans)?;
    Ok(Some(PayloadSnapshot {
        tree,
        header,
        nodes: plans,
        metadata_bytes: bytes as u64,
        digest,
        _lease: lease,
    }))
}
impl PayloadSnapshot {
    pub fn digest(&self) -> &str {
        &self.digest
    }
    pub fn metadata_bytes(&self) -> u64 {
        self.metadata_bytes
    }
    pub fn reserve(&self) -> Result<PayloadPlanAnchor> {
        let generation = uuid::Uuid::new_v4().to_string();
        let born = self
            .tree
            .create_private_child(OsStr::new(&format!("gc-birth-{generation}")))?;
        Ok(PayloadPlanAnchor {
            generation,
            directory: born.directory_identity()?,
            digest: self.digest.clone(),
            nodes: self.nodes.len() as u32,
            metadata_bytes: self.metadata_bytes,
            published: false,
        })
    }
    pub fn publish(
        self,
        operation: &str,
        anchor: &PayloadPlanAnchor,
        check: &mut impl FnMut() -> bool,
    ) -> Result<PayloadCollection> {
        ensure!(
            anchor.digest == self.digest
                && anchor.nodes as usize == self.nodes.len()
                && anchor.metadata_bytes == self.metadata_bytes,
            "external_history_payload_plan_changed"
        );
        let name = plan_name(operation, &anchor.generation);
        let directory = match self.tree.open_child(OsStr::new(&name), false) {
            Ok(directory) => directory,
            Err(error) if !anchor.published && missing(&error) => self.tree.open_child(
                OsStr::new(&format!("gc-birth-{}", anchor.generation)),
                false,
            )?,
            Err(error) => return Err(error),
        };
        ensure!(
            directory.directory_identity()? == anchor.directory,
            "external_history_payload_plan_changed"
        );
        let header = PlanHeader {
            version: 1,
            scope: self.header.scope.clone(),
            archive: self.header.archive.clone(),
            generation: self.header.generation.clone(),
            operation: operation.into(),
            directory: anchor.directory.clone(),
            tree: self.header.directory.clone(),
            digest: self.digest,
            nodes: anchor.nodes,
            metadata_bytes: anchor.metadata_bytes,
        };
        for (position, node) in self.nodes.iter().enumerate() {
            ensure!(check(), "external_history_lifecycle_cancelled");
            crate::external_history::publish_exact(
                &directory,
                &format!("entry-{position:05}.json"),
                &encode(node, META)?,
                META as u64,
            )?;
        }
        crate::external_history::publish_exact(
            &directory,
            "owner.json",
            &encode(&header, META)?,
            META as u64,
        )?;
        if !anchor.published {
            match self.tree.open_child(OsStr::new(&name), false) {
                Ok(named) => ensure!(
                    named.directory_identity()? == anchor.directory,
                    "external_history_payload_plan_changed"
                ),
                Err(error) if missing(&error) => self.tree.rename_no_replace(
                    OsStr::new(&format!("gc-birth-{}", anchor.generation)),
                    OsStr::new(&name),
                )?,
                Err(error) => return Err(error),
            }
        }
        let roots = self
            .nodes
            .iter()
            .filter(|node| !node.actual.contains('/'))
            .map(|node| (node.actual.clone(), node.manifest.clone()))
            .collect();
        Ok(PayloadCollection {
            _tree: self.tree,
            directory,
            header,
            nodes: self.nodes,
            roots,
            _lease: self._lease,
        })
    }
}
impl PayloadCollection {
    pub fn roots(&self) -> Result<Vec<String>> {
        let mut roots = Vec::new();
        for (position, node) in self.nodes.iter().enumerate() {
            if !node.actual.contains('/') && !self.progress(position, node)?.directory_removed {
                roots.push(node.actual.clone());
            }
        }
        Ok(roots)
    }
    fn progress(&self, position: usize, node: &PlannedNode) -> Result<NodeProgress> {
        let state = match load::<NodeProgress>(
            &self.directory,
            &format!("progress-{position:05}.json"),
            META,
        ) {
            Ok(state) => state,
            Err(error) if missing(&error) => NodeProgress {
                version: 1,
                plan: self.header.digest.clone(),
                position: position as u32,
                removed: Vec::new(),
                pending: None,
                directory_removed: false,
            },
            Err(error) => return Err(error),
        };
        ensure!(
            state.version == 1
                && state.plan == self.header.digest
                && state.position as usize == position
                && state.removed.len() <= node.manifest.leaves.len()
                && state.removed.windows(2).all(|pair| pair[0] < pair[1])
                && state.removed.iter().all(|name| node
                    .manifest
                    .leaves
                    .iter()
                    .any(|leaf| &leaf.name == name))
                && state.pending.as_ref().is_none_or(|name| name == "/"
                    || node.manifest.leaves.iter().any(|leaf| &leaf.name == name))
                && (!state.directory_removed
                    || state.pending.is_none()
                        && state.removed.len() == node.manifest.leaves.len()),
            "external_history_payload_progress_changed"
        );
        Ok(state)
    }
    fn save_progress(&self, state: &NodeProgress) -> Result<()> {
        self.directory.atomic_replace(
            OsStr::new(&format!("progress-{:05}.json", state.position)),
            &encode(state, META)?,
        )
    }
    fn parent(&self, raw: &PrivateDirectory, node: &PlannedNode) -> Result<PrivateDirectory> {
        if let Some((family, _)) = node.actual.split_once('/') {
            let parent = self
                .roots
                .get(family)
                .context("external_history_payload_plan_changed")?;
            raw.portable_open_verified_child(OsStr::new(family), &parent.directory)
        } else {
            raw.duplicate_handle()
        }
    }
    pub fn collect(
        &self,
        raw: &PrivateDirectory,
        check: &mut impl FnMut() -> bool,
        mut checkpoint: impl FnMut(u64, u32) -> Result<()>,
    ) -> Result<()> {
        let mut bytes = 0u64;
        let mut completed = 0u32;
        let mut last_checkpoint = std::time::Instant::now();
        let mut checkpoint_bytes = 0u64;
        for (position, node) in self.nodes.iter().enumerate() {
            ensure!(check(), "external_history_lifecycle_cancelled");
            let mut state = self.progress(position, node)?;
            if state.directory_removed {
                bytes += node
                    .manifest
                    .leaves
                    .iter()
                    .map(|leaf| leaf.bytes)
                    .sum::<u64>();
                completed += 1;
                continue;
            }
            let name = node.actual.rsplit('/').next().unwrap();
            let parent = self.parent(raw, node)?;
            let opened =
                parent.portable_open_verified_child(OsStr::new(name), &node.manifest.directory);
            let directory = match opened {
                Ok(directory) => directory,
                Err(error)
                    if missing(&error)
                        && state.pending.as_deref() == Some("/")
                        && state.removed.len() == node.manifest.leaves.len() =>
                {
                    state.directory_removed = true;
                    state.pending = None;
                    self.save_progress(&state)?;
                    bytes += node
                        .manifest
                        .leaves
                        .iter()
                        .map(|leaf| leaf.bytes)
                        .sum::<u64>();
                    completed += 1;
                    if bytes.saturating_sub(checkpoint_bytes) >= 1024 * 1024
                        || last_checkpoint.elapsed() >= std::time::Duration::from_millis(250)
                    {
                        checkpoint(bytes, completed)?;
                        checkpoint_bytes = bytes;
                        last_checkpoint = std::time::Instant::now();
                    }
                    continue;
                }
                Err(error) => return Err(error),
            };
            if let Some(pending) = state.pending.clone().filter(|name| name != "/") {
                match directory.open_single_link_regular_file(OsStr::new(&pending)) {
                    Err(error) if missing(&error) => {
                        if !state.removed.contains(&pending) {
                            state.removed.push(pending);
                            state.removed.sort();
                        }
                        state.pending = None;
                        self.save_progress(&state)?;
                    }
                    Err(error) => return Err(error),
                    Ok(_) => {}
                }
            }
            let mut children = Vec::new();
            if !node.actual.contains('/') {
                for (child_position, child) in self.nodes.iter().enumerate() {
                    if child
                        .actual
                        .strip_prefix(&format!("{}/", node.actual))
                        .is_some_and(|rest| !rest.contains('/'))
                        && !self.progress(child_position, child)?.directory_removed
                    {
                        children.push(child.actual.rsplit('/').next().unwrap().into());
                    }
                }
            }
            node.manifest.verify_remaining_with_children(
                &directory,
                &state.removed,
                &children,
                check,
            )?;
            ensure!(children.is_empty(), "external_history_payload_plan_changed");
            for leaf in &node.manifest.leaves {
                if state.removed.contains(&leaf.name) {
                    continue;
                }
                ensure!(check(), "external_history_lifecycle_cancelled");
                state.pending = Some(leaf.name.clone());
                self.save_progress(&state)?;
                let removed = directory.portable_remove_verified_regular_leaf(
                    OsStr::new(&leaf.name),
                    &leaf.identity,
                )?;
                if removed
                    .removed
                    .iter()
                    .any(|name| name == OsStr::new(&leaf.name))
                {
                    state.removed.push(leaf.name.clone());
                    state.removed.sort();
                    state.pending = None;
                    self.save_progress(&state)?;
                }
                if let Some(error) = removed.failure {
                    return Err(error);
                }
            }
            ensure!(check(), "external_history_lifecycle_cancelled");
            state.pending = Some("/".into());
            self.save_progress(&state)?;
            parent.portable_remove_verified_empty_directory(
                OsStr::new(name),
                &node.manifest.directory,
            )?;
            state.directory_removed = true;
            state.pending = None;
            self.save_progress(&state)?;
            bytes += node
                .manifest
                .leaves
                .iter()
                .map(|leaf| leaf.bytes)
                .sum::<u64>();
            completed += 1;
            if bytes.saturating_sub(checkpoint_bytes) >= 1024 * 1024
                || last_checkpoint.elapsed() >= std::time::Duration::from_millis(250)
            {
                checkpoint(bytes, completed)?;
                checkpoint_bytes = bytes;
                last_checkpoint = std::time::Instant::now();
            }
        }
        ensure!(
            completed == self.header.nodes,
            "external_history_payload_progress_changed"
        );
        checkpoint(bytes, completed)?;
        Ok(())
    }
    pub fn observed_progress(&self) -> Result<(u64, u32)> {
        let mut bytes = 0;
        let mut nodes = 0;
        for (position, node) in self.nodes.iter().enumerate() {
            if self.progress(position, node)?.directory_removed {
                bytes += node
                    .manifest
                    .leaves
                    .iter()
                    .map(|leaf| leaf.bytes)
                    .sum::<u64>();
                nodes += 1;
            }
        }
        Ok((bytes, nodes))
    }
}
pub(in crate::external_history::lifecycle) fn reopen(
    control: &PrivateDirectory,
    archive: &Archive,
    scope: &str,
    operation: &str,
    anchor: &PayloadPlanAnchor,
) -> Result<PayloadCollection> {
    let source = archive
        .payload_tree
        .as_ref()
        .context("external_history_payload_plan_changed")?;
    let tree = control.open_child(OsStr::new("payload-tree"), false)?;
    ensure!(
        tree.directory_identity()? == source.directory,
        "external_history_payload_plan_changed"
    );
    let owner: Header = load(&tree, "owner.json", META)?;
    ensure!(
        owner.version == 1
            && owner.scope == scope
            && owner.archive == archive.id
            && owner.generation == archive.generation
            && owner.directory == source.directory
            && owner.lease == source.lease,
        "external_history_payload_plan_changed"
    );
    let lease = tree
        .try_existing_portable_lock(
            OsStr::new("tree.lock"),
            &owner.lease,
            PrivateLeaseMode::Exclusive,
        )?
        .context("external_history_payload_busy")?;
    let directory =
        tree.open_child(OsStr::new(&plan_name(operation, &anchor.generation)), false)?;
    ensure!(
        directory.directory_identity()? == anchor.directory,
        "external_history_payload_plan_changed"
    );
    let header: PlanHeader = load(&directory, "owner.json", META)?;
    ensure!(
        header.version == 1
            && header.scope == scope
            && header.archive == archive.id
            && header.generation == archive.generation
            && header.operation == operation
            && header.directory == anchor.directory
            && header.tree == source.directory
            && header.digest == anchor.digest
            && header.nodes == anchor.nodes
            && header.nodes as usize <= MAX_NODES
            && header.metadata_bytes == anchor.metadata_bytes
            && header.metadata_bytes <= PLAN_META as u64,
        "external_history_payload_plan_changed"
    );
    let mut nodes = Vec::new();
    let mut bytes = 0;
    for position in 0..header.nodes {
        let node: PlannedNode = load(&directory, &format!("entry-{position:05}.json"), META)?;
        valid_path(&node.logical)?;
        node.manifest.validate()?;
        ensure!(
            valid_hash(&node.source_sha256)
                && node.actual.split('/').count() == node.logical.split('/').count()
                && node.actual.len() <= 256,
            "external_history_payload_plan_changed"
        );
        bytes += encode(&node, META)?.len();
        ensure!(
            bytes <= PLAN_META,
            "external_history_payload_metadata_budget_exceeded"
        );
        nodes.push(node);
    }
    ensure!(
        bytes as u64 == header.metadata_bytes && plan_digest(&nodes)? == anchor.digest,
        "external_history_payload_plan_changed"
    );
    let roots = nodes
        .iter()
        .filter(|node| !node.actual.contains('/'))
        .map(|node| (node.actual.clone(), node.manifest.clone()))
        .collect();
    Ok(PayloadCollection {
        _tree: tree,
        directory,
        header,
        nodes,
        roots,
        _lease: lease,
    })
}
fn plan_digest(nodes: &[PlannedNode]) -> Result<String> {
    struct HashWriter {
        hash: Sha256,
        bytes: usize,
    }
    impl std::io::Write for HashWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > PLAN_META.saturating_sub(self.bytes) {
                return Err(std::io::Error::other(
                    "external_history_payload_metadata_budget_exceeded",
                ));
            }
            self.bytes += bytes.len();
            self.hash.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = HashWriter {
        hash: Sha256::new(),
        bytes: 0,
    };
    serde_json::to_writer(&mut writer, nodes)
        .map_err(|_| anyhow::anyhow!("external_history_payload_metadata_budget_exceeded"))?;
    Ok(format!("{:x}", writer.hash.finalize()))
}
