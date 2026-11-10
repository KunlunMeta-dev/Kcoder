//! Bounded connection-owned holds. Expiry never authorizes an automatic reopen.
use super::*;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub const HISTORY_VIEW_TTL_MS: u32 = 30_000;
const MAX_ACTIVE: usize = 16;
const MAX_SOURCES: usize = 256;
const MAX_REQUESTS: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryViewLeaseState {
    Active,
    Released,
    Expired,
    Invalidated,
}

#[derive(Clone, PartialEq, Eq)]
pub struct HistoryViewLeaseObservation {
    pub request_id: String,
    pub lease_id: String,
    pub binding: HistoryViewBinding,
    pub sequence: u64,
    pub state: HistoryViewLeaseState,
    pub remaining_ms: u32,
}

struct Slot {
    profile: String,
    lease: String,
    binding: HistoryViewBinding,
    sequence: u64,
    state: HistoryViewLeaseState,
    expiry: Instant,
    hold: Option<Arc<Mutex<HistoryViewHold>>>,
}

impl Slot {
    fn expire(&mut self, now: Instant) {
        if self.hold.is_some() && now >= self.expiry {
            self.state = HistoryViewLeaseState::Expired;
            self.hold = None;
        }
    }
    fn observe(&self, request: &str, now: Instant) -> HistoryViewLeaseObservation {
        HistoryViewLeaseObservation {
            request_id: request.into(),
            lease_id: self.lease.clone(),
            binding: self.binding.clone(),
            sequence: self.sequence,
            state: self.state,
            remaining_ms: if self.state == HistoryViewLeaseState::Active {
                self.expiry
                    .saturating_duration_since(now)
                    .as_millis()
                    .min(u32::MAX as u128) as u32
            } else {
                0
            },
        }
    }
}

/// Host gateways must additionally preserve their own logical-client mapping.
/// This instance owns only one native connection and can never release a peer instance.
#[derive(Clone)]
pub struct HistoryViewLeases {
    slots: Arc<Mutex<BTreeMap<String, Slot>>>,
    closed: Arc<AtomicBool>,
    ttl: Duration,
}

fn valid_nonce(id: &str) -> Result<()> {
    ensure!(
        uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id),
        "history_view_invalid_identity"
    );
    Ok(())
}

fn profile_identity(profile: &Path) -> Result<String> {
    let directory = PrivateDirectory::open_existing(profile)?;
    directory.verify_trusted_config_directory()?;
    directory.directory_identity()
}

impl Default for HistoryViewLeases {
    fn default() -> Self {
        Self {
            slots: Arc::default(),
            closed: Arc::default(),
            ttl: Duration::from_millis(HISTORY_VIEW_TTL_MS as u64),
        }
    }
}

