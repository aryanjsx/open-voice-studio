"""Feature-parity checks for the second performance pass; no model/network needed."""

import asyncio
import hashlib
import io
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import torch
from fastapi import UploadFile

import engine
import main
import pipeline
from media import ConversionCancelled


class EngineTests(unittest.TestCase):
    def test_checkpoint_filter_keeps_original_tensors_and_only_six_layers(self):
        state = {f"encoder.layers.{i}.weight": torch.tensor([i]) for i in range(24)}
        state["feature_extractor.weight"] = torch.tensor([99])
        kept = engine.encoder_state(state)
        self.assertEqual(len(kept), 7)
        self.assertIs(kept["encoder.layers.5.weight"], state["encoder.layers.5.weight"])
        self.assertIn("encoder.layers.23.weight", state)  # Do not mutate the source checkpoint.

    def test_unknown_vocoder_graph_preserves_full_context(self):
        model = SimpleNamespace(hifigan=SimpleNamespace())
        self.assertEqual(engine.vocoder_window(model, 16000, 32000, 151), (0, 151))

    def test_derived_window_retains_all_input_dependencies(self):
        # A tiny version of the same convolution graph validates index arithmetic
        # without downloading or allocating the trained network.
        class Block(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.convs1 = torch.nn.ModuleList([torch.nn.Conv1d(1, 1, 3, padding=d, dilation=d) for d in (1, 3, 5)])
                self.convs2 = torch.nn.ModuleList([torch.nn.Conv1d(1, 1, 3, padding=1) for _ in range(3)])

            def forward(self, x):
                for first, second in zip(self.convs1, self.convs2):
                    x = x + second(torch.tanh(first(x)))
                return x

        class Generator(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.conv_pre = torch.nn.Conv1d(1, 1, 7, padding=3)
                self.conv_post = torch.nn.Conv1d(1, 1, 7, padding=3)
                self.ups = torch.nn.ModuleList([torch.nn.ConvTranspose1d(1, 1, 2 * s, stride=s, padding=s // 2) for s in (10, 8, 2, 2)])
                self.resblocks = torch.nn.ModuleList([Block() for _ in range(4)])
                self.num_kernels = 1

            def forward(self, features):
                x = self.conv_pre(features)
                for up, block in zip(self.ups, self.resblocks):
                    x = block(up(x))
                return self.conv_post(x)

        torch.manual_seed(12)
        generator = Generator().eval()
        model = SimpleNamespace(hifigan=generator)
        features = torch.randn(1, 1, 200)
        with torch.inference_mode():
            full = generator(features)
            for start, size in ((0, 8000), (16003, 16007), (60000, 4000)):
                first, last = engine.vocoder_window(model, start, size, features.shape[-1])
                window = generator(features[:, :, first:last])
                actual = window[:, :, start - first * 320:start - first * 320 + size]
                torch.testing.assert_close(actual, full[:, :, start:start + size], atol=2e-6, rtol=2e-5)
                self.assertLess(last - first, features.shape[-1])


class ReuseTests(unittest.TestCase):
    def test_same_export_is_linked_but_different_format_is_not(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old, new, other = (root / name for name in ("old", "new", "other"))
            for folder in (old, new, other):
                folder.mkdir()
            for name in ("dub_full.wav", "dub_preview.wav", "preview.mp4", "output.mp4"):
                (old / name).write_bytes(name.encode())
            previous = {"id": "old", "status": "done", "source_hash": "same", "voice": "male",
                        "quality": "studio", "duration": 5, "output_kind": "video",
                        "output_ext": ".mp4", "output": "output.mp4"}
            with patch.object(main, "STORAGE", root), patch.object(main, "JOBS", {"old": previous}):
                reused = main.reuse_converted_audio({**previous, "id": "new"}, new)
                self.assertTrue(reused["export_cache_hit"])
                self.assertTrue(reused["preview_cache_hit"])
                self.assertEqual((new / "output.mp4").read_bytes(), b"output.mp4")
                other_format = {**previous, "id": "other", "output_kind": "audio", "output_ext": ".mp3"}
                self.assertNotIn("export_cache_hit", main.reuse_converted_audio(other_format, other))
                self.assertFalse((other / "output.mp3").exists())

    def test_preview_reuses_only_video_and_maps_new_voice_audio(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache = root / f"{pipeline.CACHE_VERSION}-hash"
            cache.mkdir()
            (cache / "preview-video-v1.mp4").write_bytes(b"old preview")
            folder = root / "job"
            folder.mkdir()
            with patch.object(pipeline, "CACHE", root), patch.object(main, "ffmpeg") as ffmpeg:
                hit = main.build_preview({"source_hash": "hash"}, root / "source.mp4", folder, threading.Event())
            self.assertTrue(hit)
            args = ffmpeg.call_args.args[0]
            self.assertIn(str(folder / "dub_preview.wav"), args)
            self.assertIn("0:v:0", args)
            self.assertIn("1:a:0", args)
            self.assertEqual(args[args.index("-c:v") + 1], "copy")

    def test_metrics_and_progress_use_one_durable_write(self):
        with patch.object(main, "JOBS", {"id": {"id": "id", "status": "processing_full"}}), patch.object(main, "_save") as save:
            main._update("id", persist=False, duration=5, processed_seconds=3)
            save.assert_not_called()
            main._update("id", progress=50)
            save.assert_called_once()
            self.assertEqual(save.call_args.args[0]["processed_seconds"], 3)


class UploadTests(unittest.IsolatedAsyncioTestCase):
    async def test_threaded_upload_preserves_bytes_and_hash(self):
        data = b"voice upload" * 1000
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source.wav"
            upload = UploadFile(io.BytesIO(data), filename="sample.wav")
            digest, size = await main.store_upload(upload, path)
            self.assertEqual((digest, size), (hashlib.sha256(data).hexdigest(), len(data)))
            self.assertEqual(path.read_bytes(), data)

    async def test_size_limits_and_empty_upload_still_reject(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source.wav"
            for data, status in ((b"", 400), (b"12345", 413)):
                with patch.object(main, "MAX_UPLOAD_BYTES", 4), self.assertRaises(main.HTTPException) as error:
                    await main.store_upload(UploadFile(io.BytesIO(data)), path)
                self.assertEqual(error.exception.status_code, status)

    async def test_cancel_joins_upload_worker_before_cleanup(self):
        entered, stopped = threading.Event(), threading.Event()

        def copy(_stream, _path, cancel):
            entered.set()
            self.assertTrue(cancel.wait(timeout=2))
            stopped.set()
            raise ConversionCancelled()

        loop = asyncio.get_running_loop()
        with patch.object(main, "_store_upload", side_effect=copy), patch.object(loop, "call_exception_handler") as errors:
            task = asyncio.create_task(main.store_upload(UploadFile(io.BytesIO(b"test")), Path("unused.wav")))
            self.assertTrue(await asyncio.to_thread(entered.wait, 2))
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertTrue(stopped.is_set())
            errors.assert_not_called()


if __name__ == "__main__":
    unittest.main()