use crate::error::{failure, io};
use napi::Result;
use napi_derive::napi;

#[napi(object)]
pub struct PageCacheResidency {
    pub page_size: u32,
    pub sampled_pages: f64,
    pub resident_pages: f64,
}

fn require_observable(fd: i32) -> Result<()> {
    // Linux may mask mincore with all ones unless file write permission or
    // ownership is established. Prove write permission on the retained fd;
    // do not infer mapped inode ownership from a potentially overflowed st_uid.
    let permitted = unsafe {
        libc::syscall(
            libc::SYS_faccessat2,
            fd,
            c"".as_ptr(),
            libc::W_OK,
            libc::AT_EMPTY_PATH | libc::AT_EACCESS,
        )
    };
    if permitted != 0 {
        let error = std::io::Error::last_os_error();
        return Err(failure(
            "access-denied",
            format!("cannot establish unmasked residency: {error}"),
        ));
    }
    Ok(())
}

#[napi]
pub fn sample_page_cache_residency(fd: i32, max_pages: f64) -> Result<PageCacheResidency> {
    if fd < 0
        || !max_pages.is_finite()
        || max_pages.fract() != 0.0
        || !(1.0..=9_007_199_254_740_991.0).contains(&max_pages)
    {
        return Err(failure("invalid-argument", "invalid fd or maxPages"));
    }
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page_size <= 0 || page_size > u32::MAX as libc::c_long {
        return Err(failure("layout-mismatch", "invalid system page size"));
    }
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
        return Err(io(std::io::Error::last_os_error()));
    }
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG || stat.st_size < 0 {
        return Err(failure(
            "invalid-argument",
            "page-cache sampling requires a regular file",
        ));
    }
    let pages = (stat.st_size as u64).div_ceil(page_size as u64);
    let sampled = pages.min(max_pages as u64);
    let mut resident = 0_u64;
    for index in 0..sampled {
        require_observable(fd)?;
        let page =
            (u128::from(index) * u128::from(pages - 1) / u128::from((sampled - 1).max(1))) as u64;
        let offset = page * page_size as u64;
        let mapping = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                page_size as usize,
                libc::PROT_NONE,
                libc::MAP_PRIVATE,
                fd,
                offset as libc::off_t,
            )
        };
        if mapping == libc::MAP_FAILED {
            return Err(io(std::io::Error::last_os_error()));
        }
        let mut vector = 0_u8;
        let observed = unsafe { libc::mincore(mapping, page_size as usize, &mut vector) };
        let observation_error = (observed != 0).then(std::io::Error::last_os_error);
        let unmapped = unsafe { libc::munmap(mapping, page_size as usize) };
        if let Some(error) = observation_error {
            return Err(io(error));
        }
        if unmapped != 0 {
            return Err(io(std::io::Error::last_os_error()));
        }
        require_observable(fd)?;
        resident += u64::from(vector & 1);
    }
    Ok(PageCacheResidency {
        page_size: page_size as u32,
        sampled_pages: sampled as f64,
        resident_pages: resident as f64,
    })
}
