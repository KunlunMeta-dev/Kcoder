//! The stable Node-API v1 ABI is resolved from the actual loaded host image.
use anyhow::{Result, ensure};
use std::ffi::{c_char, c_void};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

pub(super) type Env = *mut c_void;
pub(super) type Value = *mut c_void;
pub(super) type Info = *mut c_void;
pub(super) type Reference = *mut c_void;
pub(super) type Callback = unsafe extern "C" fn(Env, Info) -> Value;
pub(super) type Finalizer = unsafe extern "C" fn(Env, *mut c_void, *mut c_void);
type Status = i32;

pub(super) struct Api {
    pub(super) get_cb_info: unsafe extern "C" fn(
        Env,
        Info,
        *mut usize,
        *mut Value,
        *mut Value,
        *mut *mut c_void,
    ) -> Status,
    pub(super) get_value_string_utf16:
        unsafe extern "C" fn(Env, Value, *mut u16, usize, *mut usize) -> Status,
    pub(super) create_function: unsafe extern "C" fn(
        Env,
        *const c_char,
        usize,
        Option<Callback>,
        *mut c_void,
        *mut Value,
    ) -> Status,
    pub(super) set_named_property: unsafe extern "C" fn(Env, Value, *const c_char, Value) -> Status,
    pub(super) create_object: unsafe extern "C" fn(Env, *mut Value) -> Status,
    pub(super) wrap: unsafe extern "C" fn(
        Env,
        Value,
        *mut c_void,
        Option<Finalizer>,
        *mut c_void,
        *mut Reference,
    ) -> Status,
    pub(super) unwrap: unsafe extern "C" fn(Env, Value, *mut *mut c_void) -> Status,
    pub(super) remove_wrap: unsafe extern "C" fn(Env, Value, *mut *mut c_void) -> Status,
    pub(super) get_reference_value: unsafe extern "C" fn(Env, Reference, *mut Value) -> Status,
    pub(super) delete_reference: unsafe extern "C" fn(Env, Reference) -> Status,
    pub(super) strict_equals: unsafe extern "C" fn(Env, Value, Value, *mut bool) -> Status,
    pub(super) get_boolean: unsafe extern "C" fn(Env, bool, *mut Value) -> Status,
    pub(super) create_uint32: unsafe extern "C" fn(Env, u32, *mut Value) -> Status,
    pub(super) throw_error: unsafe extern "C" fn(Env, *const c_char, *const c_char) -> Status,
}

impl Api {
    pub(super) fn load() -> Result<Self> {
        // SAFETY: the null module name asks Windows for this process's actual
        // executable module; no caller path or ordinary DLL search is used.
        let module = unsafe { GetModuleHandleW(std::ptr::null()) };
        ensure!(!module.is_null(), "NATIVE_ADDON_HOST_UNAVAILABLE");
        unsafe fn symbol<T: Copy>(module: *mut c_void, name: &'static std::ffi::CStr) -> Result<T> {
            // SAFETY: these are stable Node-API v1 function names/signatures
            // declared by node_api.h/js_native_api.h. The pointer stays valid
            // for the process lifetime because it belongs to the host image.
            let pointer = unsafe { GetProcAddress(module, name.as_ptr().cast()) };
            ensure!(
                pointer.is_some() && size_of::<T>() == size_of_val(&pointer),
                "NATIVE_ADDON_HOST_UNAVAILABLE"
            );
            Ok(unsafe { std::mem::transmute_copy(&pointer) })
        }
        // SAFETY: every field has the exact stable C ABI for the named symbol.
        Ok(unsafe {
            Self {
                get_cb_info: symbol(module, c"napi_get_cb_info")?,
                get_value_string_utf16: symbol(module, c"napi_get_value_string_utf16")?,
                create_function: symbol(module, c"napi_create_function")?,
                set_named_property: symbol(module, c"napi_set_named_property")?,
                create_object: symbol(module, c"napi_create_object")?,
                wrap: symbol(module, c"napi_wrap")?,
                unwrap: symbol(module, c"napi_unwrap")?,
                remove_wrap: symbol(module, c"napi_remove_wrap")?,
                get_reference_value: symbol(module, c"napi_get_reference_value")?,
                delete_reference: symbol(module, c"napi_delete_reference")?,
                strict_equals: symbol(module, c"napi_strict_equals")?,
                get_boolean: symbol(module, c"napi_get_boolean")?,
                create_uint32: symbol(module, c"napi_create_uint32")?,
                throw_error: symbol(module, c"napi_throw_error")?,
            }
        })
    }
    pub(super) fn check(&self, status: Status) -> Result<()> {
        ensure!(status == 0, "NATIVE_ADDON_ARGUMENT_INVALID");
        Ok(())
    }
    pub(super) fn arguments(&self, env: Env, info: Info, expected: usize) -> Result<Vec<Value>> {
        let mut values = [std::ptr::null_mut(); 8];
        let mut count = values.len();
        // SAFETY: Node owns env/info, and both outputs have the declared size.
        self.check(unsafe {
            (self.get_cb_info)(
                env,
                info,
                &mut count,
                values.as_mut_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        })?;
        ensure!(
            count == expected && expected <= values.len(),
            "NATIVE_ADDON_ARGUMENT_INVALID"
        );
        Ok(values[..expected].to_vec())
    }
    pub(super) fn string(&self, env: Env, value: Value) -> Result<String> {
        let mut length = 0;
        // SAFETY: Node validates the argument is a string before reporting length.
        self.check(unsafe {
            (self.get_value_string_utf16)(env, value, std::ptr::null_mut(), 0, &mut length)
        })?;
        ensure!(
            (1..=32768).contains(&length),
            "NATIVE_ADDON_ARGUMENT_INVALID"
        );
        let mut buffer = vec![0u16; length + 1];
        let mut copied = 0;
        // SAFETY: the owned buffer includes the terminating null slot.
        self.check(unsafe {
            (self.get_value_string_utf16)(
                env,
                value,
                buffer.as_mut_ptr(),
                buffer.len(),
                &mut copied,
            )
        })?;
        ensure!(
            copied == length && !buffer[..length].contains(&0),
            "NATIVE_ADDON_ARGUMENT_INVALID"
        );
        Ok(String::from_utf16(&buffer[..length])?)
    }
    pub(super) fn boolean(&self, env: Env, value: bool) -> Result<Value> {
        let mut result = std::ptr::null_mut();
        // SAFETY: the output pointer is valid and owned by this callback.
        self.check(unsafe { (self.get_boolean)(env, value, &mut result) })?;
        Ok(result)
    }
}
