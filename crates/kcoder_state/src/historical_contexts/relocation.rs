//! Preparations retain their original owner/source binding and immutable seals.
use super::*;
use crate::history_storage_relocation::graph::OwnerGraph;

pub(crate) fn collect(profile: &PrivateDirectory, graph: &mut OwnerGraph) -> Result<()> {
    let directory = match profile.open_child(OsStr::new("historical-contexts"), false) {
        Ok(directory) => directory,
        Err(error) if missing(&error) => return Ok(()),
        Err(error) => return Err(error),
    };
    directory.verify_private_directory()?;
    let owner: Owner = read_json(&directory, "owner.json", META)?;
    ensure!(
        owner.version == 1
            && owner.profile == directory.history_profile_seed(profile)?
            && directory.history_matches_directory(&owner.directory)?,
        "history_context_store_owner_changed"
    );
    let base = vec!["historical-contexts".to_owned()];
    graph.add(&base, &directory, &["owner.json", "catalog.lock"])?;
    let store = HistoricalContextStore {
        directory: directory.duplicate_handle()?,
        owner,
        path: PathBuf::new(),
    };
    directory.visit_entry_names_bounded(MAX_CONTEXT_PREPARATIONS + 3, |name| {
        if name == OsStr::new("owner.json")
            || name == OsStr::new("catalog.lock")
            || directory.history_relocation_entry(name)?
        {
            return Ok(());
        }
        let Some(id) = name.to_str().filter(|id| check_id(id).is_ok()) else {
            return Ok(());
        };
        let prepared = directory.open_child(name, false)?;
        let intent = store.intent(&prepared, id)?;
        let mut path = base.clone();
        path.push(id.into());
        let mut names = vec![
            "intent.json".to_owned(),
            "document.json".into(),
            "binding.json".into(),
            "receipt.json".into(),
            "source-reference.json".into(),
            "source-retired.json".into(),
        ];
        if let Some(body) = optional(&prepared, "document.json", HISTORICAL_CONTEXT_MAX_BYTES)? {
            ensure!(
                hash(&body) == intent.document_sha256,
                "history_context_preparation_content_changed"
            );
            let document: HistoricalContextDocument = serde_json::from_slice(&body)?;
            ensure!(
                document.attachments.len() <= 1024,
                "history_context_preparation_asset_receipt_changed"
            );
            for (index, attachment) in document.attachments.iter().enumerate() {
                names.push(payload_for(index as u32, attachment, intent.delivery_names));
                names.push(asset(index as u32));
            }
            if optional(&prepared, "receipt.json", META)?.is_some() {
                store.metadata(id)?;
            }
        }
        graph.add_directory(path, &prepared, names)
    })
}
