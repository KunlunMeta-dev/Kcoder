//! Metadata-only observations tied to the original held instance lease.
use super::*;
use anyhow::Context;
use std::path::Component;

// The existing offline protocol admits at most 128 owners, each with five
// Relay metadata paths. Bound live descriptors without reducing that contract.
pub(super) const MAX_OBSERVATIONS: usize = 128 * 5;

pub(super) struct Observation {
    relative: PathBuf,
    parent: PrivateDirectory,
    entry: Entry,
    expected: String,
}

enum Entry {
    Directory(PrivateDirectory),
    File(File),
}

fn parent(root: &PrivateDirectory, relative: &Path) -> Result<PrivateDirectory> {
    let parts = relative.components().collect::<Vec<_>>();
    ensure!(!parts.is_empty() && parts.len() <= 128, Fault::Argument);
    let mut current = root.duplicate_handle()?;
    for (index, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else {
            anyhow::bail!(Fault::Argument)
        };
        if index + 1 < parts.len() {
            current = current.open_child(name, false)?;
        }
    }
    Ok(current)
}

impl Observation {
    fn open(root: &PrivateDirectory, relative: &Path, kind: &str) -> Result<Self> {
        let parent = parent(root, relative)?;
        let name = relative.file_name().context(Fault::Argument)?;
        let entry = match kind {
            "directory" => Entry::Directory(parent.open_child(name, false)?),
            "file" => Entry::File(parent.open_regular_file(name)?),
            _ => anyhow::bail!(Fault::Argument),
        };
        let mut observation = Self {
            relative: relative.into(),
            parent,
            entry,
            expected: String::new(),
        };
        observation.expected = observation.current_facts()?;
        Ok(observation)
    }

    fn current_facts(&self) -> Result<String> {
        let (identity, links) = match &self.entry {
            Entry::Directory(directory) => (directory.portable_directory_handle_identity()?, None),
            Entry::File(file) => {
                let (identity, links) =
                    PortableLeaseIdentity::observe_regular_handle_metadata(file)?;
                (identity, Some(links.to_string()))
            }
        };
        // Keep native u64/128-bit values opaque to JavaScript Numbers.
        Ok(
            serde_json::json!({"identity":serde_json::to_string(&identity)?,"links":links})
                .to_string(),
        )
    }

    pub(super) fn verify(&self, root: &PrivateDirectory) -> Result<()> {
        let current = parent(root, &self.relative)?;
        ensure!(
            current.portable_directory_handle_identity()?
                == self.parent.portable_directory_handle_identity()?,
            Fault::Changed
        );
        let kind = match self.entry {
            Entry::Directory(_) => "directory",
            Entry::File(_) => "file",
        };
        let named = Self::open(root, &self.relative, kind)?;
        ensure!(
            named.expected == self.expected && self.current_facts()? == self.expected,
            Fault::Changed
        );
        Ok(())
    }
}

impl StorageLease {
    pub(crate) fn observe_entry(&mut self, relative: &Path, kind: &str) -> Result<String> {
        ensure!(
            self.name == "kcoder-storage-instances.lock",
            Fault::Argument
        );
        self.verify_lease()?;
        if let Some(observed) = self
            .observations
            .iter()
            .find(|entry| entry.relative == relative)
        {
            let existing = match observed.entry {
                Entry::Directory(_) => "directory",
                Entry::File(_) => "file",
            };
            ensure!(existing == kind, Fault::Argument);
            observed.verify(&self.directory)?;
            return Ok(observed.expected.clone());
        }
        ensure!(self.observations.len() < MAX_OBSERVATIONS, Fault::Argument);
        let observed = Observation::open(&self.directory, relative, kind)?;
        observed.verify(&self.directory)?;
        let facts = observed.expected.clone();
        self.observations.push(observed);
        self.verify_lease()?;
        Ok(facts)
    }
}
