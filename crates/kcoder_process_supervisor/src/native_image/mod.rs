//! A process-local opaque image capability, not a serializable launch grant.
mod abi;
mod image;

use abi::{Api, Env, Info, Reference, Value};
use anyhow::{Context, Result, ensure};
use image::ImageLease;
use std::{
    collections::HashMap,
    ffi::c_void,
    path::Path,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    thread::ThreadId,
};

static API: OnceLock<Api> = OnceLock::new();
static LEASES: OnceLock<Mutex<HashMap<usize, Lease>>> = OnceLock::new();
static NEXT_ID: AtomicUsize = AtomicUsize::new(1);
struct Lease {
    env: usize,
    owner: ThreadId,
    reference: usize,
    _loaded_addon: ImageLease,
    target: ImageLease,
}
fn registry() -> &'static Mutex<HashMap<usize, Lease>> {
    LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Node resolves this exact stable entry after loading this deployed module.
///
/// # Safety
/// Node must supply its own live module environment and exports value.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_register_module_v1(env: Env, exports: Value) -> Value {
    let result = std::panic::catch_unwind(|| -> Result<Value> {
        if API.get().is_none() {
            let _ = API.set(Api::load()?);
        }
        let api = API.get().context("NATIVE_ADDON_HOST_UNAVAILABLE")?;
        for (name, callback) in [
            (c"captureImage", capture as abi::Callback),
            (c"sameImage", matches as abi::Callback),
            (c"closeImage", close as abi::Callback),
        ] {
            let mut function = std::ptr::null_mut();
            // SAFETY: env/exports belong to this Node module callback and the
            // callback signatures are the exact stable Node-API C ABI.
            api.check(unsafe {
                (api.create_function)(
                    env,
                    name.as_ptr(),
                    name.count_bytes(),
                    Some(callback),
                    std::ptr::null_mut(),
                    &mut function,
                )
            })?;
            api.check(unsafe { (api.set_named_property)(env, exports, name.as_ptr(), function) })?;
        }
        let mut version = std::ptr::null_mut();
        // SAFETY: the output pointer and module exports are valid in this callback.
        api.check(unsafe { (api.create_uint32)(env, 1, &mut version) })?;
        api.check(unsafe {
            (api.set_named_property)(env, exports, c"abiVersion".as_ptr(), version)
        })?;
        Ok(exports)
    });
    finish(env, result)
}

#[unsafe(no_mangle)]
pub extern "C" fn node_api_module_get_api_version_v1() -> i32 {
    1
}

unsafe extern "C" fn capture(env: Env, info: Info) -> Value {
    finish(
        env,
        std::panic::catch_unwind(|| -> Result<Value> {
            let api = API.get().context("NATIVE_ADDON_HOST_UNAVAILABLE")?;
            let args = api.arguments(env, info, 4)?;
            let addon_path = api.string(env, args[0])?;
            let addon_sha = api.string(env, args[1])?;
            let target_path = api.string(env, args[2])?;
            let target_sha = api.string(env, args[3])?;
            let mapped_path = image::loaded_addon_path(napi_register_module_v1 as *const c_void)?;
            let loaded = ImageLease::capture(&mapped_path, &addon_sha, true)?;
            let declared = ImageLease::capture(Path::new(&addon_path), &addon_sha, true)?;
            ensure!(
                loaded.same_image(&declared),
                "NATIVE_ADDON_MAPPING_MISMATCH"
            );
            let target = ImageLease::capture(Path::new(&target_path), &target_sha, false)?;
            let id = NEXT_ID
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
                .map_err(|_| anyhow::anyhow!("NATIVE_IMAGE_CAPACITY"))?;
            let mut external = std::ptr::null_mut();
            // SAFETY: this creates an ordinary object with no authority-bearing
            // properties. Only this loaded module's private wrap can identify it.
            api.check(unsafe { (api.create_object)(env, &mut external) })?;
            let mut reference = std::ptr::null_mut();
            // The key is never dereferenced. napi_wrap returns an original weak
            // object reference; copied/foreign wrappers cannot impersonate it.
            api.check(unsafe {
                (api.wrap)(
                    env,
                    external,
                    id as *mut c_void,
                    Some(finalize),
                    std::ptr::null_mut(),
                    &mut reference,
                )
            })?;
            let record = Lease {
                env: env as usize,
                owner: std::thread::current().id(),
                reference: reference as usize,
                _loaded_addon: loaded,
                target,
            };
            registry()
                .lock()
                .map_err(|_| anyhow::anyhow!("NATIVE_IMAGE_STATE_UNAVAILABLE"))?
                .insert(id, record);
            Ok(external)
        }),
    )
}

