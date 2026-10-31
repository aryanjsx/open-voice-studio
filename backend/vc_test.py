import asyncio, subprocess, time
from pathlib import Path
import edge_tts, imageio_ffmpeg
import pipeline

ff = imageio_ffmpeg.get_ffmpeg_exe()
text = "Welcome to this tutorial. Today we will learn how to create a simple web application. First, open your editor and create a new folder. Then type the name of the project and press enter."
asyncio.run(edge_tts.Communicate(text, "en-US-GuyNeural").save("src.mp3"))
subprocess.run([ff, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=40", "-i", "src.mp3",
                "-c:v", "libx264", "-c:a", "aac", "t.mp4"], check=True)
t = time.time()
def prog(p, m): print(round(time.time() - t, 1), p, m, flush=True)
pipeline.convert(Path("t.mp4"), Path("p.wav"), Path("f.wav"), "male", 15, prog, lambda: print("preview ready", round(time.time() - t, 1), flush=True))
print("done", round(time.time() - t, 1), Path("f.wav").stat().st_size)
