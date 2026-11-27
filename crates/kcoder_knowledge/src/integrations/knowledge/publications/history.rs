use super::*;
use kcoder_types::integrations::knowledge::KnowledgePublicationSummary;

impl KnowledgeCatalog {
    /// Pure owner-management history: names/metadata require current revoke authority per row.
    /// Effective reader queries remain separate and never receive expired/revoked page bodies.
    pub fn list_owned_publication_versions(
        &self,
        scope: &IntegrationScope,
        access: &dyn PublicationAccess,
        after: Option<&str>,
    ) -> Result<KnowledgePage<KnowledgePublicationSummary>> {
        scope.validate()?;
        if !self.publications_initialized()? {
            return Ok(KnowledgePage {
                items: vec![],
                next_cursor: None,
            });
        }
        let owner = KnowledgeOwner::from(scope);
        let owner_key = serde_json::to_string(&owner)?;
        let mut query=self.connection.prepare("SELECT publication_id,version FROM integration_publications WHERE owner_key=?1 ORDER BY publication_id,version DESC LIMIT 10001")?;
        let rows = query
            .query_map([&owner_key], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(rows.len() <= 10_000, "KNOWLEDGE_PUBLICATION_CAPACITY");
        let rows = rows
            .into_iter()
            .map(|(id, version)| {
                let cursor = crate::objects::digest(
                    serde_json::to_string(&(scope, &id, version))?.as_bytes(),
                );
                Ok((id, version, cursor))
            })
            .collect::<Result<Vec<_>>>()?;
        let start = match after {
            Some(cursor) => {
                rows.iter()
                    .position(|(_, _, key)| key == cursor)
                    .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_INVALID_CURSOR"))?
                    + 1
            }
            None => 0,
        };
        let mut summaries = Vec::new();
        let mut cursor = None;
        let mut more = false;
        for (id, version, key) in rows.into_iter().skip(start) {
            if !access.check(scope, &owner, &id, PublicationAction::Revoke)? {
                continue;
            }
            if summaries.len() == 10 {
                more = true;
                break;
            }
            let (body,hash,revoked):(String,String,bool)=self.connection.query_row(
                "SELECT body_json,body_hash,revoked FROM integration_publications WHERE owner_key=?1 AND publication_id=?2 AND version=?3",
                params![owner_key,id,version],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
            ensure!(
                body.len() <= 512 * 1024 && crate::objects::digest(body.as_bytes()) == hash,
                "KNOWLEDGE_PUBLICATION_CORRUPT"
            );
            let publication: KnowledgePublication = serde_json::from_str(&body)?;
            ensure!(
                publication.owner == owner
                    && publication.draft.publication_id == id
                    && publication.version == version,
                "KNOWLEDGE_PUBLICATION_IDENTITY_MISMATCH"
            );
            authorize(access, scope, &owner, &id, PublicationAction::Revoke)?;
            summaries.push(KnowledgePublicationSummary {
                owner: owner.clone(),
                publication_id: id,
                version,
                title: publication.draft.title,
                purpose: publication.draft.purpose,
                publisher_role: publication.publisher_role,
                published_at_ms: publication.published_at_ms,
                valid_from_ms: publication.draft.valid_from_ms,
                valid_until_ms: publication.draft.valid_until_ms,
                revoked,
            });
            cursor = Some(key);
        }
        Ok(KnowledgePage {
            items: summaries,
            next_cursor: if more { cursor } else { None },
        })
    }
}
