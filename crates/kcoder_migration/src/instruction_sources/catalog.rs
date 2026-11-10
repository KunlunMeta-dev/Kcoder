//! Finite owned source captures retain their first interpretation; observation never refreshes it.
use super::{InstructionSourceGrant, InstructionSourcePolicy, InstructionSourceSnapshot};
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::migration::MigrationSourceKind;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

const LIFETIME: Duration = Duration::from_secs(600);
const MAX_ACTIVE: usize = 2;
const MAX_IDENTITIES: usize = 64;

pub struct InstructionCaptureRequest<'a> {
    pub source: MigrationSourceKind,
    pub root: &'a Path,
    pub cwd: &'a Path,
    pub include_descendants: bool,
}

#[derive(Default)]
pub struct InstructionSourceCatalog {
    owner: Option<(PathBuf, String)>,
    records: BTreeMap<String, Record>,
}
struct Record {
    intent: String,
    created: Instant,
    snapshot: Option<Arc<InstructionSourceSnapshot>>,
}
pub struct CapturedInstructions {
    pub snapshot: Arc<InstructionSourceSnapshot>,
    pub remaining_ms: u64,
}
impl InstructionSourceCatalog {
    /// Root and cwd are explicitly granted independently of any vendor product directory.
    pub fn capture(
        &mut self,
        profile: &Path,
        capture_id: &str,
        request: InstructionCaptureRequest<'_>,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<CapturedInstructions> {
        let InstructionCaptureRequest {
            source,
            root,
            cwd,
            include_descendants,
        } = request;
        ensure!(
            uuid::Uuid::parse_str(capture_id).is_ok_and(|id| id.to_string() == capture_id),
            "migration_invalid_request_reference"
        );
        self.verify_owner(profile)?;
        let intent = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                source,
                root,
                cwd,
                include_descendants,
                "scoped-instructions/v2"
            ))?)
        );
        if let Some(record) = self.records.get(capture_id) {
            ensure!(
                record.intent == intent,
                "migration_instruction_capture_changed"
            );
            return Self::read_record(record);
        }
        for record in self.records.values_mut() {
            if record.created.elapsed() >= LIFETIME {
                record.snapshot = None;
            }
        }
        ensure!(
            self.records.len() < MAX_IDENTITIES
                && self
                    .records
                    .values()
                    .filter(|record| record.snapshot.is_some())
                    .count()
                    < MAX_ACTIVE,
            "migration_instruction_capture_capacity"
        );
        ensure!(check(0), "migration_cancelled");
        let grant = InstructionSourceGrant::capture(profile, root, cwd, source)?;
        let policy = InstructionSourcePolicy {
            include_descendants,
            ..InstructionSourcePolicy::default()
        };
        let snapshot = Arc::new(
            grant
                .capture_static_sources(&policy, true, &mut check)?
                .for_creation_checked(capture_id, &mut check)?,
        );
        ensure!(check(0), "migration_cancelled");
        let record = Record {
            intent,
            created: Instant::now(),
            snapshot: Some(snapshot),
        };
        let result = Self::read_record(&record)?;
        self.records.insert(capture_id.into(), record);
        Ok(result)
    }
    /// Reading captured bytes grants no permission to capture or export changed source files.
    pub fn read(&self, profile: &Path, capture_id: &str) -> Result<CapturedInstructions> {
        self.check_owner(profile)?;
        Self::read_record(
            self.records
                .get(capture_id)
                .ok_or_else(|| anyhow::anyhow!("migration_instruction_capture_unavailable"))?,
        )
    }
    fn read_record(record: &Record) -> Result<CapturedInstructions> {
        let remaining = LIFETIME.saturating_sub(record.created.elapsed());
        ensure!(
            !remaining.is_zero(),
            "migration_instruction_capture_expired"
        );
        Ok(CapturedInstructions {
            snapshot: record
                .snapshot
                .clone()
                .ok_or_else(|| anyhow::anyhow!("migration_instruction_capture_expired"))?,
            remaining_ms: remaining.as_millis() as u64,
        })
    }
    fn verify_owner(&mut self, profile: &Path) -> Result<()> {
        if self.owner.is_none() {
            let directory = PrivateDirectory::open_existing(profile)?;
            directory.verify_trusted_config_directory()?;
            self.owner = Some((profile.canonicalize()?, directory.directory_identity()?));
        }
        self.check_owner(profile)
    }
    fn check_owner(&self, profile: &Path) -> Result<()> {
        let (path, identity) = self
            .owner
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_instruction_capture_unavailable"))?;
        let directory = PrivateDirectory::open_existing(profile)?;
        directory.verify_trusted_config_directory()?;
        ensure!(
            profile.canonicalize()? == *path && directory.directory_identity()? == *identity,
            "migration_instruction_capture_owner_changed"
        );
        Ok(())
    }
}
#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
