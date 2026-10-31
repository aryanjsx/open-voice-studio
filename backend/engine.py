"""Inference-only optimizations that retain the pretrained model's mathematics."""

import importlib
import logging
import math
from pathlib import Path

import torch

logger = logging.getLogger(__name__)
ENCODER_LAYERS = 6
WAVLM_URL = "https://github.com/bshall/knn-vc/releases/download/v0.1/WavLM-Large.pt"


def encoder_state(state: dict) -> dict:
    """Keep the same trained tensors, without ever constructing unused layers."""
    return {key: value for key, value in state.items()
            if not key.startswith("encoder.layers.") or int(key.split(".")[2]) < ENCODER_LAYERS}


def _compact_model(device: str):
    # This trusted Hub entry also makes the installed upstream classes importable.
    vocoder, config = torch.hub.load("bshall/knn-vc", "hifigan_wavlm", trust_repo=True,
                                    pretrained=True, prematched=True, device=device)
    checkpoint_path = Path(torch.hub.get_dir()) / "checkpoints" / "WavLM-Large.pt"
    if checkpoint_path.exists():
        try:
            checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True, mmap=True)
        except (RuntimeError, ValueError):
            # Older checkpoint serialization may not support memory mapping.
            checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    else:
        checkpoint = torch.hub.load_state_dict_from_url(WAVLM_URL, map_location="cpu", weights_only=True)
    wavlm = importlib.import_module("wavlm.WavLM")
    encoder_config = wavlm.WavLMConfig(checkpoint["cfg"])
    encoder_config.encoder_layers = ENCODER_LAYERS
    # Upstream initializers copy tensors to CPU, so a meta-device constructor is
    # not compatible. Construct ONLY six layers, then attach trained weights.
    encoder = wavlm.WavLM(encoder_config)
    encoder.load_state_dict(encoder_state(checkpoint["model"]), strict=True, assign=True)
    encoder.to(device).eval()
    matcher = importlib.import_module("matcher")
    return matcher.KNeighborsVC(encoder, vocoder, config, device=device)


def load_model(device: str):
    try:
        model = _compact_model(device)
    except Exception:
        # A future Hub/checkpoint version must not make existing conversion fail.
        logger.warning("Compact model loading unavailable; using compatible loader.", exc_info=True)
        model = torch.hub.load("bshall/knn-vc", "knn_vc", prematched=True,
                               trust_repo=True, pretrained=True, device=device)
        model.wavlm.encoder.layers = torch.nn.ModuleList(list(model.wavlm.encoder.layers)[:ENCODER_LAYERS])
    # These weights are fixed in eval mode. Compute weight normalization once,
    # rather than rebuilding the positional convolution weights for every chunk.
    position = model.wavlm.encoder.pos_conv[0]
    if hasattr(position, "weight_g") and hasattr(position, "weight_v"):
        torch.nn.utils.remove_weight_norm(position)
    return model.requires_grad_(False).eval()


def _conv_interval(layer: torch.nn.Conv1d, lo: int, hi: int) -> tuple[int, int]:
    """Input indices needed for an inclusive output interval of a convolution."""
    if layer.stride != (1,) or layer.padding_mode != "zeros":
        raise ValueError("Unrecognized vocoder convolution")
    padding = layer.padding[0]
    reach = layer.dilation[0] * (layer.kernel_size[0] - 1)
    if padding * 2 != reach:
        raise ValueError("Unrecognized vocoder padding")
    return lo - padding, hi - padding + reach


def vocoder_window(model, start: int, length: int, frames: int) -> tuple[int, int]:
    """Derive exact required HiFiGAN input frames from its convolution graph.

    WavLM keeps its original full context. Only matching/vocoding of frames that
    cannot affect the retained output samples is omitted. Unknown architectures
    safely fall back to the full feature sequence.
    """
    if start < 0 or length <= 0 or frames <= 0:
        raise ValueError("Invalid synthesis interval")
    try:
        generator = model.hifigan
        if math.prod(layer.stride[0] for layer in generator.ups) != 320:
            return 0, frames
        if len(generator.resblocks) != len(generator.ups) * generator.num_kernels:
            return 0, frames
        lo, hi = _conv_interval(generator.conv_post, start, start + length - 1)
        for stage in reversed(range(len(generator.ups))):
            branches = [(lo, hi)]  # residual identity path
            blocks = generator.resblocks[stage * generator.num_kernels:(stage + 1) * generator.num_kernels]
            for block in blocks:
                a, b = lo, hi
                if len(block.convs1) != len(block.convs2):
                    return 0, frames
                for first, second in reversed(list(zip(block.convs1, block.convs2))):
                    a, b = _conv_interval(second, a, b)
                    a, b = _conv_interval(first, a, b)
                branches.append((a, b))
            lo, hi = min(a for a, _ in branches), max(b for _, b in branches)
            up = generator.ups[stage]
            if not isinstance(up, torch.nn.ConvTranspose1d):
                return 0, frames
            stride, padding = up.stride[0], up.padding[0]
            reach = up.dilation[0] * (up.kernel_size[0] - 1)
            # Output n receives input i only when n=i*stride-padding+k*dilation.
            lo = -(-(lo + padding - reach) // stride)
            hi = (hi + padding) // stride
        lo, hi = _conv_interval(generator.conv_pre, lo, hi)
        # One extra feature frame per side is a conservative boundary guard.
        return max(0, lo - 1), min(frames, hi + 2)
    except (AttributeError, IndexError, TypeError, ValueError):
        return 0, frames