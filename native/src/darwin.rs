use crate::error::{failure, io};
use napi::{Result, bindgen_prelude::BigInt};
use napi_derive::napi;
use std::{
    ffi::{CStr, c_char, c_void},
    mem::size_of,
};

#[napi(object)]
pub struct DarwinCoalition {
    pub id: BigInt,
    pub name: Option<String>,
}

#[napi]
pub fn read_process_coalition(pid: u32) -> Result<Option<DarwinCoalition>> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(failure("invalid-argument", "invalid process ID"));
    }
    let mut ids = [0u64; 5];
    let size = size_of::<[u64; 5]>();
    let actual =
        unsafe { libc::proc_pidinfo(pid as i32, 20, 0, ids.as_mut_ptr().cast(), size as i32) };
    if actual <= 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        return Err(io(error));
    }
    if actual as usize != size {
        return Err(failure(
            "layout-mismatch",
            "invalid process coalition info size",
        ));
    }
    let id = ids[0];
    if id == 0 {
        return Ok(None);
    }
    Ok(Some(DarwinCoalition {
        id: BigInt::from(id),
        name: unsafe { coalition_name(id) },
    }))
}

// Private XPC is optional. Resolve only during a coalition query and never assume its presence.
unsafe fn coalition_name(id: u64) -> Option<String> {
    unsafe {
        let library = libc::dlopen(
            c"/usr/lib/system/libxpc.dylib".as_ptr(),
            libc::RTLD_LAZY | libc::RTLD_LOCAL,
        );
        if library.is_null() {
            return None;
        }
        struct Library(*mut c_void);
        impl Drop for Library {
            fn drop(&mut self) {
                unsafe {
                    libc::dlclose(self.0);
                }
            }
        }
        let _library = Library(library);
        macro_rules! symbol {
            ($name:literal, $ty:ty) => {{
                let pointer = libc::dlsym(library, concat!($name, "\0").as_ptr().cast());
                if pointer.is_null() {
                    return None;
                }
                std::mem::transmute::<*mut c_void, $ty>(pointer)
            }};
        }
        let copy = symbol!(
            "xpc_coalition_copy_info",
            unsafe extern "C" fn(u64) -> *mut c_void
        );
        let release = symbol!("xpc_release", unsafe extern "C" fn(*mut c_void));
        let get_type = symbol!(
            "xpc_get_type",
            unsafe extern "C" fn(*mut c_void) -> *mut c_void
        );
        let get_id = symbol!(
            "xpc_dictionary_get_uint64",
            unsafe extern "C" fn(*mut c_void, *const c_char) -> u64
        );
        let get_name = symbol!(
            "xpc_dictionary_get_string",
            unsafe extern "C" fn(*mut c_void, *const c_char) -> *const c_char
        );
        let dict_type = libc::dlsym(library, c"_xpc_type_dictionary".as_ptr());
        let id_key =
            libc::dlsym(library, c"XPC_COALITION_INFO_KEY_CID".as_ptr()).cast::<*const c_char>();
        let name_key =
            libc::dlsym(library, c"XPC_COALITION_INFO_KEY_NAME".as_ptr()).cast::<*const c_char>();
        if dict_type.is_null()
            || id_key.is_null()
            || name_key.is_null()
            || (*id_key).is_null()
            || (*name_key).is_null()
        {
            return None;
        }
        let reply = copy(id);
        if reply.is_null() {
            return None;
        }
        let name = if get_type(reply) == dict_type && get_id(reply, *id_key) == id {
            let pointer = get_name(reply, *name_key);
            if pointer.is_null() {
                None
            } else {
                CStr::from_ptr(pointer).to_str().ok().map(str::to_owned)
            }
        } else {
            None
        };
        release(reply);
        name
    }
}
