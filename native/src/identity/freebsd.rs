use super::{ProcessIdentity, identity};
use crate::error::{failure, io};
use napi::Result;
use std::{
    ffi::CStr,
    mem::{size_of, zeroed},
    sync::OnceLock,
};

fn timeval_micros(value: &libc::timeval) -> Result<u64> {
    let seconds = u64::try_from(value.tv_sec)
        .map_err(|_| failure("layout-mismatch", "negative FreeBSD timeval seconds"))?;
    let micros = u64::try_from(value.tv_usec)
        .map_err(|_| failure("layout-mismatch", "negative FreeBSD timeval microseconds"))?;
    if micros >= 1_000_000 {
        return Err(failure(
            "layout-mismatch",
            "invalid FreeBSD timeval microseconds",
        ));
    }
    seconds
        .checked_mul(1_000_000)
        .and_then(|v| v.checked_add(micros))
        .ok_or_else(|| failure("layout-mismatch", "FreeBSD timeval overflow"))
}

fn read_boot_time() -> Result<libc::timeval> {
    let mut mib = [libc::CTL_KERN, libc::KERN_BOOTTIME];
    let mut boot: libc::timeval = unsafe { zeroed() };
    let mut length = size_of::<libc::timeval>();
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as u32,
            (&mut boot as *mut libc::timeval).cast(),
            &mut length,
            std::ptr::null(),
            0,
        )
    } != 0
    {
        return Err(io(std::io::Error::last_os_error()));
    }
    if length != size_of::<libc::timeval>() {
        return Err(failure(
            "layout-mismatch",
            "unexpected FreeBSD boot timeval size",
        ));
    }
    timeval_micros(&boot)?;
    Ok(boot)
}

fn read_policy_value(name: &CStr) -> Option<i32> {
    let mut value = 0i32;
    let mut length = size_of::<i32>();
    let result = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&mut value as *mut i32).cast(),
            &mut length,
            std::ptr::null(),
            0,
        )
    };
    (result == 0 && length == size_of::<i32>()).then_some(value)
}

fn visibility_permissive() -> bool {
    static POLICY: OnceLock<bool> = OnceLock::new();
    *POLICY.get_or_init(|| {
        [
            c"security.bsd.see_other_uids",
            c"security.bsd.see_other_gids",
            c"security.bsd.see_jail_proc",
        ]
        .iter()
        .all(|name| read_policy_value(name) == Some(1))
            && read_policy_value(c"security.jail.jailed") == Some(0)
    })
}

fn missing() -> Result<Option<ProcessIdentity>> {
    if visibility_permissive() {
        Ok(None)
    } else {
        Err(super::visibility::denied())
    }
}

pub fn read(pid: u32) -> Result<Option<ProcessIdentity>> {
    visibility_permissive();
    let size = size_of::<libc::kinfo_proc>();
    if size != 1088 || size_of::<libc::timeval>() != 16 || !cfg!(target_endian = "little") {
        return Err(failure(
            "layout-mismatch",
            "unsupported FreeBSD process identity layout",
        ));
    }
    let before = read_boot_time()?;
    let mut info: libc::kinfo_proc = unsafe { zeroed() };
    let mut length = size;
    // Numeric kern.proc.pid MIB matches libutil's kinfo_getproc; it is a dynamic node.
    let mut mib = [
        libc::CTL_KERN,
        libc::KERN_PROC,
        libc::KERN_PROC_PID,
        pid as i32,
    ];
    let result = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as u32,
            (&mut info as *mut libc::kinfo_proc).cast(),
            &mut length,
            std::ptr::null(),
            0,
        )
    };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return missing();
        }
        if error.raw_os_error() == Some(libc::ENOENT) {
            return missing();
        }
        return Err(io(error));
    }
    if length == 0 {
        return missing();
    }
    let after = read_boot_time()?;
    if before.tv_sec != after.tv_sec || before.tv_usec != after.tv_usec {
        return Err(failure(
            "incomplete",
            "boot time changed during FreeBSD process observation",
        ));
    }
    if length != size
        || info.ki_structsize as usize != size
        || info.ki_layout != 0
        || info.ki_pid != pid as i32
        || info.ki_ppid < 0
    {
        return Err(failure(
            "layout-mismatch",
            "invalid FreeBSD kinfo_proc identity",
        ));
    }
    let start = timeval_micros(&info.ki_start)?;
    let since_boot = start
        .checked_sub(timeval_micros(&before)?)
        .ok_or_else(|| failure("layout-mismatch", "FreeBSD process starts before boot"))?;
    identity(
        pid,
        info.ki_ppid as u32,
        start,
        1.0,
        Some(since_boot),
        info.ki_stat == libc::SZOMB,
    )
    .map(Some)
}
