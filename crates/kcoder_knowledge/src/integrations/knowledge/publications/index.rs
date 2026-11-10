use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicationIndexHealth {
    pub page_count: usize,
    pub indexed_pages: usize,
    pub ready: bool,
}
/// Optional derived indexes are reusable only for an exact source, backend and model identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OptionalIndexIdentity {
    pub publication_digest: String,
    pub backend_revision: String,
    pub model_fingerprint: Option<String>,
    pub dimensions: Option<usize>,
}
impl OptionalIndexIdentity {
    pub fn may_reuse_for(&self, requested: &Self) -> bool {
        !self.publication_digest.is_empty()
            && !self.backend_revision.is_empty()
            && self
                .model_fingerprint
                .as_ref()
                .is_none_or(|id| !id.is_empty())
            && self.dimensions.is_none_or(|dimension| dimension > 0)
            && self == requested
    }
}
impl KnowledgeCatalog {
    /// Validates stored lexical terms against immutable source pages before trusting no-match.
    pub(super) fn verify_publication_index(
        &self,
        publication: &KnowledgePublication,
    ) -> Result<usize> {
        let key = serde_json::to_string(&publication.owner)?;
        let rows = if super::index_rows::exists(&self.connection)? {
            super::index_rows::rows(&self.connection, publication)?
        } else {
            let mut statement=self.connection.prepare("SELECT page_index,title_terms,body_terms FROM integration_publication_fts WHERE owner_key=?1 AND publication_id=?2 AND version=?3 ORDER BY page_index")?;
            statement
                .query_map(
                    params![key, publication.draft.publication_id, publication.version],
                    |r| {
                        Ok((
                            r.get::<_, usize>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ))
                    },
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        ensure!(
            rows.len() == publication.pages.len(),
            "KNOWLEDGE_INDEX_STALE"
        );
        for (expected, (index, title, body)) in rows.iter().enumerate() {
            ensure!(*index == expected, "KNOWLEDGE_INDEX_STALE");
            let page = &publication.pages[expected];
            ensure!(
                *title == crate::search::tokenize(&page.title).join(" ")
                    && *body == crate::search::tokenize(&page.markdown).join(" "),
                "KNOWLEDGE_INDEX_STALE"
            );
        }
        Ok(rows.len())
    }
    pub fn inspect_publication_index(
        &self,
        scope: &IntegrationScope,
        owner: &KnowledgeOwner,
        id: &str,
        version: u64,
        access: &dyn PublicationAccess,
        now_ms: u64,
    ) -> Result<PublicationIndexHealth> {
        let publication =
            self.resolve_publication(scope, owner, id, Some(version), access, now_ms)?;
        let sql = if super::index_rows::exists(&self.connection)? {
            "SELECT COUNT(*) FROM integration_publication_index_rows m JOIN integration_publication_fts f ON f.rowid=m.fts_rowid WHERE m.owner_key=?1 AND m.publication_id=?2 AND m.version=?3"
        } else {
            "SELECT COUNT(*) FROM integration_publication_fts WHERE owner_key=?1 AND publication_id=?2 AND version=?3"
        };
        let indexed: usize = self.connection.query_row(
            sql,
            params![serde_json::to_string(owner)?, id, version],
            |r| r.get(0),
        )?;
        Ok(PublicationIndexHealth {
            page_count: publication.pages.len(),
            indexed_pages: indexed,
            ready: match self.verify_publication_index(&publication) {
                Ok(_) => true,
                Err(error) if error.to_string() == "KNOWLEDGE_INDEX_STALE" => false,
                Err(error) => return Err(error),
            },
        })
    }
    /// Explicit repair of derived rows, never a schema or publication-body recovery mechanism.
    #[allow(clippy::too_many_arguments)]
    pub fn rebuild_publication_index(
        &mut self,
        scope: &IntegrationScope,
        owner: &KnowledgeOwner,
        id: &str,
        version: u64,
        operation: &str,
        access: &dyn PublicationAccess,
        now_ms: u64,
    ) -> Result<PublicationIndexHealth> {
        validate_id(operation)?;
        authorize(access, scope, owner, id, PublicationAction::Publish)?;
        let publication =
            self.resolve_publication(scope, owner, id, Some(version), access, now_ms)?;
        ensure!(
            access.check_publish_target(scope, owner, &publication.draft)?,
            "KNOWLEDGE_AUDIENCE_DENIED"
        );
        let key = serde_json::to_string(owner)?;
        let actor = serde_json::to_string(&KnowledgeOwner::from(scope))?;
        let intent = serde_json::to_string(
            &json!({"action":"rebuild_lexical_index","owner":owner,"publicationId":id,"version":version}),
        )?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if let Some(previous)=tx.query_row("SELECT intent_json FROM integration_publication_receipts WHERE actor_key=?1 AND operation_id=?2",params![actor,operation],|r|r.get::<_,String>(0)).optional()? {
            ensure!(previous==intent,"KNOWLEDGE_OPERATION_CONFLICT");
            drop(tx);
            return self.inspect_publication_index(scope,owner,id,version,access,now_ms);
        }
        super::index_rows::initialize_writer(&tx)?;
        super::index_rows::clear(&tx, &key, id, version)?;
        tx.execute("DELETE FROM integration_publication_fts WHERE owner_key=?1 AND publication_id=?2 AND version=?3",params![key,id,version])?;
        for (index, page) in publication.pages.iter().enumerate() {
            tx.execute("INSERT INTO integration_publication_fts(owner_key,publication_id,version,page_index,title_terms,body_terms) VALUES(?1,?2,?3,?4,?5,?6)",params![key,id,version,index as i64,crate::search::tokenize(&page.title).join(" "),crate::search::tokenize(&page.markdown).join(" ")])?;
            super::index_rows::insert(&tx, &key, id, version, index)?;
        }
        authorize(access, scope, owner, id, PublicationAction::Publish)?;
        ensure!(
            access.check_publish_target(scope, owner, &publication.draft)?,
            "KNOWLEDGE_AUDIENCE_DENIED"
        );
        tx.execute(
            "INSERT INTO integration_publication_receipts VALUES(?1,?2,?3,?4)",
            params![actor, operation, intent, "{\"rebuilt\":true}"],
        )?;
        tx.commit()
            .map_err(|_| anyhow::anyhow!("KNOWLEDGE_PUBLICATION_WRITE_UNCONFIRMED"))?;
        self.inspect_publication_index(scope, owner, id, version, access, now_ms)
    }
}
impl KnowledgeCatalog {
    /// Export preparation performs a fresh body authorization; it neither writes files nor sends data.
    #[allow(clippy::too_many_arguments)]
    pub fn export_publication_markdown(
        &self,
        scope: &IntegrationScope,
        owner: &KnowledgeOwner,
        id: &str,
        version: u64,
        access: &dyn PublicationAccess,
        now_ms: u64,
    ) -> Result<String> {
        let publication =
            self.resolve_publication(scope, owner, id, Some(version), access, now_ms)?;
        let mut output = format!(
            "# {}\n\nPublication version: {}\n",
            publication.draft.title, publication.version
        );
        for page in &publication.pages {
            output.push_str(&format!(
                "\n## {}\n\n{}\n\nSource revision: {}\n",
                page.title, page.markdown, page.source.page_revision
            ));
        }
        ensure!(
            output.len() <= 3 * 1024 * 1024,
            "KNOWLEDGE_PUBLICATION_TOO_LARGE"
        );
        authorize(access, scope, owner, id, PublicationAction::Read)?;
        Ok(output)
    }
}
