# NeoUO for Visual Studio Code

Run, record, and debug [NeoUO](https://github.com/UltimaTools/NeoUO) scripts
directly from VS Code (or VSCodium). The extension talks to the running client
over NeoUO's ProtoControl WebSocket server.

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/neouo.neouo?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=neouo.neouo)
[![Marketplace installs](https://img.shields.io/visual-studio-marketplace/i/neouo.neouo)](https://marketplace.visualstudio.com/items?itemName=neouo.neouo)
![GitHub](https://img.shields.io/github/license/UltimaTools/NeoUO-extension)
![GitHub repo size](https://img.shields.io/github/repo-size/UltimaTools/NeoUO-extension)
![GitHub all releases](https://img.shields.io/github/downloads/UltimaTools/NeoUO-extension/total)

## Features

- **Play** — send the active editor's script to the NeoUO client and stream its output back into VS Code.
- **Record** — capture your in-game actions and append the generated script code to the active editor.
- **Python debugging** — full Debug Adapter Protocol integration: breakpoints, step over/into/out, call stack, variables and scopes, and expression evaluation in the debug console.
- **UOS language support** — syntax highlighting, snippets, indentation rules, a document formatter, and a matching dark theme (with credit to the original author, see [Credits](#credits--provenance)).
- **Multiple instances** — connect to any NeoUO instance by configuring its ProtoControl port.

## Requirements

- A running **NeoUO** client: <https://github.com/UltimaTools/NeoUO>
- **ProtoControl enabled** in NeoUO (Settings → Technical → Help/Status shows the assigned port).
- A **logged-in character** — play, record, and debug are ignored by a client that is still at the login screen.
- VS Code 1.60 or newer (or a compatible VSCodium build).

NeoUO assigns the first free ProtoControl port in the range **15454–15464**. The
extension defaults to 15454. If you run several clients, use the port shown on
each client's technical help tab.

## Installation

### From the Marketplace

Open the Extensions view and search for **NeoUO**, or run:

```bash
code --install-extension neouo.neouo
```

Marketplace installs update automatically. VSCodium users can install the VSIX
directly, or from Open VSX when it is published.

### From a VSIX package

Download the latest `.vsix` from the [NeoUO download page](https://releases.neouo.net/)
and install it:

```bash
code --install-extension neouo-<version>.vsix
```

To build the VSIX locally:

```bash
npm install
npx vsce package
```

### Development build

Open this folder in VS Code and press **F5** to launch an Extension Development
Host with the extension loaded.

## Usage

Open a `.py`, `.cs`, or `.uos` file and use the editor context menu, or the
command palette:

| Command | Description |
| --- | --- |
| `NeoUO: Play` | Send the current file's contents to NeoUO and stream the result |
| `NeoUO: Stop Play` | Stop the running script |
| `NeoUO: Record` | Start recording gameplay into the current file |
| `NeoUO: Stop Record` | Stop recording |

Recorded code is appended to the active editor as it is generated.

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `neoUO.serverPort` | `15454` | Port of the NeoUO ProtoControl server |

The `port` in a debug configuration overrides the setting for that session.

## Debugging Python scripts

The debugger runs your script inside the live NeoUO client, so NeoUO APIs such
as `Player`, `Items`, and `Misc` are available while you step through code.

Create a launch configuration (`.vscode/launch.json`) or pick
**NeoUO: Debug current file** from the Run and Debug view:

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "neouo",
            "request": "launch",
            "name": "NeoUO: Debug current file",
            "program": "${file}",
            "port": 15454
        }
    ]
}
```

Supported debug features:

- Line breakpoints with verification
- Step over, step into, and step out
- Call stack with source locations
- Scopes, variables, and nested containers (lists, dictionaries, arrays)
- Hover evaluation and debug console expressions
- Stop/terminate and disconnect

Limitations:

- Debugging is **Python only** (NeoUO's debug engine rejects other languages).
- By default execution stops on the first line; set `"stopOnEntry": false` to run until the first breakpoint.
- Pausing a running script and stepping backwards are not supported.
- All Python exceptions pause execution, including ones your script catches.
- One debug session per file at a time; use the launch configuration `port` to target a different client instance.

## UOS language support

`.uos` files get:

- Syntax highlighting for UOS commands, properties, constants, strings, comments, and numbers
- Snippets for commands, expressions, and control flow (`if`, `ifel`, `else`, `while`, `for`, `for_to`, `for_list`, `for_to_list`, `pause`)
- Indentation rules and a document formatter
- A dark theme matching the classic UOSteam look (`NeoUO Theme`)

## Development

```bash
npm install          # install dependencies
npm run lint         # eslint (extension, debug adapter, tools)
make package         # build a VSIX (requires vsce)
```

### Live tests

The test scripts expect a running NeoUO client with a logged-in character.
Pass the ProtoControl port as the first argument (default `15454`):

```bash
node dap_test.js 15454                  # end-to-end DAP sessions (entry stop, breakpoints, stepping, variables, evaluate, stopOnEntry=false)
node proto_control_node_test.js 15454 play
node proto_control_node_test.js 15454 play-stop
node proto_control_node_test.js 15454 record
node proto_control_node_test.js 15454 debug
```

### Regenerating UOS language assets

The UOS grammar, snippets, and language configuration are generated from
the NeoUO UOS engine command catalog:

```bash
npm run gen:uos -- --source ../NeoUO/NeoUO/Scripting/UOSteamEngine.cs
```

The generator reads `RegisterCommandHandler`/`RegisterExpressionHandler` entries
and their XML `<summary>` usage docs, then writes:

- `snippets/uos.json`
- `syntaxes/uos.tmLanguage.json`
- `language-configuration.json`
- `tools/uos-commands.json` (checked-in catalog for reproducible builds)

Control-flow snippets are maintained by hand in `tools/uos-templates.json`.

### Project layout

| Path | Purpose |
| --- | --- |
| `extension.js` | Play/record commands, UOS formatter, extension activation |
| `debug.js` | Debug Adapter Protocol implementation bridged to ProtoControl |
| `ProtoControl.proto` | Wire protocol definition (source of truth: `NeoUO/Scripting/Proto-Control/ProtoControl.proto`) |
| `syntaxes/`, `snippets/`, `language-configuration.json` | Generated UOS language assets |
| `themes/uos-theme.json` | Dark theme |
| `tools/generate-uos-assets.js` | UOS asset generator |
| `dap_test.js`, `proto_control_node_test.js` | Live integration tests |

When NeoUO's `ProtoControl.proto` changes, update the copy in this repository and
re-run the tests.

## Credits & provenance

- This extension is an adaptation of the **RazorEnhanced VS Code extension**
  (GPL-3.0, <https://github.com/RazorEnhanced/RazorEnhanced-extension>).
  That project remains available under GPL-3.0 from its original authors.
- **UOS language support** (grammar, snippets, language configuration) was
  originally created by **cesarsl** for
  [vsc-uosteam](https://github.com/cesarsl/vsc-uosteam) and is used with the
  author's permission (email dated 2024-09-15). The assets in this repository
  have been regenerated from the NeoUO command catalog; the original idea and
  source inspiration are credited to cesarsl.
- **ProtoControl** is part of the [NeoUO](https://github.com/UltimaTools/NeoUO)
  project.

See [NOTICE.md](NOTICE.md) for the full provenance record.

## License

This project is distributed under the NeoUO license. See [LICENSE](LICENSE) for
the full text.
