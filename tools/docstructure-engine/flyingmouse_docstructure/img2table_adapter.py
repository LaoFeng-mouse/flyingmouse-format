"""Bounded table-only second opinion. No workbook output is supported."""

from pathlib import Path

from .normalize import ResourceLimitError

MAX_CELLS = 20_000
MAX_OCR_TOKENS = 20_000


def _ocr_for_box(box: list[int], ocr_result: dict | None) -> tuple[str, float]:
    if not isinstance(ocr_result, dict): return "", 0.75
    boxes = ocr_result.get("rec_boxes", [])
    texts = ocr_result.get("rec_texts", [])
    scores = ocr_result.get("rec_scores", [])
    if not isinstance(boxes, list) or len(boxes) > MAX_OCR_TOKENS: raise ResourceLimitError()
    selected = []
    for index, token in enumerate(boxes):
        if not isinstance(token, (list, tuple)) or len(token) != 4: continue
        center_x, center_y = (token[0] + token[2]) / 2, (token[1] + token[3]) / 2
        if box[0] <= center_x <= box[2] and box[1] <= center_y <= box[3]:
            text = texts[index] if index < len(texts) and isinstance(texts[index], str) else ""
            try: score = float(scores[index]) if index < len(scores) else 0.0
            except (TypeError, ValueError): score = 0.0
            selected.append((text, max(0.0, min(1.0, score))))
    if not selected: return "", 0.75
    return " ".join(text for text, _ in selected).strip(), sum(score for _, score in selected) / len(selected)


def _from_img2table(image_path: Path, page_number: int, ocr_result: dict | None) -> list[dict] | None:
    try:
        from img2table.document import Image as Img2TableImage
    except (ImportError, ModuleNotFoundError):
        return None
    document = Img2TableImage(str(image_path), detect_rotation=False)
    tables = document.extract_tables(ocr=None, implicit_rows=False, implicit_columns=False,
                                     borderless_tables=False, min_confidence=50, max_workers=1)
    candidates = []
    for table_index, table in enumerate(tables[:2], 1):
        rows = list(table.content.values())
        column_count = max((len(row) for row in rows), default=0)
        if not rows or not column_count: continue
        if len(rows) * column_count > MAX_CELLS: raise ResourceLimitError()
        grouped = {}
        for row_index, row in enumerate(rows):
            for column_index, cell in enumerate(row):
                box = [round(cell.bbox.x1), round(cell.bbox.y1),
                       round(cell.bbox.x2), round(cell.bbox.y2)]
                grouped.setdefault(tuple(box), []).append((row_index, column_index))
        cells = []
        for box_tuple, positions in sorted(grouped.items(), key=lambda item: min(item[1])):
            box = list(box_tuple)
            row_values = [item[0] for item in positions]
            column_values = [item[1] for item in positions]
            text, confidence = _ocr_for_box(box, ocr_result)
            cells.append({"row": min(row_values), "column": min(column_values),
                          "rowSpan": max(row_values) - min(row_values) + 1,
                          "columnSpan": max(column_values) - min(column_values) + 1,
                          "bbox": box, "text": text, "confidence": confidence})
        table_box = [round(table.bbox.x1), round(table.bbox.y1),
                     round(table.bbox.x2), round(table.bbox.y2)]
        confidence = sum(cell["confidence"] for cell in cells) / len(cells)
        candidates.append({"source": "img2table",
            "id": f"img2table-{page_number:03d}-{table_index:03d}",
            "rowCount": len(rows), "columnCount": column_count,
            "bbox": table_box, "confidence": confidence, "cells": cells})
    return candidates


def detect_table_candidates(image_path: Path, page_number: int,
                            ocr_result: dict | None = None) -> list[dict]:
    extracted = _from_img2table(image_path, page_number, ocr_result)
    return extracted or []
