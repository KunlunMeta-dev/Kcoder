//! Node-owned storage kernel leases. No path resolver, migration or authorization policy.
mod abi;
mod lease;

use abi::{Api, Env, Fault, Info, Value};
use anyhow::{Context, Result, ensure};
use lease::{Acquisition, Mode, StorageLease};
use std::{ffi::c_void, path::Path, ptr::NonNull, sync::OnceLock, thread::ThreadId};

static API: OnceLock<Api> = OnceLock::new();

struct WrappedLease {
    env: usize,
    thread: ThreadId,
    lease: Option<StorageLease>,
}

/// Node supplies the live module environment and exports object.
///
/// # Safety
/// The caller must be the Node host loading this addon through its module ABI.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_register_module_v1(env: Env, exports: Value) -> Value {
    finish(
        env,
        std::panic::catch_unwind(|| -> Result<Value> {
            if API.get().is_none() {
                let _ = API.set(Api::load()?);
            }
            let api = api()?;
            for (name, callback) in [
                (c"tryShared", shared as abi::Callback),
                (c"tryExclusive", exclusive as abi::Callback),
                (c"trySharedExisting", shared_existing as abi::Callback),
                (c"verify", verify as abi::Callback),
                (c"observeEntry", observe_entry as abi::Callback),
                (
                    c"readSourceRetirement",
                    read_source_retirement as abi::Callback,
                ),
                (c"close", close as abi::Callback),
            ] {
                let mut function = std::ptr::null_mut();
                // SAFETY: these callbacks and names have the stable Node-API ABI.
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
                api.check(unsafe {
                    (api.set_named_property)(env, exports, name.as_ptr(), function)
                })?;
            }
            let mut version = std::ptr::null_mut();
            // SAFETY: output and exports belong to this live module callback.
            api.check(unsafe { (api.create_uint32)(env, 1, &mut version) })?;
            api.check(unsafe {
                (api.set_named_property)(env, exports, c"abiVersion".as_ptr(), version)
            })?;
            Ok(exports)
        }),
    )
}

#[unsafe(no_mangle)]
pub extern "C" fn node_api_module_get_api_version_v1() -> i32 {
    8
}

unsafe extern "C" fn shared(env: Env, info: Info) -> Value {
    acquire(env, info, Mode::Shared)
}
unsafe extern "C" fn exclusive(env: Env, info: Info) -> Value {
    acquire(env, info, Mode::Exclusive)
}
unsafe extern "C" fn shared_existing(env: Env, info: Info) -> Value {
    acquire(env, info, Mode::SharedExisting)
}

fn acquire(env: Env, info: Info, mode: Mode) -> Value {
    finish(
        env,
        std::panic::catch_unwind(|| -> Result<Value> {
            let api = api()?;
            let existing = matches!(mode, Mode::SharedExisting);
            let args = api.arguments(env, info, if existing { 2 } else { 3 })?;
            let path = api.string(env, args[0], 32768)?;
            let name = api.string(env, args[1], 64)?;
            let create_root = if existing {
                false
            } else {
                api.bool_argument(env, args[2])?
            };
            let acquired = StorageLease::acquire(Path::new(&path), &name, mode, create_root)?;
            let missing = matches!(&acquired, Acquisition::Missing);
            match acquired {
                Acquisition::Missing | Acquisition::Busy => {
                    let mut value = std::ptr::null_mut();
                    // SAFETY: these return primitives in the original callback environment.
                    let status = unsafe {
                        if missing {
                            (api.get_undefined)(env, &mut value)
                        } else {
                            (api.get_null)(env, &mut value)
                        }
                    };
                    api.check(status)?;
                    Ok(value)
                }
                Acquisition::Held(lease) => wrap(api, env, lease),
            }
        }),
    )
}

