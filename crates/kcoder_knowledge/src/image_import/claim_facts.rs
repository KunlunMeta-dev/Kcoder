//! Read-only original image attempt metadata; these facts grant no model access.
use super::*;
#[derive(Clone, PartialEq, Eq)]
pub struct ImageImportClaimFacts {
    pub import_id: String,
    pub original_hash: String,
    pub fingerprint: String,
    pub recipe: String,
    pub call_id: String,
}
impl KnowledgeCatalog {
    pub fn image_import_original_status(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        id: &str,
    ) -> Result<String> {
        self.read(scope, library)?;
        self.connection
            .query_row(
                "SELECT status FROM knowledge_image_imports WHERE library_id=?1 AND id=?2",
                params![library, id],
                |row| row.get(0),
            )
            .optional()?
            .context("image import not found")
    }
    /// Resolve the actual local call row belonging to this native lease. Cancel,
    /// expiry and later claims retain this original observation for accounting.
    pub fn image_import_claim_facts(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &ImageImportLease,
    ) -> Result<ImageImportClaimFacts> {
        self.read(scope, library)?;
        let row = self.connection.query_row(
            "SELECT i.original_hash,i.fingerprint,i.recipe,c.call_id FROM knowledge_image_imports i JOIN knowledge_image_import_calls c ON c.library_id=i.library_id AND c.import_id=i.id WHERE i.library_id=?1 AND i.id=?2 AND c.lease_token=?3",
            params![library, lease.id, lease.token],
            |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?)),
        ).optional()?.context("image import original call not found")?;
        Ok(ImageImportClaimFacts {
            import_id: lease.id.clone(),
            original_hash: row.0,
            fingerprint: row.1,
            recipe: row.2,
            call_id: row.3,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_call_facts_survive_cancel_and_do_not_follow_a_new_lease() -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut catalog = KnowledgeCatalog::open(&root.path().join("state.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("claim-facts-owner", "host")?;
        let library = catalog.create(&scope, "create", "Images", "")?;
        let import = catalog.accept_image_import(
            &scope,
            &library.id,
            &ImageImportInput {
                key: "original",
                title: "image.png",
                original: b"already-inspected-native-bytes",
                mime: "image/png",
                source: None,
                expected_revision: None,
            },
        )?;
        let lease = catalog.claim_image_import(
            &scope,
            &library.id,
            &import.id,
            false,
            0,
            "vision",
            "frozen-recipe",
        )?;
        let facts = catalog.image_import_claim_facts(&scope, &library.id, &lease)?;
        assert_eq!(facts.import_id, import.id);
        assert_eq!(facts.recipe, "frozen-recipe");
        assert_eq!(facts.original_hash.len(), 64);
        catalog.cancel_image_import(&scope, &library.id, &import.id)?;
        assert!(
            catalog
                .check_image_import_lease(&scope, &library.id, &lease)
                .is_err()
        );
        assert_eq!(
            catalog
                .image_import_claim_facts(&scope, &library.id, &lease)?
                .call_id,
            facts.call_id
        );
        assert_eq!(
            catalog.image_import_original_status(&scope, &library.id, &import.id)?,
            "cancelled"
        );
        assert!(
            catalog
                .image_import_claim_facts(
                    &scope,
                    &library.id,
                    &ImageImportLease {
                        id: import.id,
                        token: "another-lease".into()
                    }
                )
                .is_err()
        );
        Ok(())
    }
}
