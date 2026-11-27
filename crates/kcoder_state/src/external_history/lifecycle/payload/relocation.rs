//! Register original payload nodes and plans without running publication or GC recovery.
use super::*;
use crate::history_storage_relocation::graph::OwnerGraph;

pub(in crate::external_history::lifecycle) fn collect(
    tree: &PrivateDirectory,
    path: &[String],
    allow_removed: bool,
    raw: Option<(&PrivateDirectory, Vec<String>)>,
    graph: &mut OwnerGraph,
) -> Result<()> {
    let header: Header = load(tree, "owner.json", META)?;
    ensure!(
        header.version == 1
            && tree.history_matches_directory(&header.directory)?
            && tree.history_regular_matches(OsStr::new("tree.lock"), &header.lease)?,
        "external_history_payload_changed"
    );
    let mut files = vec!["owner.json".to_owned(), "tree.lock".to_owned()];
    tree.visit_entry_names_bounded(MAX_NODES * 3 + 100, |name| {
        let Some(name) = name.to_str() else {
            return Ok(());
        };
        if name.starts_with("node-") && name.ends_with(".json") {
            let node: Node = load(tree, name, META)?;
            node.validate(&header, &node.path)?;
            ensure!(
                name == format!("{}.json", node_key(&node.path)),
                "external_history_payload_changed"
            );
            files.push(name.into());
            files.push(format!("{}.lock", node_key(&node.path)));
            if let Some((raw, raw_path)) = &raw {
                let mut actual = raw.duplicate_handle()?;
                let mut actual_path = raw_path.clone();
                for (index, part) in node.path.split('/').enumerate() {
                    let logical = node
                        .path
                        .split('/')
                        .take(index + 1)
                        .collect::<Vec<_>>()
                        .join("/");
                    let parent_node = if logical == node.path {
                        node.clone()
                    } else {
                        load::<Node>(tree, &format!("{}.json", node_key(&logical)), META)?
                    };
                    let name = match actual.open_child(OsStr::new(part), false) {
                        Ok(_) => part.to_owned(),
                        Err(error) if !parent_node.published && missing(&error) => {
                            parent_node.staging.clone()
                        }
                        Err(error) if missing(&error) => return Ok(()),
                        Err(error) => return Err(error),
                    };
                    ensure!(
                        actual.history_matches_child_directory(
                            OsStr::new(&name),
                            &parent_node.directory
                        )?,
                        "external_history_payload_changed"
                    );
                    actual = actual.open_child(OsStr::new(&name), false)?;
                    actual_path.push(name);
                }
                for (name, identity) in &node.controls {
                    if allow_removed {
                        match actual.open_single_link_regular_file(OsStr::new(name)) {
                            Err(error) if missing(&error) => continue,
                            Err(error) => return Err(error),
                            Ok(_) => (),
                        }
                    }
                    ensure!(
                        actual.history_regular_matches(OsStr::new(name), identity)?,
                        "external_history_payload_control_changed"
                    );
                }
                graph.add_directory(
                    actual_path,
                    &actual,
                    node.controls.keys().chain(node.files.keys()).cloned(),
                )?;
            }
        }
        Ok(())
    })?;
    graph.add_directory(path.to_vec(), tree, files)
}
