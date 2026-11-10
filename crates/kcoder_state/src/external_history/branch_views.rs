//! Persistent, target-owned derived branch indexes. Source archives remain immutable.
use super::*;
use crate::history_index::files;
use kcoder_types::{historical_branch::*, imported_transcript::HistoricalCodexItemRef};
use rusqlite::{Connection, Transaction, TransactionBehavior, params};
use std::{
    io::Write,
    time::{Duration, Instant},
};
mod references;
mod writer;

const DATABASE_BYTES: u64 = 1024 * 1024 * 1024;
const HEADER_BYTES: usize = 128 * 1024;
const ROW_BYTES: usize = 512 * 1024;
const INDEX_BYTES: u64 = 256 * 1024 * 1024;
const MAX_VIEWS: usize = 4096;
const BRANCH_CATALOG_WAIT: Duration = Duration::from_secs(30);
const SCHEMA: [&str; 2] = [
    "CREATE TABLE branch_header(id INTEGER PRIMARY KEY CHECK(id=1), body BLOB NOT NULL, sha BLOB NOT NULL)",
    "CREATE TABLE branch_items(position INTEGER PRIMARY KEY, body BLOB NOT NULL, sha BLOB NOT NULL)",
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    version: u32,
    owner: String,
    directory_identity: String,
    view_id: String,
    recipe: HistoricalBranchRecipe,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    version: u32,
    binding_sha256: String,
    plan: Option<HistoricalBranchPlan>,
    index_bytes: u64,
    progress: HistoricalBranchProgress,
}

