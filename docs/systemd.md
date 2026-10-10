# Linux systemd connections

`@openclaw/proc-safe/systemd` exposes asynchronous, native-owned sd-bus connections.
Importing the subpath never loads the native addon or libsystemd. `isSupported()`
returns false on other platforms, with native mode `off`, with an unavailable
addon, or when `libsystemd.so.0` or its required symbols are missing. Alpine without
libsystemd imports normally. Operations on unsupported platforms throw
`ProcSafeError` with `code: "unsupported-platform"`; missing bindings/libraries use
`"helper-unavailable"`.

```ts
import { SystemdBus } from '@openclaw/proc-safe/systemd';

await using bus = await SystemdBus.connectUserManager(
  `unix:path=/run/user/${process.geteuid!()}/systemd/private`,
  { timeoutMs: 1000 },
);
console.log(bus.peer); // Kernel-authenticated direct peer's PID and effective UID.
const version = await bus.getProperty({
  path: '/org/freedesktop/systemd1',
  interface: 'org.freedesktop.systemd1.Manager',
  member: 'Version',
}, 's', { timeoutMs: 500 });
```

## Factories and identity

```ts
type SystemdPeer = { readonly pid: number; readonly uid: number };
type SystemdCallOptions = { readonly timeoutMs: number; readonly replyBudgetBytes?: number };
interface AuthenticatedSystemdBus extends SystemdBus { readonly peer: SystemdPeer }

class SystemdBus implements AsyncDisposable {
  static connectUserManager(address: string, options: SystemdCallOptions): Promise<AuthenticatedSystemdBus>;
  static connectPrivatePeer(address: string, options: SystemdCallOptions): Promise<AuthenticatedSystemdBus>;
  static connectBroker(address: string, options: SystemdCallOptions): Promise<SystemdBus>;
  static connectMachineBroker(machine: string, options: SystemdCallOptions): Promise<SystemdBus>;
  getProperty(target: SystemdTarget, signature: SystemdSignature, options: SystemdCallOptions): Promise<SystemdValue>;
  call(target: SystemdTarget, args: readonly SystemdArg[], options: SystemdCallOptions): Promise<SystemdValue>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
```

`connectUserManager` means the direct private user-manager socket, matching the
consumer's existing private-peer route, not the session broker. It additionally
requires the peer's effective UID to equal the caller's. `connectPrivatePeer`
reports the direct owner's credentials without selecting an expected owner. Both
accept one direct `unix:` address and read PID/EUID without credential augmentation
before resolving. The immutable peer is an observation, not a process-lifetime pin.
Use the existing `ProcessIdentity` from `./identity` for additional PID-reuse checks.

Broker factories deliberately expose no `peer` property. A machine route can use
libsystemd's own `systemd-run`/`systemd-stdio-bridge` subprocesses to enter the
selected account or machine, just as `sd_bus_open_user_machine` normally does.
Their local socket credentials do not identify the destination broker. The
application authenticates its selected bus owner and enforces service policy.
The machine helper symbol is optional; if absent, only that factory fails.

## Targets, arguments, and replies

```ts
type SystemdTarget = {
  readonly destination?: string; // Required for brokers; omitted for direct peers.
  readonly path: string;
  readonly interface: string;
  readonly member: string;       // Property name or method name.
};
type SystemdArg =
  | { readonly type: 's' | 'o'; readonly value: string }
  | { readonly type: 'u' | 'i'; readonly value: number }
  | { readonly type: 't'; readonly value: bigint }
  | { readonly type: 'b'; readonly value: boolean };
```

`SystemdSignature` accepts `s`, `o`, `u`, `i`, `t`, `b`, `(sb)`, `(sus)`,
`(sasbttttuii)`, and arrays of each (`as`, `a(sus)`, etc.). The native layer
validates the actual reply layout. Unsupported or incomplete reply layouts throw
`"layout-mismatch"`; they never produce partial results. Arguments reject NUL
strings, out-of-range integers, and unsigned 64-bit values outside bigint's wire range.

`SystemdValue` contains the corresponding scalar, readonly tuple, or typed array.
`t` is always bigint. `(sb)` is `[string, boolean]`; `(sus)` is
`[string, number, string]`; `(sasbttttuii)` is
`[string, readonly string[], boolean, bigint, bigint, bigint, bigint, number, number, number]`.
Properties return the value directly. Methods return an empty reply tuple or a
one-element tuple containing their typed value, preserving the top-level D-Bus
argument boundary. Method signatures are read from the reply; unsupported
multi-argument reply bodies fail closed.

All outgoing messages disable service auto-start, including `Properties.Get`.
Named D-Bus failures throw `ProcSafeError` with `details.dbusErrorName`, allowing
the caller to recognize `org.freedesktop.systemd1.NoSuchUnit` without turning
unrelated failures into absence. Access refusal maps to `"access-denied"`, timeout
to `"timeout"`, and other remote errors to `"operation-failed"`.

## Time, budgets, and disposal

`timeoutMs` must be finite and positive. Its relative native monotonic deadline
starts at submission and includes time waiting behind other requests. There is
no JavaScript clock-origin dependency, including across Workers. An expired
queued operation is never dispatched. Timing out a dispatched operation cannot
undo remote effects. A late JavaScript delivery does not change a completed
native operation's result.

Before each call, the native owner drains and releases unmatched messages,
including late replies and unsolicited signals, under that call's deadline.
They cannot accumulate across calls on a long-lived connection.

The application converts its own deadline into a remaining `timeoutMs` when it
submits an operation. It keeps its admission/authority queue and runs guards
before each single submission. This library invokes no caller callback, retries,
route fallback, or service-admission policy.

`replyBudgetBytes` defaults to 1 MiB. The native decoder charges eight bytes per
value or container plus each string's UTF-8 bytes before copying it. This bounds
copied strings, scalars, and container counts, including empty strings; it is not
a bound on libsystemd's receive buffer or a D-Bus wire-size measurement. Exceeding
it throws `"incomplete"` and discards the entire result. It applies to properties
and method replies; it is unused when connecting.

Connections are frozen objects. `close()` immediately rejects new submissions,
drains already submitted native work, and then closes the bus through its native
owner. Repeated close/disposal joins the same completion. Garbage collection or
Worker teardown also releases native ownership; explicit awaited disposal gives
deterministic completion. A machine bridge's cleanup belongs to libsystemd and
may finish after the operation's timeout.

## Verification

Linux GNU CI starts a real user manager and a transient unit with
`systemd-run --user`, then tests main-thread and Worker connections. A separate
real sd-bus peer supplies exact scalar/tuple layouts, reply-budget failures,
remote errors, delays, queued expiry, and close-while-pending cases. Linux musl
CI proves import and typed unavailability without installing libsystemd.
Main-thread, Worker, and their signal-volume regression proofs run as independent
cases under the default per-test deadline. The flood count exceeds the measured
undrained queue limit by one complete message batch.
