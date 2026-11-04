# Maintained dependency compatibility patch

Author: 牢蜂（LaoFeng）。仅供个人免费使用，禁止商业售卖/转卖/套壳。

The upstream `temp` package remains `temp@0.9.4`, with its original package
metadata and MIT license (`temp-LICENSE`). The application overrides its
`rimraf` dependency to the official `rimraf@6.1.3` release, using the official
`glob@14.0.3` and `minimatch@11.0.4` implementations throughout the main build.

`temp-rimraf-compat.json` describes its complete local compatibility delta:

- Import `rimraf` and `rimrafSync` by their current exported names.
- Deliver modern Promise completion to the existing callback contract.
- Translate `maxBusyTries: 6` into the supported `maxRetries: 6` option.

ExcelJS remains `exceljs@4.4.0`, with its original metadata and MIT license
(`exceljs-LICENSE`). Its three reviewed consumer corrections are:

- `exceljs-stream-buf-compat.json`: return the destination from `StreamBuf.pipe`,
  as required by the stream contract used by modern archive utilities.
- `exceljs-workbook-reader-compat.json`: iterate the ZIP reader using its native
  async iterator and require workbook metadata before parsing a worksheet.
  This preserves the final ZIP entry and supports ordinary XLSX ZIP ordering.
  Deferred worksheet streams use an awaited pipeline to propagate ZIP errors;
  temporary worksheet cleanup runs even after parsing fails.
- `exceljs-parse-sax-compat.json`: close the XML parser at the end of its input
  so truncated or malformed XML is rejected instead of returning partial data.

`scripts/patch-dependency-compat.js` checks the exact upstream package version,
the complete input SHA-256, replacement counts, and complete output SHA-256.
It accepts an already patched exact output without rewriting it. Unexpected
content, missing patches in check mode, and redirected dependency paths fail.
The required set of four JSON rules is fixed: missing or extra rules fail before
any dependency is inspected, so removing a rule cannot silently reduce checks.
No dependency version, name, security implementation, or audit result is
rewritten. A fresh `npm ci` applies the patches through `postinstall`; build
preparation runs the same script with `--check` or calls
`verifyDependencyCompatibility({root, requireBuild: true})` before packaging.
An explicitly selected production-only install may omit `temp` only when the
project lock identifies it as a development dependency. All three ExcelJS patches
remain mandatory. Build checks always require all four patched files.

These patches belong to the modern Windows 10/11 dependency tree. The isolated
Windows 7 profile removes the modern overrides, this hook, and their tests.
Do not run this patcher against the canonical source workspace's retained old
`node_modules` junction. Execute installation, testing and builds in the new
frozen source directory with its independently installed physical dependencies.

Upstream sources:

- https://github.com/bruce/node-temp/tree/v0.9.4
- https://github.com/isaacs/rimraf/tree/v6.1.3
- https://github.com/exceljs/exceljs/tree/v4.4.0
- https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249
