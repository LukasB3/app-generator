# Bundled libraries

The only third-party code a generated app can load. The orchestrator copies this folder into every workspace, ignores whatever the agent does to its copy, and publishes the files from here. They are not scanned by the checker, so each one was read for `eval`, `new Function` and network or storage calls before it was added: none of them has any.

| File | Package and version | Taken from | Licence | SHA-256 of the upstream file |
|---|---|---|---|---|
| `qrcode.js` | qrcode-generator 2.0.4 | `dist/qrcode.js` | MIT | `79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c` |
| `chart.js` | chart.js 4.5.1 | `dist/chart.umd.js` | MIT | `ecc3cd1eeb8c34d2178e3f59fd63ec5a3d84358c11730af0b9958dc886d7652a` |
| `preact.js` | htm 3.1.1, which bundles Preact 10 | `preact/standalone.umd.js` | Apache 2.0 (htm), MIT (Preact) | `62c4ffea400078c0eda7f435b22726b4961ebdf74c8506f188e92bec41d8ac51` |

`preact.js` has one line added at the top, the licence notice the upstream bundle lacks; the checksum is of the file without that line. The other two are byte for byte what npm delivers.

`db.js` is not from npm. It is this project's own: the client for an app's tables in the shared database, described in `../../docs/threat-model.md`.

To add a library: one classic script (no modules, no imports), small because every app that uses it carries a copy, pinned to a release that has been out for a while, read as described above, listed here and documented in `../system-prompt.md`.
