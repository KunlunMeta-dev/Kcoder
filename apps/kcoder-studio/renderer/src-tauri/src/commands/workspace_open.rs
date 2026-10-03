//! Pending workspace-open requests and single-instance routing.

use crate::*;

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalWorkspaceOpenRequest {
    pub(crate) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) label: Option<String>,
}

#[derive(Default)]
pub(crate) struct LocalWorkspaceOpenState {
    #[cfg(desktop)]
    pub(crate) pending_requests: Mutex<Vec<LocalWorkspaceOpenRequest>>,
}

#[cfg(desktop)]
pub(crate) fn parse_local_workspace_open_request(
    argv: &[String],
) -> Option<LocalWorkspaceOpenRequest> {
    let mut path: Option<String> = None;
    let mut label: Option<String> = None;
    let mut index = 1;

    while index < argv.len() {
        match argv[index].as_str() {
            "--open-workspace" => {
                index += 1;
                path = argv
                    .get(index)
                    .and_then(|value| normalized_non_empty(value.clone()));
            }
            "--workspace-label" => {
                index += 1;
                label = argv
                    .get(index)
                    .and_then(|value| normalized_non_empty(value.clone()));
            }
            _ => {}
        }
        index += 1;
    }

    path.map(|path| LocalWorkspaceOpenRequest { path, label })
}

#[cfg(desktop)]
pub(crate) fn queue_local_workspace_open_request<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: LocalWorkspaceOpenRequest,
) {
    let state = app.state::<LocalWorkspaceOpenState>();
    match state.pending_requests.lock() {
        Ok(mut requests) => requests.push(request),
        Err(_) => {
            log::warn!("Failed to lock pending local workspace open requests");
            return;
        }
    }

    if let Err(error) = app.emit(LOCAL_WORKSPACE_OPEN_REQUESTED_EVENT, ()) {
        log::debug!("Local workspace open request queued before frontend listener: {error}");
    }
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn take_pending_local_workspace_open_requests(
    app: tauri::AppHandle,
) -> Result<Vec<LocalWorkspaceOpenRequest>, String> {
    let state = app.state::<LocalWorkspaceOpenState>();
    let mut requests = state
        .pending_requests
        .lock()
        .map_err(|_| "Failed to lock pending local workspace open requests".to_string())?;
    Ok(std::mem::take(&mut *requests))
}

#[cfg(not(desktop))]
#[tauri::command]
pub(crate) fn take_pending_local_workspace_open_requests(
    _app: tauri::AppHandle,
) -> Result<Vec<LocalWorkspaceOpenRequest>, String> {
    Err("Local workspace open requests are only available on desktop".to_string())
}
