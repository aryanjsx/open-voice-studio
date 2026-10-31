"""Lightweight regressions. No model downloads or network calls required."""

import asyncio
import tempfile
import threading
import unittest
import wave
from collections import OrderedDict
from pathlib import Path
from unittest.mock import AsyncMock, patch

import numpy as np
import torch
import torch.nn.functional as F

import main
import pipeline
from media import ConversionCancelled, SR, ffmpeg, write_wav
from voices import VOICES, synthesize


class MatchingTests(unittest.TestCase):
    def test_exact_cosine_neighbors_keep_original_synthesis_features(self):
        rng = torch.Generator().manual_seed(7)
        reference = torch.randn(97, 32, generator=rng) * 3
        query = torch.randn(513, 32, generator=rng)
        index = pipeline.MatchingIndex(reference, F.normalize(reference, dim=-1).T.contiguous())
        expected_neighbors = torch.cdist(F.normalize(query, dim=-1), F.normalize(reference, dim=-1)).topk(4, largest=False).indices
        expected = reference[expected_neighbors].mean(dim=1)
        actual = pipeline.match_features(query, index)
        torch.testing.assert_close(actual, expected)

    def test_zero_search_vectors_do_not_produce_nan(self):
        reference = torch.zeros(8, 32)
        index = pipeline.MatchingIndex(reference, F.normalize(reference, dim=-1).T.contiguous())
        self.assertTrue(torch.isfinite(pipeline.match_features(torch.zeros(3, 32), index)).all())

    def test_fast_index_is_bounded_and_studio_preserves_all_frames(self):
        reference = torch.randn(6500, 16)
        with patch.object(pipeline, "_indices", OrderedDict()), patch.object(pipeline, "DEVICE", "cpu"), \
                patch.object(pipeline, "_matching_set", return_value=reference):
            fast = pipeline._index("male", "fast", lambda *_: None, None)
            studio = pipeline._index("male", "studio", lambda *_: None, None)
            self.assertEqual(len(fast.features), 6000)
            self.assertEqual(len(studio.features), len(reference))
            self.assertIs(pipeline._index("male", "fast", lambda *_: None, None), fast)
            pipeline._index("female", "studio", lambda *_: None, None)
            self.assertEqual(len(pipeline._indices), 2)


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="voice-tests-")
        self.root = Path(self.temporary.name)
        self.cache = self.root / "cache"
        self.cache.mkdir()
        self.cache_patch = patch.object(pipeline, "CACHE", self.cache)
        self.cache_patch.start()

    def tearDown(self):
        self.cache_patch.stop()
        self.temporary.cleanup()

    def convert_silence(self, seconds=0.1, cancel=None, on_preview=lambda: None):
        source = self.root / "source.wav"
        write_wav(source, np.zeros(int(seconds * SR), dtype=np.float32))
        return pipeline.convert(source, self.root / "preview.wav", self.root / "full.wav",
                                "male", 5, lambda *_: None, on_preview, cancel=cancel)

    def test_silence_preserves_length_without_loading_model_and_reuses_decode(self):
        with patch.object(pipeline, "_model") as model:
            first = self.convert_silence()
            second = self.convert_silence()
            model.assert_not_called()
        self.assertFalse(first["source_cache_hit"])
        self.assertTrue(second["source_cache_hit"])
        with wave.open(str(self.root / "full.wav")) as audio:
            self.assertEqual(audio.getnframes(), int(0.1 * SR))
            self.assertEqual(audio.readframes(audio.getnframes()), bytes(int(0.1 * SR) * 2))

    def test_cancel_between_chunks_closes_output_and_memory_map(self):
        cancel = threading.Event()
        with self.assertRaises(ConversionCancelled):
            self.convert_silence(6, cancel, cancel.set)
        # Windows cannot remove a still-mapped input or open output; both must close.
        (self.root / "full.wav").unlink()
        for raw in self.cache.glob("*/audio.f32"):
            raw.unlink()

    def test_cancel_before_ffmpeg_never_launches_subprocess(self):
        cancel = threading.Event()
        cancel.set()
        with patch("media.subprocess.Popen") as popen, self.assertRaises(ConversionCancelled):
            ffmpeg(["-version"], cancel)
        popen.assert_not_called()

    def test_cache_budget_can_evict_a_single_oversized_source(self):
        folder = self.cache / "old-source"
        folder.mkdir()
        (folder / "audio.f32").write_bytes(bytes(32))
        with patch.object(pipeline, "MAX_CACHE_BYTES", 16):
            pipeline.cleanup_cache()
        self.assertFalse(folder.exists())


class ReferenceCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_stops_inflight_reference_request_without_retry(self):
        cancel = threading.Event()

        async def pending_request(_destination):
            await asyncio.Future()

        with patch("voices.edge_tts.Communicate") as communicate:
            communicate.return_value.save = AsyncMock(side_effect=pending_request)
            asyncio.get_running_loop().call_later(0.01, cancel.set)
            with self.assertRaises(ConversionCancelled):
                await synthesize("test", "test-voice", Path("unused.mp3"), cancel)
            communicate.assert_called_once()


class JobTests(unittest.TestCase):
    def test_format_change_reuses_audio_but_different_voice_does_not(self):
        with tempfile.TemporaryDirectory(prefix="voice-jobs-") as temporary:
            root = Path(temporary)
            (root / "old").mkdir()
            destination = root / "new"
            destination.mkdir()
            for name in ("dub_full.wav", "dub_preview.wav"):
                (root / "old" / name).write_bytes(b"test audio")
            previous = {"id": "old", "status": "done", "source_hash": "same", "voice": "male",
                        "quality": "studio", "duration": 5}
            current = {**previous, "id": "new", "status": "queued"}
            with patch.object(main, "STORAGE", root), patch.object(main, "JOBS", {"old": previous}):
                self.assertIsNone(main.reuse_converted_audio({**current, "voice": "female"}, destination))
                result = main.reuse_converted_audio(current, destination)
                self.assertTrue(result["conversion_cache_hit"])
                self.assertEqual((destination / "dub_full.wav").read_bytes(), b"test audio")

    def test_active_job_deletion_is_rejected(self):
        job_id = "a" * 32
        with patch.object(main, "JOBS", {job_id: {"id": job_id, "status": "processing_full"}}):
            with self.assertRaises(main.HTTPException) as error:
                main.delete_job(job_id)
            self.assertEqual(error.exception.status_code, 409)

    def test_eight_distinct_primary_reference_voices(self):
        self.assertEqual(len(VOICES), 8)
        self.assertEqual(len({voice.speakers[0] for voice in VOICES.values()}), 8)


if __name__ == "__main__":
    unittest.main()