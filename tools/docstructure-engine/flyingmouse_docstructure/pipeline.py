"""Local-only PP-StructureV3 construction and bounded PDF parsing."""

import json
import os
import shutil
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from .normalize import DEFAULT_LIMITS, InvalidNormalizationError, ResourceLimitError, normalize_page


class MissingModelError(Exception): pass
class ParseError(Exception): pass
class InvalidOutputError(Exception): pass


REQUIRED_MODELS = ("layout_detection", "doc_orientation_classification", "doc_unwarping",
                   "text_detection", "text_recognition", "table_classification",
                   "wired_table_structure", "wireless_table_structure",
                   "wired_table_cells", "wireless_table_cells",
                   "seal_text_detection")

MODEL_ARGUMENTS = {
    "layout_detection": "layout_detection_model_dir",
    "doc_orientation_classification": "doc_orientation_classify_model_dir",
    "doc_unwarping": "doc_unwarping_model_dir",
    "text_detection": "text_detection_model_dir",
    "text_recognition": "text_recognition_model_dir",
    "table_classification": "table_classification_model_dir",
    "wired_table_structure": "wired_table_structure_recognition_model_dir",
    "wireless_table_structure": "wireless_table_structure_recognition_model_dir",
    "wired_table_cells": "wired_table_cells_detection_model_dir",
    "wireless_table_cells": "wireless_table_cells_detection_model_dir",
    "seal_text_detection": "seal_text_detection_model_dir",
}


def _model(module_name: str, model_name: str, path: Path, **settings) -> dict:
    return {"module_name": module_name, "model_name": model_name,
            "model_dir": str(path), "batch_size": 1, **settings}


def _general_ocr_config(models: dict[str, Path]) -> dict:
    return {"pipeline_name": "OCR", "batch_size": 1, "text_type": "general",
            "use_doc_preprocessor": False, "use_textline_orientation": False,
            "SubModules": {
                "TextDetection": _model("text_detection", "PP-OCRv5_server_det",
                                       models["text_detection"], limit_side_len=736,
                                       limit_type="min", max_side_limit=4000, thresh=.3,
                                       box_thresh=.6, unclip_ratio=1.5),
                "TextRecognition": _model("text_recognition", "PP-OCRv5_server_rec",
                                          models["text_recognition"], score_thresh=0.0)}}


def _local_paddlex_config(models: dict[str, Path]) -> dict:
    ocr = _general_ocr_config(models)
    return {"pipeline_name": "PP-StructureV3", "batch_size": 1,
            "use_doc_preprocessor": True, "use_seal_recognition": True,
            "use_table_recognition": True, "use_formula_recognition": False,
            "use_chart_recognition": False, "use_region_detection": False,
            "SubModules": {"LayoutDetection": _model(
                "layout_detection", "PP-DocLayout_plus-L", models["layout_detection"])},
            "SubPipelines": {
                "DocPreprocessor": {"pipeline_name": "doc_preprocessor", "batch_size": 1,
                    "use_doc_orientation_classify": True, "use_doc_unwarping": True,
                    "SubModules": {
                        "DocOrientationClassify": _model("doc_text_orientation",
                            "PP-LCNet_x1_0_doc_ori", models["doc_orientation_classification"]),
                        "DocUnwarping": _model("image_unwarping", "UVDoc",
                                               models["doc_unwarping"])}},
                "GeneralOCR": ocr,
                "TableRecognition": {"pipeline_name": "table_recognition_v2", "batch_size": 1,
                    "use_layout_detection": False, "use_doc_preprocessor": False,
                    "use_ocr_model": False, "SubModules": {
                        "TableClassification": _model("table_classification",
                            "PP-LCNet_x1_0_table_cls", models["table_classification"]),
                        "WiredTableStructureRecognition": _model("table_structure_recognition",
                            "SLANeXt_wired", models["wired_table_structure"]),
                        "WirelessTableStructureRecognition": _model("table_structure_recognition",
                            "SLANet_plus", models["wireless_table_structure"]),
                        "WiredTableCellsDetection": _model("table_cells_detection",
                            "RT-DETR-L_wired_table_cell_det", models["wired_table_cells"]),
                        "WirelessTableCellsDetection": _model("table_cells_detection",
                            "RT-DETR-L_wireless_table_cell_det", models["wireless_table_cells"]),
                        "TableOrientationClassify": _model("doc_text_orientation",
                            "PP-LCNet_x1_0_doc_ori", models["doc_orientation_classification"])},
                    "SubPipelines": {"GeneralOCR": _general_ocr_config(models)}},
                "SealRecognition": {"pipeline_name": "seal_recognition", "batch_size": 1,
                    "use_layout_detection": False, "use_doc_preprocessor": False,
                    "SubPipelines": {"SealOCR": {"pipeline_name": "OCR", "batch_size": 1,
                        "text_type": "seal", "use_doc_preprocessor": False,
                        "use_textline_orientation": False, "SubModules": {
                            "TextDetection": _model("seal_text_detection",
                                "PP-OCRv4_server_seal_det", models["seal_text_detection"],
                                limit_side_len=736, limit_type="min", max_side_limit=4000,
                                thresh=.2, box_thresh=.6, unclip_ratio=.5),
                            "TextRecognition": _model("text_recognition", "PP-OCRv5_server_rec",
                                models["text_recognition"], score_thresh=0.0)}}}}}}