impl HistoryViewLeases {
    #[cfg(test)]
    pub(super) fn with_ttl(ttl: Duration) -> Self {
        Self {
            ttl,
            ..Self::default()
        }
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, BTreeMap<String, Slot>>> {
        self.slots
            .lock()
            .map_err(|_| anyhow::anyhow!("history_view_unavailable"))
    }

    /// The host drives this from its connection-owned timer, even while no RPCs arrive.
    pub fn expire(&self) -> Result<()> {
        let now = Instant::now();
        for slot in self.lock()?.values_mut() {
            slot.expire(now);
        }
        Ok(())
    }

    pub fn clear(&self) {
        self.closed.store(true, Ordering::Release);
        self.slots
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }

    pub fn open(
        &self,
        profile: &Path,
        request: &str,
        job: &str,
        archive: &str,
        view: Option<&str>,
    ) -> Result<HistoryViewLeaseObservation> {
        valid_nonce(request)?;
        ensure!(
            !self.closed.load(Ordering::Acquire),
            "history_view_connection_closed"
        );
        let profile_id = profile_identity(profile)?;
        self.expire()?;
        {
            let slots = self.lock()?;
            if let Some(slot) = slots.get(request) {
                ensure!(
                    slot.profile == profile_id
                        && slot.binding.job_id == job
                        && slot.binding.archive_id == archive
                        && slot.binding.view_id.as_deref() == view,
                    "history_view_request_conflict"
                );
                return Ok(slot.observe(request, Instant::now()));
            }
        }
        // A slow open never holds the slot-map mutex or blocks an existing release.
        let hold = HistoryViewHold::open(profile, job, view)?;
        ensure!(
            hold.profile_identity == profile_id && hold.binding.archive_id == archive,
            "history_view_binding_changed"
        );
        let mut slots = self.lock()?;
        ensure!(
            !self.closed.load(Ordering::Acquire),
            "history_view_connection_closed"
        );
        let now = Instant::now();
        for slot in slots.values_mut() {
            slot.expire(now);
        }
        if let Some(slot) = slots.get(request) {
            ensure!(
                slot.profile == profile_id && slot.binding == hold.binding,
                "history_view_request_conflict"
            );
            return Ok(slot.observe(request, now));
        }
        ensure!(
            slots.len() < MAX_REQUESTS,
            "history_view_request_budget_exceeded"
        );
        let active = slots.values().filter(|slot| slot.hold.is_some());
        let (count, sources) = active.fold((0, 0), |(count, sources), slot| {
            (
                count + 1,
                sources + slot.binding.managed_archives + slot.binding.legacy_archives,
            )
        });
        ensure!(
            count < MAX_ACTIVE
                && sources + hold.binding.managed_archives + hold.binding.legacy_archives
                    <= MAX_SOURCES,
            "history_view_active_budget_exceeded"
        );
        let slot = Slot {
            profile: profile_id,
            lease: uuid::Uuid::new_v4().to_string(),
            binding: hold.binding.clone(),
            sequence: 1,
            state: HistoryViewLeaseState::Active,
            expiry: now + self.ttl,
            hold: Some(Arc::new(Mutex::new(hold))),
        };
        let observation = slot.observe(request, now);
        slots.insert(request.into(), slot);
        Ok(observation)
    }

    pub fn read(
        &self,
        profile: &Path,
        request: &str,
        lease: Option<&str>,
    ) -> Result<Option<HistoryViewLeaseObservation>> {
        valid_nonce(request)?;
        let profile = profile_identity(profile)?;
        let mut slots = self.lock()?;
        let Some(slot) = slots.get_mut(request) else {
            return Ok(None);
        };
        ensure!(
            slot.profile == profile && lease.is_none_or(|lease| slot.lease == lease),
            "history_view_wrong_owner"
        );
        let now = Instant::now();
        slot.expire(now);
        Ok(Some(slot.observe(request, now)))
    }

    pub fn renew(
        &self,
        profile: &Path,
        request: &str,
        lease: &str,
        sequence: u64,
    ) -> Result<HistoryViewLeaseObservation> {
        let initial = self
            .read(profile, request, Some(lease))?
            .context("history_view_not_found")?;
        ensure!(initial.sequence == sequence, "history_view_stale_sequence");
        ensure!(
            initial.state == HistoryViewLeaseState::Active,
            "history_view_not_active"
        );
        let hold = self
            .lock()?
            .get(request)
            .and_then(|slot| slot.hold.clone())
            .context("history_view_not_active")?;
        let checked = hold
            .lock()
            .map_err(|_| anyhow::anyhow!("history_view_unavailable"))?
            .validate(profile);
        let mut slots = self.lock()?;
        let slot = slots.get_mut(request).context("history_view_not_found")?;
        let now = Instant::now();
        slot.expire(now);
        ensure!(
            slot.lease == lease
                && slot.sequence == sequence
                && slot.state == HistoryViewLeaseState::Active,
            "history_view_stale_sequence"
        );
        if checked.is_err() {
            // An unconfirmed renewal cannot revoke the original bounded read
            // fence early. Keep its original deadline; explicit release still works.
            slot.state = HistoryViewLeaseState::Invalidated;
            anyhow::bail!("history_view_binding_changed");
        }
        slot.sequence = slot
            .sequence
            .checked_add(1)
            .context("history_view_sequence_exhausted")?;
        slot.expiry = now + self.ttl;
        Ok(slot.observe(request, now))
    }

    pub fn release(
        &self,
        profile: &Path,
        request: &str,
        lease: &str,
    ) -> Result<Option<HistoryViewLeaseObservation>> {
        self.read(profile, request, Some(lease))?;
        let mut slots = self.lock()?;
        let Some(slot) = slots.get_mut(request) else {
            return Ok(None);
        };
        if slot.hold.is_some() || slot.state == HistoryViewLeaseState::Active {
            slot.state = HistoryViewLeaseState::Released;
            slot.hold = None;
        }
        Ok(Some(slot.observe(request, Instant::now())))
    }
}
