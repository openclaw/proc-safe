use crate::error::io;
use napi::Result;
use napi_derive::napi;

#[napi]
pub fn install_kill_group_seccomp_filter() -> Result<()> {
    #[cfg(target_arch = "x86_64")]
    const ARCH: u32 = 0xc000003e;
    #[cfg(target_arch = "aarch64")]
    const ARCH: u32 = 0xc00000b7;
    // seccomp_data: architecture at 4, syscall at 0, low 32 bits of pid at 16.
    // kill's pid is an int even when the register's high 32 bits are nonzero.
    let instructions: [(u16, u8, u8, u32); 10] = [
        (0x20, 0, 0, 4),
        (0x15, 1, 0, ARCH),
        (0x06, 0, 0, 0x80000000),
        (0x20, 0, 0, 0),
        (0x15, 0, 4, libc::SYS_kill as u32),
        (0x20, 0, 0, 16),
        (0x15, 1, 0, 0),
        (0x45, 0, 1, 0x80000000),
        (0x06, 0, 0, 0x00050000 | libc::EPERM as u32),
        (0x06, 0, 0, 0x7fff0000),
    ];
    let mut filters: Vec<libc::sock_filter> = instructions
        .into_iter()
        .map(|(code, jt, jf, k)| libc::sock_filter { code, jt, jf, k })
        .collect();
    let program = libc::sock_fprog {
        len: filters.len() as u16,
        filter: filters.as_mut_ptr(),
    };
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(io(std::io::Error::last_os_error()));
    }
    if unsafe {
        libc::prctl(
            libc::PR_SET_SECCOMP,
            libc::SECCOMP_MODE_FILTER,
            &program,
            0,
            0,
        )
    } != 0
    {
        return Err(io(std::io::Error::last_os_error()));
    }
    Ok(())
}
