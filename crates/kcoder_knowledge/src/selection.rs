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
        resolve_on(&self.connection, scope, explicit, conversation)
    }
    /// Only call after an explicit user request to organize/import material.
    pub fn ensure_import_library(
        &mut self,
        scope: &KnowledgeScope,
        default_name: &str,
    ) -> Result<LibrarySelection> {
        match self.resolve_library(scope, None, None)? {
            LibrarySelection::Empty => {
                let tx = self
                    .connection
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                // Admission, creation and selection are one transaction. A lost
                // receipt or concurrent import observes the selected generation.
                match resolve_on(&tx, scope, None, None)? {
                    LibrarySelection::Empty => {
                        let name = default_name.trim();
                        ensure!(
                            !name.is_empty() && name.chars().count() <= 120,
                            "invalid library name"
                        );
                        let library = Library {
                            revision: 1,
                            id: uuid::Uuid::new_v4().to_string(),
                            name: name.into(),
                            purpose: String::new(),
                            archived: false,
                        };
                        let request_key = format!("kcoder-default-wiki-v2:{}", library.id);
                        tx.execute("INSERT INTO libraries(id,principal,target,name,purpose,request_key) VALUES(?1,?2,?3,?4,'',?5)", params![library.id,scope.principal,scope.target,library.name,request_key])?;
                        tx.execute("INSERT INTO knowledge_defaults(principal,target,library_id) VALUES(?1,?2,?3)",params![scope.principal,scope.target,library.id])?;
                        tx.commit()?;
                        Ok(LibrarySelection::Selected(library))
                    }
                    selection => {
                        tx.commit()?;
                        Ok(selection)
                    }
                }
            }
            selection => Ok(selection),
        }
    }
}

fn read_scoped(
    connection: &rusqlite::Connection,
    scope: &KnowledgeScope,
    id: &str,
) -> Result<Library> {
    connection.query_row("SELECT id,name,purpose,archived,metadata_revision FROM libraries WHERE principal=?1 AND target=?2 AND id=?3",params![scope.principal,scope.target,id],crate::catalog::read_library).optional()?.ok_or_else(|| anyhow::anyhow!("knowledge library not found"))
}
fn resolve_on(
    connection: &rusqlite::Connection,
    scope: &KnowledgeScope,
    explicit: Option<&str>,
    conversation: Option<&str>,
) -> Result<LibrarySelection> {
    let preferred: Option<String> = connection
        .query_row(
            "SELECT library_id FROM knowledge_defaults WHERE principal=?1 AND target=?2",
            params![scope.principal, scope.target],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = explicit.or(conversation).or(preferred.as_deref()) {
        let library = read_scoped(connection, scope, id)?;
        ensure!(!library.archived, "knowledge library is archived");
        return Ok(LibrarySelection::Selected(library));
    }
    let mut query=connection.prepare("SELECT id FROM libraries WHERE principal=?1 AND target=?2 AND archived=0 ORDER BY id LIMIT 2")?;
    let ids = query
        .query_map(params![scope.principal, scope.target], |r| {
            r.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(match ids.as_slice() {
        [] => LibrarySelection::Empty,
        [id] => LibrarySelection::Selected(read_scoped(connection, scope, id)?),
        _ => LibrarySelection::NeedsChoice,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_new_default_imports_select_one_generation() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("state.sqlite");
        let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
        let mut store = KnowledgeCatalog::open(&path)?;
        let LibrarySelection::Selected(first) = store.ensure_import_library(&scope, "Old Wiki")?
        else {
            panic!("missing default");
        };
        store.set_archived(&scope, &first.id, first.revision, true)?;
        drop(store);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|index| {
                let path = path.clone();
                let scope = scope.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || -> Result<String> {
                    let mut store = KnowledgeCatalog::open(&path)?;
                    barrier.wait();
                    let LibrarySelection::Selected(library) =
                        store.ensure_import_library(&scope, &format!("Wiki {index}"))?
                    else {
                        panic!("missing default");
                    };
                    Ok(library.id)
                })
            })
            .collect();
        let ids: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Result<_>>()?;
        assert_eq!(ids[0], ids[1]);
        let store = KnowledgeCatalog::open(&path)?;
        assert_eq!(
            store
                .list(&scope, None, 10)?
                .iter()
                .filter(|library| !library.archived)
                .count(),
            1
        );
        assert!(store.read(&scope, &first.id)?.archived);
        Ok(())
    }
    #[test]
    fn archived_automatic_default_does_not_block_an_explicit_new_import() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("state.sqlite");
        let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
        let mut store = KnowledgeCatalog::open(&path)?;
        let LibrarySelection::Selected(first) =
            store.ensure_import_library(&scope, "First Wiki")?
        else {
            panic!("missing default");
        };
        let renamed =
            store.update_library(&scope, &first.id, first.revision, "Renamed Wiki", "")?;
        store.set_archived(&scope, &first.id, renamed.revision, true)?;
        drop(store);
        let mut store = KnowledgeCatalog::open(&path)?;
        let LibrarySelection::Selected(second) = store.ensure_import_library(&scope, "New Wiki")?
        else {
            panic!("missing new default");
        };
        assert_ne!(first.id, second.id);
        assert!(!second.archived);
        assert!(store.read(&scope, &first.id)?.archived);
        let LibrarySelection::Selected(replayed) =
            store.ensure_import_library(&scope, "New Wiki")?
        else {
            panic!("missing replay");
        };
        assert_eq!(second.id, replayed.id);
        Ok(())
    }
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