pub struct HistoricalBranchView {
    _source_leases: Vec<lifecycle::ArchiveReadGuard>,
    _lifecycle: Option<std::sync::Arc<kcoder_config::VerifiedPrivateLease>>,
    connection: Connection,
    _lease: files::Lease,
    _writer: Option<File>,
    directory: PrivateDirectory,
    binding: Binding,
    binding_sha256: String,
    writable: bool,
}
pub struct HistoricalBranchControl {
    directory: PrivateDirectory,
    name: &'static str,
}
impl HistoricalBranchControl {
    pub fn cancelled(&self) -> Result<bool> {
        let Some(bytes) = read_optional(&self.directory, self.name, 8)? else {
            return Ok(false);
        };
        serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("history_branch_invalid_control"))
    }
}
struct Encoding {
    bytes: Vec<u8>,
    maximum: usize,
}
impl Write for Encoding {
    fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
        if input.len() > self.maximum.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::other(
                "history_branch_encoding_budget_exceeded",
            ));
        }
        self.bytes.extend_from_slice(input);
        Ok(input.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn encode(value: &impl Serialize, maximum: usize) -> Result<Vec<u8>> {
    let mut out = Encoding {
        bytes: Vec::new(),
        maximum,
    };
    serde_json::to_writer(&mut out, value)
        .map_err(|_| anyhow::anyhow!("history_branch_encoding_budget_exceeded"))?;
    Ok(out.bytes)
}
fn valid_recipe(recipe: &HistoricalBranchRecipe) -> Result<()> {
    ensure!(
        !recipe.sources.is_empty()
            && recipe.sources.len() <= 256
            && !recipe.revision.is_empty()
            && recipe.revision.len() <= 128
            && !recipe.normalization_revision.is_empty()
            && recipe.normalization_revision.len() <= 256
            && recipe.sources.iter().all(|source| source
                .archive_id
                .strip_prefix("archive-")
                .is_some_and(valid_hash)
                && valid_hash(&source.projection_fingerprint))
            && recipe
                .sources
                .iter()
                .map(|source| &source.archive_id)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == recipe.sources.len(),
        "history_branch_invalid_recipe"
    );
    Ok(())
}
fn id(owner: &str, recipe: &HistoricalBranchRecipe) -> Result<String> {
    valid_recipe(recipe)?;
    Ok(format!(
        "branch-{}",
        hash(&encode(
            &("historical-branch/v1", owner, recipe),
            HEADER_BYTES
        )?)
    ))
}
fn header(connection: &Connection, binding: &str) -> Result<Header> {
    let (body, sha): (Vec<u8>, Vec<u8>) =
        connection.query_row("SELECT body,sha FROM branch_header WHERE id=1", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
    ensure!(
        body.len() <= HEADER_BYTES && Sha256::digest(&body).as_slice() == sha,
        "history_branch_header_changed"
    );
    let header: Header = decode(&body)?;
    ensure!(
        header.version == 1
            && header.binding_sha256 == binding
            && header.index_bytes <= INDEX_BYTES
            && header.progress.written_items <= EXTERNAL_HISTORY_MAX_RECORDS
            && header
                .plan
                .as_ref()
                .is_none_or(|plan| plan.total_items <= EXTERNAL_HISTORY_MAX_RECORDS
                    && valid_hash(&plan.selection_sha256)
                    && header.progress.written_items <= plan.total_items)
            && (header.progress.stage != HistoricalBranchStage::Ready
                || header
                    .plan
                    .as_ref()
                    .is_some_and(|plan| header.progress.written_items == plan.total_items)),
        "history_branch_invalid_header"
    );
    Ok(header)
}
fn save(connection: &Connection, header: &mut Header) -> Result<()> {
    header.progress.sequence = header
        .progress
        .sequence
        .checked_add(1)
        .context("history_branch_sequence_exhausted")?;
    let bytes = encode(header, HEADER_BYTES)?;
    connection.execute("INSERT INTO branch_header(id,body,sha) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body,sha=excluded.sha",params![&bytes,Sha256::digest(&bytes).as_slice()])?;
    Ok(())
}

fn lock_branch_catalog(directory: &PrivateDirectory) -> Result<File> {
    let deadline = Instant::now() + BRANCH_CATALOG_WAIT;
    loop {
        if let Some(lease) = directory.try_exclusive_lock(OsStr::new("catalog.lock"))? {
            return Ok(lease);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        ensure!(!remaining.is_zero(), "history_branch_catalog_busy");
        // Wait before directory publication; never replay a completed write.
        std::thread::sleep(remaining.min(Duration::from_millis(10)));
    }
}

impl ExternalHistoryStore {
    pub fn branch_id(&self, recipe: &HistoricalBranchRecipe) -> Result<String> {
        id(&self.scope_fingerprint()?, recipe)
    }

    /// Resolve only a target-owned binding; a copied cache never grants another profile access.
    fn branch_directory(&self, view_id: &str, create: bool) -> Result<PrivateDirectory> {
        self.branch_directory_with_birth(view_id, create)
            .map(|(directory, _)| directory)
    }
    fn branch_directory_with_birth(
        &self,
        view_id: &str,
        create: bool,
    ) -> Result<(PrivateDirectory, bool)> {
        ensure!(
            view_id.strip_prefix("branch-").is_some_and(valid_hash),
            "history_branch_invalid_id"
        );
        self.directory.verify_private_directory()?;
        let base = self.directory.open_child(OsStr::new("branches"), create)?;
        base.verify_private_directory()?;
        let _catalog = if create {
            Some(lock_branch_catalog(&base)?)
        } else {
            None
        };
        let existing = match base.open_child(OsStr::new(view_id), false) {
            Ok(directory) => Some(directory),
            Err(error) if create && missing(&error) => None,
            Err(error) => return Err(error),
        };
        if create && existing.is_none() {
            let mut count = 0;
            base.visit_entry_names_bounded(MAX_VIEWS + 2, |name| {
                if name
                    .to_str()
                    .is_some_and(|name| name.starts_with("branch-"))
                {
                    count += 1;
                }
                Ok(())
            })?;
            ensure!(count < MAX_VIEWS, "history_branch_count_budget_exceeded");
        }
        let born = existing.is_none();
        let directory = match existing {
            Some(directory) => directory,
            None => base.create_private_child(OsStr::new(view_id))?,
        };
        directory.verify_private_directory()?;
        Ok((directory, born))
    }
    fn branch_binding(&self, directory: &PrivateDirectory, view_id: &str) -> Result<Binding> {
        let bytes = read_optional(directory, "binding.json", HEADER_BYTES as u64)?
            .context("history_branch_not_found")?;
        let binding: Binding = decode(&bytes)?;
        ensure!(
            binding.version == 1
                && binding.owner == self.scope_fingerprint()?
                && binding.directory_identity == directory.directory_identity()?
                && binding.view_id == view_id
                && id(&binding.owner, &binding.recipe)? == view_id,
            "history_branch_owner_mismatch"
        );
        Ok(binding)
    }
    pub fn prepare_branch(&self, recipe: &HistoricalBranchRecipe) -> Result<HistoricalBranchView> {
        let source_leases = self.branch_source_guards(recipe)?;
        let owner = self.scope_fingerprint()?;
        let view_id = id(&owner, recipe)?;
        let (directory, born) = self.branch_directory_with_birth(&view_id, true)?;
        let writer = directory
            .try_exclusive_lock(OsStr::new("build.lock"))?
            .context("history_branch_busy")?;
        let binding = Binding {
            version: 1,
            owner,
            directory_identity: directory.directory_identity()?,
            view_id: view_id.clone(),
            recipe: recipe.clone(),
        };
        let bytes = encode(&binding, HEADER_BYTES)?;
        self.pin_branch(&directory, &binding, &source_leases, born)?;
        publish_exact(&directory, "binding.json", &bytes, HEADER_BYTES as u64)?;
        let selected = self.branch_binding(&directory, &view_id)?;
        self.open_branch_inner(directory, selected, Some(writer), true)
    }
    pub fn branch(&self, view_id: &str, writable: bool) -> Result<HistoricalBranchView> {
        let directory = self.branch_directory(view_id, false)?;
        let binding = self.branch_binding(&directory, view_id)?;
        let writer = if writable {
            Some(
                directory
                    .try_exclusive_lock(OsStr::new("build.lock"))?
                    .context("history_branch_busy")?,
            )
        } else {
            None
        };
        self.open_branch_inner(directory, binding, writer, writable)
    }
    /// Cancellation does not wait on the writer or a SQLite transaction.
    pub fn cancel_branch(&self, view_id: &str) -> Result<()> {
        let directory = self.branch_directory(view_id, false)?;
        self.branch_binding(&directory, view_id)?;
        let _control = directory
            .try_exclusive_lock(OsStr::new("control.lock"))?
            .context("history_branch_control_busy")?;
        directory.atomic_replace(OsStr::new("cancel.json"), b"true")
    }
    pub fn branch_control(&self, view_id: &str) -> Result<HistoricalBranchControl> {
        let directory = self.branch_directory(view_id, false)?;
        self.branch_binding(&directory, view_id)?;
        Ok(HistoricalBranchControl {
            directory,
            name: "cancel.json",
        })
    }
    pub fn branch_tools_control(&self, view_id: &str) -> Result<HistoricalBranchControl> {
        let directory = self.branch_directory(view_id, false)?;
        self.branch_binding(&directory, view_id)?;
        Ok(HistoricalBranchControl {
            directory,
            name: "tools.cancel.json",
        })
    }
    pub fn set_branch_tools_cancel(&self, view_id: &str, cancelled: bool) -> Result<()> {
        let directory = self.branch_directory(view_id, false)?;
        self.branch_binding(&directory, view_id)?;
        let _control = directory
            .try_exclusive_lock(OsStr::new("control.lock"))?
            .context("history_branch_control_busy")?;
        directory.atomic_replace(
            OsStr::new("tools.cancel.json"),
            if cancelled { b"true" } else { b"false" },
        )
    }
    pub fn branch_recipe(&self, view_id: &str) -> Result<HistoricalBranchRecipe> {
        let directory = self.branch_directory(view_id, false)?;
        Ok(self.branch_binding(&directory, view_id)?.recipe)
    }
    pub fn branch_running(&self, view_id: &str) -> Result<bool> {
        let directory = self.branch_directory(view_id, false)?;
        self.branch_binding(&directory, view_id)?;
        Ok(directory
            .try_exclusive_lock(OsStr::new("build.lock"))?
            .is_none())
    }
    fn open_branch_inner(
        &self,
        directory: PrivateDirectory,
        binding: Binding,
        writer: Option<File>,
        writable: bool,
    ) -> Result<HistoricalBranchView> {
        let (source_leases, lifecycle) = self.branch_read_fences(&directory, &binding)?;
        let binding_sha256 = hash(&encode(&binding, HEADER_BYTES)?);
        let scope = format!("historical-branch/v1:{binding_sha256}");
        let database_directory = self.branch_directory(&binding.view_id, false)?;
        ensure!(
            database_directory.directory_identity()? == binding.directory_identity,
            "history_branch_owner_mismatch"
        );
        // Source zero is the recipe's explicit primary source; peer sources never lend quota.
        let resource = source_leases
            .first()
            .map(|guard| {
                files::resource_for_database(
                    guard,
                    &database_directory,
                    &scope,
                    writable,
                    DATABASE_BYTES,
                )
            })
            .transpose()?
            .flatten();
        let opened = files::open_database_in_with_resource(
            database_directory,
            &scope,
            writable,
            DATABASE_BYTES,
            resource,
        )?
        .context("history_branch_not_ready")?;
        let mut connection = opened.connection;
        connection.set_limit(
            rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
            (ROW_BYTES + 4096) as i32,
        );
        connection.busy_timeout(std::time::Duration::from_millis(50))?;
        connection.execute_batch(
            "PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048;",
        )?;
        if !writable {
            connection.pragma_update(None, "query_only", true)?;
        }
        let transaction = connection.transaction_with_behavior(if writable {
            TransactionBehavior::Immediate
        } else {
            TransactionBehavior::Deferred
        })?;
        let schema:Vec<String>=transaction.prepare("SELECT CASE WHEN length(sql)<=4096 THEN sql ELSE NULL END FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 3")?.query_map([],|row|row.get(0))?.collect::<rusqlite::Result<_>>()?;
        if schema.is_empty() {
            ensure!(writable, "history_branch_schema_missing");
            for sql in SCHEMA {
                transaction.execute_batch(sql)?;
            }
            let mut initial = Header {
                version: 1,
                binding_sha256: binding_sha256.clone(),
                plan: None,
                index_bytes: 0,
                progress: HistoricalBranchProgress {
                    view_id: binding.view_id.clone(),
                    sequence: 0,
                    source: binding.recipe.source,
                    stage: HistoricalBranchStage::Planned,
                    checks: 0,
                    written_items: 0,
                    total_items: None,
                    structural_complete: None,
                    source_records_with_diagnostics: 0,
                    issues: Vec::new(),
                    cancel_requested: false,
                    failure_code: None,
                },
            };
            save(&transaction, &mut initial)?;
        } else {
            ensure!(schema == SCHEMA, "history_branch_schema_changed");
        }
        let observed = header(&transaction, &binding_sha256)?;
        ensure!(
            observed.progress.view_id == binding.view_id
                && observed.progress.source == binding.recipe.source,
            "history_branch_scope_changed"
        );
        transaction.commit()?;
        Ok(HistoricalBranchView {
            _source_leases: source_leases,
            _lifecycle: lifecycle,
            connection,
            _lease: opened.lease,
            _writer: writer,
            directory,
            binding,
            binding_sha256,
            writable,
        })
    }
}

impl HistoricalBranchView {
    /// Retain the same admitted source claims when another native domain publishes
    /// a durable descendant. Cloning never reopens a source or grants new authority.
    pub fn source_guards(&self) -> Vec<lifecycle::ArchiveReadGuard> {
        self._source_leases.clone()
    }
    pub fn tool_links(&self, writable: bool) -> Result<Option<tool_links::HistoricalToolLinks>> {
        let identity = self.content_identity()?;
        let directory = match self
            .directory
            .open_child(OsStr::new("tool-links-v1"), writable)
        {
            Ok(directory) => directory,
            Err(error) if !writable && missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        let writer = if writable {
            Some(
                directory
                    .try_exclusive_lock(OsStr::new("build.lock"))?
                    .context("history_tool_links_busy")?,
            )
        } else {
            None
        };
        let scope = format!("branch-tool-links/v1:{identity}");
        let mut links = tool_links::open(
            directory,
            &scope,
            None,
            tool_links::ToolLinkBinding {
                source: &identity,
                normalization: &self.binding.recipe.normalization_revision,
                selection: &identity,
                resource_guard: self._source_leases.first(),
            },
            writer,
            writable,
        )?;
        if let Some(links) = &mut links {
            links.retain_sources(self._source_leases.clone(), self._lifecycle.clone());
        }
        Ok(links)
    }
    pub fn tools_running(&self) -> Result<bool> {
        self.content_identity()?;
        let directory = match self
            .directory
            .open_child(OsStr::new("tool-links-v1"), false)
        {
            Ok(directory) => directory,
            Err(error) if missing(&error) => return Ok(false),
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        Ok(directory
            .try_exclusive_lock(OsStr::new("build.lock"))?
            .is_none())
    }
    pub fn content_identity(&self) -> Result<String> {
        let value = header(&self.connection, &self.binding_sha256)?;
        ensure!(
            value.progress.stage == HistoricalBranchStage::Ready,
            "history_branch_not_ready"
        );
        Ok(hash(&encode(
            &(
                &self.binding_sha256,
                value.plan.context("history_branch_plan_missing")?,
            ),
            HEADER_BYTES,
        )?))
    }
    pub fn recipe(&self) -> &HistoricalBranchRecipe {
        &self.binding.recipe
    }
    pub fn cancel_requested(&self) -> Result<bool> {
        let Some(bytes) = read_optional(&self.directory, "cancel.json", 8)? else {
            return Ok(false);
        };
        serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("history_branch_invalid_control"))
    }
    pub fn progress(&self) -> Result<HistoricalBranchProgress> {
        let mut progress = header(&self.connection, &self.binding_sha256)?.progress;
        progress.cancel_requested =
            progress.stage != HistoricalBranchStage::Ready && self.cancel_requested()?;
        Ok(progress)
    }
    pub fn page(&self, cursor: u64) -> Result<HistoricalBranchItems> {
        let transaction = self.connection.unchecked_transaction()?;
        let header = header(&transaction, &self.binding_sha256)?;
        ensure!(
            header.progress.stage == HistoricalBranchStage::Ready,
            "history_branch_not_ready"
        );
        ensure!(
            cursor <= header.progress.written_items,
            "history_branch_invalid_cursor"
        );
        let mut statement=transaction.prepare("SELECT position,body,sha FROM branch_items WHERE position>=?1 ORDER BY position LIMIT 10")?;
        let rows: Vec<(u64, Vec<u8>, Vec<u8>)> = statement
            .query_map([cursor], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        drop(statement);
        let mut items = Vec::new();
        for (index, (position, bytes, sha)) in rows.into_iter().enumerate() {
            ensure!(
                position == cursor + index as u64
                    && bytes.len() <= ROW_BYTES
                    && Sha256::digest(&bytes).as_slice() == sha,
                "history_branch_item_changed"
            );
            let item: HistoricalCodexItemRef = decode(&bytes)?;
            self.valid_item(&item)?;
            items.push(item);
        }
        let next = cursor + items.len() as u64;
        ensure!(
            items.len() as u64 == (header.progress.written_items - cursor).min(10),
            "history_branch_cursor_gap"
        );
        transaction.commit()?;
        let next_cursor = (next < header.progress.written_items).then_some(next);
        Ok(HistoricalBranchItems {
            recipe: self.binding.recipe.clone(),
            progress: header.progress,
            items,
            next_cursor,
        })
    }
    fn valid_item(&self, item: &HistoricalCodexItemRef) -> Result<()> {
        ensure!(
            (item.source_index as usize) < self.binding.recipe.sources.len()
                && item.record < EXTERNAL_HISTORY_MAX_RECORDS
                && item.omitted_blocks.windows(2).all(|pair| pair[0] < pair[1]),
            "history_branch_invalid_item"
        );
        Ok(())
    }
}
