use crate::error::failure;
use napi::Result;
use napi_derive::napi;

#[napi(object)]
pub struct EnvironmentEntry {
    pub key: String,
    pub value: String,
}

#[napi(object)]
pub struct ProcessCommand {
    pub executable: String,
    pub argv: Vec<String>,
    pub command_line: Option<String>,
    pub cwd: Option<String>,
    pub environment: Vec<EnvironmentEntry>,
}

#[napi]
pub fn inspect_supported() -> Result<bool> {
    #[cfg(target_os = "macos")]
    return macos::supported();
    #[cfg(windows)]
    Ok(true)
}

#[napi]
pub fn read_process_command(
    pid: u32,
    environment_keys: Vec<String>,
) -> Result<Option<ProcessCommand>> {
    if pid == 0 || (!cfg!(windows) && pid > i32::MAX as u32) {
        return Err(failure("invalid-argument", "invalid process ID"));
    }
    if environment_keys
        .iter()
        .any(|key| key.is_empty() || key.contains(['\0', '=']))
    {
        return Err(failure("invalid-argument", "invalid environment key"));
    }
    #[cfg(target_os = "macos")]
    return macos::read(pid, &environment_keys);
    #[cfg(windows)]
    return windows::read(pid, &environment_keys);
}

#[cfg(windows)]
#[napi(object)]
pub struct ProcessSnapshot {
    pub pid: u32,
    pub identity: Option<crate::identity::ProcessIdentity>,
    pub owner: String,
    pub command: Option<ProcessCommand>,
}

