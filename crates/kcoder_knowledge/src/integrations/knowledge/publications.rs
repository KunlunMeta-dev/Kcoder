use crate::{KnowledgeCatalog, KnowledgeScope};
use anyhow::{Result, ensure};
use kcoder_types::integrations::core::IntegrationScope;
use kcoder_types::integrations::knowledge::{
    KnowledgeOwner, KnowledgePage, KnowledgePublication, KnowledgeRetrieval,
    KnowledgeRetrievalOutcome, KnowledgeVisibility, PublicationDraft, PublicationHit,
    PublicationSource, PublishedKnowledgePage,
};
use rusqlite::{OptionalExtension, params};
use serde_json::json;

fn same_account_other_workspace(owner: &KnowledgeOwner, caller: &IntegrationScope) -> bool {
    use kcoder_types::integrations::core::IntegrationNullable;
    owner.account_id == caller.account_id
        && owner.target_id == caller.target_id
        && owner.workspace_id != caller.workspace_id
        && matches!(owner.workspace_id, IntegrationNullable::Value(_))
        && matches!(caller.workspace_id, IntegrationNullable::Value(_))
        && matches!(caller.organization_id, Some(IntegrationNullable::Value(_)))
        && owner.organization_id == caller.organization_id
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicationAction {
    Publish,
    Read,
    ReadCitation,
    Revoke,
    Adopt,
    ManageAdoption,
}
/// The host must use current authenticated policy facts; scope alone is not authority.
pub trait PublicationAccess {
    /// Sharing a new audience is a separate native authorization, denied by default.
    fn check_publish_target(
        &self,
        caller: &IntegrationScope,
        owner: &KnowledgeOwner,
        draft: &PublicationDraft,
    ) -> Result<bool> {
        if draft.visibility != KnowledgeVisibility::Personal {
            return Ok(false);
        }
        self.check(
            caller,
            owner,
            &draft.publication_id,
            PublicationAction::Publish,
        )
    }
    fn check(
        &self,
        caller: &IntegrationScope,
        owner: &KnowledgeOwner,
        publication: &str,
        action: PublicationAction,
    ) -> Result<bool>;
}

/// Native provider contract, not a page-body field in a public request.
pub trait PublicationSourceResolver {
    fn resolve_fixed_pages(
        &self,
        caller: &IntegrationScope,
        sources: &[PublicationSource],
    ) -> Result<Vec<PublishedKnowledgePage>>;
}
/// A memory-only source proof. Caller JSON cannot construct or deserialize it.
pub struct VerifiedPublicationSources {
    scope: IntegrationScope,
    sources: Vec<PublicationSource>,
    pages: Vec<PublishedKnowledgePage>,
}
impl VerifiedPublicationSources {
    fn from_native_pages(
        scope: &IntegrationScope,
        draft: &PublicationDraft,
        pages: Vec<PublishedKnowledgePage>,
    ) -> Result<Self> {
        scope.validate()?;
        validate_draft(draft)?;
        ensure!(
            pages.len() == draft.sources.len(),
            "KNOWLEDGE_NATIVE_SOURCE_MISMATCH"
        );
        let mut total = 0usize;
        for (page, source) in pages.iter().zip(&draft.sources) {
            ensure!(
                &page.source == source && !page.title.trim().is_empty() && page.title.len() <= 512,
                "KNOWLEDGE_NATIVE_SOURCE_MISMATCH"
            );
            total = total
                .checked_add(page.markdown.len())
                .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_PUBLICATION_TOO_LARGE"))?;
            ensure!(total <= 2 * 1024 * 1024, "KNOWLEDGE_PUBLICATION_TOO_LARGE");
        }
        Ok(Self {
            scope: scope.clone(),
            sources: draft.sources.clone(),
            pages,
        })
    }
}

impl KnowledgeCatalog {
    pub fn resolve_publication_sources(
        scope: &IntegrationScope,
        draft: &PublicationDraft,
        resolver: &dyn PublicationSourceResolver,
    ) -> Result<VerifiedPublicationSources> {
        scope.validate()?;
        validate_draft(draft)?;
        VerifiedPublicationSources::from_native_pages(
            scope,
            draft,
            resolver.resolve_fixed_pages(scope, &draft.sources)?,
        )
    }
    /// Explicit new-store initialization, never an observer or a missing-table repair path.
    pub fn initialize_native_publication_schema(&self) -> Result<()> {
        self.initialize_publications()
    }
    fn publications_initialized(&self) -> Result<bool> {
        let names = [
            "integration_publication_meta",
            "integration_publications",
            "integration_publication_receipts",
            "integration_publication_fts",
        ];
        let mut present = 0;
        for name in names {
            let exists: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
                [name],
                |r| r.get(0),
            )?;
            present += usize::from(exists);
        }
        if present == 0 {
            return Ok(false);
        }
        ensure!(
            present == names.len(),
            "KNOWLEDGE_PUBLICATION_STORAGE_CORRUPT"
        );
        let (count, version): (u64, Option<i64>) = self.connection.query_row(
            "SELECT COUNT(*), MIN(version) FROM integration_publication_meta",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        ensure!(count == 1, "KNOWLEDGE_PUBLICATION_STORAGE_CORRUPT");
        ensure!(
            version == Some(1),
            "KNOWLEDGE_PUBLICATION_SCHEMA_UNSUPPORTED"
        );
        Ok(true)
    }
    fn verify_publications(&self) -> Result<()> {
        ensure!(
            self.publications_initialized()?,
            "KNOWLEDGE_PUBLICATION_NOT_INITIALIZED"
        );
        Ok(())
    }
    /// Schema creation belongs only to explicit publication, never a display read.
    fn initialize_publications(&self) -> Result<()> {
        if self.publications_initialized()? {
            return Ok(());
        }
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE integration_publication_meta(version INTEGER NOT NULL);
             INSERT INTO integration_publication_meta VALUES(1);
             CREATE TABLE integration_publications(
               owner_key TEXT NOT NULL, publication_id TEXT NOT NULL, version INTEGER NOT NULL,
               body_json TEXT NOT NULL, body_hash TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY(owner_key,publication_id,version));
             CREATE TABLE integration_publication_receipts(
               actor_key TEXT NOT NULL, operation_id TEXT NOT NULL, intent_json TEXT NOT NULL,
               result_json TEXT NOT NULL, PRIMARY KEY(actor_key,operation_id));
             CREATE VIRTUAL TABLE integration_publication_fts USING fts5(
               owner_key UNINDEXED,publication_id UNINDEXED,version UNINDEXED,page_index UNINDEXED,
               title_terms,body_terms,tokenize='unicode61');",
        )?;
        tx.commit()
            .map_err(|_| anyhow::anyhow!("KNOWLEDGE_PUBLICATION_WRITE_UNCONFIRMED"))?;
        Ok(())
    }
    /// Materializes only verified, fixed Wiki page revisions. No caller-supplied page body.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_knowledge(
        &mut self,
        native_scope: &KnowledgeScope,
        scope: &IntegrationScope,
        operation: &str,
        expected_version: u64,
        draft: PublicationDraft,
        access: &dyn PublicationAccess,
        now_ms: u64,
    ) -> Result<KnowledgePublication> {
        scope.validate()?;
        ensure!(
            native_scope.principal == scope.account_id && native_scope.target == scope.target_id,
            "KNOWLEDGE_NATIVE_SCOPE_MISMATCH"
        );
        validate_draft(&draft)?;
        let owner = KnowledgeOwner::from(scope);
        authorize(
            access,
            scope,
            &owner,
            &draft.publication_id,
            PublicationAction::Publish,
        )?;
        ensure!(
            access.check_publish_target(scope, &owner, &draft)?,
            "KNOWLEDGE_AUDIENCE_DENIED"
        );
        let pages = draft
            .sources
            .iter()
            .map(|source| {
                let page = self.read_page(
                    native_scope,
                    &source.library_id,
                    &source.page_id,
                    Some(&source.page_revision),
                )?;
                Ok(PublishedKnowledgePage {
                    source: source.clone(),
                    title: page.draft.title,
                    markdown: page.draft.markdown,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let resolved = VerifiedPublicationSources::from_native_pages(scope, &draft, pages)?;
        self.publish_resolved_knowledge(
            scope,
            operation,
            expected_version,
            draft,
            &resolved,
            access,
            now_ms,
        )
    }

    /// The native host has already resolved real fixed sources under its actual legacy Wiki authority.
    #[allow(clippy::too_many_arguments)]
    pub fn publish_resolved_knowledge(
        &mut self,
        scope: &IntegrationScope,
        operation: &str,
        expected_version: u64,
        draft: PublicationDraft,
        resolved: &VerifiedPublicationSources,
        access: &dyn PublicationAccess,
        now_ms: u64,
    ) -> Result<KnowledgePublication> {
        scope.validate()?;
        validate_id(operation)?;
        validate_draft(&draft)?;
        ensure!(
            resolved.scope == *scope && resolved.sources == draft.sources,
            "KNOWLEDGE_NATIVE_SOURCE_MISMATCH"
        );
        let owner = KnowledgeOwner::from(scope);
        authorize(
            access,
            scope,
            &owner,
            &draft.publication_id,
            PublicationAction::Publish,
        )?;
        ensure!(
            access.check_publish_target(scope, &owner, &draft)?,
            "KNOWLEDGE_AUDIENCE_DENIED"
        );
        self.initialize_publications()?;
        let actor_key = serde_json::to_string(&owner)?;
        let intent = serde_json::to_string(
            &json!({"action":"publish","expectedVersion":expected_version,"draft":draft}),
        )?;
        if let Some((old_intent,result)) = self.connection.query_row(
            "SELECT intent_json,result_json FROM integration_publication_receipts WHERE actor_key=?1 AND operation_id=?2",
            params![actor_key,operation], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()? {
            ensure!(old_intent == intent, "KNOWLEDGE_OPERATION_CONFLICT");
            return Ok(serde_json::from_str(&result)?);
        }
        let pages = resolved.pages.clone();
        authorize(
            access,
            scope,
            &owner,
            &draft.publication_id,
            PublicationAction::Publish,
        )?;
        ensure!(
            access.check_publish_target(scope, &owner, &draft)?,
            "KNOWLEDGE_AUDIENCE_DENIED"
        );
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if let Some((old_intent,result)) = tx.query_row(
            "SELECT intent_json,result_json FROM integration_publication_receipts WHERE actor_key=?1 AND operation_id=?2",
            params![actor_key,operation], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()? {
            ensure!(old_intent == intent, "KNOWLEDGE_OPERATION_CONFLICT");
            return Ok(serde_json::from_str(&result)?);
        }
        let current: u64 = tx.query_row("SELECT COALESCE(MAX(version),0) FROM integration_publications WHERE owner_key=?1 AND publication_id=?2",
            params![actor_key,draft.publication_id], |r|r.get(0))?;
        ensure!(
            current == expected_version,
            "KNOWLEDGE_PUBLICATION_REVISION_CONFLICT"
        );
        index_rows::initialize_writer(&tx)?;
        let version = current
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_VERSION_EXHAUSTED"))?;
        let result = KnowledgePublication {
            owner,
            publisher_role: Some(
                match draft.visibility {
                    KnowledgeVisibility::Personal => "personal_owner",
                    KnowledgeVisibility::Project => "authorized_project_publisher",
                    KnowledgeVisibility::Department => "authorized_department_publisher",
                    KnowledgeVisibility::Organization => "authorized_organization_publisher",
                }
                .into(),
            ),
            version,
            draft,
            pages,
            published_at_ms: now_ms,
            revoked: false,
        };
        let body = serde_json::to_string(&result)?;
        ensure!(body.len() <= 512 * 1024, "KNOWLEDGE_PUBLICATION_TOO_LARGE");
        let hash = crate::objects::digest(body.as_bytes());
        tx.execute(
            "INSERT INTO integration_publications VALUES(?1,?2,?3,?4,?5,0)",
            params![actor_key, result.draft.publication_id, version, body, hash],
        )?;
        for (index, page) in result.pages.iter().enumerate() {
            let title = crate::search::tokenize(&page.title).join(" ");
            let terms = crate::search::tokenize(&page.markdown).join(" ");
            tx.execute("INSERT INTO integration_publication_fts(owner_key,publication_id,version,page_index,title_terms,body_terms) VALUES(?1,?2,?3,?4,?5,?6)",
                params![actor_key,result.draft.publication_id,version,index as i64,title,terms])?;
            index_rows::insert(
                &tx,
                &actor_key,
                &result.draft.publication_id,
                version,
                index,
            )?;
        }
        tx.execute(
            "INSERT INTO integration_publication_receipts VALUES(?1,?2,?3,?4)",
            params![actor_key, operation, intent, body],
        )?;
        authorize(
            access,
            scope,
            &result.owner,
            &result.draft.publication_id,
            PublicationAction::Publish,
        )?;
        ensure!(
            access.check_publish_target(scope, &result.owner, &result.draft)?,
            "KNOWLEDGE_AUDIENCE_DENIED"
        );
        tx.commit()
            .map_err(|_| anyhow::anyhow!("KNOWLEDGE_PUBLICATION_WRITE_UNCONFIRMED"))?;
        Ok(result)
    }
    pub fn resolve_publication(
        &self,
        scope: &IntegrationScope,
        owner: &KnowledgeOwner,
        id: &str,
        version: Option<u64>,
        access: &dyn PublicationAccess,
        now_ms: u64,
    ) -> Result<KnowledgePublication> {
        scope.validate()?;
        validate_id(id)?;
        authorize(access, scope, owner, id, PublicationAction::Read)?;
        self.verify_publications()?;
        let key = serde_json::to_string(owner)?;
        let row: Option<(String,String,bool,u64)> = self.connection.query_row(
            "SELECT body_json,body_hash,revoked,version FROM integration_publications WHERE owner_key=?1 AND publication_id=?2 AND (?3 IS NULL OR version=?3) ORDER BY version DESC LIMIT 1",
            params![key,id,version],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let (body, hash, revoked, row_version) =
            row.ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_PUBLICATION_NOT_FOUND"))?;
        ensure!(!revoked, "KNOWLEDGE_PUBLICATION_REVOKED");
        ensure!(body.len() <= 512 * 1024, "KNOWLEDGE_PUBLICATION_TOO_LARGE");
        ensure!(
            crate::objects::digest(body.as_bytes()) == hash,
            "KNOWLEDGE_PUBLICATION_CORRUPT"
        );
        let result: KnowledgePublication = serde_json::from_str(&body)?;
        ensure!(
            &result.owner == owner
                && result.draft.publication_id == id
                && result.version == row_version,
            "KNOWLEDGE_PUBLICATION_IDENTITY_MISMATCH"
        );
        ensure!(
            result.draft.valid_from_ms.is_none_or(|t| now_ms >= t),
            "KNOWLEDGE_PUBLICATION_NOT_EFFECTIVE"
        );
        ensure!(
            result.draft.valid_until_ms.is_none_or(|t| now_ms < t),
            "KNOWLEDGE_PUBLICATION_EXPIRED"
        );
        authorize(access, scope, owner, id, PublicationAction::Read)?;
        Ok(result)
    }
    pub fn revoke_publication(
        &mut self,
        scope: &IntegrationScope,
        owner: &KnowledgeOwner,
        id: &str,
        version: u64,
        operation: &str,
        access: &dyn PublicationAccess,
    ) -> Result<()> {
        scope.validate()?;
        validate_id(operation)?;
        validate_id(id)?;
        authorize(access, scope, owner, id, PublicationAction::Revoke)?;
        self.verify_publications()?;
        let actor_key = serde_json::to_string(&KnowledgeOwner::from(scope))?;
        let key = serde_json::to_string(owner)?;
        let intent = serde_json::to_string(
            &json!({"action":"revoke","owner":owner,"id":id,"version":version}),
        )?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if let Some(old) = tx.query_row("SELECT intent_json FROM integration_publication_receipts WHERE actor_key=?1 AND operation_id=?2",params![actor_key,operation],|r|r.get::<_,String>(0)).optional()? {
            ensure!(old == intent, "KNOWLEDGE_OPERATION_CONFLICT"); return Ok(());
        }
        ensure!(tx.execute("UPDATE integration_publications SET revoked=1 WHERE owner_key=?1 AND publication_id=?2 AND version=?3",params![key,id,version])? == 1, "KNOWLEDGE_PUBLICATION_NOT_FOUND");
        tx.execute(
            "INSERT INTO integration_publication_receipts VALUES(?1,?2,?3,'null')",
            params![actor_key, operation, intent],
        )?;
        authorize(access, scope, owner, id, PublicationAction::Revoke)?;
        tx.commit()
            .map_err(|_| anyhow::anyhow!("KNOWLEDGE_PUBLICATION_WRITE_UNCONFIRMED"))?;
        Ok(())
    }
    /// Searches only the explicitly selected, authorized publication version.
    #[allow(clippy::too_many_arguments)]
    pub fn retrieve_publication(
        &self,
        scope: &IntegrationScope,
        owner: &KnowledgeOwner,
        id: &str,
        version: u64,
        query: &str,
        limit: usize,
        access: &dyn PublicationAccess,
        now_ms: u64,
    ) -> Result<KnowledgeRetrieval> {
        ensure!(
            !query.trim().is_empty() && query.len() <= 4096,
            "KNOWLEDGE_INVALID_QUERY"
        );
        ensure!((1..=20).contains(&limit), "KNOWLEDGE_INVALID_LIMIT");
        let publication =
            self.resolve_publication(scope, owner, id, Some(version), access, now_ms)?;
        let terms: Vec<_> = crate::search::tokenize(query)
            .into_iter()
            .take(32)
            .collect();
        ensure!(!terms.is_empty(), "KNOWLEDGE_QUERY_HAS_NO_TERMS");
        let expression = terms
            .iter()
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" OR ");
        self.verify_publication_index(&publication)?;
        let key = serde_json::to_string(owner)?;
        let sql = if index_rows::exists(&self.connection)? {
            "SELECT integration_publication_fts.page_index FROM integration_publication_index_rows m CROSS JOIN integration_publication_fts WHERE m.owner_key=?2 AND m.publication_id=?3 AND m.version=?4 AND integration_publication_fts.rowid=m.fts_rowid AND integration_publication_fts MATCH ?1 ORDER BY bm25(integration_publication_fts) LIMIT ?5"
        } else {
            "SELECT page_index FROM integration_publication_fts WHERE integration_publication_fts MATCH ?1 AND owner_key=?2 AND publication_id=?3 AND version=?4 ORDER BY bm25(integration_publication_fts) LIMIT ?5"
        };
        let mut statement = self.connection.prepare(sql)?;
        let indices = statement
            .query_map(params![expression, key, id, version, limit as i64], |row| {
                row.get::<_, usize>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut hits = Vec::new();
        for index in indices {
            let page = publication
                .pages
                .get(index)
                .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_INDEX_STALE"))?;
            hits.push(PublicationHit {
                publication_id: id.into(),
                version,
                source: page.source.clone(),
                title: page.title.clone(),
                excerpt: excerpt(&page.markdown, &terms),
            });
        }
        authorize(access, scope, owner, id, PublicationAction::Read)?;
        Ok(KnowledgeRetrieval {
            outcome: if hits.is_empty() {
                KnowledgeRetrievalOutcome::NoMatch
            } else {
                KnowledgeRetrievalOutcome::Matched
            },
            hits,
            observed_at_ms: now_ms,
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn read_publication_citation(
        &self,
        scope: &IntegrationScope,
        owner: &KnowledgeOwner,
        id: &str,
        version: u64,
        source: &kcoder_types::integrations::knowledge::PublicationSource,
        access: &dyn PublicationAccess,
        now_ms: u64,
    ) -> Result<PublishedKnowledgePage> {
        authorize(access, scope, owner, id, PublicationAction::ReadCitation)?;
        let publication =
            self.resolve_publication(scope, owner, id, Some(version), access, now_ms)?;
        let page = publication
            .pages
            .into_iter()
            .find(|p| &p.source == source)
            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_CITATION_NOT_FOUND"))?;
        authorize(access, scope, owner, id, PublicationAction::ReadCitation)?;
        Ok(page)
    }
    pub fn list_publications(
        &self,
        scope: &IntegrationScope,
        access: &dyn PublicationAccess,
        after: Option<&str>,
        now_ms: u64,
    ) -> Result<KnowledgePage<KnowledgePublication>> {
        self.list_publication_directory(scope, access, after, now_ms, None)
    }

    /// The authenticated host fixes the publisher owner. Caller identity stays
    /// unchanged even when its native target differs from the publisher's target.
    pub fn list_shared_native_publications(
        &self,
        caller: &IntegrationScope,
        publisher: &KnowledgeOwner,
        access: &dyn PublicationAccess,
        after: Option<&str>,
        now_ms: u64,
    ) -> Result<KnowledgePage<KnowledgePublication>> {
        ensure!(
            (publisher.account_id != caller.account_id
                || same_account_other_workspace(publisher, caller))
                && publisher.organization_id == caller.organization_id
                && matches!(
                    publisher.organization_id,
                    Some(kcoder_types::integrations::core::IntegrationNullable::Value(_))
                ),
            "KNOWLEDGE_RESOURCE_DENIED"
        );
        self.list_publication_directory(caller, access, after, now_ms, Some(publisher))
    }

    fn list_publication_directory(
        &self,
        scope: &IntegrationScope,
        access: &dyn PublicationAccess,
        after: Option<&str>,
        now_ms: u64,
        shared_owner: Option<&KnowledgeOwner>,
    ) -> Result<KnowledgePage<KnowledgePublication>> {
        scope.validate()?;
        self.verify_publications()?;
        if let Some(cursor) = after {
            validate_id(cursor)?;
        }
        let mut statement=self.connection.prepare("SELECT owner_key,publication_id,version FROM integration_publications p WHERE p.version=(SELECT MAX(q.version) FROM integration_publications q WHERE q.owner_key=p.owner_key AND q.publication_id=p.publication_id) AND p.revoked=0 ORDER BY p.owner_key,p.publication_id LIMIT 10001")?;
        let metadata = statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, u64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(metadata.len() <= 10_000, "KNOWLEDGE_PUBLICATION_CAPACITY");
        // Order only metadata before materializing bodies; large catalogs cannot load all pages.
        let mut ordered = metadata
            .into_iter()
            .map(|(key, id, version)| {
                let cursor = Self::publication_listing_cursor(&serde_json::from_str(&key)?, &id)?;
                Ok((cursor, key, id, version))
            })
            .collect::<Result<Vec<_>>>()?;
        ordered.sort_by(|a, b| a.0.cmp(&b.0));
        let mut items = Vec::new();
        let mut encoded_bytes = 0usize;
        let mut has_more = false;
        for (cursor, owner_key, id, version) in ordered {
            if after.is_some_and(|value| cursor.as_str() <= value) {
                continue;
            }
            let owner: KnowledgeOwner = serde_json::from_str(&owner_key)?;
            if shared_owner.map_or(owner.target_id != scope.target_id, |expected| {
                &owner != expected
            }) || !access.check(scope, &owner, &id, PublicationAction::Read)?
            {
                continue;
            }
            let record =
                match self.resolve_publication(scope, &owner, &id, Some(version), access, now_ms) {
                    Ok(record) => record,
                    Err(error)
                        if matches!(
                            error.to_string().as_str(),
                            "KNOWLEDGE_PUBLICATION_NOT_EFFECTIVE" | "KNOWLEDGE_PUBLICATION_EXPIRED"
                        ) =>
                    {
                        continue;
                    }
                    Err(error) => return Err(error),
                };
            if shared_owner.is_some()
                && (record.draft.visibility == KnowledgeVisibility::Personal
                    || record
                        .draft
                        .audience_id
                        .as_ref()
                        .is_none_or(|id| id.is_empty()))
            {
                continue;
            }
            let bytes = serde_json::to_vec(&record)?.len();
            ensure!(bytes <= 512 * 1024, "KNOWLEDGE_PUBLICATION_TOO_LARGE");
            if items.len() == 10 || encoded_bytes.saturating_add(bytes) > 768 * 1024 - 4096 {
                has_more = true;
                break;
            }
            encoded_bytes += bytes;
            items.push((cursor, record));
        }
        let next_cursor = if has_more {
            items.last().map(|v| v.0.clone())
        } else {
            None
        };
        Ok(KnowledgePage {
            items: items.into_iter().map(|v| v.1).collect(),
            next_cursor,
        })
    }

    /// Shared ordering for a native directory spanning independently owned catalogs.
    pub fn publication_listing_cursor(owner: &KnowledgeOwner, id: &str) -> Result<String> {
        let owner_key = serde_json::to_string(owner)?;
        Ok(crate::objects::digest(
            serde_json::to_string(&(&owner_key, id))?.as_bytes(),
        ))
    }

    /// Bind pagination to effective-date transitions without freezing access at an old clock.
    /// Only bounded latest-version metadata is materialized; no page body leaves this query.
    pub fn publication_listing_time_epoch(&self, now_ms: u64) -> Result<String> {
        self.publication_listing_time_snapshot(now_ms)
            .map(|(epoch, _)| epoch)
    }

    /// Earliest future validity transition binds a whole native directory snapshot.
    pub fn publication_listing_time_snapshot(&self, now_ms: u64) -> Result<(String, Option<u64>)> {
        use sha2::{Digest, Sha256};
        self.verify_publications()?;
        let mut query = self.connection.prepare(
            "SELECT owner_key,publication_id,version,
             (json_extract(body_json,'$.draft.validFromMs') IS NULL OR json_extract(body_json,'$.draft.validFromMs')<=?1),
             (json_extract(body_json,'$.draft.validUntilMs') IS NULL OR json_extract(body_json,'$.draft.validUntilMs')>?1),
             json_extract(body_json,'$.draft.validFromMs'),json_extract(body_json,'$.draft.validUntilMs')
             FROM integration_publications p WHERE p.version=(SELECT MAX(q.version) FROM integration_publications q WHERE q.owner_key=p.owner_key AND q.publication_id=p.publication_id) AND p.revoked=0 ORDER BY owner_key,publication_id LIMIT 10001",
        )?;
        let mut digest = Sha256::new();
        let mut next = None;
        for (index, row) in query
            .query_map([now_ms], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, bool>(4)?,
                    row.get::<_, Option<u64>>(5)?,
                    row.get::<_, Option<u64>>(6)?,
                ))
            })?
            .enumerate()
        {
            ensure!(index < 10_000, "KNOWLEDGE_PUBLICATION_CAPACITY");
            let row = row?;
            for transition in [row.5, row.6]
                .into_iter()
                .flatten()
                .filter(|time| *time > now_ms)
            {
                next = Some(next.map_or(transition, |old: u64| old.min(transition)));
            }
            digest.update(serde_json::to_vec(&row)?);
        }
        Ok((format!("{:x}", digest.finalize()), next))
    }
}
fn authorize(
    access: &dyn PublicationAccess,
    scope: &IntegrationScope,
    owner: &KnowledgeOwner,
    id: &str,
    action: PublicationAction,
) -> Result<()> {
    ensure!(
        access.check(scope, owner, id, action)?,
        "KNOWLEDGE_RESOURCE_DENIED"
    );
    Ok(())
}
fn validate_id(value: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.chars().count() <= 256,
        "KNOWLEDGE_INVALID_ID"
    );
    Ok(())
}
fn validate_draft(draft: &PublicationDraft) -> Result<()> {
    for text in [&draft.purpose, &draft.review_conclusion]
        .into_iter()
        .flatten()
    {
        ensure!(
            !text.trim().is_empty() && text.len() <= 4096,
            "KNOWLEDGE_INVALID_PUBLICATION_METADATA"
        );
    }
    validate_id(&draft.publication_id)?;
    ensure!(
        !draft.title.trim().is_empty() && draft.title.len() <= 512,
        "KNOWLEDGE_INVALID_TITLE"
    );
    ensure!(
        !draft.sources.is_empty() && draft.sources.len() <= 64,
        "KNOWLEDGE_SOURCE_REQUIRED"
    );
    ensure!(
        draft.unresolved.len() <= 64 && draft.unresolved.iter().all(|v| v.len() <= 2048),
        "KNOWLEDGE_INVALID_UNRESOLVED"
    );
    ensure!(
        draft
            .valid_from_ms
            .zip(draft.valid_until_ms)
            .is_none_or(|(a, b)| a < b),
        "KNOWLEDGE_INVALID_VALIDITY"
    );
    if matches!(
        draft.visibility,
        KnowledgeVisibility::Department | KnowledgeVisibility::Organization
    ) {
        ensure!(
            draft
                .audience_id
                .as_ref()
                .is_some_and(|s| !s.trim().is_empty() && s.len() <= 256),
            "KNOWLEDGE_AUDIENCE_REQUIRED"
        );
    }
    let mut seen = std::collections::BTreeSet::new();
    for source in &draft.sources {
        validate_id(&source.library_id)?;
        validate_id(&source.page_id)?;
        validate_id(&source.page_revision)?;
        ensure!(
            seen.insert(serde_json::to_string(source)?),
            "KNOWLEDGE_DUPLICATE_SOURCE"
        );
    }
    Ok(())
}
fn excerpt(body: &str, terms: &[String]) -> String {
    let at = terms
        .iter()
        .filter_map(|term| body.find(term))
        .min()
        .unwrap_or(0);
    let offset = body[..at].chars().count().saturating_sub(80);
    body.chars().skip(offset).take(600).collect()
}

#[cfg(test)]
mod tests;

mod index;
mod index_rows;
pub use index::{OptionalIndexIdentity, PublicationIndexHealth};

mod adoptions;
pub use adoptions::PublicationReferenceResolver;
mod history;
