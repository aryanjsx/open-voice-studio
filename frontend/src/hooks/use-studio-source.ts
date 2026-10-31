import { useCallback, useEffect, useRef, useState } from "react";
import { jobUrl } from "@/lib/studio-api";
import type { Job, StudioSource } from "@/lib/studio-types";
import { extensionOf, savedSource, validateFile, VIDEO_EXTENSIONS } from "@/lib/studio-utils";

export function useStudioSource(maxBytes: number) {
  const [source, setSource] = useState<StudioSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const objectUrl = useRef<string | null>(null);

  const release = useCallback(() => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  }, []);

  useEffect(() => release, [release]);

  function chooseFile(file: File) {
    const problem = validateFile(file, maxBytes);
    if (problem) { setError(problem); return false; }
    release();
    const url = URL.createObjectURL(file);
    objectUrl.current = url;
    setSource({
      type: "file", file, filename: file.name, size: file.size, url,
      mediaKind: VIDEO_EXTENSIONS.includes(extensionOf(file.name)) ? "video" : "audio",
    });
    setError(null);
    return true;
  }

  function reuse(job: Job) {
    release();
    setSource(savedSource(job));
    setError(null);
  }

  function markSaved(id: string, original: StudioSource) {
    release();
    setSource({
      type: "saved", jobId: id, filename: original.filename, size: original.size,
      mediaKind: original.mediaKind, url: jobUrl(id, "source"),
    });
  }

  function clear() {
    release();
    setSource(null);
    setError(null);
  }

  function forgetSaved(id: string) {
    setSource((previous) => previous?.type === "saved" && previous.jobId === id ? null : previous);
  }

  return { source, error, setError, chooseFile, reuse, markSaved, clear, forgetSaved };
}