#[cfg(windows)]
#[napi]
pub fn list_processes(
    timeout_ms: f64,
    include_command: bool,
    pids: Option<Vec<u32>>,
) -> Result<Vec<ProcessSnapshot>> {
    if pids.as_ref().is_some_and(|pids| pids.contains(&0)) {
        return Err(failure("invalid-argument", "invalid process ID"));
    }
    windows::list(timeout_ms, include_command, pids)
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use crate::error::io;
    use std::{ffi::c_void, mem::size_of};

    pub fn supported() -> Result<bool> {
        let mut translated: i32 = 0;
        let mut size = size_of::<i32>();
        let result = unsafe {
            libc::sysctlbyname(
                c"sysctl.proc_translated".as_ptr(),
                (&mut translated as *mut i32).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ENOENT) {
                return Ok(true);
            }
            return Err(io(error));
        }
        if size != size_of::<i32>() || ![0, 1].contains(&translated) {
            return Err(failure("layout-mismatch", "invalid translation status"));
        }
        Ok(translated == 0)
    }

    fn sysctl(mib: &mut [i32], buffer: *mut c_void, size: &mut usize) -> Result<()> {
        if unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as u32,
                buffer,
                size,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return Err(io(std::io::Error::last_os_error()));
        }
        Ok(())
    }

    pub fn read(pid: u32, keys: &[String]) -> Result<Option<ProcessCommand>> {
        if !supported()? {
            return Err(failure(
                "unsupported-platform",
                "process command inspection under Rosetta is unsupported; use native arm64 Node.js or Bun",
            ));
        }
        let mut arg_max: i32 = 0;
        let mut size = size_of::<i32>();
        sysctl(
            &mut [libc::CTL_KERN, libc::KERN_ARGMAX],
            (&mut arg_max as *mut i32).cast(),
            &mut size,
        )?;
        if size != size_of::<i32>() || !(5..=16 * 1024 * 1024).contains(&arg_max) {
            return Err(failure("layout-mismatch", "invalid Darwin argument limit"));
        }
        let mut required = 0;
        if let Err(error) = sysctl(
            &mut [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as i32],
            std::ptr::null_mut(),
            &mut required,
        ) {
            if crate::identity::read_process_identity(pid)?.is_none() {
                return Ok(None);
            }
            return Err(error);
        }
        // XNU's full image includes executable/Apple strings outside ARG_MAX's argv budget.
        if required < 5 || required >= arg_max as usize {
            return Err(failure(
                "incomplete",
                "Darwin argument image exceeds bounded read",
            ));
        }
        let mut bytes = vec![0u8; arg_max as usize];
        size = bytes.len();
        if let Err(error) = sysctl(
            &mut [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as i32],
            bytes.as_mut_ptr().cast(),
            &mut size,
        ) {
            // ESRCH alone does not prove that a retained kernel object has disappeared.
            if crate::identity::read_process_identity(pid)?.is_none() {
                return Ok(None);
            }
            return Err(error);
        }
        if size < 5 || size >= bytes.len() {
            return Err(failure("incomplete", "truncated Darwin process arguments"));
        }
        bytes.truncate(size);
        parse(&bytes, keys).map(Some)
    }

    fn string(bytes: &[u8]) -> Result<String> {
        String::from_utf8(bytes.to_vec())
            .map_err(|_| failure("layout-mismatch", "process arguments are not valid UTF-8"))
    }

    fn terminated<'a>(bytes: &'a [u8], offset: &mut usize) -> Result<&'a [u8]> {
        let tail = bytes
            .get(*offset..)
            .ok_or_else(|| failure("incomplete", "truncated process arguments"))?;
        let length = tail
            .iter()
            .position(|&byte| byte == 0)
            .ok_or_else(|| failure("incomplete", "unterminated process argument"))?;
        *offset += length + 1;
        Ok(&tail[..length])
    }

    fn parse(bytes: &[u8], keys: &[String]) -> Result<ProcessCommand> {
        let argc = i32::from_ne_bytes(bytes[..4].try_into().unwrap());
        if argc < 0 || argc as usize > bytes.len() - 4 {
            return Err(failure("layout-mismatch", "invalid Darwin argument count"));
        }
        let mut offset = 4;
        let executable = string(terminated(bytes, &mut offset)?)?;
        if executable.is_empty() {
            return Err(failure("layout-mismatch", "empty Darwin executable"));
        }
        // XNU aligns the original "executable_path=" string to target pointer size,
        // then strips that prefix from this sysctl response. Do not skip
        // arbitrary NULs: an empty argv[0] must not shift environment data into argv.
        let aligned = (offset - 4 + b"executable_path=".len()).next_multiple_of(8)
            - b"executable_path=".len()
            + 4;
        if aligned > bytes.len() || bytes[offset..aligned].iter().any(|&byte| byte != 0) {
            return Err(failure(
                "layout-mismatch",
                "invalid Darwin argument alignment",
            ));
        }
        offset = aligned;
        let mut argv = Vec::new();
        for _ in 0..argc {
            argv.push(string(terminated(bytes, &mut offset)?)?);
        }
        let mut environment = Vec::new();
        if !keys.is_empty() {
            while offset < bytes.len() && bytes[offset] != 0 {
                let entry_offset = offset;
                let entry = terminated(bytes, &mut offset)?;
                // XNU's Apple vector begins with pfz at an aligned boundary. With
                // zero padding it is indistinguishable from an envp entry: refuse
                // the whole observation instead of returning startup metadata.
                if (entry_offset - 4 + b"executable_path=".len()).is_multiple_of(8)
                    && entry.starts_with(b"pfz=")
                {
                    return Err(failure(
                        "incomplete",
                        "ambiguous Darwin environment boundary",
                    ));
                }
                if let Some(separator) = entry.iter().position(|&byte| byte == b'=')
                    && let Some(key) = keys
                        .iter()
                        .find(|key| key.as_bytes() == &entry[..separator])
                {
                    environment.push(EnvironmentEntry {
                        key: key.clone(),
                        value: string(&entry[separator + 1..])?,
                    });
                }
            }
            if offset == bytes.len() {
                return Err(failure("incomplete", "unterminated Darwin environment"));
            }
        }
        Ok(ProcessCommand {
            executable,
            argv,
            command_line: None,
            cwd: None,
            environment,
        })
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        ffi::c_void,
        mem::{size_of, zeroed},
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, ERROR_ACCESS_DENIED, ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_PARAMETER,
            GetLastError, HANDLE, LocalFree,
        },
        Globalization::{CSTR_EQUAL, CompareStringOrdinal},
        Security::{EqualSid, GetTokenInformation, IsValidSid, TOKEN_QUERY, TOKEN_USER, TokenUser},
        System::{
            Diagnostics::Debug::ReadProcessMemory,
            Memory::{
                MEM_COMMIT, MEMORY_BASIC_INFORMATION, PAGE_GUARD, PAGE_NOACCESS, VirtualQueryEx,
            },
            ProcessStatus::K32EnumProcesses,
            Threading::{
                GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_INFORMATION,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ, QueryFullProcessImageNameW,
            },
        },
        UI::Shell::CommandLineToArgvW,
    };

    // A foreign process controls these layouts. Every read is bounded and checked.
    const ENV_LIMIT: usize = 1024 * 1024;
    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
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

    fn win_error(operation: &str) -> napi::Error {
        let code = unsafe { GetLastError() };
        failure(
            if code == ERROR_ACCESS_DENIED {
                "access-denied"
            } else {
                "operation-failed"
            },
            format!("{operation} failed ({code})"),
        )
    }

    fn query(handle: HANDLE, class: u32, bytes: &mut [u8]) -> Result<()> {
        let mut actual = 0;
        let status = unsafe {
            NtQueryInformationProcess(
                handle,
                class,
                bytes.as_mut_ptr().cast(),
                bytes.len() as u32,
                &mut actual,
            )
        };
        if status < 0 {
            return Err(failure(
                if status as u32 == 0xc0000022 {
                    "access-denied"
                } else {
                    "operation-failed"
                },
                format!("process query failed ({status:#x})"),
            ));
        }
        if actual as usize != bytes.len() {
            return Err(failure(
                "layout-mismatch",
                "invalid process information length",
            ));
        }
        Ok(())
    }

    fn memory(handle: HANDLE, address: usize, length: usize) -> Result<Vec<u8>> {
        if address == 0
            || length == 0
            || length > ENV_LIMIT
            || address.checked_add(length).is_none()
        {
            return Err(failure("layout-mismatch", "invalid foreign memory range"));
        }
        let mut bytes = vec![0u8; length];
        let mut actual = 0;
        if unsafe {
            ReadProcessMemory(
                handle,
                address as *const c_void,
                bytes.as_mut_ptr().cast(),
                length,
                &mut actual,
            )
        } == 0
        {
            return Err(win_error("ReadProcessMemory"));
        }
        if actual != length {
            return Err(failure("incomplete", "short foreign memory read"));
        }
        Ok(bytes)
    }

    fn pointer(bytes: &[u8], offset: usize, narrow: bool) -> usize {
        if narrow {
            u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize
        } else {
            u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap()) as usize
        }
    }

    fn wide(bytes: &[u8]) -> Result<String> {
        if !bytes.len().is_multiple_of(2) {
            return Err(failure("layout-mismatch", "odd UTF-16 byte length"));
        }
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16(&units).map_err(|_| failure("layout-mismatch", "invalid process UTF-16"))
    }

    fn location(value: usize, base: usize, normalized: bool, narrow: bool) -> Result<usize> {
        let address = if normalized {
            Some(value)
        } else {
            base.checked_add(value)
        }
        .ok_or_else(|| failure("layout-mismatch", "foreign pointer overflow"))?;
        if address == 0 || address % 2 != 0 || narrow && address > u32::MAX as usize {
            return Err(failure("layout-mismatch", "invalid foreign pointer"));
        }
        Ok(address)
    }

    fn field(
        handle: HANDLE,
        header: &[u8],
        offset: usize,
        narrow: bool,
        base: usize,
        normalized: bool,
    ) -> Result<String> {
        let length = u16::from_le_bytes(header[offset..offset + 2].try_into().unwrap()) as usize;
        let maximum =
            u16::from_le_bytes(header[offset + 2..offset + 4].try_into().unwrap()) as usize;
        if length > maximum || !length.is_multiple_of(2) || !maximum.is_multiple_of(2) {
            return Err(failure("layout-mismatch", "invalid process UNICODE_STRING"));
        }
        if length == 0 {
            return Ok(String::new());
        }
        let address = location(
            pointer(header, offset + if narrow { 4 } else { 8 }, narrow),
            base,
            normalized,
            narrow,
        )?;
        let value = wide(&memory(handle, address, length)?)?;
        if value.contains('\0') {
            return Err(failure(
                "layout-mismatch",
                "embedded process string terminator",
            ));
        }
        Ok(value)
    }

    fn environment(
        handle: HANDLE,
        address: usize,
        keys: &[String],
    ) -> Result<Vec<EnvironmentEntry>> {
        let mut bytes = Vec::new();
        let mut cursor = address;
        loop {
            let mut region: MEMORY_BASIC_INFORMATION = unsafe { zeroed() };
            if unsafe {
                VirtualQueryEx(
                    handle,
                    cursor as *const c_void,
                    &mut region,
                    size_of::<MEMORY_BASIC_INFORMATION>(),
                )
            } != size_of::<MEMORY_BASIC_INFORMATION>()
            {
                return Err(win_error("VirtualQueryEx"));
            }
            let base = region.BaseAddress as usize;
            let end = base
                .checked_add(region.RegionSize)
                .ok_or_else(|| failure("layout-mismatch", "memory region overflow"))?;
            if region.State != MEM_COMMIT
                || region.Protect & (PAGE_NOACCESS | PAGE_GUARD) != 0
                || cursor < base
                || cursor >= end
            {
                return Err(failure("incomplete", "unreadable environment region"));
            }
            let length = (end - cursor).min(4096).min(ENV_LIMIT - bytes.len());
            if length == 0 || !length.is_multiple_of(2) {
                return Err(failure("incomplete", "environment exceeds bounded read"));
            }
            let start = bytes.len().saturating_sub(2);
            bytes.extend(memory(handle, cursor, length)?);
            if let Some(offset) = (start..bytes.len().saturating_sub(3))
                .step_by(2)
                .find(|&offset| bytes[offset..offset + 4] == [0, 0, 0, 0])
            {
                bytes.truncate(offset + 2);
                break;
            }
            cursor = cursor
                .checked_add(length)
                .ok_or_else(|| failure("layout-mismatch", "environment address overflow"))?;
        }
        let mut result: Vec<EnvironmentEntry> = Vec::new();
        let names: Vec<_> = keys
            .iter()
            .map(|key| (key, key.encode_utf16().collect::<Vec<_>>()))
            .collect();
        // Compare in Windows' ordinal case-insensitive domain, then retain caller casing.
        // Decode only requested values; unrelated environment data never crosses N-API.
        for entry in bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>()
            .split(|&unit| unit == 0)
        {
            if let Some(separator) = entry.iter().position(|&unit| unit == b'=' as u16) {
                if separator == 0 {
                    continue;
                }
                for (key, name) in &names {
                    let comparison = unsafe {
                        CompareStringOrdinal(
                            name.as_ptr(),
                            name.len() as i32,
                            entry.as_ptr(),
                            separator as i32,
                            1,
                        )
                    };
                    if comparison == 0 {
                        return Err(win_error("CompareStringOrdinal"));
                    }
                    if comparison == CSTR_EQUAL
                        && !result.iter().any(|existing| existing.key == **key)
                    {
                        let value = String::from_utf16(&entry[separator + 1..]).map_err(|_| {
                            failure("layout-mismatch", "invalid environment UTF-16")
                        })?;
                        result.push(EnvironmentEntry {
                            key: (*key).clone(),
                            value,
                        });
                    }
                }
            }
        }
        Ok(result)
    }

    fn argv(line: &str) -> Result<Vec<String>> {
        let input: Vec<u16> = line.encode_utf16().chain(Some(0)).collect();
        let mut count = 0;
        let allocation = unsafe { CommandLineToArgvW(input.as_ptr(), &mut count) };
        if allocation.is_null() {
            return Err(win_error("CommandLineToArgvW"));
        }
        struct Args(*mut *mut u16);
        impl Drop for Args {
            fn drop(&mut self) {
                unsafe {
                    LocalFree(self.0.cast());
                }
            }
        }
        let owner = Args(allocation);
        if count <= 0 || count as usize > input.len() {
            return Err(failure("layout-mismatch", "invalid parsed argument count"));
        }
        let mut result = Vec::new();
        for &argument in unsafe { std::slice::from_raw_parts(owner.0, count as usize) } {
            let mut length = 0;
            while length < input.len() && unsafe { *argument.add(length) } != 0 {
                length += 1;
            }
            if length == input.len() {
                return Err(failure("layout-mismatch", "unterminated parsed argument"));
            }
            result.push(
                String::from_utf16(unsafe { std::slice::from_raw_parts(argument, length) })
                    .map_err(|_| failure("layout-mismatch", "invalid parsed argument UTF-16"))?,
            );
        }
        Ok(result)
    }

    struct Budget {
        started: std::time::Instant,
        timeout_ms: f64,
    }

    impl Budget {
        fn check(&self) -> Result<()> {
            if self.started.elapsed().as_secs_f64() * 1000.0 >= self.timeout_ms {
                return Err(failure("timeout", "process census exceeded timeoutMs"));
            }
            Ok(())
        }
    }

    fn token_owner(handle: HANDLE) -> Result<Vec<u8>> {
        let mut token = std::ptr::null_mut();
        if unsafe { OpenProcessToken(handle, TOKEN_QUERY, &mut token) } == 0 {
            return Err(win_error("OpenProcessToken"));
        }
        let token = OwnedHandle(token);
        let mut length = 0;
        if unsafe { GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut length) }
            != 0
            || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER
        {
            return Err(win_error("GetTokenInformation size"));
        }
        if (length as usize) < size_of::<TOKEN_USER>() || length > 65536 {
            return Err(failure("layout-mismatch", "invalid token information size"));
        }
        let mut bytes = vec![0u8; length as usize];
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                bytes.as_mut_ptr().cast(),
                length,
                &mut length,
            )
        } == 0
        {
            return Err(win_error("GetTokenInformation"));
        }
        if (length as usize) < size_of::<TOKEN_USER>() || length as usize > bytes.len() {
            return Err(failure("layout-mismatch", "invalid returned token size"));
        }
        let user = unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast::<TOKEN_USER>()) };
        let offset = (user.User.Sid as usize)
            .checked_sub(bytes.as_ptr() as usize)
            .ok_or_else(|| failure("layout-mismatch", "token SID outside allocation"))?;
        let header = bytes
            .get(offset..offset.saturating_add(8))
            .filter(|_| offset + 8 <= length as usize)
            .ok_or_else(|| failure("layout-mismatch", "truncated token SID"))?;
        let sid_length = 8 + usize::from(header[1]) * 4;
        if header[1] > 15 || offset.saturating_add(sid_length) > length as usize {
            return Err(failure("layout-mismatch", "invalid token SID length"));
        }
        if unsafe { IsValidSid(user.User.Sid) } == 0 {
            return Err(failure("layout-mismatch", "invalid token SID"));
        }
        Ok(bytes[offset..offset + sid_length].to_vec())
    }

    fn observed<T>(result: Result<T>) -> Result<Option<T>> {
        match result {
            Ok(value) => Ok(Some(value)),
            // Unavailable per-row observations do not erase an enumerated PID.
            Err(error)
                if error.reason.starts_with("timeout:")
                    || error.reason.starts_with("invalid-argument:") =>
            {
                Err(error)
            }
            Err(_) => Ok(None),
        }
    }

    pub fn list(
        timeout_ms: f64,
        include_command: bool,
        selected: Option<Vec<u32>>,
    ) -> Result<Vec<ProcessSnapshot>> {
        let budget = Budget {
            started: std::time::Instant::now(),
            timeout_ms,
        };
        if !timeout_ms.is_finite() || timeout_ms <= 0.0 {
            return Err(failure(
                "invalid-argument",
                "timeoutMs must be positive and finite",
            ));
        }
        budget.check()?;
        const PID_CAP: usize = 65_536;
        let mut pids = vec![0u32; PID_CAP];
        let mut actual = 0;
        let capacity_bytes = (PID_CAP * size_of::<u32>()) as u32;
        if unsafe { K32EnumProcesses(pids.as_mut_ptr(), capacity_bytes, &mut actual) } == 0 {
            return Err(failure("incomplete", "Windows process enumeration failed"));
        }
        if actual >= capacity_bytes || !(actual as usize).is_multiple_of(size_of::<u32>()) {
            return Err(failure(
                "incomplete",
                "Windows process enumeration exceeded the PID cap or was truncated",
            ));
        }
        budget.check()?;
        pids.truncate(actual as usize / size_of::<u32>());
        if pids.is_empty() || !pids.contains(&std::process::id()) {
            return Err(failure(
                "incomplete",
                "Windows process enumeration omitted the caller",
            ));
        }
        let mut seen = std::collections::HashSet::with_capacity(pids.len());
        if pids.iter().any(|pid| !seen.insert(*pid)) {
            return Err(failure(
                "incomplete",
                "Windows process enumeration repeated a PID",
            ));
        }
        if let Some(selected) = selected {
            let selected: std::collections::HashSet<_> = selected.into_iter().collect();
            pids.retain(|pid| selected.contains(pid));
        }
        let self_owner = observed(token_owner(unsafe { GetCurrentProcess() }))?;
        let mut rows = Vec::with_capacity(pids.len());
        for pid in pids {
            budget.check()?;
            let mut row = ProcessSnapshot {
                pid,
                identity: None,
                owner: "unknown".into(),
                command: None,
            };
            let mut can_read_command = include_command;
            let mut raw = if include_command {
                unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) }
            } else {
                std::ptr::null_mut()
            };
            if raw.is_null() {
                can_read_command = false;
                raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            }
            if !raw.is_null() {
                // All facts in a row share this retained object, including across PID exit/reuse.
                let handle = OwnedHandle(raw);
                if let Some(self_owner) = &self_owner
                    && let Some(owner) = observed(token_owner(handle.0))?
                {
                    row.owner = if unsafe {
                        EqualSid(
                            self_owner.as_ptr().cast_mut().cast(),
                            owner.as_ptr().cast_mut().cast(),
                        )
                    } != 0
                    {
                        "same".into()
                    } else {
                        "different".into()
                    };
                }
                budget.check()?;
                row.identity = observed(crate::identity::windows::read_handle(pid, handle.0))?;
                budget.check()?;
                if can_read_command {
                    row.command = observed(read_handle(pid, handle.0, &[]))?;
                }
            }
            budget.check()?;
            rows.push(row);
        }
        budget.check()?;
        Ok(rows)
    }

    pub fn read(pid: u32, keys: &[String]) -> Result<Option<ProcessCommand>> {
        let raw = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
        if raw.is_null() {
            if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
                return Ok(None);
            }
            return Err(win_error("OpenProcess"));
        }
        let handle = OwnedHandle(raw);
        read_handle(pid, handle.0, keys).map(Some)
    }

    fn read_handle(pid: u32, handle: HANDLE, keys: &[String]) -> Result<ProcessCommand> {
        let mut basic = [0u8; 48];
        query(handle, 0, &mut basic)?;
        if pointer(&basic, 32, false) != pid as usize {
            return Err(failure("layout-mismatch", "process PID does not match"));
        }
        let mut wow64 = [0u8; 8];
        query(handle, 26, &mut wow64)?;
        let wow64_peb = pointer(&wow64, 0, false);
        let narrow = wow64_peb != 0;
        let peb = if narrow {
            wow64_peb
        } else {
            pointer(&basic, 8, false)
        };
        let peb_bytes = memory(handle, peb, if narrow { 20 } else { 40 })?;
        let address = location(
            pointer(&peb_bytes, if narrow { 16 } else { 32 }, narrow),
            0,
            true,
            narrow,
        )?;
        let header = memory(handle, address, if narrow { 76 } else { 136 })?;
        let maximum = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
        let length = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
        if length < header.len() || length > maximum || maximum > ENV_LIMIT {
            return Err(failure(
                "layout-mismatch",
                "invalid process parameters header",
            ));
        }
        let normalized = u32::from_le_bytes(header[8..12].try_into().unwrap()) & 1 != 0;
        let command_line = field(
            handle,
            &header,
            if narrow { 64 } else { 112 },
            narrow,
            address,
            normalized,
        )?;
        if command_line.is_empty() {
            return Err(failure("incomplete", "empty process command line"));
        }
        let cwd = field(
            handle,
            &header,
            if narrow { 36 } else { 56 },
            narrow,
            address,
            normalized,
        )?;
        let mut path = vec![0u16; 32768];
        let mut path_length = path.len() as u32;
        if unsafe { QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut path_length) }
            == 0
        {
            return Err(win_error("QueryFullProcessImageNameW"));
        }
        if path_length == 0 || path_length as usize >= path.len() {
            return Err(failure("layout-mismatch", "invalid process image length"));
        }
        let executable = String::from_utf16(&path[..path_length as usize])
            .map_err(|_| failure("layout-mismatch", "invalid process image UTF-16"))?;
        let environment = if keys.is_empty() {
            Vec::new()
        } else {
            let value = pointer(&header, if narrow { 72 } else { 128 }, narrow);
            environment(handle, location(value, address, true, narrow)?, keys)?
        };
        Ok(ProcessCommand {
            executable,
            argv: argv(&command_line)?,
            command_line: Some(command_line),
            cwd: Some(cwd),
            environment,
        })
    }
}
