#!/usr/bin/env python3

import importlib.util
from pathlib import Path


script_path = Path(__file__).parents[1] / "scripts" / "run-ppocr-menu-pilot.py"
spec = importlib.util.spec_from_file_location("run_ppocr_menu_pilot", script_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeArray:
    def tolist(self):
        return [[1, 2], [3, 4]]


assert module.jsonable(FakeArray()) == [[1, 2], [3, 4]]
assert module.result_payload({"res": {"rec_texts": ["Tea"]}})["rec_texts"] == ["Tea"]
print("test-run-ppocr-menu-pilot: ok")
