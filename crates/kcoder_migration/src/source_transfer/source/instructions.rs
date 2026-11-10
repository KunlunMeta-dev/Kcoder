//! Original private source proof and portable graph payload are separate immutable artifacts.
use super::*;
use crate::instruction_sources::{
    InstructionSourceSeed, InstructionSourceSnapshot,
    portable::{self, GRAPH_PARSER, PortableInstructionGraph},
};
use std::sync::Arc;
use zeroize::Zeroizing;
const MAX_ORIGIN_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone)]
pub struct InstructionExportSelection {
    snapshot: Option<Arc<InstructionSourceSnapshot>>,
    binding: InstructionExportBinding,
}
/// Private source intent metadata; public selectors cannot deserialize filesystem proof.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstructionExportBinding {
    seed: InstructionSourceSeed,
    descriptor: InstructionExportDescriptor,
}
impl InstructionExportBinding {
    pub fn export(&self) -> InstructionExportSelection {
        InstructionExportSelection {
            snapshot: None,
            binding: self.clone(),
        }
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InstructionExportDescriptor {
    source: kcoder_types::migration::MigrationSourceKind,
    parser_revision: String,
    origin_bytes: u64,
    origin_sha256: String,
    graph_bytes: u64,
    graph_sha256: String,
}
impl InstructionExportSelection {
    /// Native composition must first acquire an explicit root/cwd grant and static parser consent.
    pub fn capture(snapshot: Arc<InstructionSourceSnapshot>) -> Result<Self> {
        Self::capture_checked(snapshot, |_| true)
    }
    pub fn capture_checked(
        snapshot: Arc<InstructionSourceSnapshot>,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<Self> {
        ensure!(
            !snapshot.is_received_instruction(),
            "source_transfer_instruction_origin_unsupported"
        );
        snapshot.verify_source(&mut check)?;
        let graph = portable::checked_encode(
            &PortableInstructionGraph::from_snapshot(&snapshot)?,
            portable::MAX_GRAPH_BYTES,
            &mut check,
        )?;
        let origin = portable::checked_encode(&*snapshot, MAX_ORIGIN_BYTES, &mut check)?;
        let descriptor = InstructionExportDescriptor {
            source: snapshot.source(),
            parser_revision: GRAPH_PARSER.into(),
            origin_bytes: origin.len() as u64,
            origin_sha256: format!("{:x}", Sha256::digest(&*origin)),
            graph_bytes: graph.len() as u64,
            graph_sha256: format!("{:x}", Sha256::digest(&*graph)),
        };
        let seed = InstructionSourceSeed::capture(&snapshot)?;
        Ok(Self {
            snapshot: Some(snapshot),
            binding: InstructionExportBinding { seed, descriptor },
        })
    }
    pub(super) fn descriptor(&self) -> &InstructionExportDescriptor {
        &self.binding.descriptor
    }
    pub fn persisted_binding(&self) -> InstructionExportBinding {
        self.binding.clone()
    }
    pub(super) fn publish_origin(&self, directory: &PrivateDirectory, index: usize) -> Result<()> {
        let name = origin_name(index);
        match directory.entry_metadata(OsStr::new(&name)) {
            Ok(_) => {
                read_origin(directory, index, self.descriptor(), &mut |_| true)?;
                return Ok(());
            }
            Err(error) if missing(&error) => {}
            Err(error) => return Err(error),
        }
        active(directory)?;
        let snapshot = match &self.snapshot {
            Some(snapshot) => snapshot.clone(),
            None => Arc::new(self.binding.seed.reopen(|_| active(directory).is_ok())?),
        };
        snapshot.verify_source(|_| active(directory).is_ok())?;
        let bytes = portable::checked_encode(&*snapshot, MAX_ORIGIN_BYTES, &mut |_| {
            active(directory).is_ok()
        })?;
        ensure!(
            bytes.len() as u64 == self.descriptor().origin_bytes
                && format!("{:x}", Sha256::digest(&*bytes)) == self.descriptor().origin_sha256,
            "source_transfer_instruction_graph_changed"
        );
        let mut reader = OriginReader {
            bytes: Cursor::new(&*bytes),
            directory,
        };
        directory.atomic_publish_from_reader(OsStr::new(&name), &mut reader, false, || {
            active(directory)?;
            snapshot.verify_source(|_| active(directory).is_ok())?;
            Ok(None)
        })?;
        read_origin(directory, index, self.descriptor(), &mut |_| true)?;
        Ok(())
    }
}
impl InstructionExportDescriptor {
    pub(super) fn reserved_bytes(&self) -> Result<u64> {
        self.validate()?;
        self.origin_bytes
            .checked_add(self.graph_bytes)
            .context("source_transfer_budget_exceeded")
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            self.parser_revision == GRAPH_PARSER
                && self.origin_bytes > 0
                && self.origin_bytes <= MAX_ORIGIN_BYTES as u64
                && self.graph_bytes > 0
                && self.graph_bytes <= portable::MAX_GRAPH_BYTES as u64
                && valid_sha(&self.origin_sha256)
                && valid_sha(&self.graph_sha256),
            "source_transfer_instruction_graph_invalid"
        );
        Ok(())
    }
}
fn origin_name(index: usize) -> String {
    format!("instructions-origin-{index:04}.json")
}
struct OriginReader<'a> {
    bytes: Cursor<&'a [u8]>,
    directory: &'a PrivateDirectory,
}
impl Read for OriginReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        active(self.directory).map_err(|_| std::io::Error::other("source_transfer_cancelled"))?;
        let limit = buffer.len().min(64 * 1024);
        self.bytes.read(&mut buffer[..limit])
    }
}
fn read_origin(
    directory: &PrivateDirectory,
    index: usize,
    descriptor: &InstructionExportDescriptor,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<InstructionSourceSnapshot> {
    descriptor.validate()?;
    let name = origin_name(index);
    let file = directory.open_single_link_regular_file(OsStr::new(&name))?;
    let identity = directory.portable_regular_handle_identity(&file)?;
    ensure!(
        file.metadata()?.len() == descriptor.origin_bytes,
        "source_transfer_instruction_graph_changed"
    );
    let mut bytes = Zeroizing::new(Vec::new());
    let mut buffer = [0; 64 * 1024];
    let mut reader = (&file).take(descriptor.origin_bytes + 1);
    loop {
        active(directory)?;
        ensure!(check(bytes.len() as u64), "source_transfer_cancelled");
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        ensure!(
            bytes.len() as u64 + count as u64 <= descriptor.origin_bytes,
            "source_transfer_instruction_graph_changed"
        );
        bytes.extend_from_slice(&buffer[..count]);
    }
    ensure!(
        bytes.len() as u64 == descriptor.origin_bytes
            && format!("{:x}", Sha256::digest(&*bytes)) == descriptor.origin_sha256
            && directory.portable_regular_handle_identity(&file)? == identity
            && directory.portable_regular_identity(OsStr::new(&name))? == identity,
        "source_transfer_instruction_graph_changed"
    );
    let snapshot: InstructionSourceSnapshot = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("source_transfer_instruction_graph_invalid"))?;
    ensure!(
        snapshot.source() == descriptor.source
            && snapshot.format_revision() == descriptor.parser_revision
            && !snapshot.is_received_instruction(),
        "source_transfer_instruction_graph_changed"
    );
    PortableInstructionGraph::from_snapshot(&snapshot)?;
    Ok(snapshot)
}
pub(super) fn capture(
    directory: &PrivateDirectory,
    index: usize,
    descriptor: &InstructionExportDescriptor,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<TransferEntry> {
    let snapshot = read_origin(directory, index, descriptor, check)?;
    snapshot.verify_source(&mut |bytes| active(directory).is_ok() && check(bytes))?;
    let graph = PortableInstructionGraph::from_snapshot(&snapshot)?;
    let bytes = portable::checked_encode(&graph, portable::MAX_GRAPH_BYTES, check)?;
    ensure!(
        bytes.len() as u64 == descriptor.graph_bytes
            && format!("{:x}", Sha256::digest(&*bytes)) == descriptor.graph_sha256,
        "source_transfer_instruction_graph_changed"
    );
    let entry = entry(
        index,
        0,
        TransferContent::InstructionBundle {
            source: descriptor.source,
            parser_revision: descriptor.parser_revision.clone(),
        },
        &bytes,
    );
    super::snapshot(directory, &entry, &mut Cursor::new(&*bytes), check)?;
    snapshot.verify_source(|bytes| active(directory).is_ok() && check(bytes))?;
    Ok(entry)
}
