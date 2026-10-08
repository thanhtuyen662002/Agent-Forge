# Desktop dependency security evidence

## Reproducible baseline

Issue [#201](https://github.com/thanhtuyen662002/Agent-Forge/issues/201)
records the 2026-10-07 audit of protected main
`06bd8986f904df7da25b306a101337aed31e2b82`. Its `package-lock.json` Git blob is
`0d8d1cb1c834c6f1462095485bcaccc5ed814b81`. `npm audit --json` reported
25 vulnerable package records: 15 high and 10 moderate. Those are package
records, including propagated dependency findings, rather than 25 independent
exploits or proof of runtime reachability.

Reproduce a historical baseline in an isolated checkout of that commit, then
run `npm ci` and `npm audit --json`. Registry advisories can change after the
snapshot date; preserve the date, exact lock identity, resolved versions and
advisory IDs with any new evidence. Do not rewrite this historical snapshot to
make a later audit look green.

| Baseline package | Resolved versions | Exposure and remediation |
| --- | --- | --- |
| electron | 34.5.8 | Actual installed Windows binary despite being a development dependency; replace with maintained 44.6.0. |
| @modelcontextprotocol/client | 2.0.0 | Development stdio/in-memory integration clients; upgrade to patched 2.3.1. |
| @xmldom/xmldom | 0.8.14 | Packaging XML parser; patch to 0.8.15. |
| brace-expansion | 1.1.18, 2.1.4, 5.0.9 | Packaging glob parsers; patch each compatible major to 1.1.21, 2.1.7 and 5.0.12. |
| braces | 3.0.3 | Unpatched recursive pattern parser; remove with the Tailwind 4 transition. |
| chokidar | 3.6.0 | Propagates braces exposure; remove the old Tailwind graph. |
| fast-glob | 3.3.3 | Propagates micromatch/braces exposure; remove the old Tailwind graph. |
| micromatch | 4.0.8 | Propagates braces exposure; remove the old Tailwind graph. |
| tailwindcss | 3.4.19 | Build/watch dependency chain above; use 4.3.3 with its dedicated PostCSS plugin. |
| postcss-nested | 6.2.0 | Propagates selector-parser exposure; remove the old Tailwind graph. |
| postcss-selector-parser | 6.1.4 | Build-only selector parser; remove the old Tailwind graph. |
| extract-zip | 2.0.1 | Unsafe distribution archive extraction; remove the old Electron/get dependency graph. |
| @electron/get | 2.0.3, 3.1.0 | Distribution downloader and old proxy chain; use reviewed 5.1.0 for both Electron and builder. |
| global-agent | 3.0.0 | Old downloader proxy dependency; remove with get 5. |
| roarr | 2.15.4 | Old proxy logging dependency; remove with get 5. |
| sprintf-js | 1.1.3 | Old proxy formatting dependency; remove with get 5. |
| app-builder-lib | 26.15.3 | Propagated downloader/packaging findings; retain builder version with patched resolved graph. |
| dmg-builder | 26.15.3 | Build-only non-Windows dependency with propagated findings; patched resolved graph. |
| electron-builder-squirrel-windows | 26.15.3 | Build dependency with propagated findings; patched resolved graph; shipped installer remains NSIS. |
| electron-builder | 26.15.3 | Propagated packaging findings; retain current builder and repair its dependencies. |
| http-cache-semantics | 4.2.0 | Old download/install cache chain; removed from the resolved graph. |
| fast-uri | 3.1.5 | Build schema URI parser; patch within its major to 3.1.8. |
| js-yaml | 4.3.1 | Also a production updater dependency; patch to 4.3.2. |
| source-map-js | 1.2.1 | Development source-map processing; patch to 1.2.2. |
| undici | 6.28.0 | Development HTTP/WebSocket dependency; patch to 6.29.0; get's separate optional 7.30.0 is also outside the audited ranges. |

## Runtime and SDK boundaries

On the snapshot date, Electron supports its latest three stable major lines.
44.6.0 is a stable maintained release with Chromium 152 and Node 24, outside
the applicable ranges reported for 34.5.8. The upgrade replaces the actual
distribution binary; disabling an application API is not a substitute for a
patched binary. See [Electron support](https://www.electronjs.org/docs/latest/tutorial/electron-timelines),
[official releases](https://releases.electronjs.org/) and the
[upstream Windows/macOS PowerMonitor advisory](https://github.com/electron/electron/security/advisories/GHSA-jjp3-mq3x-295m).

The [MCP credential-forwarding advisory](https://github.com/advisories/GHSA-6qxp-vccf-f47h)
affects HTTP OAuth clients in versions below 2.2.0. Its upstream scope excludes
stdio clients and SDK servers. Repository clients currently use stdio or
in-memory transports in integration tests; `src/mcp/clientBridge.ts` generates
stdio configuration, and the packaged product runs SDK servers. Both SDK
packages are nevertheless pinned to 2.3.1, sharing core 2.3.1. This removes the
vulnerable client instead of relying on an audit exclusion. A future HTTP OAuth
integration must independently bind stored credentials to the expected issuer;
using a patched library alone does not authorize an arbitrary issuer.

SQLite 13.0.3 uses N-API and requires Node 22 or later. Electron 44 provides
Node 24; Node-based CI uses Node 22. The
[SQLite 13 upstream transition](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0)
provides platform prebuilds and removes the older prebuild-install graph.
This native/API change is verified by real rollback, cross-realm parameter,
reopen and integrity tests, plus the existing application migration and
packaged/installed startup gates. N-API portability is not inferred solely
from the version name. The old runtime proposal #191 passed ordinary tests but
its Electron 34 packaged process exited prematurely; it was not merge evidence
for the coordinated Electron/SQLite runtime.

## Build graph and extraction

Pinning `@electron/get` 5.1.0 replaces the vulnerable old proxy/download graph.
The [upstream downloader](https://github.com/electron/get) retains artifact
checksums, cache controls and mirror options and uses native fetch. The real
CommonJS import used by builder is tested against a loopback download: valid
bytes pass and altered bytes fail the checksum before extraction. Official
proxy support uses HTTP_PROXY, HTTPS_PROXY and NO_PROXY through its optional
undici dispatcher. Packaging/install/update CI must exercise actual downloads;
a lock-only audit cannot establish builder API compatibility.

Electron 44's own installer uses the upstream
[@electron-internal/extract-zip](https://github.com/electron/extract-zip)
1.0.5 package. This is Electron tooling with a deliberately restricted API for
verified distribution archives. It is not introduced as a general product
archive upload/parser. Real native fixtures cover ordinary extraction, parent
traversal, absolute-name containment, existing symlink/junction traversal and
an escaping archive symlink. Platform normalization of an absolute entry is
acceptable only while all output remains contained and an outside sentinel is
unchanged. These fixtures supplement artifact verification; they do not make
untrusted archive ingestion a supported workflow.

The [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
has no patched version in its reported range. Replace its dependency chain
with Tailwind 4.3.3 and `@tailwindcss/postcss` 4.3.3 using the
[upstream migration](https://tailwindcss.com/docs/upgrade-guide). Explicitly
load the existing JavaScript theme, retain the current small shadow/blur sizes,
and compile regressions for custom surfaces/action colors, visible keyboard
focus, the 240px Kanban column and responsive dashboard grid. No provider,
authorization or UI action semantics are changed by this CSS transition.

Remaining patched parsers are ordinary compatible updates, including
[brace-expansion recursion fixes](https://github.com/advisories/GHSA-qhr7-859c-m2p7),
[updater YAML merge limits](https://github.com/advisories/GHSA-2883-xcg3-v3hh),
[URI normalization](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj),
[source-map offsets](https://github.com/advisories/GHSA-68fv-2mgg-jv7q),
[XML parsing](https://github.com/advisories/GHSA-93r5-fhx6-vmg9) and
[WebSocket protocol handling](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5).
No force downgrade, advisory suppression or security waiver is used.

## Remediation evidence and required gates

The remediation lock Git blob is `e92788409db58be725b3c0c01afb935c35ac4c23`.
Its SHA-256 is
`d3976469af4872a6856f3f317c89fcfc5b3096908e200db99f2250440b81082b`.
The 2026-10-07 full lock audit reports zero known vulnerable package records,
including development dependencies; production-only auditing is not the gate.
Re-auditing the same lock on 2026-10-08 also reports zero findings. Focused
protected checks pass all 12 new dependency/CSS cases and all 187 existing
MCP client, server and session-authority cases; the TypeScript/renderer/Electron
build passes. A hidden Electron 44.6.0 renderer loads the built dashboard and
task board without renderer errors. Comparing their existing Tailwind 3 CSS
with the new CSS retains the 256px sidebar, main width, heading positions and
240px Kanban columns. This uses read-only browser-preview fixtures and is not
evidence of live provider execution or installed application acceptance.
This is a dated advisory snapshot, not a claim that future vulnerabilities are
impossible. Re-audit the exact lock when dependencies or advisories change.

The local Windows npm 10.9.2 installation attempted a node-gyp rebuild despite
SQLite's bundled prebuilds and failed without Visual Studio. Local focused
checks used an explicitly reported install without scripts and the genuine
bundled N-API binary; the Electron installer was then run separately. This
local limitation neither disables CI installation scripts nor substitutes for
normal Node 22 Windows/Ubuntu CI and actual Electron packaging.

Both Windows runtime probes verify the actual Electron and SQLite package
versions against the source lock, then require exactly one loaded native
binding at an exact package-rooted prebuild or release-build path. Existing
physical ASAR-unpack and installed-tree boundaries, migration count 25, stdio
authority/session revocation, update integration and RC gates remain required.
The N-API prebuild filename is accepted by exact path, not a loose filename
substring or fallback to a developer's node_modules.

Exact-head PR checks, complete diff review and high-risk post-merge main checks
are recorded on [the #201 lease](https://github.com/thanhtuyen662002/Agent-Forge/pull/205).
That GitHub record is authoritative for current completion. This document is
implementation/evidence reference, not a second mutable engineering queue.
Owner signing, production release publication and real-provider R5L acceptance
remain separate gates under [#195](https://github.com/thanhtuyen662002/Agent-Forge/issues/195).
