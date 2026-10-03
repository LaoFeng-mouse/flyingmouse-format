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
