use super::{ProcessIdentity, identity};
use crate::error::{failure, io};
use napi::Result;
use std::mem::{size_of, zeroed};

pub fn read(pid: u32) -> Result<Option<ProcessIdentity>> {
    // libc's repr(C) structure follows the public ABI on both arm64 and x86_64.
    let mut info: libc::proc_bsdinfo = unsafe { zeroed() };
    let size = size_of::<libc::proc_bsdinfo>();
    if size != 136 {
        return Err(failure("layout-mismatch", "unexpected proc_bsdinfo size"));
    }
    let actual = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size as i32,
        )
    };
    if actual <= 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        return Err(io(error));
    }
    if actual as usize != size
        || info.pbi_pid != pid
        || info.pbi_start_tvusec >= 1_000_000
        || info.pbi_start_tvsec == 0
    {
        return Err(failure("layout-mismatch", "invalid proc_bsdinfo identity"));
    }
    let micros = info
        .pbi_start_tvsec
        .checked_mul(1_000_000)
        .and_then(|v| v.checked_add(info.pbi_start_tvusec))
        .ok_or_else(|| failure("layout-mismatch", "process start time overflow"))?;
    identity(pid, info.pbi_ppid, micros, 1.0).map(Some)
}
