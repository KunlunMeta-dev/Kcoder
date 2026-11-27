//! Live parent checks and bounded private frames for one trusted offline child.
//! Serializable path/identity facts never grant migration or domain authority.
use super::*;
use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, Write};

pub const STORAGE_OFFLINE_CHILD_FRAME_LIMIT: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageOfflineChildFence {
    #[serde(serialize_with = "super::super::node_wire_path::serialize")]
    pub root: PathBuf,
    pub directory_identity: String,
    pub primary_identity: String,
    pub secondary_identity: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageOfflineChildFences {
    pub operation_id: String,
    pub roots: Vec<StorageOfflineChildFence>,
}

impl StorageCoordinator {
    fn require_offline_child_parent(&mut self, id: &str) -> Result<()> {
        let receipt = self.require(id)?;
        ensure!(
            receipt.disposition == Disposition::Active
                && matches!(
                    receipt.phase,
                    Phase::Stopped | Phase::Copying | Phase::Verifying | Phase::Prepared
                ),
            "STORAGE_PHASE_INVALID"
        );
        ensure!(
            location(&self.directory)? == receipt.plan.original,
            "STORAGE_SELECTION_CHANGED"
        );
        self.require_stopped(&receipt.plan)
    }

    /// Call before source inventory so these actual control files are excluded.
    pub fn prepare_offline_child_fences(&mut self, id: &str) -> Result<StorageOfflineChildFences> {
        self.require_offline_child_parent(id)?;
        ensure!(!self.roots.is_empty(), "STORAGE_CHILD_ROOT_REQUIRED");
        let mut roots = Vec::with_capacity(self.roots.len());
        for root in &mut self.roots {
            root.prepare_child_fence()?;
            let (root, directory_identity, primary_identity, secondary_identity) =
                root.child_fence_fact()?;
            roots.push(StorageOfflineChildFence {
                root,
                directory_identity,
                primary_identity,
                secondary_identity,
            });
        }
        self.verify_control()?;
        Ok(StorageOfflineChildFences {
            operation_id: id.into(),
            roots,
        })
    }

    /// The parent retains this original value. Never use child-returned facts
    /// as authority; the dispatcher also checks its original domain/path scope.
    pub fn validate_offline_child_fences(
        &mut self,
        id: &str,
        original: &StorageOfflineChildFences,
    ) -> Result<()> {
        self.require_offline_child_parent(id)?;
        ensure!(
            original.operation_id == id && original.roots.len() == self.roots.len(),
            "STORAGE_CHILD_FENCE_CHANGED"
        );
        for (held, expected) in self.roots.iter().zip(&original.roots) {
            let (root, directory_identity, primary_identity, secondary_identity) =
                held.child_fence_fact()?;
            ensure!(
                root == expected.root
                    && directory_identity == expected.directory_identity
                    && primary_identity == expected.primary_identity
                    && secondary_identity == expected.secondary_identity,
                "STORAGE_CHILD_FENCE_CHANGED"
            );
        }
        Ok(())
    }
}

pub fn read_storage_offline_child_frame(reader: &mut impl BufRead) -> Result<Value> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        ensure!(!available.is_empty(), "STORAGE_OFFLINE_CHILD_PIPE_CLOSED");
        let newline = available.iter().position(|byte| *byte == b'\n');
        let length = newline.map_or(available.len(), |index| index + 1);
        ensure!(
            length <= STORAGE_OFFLINE_CHILD_FRAME_LIMIT.saturating_sub(bytes.len()),
            "STORAGE_OFFLINE_CHILD_FRAME_TOO_LARGE"
        );
        bytes.extend_from_slice(&available[..length]);
        reader.consume(length);
        if newline.is_some() {
            let frame: Value =
                serde_json::from_slice(&bytes).context("STORAGE_OFFLINE_CHILD_FRAME_INVALID")?;
            ensure!(frame.is_object(), "STORAGE_OFFLINE_CHILD_FRAME_INVALID");
            return Ok(frame);
        }
    }
}

pub fn write_storage_offline_child_frame(writer: &mut impl Write, frame: &Value) -> Result<()> {
    ensure!(frame.is_object(), "STORAGE_OFFLINE_CHILD_FRAME_INVALID");
    let bytes = serde_json::to_vec(frame)?;
    ensure!(
        bytes.len() < STORAGE_OFFLINE_CHILD_FRAME_LIMIT,
        "STORAGE_OFFLINE_CHILD_FRAME_TOO_LARGE"
    );
    writer.write_all(&bytes)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
#[path = "offline_child_tests.rs"]
mod tests;
