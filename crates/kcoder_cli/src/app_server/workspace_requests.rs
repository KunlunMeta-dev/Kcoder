//! Workspace requests: extracted from the app-server connection boundary.

use super::*;

pub(super) async fn canonical_workspace_directory(raw: &str) -> Result<PathBuf> {
    if raw.trim().is_empty() || raw.len() > 4096 {
        anyhow::bail!("workspacePath is invalid")
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        anyhow::bail!("workspacePath must be absolute")
    }
    let canonical = dunce::canonicalize(path)
        .with_context(|| format!("workspace root does not exist: {raw}"))?;
    if !tokio::fs::metadata(&canonical).await?.is_dir() {
        anyhow::bail!("workspace root is not a directory: {raw}")
    }
    Ok(canonical)
}

pub(super) fn workspace_record_matches(record: &ClientWorkspaceRecord, project_key: &str) -> bool {
    record.project_key == project_key || record.workspace_path == project_key
}

pub(super) fn workspace_label(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Workspace")
        .to_string()
}

pub(super) async fn workspace_request(
    engine: &QueryEngine,
    method: &str,
    params: &Value,
) -> Result<Value> {
    let store = ClientWorkspaceStore::new(engine);
    let device_id = params
        .get("deviceId")
        .and_then(Value::as_str)
        .unwrap_or("local");
    if let Some(runtime) = params.get("runtime").and_then(Value::as_str)
        && !matches!(runtime, "kcoder" | "codex")
    {
        anyhow::bail!("only the kcoder runtime supports client workspaces")
    }
    match method {
        "runtime.workspaces.prepare" => {
            let raw = params
                .get("workspacePath")
                .and_then(Value::as_str)
                .context("workspacePath is required")?;
            let action = params
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("select");
            if !matches!(action, "create" | "select") {
                anyhow::bail!("action must be create or select")
            }
            let raw_path = Path::new(raw);
            if !raw_path.is_absolute() || raw_path.parent().is_none() {
                anyhow::bail!("workspacePath must be an absolute non-root directory")
            }
            if action == "create" {
                tokio::fs::create_dir_all(raw_path).await?;
            }
            let path = canonical_workspace_directory(raw).await?;
            let workspace_path = path.to_string_lossy().into_owned();
            let label = params
                .get("label")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| workspace_label(&path));
            let project_id = params.get("projectId").and_then(Value::as_i64).unwrap_or(0);
            let project_key = format!("project:{project_id}");
            let _guard = store.lock()?;
            let mut state = store.load();
            let now = app_server_now_ms();
            let prior = state.records.remove(&workspace_path).unwrap_or_default();
            state.records.insert(
                workspace_path.clone(),
                ClientWorkspaceRecord {
                    workspace_path: workspace_path.clone(),
                    label: label.clone(),
                    project_key: project_key.clone(),
                    roots: vec![workspace_path.clone()],
                    created_at: if prior.created_at == 0 {
                        now
                    } else {
                        prior.created_at
                    },
                    updated_at: now,
                    ..prior
                },
            );
            if !state.project_order.contains(&project_key) {
                state.project_order.push(project_key);
            }
            store.save(&state)?;
            Ok(json!({
                "mapping": {
                    "id": project_id,
                    "userId": 0,
                    "projectId": project_id,
                    "deviceId": device_id,
                    "workspacePath": workspace_path,
                    "label": label,
                    "createdAt": now.to_string(),
                    "updatedAt": now.to_string(),
                },
                "preparedAction": if action == "create" { "created" } else { "selected" },
            }))
        }
        "runtime.workspaces.delete" => {
            let workspace_path = params
                .get("workspacePath")
                .and_then(Value::as_str)
                .context("workspacePath is required")?;
            let _guard = store.lock()?;
            let mut state = store.load();
            let before = state.records.len();
            let removed_keys = state
                .records
                .values()
                .filter(|record| record.workspace_path == workspace_path)
                .map(|record| record.project_key.clone())
                .collect::<HashSet<_>>();
            state
                .records
                .retain(|_, record| record.workspace_path != workspace_path);
            state
                .project_order
                .retain(|key| !removed_keys.contains(key));
            let deleted = state.records.len() != before;
            store.save(&state)?;
            Ok(json!({"deleted": deleted}))
        }
        "runtime.workspaces.open" => {
            let raw = params
                .get("workspacePath")
                .and_then(Value::as_str)
                .context("workspacePath is required")?;
            let path = canonical_workspace_directory(raw).await?;
            let workspace_path = path.to_string_lossy().into_owned();
            let label = params
                .get("label")
                .or_else(|| params.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| workspace_label(&path));
            if label.len() > 256 {
                anyhow::bail!("workspace label is too long")
            }
            let project_key = params
                .get("projectKey")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&workspace_path)
                .to_string();
            let _guard = store.lock()?;
            let mut state = store.load();
            let now = app_server_now_ms();
            let prior = state.records.remove(&workspace_path).unwrap_or_default();
            state.records.insert(
                workspace_path.clone(),
                ClientWorkspaceRecord {
                    workspace_path: workspace_path.clone(),
                    label,
                    project_key: project_key.clone(),
                    roots: vec![workspace_path.clone()],
                    created_at: if prior.created_at == 0 {
                        now
                    } else {
                        prior.created_at
                    },
                    updated_at: now,
                    ..prior
                },
            );
            if !state.project_order.contains(&project_key) {
                state.project_order.insert(0, project_key);
            }
            store.save(&state)?;
            Ok(json!({
                "success": true,
                "accepted": true,
                "deviceId": device_id,
                "workspacePath": workspace_path,
                "runtime": "kcoder",
            }))
        }
        "runtime.projects.upsert_local" => {
            let project_key = params
                .get("projectKey")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .context("projectKey is required")?;
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .context("name is required")?;
            if project_key.len() > 512 || name.len() > 256 {
                anyhow::bail!("projectKey or name is too long")
            }
            let raw_roots = params
                .get("roots")
                .and_then(Value::as_array)
                .context("roots is required")?;
            if raw_roots.is_empty() || raw_roots.len() > 64 {
                anyhow::bail!("roots must contain between 1 and 64 directories")
            }
            let mut roots = Vec::with_capacity(raw_roots.len());
            for raw in raw_roots {
                let raw = raw.as_str().context("each root must be a string")?;
                roots.push(
                    canonical_workspace_directory(raw)
                        .await?
                        .to_string_lossy()
                        .into_owned(),
                );
            }
            let mut seen_roots = HashSet::with_capacity(roots.len());
            roots.retain(|root| seen_roots.insert(root.clone()));
            let _guard = store.lock()?;
            let mut state = store.load();
            state
                .records
                .retain(|path, record| record.project_key != project_key || roots.contains(path));
            let now = app_server_now_ms();
            for root in &roots {
                let prior = state.records.remove(root).unwrap_or_default();
                state.records.insert(
                    root.clone(),
                    ClientWorkspaceRecord {
                        workspace_path: root.clone(),
                        label: name.to_string(),
                        project_key: project_key.to_string(),
                        roots: roots.clone(),
                        created_at: if prior.created_at == 0 {
                            now
                        } else {
                            prior.created_at
                        },
                        updated_at: now,
                        ..prior
                    },
                );
            }
            if !state.project_order.iter().any(|value| value == project_key) {
                state.project_order.insert(0, project_key.to_string());
            }
            store.save(&state)?;
            Ok(json!({
                "success": true,
                "accepted": true,
                "deviceId": device_id,
                "projectKey": project_key,
                "name": name,
                "roots": roots,
                "runtime": "kcoder",
            }))
        }
        "runtime.workspaces.rename" => {
            let workspace_path = params
                .get("workspacePath")
                .and_then(Value::as_str)
                .context("workspacePath is required")?;
            let project_key = params.get("projectKey").and_then(Value::as_str);
            let label = params
                .get("label")
                .or_else(|| params.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .context("name is required")?;
            if label.len() > 256 {
                anyhow::bail!("workspace label is too long")
            }
            let _guard = store.lock()?;
            let mut state = store.load();
            let mut matched = false;
            for record in state.records.values_mut() {
                if project_key.is_some_and(|key| workspace_record_matches(record, key))
                    || record.workspace_path == workspace_path
                {
                    record.label = label.to_string();
                    record.updated_at = app_server_now_ms();
                    matched = true;
                }
            }
            if !matched {
                anyhow::bail!("workspace was not found")
            }
            store.save(&state)?;
            Ok(
                json!({"success": true, "accepted": true, "deviceId": device_id, "workspacePath": workspace_path, "runtime": "kcoder"}),
            )
        }
        "runtime.workspaces.remove" => {
            let workspace_path = params
                .get("workspacePath")
                .and_then(Value::as_str)
                .context("workspacePath is required")?;
            let project_key = params.get("projectKey").and_then(Value::as_str);
            let _guard = store.lock()?;
            let mut state = store.load();
            let removed_keys = state
                .records
                .values()
                .filter(|record| {
                    project_key.is_some_and(|key| workspace_record_matches(record, key))
                        || record.workspace_path == workspace_path
                })
                .map(|record| record.project_key.clone())
                .collect::<HashSet<_>>();
            state.records.retain(|_, record| {
                !(project_key.is_some_and(|key| workspace_record_matches(record, key))
                    || record.workspace_path == workspace_path)
            });
            state
                .project_order
                .retain(|key| !removed_keys.contains(key));
            store.save(&state)?;
            Ok(
                json!({"success": true, "accepted": true, "deviceId": device_id, "workspacePath": workspace_path, "runtime": "kcoder"}),
            )
        }
        "runtime.workspaces.list" => {
            let _guard = store.lock()?;
            let state = store.load();
            let positions = state
                .project_order
                .iter()
                .enumerate()
                .map(|(index, key)| (key.as_str(), index))
                .collect::<HashMap<_, _>>();
            let mut records = state.records.values().collect::<Vec<_>>();
            records.sort_by_key(|record| {
                (
                    positions
                        .get(record.project_key.as_str())
                        .copied()
                        .unwrap_or(usize::MAX),
                    record.workspace_path.as_str(),
                )
            });
            let items = records
                .into_iter()
                .map(|record| {
                    let available = Path::new(&record.workspace_path).is_dir();
                    json!({
                        "deviceId": device_id,
                        "workspacePath": record.workspace_path,
                        "workspaceKind": "workspace",
                        "workspaceSource": "local",
                        "available": available,
                        "error": (!available).then_some("workspace directory is unavailable"),
                        "label": record.label,
                        "projectName": record.label,
                        "projectKey": record.project_key,
                        "projectRoots": record.roots,
                        "projectSource": "legacy_root",
                        "projectPinned": record.pinned,
                        "projectPinnedOrder": record.pinned_order,
                        "projectActive": record.active,
                        "projectAppearance": record.appearance,
                        "createdAt": record.created_at,
                        "updatedAt": record.updated_at,
                        "tasks": [],
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({
                "success": true,
                "deviceId": device_id,
                "items": items,
                "pinnedTaskIds": state.pinned_tasks,
                "rootProjectPinned": state.root_project_pinned.unwrap_or(true),
                "taskOrders": state.task_orders,
            }))
        }
        "runtime.sidebar.projects.reorder" => {
            let project_key = params
                .get("projectKey")
                .and_then(Value::as_str)
                .context("projectKey is required")?;
            let before = params.get("beforeProjectKey").and_then(Value::as_str);
            let _guard = store.lock()?;
            let mut state = store.load();
            if !state
                .records
                .values()
                .any(|record| workspace_record_matches(record, project_key))
            {
                anyhow::bail!("project was not found")
            }
            state.project_order.retain(|key| key != project_key);
            let index = before
                .and_then(|before| state.project_order.iter().position(|key| key == before))
                .unwrap_or(state.project_order.len());
            state.project_order.insert(index, project_key.to_string());
            store.save(&state)?;
            Ok(json!({"success": true, "accepted": true, "deviceId": device_id}))
        }
        "runtime.sidebar.projects.pin" => {
            let project_key = params
                .get("projectKey")
                .and_then(Value::as_str)
                .context("projectKey is required")?;
            let pinned = params
                .get("pinned")
                .and_then(Value::as_bool)
                .context("pinned is required")?;
            let root_project = match params.get("rootProject") {
                None => false,
                Some(Value::Bool(value)) => *value,
                _ => anyhow::bail!("rootProject must be a boolean"),
            };
            if root_project
                && std::fs::canonicalize(project_key)? != std::fs::canonicalize(engine.state.cwd())?
            {
                anyhow::bail!("root project must match the app-server workspace")
            }
            let _guard = store.lock()?;
            let mut state = store.load();
            let mut matched = root_project;
            if root_project {
                state.root_project_pinned = Some(pinned);
            }
            for record in state.records.values_mut() {
                if !root_project && workspace_record_matches(record, project_key) {
                    record.pinned = pinned;
                    record.pinned_order = pinned.then_some(0);
                    record.updated_at = app_server_now_ms();
                    matched = true;
                }
            }
            if !matched {
                anyhow::bail!("project was not found")
            }
            store.save(&state)?;
            Ok(json!({"success": true, "accepted": true, "deviceId": device_id}))
        }
        "runtime.sidebar.projects.appearance" => {
            let project_key = params
                .get("projectKey")
                .and_then(Value::as_str)
                .context("projectKey is required")?;
            let appearance = params.get("appearance").cloned().unwrap_or(Value::Null);
            if serde_json::to_vec(&appearance)?.len() > 16 * 1024 {
                anyhow::bail!("project appearance is too large")
            }
            let _guard = store.lock()?;
            let mut state = store.load();
            let mut matched = false;
            for record in state.records.values_mut() {
                if workspace_record_matches(record, project_key) {
                    record.appearance = appearance.clone();
                    record.updated_at = app_server_now_ms();
                    matched = true;
                }
            }
            if !matched {
                anyhow::bail!("project was not found")
            }
            store.save(&state)?;
            Ok(json!({"success": true, "accepted": true, "deviceId": device_id}))
        }
        "runtime.sidebar.projects.activate" => {
            let project_key = params.get("projectKey").and_then(Value::as_str);
            let workspace_path = params.get("workspacePath").and_then(Value::as_str);
            let _guard = store.lock()?;
            let mut state = store.load();
            for record in state.records.values_mut() {
                record.active = project_key
                    .is_some_and(|key| workspace_record_matches(record, key))
                    || workspace_path.is_some_and(|path| record.workspace_path == path);
            }
            store.save(&state)?;
            Ok(json!({"success": true, "accepted": true, "deviceId": device_id}))
        }
        "runtime.sidebar.tasks.pin" => {
            let thread_id = params
                .get("threadId")
                .and_then(Value::as_str)
                .context("threadId is required")?;
            let pinned = params
                .get("pinned")
                .and_then(Value::as_bool)
                .context("pinned is required")?;
            let _guard = store.lock()?;
            let mut state = store.load();
            state.pinned_tasks.retain(|value| value != thread_id);
            if pinned {
                let before = params.get("beforeThreadId").and_then(Value::as_str);
                let index = before
                    .and_then(|before| state.pinned_tasks.iter().position(|item| item == before))
                    .unwrap_or(state.pinned_tasks.len());
                state.pinned_tasks.insert(index, thread_id.to_string());
            }
            store.save(&state)?;
            Ok(json!({"success": true, "accepted": true, "deviceId": device_id}))
        }
        "runtime.sidebar.tasks.reorder" => {
            let project_key = params
                .get("projectKey")
                .and_then(Value::as_str)
                .context("projectKey is required")?;
            let thread_id = params
                .get("threadId")
                .and_then(Value::as_str)
                .context("threadId is required")?;
            let before = params.get("beforeThreadId").and_then(Value::as_str);
            let _guard = store.lock()?;
            let mut state = store.load();
            let order = state
                .task_orders
                .entry(project_key.to_string())
                .or_default();
            order.retain(|item| item != thread_id);
            let index = before
                .and_then(|before| order.iter().position(|item| item == before))
                .unwrap_or(order.len());
            order.insert(index, thread_id.to_string());
            store.save(&state)?;
            Ok(json!({"success": true, "accepted": true, "deviceId": device_id}))
        }
        "runtime.sidebar.projects.sync_remote" => Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": device_id,
        })),
        _ => anyhow::bail!("unsupported workspace method: {method}"),
    }
}

