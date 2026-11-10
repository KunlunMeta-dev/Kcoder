//! Bounded durable discovery. No TTL, epoch GC, directory walk or turn dispatch.
use super::*;

pub struct ReaperCandidate(ReaperItem);
enum ReaperItem {
    Owner(Box<Owner>),
    Receipt(Box<Receipt>),
}
pub struct ReaperWindow {
    pub candidates: Vec<ReaperCandidate>,
    pub page_reads: usize,
    pub records_read: usize,
    pub unknown: usize,
}

impl RetentionService {
    pub fn reaper_resume_owner(
        &self,
        candidate: &ReaperCandidate,
        workspace: &str,
        principal: &RetentionPrincipalV1,
    ) -> Result<Option<bool>> {
        let ReaperItem::Owner(snapshot) = &candidate.0 else {
            return Ok(None);
        };
        let tx = self.store.transaction()?;
        let owner = self.owner(&tx, &snapshot.scope, &snapshot.id)?;
        ensure!(
            owner.epoch == snapshot.epoch
                && owner.entries.len() <= 32
                && owner.scope.version == 2
                && canonical_scope(&owner.scope)? == owner.scope
                && owner.scope.workspace_identity == workspace
                && owner.scope.context.principal == *principal,
            RetentionFailure::ProofUnavailable
        );
        ensure!(
            matches!(
                owner.phase,
                OwnerPhase::Retiring | OwnerPhase::Retired | OwnerPhase::Cancelled
            ),
            RetentionFailure::CompletionUnknown
        );
        drop(tx);
        self.resume_owner_retirement(&owner.scope, &owner.id)
            .map(Some)
    }
    pub fn reaper_window(
        &self,
        workspace: &str,
        principal: &RetentionPrincipalV1,
    ) -> Result<ReaperWindow> {
        sha(workspace)?;
        let key = digest(&serde_json::to_vec(&(
            "kcoder.retention.reaper.v1",
            self.namespace(),
            &self.store.header.identity,
            workspace,
            principal,
        ))?);
        let mut tx = self.store.transaction()?;
        let first = *tx
            .state
            .epochs
            .keys()
            .next()
            .context("reaper epochs missing")?;
        let mut cursor = tx
            .state
            .reaper_cursors
            .get(&key)
            .cloned()
            .unwrap_or(ReaperCursor {
                epoch: first,
                next_record: 0,
                last_used: tx.state.revision,
            });
        // A full pass can contain empty epochs. The header bounds this loop to 8.
        for _ in 0..tx.state.epochs.len() {
            if cursor.next_record < tx.state.epochs[&cursor.epoch].records {
                break;
            }
            cursor.epoch = tx
                .state
                .epochs
                .range((
                    std::ops::Bound::Excluded(cursor.epoch),
                    std::ops::Bound::Unbounded,
                ))
                .next()
                .map(|(id, _)| *id)
                .unwrap_or(first);
            cursor.next_record = 0;
        }
        let mut window = ReaperWindow {
            candidates: Vec::new(),
            page_reads: 0,
            records_read: 0,
            unknown: 0,
        };
        let records = tx.state.epochs[&cursor.epoch].records;
        if cursor.next_record < records {
            let page_number = cursor.next_record / INDEX_PAGE_SIZE as u64;
            let start = (cursor.next_record % INDEX_PAGE_SIZE as u64) as usize;
            window.page_reads = 1;
            match tx.catalog_page(cursor.epoch, page_number) {
                Err(_) => {
                    // This is a scan position, not a GC frontier. A bad page is
                    // retried on wrap without starving healthy later pages.
                    window.unknown += 1;
                    cursor.next_record = ((page_number + 1) * INDEX_PAGE_SIZE as u64).min(records);
                }
                Ok(page) => {
                    for locator in page.records.iter().skip(start) {
                        window.records_read += 1;
                        cursor.next_record += 1;
                        let candidate = match locator.area {
                            Area::Owners => tx.catalog_record::<Owner>(locator).and_then(|owner| {
                                ensure!(
                                    storage::leaf(&owner.id) == locator.leaf
                                        && owner.epoch == cursor.epoch,
                                    "reaper owner registration mismatch"
                                );
                                Ok((owner.scope.version == 2
                                    && canonical_scope(&owner.scope)? == owner.scope
                                    && owner.scope.workspace_identity == workspace
                                    && owner.scope.context.principal == *principal
                                    && owner.phase == OwnerPhase::Retiring)
                                    .then_some(ReaperCandidate(ReaperItem::Owner(Box::new(owner)))))
                            }),
                            Area::Receipts => {
                                tx.catalog_record::<Receipt>(locator).and_then(|receipt| {
                                    ensure!(
                                        storage::leaf(&receipt.wire.retention_id) == locator.leaf
                                            && receipt.epoch == cursor.epoch,
                                        "reaper receipt registration mismatch"
                                    );
                                    // Exact scope is recovered from registered owners during
                                    // execution. Discovery never supplies mutation authority.
                                    Ok((matches!(
                                        receipt.wire.state,
                                        RetentionReceiptStateV1::ReleasePending
                                            | RetentionReceiptStateV1::Released
                                    ) && receipt.release_intent.is_some())
                                    .then_some(ReaperCandidate(ReaperItem::Receipt(Box::new(
                                        receipt,
                                    )))))
                                })
                            }
                            _ => Ok(None),
                        };
                        match candidate {
                            Ok(Some(candidate)) => {
                                window.candidates.push(candidate);
                                break;
                            }
                            Ok(None) => (),
                            Err(_) => window.unknown += 1,
                        }
                    }
                }
            }
        }
        cursor.last_used = tx.state.revision;
        if !tx.state.reaper_cursors.contains_key(&key) && tx.state.reaper_cursors.len() == 32 {
            let oldest = tx
                .state
                .reaper_cursors
                .iter()
                .min_by_key(|(id, position)| (position.last_used, *id))
                .map(|(id, _)| id.clone())
                .context("reaper cursor eviction missing")?;
            // Evicting a position only repeats discovery. It never erases work.
            tx.state.reaper_cursors.remove(&oldest);
        }
        tx.state.reaper_cursors.insert(key, cursor);
        tx.commit()?;
        Ok(window)
    }
}
