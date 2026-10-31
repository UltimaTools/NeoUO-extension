# AGENTS.md — NeoUO VS Code extension

Instructions for AI agents and contributors working in this repository.

## What this project is

A VS Code extension for the [NeoUO](https://github.com/UltimaTools/NeoUO) Ultima Online
client. It talks to the client's **ProtoControl** WebSocket server over loopback and
provides:

- **Play / Stop Play** — send the active `.py`, `.cs`, or `.uos` file to the client
- **Record / Stop Record** — capture gameplay into the active editor
- **Python debugging** — a DAP adapter for NeoUO's IronPython debug engine
- **UOS language support** — generated grammar, snippets, formatter, and theme

Extension ID: `neouo.neouo` (Marketplace and Open VSX). Publisher/namespace:
`neouo`.

## Repository map

| Path | Purpose |
| --- | --- |
| `extension.js` | Activation, Play/Record session manager, UOS formatter |
| `debug.js` | Debug Adapter Protocol implementation over ProtoControl |
| `debugAdapterStub.js` | Manifest fallback; the inline adapter is normally used |
| `ProtoControl.proto` | Wire protocol (copied from the NeoUO client) |
| `snippets/uos.json` | **Generated** UOS snippets |
| `syntaxes/uos.tmLanguage.json` | **Generated** TextMate grammar |
| `language-configuration.json` | **Generated** UOS language configuration |
| `themes/uos-theme.json` | Dark theme (hand-maintained) |
| `tools/generate-uos-assets.js` | UOS asset generator |
| `tools/uos-commands.json` | Committed command catalog used by the generator |
| `tools/uos-templates.json` | Hand-written control-flow snippets and overrides |
| `dap_test.js` | Live DAP test (entry stop + `stopOnEntry:false` scenarios) |
| `proto_control_node_test.js` | Live protocol test (`play`, `play-stop`, `record`, `debug`) |
| `vscode_mock.js` | `vscode` module mock for `dap_test.js` |
| `.github/workflows/checkin.yml` | CI + release publishing |
| `.github/workflows/publish-openvsx.yml` | Manual Open VSX publish |

Sibling project: the client lives at `../NeoUO` (`UltimaTools/NeoUO`). The website is
`../NeoUO/web`. Both are separate repositories.

## Prerequisites

- Node.js **22** (CI uses 22; `@vscode/vsce` and `ovsx` require >= 22)
- VS Code 1.60+
- A running NeoUO client with **Remote Control** enabled (Technical settings tab)
- A **logged-in character** — Play, Record, and Debug are silently ignored at the
  login screen
- ProtoControl port: NeoUO picks the first free port in **15454–15464** and shows it
  on the Remote Control checkbox label

## Build and package

```bash
npm install                 # or npm ci
npm run lint                # eslint .
make check-assets           # validates all generated JSON
npx vsce package            # or: make package (npm ci + lint + check + package)
```

`make package` produces `neouo-<version>.vsix`. Install locally with
`code --install-extension neouo-<version>.vsix`.

For live extension work, open the folder and press **F5** (`.vscode/launch.json`
starts an Extension Development Host).

## Tests

Live tests need the NeoUO client running with a logged-in character. Pass the
ProtoControl port (default `15454`):

```bash
node dap_test.js 15454
node proto_control_node_test.js 15454 play
node proto_control_node_test.js 15454 play-stop
node proto_control_node_test.js 15454 record
node proto_control_node_test.js 15454 debug
```

`dap_test.js` runs the real `debug.js` adapter against the live client using
`vscode_mock.js`. It covers entry stop, breakpoints, stack/scopes/variables,
evaluate, stepping, disconnect, and the `stopOnEntry:false` path. There is no
automated Extension Host test yet.

If `code --install-extension` times out on a slow network, VS Code's bundled Node
uses a 250 ms per-address connect timeout. Workaround:

```powershell
$env:NODE_OPTIONS='--network-family-autoselection-attempt-timeout=10000'
```

## Generated UOS assets

Do **not** hand-edit `snippets/uos.json`, `syntaxes/uos.tmLanguage.json`, or
`language-configuration.json`. They are generated from the NeoUO UOS engine:

```bash
npm run gen:uos -- --source ../NeoUO/NeoUO/Scripting/UOSteamEngine.cs
# or, when the catalog already exists:
make gen-uos
```

The generator parses `RegisterCommandHandler`/`RegisterExpressionHandler` and their
XML `<summary>` usage docs, then writes the catalog + assets. Control-flow snippets
and curated overrides live in `tools/uos-templates.json`. `tools/uos-commands.json`
is committed so regeneration works without the client checkout.

After changing UOS assets: `make check-assets`, `npm run lint`, package, and spot
check the grammar/snippets. UOS support is derived from the NeoUO engine — if the
engine adds/removes a command, regenerate.

## Protocol notes (`ProtoControl.proto`)

- **Source of truth**: `NeoUO/Scripting/Proto-Control/ProtoControl.proto`. Update the
  copy here when the client protocol changes.
- protobufjs parses fields as **camelCase** (`keepCase` is off). Use
  `frameId`, `variablesReference`, `stepType` in payloads — snake_case keys are
  silently ignored.
- The server requires a logged-in character (`World.Player != null`); otherwise
  requests are ignored.
- **`StopPlayResponse` is never sent by the server.** After `StopPlay`, the play
  callback ends with the final `PlayResponse { more: false }`. Do not wait for a
  stop response.
- Server session state is **per WebSocket connection** (`ProtoMessageParser`). This
  is why the extension keeps one socket per session (see below).

## Play / Record implementation notes

- Each Play or Record session owns **one WebSocket** for its lifetime. Stop requests
  travel over the **same socket**. Opening a second socket for Stop leaks the
  original connection and, for Record, leaves the server's per-connection
  `_activeSessions` loop waiting forever.
- Session IDs are deterministic 31-bit hashes of the document path, so a Stop from
  a reloaded window can still address the session. ID 0 is invalid.
- Set the context keys (`neoUO.isPlaying`, `neoUO.isRecording`) only after the
  socket connects; reset them and show an error on every failure path.
- Connect with a timeout (5 s). Validate the language before connecting:
  Play accepts Python/C#/UOS; Record accepts Python/UOS.
- Split script text with `/\r?\n/` (CRLF-safe).
- Recorded code is appended via `WorkspaceEdit` keyed by the document URI, not a
  captured editor, so tab switches do not break it.
- `deactivate()` closes any open session sockets.
- The output channel is **NeoUO Results**.

## Debug adapter notes (`debug.js`)

- Sessions: `DebugStartRequest` is sent in `launch`; breakpoints require the
  server-side session to exist, so `setBreakpoints` must come after `DebugStart`.
- The engine starts in `StepInto`, so it stops on the **first traceable line**,
  which is not always line 1. The first stop is surfaced as `reason: "entry"`.
- `stopOnEntry: false`: the adapter auto-continues at `configurationDone` (after
  breakpoints are applied). A breakpoint on the entry line itself may be skipped.
- `DebugEntry` with message `"terminated"` means the script ended → DAP
  `terminated` event. `DebugException` stops on **all** exceptions, including
  handled ones.
- Events are buffered until `configurationDone`; `initialized` is sent immediately.
- Response routing is FIFO per response type; the server processes messages
  sequentially. Waiter timeouts are 15 s; disconnect is best-effort 3 s.
- Watchdog: if no stop event arrives 12 s after `configurationDone`, an output
  message warns that the client may not be logged in.
- Supported: breakpoints, continue, step in/over/out, stack trace, scopes,
  variables (including nested containers), evaluate, disconnect/terminate.
- Not supported: pause, step back, restart, set-variable. Debugging is Python only.
- The debugger type is `neouo`; the launch config is `NeoUO: Debug current file`.
- Adapter logs go to the **NeoUO Debug** output channel.

## Publishing and releases

`package.json` publisher **must remain `neouo`** — it is the Marketplace publisher
and the Open VSX namespace. Changing it changes the extension ID everywhere.

Release flow:

1. Bump `version` in `package.json` and update `CHANGELOG.md`.
2. Verify: `npm ci`, `npm run lint`, `make check-assets`, `make package`, live tests.
3. Commit/push `main`.
4. Create a GitHub release with tag `vX.Y.Z`. `checkin.yml` then:
   - sets the version from the tag
   - packages the VSIX
   - publishes to the **VS Code Marketplace** with **Trusted Publishing**
     (`vsce publish --oidc`; no PAT)
   - uploads `neouo-<version>.vsix` + `latest.json` to Cloudflare R2
   - attempts **Open VSX** if `OVSX_PAT` is configured (non-fatal)
   - attaches the VSIX to the GitHub release

Secrets (repo-level, `UltimaTools/NeoUO-extension`):

- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — Cloudflare R2
- `OVSX_PAT` — Open VSX token (optional)

Org-level R2 secrets exist for the `UltimaTools` org, but they were not applied to
the private repos on the free plan; repo-level secrets are authoritative. The
extension repo is now public, but keep the repo secrets in sync.

Marketplace Trusted Publishing policy: repository `UltimaTools/NeoUO-extension`,
workflow `checkin.yml`. The first exchange activated it.

Open VSX:

- Namespace `neouo`; ownership claim issue: `EclipseFdn/open-vsx.org#15007`.
- 0.1.0 was published but is stuck **inactive** pending review:
  `EclipseFdn/open-vsx.org#15030`. Until resolved, VSCodium users can install the
  VSIX directly.
- Manual publish: run the **Publish to Open VSX** workflow
  (`publish-openvsx.yml`), which downloads the R2 VSIX and uses `OVSX_PAT`.
- After ownership is approved and an active version exists, register a trusted
  publisher (repo `UltimaTools/NeoUO-extension`, workflow `checkin.yml`) and switch
  the Open VSX step to `--trusted-publishing` to drop the PAT.

## Website integration

`../NeoUO/web/index.html` provides:

- primary **Install VS Code Extension** button → Marketplace listing
- secondary **Direct download (.vsix)** link → `latest.json` at
  `https://releases.neouo.net/alpha/neouo-vscode-extension/latest.json`

`../NeoUO/.github/workflows/deploy-page.yml` deploys the page on pushes to
`GTK-64bit` that touch `web/**` (or the workflow). R2 bucket: `neouo-releases`.
Do not mix unrelated website changes into extension commits.

## Optional: trim vendored files from the VSIX (not applied)

The VSIX currently ships the whole `protobufjs` package, including browser bundles,
source maps, `.d.ts` files, and tests. The extension only needs `index.js`/`src/`
(and `light.js`/`minimal.js`). A future version can shrink the package and reduce
scanner surface with these `.vscodeignore` entries:

```
node_modules/**/tests/**
node_modules/**/test/**
node_modules/**/test.js
node_modules/**/*.map
node_modules/**/*.d.ts
node_modules/**/dist/**
```

Keep all `LICENSE` files. This was deferred while Open VSX review is pending; it
cannot retroactively change the already-uploaded 0.1.0. Apply it before a 0.1.1
only if needed (or for general hygiene), then repackage and re-run the live tests.

## Conventions

- ESLint flat config (`eslint.config.js`); no comments unless they add value.
- Do not commit secrets. Use GitHub secrets for R2/Open VSX credentials.
- Do not edit generated UOS assets by hand.
- Do not remove `LICENSE` or `NOTICE.md` attribution. `NOTICE.md` records the
  RazorEnhanced GPL-3 provenance and the cesarsl UOS permission.
- Keep `ProtoControl.proto` in sync with the NeoUO client.
- Do not change the publisher/extension ID without coordinating Marketplace, Open
  VSX, the website, and CI.
- Use `git status` before staging; the sibling NeoUO repo often has unrelated work.

## Known outstanding items

- Open VSX 0.1.0 inactive (support issue #15030); namespace claim #15007 pending.
- No Extension Host (`@vscode/test-electron`) tests; current coverage is live
  protocol + DAP tests.
- The vendored-file trim above is not applied.