fn wrap(api: &Api, env: Env, lease: StorageLease) -> Result<Value> {
    let mut object = std::ptr::null_mut();
    // SAFETY: this creates and brands a new ordinary object in the current environment.
    api.check(unsafe { (api.create_object)(env, &mut object) })?;
    api.check(unsafe { (api.type_tag_object)(env, object, &abi::lease_tag()) })?;
    let handle = Box::new(WrappedLease {
        env: env as usize,
        thread: std::thread::current().id(),
        lease: Some(lease),
    });
    let data = Box::into_raw(handle);
    // SAFETY: Node takes this exact allocation only on successful wrapping, and
    // calls its finalizer once. No weak reference or registry is required.
    let status = unsafe {
        (api.wrap)(
            env,
            object,
            data.cast(),
            Some(finalize),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if let Err(error) = api.check(status) {
        // SAFETY: failed wrapping did not transfer this allocation to Node.
        drop(unsafe { Box::from_raw(data) });
        return Err(error);
    }
    Ok(object)
}

fn handle(api: &Api, env: Env, object: Value) -> Result<NonNull<WrappedLease>> {
    let mut kind = -1;
    // SAFETY: typeof validates the value without ToObject/coercion. Null must
    // be rejected before the tag API can leave a pending V8 TypeError.
    let status = unsafe { (api.type_of)(env, object, &mut kind) };
    ensure!(status == 0 && kind == 6, Fault::Handle); // napi_object
    let mut tagged = false;
    // SAFETY: Node validates the object; no pointer is used before its private brand matches.
    let status =
        unsafe { (api.check_object_type_tag)(env, object, &abi::lease_tag(), &mut tagged) };
    ensure!(status == 0 && tagged, Fault::Handle);
    let mut data = std::ptr::null_mut();
    // SAFETY: only objects carrying this addon's private type tag reach unwrap.
    ensure!(
        unsafe { (api.unwrap)(env, object, &mut data) } == 0,
        Fault::Handle
    );
    let pointer = NonNull::<WrappedLease>::new(data.cast()).context(Fault::Handle)?;
    // SAFETY: this is the allocation made by wrap, and the JS argument keeps its
    // object alive throughout the synchronous callback. It cannot be JS-forged.
    let handle = unsafe { pointer.as_ref() };
    ensure!(
        handle.env == env as usize && handle.thread == std::thread::current().id(),
        Fault::Handle
    );
    Ok(pointer)
}

unsafe extern "C" fn verify(env: Env, info: Info) -> Value {
    finish(
        env,
        std::panic::catch_unwind(|| -> Result<Value> {
            let api = api()?;
            let args = api.arguments(env, info, 1)?;
            let pointer = handle(api, env, args[0])?;
            // SAFETY: handle checked the type tag and this original environment/thread.
            let lease = unsafe { pointer.as_ref() }
                .lease
                .as_ref()
                .context(Fault::Closed)?;
            lease.verify().map_err(|_| Fault::Changed)?;
            api.boolean(env, true)
        }),
    )
}

unsafe extern "C" fn observe_entry(env: Env, info: Info) -> Value {
    finish(
        env,
        std::panic::catch_unwind(|| -> Result<Value> {
            let api = api()?;
            let args = api.arguments(env, info, 3)?;
            let mut pointer = handle(api, env, args[0])?;
            let relative = api.string(env, args[1], 32768)?;
            let kind = api.string(env, args[2], 16)?;
            // SAFETY: this synchronous callback owns the branded environment/thread.
            let lease = unsafe { pointer.as_mut() }
                .lease
                .as_mut()
                .context(Fault::Closed)?;
            api.output_string(env, &lease.observe_entry(Path::new(&relative), &kind)?)
        }),
    )
}

unsafe extern "C" fn read_source_retirement(env: Env, info: Info) -> Value {
    finish(
        env,
        std::panic::catch_unwind(|| -> Result<Value> {
            let api = api()?;
            let args = api.arguments(env, info, 2)?;
            let pointer = handle(api, env, args[0])?;
            let role = api.string(env, args[1], 128)?;
            // SAFETY: the original object is kept alive by this synchronous callback.
            let lease = unsafe { pointer.as_ref() }
                .lease
                .as_ref()
                .context(Fault::Closed)?;
            api.output_string(env, &lease.source_retirement(&role)?)
        }),
    )
}

unsafe extern "C" fn close(env: Env, info: Info) -> Value {
    finish(
        env,
        std::panic::catch_unwind(|| -> Result<Value> {
            let api = api()?;
            let args = api.arguments(env, info, 1)?;
            let mut pointer = handle(api, env, args[0])?;
            // SAFETY: callbacks are synchronous on the checked owner thread, and
            // this argument keeps the allocation alive. Taking once makes close idempotent.
            let lease = unsafe { pointer.as_mut() }.lease.take();
            let closed = lease.is_some();
            drop(lease);
            api.boolean(env, closed)
        }),
    )
}

unsafe extern "C" fn finalize(_: Env, data: *mut c_void, _: *mut c_void) {
    // SAFETY: Node returns only the exact Box transferred by wrap, once. This
    // finalizer only drops Rust-owned files and makes no Node/JS calls during teardown.
    let _ =
        std::panic::catch_unwind(|| drop(unsafe { Box::from_raw(data.cast::<WrappedLease>()) }));
}

fn api() -> Result<&'static Api> {
    API.get().context("native storage host unavailable")
}

fn finish(env: Env, result: std::thread::Result<Result<Value>>) -> Value {
    match result {
        Ok(Ok(value)) => value,
        failed => {
            if let Some(api) = API.get() {
                let code = match failed {
                    Ok(Err(ref error)) => error
                        .downcast_ref::<Fault>()
                        .map(Fault::code)
                        .unwrap_or_else(|| {
                            if error.chain().any(|cause| {
                                cause.downcast_ref::<std::io::Error>().is_some_and(|error| {
                                    error.kind() == std::io::ErrorKind::PermissionDenied
                                })
                            }) {
                                c"NATIVE_STORAGE_PERMISSION_DENIED"
                            } else {
                                c"NATIVE_STORAGE_UNAVAILABLE"
                            }
                        }),
                    _ => c"NATIVE_STORAGE_UNAVAILABLE",
                };
                // SAFETY: env is live for this callback. Internal OS diagnostics,
                // paths and file contents never become an unbounded JS exception.
                let _ = unsafe {
                    (api.throw_error)(
                        env,
                        code.as_ptr(),
                        c"Native storage lease unavailable".as_ptr(),
                    )
                };
            }
            std::ptr::null_mut()
        }
    }
}
