"""Normalize engine-specific dictionaries into structure manifest schema v1."""

from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


class ResourceLimitError(Exception):
    pass


class InvalidNormalizationError(Exception):
    pass


@dataclass(frozen=True)
class Limits:
    max_pages: int = 500
    max_dimension: int = 16_384
    max_page_pixels: int = 50_000_000
    max_total_pixels: int = 100_000_000
    max_output_bytes: int = 512 * 1024 * 1024
    max_blocks_per_page: int = 5_000
    max_tables_per_page: int = 100
    max_cells_per_table: int = 20_000
    max_candidates_per_page: int = 2
    max_text_length: int = 4_096
    max_warnings_per_page: int = 100
    max_html_length: int = 4 * 1024 * 1024


DEFAULT_LIMITS = Limits()
SOURCE_ORDER = {"pp-structure-v3": 0, "img2table": 1}
BLOCK_TYPES = {
    "doc_title": "heading", "paragraph_title": "heading", "title": "heading",
    "text": "text", "paragraph": "text", "table": "table", "seal": "seal",
    "signature": "signature", "figure": "figure", "image": "figure",
}


def _number(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    if result != result or result in (float("inf"), float("-inf")):
        return default
    return result


def _confidence(value: Any) -> float:
    result = _number(value, 0.0)
    if not 0 <= result <= 1:
        raise InvalidNormalizationError("confidence")
    return result


def _bounded_text(value: Any, limits: Limits) -> str:
    text = "" if value is None else str(value)
    if len(text) > limits.max_text_length:
        raise ResourceLimitError()
    return text


def _bbox(value: Any, width: int, height: int) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise InvalidNormalizationError("bbox")
    box = [_number(item, -1) for item in value]
    x0, y0, x1, y1 = box
    if x0 < 0 or y0 < 0 or x1 < x0 or y1 < y0 or x1 > width or y1 > height:
        raise InvalidNormalizationError("bbox")
    return [int(v) if v.is_integer() else v for v in box]


def _relative_asset(value: Any) -> str:
    if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
        raise InvalidNormalizationError("asset")
    path = Path(value)
    if path.is_absolute() or ":" in value or any(part in ("", ".", "..") for part in value.split("/")):
        raise InvalidNormalizationError("asset")
    return value


def _normalize_cell(cell: dict, width: int, height: int, limits: Limits) -> dict:
    row = int(cell.get("row", cell.get("row_index", -1)))
    column = int(cell.get("column", cell.get("col", cell.get("column_index", -1))))
    row_span = int(cell.get("rowSpan", cell.get("row_span", 1)))
    column_span = int(cell.get("columnSpan", cell.get("col_span", cell.get("column_span", 1))))
    if min(row, column) < 0 or min(row_span, column_span) < 1:
        raise InvalidNormalizationError("cell")
    return {"row": row, "column": column, "rowSpan": row_span,
            "columnSpan": column_span, "bbox": _bbox(cell.get("bbox"), width, height),
            "text": _bounded_text(cell.get("text", cell.get("content", "")), limits),
            "confidence": _confidence(cell.get("confidence", cell.get("score", 0)))}


def _normalize_table(table: dict, width: int, height: int, limits: Limits,
                     table_id: str) -> dict:
    raw_cells = table.get("cells", table.get("cell_list", []))
    if not raw_cells and table.get("cell_box_list") is not None:
        raw_cells = _cells_from_ppstructure(table, limits)
    if not isinstance(raw_cells, list):
        raise InvalidNormalizationError("cells")
    if len(raw_cells) > limits.max_cells_per_table:
        raise ResourceLimitError()
    cells = [_normalize_cell(cell, width, height, limits) for cell in raw_cells]
    cells.sort(key=lambda cell: (cell["row"], cell["column"], cell["rowSpan"], cell["columnSpan"]))
    row_count = int(table.get("rowCount", table.get("row_count",
        max((cell["row"] + cell["rowSpan"] for cell in cells), default=0))))
    column_count = int(table.get("columnCount", table.get("column_count",
        max((cell["column"] + cell["columnSpan"] for cell in cells), default=0))))
    if row_count < 1 or column_count < 1 or row_count * column_count > limits.max_cells_per_table:
        raise ResourceLimitError()
    normalized_id = str(table.get("id", table_id))
    if not normalized_id or len(normalized_id) > 256: raise InvalidNormalizationError("table id")
    result = {"id": normalized_id, "rowCount": row_count,
              "columnCount": column_count, "bbox": _bbox(table.get("bbox"), width, height),
              "confidence": _confidence(table.get("confidence", table.get("score", 0))),
              "cells": cells}
    if "source" in table:
        source = table["source"]
        if source not in SOURCE_ORDER:
            raise InvalidNormalizationError("source")
        result["source"] = source
    return result


class _TableHTMLParser(HTMLParser):
    def __init__(self, limits: Limits):
        super().__init__(convert_charrefs=True)
        self.limits = limits
        self.rows = []
        self.current_row = None
        self.current_cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.current_row = []
            self.rows.append(self.current_row)
        elif tag in ("td", "th") and self.current_row is not None:
            attributes = dict(attrs)
            self.current_cell = {"rowSpan": int(attributes.get("rowspan", 1)),
                                 "columnSpan": int(attributes.get("colspan", 1)), "text": ""}
            self.current_row.append(self.current_cell)

    def handle_data(self, data):
        if self.current_cell is not None:
            self.current_cell["text"] = _bounded_text(self.current_cell["text"] + data, self.limits)

    def handle_endtag(self, tag):
        if tag in ("td", "th"): self.current_cell = None
        elif tag == "tr": self.current_row = None


def _cells_from_ppstructure(table: dict, limits: Limits) -> list[dict]:
    boxes = table.get("cell_box_list")
    html = table.get("pred_html")
    if (not isinstance(boxes, list) or not isinstance(html, str)
            or len(boxes) > limits.max_cells_per_table or len(html) > limits.max_html_length):
        raise InvalidNormalizationError("pp table")
    parser = _TableHTMLParser(limits)
    try:
        parser.feed(html); parser.close()
    except (ValueError, TypeError) as error:
        raise InvalidNormalizationError("table html") from error
    descriptors = [cell for row in parser.rows for cell in row]
    if len(descriptors) != len(boxes):
        raise InvalidNormalizationError("table cells")
    ocr = table.get("table_ocr_pred", {})
    scores = ocr.get("rec_scores", []) if isinstance(ocr, dict) else []
    texts = ocr.get("rec_texts", []) if isinstance(ocr, dict) else []
    occupied = set()
    cells = []
    box_index = 0
    for row_index, row in enumerate(parser.rows):
        column = 0
        for descriptor in row:
            while (row_index, column) in occupied: column += 1
            row_span, column_span = descriptor["rowSpan"], descriptor["columnSpan"]
            if row_span < 1 or column_span < 1: raise InvalidNormalizationError("span")
            for row_slot in range(row_index, row_index + row_span):
                for column_slot in range(column, column + column_span):
                    if (row_slot, column_slot) in occupied: raise InvalidNormalizationError("overlap")
                    occupied.add((row_slot, column_slot))
            text = descriptor["text"].strip()
            if box_index < len(texts) and isinstance(texts[box_index], str): text = texts[box_index]
            score = scores[box_index] if box_index < len(scores) else 0
            cells.append({"row": row_index, "column": column, "rowSpan": row_span,
                          "columnSpan": column_span, "bbox": boxes[box_index],
                          "text": text, "confidence": score})
            box_index += 1; column += column_span
    if "bbox" not in table and boxes:
        table["bbox"] = [min(box[0] for box in boxes), min(box[1] for box in boxes),
                         max(box[2] for box in boxes), max(box[3] for box in boxes)]
    if "confidence" not in table and scores:
        table["confidence"] = sum(_confidence(score) for score in scores) / len(scores)
    return cells


def normalize_page(page_number: int, raw: dict, output_dir: Path,
                   limits: Limits = DEFAULT_LIMITS) -> dict:
    if not isinstance(raw, dict) or not isinstance(page_number, int) or page_number < 1:
        raise InvalidNormalizationError("page")
    width, height = int(raw.get("width", 0)), int(raw.get("height", 0))
    if width < 1 or height < 1 or width > limits.max_dimension or height > limits.max_dimension:
        raise ResourceLimitError()
    if width * height > limits.max_page_pixels:
        raise ResourceLimitError()
    raw_blocks = raw.get("blocks", raw.get("parsing_res_list", []))
    raw_tables = raw.get("tables", [])
    raw_pp_tables = raw.get("table_res_list", [])
    raw_candidates = raw.get("tableCandidates", [])
    if not all(isinstance(item, list) for item in (raw_blocks, raw_tables, raw_pp_tables, raw_candidates)):
        raise InvalidNormalizationError("collections")
    if len(raw_blocks) > limits.max_blocks_per_page or \
            len(raw_tables) + len(raw_pp_tables) > limits.max_tables_per_page:
        raise ResourceLimitError()
    if len(raw_candidates) > limits.max_candidates_per_page:
        raise ResourceLimitError()
    raw_warnings = raw.get("warnings", [])
    if not isinstance(raw_warnings, list): raise InvalidNormalizationError("warnings")
    if len(raw_warnings) > limits.max_warnings_per_page: raise ResourceLimitError()

    blocks = []
    for raw_block in raw_blocks:
        block_type = BLOCK_TYPES.get(raw_block.get("type", raw_block.get("block_label")), "text")
        block = {"type": block_type,
                 "bbox": _bbox(raw_block.get("bbox", raw_block.get("block_bbox")), width, height),
                 "confidence": _confidence(raw_block.get("confidence", raw_block.get("block_score", 0)))}
        if block_type not in ("table", "seal", "signature", "figure"):
            block["text"] = _bounded_text(raw_block.get("text", raw_block.get("block_content", "")), limits)
        if raw_block.get("asset") is not None:
            block["asset"] = _relative_asset(raw_block["asset"])
        if raw_block.get("tableId") is not None:
            table_id = str(raw_block["tableId"])
            if not table_id or len(table_id) > 256: raise InvalidNormalizationError("table id")
            block["tableId"] = table_id
        blocks.append(block)
    blocks.sort(key=lambda block: (block["bbox"][1], block["bbox"][0], block["type"]))

    tables = [_normalize_table(table, width, height, limits, f"table-{page_number:03d}-{index:03d}")
              for index, table in enumerate(raw_tables, 1)]
    pp_candidates = [_normalize_table(table, width, height, limits,
                     f"pp-{page_number:03d}-{index:03d}")
                     for index, table in enumerate(raw_pp_tables, 1)]
    for candidate in pp_candidates: candidate["source"] = "pp-structure-v3"
    candidates = [_normalize_table(table, width, height, limits,
                  f"candidate-{page_number:03d}-{index:03d}")
                  for index, table in enumerate(raw_candidates, 1)]
    candidates = pp_candidates + candidates
    if len(candidates) > limits.max_candidates_per_page or (tables and candidates):
        raise ResourceLimitError()
    candidates.sort(key=lambda item: (SOURCE_ORDER[item["source"]], item["id"]))
    pp_ids = iter(candidate["id"] for candidate in candidates
                  if candidate["source"] == "pp-structure-v3")
    for block in blocks:
        if block["type"] == "table" and "tableId" not in block:
            try: block["tableId"] = next(pp_ids)
            except StopIteration: break
    rotation = int(raw.get("rotation", 0))
    if rotation not in (0, 90, 180, 270): raise InvalidNormalizationError("rotation")
    page = {"pageNumber": page_number, "width": width, "height": height,
            "rotation": rotation,
            "referenceImage": f"page-{page_number:03d}.png",
            "tableLike": bool(raw.get("tableLike", tables or candidates)),
            "blocks": blocks, "tables": tables,
            "warnings": [_bounded_text(item, limits) for item in raw_warnings],
            "elapsedMs": max(0, int(raw.get("elapsedMs", 0)))}
    if candidates:
        page["tableCandidates"] = candidates
    return page