unsafe extern "C" fn matches(env: Env, info: Info) -> Value {
    finish(
        env,
        std::panic::catch_unwind(|| -> Result<Value> {
            let api = API.get().context("NATIVE_ADDON_HOST_UNAVAILABLE")?;
            let args = api.arguments(env, info, 2)?;
            let path = api.string(env, args[1])?;
            let mut data = std::ptr::null_mut();
            // SAFETY: Node validates its private object wrap; data is only a map key.
            api.check(unsafe { (api.unwrap)(env, args[0], &mut data) })?;
            let registry = registry()
                .lock()
                .map_err(|_| anyhow::anyhow!("NATIVE_IMAGE_STATE_UNAVAILABLE"))?;
            let result = match registry.get(&(data as usize)) {
                Some(lease) if original(api, env, args[0], lease)? => {
                    lease.target.matches(Path::new(&path))?
                }
                _ => false,
            };
            api.boolean(env, result)
        }),
    )
}

unsafe extern "C" fn close(env: Env, info: Info) -> Value {
    finish(
        env,
        std::panic::catch_unwind(|| -> Result<Value> {
            let api = API.get().context("NATIVE_ADDON_HOST_UNAVAILABLE")?;
            let args = api.arguments(env, info, 1)?;
            let mut data = std::ptr::null_mut();
            // SAFETY: no pointer data is dereferenced; lookup requires original identity.
            api.check(unsafe { (api.unwrap)(env, args[0], &mut data) })?;
            let mut registry = registry()
                .lock()
                .map_err(|_| anyhow::anyhow!("NATIVE_IMAGE_STATE_UNAVAILABLE"))?;
            let original = match registry.get(&(data as usize)) {
                Some(lease) => original(api, env, args[0], lease)?,
                None => false,
            };
            if original {
                let mut unwrapped = std::ptr::null_mut();
                // SAFETY: the original private wrapper was just checked in this env.
                api.check(unsafe { (api.remove_wrap)(env, args[0], &mut unwrapped) })?;
                ensure!(unwrapped == data, "NATIVE_IMAGE_STATE_UNAVAILABLE");
                let removed = registry
                    .remove(&(data as usize))
                    .context("NATIVE_IMAGE_STATE_UNAVAILABLE")?;
                // SAFETY: the weak reference was created in this same environment.
                api.check(unsafe { (api.delete_reference)(env, removed.reference as Reference) })?;
                drop(removed);
            }
            api.boolean(env, original)
        }),
    )
}

fn original(api: &Api, env: Env, value: Value, lease: &Lease) -> Result<bool> {
    if lease.env != env as usize || lease.owner != std::thread::current().id() {
        return Ok(false);
    }
    let mut original = std::ptr::null_mut();
    // SAFETY: the exact env and owner thread fence precedes use of its weak reference.
    api.check(unsafe {
        (api.get_reference_value)(env, lease.reference as Reference, &mut original)
    })?;
    let mut equal = false;
    if !original.is_null() {
        // SAFETY: both values belong to the same live Node environment.
        api.check(unsafe { (api.strict_equals)(env, original, value, &mut equal) })?;
    }
    Ok(equal)
}

unsafe extern "C" fn finalize(env: Env, data: *mut c_void, _: *mut c_void) {
    let _ = std::panic::catch_unwind(|| {
        let Ok(mut registry) = registry().lock() else {
            return;
        };
        let Some(record) = registry.get(&(data as usize)) else {
            return;
        };
        if record.env != env as usize || record.owner != std::thread::current().id() {
            return;
        }
        if let Some(record) = registry.remove(&(data as usize)) {
            if let Some(api) = API.get() {
                // SAFETY: deletion of this env's weak reference is allowed by the basic finalizer ABI.
                let _ = unsafe { (api.delete_reference)(env, record.reference as Reference) };
            }
            drop(record);
        }
    });
}

fn finish(env: Env, result: std::thread::Result<Result<Value>>) -> Value {
    match result {
        Ok(Ok(value)) => value,
        _ => {
            if let Some(api) = API.get() {
                // SAFETY: this callback's env is live. Only a finite code crosses
                // the JS boundary; paths and internal OS diagnostics stay private.
                let _ = unsafe {
                    (api.throw_error)(
                        env,
                        c"NATIVE_IMAGE_UNAVAILABLE".as_ptr(),
                        c"Native image lease unavailable".as_ptr(),
                    )
                };
            }
            std::ptr::null_mut()
        }
    }
}
