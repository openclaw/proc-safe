# Native test fixtures

`@openclaw/proc-safe/test-support` contains test-only mechanisms. Do not use it as a
production process supervisor. Importing is lazy on all platforms. `isSupported()`
reports whether all fixtures for the current platform have a loadable binding;
individual operations still enforce their platform and throw `ProcSafeError`.

```ts
function installKillGroupSeccompFilter(): void;
function spawnDetachedRaw(options: {
  executable: string;
  args?: readonly string[];
  cwd?: string;
}): { readonly pid: number };
function hasConsoleWindow(): boolean;
function isSupported(): boolean;
```

On Linux, `installKillGroupSeccompFilter()` irreversibly sets `no_new_privs` and
installs a seccomp filter on the calling thread. Run it only in a disposable fixture
process. It rejects `kill` with PID zero or any negative PID with `EPERM`, while
allowing positive-PID `kill` and unrelated syscalls. A mismatched syscall architecture
terminates the process. Existing sibling threads are unaffected; newly created
threads/children inherit the filter. This is a focused group-kill denial fixture,
not a complete sandbox. Installation can fail after `no_new_privs` has been set.

On Windows, `spawnDetachedRaw` directly invokes `CreateProcessW` with
`CREATE_NO_WINDOW`, no inherited handles, the inherited environment, and optional
working directory. Arguments follow Windows CRT quoting, including empty arguments,
quotes, and trailing backslashes. The child is outside libuv's child registry;
it still inherits any applicable Windows Job membership. This fixture deliberately
matches the consumer's raw launch and does not set `DETACHED_PROCESS` or create a Job.
The native owner closes both returned handles before returning a frozen PID result.
The caller is responsible for the child's test lifetime. A close failure throws
after creation, so the child may already be running when a call fails.

`hasConsoleWindow()` reports whether the calling process has a console window via
`GetConsoleWindow`. The Windows fixtures support x64 and arm64. Paths and arguments
must not contain NULs. Unsupported operations throw `unsupported-platform`; missing
or disabled bindings throw `helper-unavailable`; native denial and other failures
remain typed errors.
