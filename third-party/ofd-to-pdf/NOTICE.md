# Maintained OFD renderer derivative

`../../ofd-renderer.js` is derived from the CommonJS distribution of
`@miconvert/ofd-to-pdf` version **0.2.3**, authored by **Antigravity / MiConvert**.
Upstream project: https://github.com/huuhuybn/miconvert-ofd-to-pdf

The upstream distribution was 49,947 bytes, with SHA-256
`254a22b7ebe342318d03b6c5efb61a6779fa8368318c74c5e04d5f831360847d`.
It is redistributed and modified under **Apache License 2.0**; the complete
license is retained in the adjacent `LICENSE`. The surrounding FlyingMouse
application license does not replace that license for this derivative.

Modifications by **牢蜂 (LaoFeng), 2026-10-02**:

- Resolve resource references from the declaring XML and its `BaseLoc`.
- Parse namespace URIs and retain the original layer/object/PageBlock order.
- Preserve background/foreground template order and reject missing pages,
  resources, unsupported drawing constructs, or failed image/font rendering.
- Bound compressed input, expansion, entry/XML/page/object counts, nesting,
  and decoded image pixels; reject DTD/entity declarations and unsafe paths.
- Remove silent error swallowing, placeholder glyphs, lossy fallback rendering,
  and cross-document fontkit registration state.
- Expose source-page inspection so the application can check the actual final
  PDF rendering before publishing a conversion result.
- Respect Background/Body/Foreground layer and template groups while preserving
  same-group XML order; implement basic DrawParam/Relative style inheritance,
  neutral explicit attributes, and standard `S x y` subpath starts.
- Materialize image alpha compositing before content statistics; cache embedded
  images by document resource path and preflight at most 100 MP of distinct images.
- Propagate cancellation through archive/page/object/font/image/save boundaries,
  with periodic event-loop yields so cancellation during work is observable.

Layer order and path semantics were checked against the upstream OFDRW primary
implementation: [Content.java](https://github.com/ofdrw/ofdrw/blob/master/ofdrw-core/src/main/java/org/ofdrw/core/basicStructure/pageObj/Content.java),
[CT_TemplatePage.java](https://github.com/ofdrw/ofdrw/blob/master/ofdrw-core/src/main/java/org/ofdrw/core/basicStructure/pageObj/CT_TemplatePage.java),
and [AbbreviatedData.java](https://github.com/ofdrw/ofdrw/blob/master/ofdrw-core/src/main/java/org/ofdrw/core/graph/pathObj/AbbreviatedData.java).

This is a deliberately bounded renderer. Unsupported constructs produce an
explicit error; this file does not claim complete GB/T 33190 conformance.
It retains the upstream PDF producer/creator attribution.

Follow-up modifications by **牢蜂 (LaoFeng), 2026-10-03**:

- Inherit omitted `TextCode` X/Y from the previous run's origin, not its final
  glyph position; keep DeltaY-only runs in their column.
- Default PathObject Fill to false independently of a supplied FillColor.
- Clip text, paths, and images to their Boundary rectangle, and isolate each
  object's graphics state and unfinished PDF path from subsequent objects.

These semantics were checked against OFDRW's primary implementation:
[TextCode.java](https://raw.githubusercontent.com/ofdrw/ofdrw/master/ofdrw-core/src/main/java/org/ofdrw/core/text/TextCode.java),
[CT_Path.java](https://raw.githubusercontent.com/ofdrw/ofdrw/master/ofdrw-core/src/main/java/org/ofdrw/core/graph/pathObj/CT_Path.java),
and [CT_GraphicUnit.java](https://raw.githubusercontent.com/ofdrw/ofdrw/master/ofdrw-core/src/main/java/org/ofdrw/core/pageDescription/CT_GraphicUnit.java).
This adds rectangular Boundary clipping, not support for arbitrary Clips.

Follow-up modifications by **牢蜂 (LaoFeng), 2026-11-04**:

- Resolve system-fallback TrueType collections to their first face before passing them to
  pdf-lib. Collection order is deterministic; for Windows `msyh.ttc` this is
  Microsoft YaHei. Embed a subset of that face, never the raw TTC as a PDF font.
  This does not identify arbitrary embedded collection faces by `FontName`;
  embedded TTC fonts remain explicitly unsupported, including mislabeled TTFs.
  Other collection formats such as Macintosh DFont are rejected by the fontkit
  adapter, even when mislabeled with a supported standalone font extension.
- Load fallback fonts only for used text fonts, so an unrelated system font
  cannot break image-only or blank pages. Keep font-directory selection local
  to each conversion, and retain explicit rejection of missing glyphs.
- Exercise real TTC parsing and PDF text extraction with collections built at
  test time from pdfjs-dist's licensed Liberation Sans font. Windows system
  fonts are not redistributed by these tests.
