# Bundled libraries

The only third-party code and fonts a generated app can load. The orchestrator copies this folder into every workspace, ignores whatever the agent does to its copy, and publishes the files from here. They are not scanned by the checker, so each one was read for `eval`, `new Function` and network or storage calls before it was added: none of them has any.

| File | Package and version | Taken from | Licence | SHA-256 of the upstream file |
|---|---|---|---|---|
| `qrcode.js` | qrcode-generator 2.0.4 | `dist/qrcode.js` | MIT | `79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c` |
| `chart.js` | chart.js 4.5.1 | `dist/chart.umd.js` | MIT | `ecc3cd1eeb8c34d2178e3f59fd63ec5a3d84358c11730af0b9958dc886d7652a` |
| `preact.js` | htm 3.1.1, which bundles Preact 10 | `preact/standalone.umd.js` | Apache 2.0 (htm), MIT (Preact) | `62c4ffea400078c0eda7f435b22726b4961ebdf74c8506f188e92bec41d8ac51` |
| `icons.js` | lucide-static 1.72.0 | 164 icons out of `icon-nodes.json`, written out by `build-icons.mjs` | ISC, some icons MIT (Feather) | `1076b052e2dc2363c30a271121192755ef1414db6fa8dae393b52b90a49e83db` |
| `fonts/inter/inter-latin-ext.woff2` | @fontsource-variable/inter 5.3.0 | `files/inter-latin-ext-wght-normal.woff2` | OFL 1.1 | `34b9c504cab7a73e37b746343a449132e56cf7b5481af2cb81dc74dcff25c956` |
| `fonts/inter/inter-latin.woff2` | @fontsource-variable/inter 5.3.0 | `files/inter-latin-wght-normal.woff2` | OFL 1.1 | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `fonts/space-grotesk/space-grotesk-latin-ext.woff2` | @fontsource-variable/space-grotesk 5.3.0 | `files/space-grotesk-latin-ext-wght-normal.woff2` | OFL 1.1 | `952dddb45d2f96f71cbf3b7f510b24379afc3c89ea02fcf89d377b45d62c0166` |
| `fonts/space-grotesk/space-grotesk-latin.woff2` | @fontsource-variable/space-grotesk 5.3.0 | `files/space-grotesk-latin-wght-normal.woff2` | OFL 1.1 | `0640890476fc1198ab4de571fb658de443c4d85b66466ec09534a8737ab1ce9d` |
| `fonts/fraunces/fraunces-latin-ext.woff2` | @fontsource-variable/fraunces 5.3.0 | `files/fraunces-latin-ext-wght-normal.woff2` | OFL 1.1 | `a21ecfbf41fbc393e24ef9b7e38532a27e8da5e0a074aa7d66802d1b5ccec2f0` |
| `fonts/fraunces/fraunces-latin.woff2` | @fontsource-variable/fraunces 5.3.0 | `files/fraunces-latin-wght-normal.woff2` | OFL 1.1 | `7f9d191d999336d3b9790afa72e1358e50a13b06d4f289341e92a311967a80f9` |
| `fonts/jetbrains-mono/jetbrains-mono-latin-ext.woff2` | @fontsource-variable/jetbrains-mono 5.3.0 | `files/jetbrains-mono-latin-ext-wght-normal.woff2` | OFL 1.1 | `79bfdab9ba467e26eea4122e6f2567e188dd8a09a8c730d501fc487c4ab99c6e` |
| `fonts/jetbrains-mono/jetbrains-mono-latin.woff2` | @fontsource-variable/jetbrains-mono 5.3.0 | `files/jetbrains-mono-latin-wght-normal.woff2` | OFL 1.1 | `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e` |
| `fonts/nunito/nunito-latin-ext.woff2` | @fontsource-variable/nunito 5.3.0 | `files/nunito-latin-ext-wght-normal.woff2` | OFL 1.1 | `2c8d792869818ecb253a46bc3c63c7013df7aac2f69291c3c85e5cdc94160960` |
| `fonts/nunito/nunito-latin.woff2` | @fontsource-variable/nunito 5.3.0 | `files/nunito-latin-wght-normal.woff2` | OFL 1.1 | `ba344451eab25b217a165363b1982048a5e5830a0daf36577973955a04cac793` |

`preact.js` has one line added at the top, the licence notice the upstream bundle lacks; the checksum is of the file without that line. `qrcode.js` and `chart.js` are byte for byte what npm delivers.

`icons.js` is made here: `build-icons.mjs` takes the drawing instructions of the icons it names from the package's `icon-nodes.json` (data, no code) and wraps them in a small function that builds an `<svg>` element. The licence text of the package is its header.

The fonts are the variable files of five families, one file for the Latin alphabet and one for its extensions (Polish, Czech, Turkish and the like), byte for byte what npm delivers, renamed. Each family is a folder with a `font.css` that declares the two files and a `LICENSE.txt`, the licence text of the package. An app that links a family's `font.css` gets the whole folder published with it, so the licence travels with the font. A font file is data: nothing in it runs.

`db.js` and `data.js` are not from npm. They are this project's own: the client for an app's tables in the shared database, and the client for the live data routes of the API. Both are described in `../../docs/threat-model.md`.

To add a library: one classic script (no modules, no imports), small because every app that uses it carries a copy, pinned to a release that has been out for a while, read as described above, listed here and documented in `../system-prompt.md`. To add a font: a folder under `fonts/` made the same way, under the SIL Open Font License or one as free, with its licence file in it.
