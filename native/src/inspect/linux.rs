use super::{EnvironmentEntry, ProcessCommand};
use crate::error::{failure, io};
use napi::Result;
use std::{
    ffi::CStr,
    fs::File,
    io::Read,
    os::fd::{AsRawFd, FromRawFd},
};

// Procfs reports zero st_size for these files. Bound bytes read, including one
// extra byte to distinguish an exact-size image from truncation.
const IMAGE_LIMIT: usize = 8 * 1024 * 1024;
const LINK_LIMIT: usize = 64 * 1024;

fn open_at(directory: &File, name: &CStr) -> std::io::Result<File> {
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: openat returned a new owned descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn bounded_read(reader: impl Read, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() > limit {
        return Err(failure("incomplete", "procfs image exceeds bounded read"));
    }
    Ok(bytes)
}

fn read_at(directory: &File, name: &CStr) -> Result<Vec<u8>> {
    bounded_read(open_at(directory, name).map_err(io)?, IMAGE_LIMIT)
}

fn executable(directory: &File) -> Result<String> {
    let mut bytes = vec![0; LINK_LIMIT];
    let length = unsafe {
        libc::readlinkat(
            directory.as_raw_fd(),
            c"exe".as_ptr(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
        )
    };
    if length < 0 {
        return Err(io(std::io::Error::last_os_error()));
    }
    if length as usize == bytes.len() {
        return Err(failure(
            "incomplete",
            "procfs executable exceeds bounded read",
        ));
    }
    bytes.truncate(length as usize);
    if bytes.is_empty() {
        return Err(failure("incomplete", "empty procfs executable"));
    }
    String::from_utf8(bytes).map_err(|_| failure("layout-mismatch", "invalid executable UTF-8"))
}

fn arguments(bytes: &[u8]) -> Result<Vec<String>> {
    if bytes.is_empty() {
        return Err(failure(
            "incomplete",
            "process has no readable argument image",
        ));
    }
    let body = bytes
        .strip_suffix(&[0])
        .ok_or_else(|| failure("layout-mismatch", "unterminated procfs argument image"))?;
    body.split(|byte| *byte == 0)
        .map(|arg| {
            std::str::from_utf8(arg)
                .map(str::to_owned)
                .map_err(|_| failure("layout-mismatch", "invalid argument UTF-8"))
        })
        .collect()
}

fn environment(bytes: &[u8], keys: &[String]) -> Result<Vec<EnvironmentEntry>> {
    let mut selected = Vec::new();
    for entry in bytes.split(|byte| *byte == 0) {
        let Some(equals) = entry.iter().position(|byte| *byte == b'=') else {
            continue;
        };
        // Neither decode nor expose unrelated entries, including invalid UTF-8.
        if let Some(key) = keys.iter().find(|key| key.as_bytes() == &entry[..equals]) {
            let value = std::str::from_utf8(&entry[equals + 1..])
                .map_err(|_| failure("layout-mismatch", "invalid selected environment UTF-8"))?;
            selected.push(EnvironmentEntry {
                key: key.clone(),
                value: value.to_owned(),
            });
        }
    }
    Ok(selected)
}

fn start_ticks(bytes: &[u8], pid: u32) -> Result<u64> {
    let prefix = format!("{pid} (");
    let end = bytes
        .iter()
        .rposition(|byte| *byte == b')')
        .ok_or_else(|| failure("layout-mismatch", "invalid procfs comm field"))?;
    if !bytes.starts_with(prefix.as_bytes()) || end < prefix.len() - 1 {
        return Err(failure("layout-mismatch", "procfs PID does not match"));
    }
    let numeric = std::str::from_utf8(&bytes[end + 1..])
        .map_err(|_| failure("layout-mismatch", "invalid procfs stat fields"))?;
    let fields: Vec<_> = numeric.split_whitespace().collect();
    let state = fields
        .first()
        .filter(|state| state.len() == 1)
        .ok_or_else(|| failure("layout-mismatch", "invalid procfs process state"))?;
    if matches!(*state, "Z" | "X" | "x") {
        return Err(failure(
            "incomplete",
            "exited process has no readable command image",
        ));
    }
    fields
        .get(19)
        .and_then(|ticks| ticks.parse().ok())
        .ok_or_else(|| failure("layout-mismatch", "invalid procfs start ticks"))
}

fn observe(directory: &File, pid: u32, keys: &[String]) -> Result<ProcessCommand> {
    let before = start_ticks(&read_at(directory, c"stat")?, pid)?;
    let executable = executable(directory)?;
    let argv = arguments(&read_at(directory, c"cmdline")?)?;
    let environment = if keys.is_empty() {
        Vec::new()
    } else {
        environment(&read_at(directory, c"environ")?, keys)?
    };
    let after = start_ticks(&read_at(directory, c"stat")?, pid)?;
    if before != after {
        return Err(failure(
            "incomplete",
            "process instance changed during inspection",
        ));
    }
    Ok(ProcessCommand {
        executable,
        argv,
        command_line: None,
        cwd: None,
        environment,
    })
}

pub fn read(pid: u32, keys: &[String]) -> Result<Option<ProcessCommand>> {
    // An open proc PID directory never retargets a reused PID. All process facts
    // below are read relative to this one descriptor, not reconstructed paths.
    let path = std::ffi::CString::new(format!("/proc/{pid}")).expect("numeric PID");
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH)) {
            // Keep identity's restricted-procfs and signal-namespace checks.
            return match crate::identity::read_process_identity(pid)? {
                None => Ok(None),
                Some(_) => Err(failure(
                    "incomplete",
                    "live process has no readable procfs directory",
                )),
            };
        }
        return Err(io(error));
    }
    // SAFETY: open returned a new owned descriptor, closed on every exit path.
    let directory = unsafe { File::from_raw_fd(fd) };
    let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(directory.as_raw_fd(), filesystem.as_mut_ptr()) } != 0 {
        return Err(io(std::io::Error::last_os_error()));
    }
    if unsafe { filesystem.assume_init() }.f_type != libc::PROC_SUPER_MAGIC {
        return Err(failure("incomplete", "process directory is not procfs"));
    }
    match observe(&directory, pid, keys) {
        Ok(command) => Ok(Some(command)),
        Err(error) => {
            // Absence is only established by the existing identity contract.
            // A retained zombie, hidden process or reused PID is not absence.
            if crate::identity::read_process_identity(pid)?.is_none() {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn argument_boundaries_and_invalid_images() {
        assert_eq!(
            arguments(b"\0two words\0\0\xc3\xa9\0\0").unwrap(),
            ["", "two words", "", "é", ""]
        );
        assert!(
            arguments(b"")
                .unwrap_err()
                .reason
                .starts_with("incomplete:")
        );
        assert!(arguments(b"unterminated").is_err());
        assert!(arguments(b"\xff\0").is_err());
    }

    #[test]
    fn only_selected_environment_is_decoded() {
        let keys = vec!["KEY".into(), "EMPTY".into()];
        let entries = environment(b"\xff=\xff\0KEY=value=tail\0EMPTY=", &keys).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].value, "value=tail");
        assert_eq!(entries[1].value, "");
        assert!(environment(b"KEY=\xff\0", &keys).is_err());
        assert!(environment(b"key=lower\0", &keys).unwrap().is_empty());
    }

    #[test]
    fn bounded_reads_distinguish_exact_limit_and_overflow() {
        assert_eq!(bounded_read(Cursor::new(b"1234"), 4).unwrap(), b"1234");
        assert!(
            bounded_read(Cursor::new(b"12345"), 4)
                .unwrap_err()
                .reason
                .starts_with("incomplete:")
        );
        struct ShortReads(Cursor<&'static [u8]>);
        impl Read for ShortReads {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let length = buffer.len().min(1);
                self.0.read(&mut buffer[..length])
            }
        }
        assert_eq!(
            bounded_read(ShortReads(Cursor::new(b"1234")), 4).unwrap(),
            b"1234"
        );
        assert!(bounded_read(ShortReads(Cursor::new(b"12345")), 4).is_err());
    }

    #[test]
    fn retained_directory_does_not_follow_replacement() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("proc-safe-inspect-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let current = root.join("current");
        std::fs::create_dir(&current).unwrap();
        let stat = format!(
            "17 (name with ) parentheses) S {} 42",
            vec!["0"; 18].join(" ")
        );
        std::fs::write(current.join("stat"), stat).unwrap();
        std::fs::write(current.join("cmdline"), b"original\0").unwrap();
        symlink("/original (deleted)", current.join("exe")).unwrap();
        let directory = File::open(&current).unwrap();
        std::fs::rename(&current, root.join("retained")).unwrap();
        std::fs::create_dir(&current).unwrap();
        std::fs::write(current.join("cmdline"), b"replacement\0").unwrap();
        let command = observe(&directory, 17, &[]).unwrap();
        assert_eq!(command.argv, ["original"]);
        assert_eq!(command.executable, "/original (deleted)");
        // No environ file exists: an empty selection must not open it.
        assert!(command.environment.is_empty());
    }
}
