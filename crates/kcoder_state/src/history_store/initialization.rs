//! Atomic first publication and proof-only reconciliation share the native source fence.
use super::*;
pub(super) fn initialize(
    source: &HistorySource,
    bytes: &[u8],
    generation: uuid::Uuid,
) -> Result<()> {
    validate_replacement(bytes)?;
    anyhow::ensure!(!bytes.is_empty(), "initial history must not be empty");
    source.mutate_when(None, false, || {
        Ok(Mutation::Initialize { bytes, generation })
    })
}
pub(super) fn reconcile(
    source: &HistorySource,
    generation: uuid::Uuid,
    length: u64,
    sha256: &str,
) -> Result<()> {
    let mut binding = source
        .binding
        .lock()
        .map_err(|_| anyhow::anyhow!("history source binding lock is poisoned"))?;
    let (directory, name) = open_parent_with_create(&source.path, false)?;
    let lock = open_mutation_lock(&directory)?;
    FileExt::lock_exclusive(&lock)?;
    let mut fence = JournalFence::from_locked_history(
        source
            .path
            .parent()
            .context("history source has no parent")?,
        lock,
    )?;
    let mut record =
        read_source_record(&directory, &name)?.context("historical_seed_source_receipt_missing")?;
    binding.verify(Some(&record))?;
    if let Some(pending) = record
        .commit
        .as_ref()
        .and_then(|value| value.pending.as_ref())
    {
        anyhow::ensure!(
            matches!(&pending.operation,commit::MutationPlan::Replace{generation:actual,length:bytes,sha256:digest} if *actual==generation&&*bytes==length&&digest==sha256),
            "historical_seed_unrelated_pending_commit"
        );
        commit::confirm_completed_pending(
            &source.path,
            &directory,
            &name,
            &mut record,
            &mut fence,
        )?;
        binding.generation = Some(record.body_generation());
    }
    anyhow::ensure!(
        record.body_generation() == generation,
        "historical_seed_source_generation_changed"
    );
    Ok(())
}
#[cfg(test)]
mod tests;
