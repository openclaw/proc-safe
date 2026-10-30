// A separate executable leaves Node's caller-owned pipes and IPC channel untouched.
// It changes process placement only; it never interprets or relays their bytes.
#[cfg(not(windows))]
fn main() {}

#[cfg(windows)]
mod windows {
    use std::{
        ffi::{OsStr, c_void},
        io,
        mem::{size_of, zeroed},
        os::windows::ffi::OsStrExt,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{Foundation::*, System::Threading::*};

    unsafe extern "C" {
        fn _close(fd: i32) -> i32;
    }

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn valid(handle: HANDLE) -> bool {
        !handle.is_null() && handle != INVALID_HANDLE_VALUE
    }

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }

    fn quoted(value: &OsStr) -> Vec<u16> {
        let mut output = vec![b'"' as u16];
        let mut slashes = 0;
        for unit in value.encode_wide() {
            if unit == b'\\' as u16 {
                slashes += 1;
            } else {
                output.extend(std::iter::repeat_n(
                    b'\\' as u16,
                    slashes * if unit == b'"' as u16 { 2 } else { 1 },
                ));
                slashes = 0;
                if unit == b'"' as u16 {
                    output.push(b'\\' as u16);
                }
                output.push(unit);
            }
        }
        output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        output.push(b'"' as u16);
        output
    }

    pub fn run() -> io::Result<u32> {
        let mut args = std::env::args_os().skip(1);
        let mode = args
            .next()
            .ok_or_else(|| io::Error::other("missing argument mode"))?;
        if mode != "quoted" && mode != "verbatim" {
            return Err(io::Error::other("invalid argument mode"));
        }
        let argv0 = args
            .next()
            .ok_or_else(|| io::Error::other("missing argv0"))?;
        let executable = args
            .next()
            .ok_or_else(|| io::Error::other("missing executable"))?;
        let mut command = Vec::new();
        for arg in std::iter::once(argv0).chain(args) {
            if !command.is_empty() {
                command.push(b' ' as u16);
            }
            command.extend(if mode == "verbatim" {
                arg.encode_wide().collect()
            } else {
                quoted(&arg)
            });
        }
        command.push(0);
        let executable = wide(&executable);
        let mut inherited_startup: STARTUPINFOW = unsafe { zeroed() };
        unsafe {
            GetStartupInfoW(&mut inherited_startup);
        }
        let mut handles = Vec::new();
        let mut descriptors = Vec::new();
        for handle in [
            inherited_startup.hStdInput,
            inherited_startup.hStdOutput,
            inherited_startup.hStdError,
        ] {
            if valid(handle) && !handles.contains(&handle) {
                handles.push(handle);
            }
        }
        // libuv's public stdio contract is encoded in the child's CRT startup table:
        // u32 count, count flag bytes, then count unaligned HANDLE values. Preserve
        // the exact table so fd 3+ (including NODE_CHANNEL_FD) keep their identities.
        let reserved_size = usize::from(inherited_startup.cbReserved2);
        if reserved_size > 0 {
            if inherited_startup.lpReserved2.is_null() || reserved_size < size_of::<u32>() {
                return Err(io::Error::other("invalid inherited descriptor table"));
            }
            let table =
                unsafe { std::slice::from_raw_parts(inherited_startup.lpReserved2, reserved_size) };
            let count = u32::from_ne_bytes(table[..4].try_into().unwrap()) as usize;
            let expected = 4usize
                .checked_add(
                    count
                        .checked_mul(1 + size_of::<HANDLE>())
                        .ok_or_else(|| io::Error::other("descriptor table overflow"))?,
                )
                .ok_or_else(|| io::Error::other("descriptor table overflow"))?;
            if expected != table.len() {
                return Err(io::Error::other("incomplete inherited descriptor table"));
            }
            for index in 0..count {
                if table[4 + index] & 1 == 0 {
                    continue;
                }
                let offset = 4 + count + index * size_of::<HANDLE>();
                let handle = unsafe {
                    std::ptr::read_unaligned(table.as_ptr().add(offset).cast::<HANDLE>())
                };
                if valid(handle) {
                    descriptors.push((index as i32, handle));
                    if !handles.contains(&handle) {
                        handles.push(handle);
                    }
                }
            }
        }
        let mut attribute_size = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_size);
        }
        if attribute_size == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut attributes = vec![0usize; attribute_size.div_ceil(size_of::<usize>())];
        let attributes_ptr = attributes.as_mut_ptr().cast::<c_void>();
        if unsafe { InitializeProcThreadAttributeList(attributes_ptr, 1, 0, &mut attribute_size) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        struct Attributes(*mut c_void);
        impl Drop for Attributes {
            fn drop(&mut self) {
                unsafe {
                    DeleteProcThreadAttributeList(self.0);
                }
            }
        }
        let _attributes = Attributes(attributes_ptr);
        if !handles.is_empty()
            && unsafe {
                UpdateProcThreadAttribute(
                    attributes_ptr,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    handles.as_ptr().cast(),
                    std::mem::size_of_val(handles.as_slice()),
                    null_mut(),
                    null(),
                )
            } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo = inherited_startup;
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.lpAttributeList = attributes_ptr;
        let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
        if unsafe {
            CreateProcessW(
                executable.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                i32::from(!handles.is_empty()),
                CREATE_BREAKAWAY_FROM_JOB
                    | CREATE_NEW_PROCESS_GROUP
                    | CREATE_NO_WINDOW
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT,
                null(),
                null(),
                &startup.StartupInfo,
                &mut info,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let process = Handle(info.hProcess);
        let _thread = Handle(info.hThread);
        // The payload now owns its inherited copies. Keeping ours would delay
        // EOF and JSON IPC disconnect until this launcher exits. Close CRT-owned
        // descriptors through the CRT so normal process teardown cannot close
        // stale descriptor entries a second time.
        for (fd, handle) in descriptors {
            if unsafe { _close(fd) } != 0 {
                return Err(io::Error::other("closing inherited descriptor failed"));
            }
            handles.retain(|candidate| *candidate != handle);
        }
        for handle in handles {
            if unsafe { CloseHandle(handle) } == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        if unsafe { WaitForSingleObject(process.0, INFINITE) } != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        let mut code = 0;
        if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(code)
    }
}

#[cfg(windows)]
fn main() {
    match windows::run() {
        Ok(code) => std::process::exit(code as i32),
        Err(error) => {
            // Creation errors still have stderr; after successful handoff it is
            // closed deliberately, so a later observation failure may be silent.
            use std::io::Write;
            let _ = writeln!(
                std::io::stderr(),
                "Windows breakaway process failed: {error}"
            );
            std::process::exit(1);
        }
    }
}
