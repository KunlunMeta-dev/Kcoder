//! Resolve conversational Wiki scope without repeatedly asking for internal IDs.
use crate::{KnowledgeCatalog, KnowledgeScope, Library};
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, params};

#[derive(Debug)]
pub enum LibrarySelection {
    Selected(Library),
    Empty,
    NeedsChoice,
}

impl KnowledgeCatalog {
    pub fn set_default_library(&mut self, scope: &KnowledgeScope, library: &str) -> Result<()> {
        ensure!(
            !self.read(scope, library)?.archived,
            "knowledge library is archived"
        );
        self.connection.execute("INSERT INTO knowledge_defaults(principal,target,library_id) VALUES(?1,?2,?3) ON CONFLICT(principal,target) DO UPDATE SET library_id=excluded.library_id",params![scope.principal,scope.target,library])?;
        Ok(())
    }
    /// Explicit and conversation scope never silently fall back to a different
    /// library when missing or unauthorized. A read alone never creates a Wiki.
    pub fn resolve_library(
        &self,
        scope: &KnowledgeScope,
        explicit: Option<&str>,
        conversation: Option<&str>,
    ) -> Result<LibrarySelection> {
        let preferred: Option<String> = self
            .connection
            .query_row(
                "SELECT library_id FROM knowledge_defaults WHERE principal=?1 AND target=?2",
                params![scope.principal, scope.target],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = explicit.or(conversation).or(preferred.as_deref()) {
            let library = self.read(scope, id)?;
            ensure!(!library.archived, "knowledge library is archived");
            return Ok(LibrarySelection::Selected(library));
        }
        let mut query=self.connection.prepare("SELECT id FROM libraries WHERE principal=?1 AND target=?2 AND archived=0 ORDER BY id LIMIT 2")?;
        let ids = query
            .query_map(params![scope.principal, scope.target], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(match ids.as_slice() {
            [] => LibrarySelection::Empty,
            [id] => LibrarySelection::Selected(self.read(scope, id)?),
            _ => LibrarySelection::NeedsChoice,
        })
    }
    /// Only call after an explicit user request to organize/import material.
    pub fn ensure_import_library(
        &mut self,
        scope: &KnowledgeScope,
        default_name: &str,
    ) -> Result<LibrarySelection> {
        match self.resolve_library(scope, None, None)? {
            LibrarySelection::Empty => {
                let library = self.create(scope, "kcoder-default-wiki-v1", default_name, "")?;
                // A concurrently selected preference must win over automatic creation.
                self.connection.execute("INSERT OR IGNORE INTO knowledge_defaults(principal,target,library_id) VALUES(?1,?2,?3)",params![scope.principal,scope.target,library.id])?;
                self.resolve_library(scope, None, None)
            }
            selection => Ok(selection),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_wiki_is_remembered_per_identity_and_target_but_reads_do_not_create() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&dir.path().join("state.sqlite"))?;
        let alice = KnowledgeScope::from_authenticated_host("alice", "ssh")?;
        let bob = KnowledgeScope::from_authenticated_host("bob", "ssh")?;
        let local = KnowledgeScope::from_authenticated_host("alice", "local")?;
        assert!(matches!(
            store.resolve_library(&alice, None, None)?,
            LibrarySelection::Empty
        ));
        assert!(store.list(&alice, None, 10)?.is_empty());
        let LibrarySelection::Selected(first) = store.ensure_import_library(&alice, "个人 Wiki")?
        else {
            panic!("missing default")
        };
        let LibrarySelection::Selected(again) =
            store.ensure_import_library(&alice, "Personal Wiki")?
        else {
            panic!("missing default")
        };
        assert_eq!(first.id, again.id);
        for scope in [&bob, &local] {
            assert!(matches!(
                store.resolve_library(scope, None, None)?,
                LibrarySelection::Empty
            ));
            assert!(store.set_default_library(scope, &first.id).is_err());
        }
        let second = store.create(&alice, "second", "研发", "")?;
        assert!(
            matches!(store.resolve_library(&alice,None,None)?,LibrarySelection::Selected(lib) if lib.id==first.id)
        );
        assert!(
            matches!(store.resolve_library(&alice,Some(&second.id),Some(&first.id))?,LibrarySelection::Selected(lib) if lib.id==second.id)
        );
        assert!(
            store
                .resolve_library(&alice, Some("deleted"), None)
                .is_err()
        );
        Ok(())
    }
}
