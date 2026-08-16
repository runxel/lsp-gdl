# GDL Language Server

A [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) implementation for **GDL** — the BASIC-derived language used to script library parts in [Archicad](https://graphisoft.com/archicad).

This repo contains both halves: the language server and the VS Code extension that hosts it.

It **complements** Graphisoft's own [vscode-gdl](https://github.com/GRAPHISOFT/vscode-gdl) extension (rather than replacing it), which already provides syntax colouring, snippets, the outline tree and the reference guide.
The LSP only adds what a TextMate grammar structurally cannot do — understanding *which script* you are editing, *which parameters* the library part has, and whether the code actually holds together.

If not already done, `vscode-gdl` will be installed alongside (it's declared as an extension dependency).


## Status

Solid but still quite early. The foundations are in place and have been tested against a corpus of ~2500 real GDL scripts.


**Working**

- **Script-aware completion** — statements filtered to the script you are in,
  plus the library part's parameters and the variables in scope. Because the
  master script runs before every other one, its variables are offered
  everywhere too — except those starting with `_`, which are private by
  convention. Globals are filtered to the scripts the reference guide allows.
- **Hover** — parameters (type, description, flags), keywords, globals, fixed
  parameters, autotexts and query strings, with the scripts each is valid in.
  Globals and the `ac_`/`ifc_` fixed parameters also carry the **reference
  guide's own description** — read from the official GRAPHISOFT extension you
  already have installed. And a variable that arrived from the **master script** 
  is explained where it is used, with the line that defines it, so a name 
  with no declaration in the file you are reading is no longer a mystery.
- **Where a Global actually works** — e.g. `GLOB_SCALE` is view dependent so you'll get a warning in the master script.
- **Diagnostics**
  - unbalanced blocks (`if`/`endif`, `for`/`next`, `while`/`endwhile`, `do`/`while`,
    `repeat`/`until`, `group`/`endgroup`)
  - commands used in the wrong script, e.g. `cutplane` in a parameter script
  - deprecated names
  - unterminated strings
- **Trailing and missing Commas**
- **Array bounds** — writing or reading past fixed `DIM` sizes, and any index below 1.
- **Parameter names** in `parameters`, `lock`, `hideparameter`, `values` and `values{2}` checked against `paramlist.xml`.
- **(Basic) Type checking**
- **Symbol Rename**:
  - a variable defined in the **master** script is renamed across every script of the library part
  - a variable local to one script is renamed only in there
  - keywords, globals and fixed parameters (`A`, `zzyzx`, `ac_*`) are excluded
- **Go-to-definition** (⌘-click) for **Group commands**


## Requirements

Source must be in **HSF** (Hierarchical Source Format) — the folder layout produced by `LP_XMLConverter`:

```
MyObject/
  libpartdata.xml
  paramlist.xml
  ….xml
  scripts/
    1d.gdl  2d.gdl  3d.gdl  vl.gdl  ui.gdl  pr.gdl  fwm.gdl  bwm.gdl
```

The script kind is taken from the filename, and parameters are read from `paramlist.xml`. The extension activates when a `gdl-hsf` file is opened.


## Development

```bash
npm install
npm run compile
npm test
```

Press **F5** (`Launch Client`) to open an Extension Development Host on `TestObject/`, which holds a small library part with deliberate mistakes in `scripts/3d.gdl` to exercise the diagnostics.

To debug the server itself, run the `Client + Server` compound configuration, or attach to port 6009.


## Building

```bash
npm run package
```

This compiles both halves and writes the installable extension to **`dist/lsp-gdl-<version>.vsix`**. The version comes from `package.json`, and `dist/` is ignored by git. Install the result with:

```bash
code --install-extension dist/lsp-gdl-*.vsix
```

The `.vsix` bundles the compiled `client/out` and `server/out` together with their runtime dependencies; sources, tests, the keyword generator and the test fixture are excluded by `.vscodeignore`.
Because the manifest declares `Graphisoft.gdl` as an extension dependency, VS Code installs the official GDL extension alongside it.


## Layout

```
client/     VS Code extension host
server/     the language server
data/       keyword list (vendored from [GRAPHISOFT/vscode-gdl](https://github.com/GRAPHISOFT/vscode-gdl) under MIT license)
scripts/    build-time code generation
TestObject/ sample HSF library part
```


## Licence

MIT — see [LICENSE](LICENSE).

The client/server split and build setup started from Microsoft's
[`lsp-sample`](https://github.com/microsoft/vscode-extension-samples/tree/main/lsp-sample)
(MIT, Copyright (c) Microsoft Corporation).

GDL (Geometric Description Language) and Archicad are products of Graphisoft SE.
This project is an independent, unaffiliated developer tool.
Tautological boilerplate: All trademarks and copyrights on this page are the property of their respective owners.
