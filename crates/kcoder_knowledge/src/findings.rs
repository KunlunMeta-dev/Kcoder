//! Durable verification findings, pending source units and their human
//! decisions. Findings bind to immutable page revisions and are written in the
//! same transaction as the page commit; decisions are append-only. Nothing here
//! approves content: confirming a finding is a recorded human judgement.
use crate::{KnowledgeCatalog, KnowledgeScope, PageRevisionRef, WikiJob};
use anyhow::{Result, ensure};
use kcoder_types::knowledge::{KnowledgePageDraft, KnowledgePageKind};
use kcoder_types::wiki_findings::{
    WikiFindingDecisionKind, WikiJobOutcome, WikiPageUnverifiedLines, WikiPageVerification,
    WikiPageVerificationStatus, WikiPendingStatus, WikiPendingUnit, WikiPublicationFindings,
    WikiUnverifiedVerdict, WikiVerificationFinding,
};
use rusqlite::{OptionalExtension, params};

fn verdict_name(verdict: WikiUnverifiedVerdict) -> &'static str {
    match verdict {
        WikiUnverifiedVerdict::Unsupported => "unsupported",
        WikiUnverifiedVerdict::Uncertain => "uncertain",
        WikiUnverifiedVerdict::Unassessed => "unassessed",
    }
}

