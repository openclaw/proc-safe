# Linux page-cache diagnostics

```ts
import { samplePageCacheResidency } from '@openclaw/proc-safe/diagnostics';

const sample = samplePageCacheResidency(fd, { maxPages: 256 });
// { pageSize, sampledPages, residentPages }
```

The caller owns the readable regular-file descriptor and must keep it open for the
synchronous call. `maxPages` is a positive safe integer. Sampling selects at most
that many pages, evenly spread from the first to the last page; a one-page sample
selects the first page. Empty files return zero sampled and resident pages with the
system page size. The frozen result counts operating-system pages, not SQLite pages.
For nonempty files the sampler requires effective write permission on the retained
descriptor's file, checked without writing it. Linux can otherwise silently substitute
all-resident bits. If permission cannot be established, including on kernels without
`faccessat2`, the sampler throws `access-denied` instead of returning masked data.
This conservative check also rejects an owned read-only file even though some kernels
permit its owner to observe residency. Ownership alone is not inferred from translated
UIDs because an unmapped owner can appear as the overflow UID.

Each observation uses a one-page `PROT_NONE`, `MAP_PRIVATE` mapping and `mincore`,
then unmaps through the native owner. Sampling does not read or fault file contents
into memory. Concurrent file changes and cache eviction make residency advisory;
it does not identify an application's logical hot set or establish file identity.
Only `residentPages <= sampledPages` is guaranteed, not a precise warm/cold ratio.
The descriptor's current read position is unchanged.

Linux GNU and musl on x64 and arm64 are supported. `isSupported()` probes platform
and binding availability without throwing. Imports are lazy everywhere. Calls on
other platforms throw `ProcSafeError` with `unsupported-platform`; a disabled or
missing binding throws `helper-unavailable`. Invalid arguments or nonregular files
throw `invalid-argument`; operating-system failures throw a typed error.