pub(super) async fn workspace_search_request(
    engine: &QueryEngine,
    params: &Value,
) -> Result<Value> {
    let root = params
        .get("root")
        .and_then(Value::as_str)
        .context("root is required")?;
    let query = params
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if query.is_empty() {
        return Ok(json!({"files": []}));
    }
    if query.len() > 256 {
        anyhow::bail!("workspace search query is too long")
    }
    let root = dunce::canonicalize(root)?;
    if !tokio::fs::metadata(&root).await?.is_dir() {
        anyhow::bail!("workspace search root is not a directory")
    }
    let configured = dunce::canonicalize(engine.state.cwd())?;
    let inside_configured = root == configured || root.starts_with(&configured);
    let managed = if inside_configured {
        false
    } else {
        let store = ClientWorktreeStore::new(engine);
        let _guard = store.lock()?;
        store
            .load()?
            .records
            .values()
            .filter(|record| Path::new(&record.path).exists())
            .filter_map(|record| dunce::canonicalize(&record.path).ok())
            .any(|allowed| root == allowed || root.starts_with(allowed))
    };
    if !inside_configured && !managed {
        anyhow::bail!("workspace search root has not been opened")
    }
    let query = query.to_lowercase();
    let scan_root = root.clone();
    let files = tokio::task::spawn_blocking(move || -> Result<Vec<Value>> {
        let mut pending = vec![(scan_root.clone(), 0_usize)];
        let mut visited = 0_usize;
        let mut matches = Vec::<(usize, Value)>::new();
        while let Some((directory, depth)) = pending.pop() {
            if depth > 20 || visited >= 50_000 {
                continue;
            }
            let entries = match std::fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                visited += 1;
                if visited > 50_000 {
                    break;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if matches!(name.as_str(), ".git" | "node_modules" | "target" | ".next") {
                    continue;
                }
                let entry_path = entry.path();
                let metadata = match std::fs::symlink_metadata(&entry_path) {
                    Ok(metadata) if !metadata.file_type().is_symlink() => metadata,
                    _ => continue,
                };
                let relative = entry_path
                    .strip_prefix(&scan_root)
                    .unwrap_or(&entry_path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let haystack = relative.to_lowercase();
                if let Some(index) = haystack.find(&query) {
                    let score = 10_000_usize
                        .saturating_sub(index * 10)
                        .saturating_sub(depth * 25)
                        .saturating_sub(relative.len());
                    matches.push((
                        score,
                        json!({
                            "root": scan_root,
                            "path": relative,
                            "fileName": name,
                            "matchType": if metadata.is_dir() { "directory" } else { "file" },
                            "score": score,
                            "indices": (index..index + query.len()).collect::<Vec<_>>(),
                        }),
                    ));
                }
                if metadata.is_dir() {
                    pending.push((entry_path, depth + 1));
                }
            }
        }
        matches.sort_by_key(|item| std::cmp::Reverse(item.0));
        matches.truncate(200);
        Ok(matches.into_iter().map(|(_, value)| value).collect())
    })
    .await
    .context("workspace search task failed")??;
    Ok(json!({"files": files}))
}
