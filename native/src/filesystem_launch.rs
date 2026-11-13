use std::collections::BTreeMap;
use std::ffi::{CString, OsString};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

const EXECUTE: u64 = 1;
const WRITE_FILE: u64 = 1 << 1;
const READ_FILE: u64 = 1 << 2;
const READ_DIR: u64 = 1 << 3;
const TRUNCATE: u64 = 1 << 14;
// Require ABI 3: rename/link referral and truncation must not be unmediated.
const HANDLED_FS: u64 = (1 << 15) - 1;
const READ_ONLY: u64 = EXECUTE | READ_FILE | READ_DIR;
// Writable paths allow ordinary files, directories, links, FIFOs and sockets,
// never creation of devices that could expose storage outside the hierarchy.
const READ_WRITE: u64 = HANDLED_FS & !((1 << 6) | (1 << 11));

#[repr(C)]
struct Ruleset {
    handled_access_fs: u64,
}

#[repr(C, packed)]
struct PathRule {
    allowed_access: u64,
    parent_fd: i32,
}

fn checked(result: libc::c_long, operation: &str) -> io::Result<libc::c_long> {
    if result < 0 {
        let cause = io::Error::last_os_error();
        Err(io::Error::new(
            cause.kind(),
            format!("{operation}: {cause}"),
        ))
    } else {
        Ok(result)
    }
}

fn absolute(value: OsString) -> io::Result<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "filesystem paths and executable must be absolute",
        ));
    }
    Ok(path)
}

fn add_path(ruleset: &OwnedFd, path: &Path, mut access: u64) -> io::Result<()> {
    // Resolve existing system aliases (e.g. /bin -> /usr/bin), then bind the
    // rule to the opened object. The caller must protect grant acquisition
    // from unconfined writers; this is not an admission or pathname lock.
    let canonical = path.canonicalize()?;
    let name = CString::new(canonical.as_os_str().as_bytes())?;
    let raw = checked(
        unsafe {
            libc::open(
                name.as_ptr(),
                libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        }
        .into(),
        "open filesystem grant",
    )?;
    let fd = unsafe { OwnedFd::from_raw_fd(raw as i32) };
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    checked(
        unsafe { libc::fstat(fd.as_raw_fd(), metadata.as_mut_ptr()) }.into(),
        "inspect filesystem grant",
    )?;
    let metadata = unsafe { metadata.assume_init() };
    if metadata.st_mode & libc::S_IFMT == libc::S_IFLNK {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "filesystem grant changed to a symbolic link",
        ));
    }
    if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR {
        access &= EXECUTE | READ_FILE | WRITE_FILE | TRUNCATE;
    }
    let rule = PathRule {
        allowed_access: access,
        parent_fd: fd.as_raw_fd(),
    };
    checked(
        unsafe {
            libc::syscall(
                libc::SYS_landlock_add_rule,
                ruleset.as_raw_fd(),
                1, // LANDLOCK_RULE_PATH_BENEATH
                &rule,
                0,
            )
        },
        "add filesystem grant",
    )?;
    Ok(())
}

pub fn run() -> io::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let mut grants = Vec::new();
    let mut cwd = None;
    let mut environment = Vec::new();
    let mut executable = None;
    while let Some(option) = args.next() {
        if option == "--" {
            executable = args.next().map(absolute).transpose()?;
            break;
        }
        let value = args.next().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "missing filesystem launch argument",
            )
        })?;
        match option.to_str() {
            Some("--read-only") => grants.push((absolute(value)?, READ_ONLY)),
            Some("--read-write") => grants.push((absolute(value)?, READ_WRITE)),
            Some("--cwd") if cwd.is_none() => cwd = Some(absolute(value)?),
            Some("--env") => {
                let bytes = value.into_vec();
                let separator = bytes
                    .iter()
                    .position(|byte| *byte == b'=')
                    .filter(|index| *index > 0)
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "expected environment NAME=VALUE",
                        )
                    })?;
                environment.push((
                    OsString::from_vec(bytes[..separator].to_vec()),
                    OsString::from_vec(bytes[separator + 1..].to_vec()),
                ));
            }
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid filesystem launch option",
                ));
            }
        }
    }
    let executable = executable.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected -- and an absolute executable",
        )
    })?;
    let abi = checked(
        unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                std::ptr::null::<Ruleset>(),
                0,
                1,
            )
        },
        "query Landlock ABI",
    )?;
    if abi < 3 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Landlock ABI 3 or later is required",
        ));
    }
    let attr = Ruleset {
        handled_access_fs: HANDLED_FS,
    };
    let raw = checked(
        unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                &attr,
                size_of::<Ruleset>(),
                0,
            )
        },
        "create filesystem ruleset",
    )?;
    let ruleset = unsafe { OwnedFd::from_raw_fd(raw as i32) };
    for (path, access) in grants {
        add_path(&ruleset, &path, access)?;
    }
    checked(
        unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) }.into(),
        "set no-new-privileges",
    )?;
    checked(
        unsafe { libc::syscall(libc::SYS_landlock_restrict_self, ruleset.as_raw_fd(), 0) },
        "enforce filesystem ruleset",
    )?;
    drop(ruleset);
    if let Some(cwd) = cwd {
        std::env::set_current_dir(cwd)?;
    }
    // No shell, new process, or descriptor duplication. Target-only environment
    // overrides are applied after restriction, not to the trusted launcher.
    // Exec retains the caller's explicit IPC/stdio contract and the restriction;
    // every thread and descendant the target creates starts inside this domain.
    let arguments = std::iter::once(executable.into_os_string())
        .chain(args)
        .map(|value| CString::new(value.into_vec()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut target_environment = std::env::vars_os().collect::<BTreeMap<_, _>>();
    target_environment.extend(environment);
    let target_environment = target_environment
        .into_iter()
        .map(|(mut key, value)| {
            key.push("=");
            key.push(value);
            CString::new(key.into_vec())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut argv = arguments
        .iter()
        .map(|value| value.as_ptr())
        .collect::<Vec<_>>();
    argv.push(std::ptr::null());
    let mut envp = target_environment
        .iter()
        .map(|value| value.as_ptr())
        .collect::<Vec<_>>();
    envp.push(std::ptr::null());
    // Match Command::exec's reset of the disposition changed by Rust's runtime.
    if unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) } == libc::SIG_ERR {
        return Err(io::Error::last_os_error());
    }
    // The C strings outlive these null-terminated pointer arrays. Unlike execvp,
    // execve returns ENOEXEC for an invalid executable without invoking a shell.
    unsafe { libc::execve(arguments[0].as_ptr(), argv.as_ptr(), envp.as_ptr()) };
    Err(io::Error::last_os_error())
}
