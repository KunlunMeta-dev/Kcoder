//! An exact receiving receipt fixes parser and payload; target scope is authorized separately.
use super::super::*;
use super::binding::ReceivedBinding;
use crate::instruction_sources::{
    InstructionSourceSnapshot,
    portable::{GRAPH_PARSER, MAX_GRAPH_BYTES, PortableInstructionGraph},
};
use std::sync::Arc;
use zeroize::Zeroizing;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReceivedInstructionGraphBinding {
    binding: ReceivedBinding,
    parser_revision: String,
}
impl ReceivedInstructionGraphBinding {
    pub(crate) fn verify_consumer(&self, profile: &std::path::Path) -> Result<()> {
        ensure!(
            profile.canonicalize()? == self.binding.profile().canonicalize()?,
            "source_transfer_wrong_consumer"
        );
        Ok(())
    }
    pub(crate) fn source(&self) -> Result<kcoder_types::migration::MigrationSourceKind> {
        let TransferContent::InstructionBundle {
            source,
            parser_revision,
        } = &self.binding.entry().content
        else {
            anyhow::bail!("source_transfer_not_instruction_graph");
        };
        ensure!(
            parser_revision == GRAPH_PARSER
                && self.parser_revision == *parser_revision
                && self.binding.entry().bytes > 0
                && self.binding.entry().bytes <= MAX_GRAPH_BYTES as u64,
            "source_transfer_instruction_parser_unsupported"
        );
        Ok(*source)
    }
    pub(crate) fn verify_bytes(&self, bytes: &[u8]) -> Result<()> {
        self.source()?;
        ensure!(
            self.binding.entry().bytes == bytes.len() as u64
                && self.binding.entry().sha256 == format!("{:x}", Sha256::digest(bytes)),
            "source_transfer_instruction_graph_changed"
        );
        Ok(())
    }
    pub(crate) fn verify_payload(&self, mut check: impl FnMut(u64) -> bool) -> Result<()> {
        self.source()?;
        let receiver = self.binding.validate()?;
        let receipt = self.binding.receipt();
        let (directory, manifest) =
            receiver.ready(&receipt.request_id, self.binding.source(), receipt)?;
        let entry = find_entry(&manifest, &self.binding.entry().id)?;
        ensure!(
            entry == self.binding.entry(),
            "source_transfer_instruction_graph_changed"
        );
        verify_payload(&directory, entry, &mut check)
    }
}
impl IncomingTransfers {
    /// This does not select a target directory or publish a migration job.
    pub fn received_instruction_snapshot(
        &self,
        request: &str,
        manifest_sha256: &str,
        entry_id: &str,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<Arc<InstructionSourceSnapshot>> {
        let binding = ReceivedInstructionGraphBinding {
            binding: self.received_binding(request, manifest_sha256, entry_id)?,
            parser_revision: GRAPH_PARSER.into(),
        };
        let source = binding.source()?;
        let receipt = binding.binding.receipt();
        let (directory, manifest) = self.ready(request, binding.binding.source(), receipt)?;
        let entry = find_entry(&manifest, entry_id)?;
        let file = directory.open_single_link_regular_file(OsStr::new(&payload_name(entry)))?;
        let identity = directory.portable_regular_handle_identity(&file)?;
        ensure!(
            file.metadata()?.len() == entry.bytes,
            "source_transfer_instruction_graph_changed"
        );
        let mut reader = (&file).take(entry.bytes + 1);
        let mut bytes = Zeroizing::new(Vec::new());
        let mut buffer = [0; 64 * 1024];
        loop {
            active(&directory)?;
            ensure!(check(bytes.len() as u64), "source_transfer_cancelled");
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            ensure!(
                bytes.len() as u64 + count as u64 <= entry.bytes,
                "source_transfer_instruction_graph_changed"
            );
            bytes.extend_from_slice(&buffer[..count]);
        }
        ensure!(
            directory.portable_regular_handle_identity(&file)? == identity
                && directory.portable_regular_identity(OsStr::new(&payload_name(entry)))?
                    == identity,
            "source_transfer_instruction_graph_changed"
        );
        binding.verify_bytes(&bytes)?;
        let graph = PortableInstructionGraph::decode(&bytes)?;
        ensure!(
            graph.source() == source,
            "source_transfer_instruction_graph_changed"
        );
        let snapshot = graph.into_snapshot(binding)?;
        snapshot.verify_source(check)?;
        Ok(Arc::new(snapshot))
    }
}
