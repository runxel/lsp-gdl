# GDL Language Server

A [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) implementation for **GDL** — the BASIC-derived language used to script library parts in [Archicad](https://graphisoft.com/archicad).

This repo contains both halves: the language server and the VS Code extension that hosts it.

It **complements** Graphisoft's own [vscode-gdl](https://github.com/GRAPHISOFT/vscode-gdl) extension (rather than replacing it), which already provides syntax colouring, snippets, the outline tree and the reference guide.
The LSP only adds what a TextMate grammar structurally cannot do — understanding *which script* you are editing, *which parameters* the library part has, and whether the code actually holds together.

If not already done, `vscode-gdl` will be installed alongside (it's declared as an extension dependency).


## Status

Solid but still quite early. The foundations are in place and have been tested against a corpus of ~3000 real GDL scripts.


**Working**

- **Script-aware completion** — statements filtered to the script you are in,
  plus the library part's parameters and the variables in scope. Because the
  master script runs before every other one, its variables are offered
  everywhere too — except those starting with `_`, which are private by
  convention. Globals are filtered to the scripts the reference guide allows.
- **Hover** — parameters (type, description, flags), keywords, globals, fixed
  parameters, autotexts and query strings, with the scripts each is valid in.
  Globals and the `ac_`/`ifc_` fixed parameters also carry the **reference guide's own description** — 
  read from the official GRAPHISOFT extension you already have installed.
  And a variable that arrived from the **master script** is explained where it is used, with the line that defines it, so a name 
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
  - labels (subroutine and `goto` names)
  - "`group`" names can be renamed as well
  - keywords, globals and fixed parameters (`A`, `zzyzx`, `ac_*`) are excluded
- **Go-to-definition** (⌘-click) for **Group commands**
- **Auto formatting**
- **Folding** — blocks (`if`/`endif`, `for`/`next`, both `while` loops,
  `repeat`/`until`, `group`/`endgroup`, `paragraph`/`endparagraph`) whether
  indented or not, an `if` with an `else` as two branches, subroutines from
  their label through the `return`, wrapped argument lists, and runs of comment lines.
- **Regions** — mark any stretch of a script yourself, and nest them as deep as you like:

  ```gdl
  ! #region [Hotspots]
  hotspot2 0, 0
  hotspot2 A, 0
  ! #endregion
  ```

  A region folds down to its first line. **A named one is also listed as a symbol** — in 
  the Outline view (in a *Regions* group, beside the subroutines
  and macro calls the GRAPHISOFT extension lists), in the breadcrumbs, and in
  Go to Symbol in Editor (⇧⌘O / Ctrl+Shift+O) — so you can jump straight to
  it. The brackets around the name are optional, as is the `#`; case does not
  matter. The marker must be a comment on a line of its own, and only a
  `#region` closed by an `#endregion` counts.

  > **Caution: indentation folding is gone.** Once a language server provides
  > folding, VS Code stops folding `.gdl` files by indentation, so the folds you
  > get are exactly the ones listed above. A stretch of code that used to fold
  > only because it was indented — and is none of these — no longer folds;
  > wrap it in a region instead.
- **Section headers in the minimap** — named regions, banner comments and
  subroutines are written into the minimap as headings, so a long script can
  be navigated at a glance:

  ```text
  ! ==========================            !------------------------------!
  ! Hotspots                 → Hotspots   ! what the routine does          → draw handle
  ! ==========================            "draw handle":
  ```

  A banner is a title between two identical rule lines (`=`, `-` or `*`). A
  subroutine is a label under a rule line, with up to three comment lines in
  between. This ships as a default for `editor.minimap.markSectionHeaderRegex`
  in `.gdl` files, so there is nothing to set up.

  > **To change the pattern, set it for GDL only**, under `"[gdl-hsf]"` in
  > your settings. VS Code ranks an extension's language-specific default
  > above your own *global* setting, so an unscoped
  > `editor.minimap.markSectionHeaderRegex` no longer applies to `.gdl` files.
  > `editor.minimap.showMarkSectionHeaders` turns the headings off.
- **Called Macros view** in the Explorer — every macro the open script calls,
  followed recursively through the workspace and drawn as a classic tree
  (`+`/`−` boxes, dotted connectors). Click a macro to open the script that
  call runs; Alt-click, or the arrow at the row's end, jumps to the call —
  and for a macro called several times, on to the next call with each click.
  Macros only present as a `.gsm`, not in the workspace at all, or named by a
  variable nothing assigns, are shown as such rather than hidden.


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
