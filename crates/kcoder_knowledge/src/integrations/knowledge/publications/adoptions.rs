use super::*;
use kcoder_types::integrations::knowledge::KnowledgeAdoption;

/// An authenticated native source provider, never a caller-supplied publication body.
pub trait PublicationReferenceResolver {
    fn resolve_reference(
        &self,
        caller: &IntegrationScope,
        owner: &KnowledgeOwner,
        publication_id: &str,
        version: u64,
    ) -> Result<KnowledgePublication>;
}
fn legacy_owned_reference(caller: &IntegrationScope, owner: &KnowledgeOwner) -> bool {
    matches!(
        caller.organization_id,
        Some(kcoder_types::integrations::core::IntegrationNullable::Value(_))
    ) && owner.organization_id.is_none()
        && owner.account_id == caller.account_id
        && owner.target_id == caller.target_id
        && owner.workspace_id == caller.workspace_id
}
fn validate_external_reference(
    caller: &IntegrationScope,
    owner: &KnowledgeOwner,
    id: &str,
    version: u64,
    publication: &KnowledgePublication,
    now_ms: u64,
) -> Result<String> {
    ensure!(
        (legacy_owned_reference(caller, owner)
            || ((owner.account_id != caller.account_id
                || same_account_other_workspace(owner, caller))
                && owner.organization_id == caller.organization_id
                && matches!(
                    owner.organization_id,
                    Some(kcoder_types::integrations::core::IntegrationNullable::Value(_))
                )))
            && &publication.owner == owner
            && publication.draft.publication_id == id
            && publication.version == version
            && !publication.revoked
            && (legacy_owned_reference(caller, owner)
                || (publication.draft.visibility != KnowledgeVisibility::Personal
                    && publication.draft.audience_id.is_some()))
            && publication
                .draft
                .valid_from_ms
                .is_none_or(|time| now_ms >= time)
            && publication
                .draft
                .valid_until_ms
                .is_none_or(|time| now_ms < time),
        "KNOWLEDGE_RESOURCE_DENIED"
    );
    Ok(crate::objects::digest(&serde_json::to_vec(publication)?))
}
impl KnowledgeCatalog {
    /// Original adoption receipts prove selection only, never current source permission.
    /// The current enabled row must still match the caller's observed selection.
    pub fn has_recorded_publication_adoption(
        &self,
        scope: &IntegrationScope,
        current: &KnowledgeAdoption,
        version: u64,
    ) -> Result<bool> {
        scope.validate()?;
        ensure!(
            current.owner == KnowledgeOwner::from(scope) && version > 0,
            "KNOWLEDGE_NATIVE_SCOPE_MISMATCH"
        );
        if !self.adoptions_initialized()? || !current.enabled {
            return Ok(false);
        }
        let consumer = serde_json::to_string(&current.owner)?;
        let body: Option<String> = self.connection.query_row(
            "SELECT body_json FROM integration_knowledge_adoptions WHERE consumer_key=?1 AND adoption_id=?2",
            params![consumer, current.id], |row| row.get(0),
        ).optional()?;
        let Some(body) = body else {
            return Ok(false);
        };
        ensure!(
            serde_json::from_str::<KnowledgeAdoption>(&body)? == *current,
            "KNOWLEDGE_ADOPTION_REVISION_CONFLICT"
        );
        if current.publication_version == version {
            return Ok(true);
        }
        // Read the existing append-only action receipts; no migration or repair on read.
        let receipt: Option<(String, String)> = self.connection.query_row(
            "SELECT intent_json,result_json FROM integration_publication_receipts WHERE actor_key=?1 AND json_extract(intent_json,'$.action')='adopt' AND json_extract(result_json,'$.id')=?2 AND json_extract(result_json,'$.publicationVersion')=?3 LIMIT 1",
            params![consumer, current.id, version], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let Some((intent, result)) = receipt else {
            return Ok(false);
        };
        let recorded: KnowledgeAdoption = serde_json::from_str(&result)?;
        let intent: serde_json::Value = serde_json::from_str(&intent)?;
        ensure!(
            recorded.id == current.id
                && recorded.owner == current.owner
                && recorded.publication_owner == current.publication_owner
                && recorded.publication_id == current.publication_id
                && recorded.publication_version == version
                && recorded.enabled
                && recorded.revision > 0
                && recorded.revision <= current.revision
                && intent
                    == json!({"action":"adopt","publisher":current.publication_owner,
                "publicationId":current.publication_id,"version":version,
                "revision":recorded.revision - 1}),
            "KNOWLEDGE_ADOPTION_STORAGE_CORRUPT"
        );
        Ok(true)
    }

    fn adoptions_initialized(&self) -> Result<bool> {
        let present:u64=self.connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('integration_knowledge_adoption_meta','integration_knowledge_adoptions')",[],|r|r.get(0))?;
        if present == 0 {
            return Ok(false);
        }
        ensure!(present == 2, "KNOWLEDGE_ADOPTION_STORAGE_CORRUPT");
        let (count, version): (u64, Option<u64>) = self.connection.query_row(
            "SELECT COUNT(*),MIN(version) FROM integration_knowledge_adoption_meta",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        ensure!(
            count == 1 && version == Some(1),
            "KNOWLEDGE_ADOPTION_STORAGE_CORRUPT"
        );
        Ok(true)
    }
    fn initialize_adoptions(&self) -> Result<()> {
        if self.adoptions_initialized()? {
            return Ok(());
        }
        let tx = self.connection.unchecked_transaction()?;
        tx.execute_batch("CREATE TABLE integration_knowledge_adoption_meta(version INTEGER NOT NULL); INSERT INTO integration_knowledge_adoption_meta VALUES(1); CREATE TABLE integration_knowledge_adoptions(consumer_key TEXT NOT NULL,adoption_id TEXT NOT NULL,body_json TEXT NOT NULL,PRIMARY KEY(consumer_key,adoption_id));")?;
        tx.commit()
            .map_err(|_| anyhow::anyhow!("KNOWLEDGE_PUBLICATION_WRITE_UNCONFIRMED"))?;
        Ok(())
    }
    /// Explicit adoption pins a real readable version; later use always re-resolves current ACL.
    #[allow(clippy::too_many_arguments)]
    pub fn adopt_publication(
        &mut self,
        scope: &IntegrationScope,
        publisher: &KnowledgeOwner,
        id: &str,
        version: u64,
        operation: &str,
        expected_revision: u64,
        access: &dyn PublicationAccess,
        now_ms: u64,
    ) -> Result<KnowledgeAdoption> {
        scope.validate()?;
        validate_id(operation)?;
        authorize(access, scope, publisher, id, PublicationAction::Adopt)?;
        self.resolve_publication(scope, publisher, id, Some(version), access, now_ms)?;
        self.record_publication_adoption(
            scope,
            publisher,
            id,
            version,
            operation,
            expected_revision,
            access,
            now_ms,
            || Ok(()),
        )
    }

    /// The native resolver must read the publisher's real fixed source under current
    /// authority. Only the adoption reference and original operation receipt persist.
    #[allow(clippy::too_many_arguments)]
    pub fn adopt_external_publication(
        &mut self,
        scope: &IntegrationScope,
        publisher: &KnowledgeOwner,
        id: &str,
        version: u64,
        operation: &str,
        expected_revision: u64,
        access: &dyn PublicationAccess,
        resolver: &dyn PublicationReferenceResolver,
        now_ms: u64,
    ) -> Result<KnowledgeAdoption> {
        scope.validate()?;
        validate_id(operation)?;
        authorize(access, scope, publisher, id, PublicationAction::Adopt)?;
        authorize(access, scope, publisher, id, PublicationAction::Read)?;
        let first = resolver.resolve_reference(scope, publisher, id, version)?;
        let digest = validate_external_reference(scope, publisher, id, version, &first, now_ms)?;
        self.record_publication_adoption(
            scope,
            publisher,
            id,
            version,
            operation,
            expected_revision,
            access,
            now_ms,
            || {
                authorize(access, scope, publisher, id, PublicationAction::Read)?;
                let current = resolver.resolve_reference(scope, publisher, id, version)?;
                ensure!(
                    validate_external_reference(scope, publisher, id, version, &current, now_ms)?
                        == digest,
                    "KNOWLEDGE_PUBLICATION_IDENTITY_MISMATCH"
                );
                Ok(())
            },
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn record_publication_adoption(
        &mut self,
        scope: &IntegrationScope,
        publisher: &KnowledgeOwner,
        id: &str,
        version: u64,
        operation: &str,
        expected_revision: u64,
        access: &dyn PublicationAccess,
        now_ms: u64,
        mut verify_source: impl FnMut() -> Result<()>,
    ) -> Result<KnowledgeAdoption> {
        self.initialize_adoptions()?;
        let owner = KnowledgeOwner::from(scope);
        let consumer = serde_json::to_string(&owner)?;
        let key = crate::objects::digest(serde_json::to_string(&(publisher, id))?.as_bytes());
        let intent = serde_json::to_string(
            &json!({"action":"adopt","publisher":publisher,"publicationId":id,"version":version,"revision":expected_revision}),
        )?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if let Some((previous,result))=tx.query_row("SELECT intent_json,result_json FROM integration_publication_receipts WHERE actor_key=?1 AND operation_id=?2",params![consumer,operation],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()? {
            ensure!(previous==intent,"KNOWLEDGE_OPERATION_CONFLICT");verify_source()?;authorize(access,scope,publisher,id,PublicationAction::Adopt)?;return Ok(serde_json::from_str(&result)?);
        }
        let old=tx.query_row("SELECT body_json FROM integration_knowledge_adoptions WHERE consumer_key=?1 AND adoption_id=?2",params![consumer,key],|r|r.get::<_,String>(0)).optional()?.map(|body|serde_json::from_str::<KnowledgeAdoption>(&body)).transpose()?;
        ensure!(
            old.as_ref().map_or(0, |record| record.revision) == expected_revision,
            "KNOWLEDGE_ADOPTION_REVISION_CONFLICT"
        );
        let count: u64 = tx.query_row(
            "SELECT COUNT(*) FROM integration_knowledge_adoptions WHERE consumer_key=?1",
            [&consumer],
            |r| r.get(0),
        )?;
        ensure!(old.is_some() || count < 64, "KNOWLEDGE_ADOPTION_CAPACITY");
        let result = KnowledgeAdoption {
            id: key,
            owner,
            revision: expected_revision
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_VERSION_EXHAUSTED"))?,
            publication_owner: publisher.clone(),
            publication_id: id.into(),
            publication_version: version,
            enabled: true,
            adopted_at_ms: old.as_ref().map_or(now_ms, |record| record.adopted_at_ms),
            updated_at_ms: now_ms,
        };
        let body = serde_json::to_string(&result)?;
        tx.execute("INSERT INTO integration_knowledge_adoptions VALUES(?1,?2,?3) ON CONFLICT(consumer_key,adoption_id) DO UPDATE SET body_json=excluded.body_json",params![consumer,result.id,body])?;
        tx.execute(
            "INSERT INTO integration_publication_receipts VALUES(?1,?2,?3,?4)",
            params![consumer, operation, intent, body],
        )?;
        verify_source()?;
        authorize(access, scope, publisher, id, PublicationAction::Adopt)?;
        tx.commit()
            .map_err(|_| anyhow::anyhow!("KNOWLEDGE_PUBLICATION_WRITE_UNCONFIRMED"))?;
        Ok(result)
    }
    pub fn list_knowledge_adoptions(
        &self,
        scope: &IntegrationScope,
        after: Option<&str>,
    ) -> Result<KnowledgePage<KnowledgeAdoption>> {
        self.list_owned_catalog_adoptions(scope, &KnowledgeOwner::from(scope), after)
    }

    /// Read-only routing under an already-held native catalog. The data owner is
    /// not installed as the current caller, and grants no source/body permission.
    pub fn list_owned_catalog_adoptions(
        &self,
        scope: &IntegrationScope,
        data_owner: &KnowledgeOwner,
        after: Option<&str>,
    ) -> Result<KnowledgePage<KnowledgeAdoption>> {
        scope.validate()?;
        if !self.adoptions_initialized()? {
            return Ok(KnowledgePage {
                items: vec![],
                next_cursor: None,
            });
        }
        if let Some(after) = after {
            validate_id(after)?;
        }
        ensure!(
            *data_owner == KnowledgeOwner::from(scope) || legacy_owned_reference(scope, data_owner),
            "KNOWLEDGE_NATIVE_SCOPE_MISMATCH"
        );
        let owner = data_owner.clone();
        let consumer = serde_json::to_string(&owner)?;
        let mut query=self.connection.prepare("SELECT body_json FROM integration_knowledge_adoptions WHERE consumer_key=?1 AND adoption_id>?2 ORDER BY adoption_id LIMIT 11")?;
        let mut records = query
            .query_map(params![consumer, after.unwrap_or("")], |r| {
                r.get::<_, String>(0)
            })?
            .map(|body| Ok(serde_json::from_str::<KnowledgeAdoption>(&body?)?))
            .collect::<Result<Vec<_>>>()?;
        ensure!(
            records.iter().all(|record| record.owner == owner),
            "KNOWLEDGE_NATIVE_SCOPE_MISMATCH"
        );
        let more = records.len() > 10;
        records.truncate(10);
        let next_cursor = more.then(|| records.last().unwrap().id.clone());
        Ok(KnowledgePage {
            items: records,
            next_cursor,
        })
    }
    /// An adopted reference is not a cached permission: every resolution checks the original version.
    pub fn resolve_knowledge_adoption(
        &self,
        scope: &IntegrationScope,
        adoption_id: &str,
        access: &dyn PublicationAccess,
        now_ms: u64,
    ) -> Result<KnowledgePublication> {
        scope.validate()?;
        validate_id(adoption_id)?;
        ensure!(
            self.adoptions_initialized()?,
            "KNOWLEDGE_ADOPTION_NOT_FOUND"
        );
        let consumer = serde_json::to_string(&KnowledgeOwner::from(scope))?;
        let body:String=self.connection.query_row("SELECT body_json FROM integration_knowledge_adoptions WHERE consumer_key=?1 AND adoption_id=?2",params![consumer,adoption_id],|r|r.get(0)).optional()?.ok_or_else(||anyhow::anyhow!("KNOWLEDGE_ADOPTION_NOT_FOUND"))?;
        let adoption: KnowledgeAdoption = serde_json::from_str(&body)?;
        ensure!(
            adoption.owner == KnowledgeOwner::from(scope) && adoption.enabled,
            "KNOWLEDGE_ADOPTION_DISABLED"
        );
        self.resolve_publication(
            scope,
            &adoption.publication_owner,
            &adoption.publication_id,
            Some(adoption.publication_version),
            access,
            now_ms,
        )
    }
}
impl KnowledgeCatalog {
    #[allow(clippy::too_many_arguments)]
    pub fn set_knowledge_adoption_enabled(
        &mut self,
        scope: &IntegrationScope,
        adoption_id: &str,
        operation: &str,
        expected_revision: u64,
        enabled: bool,
        access: &dyn PublicationAccess,
        now_ms: u64,
    ) -> Result<KnowledgeAdoption> {
        self.set_adoption_enabled_inner(
            scope,
            adoption_id,
            operation,
            expected_revision,
            enabled,
            access,
            None,
            now_ms,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_external_adoption_enabled(
        &mut self,
        scope: &IntegrationScope,
        adoption_id: &str,
        operation: &str,
        expected_revision: u64,
        enabled: bool,
        access: &dyn PublicationAccess,
        resolver: &dyn PublicationReferenceResolver,
        now_ms: u64,
    ) -> Result<KnowledgeAdoption> {
        self.set_adoption_enabled_inner(
            scope,
            adoption_id,
            operation,
            expected_revision,
            enabled,
            access,
            Some(resolver),
            now_ms,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn set_adoption_enabled_inner(
        &mut self,
        scope: &IntegrationScope,
        adoption_id: &str,
        operation: &str,
        expected_revision: u64,
        enabled: bool,
        access: &dyn PublicationAccess,
        resolver: Option<&dyn PublicationReferenceResolver>,
        now_ms: u64,
    ) -> Result<KnowledgeAdoption> {
        scope.validate()?;
        validate_id(adoption_id)?;
        validate_id(operation)?;
        let owner = KnowledgeOwner::from(scope);
        authorize(
            access,
            scope,
            &owner,
            adoption_id,
            PublicationAction::ManageAdoption,
        )?;
        ensure!(
            self.adoptions_initialized()?,
            "KNOWLEDGE_ADOPTION_NOT_FOUND"
        );
        let consumer = serde_json::to_string(&owner)?;
        let body:String=self.connection.query_row("SELECT body_json FROM integration_knowledge_adoptions WHERE consumer_key=?1 AND adoption_id=?2",params![consumer,adoption_id],|r|r.get(0)).optional()?.ok_or_else(||anyhow::anyhow!("KNOWLEDGE_ADOPTION_NOT_FOUND"))?;
        let mut record: KnowledgeAdoption = serde_json::from_str(&body)?;
        ensure!(record.owner == owner, "KNOWLEDGE_NATIVE_SCOPE_MISMATCH");
        let publisher = record.publication_owner.clone();
        let publication_id = record.publication_id.clone();
        let publication_version = record.publication_version;
        let external_digest = if enabled {
            authorize(
                access,
                scope,
                &publisher,
                &publication_id,
                PublicationAction::Adopt,
            )?;
            if let Some(resolver) = resolver {
                authorize(
                    access,
                    scope,
                    &publisher,
                    &publication_id,
                    PublicationAction::Read,
                )?;
                let current = resolver.resolve_reference(
                    scope,
                    &publisher,
                    &publication_id,
                    publication_version,
                )?;
                Some(validate_external_reference(
                    scope,
                    &publisher,
                    &publication_id,
                    publication_version,
                    &current,
                    now_ms,
                )?)
            } else {
                self.resolve_publication(
                    scope,
                    &publisher,
                    &publication_id,
                    Some(publication_version),
                    access,
                    now_ms,
                )?;
                None
            }
        } else {
            None
        };
        let verify_external = || -> Result<()> {
            if let (Some(resolver), Some(expected)) = (resolver, &external_digest) {
                authorize(
                    access,
                    scope,
                    &publisher,
                    &publication_id,
                    PublicationAction::Read,
                )?;
                authorize(
                    access,
                    scope,
                    &publisher,
                    &publication_id,
                    PublicationAction::Adopt,
                )?;
                let current = resolver.resolve_reference(
                    scope,
                    &publisher,
                    &publication_id,
                    publication_version,
                )?;
                ensure!(
                    &validate_external_reference(
                        scope,
                        &publisher,
                        &publication_id,
                        publication_version,
                        &current,
                        now_ms
                    )? == expected,
                    "KNOWLEDGE_PUBLICATION_IDENTITY_MISMATCH"
                );
            }
            Ok(())
        };
        let intent = serde_json::to_string(
            &json!({"action":"set_adoption_enabled","id":adoption_id,"revision":expected_revision,"enabled":enabled}),
        )?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if let Some((previous,result))=tx.query_row("SELECT intent_json,result_json FROM integration_publication_receipts WHERE actor_key=?1 AND operation_id=?2",params![consumer,operation],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()? {ensure!(previous==intent,"KNOWLEDGE_OPERATION_CONFLICT");verify_external()?;return Ok(serde_json::from_str(&result)?);}
        let current:String=tx.query_row("SELECT body_json FROM integration_knowledge_adoptions WHERE consumer_key=?1 AND adoption_id=?2",params![consumer,adoption_id],|r|r.get(0))?;
        let current: KnowledgeAdoption = serde_json::from_str(&current)?;
        ensure!(
            current.revision == expected_revision && current == record,
            "KNOWLEDGE_ADOPTION_REVISION_CONFLICT"
        );
        record.enabled = enabled;
        record.revision = record
            .revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_VERSION_EXHAUSTED"))?;
        record.updated_at_ms = now_ms;
        let body = serde_json::to_string(&record)?;
        tx.execute("UPDATE integration_knowledge_adoptions SET body_json=?3 WHERE consumer_key=?1 AND adoption_id=?2",params![consumer,adoption_id,body])?;
        tx.execute(
            "INSERT INTO integration_publication_receipts VALUES(?1,?2,?3,?4)",
            params![consumer, operation, intent, body],
        )?;
        verify_external()?;
        authorize(
            access,
            scope,
            &owner,
            adoption_id,
            PublicationAction::ManageAdoption,
        )?;
        tx.commit()
            .map_err(|_| anyhow::anyhow!("KNOWLEDGE_PUBLICATION_WRITE_UNCONFIRMED"))?;
        Ok(record)
    }
}
