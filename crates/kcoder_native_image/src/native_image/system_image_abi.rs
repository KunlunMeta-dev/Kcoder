//! A dedicated system OpenSSH image capture; ordinary image hard-link rules stay strict.
use super::{
    API, Lease, NEXT_ID,
    abi::{Env, Info, Reference, Value},
    image::ImageLease,
};
use anyhow::{Context, Result, ensure};
use std::{
    ffi::c_void,
    sync::{Arc, atomic::Ordering},
};

pub(super) unsafe extern "C" fn capture(env: Env, info: Info) -> Value {
    super::finish(
        env,
        std::panic::catch_unwind(|| -> Result<Value> {
            let api = API.get().context("NATIVE_ADDON_HOST_UNAVAILABLE")?;
            let args = api.arguments(env, info, 2)?;
            let mut data = std::ptr::null_mut();
            api.check(unsafe { (api.unwrap)(env, args[0], &mut data) })?;
            let loaded = {
                let images = super::registry()
                    .lock()
                    .map_err(|_| anyhow::anyhow!("NATIVE_IMAGE_STATE_UNAVAILABLE"))?;
                let parent = images
                    .get(&(data as usize))
                    .context("NATIVE_IMAGE_STATE_UNAVAILABLE")?;
                ensure!(
                    super::original(api, env, args[0], parent)?,
                    "NATIVE_IMAGE_IDENTITY_CHANGED"
                );
                parent._loaded_addon.clone()
            };
            let target = ImageLease::capture_system_ssh(&api.string(env, args[1])?)?;
            let id = NEXT_ID
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                    value.checked_add(1)
                })
                .map_err(|_| anyhow::anyhow!("NATIVE_IMAGE_CAPACITY"))?;
            let mut images = super::registry()
                .lock()
                .map_err(|_| anyhow::anyhow!("NATIVE_IMAGE_STATE_UNAVAILABLE"))?;
            ensure!(images.len() < 256, "NATIVE_IMAGE_CAPACITY");
            let mut object = std::ptr::null_mut();
            api.check(unsafe { (api.create_object)(env, &mut object) })?;
            let mut reference: Reference = std::ptr::null_mut();
            api.check(unsafe {
                (api.wrap)(
                    env,
                    object,
                    id as *mut c_void,
                    Some(super::finalize),
                    std::ptr::null_mut(),
                    &mut reference,
                )
            })?;
            images.insert(
                id,
                Lease {
                    env: env as usize,
                    owner: std::thread::current().id(),
                    reference: reference as usize,
                    _loaded_addon: loaded,
                    target: Arc::new(target),
                },
            );
            Ok(object)
        }),
    )
}
