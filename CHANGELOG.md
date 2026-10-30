# Changelog

## [0.1.0] - 2026-10-30

### Added

- **Play** and **Record** commands backed by NeoUO's ProtoControl WebSocket server.
- **Python debugging** via a full Debug Adapter Protocol implementation: breakpoints, step over/into/out, call stack, scopes, variables, expression evaluation, and disconnect.
- `stopOnEntry` support: stop on the first line (default) or run until the first breakpoint.
- **UOS language support** generated from the NeoUO engine command catalog: syntax highlighting, snippets, indentation rules, document formatter, and theme.
- Live integration tests for DAP, play, play-stop, and record against a running NeoUO client.

### Changed

- Adapted from the RazorEnhanced VS Code extension and relicensed under the NeoUO license (see `LICENSE` and `NOTICE.md`).
- Play/record/stop now use one WebSocket per session instead of opening a new connection per command.

### Fixed

- Stop Play and Stop Record now travel over the session socket, eliminating leaked connections and the stop acknowledgement that never arrived.
- Connection failures reset the play/record state and show an error instead of leaving the toolbar stuck.
- Scripts are split CRLF-safely, unsupported languages are rejected up front, and session IDs are clamped to 31 bits.
- Recording appends through `WorkspaceEdit` by document URI, so it survives tab switches.
- Debug adapter: decode errors no longer break the message loop, failed sends clean up their waiters, and `dispose()` releases pending requests.