fn verdict(raw: &str) -> rusqlite::Result<WikiUnverifiedVerdict> {
    serde_json::from_value(serde_json::Value::String(raw.into())).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn identity(parts: &[&str]) -> String {
    crate::objects::digest(parts.join("\0").as_bytes())[..32].to_owned()
}

/// Record the publication facts of one committed batch. Idempotent: replaying
/// a commit receipt inserts nothing new.
pub(crate) fn record_commit(
    tx: &rusqlite::Connection,
    library: &str,
    job: &str,
    batch: usize,
    revisions: &[PageRevisionRef],
    pages: &[KnowledgePageDraft],
    publication: &WikiPublicationFindings,
) -> Result<()> {
    let now = crate::jobs::now_ms()?;
    let mut outcome = WikiJobOutcome {
        published_pages: revisions.len() as u32,
        verified_units: publication.verified_units as u32,
        pending_units: publication.pending.len() as u32,
        withheld_updates: publication.withheld.len() as u32,
        tool_turns: publication.tool_turns,
        tool_calls: publication.tool_calls,
        ..WikiJobOutcome::default()
    };
    for revision in revisions {
        let Some(page) = pages.iter().find(|page| page.page_id == revision.page_id) else {
            continue;
        };
        tx.execute("INSERT OR IGNORE INTO knowledge_revision_assessments(library_id,page_id,revision_id,job_id,assessed,created_at_ms) VALUES(?1,?2,?3,?4,1,?5)",params![library,revision.page_id,revision.revision_id,job,now])?;
        if matches!(
            page.kind,
            KnowledgePageKind::Source | KnowledgePageKind::Overview
        ) {
            continue;
        }
        let body = crate::objects::digest(page.markdown.as_bytes());
        for finding in publication
            .unverified
            .iter()
            .filter(|finding| finding.page_id == page.page_id && finding.body_hash == body)
        {
            match finding.verdict {
                WikiUnverifiedVerdict::Unsupported => outcome.unverified.unsupported += 1,
                WikiUnverifiedVerdict::Uncertain => outcome.unverified.uncertain += 1,
                WikiUnverifiedVerdict::Unassessed => outcome.unverified.unassessed += 1,
            }
            let id = identity(&[
                "finding",
                job,
                &batch.to_string(),
                &revision.page_id,
                &finding.first_line.to_string(),
                &finding.last_line.to_string(),
                &finding.code,
            ]);
            tx.execute("INSERT OR IGNORE INTO knowledge_page_findings(library_id,finding_id,page_id,revision_id,job_id,batch,verdict,code,first_line,last_line,body_hash,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",params![library,id,revision.page_id,revision.revision_id,job,batch as i64,verdict_name(finding.verdict),finding.code,finding.first_line as i64,finding.last_line as i64,body,now])?;
        }
    }
    for pending in &publication.pending {
        let id = identity(&["pending", job, &batch.to_string(), &pending.unit_id]);
        tx.execute("INSERT OR IGNORE INTO knowledge_pending_units(library_id,pending_id,job_id,batch,source_id,source_revision,unit_id,chunk_ids_json,first_line,last_line,reason_code,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",params![library,id,job,batch as i64,pending.source_id,pending.source_revision,pending.unit_id,serde_json::to_string(&pending.chunk_ids)?,pending.first_line as i64,pending.last_line as i64,pending.reason_code,now])?;
    }
    tx.execute("INSERT OR IGNORE INTO knowledge_job_outcomes(library_id,job_id,batch,outcome_json,created_at_ms) VALUES(?1,?2,?3,?4,?5)",params![library,job,batch as i64,serde_json::to_string(&outcome)?,now])?;
    resolve_focused(tx, library, job, publication)?;
    Ok(())
}

/// An explicit organize job resolves its focused pending units when it
/// commits without recording the same unit range as pending again.
fn resolve_focused(
    tx: &rusqlite::Connection,
    library: &str,
    job: &str,
    publication: &WikiPublicationFindings,
) -> Result<()> {
    let focus: Option<String> = tx
        .query_row(
            "SELECT focus_json FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2",
            params![library, job],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let Some(focus) = focus else { return Ok(()) };
    let focus: serde_json::Value = serde_json::from_str(&focus)?;
    let now = crate::jobs::now_ms()?;
    for id in focus["pendingIds"].as_array().into_iter().flatten() {
        let Some(id) = id.as_str() else { continue };
        let range: Option<(i64, i64)> = tx
            .query_row(
                "SELECT first_line,last_line FROM knowledge_pending_units WHERE library_id=?1 AND pending_id=?2",
                params![library, id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((first, last)) = range else { continue };
        let still_pending = publication.pending.iter().any(|pending| {
            (pending.first_line as i64) <= last && (pending.last_line as i64) >= first
        });
        if !still_pending {
            tx.execute("INSERT OR IGNORE INTO knowledge_finding_decisions(library_id,decision_id,target_kind,target_id,decision,request_key,related_job_id,created_at_ms) VALUES(?1,?2,'pending',?3,'resolved',?4,?5,?6)",params![library,identity(&["resolved",job,id]),id,format!("resolved:{job}:{id}"),job,now])?;
        }
    }
    Ok(())
}

fn latest_decision(
    db: &rusqlite::Connection,
    library: &str,
    kind: &str,
    target: &str,
) -> Result<Option<(String, Option<String>, i64)>> {
    Ok(db
        .query_row(
            "SELECT decision,related_job_id,created_at_ms FROM knowledge_finding_decisions WHERE library_id=?1 AND target_kind=?2 AND target_id=?3 ORDER BY rowid DESC LIMIT 1",
            params![library, kind, target],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?)
}

fn pending_status(
    db: &rusqlite::Connection,
    library: &str,
    pending: &str,
) -> Result<(WikiPendingStatus, Option<String>)> {
    Ok(match latest_decision(db, library, "pending", pending)? {
        None => (WikiPendingStatus::Open, None),
        Some((decision, job, _)) => match decision.as_str() {
            "resolved" => (WikiPendingStatus::Resolved, job),
            "dismissed" => (WikiPendingStatus::Dismissed, None),
            _ => {
                let active: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2 AND status IN ('queued','running','paused','awaiting_review'))",params![library,job],|row|row.get(0))?;
                if active {
                    (WikiPendingStatus::Organizing, job)
                } else {
                    (WikiPendingStatus::Open, None)
                }
            }
        },
    })
}

type FindingRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
    String,
    i64,
);

impl KnowledgeCatalog {
    fn finding(&self, library: &str, row: FindingRow) -> Result<WikiVerificationFinding> {
        let (
            finding_id,
            page_id,
            revision_id,
            job_id,
            verdict_raw,
            code,
            first,
            last,
            body_hash,
            created,
        ) = row;
        let current: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM knowledge_pages WHERE library_id=?1 AND page_id=?2 AND current_revision=?3)",params![library,page_id,revision_id],|row|row.get(0))?;
        let decision = latest_decision(&self.connection, library, "finding", &finding_id)?;
        Ok(WikiVerificationFinding {
            finding_id,
            page_id,
            revision_id,
            job_id,
            verdict: verdict(&verdict_raw)?,
            code,
            first_line: first as usize,
            last_line: last as usize,
            body_hash,
            current,
            decision: decision
                .as_ref()
                .and_then(|(kind, _, _)| match kind.as_str() {
                    "confirmed" => Some(WikiFindingDecisionKind::Confirmed),
                    "dismissed" => Some(WikiFindingDecisionKind::Dismissed),
                    _ => None,
                }),
            decided_at_ms: decision.map(|(_, _, at)| at as u64),
            created_at_ms: created as u64,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn list_findings(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        page: Option<&str>,
        job: Option<&str>,
        include_decided: bool,
        after: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<WikiVerificationFinding>, Option<String>)> {
        self.read(scope, library)?;
        ensure!((1..=100).contains(&limit), "finding limit must be 1..100");
        let mut query = self.connection.prepare("SELECT finding_id,page_id,revision_id,job_id,verdict,code,first_line,last_line,body_hash,created_at_ms FROM knowledge_page_findings WHERE library_id=?1 AND (?2 IS NULL OR page_id=?2) AND (?3 IS NULL OR job_id=?3) AND finding_id>?4 ORDER BY finding_id")?;
        let rows = query.query_map(params![library, page, job, after.unwrap_or("")], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
            ))
        })?;
        let mut items = Vec::new();
        let mut next = None;
        for row in rows {
            let finding = self.finding(library, row?)?;
            if !include_decided && (!finding.current || finding.decision.is_some()) {
                continue;
            }
            if items.len() == limit {
                next = items
                    .last()
                    .map(|last: &WikiVerificationFinding| last.finding_id.clone());
                break;
            }
            items.push(finding);
        }
        Ok((items, next))
    }

    pub fn decide_finding(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        finding: &str,
        expected_revision: &str,
        confirm: bool,
        key: &str,
    ) -> Result<WikiVerificationFinding> {
        self.read(scope, library)?;
        ensure!(!key.is_empty() && key.len() <= 128, "invalid request key");
        let decision = if confirm { "confirmed" } else { "dismissed" };
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::pages::require_active(&tx, library)?;
        let prior: Option<(String, String)> = tx.query_row("SELECT target_id,decision FROM knowledge_finding_decisions WHERE library_id=?1 AND request_key=?2",params![library,key],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        if let Some((target, previous)) = prior {
            ensure!(
                target == finding && previous == decision,
                "idempotency conflict"
            );
        } else {
            let (page, revision): (String, String) = tx
                .query_row(
                    "SELECT page_id,revision_id FROM knowledge_page_findings WHERE library_id=?1 AND finding_id=?2",
                    params![library, finding],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| anyhow::anyhow!("Wiki finding not found"))?;
            let current: Option<String> = tx
                .query_row(
                    "SELECT current_revision FROM knowledge_pages WHERE library_id=?1 AND page_id=?2",
                    params![library, page],
                    |row| row.get(0),
                )
                .optional()?;
            ensure!(
                revision == expected_revision && current.as_deref() == Some(expected_revision),
                "Wiki page changed; reload it before deciding this finding"
            );
            tx.execute("INSERT INTO knowledge_finding_decisions(library_id,decision_id,target_kind,target_id,decision,request_key,created_at_ms) VALUES(?1,?2,'finding',?3,?4,?5,?6)",params![library,uuid::Uuid::new_v4().to_string(),finding,decision,key,crate::jobs::now_ms()?])?;
        }
        tx.commit()?;
        let row: FindingRow = self.connection.query_row("SELECT finding_id,page_id,revision_id,job_id,verdict,code,first_line,last_line,body_hash,created_at_ms FROM knowledge_page_findings WHERE library_id=?1 AND finding_id=?2",params![library,finding],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?)))?;
        self.finding(library, row)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn list_pending(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        source: Option<&str>,
        include_closed: bool,
        after: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<WikiPendingUnit>, Option<String>)> {
        self.read(scope, library)?;
        ensure!((1..=100).contains(&limit), "pending limit must be 1..100");
        type Row = (
            String,
            String,
            String,
            String,
            String,
            String,
            i64,
            i64,
            String,
            i64,
        );
        let rows: Vec<Row> = self.connection.prepare("SELECT pending_id,job_id,source_id,source_revision,unit_id,chunk_ids_json,first_line,last_line,reason_code,created_at_ms FROM knowledge_pending_units WHERE library_id=?1 AND (?2 IS NULL OR source_id=?2) AND pending_id>?3 ORDER BY pending_id")?
            .query_map(params![library,source,after.unwrap_or("")],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut items = Vec::new();
        let mut next = None;
        for (
            pending_id,
            job_id,
            source_id,
            source_revision,
            unit_id,
            chunks,
            first,
            last,
            reason,
            created,
        ) in rows
        {
            let (status, organize_job_id) = pending_status(&self.connection, library, &pending_id)?;
            if !include_closed
                && matches!(
                    status,
                    WikiPendingStatus::Resolved | WikiPendingStatus::Dismissed
                )
            {
                continue;
            }
            if items.len() == limit {
                next = items
                    .last()
                    .map(|last: &WikiPendingUnit| last.pending_id.clone());
                break;
            }
            items.push(WikiPendingUnit {
                pending_id,
                job_id,
                source_id,
                source_revision,
                unit_id,
                chunk_ids: serde_json::from_str(&chunks)?,
                first_line: first as usize,
                last_line: last as usize,
                reason_code: reason,
                status,
                organize_job_id,
                created_at_ms: created as u64,
            });
        }
        Ok((items, next))
    }

    /// Explicit user request only. Creates one file-contract job limited to the
    /// chunk window of the selected open pending units of a current source.
    #[allow(clippy::too_many_arguments)]
    pub fn organize_pending(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        pending: &[String],
        key: &str,
        recipe: &str,
        language: &str,
    ) -> Result<WikiJob> {
        self.read(scope, library)?;
        ensure!(
            (1..=64).contains(&pending.len()),
            "select 1..64 pending units"
        );
        let mut source: Option<(String, String)> = None;
        let mut ordinals = Vec::new();
        for id in pending {
            let (source_id, revision, chunks): (String, String, String) = self
                .connection
                .query_row(
                    "SELECT source_id,source_revision,chunk_ids_json FROM knowledge_pending_units WHERE library_id=?1 AND pending_id=?2",
                    params![library, id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .ok_or_else(|| anyhow::anyhow!("Wiki pending unit not found"))?;
            ensure!(
                source
                    .as_ref()
                    .is_none_or(|known| known == &(source_id.clone(), revision.clone())),
                "pending units must belong to one source revision"
            );
            let existing_job: Option<i64> = self
                .connection
                .query_row(
                    "SELECT 1 FROM knowledge_jobs WHERE library_id=?1 AND request_key=?2",
                    params![library, key],
                    |row| row.get(0),
                )
                .optional()?;
            if existing_job.is_none() {
                ensure!(
                    pending_status(&self.connection, library, id)?.0 == WikiPendingStatus::Open,
                    "Wiki pending unit is not open"
                );
            }
            for chunk in serde_json::from_str::<Vec<String>>(&chunks)? {
                let ordinal: i64 = self.connection.query_row("SELECT ordinal FROM knowledge_chunks WHERE library_id=?1 AND source_id=?2 AND revision_id=?3 AND chunk_id=?4",params![library,source_id,revision,chunk],|row|row.get(0))?;
                ordinals.push(ordinal as usize);
            }
            source = Some((source_id, revision));
        }
        let (source_id, revision) = source.expect("at least one pending unit");
        let first = ordinals.iter().min().copied().unwrap_or(1).max(1);
        let last = ordinals.iter().max().copied().unwrap_or(first);
        let focus = serde_json::json!({"pendingIds":pending,"throughChunk":last});
        let job = self.enqueue_job(
            scope,
            library,
            key,
            &source_id,
            &revision,
            recipe,
            language,
            first - 1,
            Some(&focus.to_string()),
        )?;
        let now = crate::jobs::now_ms()?;
        for id in pending {
            self.connection.execute("INSERT OR IGNORE INTO knowledge_finding_decisions(library_id,decision_id,target_kind,target_id,decision,request_key,related_job_id,created_at_ms) VALUES(?1,?2,'pending',?3,'organizing',?4,?5,?6)",params![library,identity(&["organizing",&job.id,id]),id,format!("organizing:{}:{id}",job.id),job.id,now])?;
        }
        Ok(job)
    }

    /// Last chunk ordinal of an explicit pending-organize job.
    pub fn job_window_limit(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        job: &str,
    ) -> Result<Option<usize>> {
        self.read(scope, library)?;
        let focus: Option<String> = self.connection.query_row(
            "SELECT focus_json FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2",
            params![library, job],
            |row| row.get(0),
        )?;
        Ok(focus
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|value| value["throughChunk"].as_u64())
            .map(|value| value as usize))
    }

    pub fn page_verification(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        page: &str,
        revision: &str,
    ) -> Result<WikiPageVerification> {
        self.read(scope, library)?;
        let author: Option<String> = self.connection.query_row("SELECT author FROM knowledge_page_revisions WHERE library_id=?1 AND page_id=?2 AND revision_id=?3",params![library,page,revision],|row|row.get(0)).optional()?;
        if author.as_deref() == Some("human") {
            return Ok(WikiPageVerification {
                status: WikiPageVerificationStatus::HumanEdited,
                unverified: Vec::new(),
            });
        }
        let assessed: Option<bool> = self.connection.query_row("SELECT assessed FROM knowledge_revision_assessments WHERE library_id=?1 AND page_id=?2 AND revision_id=?3",params![library,page,revision],|row|row.get(0)).optional()?;
        let rows: Vec<(String, String, i64, i64)> = self.connection.prepare("SELECT finding_id,verdict,first_line,last_line FROM knowledge_page_findings WHERE library_id=?1 AND page_id=?2 AND revision_id=?3 ORDER BY first_line,finding_id")?
            .query_map(params![library,page,revision],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut unverified = Vec::new();
        for (id, raw, first, last) in rows {
            if latest_decision(&self.connection, library, "finding", &id)?.is_some() {
                continue;
            }
            unverified.push(WikiPageUnverifiedLines {
                first_line: first as usize,
                last_line: last as usize,
                verdict: verdict(&raw)?,
            });
        }
        let status = match (assessed, unverified.is_empty()) {
            (_, false) => WikiPageVerificationStatus::Partial,
            (Some(true), true) => WikiPageVerificationStatus::Verified,
            (Some(false), true) => WikiPageVerificationStatus::Unassessed,
            (None, true) => WikiPageVerificationStatus::Legacy,
        };
        Ok(WikiPageVerification { status, unverified })
    }

    /// Open findings per current page revision, for page summaries.
    pub(crate) fn open_finding_count(
        &self,
        library: &str,
        page: &str,
        revision: &str,
    ) -> Result<Option<u32>> {
        let assessed: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM knowledge_revision_assessments WHERE library_id=?1 AND page_id=?2 AND revision_id=?3)",params![library,page,revision],|row|row.get(0))?;
        if !assessed {
            return Ok(None);
        }
        let count: u32 = self.connection.query_row("SELECT count(*) FROM knowledge_page_findings f WHERE f.library_id=?1 AND f.page_id=?2 AND f.revision_id=?3 AND NOT EXISTS(SELECT 1 FROM knowledge_finding_decisions d WHERE d.library_id=f.library_id AND d.target_kind='finding' AND d.target_id=f.finding_id)",params![library,page,revision],|row|row.get(0))?;
        Ok(Some(count))
    }

    pub(crate) fn job_outcome(&self, library: &str, job: &str) -> Result<Option<WikiJobOutcome>> {
        let rows: Vec<String> = self.connection.prepare("SELECT outcome_json FROM knowledge_job_outcomes WHERE library_id=?1 AND job_id=?2 ORDER BY batch")?
            .query_map(params![library,job],|row|row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        if rows.is_empty() {
            return Ok(None);
        }
        let mut total = WikiJobOutcome::default();
        for raw in rows {
            let item: WikiJobOutcome = serde_json::from_str(&raw)?;
            total.published_pages += item.published_pages;
            total.verified_units += item.verified_units;
            total.unverified.unsupported += item.unverified.unsupported;
            total.unverified.uncertain += item.unverified.uncertain;
            total.unverified.unassessed += item.unverified.unassessed;
            total.pending_units += item.pending_units;
            total.withheld_updates += item.withheld_updates;
            total.tool_turns += item.tool_turns;
            total.tool_calls += item.tool_calls;
        }
        Ok(Some(total))
    }
}