def _is_reparse(path: Path) -> bool:
    info = path.lstat()
    return path.is_symlink() or bool(getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _contained(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return candidate != root
    except ValueError:
        return False


def _is_ascii(value: str) -> bool:
    try:
        value.encode("ascii")
        return True
    except UnicodeEncodeError:
        return False


def _ascii_staging_root() -> Path:
    # Paddle's native inference runtime (paddle_inference) opens model files through
    # the ANSI code page and cannot resolve paths containing non-ASCII characters
    # (verified: `paddle::inference::IsFileExists` returns false for a valid
    # `C:\...\飞鼠格式\...` model path). Prefer a temp root that is itself ASCII.
    for candidate in (os.environ.get("TEMP"), os.environ.get("TMP"),
                      os.environ.get("LOCALAPPDATA"), tempfile.gettempdir()):
        if candidate and _is_ascii(candidate):
            return Path(candidate)
    raise MissingModelError()


def _link_or_copy(source: Path, target: Path) -> None:
    if source.is_dir():
        target.mkdir()
        for child in source.iterdir():
            _link_or_copy(child, target / child.name)
        return
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)


def _stage_ascii_models(models: dict[str, Path]) -> tuple[dict[str, Path], Path | None]:
    if all(_is_ascii(str(path)) for path in models.values()):
        return models, None
    staging = Path(tempfile.mkdtemp(prefix="flyingmouse-models-", dir=str(_ascii_staging_root())))
    staged: dict[str, Path] = {}
    for name, source in models.items():
        target = staging / name
        try:
            _link_or_copy(source, target)
        except OSError as error:
            shutil.rmtree(staging, ignore_errors=True)
            raise MissingModelError() from error
        staged[name] = target
    return staged, staging


def _resolve_models(models_root: Path) -> dict[str, Path]:
    try:
        root = models_root.resolve(strict=True)
    except OSError as error:
        raise MissingModelError() from error
    if not root.is_dir() or _is_reparse(models_root):
        raise MissingModelError()
    mapping = {name: name for name in REQUIRED_MODELS}
    map_file = root / "model-map.json"
    if map_file.exists():
        try:
            supplied = json.loads(map_file.read_text("utf-8"))
            mapping.update(supplied)
        except Exception as error:
            raise MissingModelError() from error
    resolved = {}
    for name in REQUIRED_MODELS:
        raw = mapping.get(name)
        if not isinstance(raw, str) or urlparse(raw).scheme or Path(raw).is_absolute():
            raise MissingModelError()
        lexical = root.joinpath(*raw.replace("\\", "/").split("/"))
        try:
            target = lexical.resolve(strict=True)
        except OSError as error:
            raise MissingModelError() from error
        if not target.is_dir() or not _contained(root, target) or _is_reparse(lexical):
            raise MissingModelError()
        resolved[name] = target
    return resolved


@dataclass
class LocalPipeline:
    backend: object
    config_path: Path
    staging_root: Path | None = None

    def close(self) -> None:
        try: self.config_path.unlink(missing_ok=True)
        finally:
            try: self.config_path.parent.rmdir()
            except OSError: pass
        if self.staging_root is not None:
            shutil.rmtree(self.staging_root, ignore_errors=True)
            self.staging_root = None

    def parse(self, input_path: Path, output_dir: Path) -> list[dict]:
        # PyMuPDF is delayed until a real conversion is requested.
        try:
            import fitz
        except Exception as error:
            raise ParseError() from error
        pages = []
        total_pixels = 0
        try:
            document = fitz.open(str(input_path))
            if document.page_count < 1 or document.page_count > DEFAULT_LIMITS.max_pages:
                raise ResourceLimitError()
            for page_index in range(document.page_count):
                page = document.load_page(page_index)
                # Inspect geometry before raster allocation.
                rectangle = page.rect
                estimated_width = round(rectangle.width * 2)
                estimated_height = round(rectangle.height * 2)
                if (estimated_width > DEFAULT_LIMITS.max_dimension or
                        estimated_height > DEFAULT_LIMITS.max_dimension or
                        estimated_width * estimated_height > DEFAULT_LIMITS.max_page_pixels):
                    raise ResourceLimitError()
                total_pixels += estimated_width * estimated_height
                if total_pixels > DEFAULT_LIMITS.max_total_pixels:
                    raise ResourceLimitError()
                pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                reference = output_dir / f"page-{page_index + 1:03d}.png"
                pixmap.save(str(reference))
                _enforce_output_budget(output_dir)
                results = list(self.backend.predict(input=str(reference)))
                raw = results[0].json if results else {}
                if callable(raw): raw = raw()
                raw = dict(raw or {})
                # PaddleX JsonMixin wraps the parsed page under a "res" key
                # ({"res": {"parsing_res_list": ..., "table_res_list": ...}}).
                nested = raw.get("res")
                if isinstance(nested, dict):
                    raw = nested
                raw.update(width=pixmap.width, height=pixmap.height,
                           rotation=page.rotation)
                materialize_assets(raw, reference, output_dir, page_index + 1)
                attach_second_opinion(raw, reference, page_index + 1)
                pages.append(normalize_page(page_index + 1, raw, output_dir))
                validate_manifest_limits(pages)
                _enforce_output_budget(output_dir)
            return pages
        except ResourceLimitError:
            raise
        except (InvalidNormalizationError, ValueError, TypeError) as error:
            raise InvalidOutputError() from error
        except OSError as error:
            raise ParseError() from error
        finally:
            if "document" in locals(): document.close()


def _enforce_output_budget(output_dir: Path) -> None:
    total = 0
    for child in output_dir.iterdir():
        if child.is_symlink() or not child.is_file(): raise InvalidOutputError()
        total += child.stat().st_size
        if total > DEFAULT_LIMITS.max_output_bytes: raise ResourceLimitError()


def validate_manifest_limits(pages: list[dict]) -> None:
    if len(pages) > DEFAULT_LIMITS.max_pages: raise ResourceLimitError()
    total_pixels = total_blocks = total_tables = total_cells = 0
    for page in pages:
        width, height = page.get("width", 0), page.get("height", 0)
        total_pixels += width * height
        blocks = page.get("blocks", [])
        tables = page.get("tables", [])
        candidates = page.get("tableCandidates", [])
        if len(blocks) > DEFAULT_LIMITS.max_blocks_per_page or \
                len(tables) > DEFAULT_LIMITS.max_tables_per_page or \
                len(candidates) > DEFAULT_LIMITS.max_candidates_per_page:
            raise ResourceLimitError()
        total_blocks += len(blocks)
        total_tables += len(tables) + len(candidates)
        for table in [*tables, *candidates]:
            cells = table.get("cells", [])
            if len(cells) > DEFAULT_LIMITS.max_cells_per_table: raise ResourceLimitError()
            total_cells += len(cells)
        if total_pixels > DEFAULT_LIMITS.max_total_pixels or total_blocks > 50_000 or \
                total_tables > 1_000 or total_cells > 200_000:
            raise ResourceLimitError()


def materialize_assets(raw: dict, reference: Path, output_dir: Path, page_number: int) -> None:
    from PIL import Image

    blocks = raw.get("parsing_res_list", raw.get("blocks", []))
    if not isinstance(blocks, list): raise InvalidOutputError()
    with Image.open(reference) as image:
        width, height = image.size
        for index, block in enumerate(blocks, 1):
            label = block.get("block_label", block.get("type"))
            normalized = {"image": "figure"}.get(label, label)
            if normalized not in ("seal", "signature", "figure"): continue
            box_key = "block_bbox" if "block_bbox" in block else "bbox"
            box = block.get(box_key)
            if not isinstance(box, (list, tuple)) or len(box) != 4: raise InvalidOutputError()
            clipped = [max(0, min(width, round(box[0]))), max(0, min(height, round(box[1]))),
                       max(0, min(width, round(box[2]))), max(0, min(height, round(box[3])))]
            if clipped[2] <= clipped[0] or clipped[3] <= clipped[1]: raise InvalidOutputError()
            block[box_key] = clipped
            asset = f"page-{page_number:03d}-{normalized}-{index:03d}.png"
            target = (output_dir / asset).resolve()
            root = output_dir.resolve()
            if not _contained(root, target): raise InvalidOutputError()
            image.crop(tuple(clipped)).save(target, format="PNG")
            block["asset"] = asset
            _enforce_output_budget(output_dir)


def attach_second_opinion(raw: dict, reference: Path, page_number: int) -> None:
    tables = raw.get("table_res_list", raw.get("tables", []))
    if not isinstance(tables, list): raise InvalidOutputError()
    if tables: return
    blocks = raw.get("parsing_res_list", raw.get("blocks", []))
    if not isinstance(blocks, list): raise InvalidOutputError()
    layout = raw.get("layout_det_res", {})
    if not isinstance(layout, dict): raise InvalidOutputError()
    layout_boxes = layout.get("boxes", [])
    if not isinstance(layout_boxes, list): raise InvalidOutputError()

    def label(item: object) -> object:
        if not isinstance(item, dict): return None
        return item.get("label", item.get("block_label", item.get("type")))

    table_like = raw.get("tableLike") is True or any(
        label(block) == "table"
        for block in [*blocks, *layout_boxes]
    )
    if not table_like: return
    from .img2table_adapter import detect_table_candidates
    candidates = detect_table_candidates(reference, page_number, raw.get("overall_ocr_res"))
    if candidates:
        raw["tableLike"] = True
        raw["tableCandidates"] = candidates


def build_pipeline(models_root: Path, language: str) -> LocalPipeline:
    models = _resolve_models(Path(models_root))
    models, staging_root = _stage_ascii_models(models)
    config = _local_paddlex_config(models)
    config_dir = Path(tempfile.mkdtemp(prefix="flyingmouse-paddlex-"))
    config_path = config_dir / "paddlex-local.yaml"
    config_path.write_text(json.dumps(config, ensure_ascii=True, sort_keys=True), "utf-8")
    try:
        # Import only after every local model has passed canonical containment checks.
        from paddleocr import PPStructureV3
        os.environ["OMP_NUM_THREADS"] = "1"
        os.environ["MKL_NUM_THREADS"] = "1"
        model_arguments = {MODEL_ARGUMENTS[name]: str(path) for name, path in models.items()}
        model_arguments["table_orientation_classify_model_dir"] = str(
            models["doc_orientation_classification"])
        model_arguments["seal_text_recognition_model_dir"] = str(models["text_recognition"])
        backend = PPStructureV3(paddlex_config=str(config_path), device="cpu", lang=language,
                                use_formula_recognition=False, use_seal_recognition=True,
                                use_doc_orientation_classify=True, use_doc_unwarping=True,
                                use_textline_orientation=False, use_chart_recognition=False,
                                use_region_detection=False, cpu_threads=1, **model_arguments)
    except Exception:
        config_path.unlink(missing_ok=True); config_dir.rmdir()
        if staging_root is not None:
            shutil.rmtree(staging_root, ignore_errors=True)
        raise
    return LocalPipeline(backend, config_path, staging_root)
