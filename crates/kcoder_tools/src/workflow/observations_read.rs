//! Passive observation does not reconcile, resume, acquire a run lease or write.
use super::*;

pub fn observe_read(root: PathBuf, id: &str) -> Result<WorkflowRunSnapshot> {
    let directory = PrivateDirectory::open_existing(&root)?;
    directory.verify_private_directory()?;
    let name = name(id);
    let identity = directory.portable_regular_identity(OsStr::new(&name))?;
    let result = read_record(&directory, id)?;
    ensure!(
        directory.portable_regular_identity(OsStr::new(&name))? == identity,
        "workflow_observation_changed: record changed while reading"
    );
    Ok(result)
}

pub fn observe_list(root: PathBuf) -> Result<Vec<WorkflowRunSnapshot>> {
    let directory = match PrivateDirectory::open_existing(&root) {
        Ok(directory) => directory,
        Err(error) if user_controls::missing(&error) => return Ok(vec![]),
        Err(error) => return Err(error),
    };
    directory.verify_private_directory()?;
    let mut names = vec![];
    directory.visit_regular_files(
        |name| name.to_string_lossy().ends_with(".json"),
        |name, _| {
            ensure!(
                names.len() < MAX_RUNS,
                "workflow_quota: too many observations"
            );
            names.push(name.to_os_string());
            Ok(())
        },
    )?;
    let mut records = vec![];
    for name in names {
        let name = name
            .to_str()
            .context("workflow_corrupt: observation name")?;
        let id = name
            .strip_suffix(".json")
            .context("workflow_corrupt: observation suffix")?;
        records.push(observe_read(root.clone(), id)?);
    }
    records.sort_by(|a, b| {
        b.updated_at_ms
            .cmp(&a.updated_at_ms)
            .then(a.run_id.cmp(&b.run_id))
    });
    Ok(records)
}
