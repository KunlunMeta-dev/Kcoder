use crate::{KnowledgeCatalog, KnowledgeScope, Library};
use anyhow::{Result, ensure};
use rusqlite::params;

impl KnowledgeCatalog {
    pub fn update_library(
        &mut self,
        scope: &KnowledgeScope,
        id: &str,
        expected: u64,
        name: &str,
        purpose: &str,
    ) -> Result<Library> {
        ensure!(
            !name.trim().is_empty() && name.chars().count() <= 120,
            "invalid library name"
        );
        ensure!(purpose.len() <= 32 * 1024, "library purpose is too large");
        let current = self.read(scope, id)?;
        if current.name == name.trim() && current.purpose == purpose {
            return Ok(current);
        }
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let changed=tx.execute("UPDATE libraries SET name=?4,purpose=?5,metadata_revision=metadata_revision+1 WHERE id=?1 AND principal=?2 AND target=?3 AND metadata_revision=?6",params![id,scope.principal,scope.target,name.trim(),purpose,expected as i64])?;
        ensure!(changed == 1, "library revision conflict");
        if purpose != current.purpose {
            tx.execute("UPDATE knowledge_jobs SET status='paused',error_code='configuration_changed',lease_token=NULL,lease_until_ms=0 WHERE library_id=?1 AND status IN ('queued','running')",[id])?;
        }
        tx.commit()?;

        self.read(scope, id)
    }
}
