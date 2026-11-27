//! Retain one matched original close until its existing backend is returned.
use super::*;

pub(super) struct PendingClose {
    pub(super) id: Value,
    original: NativeRemoteControlFrameV1,
    pub(super) deadline: tokio::time::Instant,
}
impl PendingClose {
    pub(super) fn new(id: Value, original: NativeRemoteControlFrameV1) -> Self {
        Self {
            id,
            original,
            deadline: tokio::time::Instant::now() + Duration::from_secs(10),
        }
    }
}

pub(super) fn start_ready(
    pending: &mut Option<PendingClose>,
    sessions: &mut BTreeMap<String, Slot>,
    tasks: &mut JoinSet<Completion>,
) {
    if pending.is_none() {
        return;
    }
    let Some(mut backend) = sessions.values_mut().find_map(|slot| slot.backend.take()) else {
        return;
    };
    let PendingClose { id, original, .. } = pending.take().expect("original pending close");
    tasks.spawn(async move {
        let result = backend.close_native_original(&original).await;
        Completion::NativeClosed {
            id,
            backend,
            result,
        }
    });
}
