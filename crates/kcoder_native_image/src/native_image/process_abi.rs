//! Opaque observations of the launcher's original Windows child process.
use super::{
    API,
    abi::{Api, Env, Info, Reference, Value},
    image::ImageLease,
    process::ProcessLease,
};
use anyhow::{Context, Result, ensure};
use std::{
    collections::HashMap,
    ffi::c_void,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    thread::ThreadId,
};

const MAX_LEASES: usize = 256;
static RECORDS: OnceLock<Mutex<HashMap<usize, Record>>> = OnceLock::new();
static NEXT_ID: AtomicUsize = AtomicUsize::new(1);
struct Record {
    env: usize,
    owner: ThreadId,
    reference: usize,
    image_id: usize,
    _loaded_addon: Arc<ImageLease>,
    target: Arc<ImageLease>,
    process: ProcessLease,
}
fn records() -> &'static Mutex<HashMap<usize, Record>> {
    RECORDS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) unsafe extern "C" fn capture(env: Env, info: Info) -> Value {
    super::finish(
        env,
        std::panic::catch_unwind(|| -> Result<Value> {
            let api = API.get().context("NATIVE_ADDON_HOST_UNAVAILABLE")?;
            let args = api.arguments(env, info, 2)?;
            let mut data = std::ptr::null_mut();
            // SAFETY: Node validates its private image wrap; the pointer is only a registry key.
            api.check(unsafe { (api.unwrap)(env, args[0], &mut data) })?;
            let image_id = data as usize;
            let (loaded, target) = {
                let images = super::registry()
                    .lock()
                    .map_err(|_| anyhow::anyhow!("NATIVE_IMAGE_STATE_UNAVAILABLE"))?;
                let image = images
                    .get(&image_id)
                    .context("NATIVE_IMAGE_STATE_UNAVAILABLE")?;
                ensure!(
                    super::original(api, env, args[0], image)?,
                    "NATIVE_IMAGE_IDENTITY_CHANGED"
                );
                (image._loaded_addon.clone(), image.target.clone())
            };
            let process = ProcessLease::capture(&target, api.process_id(env, args[1])?)?;
            let id = NEXT_ID
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                    value.checked_add(1)
                })
                .map_err(|_| anyhow::anyhow!("NATIVE_PROCESS_CAPACITY"))?;
            let mut registry = records()
                .lock()
                .map_err(|_| anyhow::anyhow!("NATIVE_PROCESS_STATE_UNAVAILABLE"))?;
            ensure!(registry.len() < MAX_LEASES, "NATIVE_PROCESS_CAPACITY");
            let mut object = std::ptr::null_mut();
            api.check(unsafe { (api.create_object)(env, &mut object) })?;
            let mut reference = std::ptr::null_mut();
            // SAFETY: this new plain object carries only a module-private key and weak original reference.
            api.check(unsafe {
                (api.wrap)(
                    env,
                    object,
                    id as *mut c_void,
                    Some(finalize),
                    std::ptr::null_mut(),
                    &mut reference,
                )
            })?;
            registry.insert(
                id,
                Record {
                    env: env as usize,
                    owner: std::thread::current().id(),
                    reference: reference as usize,
                    image_id,
                    _loaded_addon: loaded,
                    target,
                    process,
                },
            );
            Ok(object)
        }),
    )
}

pub(super) unsafe extern "C" fn matches(env: Env, info: Info) -> Value {
    super::finish(
        env,
        std::panic::catch_unwind(|| -> Result<Value> {
            let api = API.get().context("NATIVE_ADDON_HOST_UNAVAILABLE")?;
            let args = api.arguments(env, info, 1)?;
            let mut data = std::ptr::null_mut();
            api.check(unsafe { (api.unwrap)(env, args[0], &mut data) })?;
            let registry = records()
                .lock()
                .map_err(|_| anyhow::anyhow!("NATIVE_PROCESS_STATE_UNAVAILABLE"))?;
            let valid = if let Some(record) = registry.get(&(data as usize)) {
                if !original(api, env, args[0], record)? {
                    false
                } else {
                    let images = super::registry()
                        .lock()
                        .map_err(|_| anyhow::anyhow!("NATIVE_IMAGE_STATE_UNAVAILABLE"))?;
                    let image_current = images.get(&record.image_id).is_some_and(|image| {
                        image.env == record.env
                            && image.owner == record.owner
                            && Arc::ptr_eq(&image.target, &record.target)
                    });
                    image_current && record.process.verify(&record.target).is_ok()
                }
            } else {
                false
            };
            api.boolean(env, valid)
        }),
    )
}

pub(super) unsafe extern "C" fn close(env: Env, info: Info) -> Value {
    super::finish(
        env,
        std::panic::catch_unwind(|| -> Result<Value> {
            let api = API.get().context("NATIVE_ADDON_HOST_UNAVAILABLE")?;
            let args = api.arguments(env, info, 1)?;
            let mut data = std::ptr::null_mut();
            api.check(unsafe { (api.unwrap)(env, args[0], &mut data) })?;
            let mut registry = records()
                .lock()
                .map_err(|_| anyhow::anyhow!("NATIVE_PROCESS_STATE_UNAVAILABLE"))?;
            let matched = registry
                .get(&(data as usize))
                .map(|record| original(api, env, args[0], record))
                .transpose()?
                .unwrap_or(false);
            if matched {
                api.check(unsafe { (api.remove_wrap)(env, args[0], &mut data) })?;
                let record = registry
                    .remove(&(data as usize))
                    .context("NATIVE_PROCESS_STATE_UNAVAILABLE")?;
                api.check(unsafe { (api.delete_reference)(env, record.reference as Reference) })?;
            }
            api.boolean(env, matched)
        }),
    )
}

pub(super) unsafe extern "C" fn system_path(env: Env, info: Info) -> Value {
    super::finish(
        env,
        std::panic::catch_unwind(|| -> Result<Value> {
            let api = API.get().context("NATIVE_ADDON_HOST_UNAVAILABLE")?;
            api.arguments(env, info, 0)?;
            api.string_value(env, super::process::system_ssh_path()?.as_os_str())
        }),
    )
}

fn original(api: &Api, env: Env, value: Value, record: &Record) -> Result<bool> {
    if record.env != env as usize || record.owner != std::thread::current().id() {
        return Ok(false);
    }
    let mut object = std::ptr::null_mut();
    api.check(unsafe {
        (api.get_reference_value)(env, record.reference as Reference, &mut object)
    })?;
    let mut equal = false;
    if !object.is_null() {
        api.check(unsafe { (api.strict_equals)(env, object, value, &mut equal) })?;
    }
    Ok(equal)
}

unsafe extern "C" fn finalize(env: Env, data: *mut c_void, _: *mut c_void) {
    let _ = std::panic::catch_unwind(|| {
        let Ok(mut registry) = records().lock() else {
            return;
        };
        let Some(record) = registry.get(&(data as usize)) else {
            return;
        };
        if record.env != env as usize || record.owner != std::thread::current().id() {
            return;
        }
        if let Some(record) = registry.remove(&(data as usize))
            && let Some(api) = API.get()
        {
            // SAFETY: this weak reference was created by this exact environment.
            let _ = unsafe { (api.delete_reference)(env, record.reference as Reference) };
        }
    });
}
