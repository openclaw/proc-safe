use super::{ProcessIdentity, identity};
use crate::error::failure;
use napi::Result;
use std::{
    ffi::c_void,
    mem::{size_of, zeroed},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, FILETIME, GetLastError, HANDLE,
        STILL_ACTIVE,
    },
    System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    },
};

#[repr(C)]
struct BasicInformation {
    exit_status: i32,
    peb_base: *mut c_void,
    affinity_mask: usize,
    base_priority: i32,
    unique_pid: usize,
    parent_pid: usize,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryInformationProcess(
        process: HANDLE,
        class: u32,
        info: *mut c_void,
        length: u32,
        actual: *mut u32,
    ) -> i32;
}

struct OwnedHandle(HANDLE);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn error(operation: &str) -> napi::Error {
    let error = unsafe { GetLastError() };
    failure(
        if error == ERROR_ACCESS_DENIED {
            "access-denied"
        } else {
            "operation-failed"
        },
        format!("{operation} failed ({error})"),
    )
}

pub fn read(pid: u32) -> Result<Option<ProcessIdentity>> {
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if raw.is_null() {
        if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
            return Ok(None);
        }
        return Err(error("OpenProcess"));
    }
    let handle = OwnedHandle(raw);
    read_handle(pid, handle.0).map(Some)
}

pub(crate) fn read_handle(pid: u32, handle: HANDLE) -> Result<ProcessIdentity> {
    let mut created: FILETIME = unsafe { zeroed() };
    let mut exited: FILETIME = unsafe { zeroed() };
    let mut kernel: FILETIME = unsafe { zeroed() };
    let mut user: FILETIME = unsafe { zeroed() };
    if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
        return Err(error("GetProcessTimes"));
    }
    let mut basic: BasicInformation = unsafe { zeroed() };
    let mut actual = 0;
    let result = unsafe {
        NtQueryInformationProcess(
            handle,
            0,
            (&mut basic as *mut BasicInformation).cast(),
            size_of::<BasicInformation>() as u32,
            &mut actual,
        )
    };
    if result < 0 {
        return Err(failure(
            if result as u32 == 0xc0000022 {
                "access-denied"
            } else {
                "operation-failed"
            },
            format!("process parent query failed ({result:#x})"),
        ));
    }
    if actual as usize != size_of::<BasicInformation>()
        || basic.unique_pid != pid as usize
        || basic.parent_pid > u32::MAX as usize
    {
        return Err(failure(
            "layout-mismatch",
            "invalid process basic information",
        ));
    }
    let ticks = u64::from(created.dwHighDateTime) << 32 | u64::from(created.dwLowDateTime);
    // Divide in integer space before any conversion to f64; FILETIME is not exactly representable.
    let micros = (ticks / 10)
        .checked_sub(11_644_473_600_000_000)
        .ok_or_else(|| failure("layout-mismatch", "invalid process FILETIME"))?;
    let mut exit_code = 0;
    if unsafe { GetExitCodeProcess(handle, &mut exit_code) } == 0 {
        return Err(error("GetExitCodeProcess"));
    }
    let mut has_exited = exit_code != STILL_ACTIVE as u32;
    if !has_exited {
        // An application can itself return 259. The kernel exit timestamp is unambiguous.
        if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }
            == 0
        {
            return Err(error("GetProcessTimes"));
        }
        has_exited = exited.dwHighDateTime != 0 || exited.dwLowDateTime != 0;
    }
    identity(pid, basic.parent_pid as u32, micros, 1.0, None, has_exited)
}
