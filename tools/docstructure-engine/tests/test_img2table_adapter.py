import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from PIL import Image, ImageDraw

ENGINE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE_ROOT))

from flyingmouse_docstructure.img2table_adapter import detect_table_candidates


class Img2TableAdapterTests(unittest.TestCase):
    def test_32_percent_page_height_fake_img2table_yields_four_column_candidate(self):
        class Cell:
            def __init__(self, box): self.bbox = SimpleNamespace(x1=box[0], y1=box[1], x2=box[2], y2=box[3])
        width, height = 1240, 1754
        top, bottom = 500, 500 + round(height * .32)
        columns = [100, 360, 620, 880, 1140]
        rows = [top, top + 140, top + 280, bottom]
        content = {row: [Cell([columns[column], rows[row], columns[column + 1], rows[row + 1]])
                         for column in range(4)] for row in range(3)}
        table = SimpleNamespace(bbox=SimpleNamespace(x1=100, y1=top, x2=1140, y2=bottom),
                                content=content)
        document = mock.Mock(); document.extract_tables.return_value = [table]
        image_class = mock.Mock(return_value=document)
        fake_document = SimpleNamespace(Image=image_class)
        ocr = {"rec_boxes": [[110, top + 10, 350, top + 100]], "rec_texts": ["Paddle value"],
               "rec_scores": [.91]}
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.dict(sys.modules, {"img2table": SimpleNamespace(),
                                            "img2table.document": fake_document}):
            image_path = Path(tmp) / "page.png"
            Image.new("RGB", (width, height), "white").save(image_path)
            candidates = detect_table_candidates(image_path, 3, ocr)
        kwargs = document.extract_tables.call_args.kwargs
        self.assertEqual(kwargs["max_workers"], 1)
        self.assertIsNone(kwargs["ocr"])
        self.assertEqual(candidates[0]["source"], "img2table")
        self.assertEqual(candidates[0]["columnCount"], 4)
        self.assertEqual(candidates[0]["rowCount"], 3)
        self.assertEqual(candidates[0]["cells"][0]["text"], "Paddle value")
        self.assertEqual(candidates[0]["cells"][0]["confidence"], .91)

    def test_missing_img2table_returns_no_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "a4.png"
            width, height = 1240, 1754
            image = Image.new("RGB", (width, height), "white")
            draw = ImageDraw.Draw(image)
            top, bottom = 500, 500 + round(height * .32)
            left, right = 100, 1140
            for index in range(5):
                x = left + round((right - left) * index / 4)
                draw.line((x, top, x, bottom), fill="black", width=4)
            for index in range(5):
                y = top + round((bottom - top) * index / 4)
                draw.line((left, y, right, y), fill="black", width=4)
            image.save(image_path)
            with mock.patch.dict(sys.modules, {"img2table": None, "img2table.document": None}):
                candidates = detect_table_candidates(image_path, page_number=1)
        self.assertEqual(candidates, [])


if __name__ == "__main__":
    unittest.main()
