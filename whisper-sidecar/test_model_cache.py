import importlib
import sys
import types
import unittest
from pathlib import Path


class FakeWhisperModel:
    def __init__(self, model_name, **kwargs):
        self.model_name = model_name
        self.closed = False

    def close(self):
        self.closed = True


class ModelCacheTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(Path(__file__).parent))
        fake_fastapi = types.ModuleType("fastapi")

        class FakeFastAPI:
            def __init__(self, *args, **kwargs):
                pass

            def get(self, *args, **kwargs):
                return lambda func: func

            def post(self, *args, **kwargs):
                return lambda func: func

        fake_fastapi.FastAPI = FakeFastAPI
        fake_fastapi.File = lambda *args, **kwargs: None
        fake_fastapi.Form = lambda *args, **kwargs: None
        fake_fastapi.HTTPException = Exception
        fake_fastapi.UploadFile = object
        sys.modules["fastapi"] = fake_fastapi

        fake_faster_whisper = types.ModuleType("faster_whisper")
        fake_faster_whisper.WhisperModel = FakeWhisperModel
        sys.modules["faster_whisper"] = fake_faster_whisper
        sys.modules.pop("app", None)
        self.app = importlib.import_module("app")
        self.app._models.clear()

    def tearDown(self):
        self.app._models.clear()

    def test_loading_a_different_model_unloads_the_prior_model(self):
        first = self.app.get_model("base")
        second = self.app.get_model("large-v3-turbo")

        self.assertTrue(first.closed)
        self.assertFalse(second.closed)
        self.assertNotIn("base", self.app._models)
        self.assertIs(self.app._models["large-v3-turbo"], second)


if __name__ == "__main__":
    unittest.main()
