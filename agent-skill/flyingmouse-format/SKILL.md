---
name: flyingmouse-format
description: Use FlyingMouse Format's local offline CLI to inspect supported conversions and convert images, text, documents, spreadsheets, presentations, PDFs, archives, audio, and video. Trigger when a user asks to convert file formats, merge images into PDF, merge PDFs, inspect available target formats, or automate these operations from an agent.
---

# FlyingMouse Format

Use the bundled wrapper at `scripts/flyingmouse-format.js`. It locates the FlyingMouse Format application configured by the in-app “Connect to Agent” action and invokes its CLI.

## Workflow

1. Check available targets before an unfamiliar conversion:

   `node scripts/flyingmouse-format.js targets <file> --json`

2. Convert one or more independent files:

   `node scripts/flyingmouse-format.js convert <files...> --to <format> --output-dir <directory> --json`

3. Merge images into one PDF:

   `node scripts/flyingmouse-format.js images-to-pdf <images...> --output <result.pdf> --json`

4. Merge PDFs:

   `node scripts/flyingmouse-format.js merge-pdfs <pdfs...> --output <result.pdf> --json`

5. Use `capabilities --json` when engine availability matters.

## Options

- ZIP: `--compression-level 0..9`
- Video: `--video-codec h264|h265|av1`
- PDF: `--pdf-action encrypt|decrypt --password <password>`
- Prefer `--json` and read `outputs[].path` from stdout.
- Never echo or log a PDF password.
- Preserve the user's requested output directory and do not overwrite existing files without permission.

If the wrapper reports that FlyingMouse Format is missing, ask the user to open the application and use “Connect to Agent” again.
