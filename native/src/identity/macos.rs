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
            return read_kernel_object(pid);
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
    identity(
        pid,
        info.pbi_ppid,
        micros,
        1.0,
        None,
        info.pbi_status == libc::SZOMB,
    )
    .map(Some)
}

#[repr(C)]
#[derive(Default)]
struct BsdIdentity {
    pid: u32,
    parent_pid: u32,
    seconds: i64,
    microseconds: i64,
    state: u32,
}

unsafe extern "C" {
    fn proc_safe_read_bsd_identity(pid: u32, out: *mut BsdIdentity) -> i32;
}

fn read_kernel_object(pid: u32) -> Result<Option<ProcessIdentity>> {
    let mut info = BsdIdentity::default();
    let result = unsafe { proc_safe_read_bsd_identity(pid, &mut info) };
    if result == 1 {
        if unsafe { libc::kill(pid as i32, 0) } == -1 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                return Ok(None);
            }
            return Err(io(error));
        }
        return Err(failure(
            "incomplete",
            "existing process has no Darwin kernel identity",
        ));
    }
    if result < 0 {
        if result == -libc::EPROTO {
            return Err(failure(
                "layout-mismatch",
                "invalid Darwin kinfo_proc layout",
            ));
        }
        return Err(io(std::io::Error::from_raw_os_error(-result)));
    }
    if info.pid != pid || info.seconds <= 0 || !(0..1_000_000).contains(&info.microseconds) {
        return Err(failure(
            "layout-mismatch",
            "invalid Darwin kernel process identity",
        ));
    }
    let micros = (info.seconds as u64)
        .checked_mul(1_000_000)
        .and_then(|v| v.checked_add(info.microseconds as u64))
        .ok_or_else(|| failure("layout-mismatch", "process start time overflow"))?;
    identity(
        pid,
        info.parent_pid,
        micros,
        1.0,
        None,
        info.state == libc::SZOMB,
    )
    .map(Some)
}
