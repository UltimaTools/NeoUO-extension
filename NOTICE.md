# Notices and Provenance

## NeoUO extension

This Visual Studio Code extension adapts the **RazorEnhanced VS Code extension**
(https://github.com/RazorEnhanced/RazorEnhanced-extension, GPL-3.0) for use with
the **NeoUO** client (https://github.com/UltimaTools/NeoUO).

The extension has been substantially rewritten, renamed, and extended with a
Debug Adapter Protocol implementation for NeoUO's ProtoControl server. The code
in this repository is maintained by UltimaTools (credzba). The separate
RazorEnhanced-extension project remains available under GPL-3.0 from its
original authors; nothing in this repository changes the terms of that project.

## ProtoControl protocol

`ProtoControl.proto` describes the wire protocol implemented by the NeoUO
client (`NeoUO/Scripting/Proto-Control/ProtoControl.proto`, UltimaTools/NeoUO)
and by the earlier RazorEnhanced ProtoControl server.

## UOS language support

The UOS language support in this extension — syntax highlighting, snippets, and
language configuration — was originally created by **cesarsl** for the
`vsc-uosteam` project (https://github.com/cesarsl/vsc-uosteam) and is used here
with the author's permission (email from cesarsl@duck.com, 2024-09-15):

> "I don't have any problem with that, just mention the original source and me,
> and it will be fine"

The grammar, snippets, and language configuration in this repository have been
regenerated from the NeoUO UOS engine command catalog. The original idea and
source inspiration are credited to cesarsl.

## Third-party assets

- Theme colors are inspired by the original UOSteam client appearance.
- `settings.png` (if present) is a screenshot of this extension in VS Code.
