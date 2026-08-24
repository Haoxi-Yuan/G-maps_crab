#!/usr/bin/env python3

import importlib.util
from pathlib import Path


script_path = Path(__file__).parents[1] / "scripts" / "build-menu-ocr-crops.py"
spec = importlib.util.spec_from_file_location("build_menu_ocr_crops", script_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

assert module.is_price_anchor("$2.50")
assert module.is_price_anchor("SGD 12.90")
assert module.is_price_anchor("15.00")
assert not module.is_price_anchor("8647 3760")
assert not module.is_price_anchor("K3")
assert module.starts(1000, 1800, 0.15) == [0]
assert module.starts(3000, 1800, 0.15) == [0, 1200]
assert module.starts(3335, 1800, 0.15) == [0, 1535]
assert module.merge_regions([(0, 0, 100, 100), (90, 90, 200, 200)]) == [(0, 0, 200, 200)]
print("test-build-menu-ocr-crops: ok")
