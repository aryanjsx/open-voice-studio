import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiUrl, errorMessage, requestJson, responseError, validateJob } from "@/lib/studio-api";
import { isTerminal, newerJob, type ConversionInput, type Job, type UploadState } from "@/lib/studio-types";
import { clampPercent, extensionOf, readStorage, validateFile, writeStorage } from "@/lib/studio-utils";

const LAST_JOB = "voice-studio.last-job.v1";
const MAX_POLL_FAILURES = 5;
const MAX_TRACKING_MS = 6 * 60 * 60 * 1000;
const ID_PATTERN = /^[a-f0-9]{32}$/;

function upsert(jobs: Job[], incoming: Job) {
  const updated = newerJob(jobs.find((job) => job.id === incoming.id), incoming);
  return [updated, ...jobs.filter((job) => job.id !== incoming.id)]
    .sort((a, b) => b.created_at - a.created_at).slice(0, 30);
}

function detachUpload(xhr: XMLHttpRequest) {
  xhr.onload = xhr.onerror = xhr.onabort = xhr.ontimeout = null;
  xhr.upload.onprogress = xhr.upload.onload = null;
}

export function useStudioJobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [view, setView] = useState<{ id: string | null; job: Job | null }>({ id: null, job: null });
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollPaused, setPollPaused] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const mounted = useRef(false);
  const selectedId = useRef<string | null>(null);
  const canRestore = useRef(true);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const uploadGeneration = useRef(0);
  const historyRequest = useRef<AbortController | null>(null);
  const historyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const historyGeneration = useRef(0);
  const cancelRequest = useRef<AbortController | null>(null);
  const deleteRequest = useRef<AbortController | null>(null);

  const acceptJob = useCallback((job: Job) => {
    setJobs((previous) => upsert(previous, job));
    if (selectedId.current === job.id) {
      setView((previous) => previous.id === job.id ? { id: job.id, job: newerJob(previous.job, job) } : previous);
    }
  }, []);

  const refreshHistory = useCallback(() => {
    historyRequest.current?.abort();
    clearTimeout(historyTimer.current);
    const generation = ++historyGeneration.current;
    const controller = new AbortController();
    historyRequest.current = controller;
    setHistoryLoading(true);
    let failures = 0;
    const isCurrent = () => mounted.current && !controller.signal.aborted && generation === historyGeneration.current;

    async function load() {
      try {
        const incoming = await requestJson<Job[]>("/api/jobs", { signal: controller.signal });
        if (!Array.isArray(incoming)) throw new ApiError(502, "The conversion history could not be read.");
        incoming.forEach((job) => validateJob(job));
        if (!isCurrent()) return;
        failures = 0;
        setJobs((previous) => incoming.map((job) => newerJob(previous.find((item) => item.id === job.id), job))
          .sort((a, b) => b.created_at - a.created_at).slice(0, 30));
        setHistoryError(null);
        const current = incoming.find((job) => job.id === selectedId.current);
        if (current) setView((previous) => previous.id === current.id ? { id: current.id, job: newerJob(previous.job, current) } : previous);

        if (canRestore.current) {
          canRestore.current = false;
          const storedId = readStorage(LAST_JOB);
          const saved = incoming.find((job) => job.id === storedId);
          const restore = saved && !isTerminal(saved) ? saved : incoming.find((job) => !isTerminal(job)) ?? saved;
          const id = restore?.id ?? (storedId && ID_PATTERN.test(storedId) ? storedId : null);
          if (id) {
            selectedId.current = id;
            setView({ id, job: restore ?? null });
            writeStorage(LAST_JOB, id);
          }
        }
        if (incoming.some((job) => !isTerminal(job))) {
          historyTimer.current = setTimeout(() => void load(), 12000);
        }
      } catch (error) {
        if (!isCurrent()) return;
        failures += 1;
        setHistoryError(`${errorMessage(error)}${failures >= 4 ? " History updates paused; use Refresh to retry." : " Retrying history…"}`);
        if (failures < 4) historyTimer.current = setTimeout(() => void load(), 3000 * 2 ** (failures - 1));
      } finally {
        if (isCurrent()) setHistoryLoading(false);
      }
    }
    void load();
  }, []);

  useEffect(() => {
    mounted.current = true;
    const initial = setTimeout(refreshHistory, 0);
    return () => {
      mounted.current = false;
      clearTimeout(initial);
      clearTimeout(historyTimer.current);
      historyRequest.current?.abort();
      cancelRequest.current?.abort();
      deleteRequest.current?.abort();
      uploadGeneration.current += 1;
      if (xhrRef.current) {
        detachUpload(xhrRef.current);
        xhrRef.current.abort();
        xhrRef.current = null;
      }
    };
  }, [refreshHistory]);

  useEffect(() => {
    const id = view.id ?? "";
    if (!id) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const began = Date.now();
    const isCurrent = () => !controller.signal.aborted && mounted.current && selectedId.current === id;

    async function poll() {
      try {
        const job = validateJob(await requestJson<Job>(`/api/jobs/${id}`, { signal: controller.signal }), id);
        if (!isCurrent()) return;
        acceptJob(job);
        failures = 0;
        setPollError(null);
        setPollPaused(false);
        if (isTerminal(job)) { refreshHistory(); return; }
        if (Date.now() - began > MAX_TRACKING_MS) {
          setPollPaused(true);
          setPollError("Live updates paused after six hours. The job was not cancelled. Resume updates to check its status.");
          return;
        }
        // Schedule only after the previous request has settled: no overlapping polls.
        timer = setTimeout(() => void poll(), job.status === "queued" ? 2500 : 1800);
      } catch (error) {
        if (!isCurrent()) return;
        if (error instanceof ApiError && error.status === 404) {
          selectedId.current = null;
          setView({ id: null, job: null });
          writeStorage(LAST_JOB, null);
          setActionError("This conversion was not found (404). It may have been deleted. Choose an available upload or start a new conversion.");
          setPollError(null);
          refreshHistory();
          return;
        }
        failures += 1;
        const permanent = error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
        const paused = permanent || failures >= MAX_POLL_FAILURES || Date.now() - began > MAX_TRACKING_MS;
        setPollPaused(paused);
        setPollError(`${errorMessage(error)} ${paused ? "Live updates paused. The job has not been cancelled; resume updates to reconnect." : `Reconnecting (${failures}/${MAX_POLL_FAILURES})…`}`);
        if (!paused) timer = setTimeout(() => void poll(), Math.min(30000, 2000 * 2 ** (failures - 1)));
      }
    }

    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [view.id, pollVersion, acceptJob, refreshHistory]);

  function selectJob(job: Job) {
    if (xhrRef.current) return;
    canRestore.current = false;
    cancelRequest.current?.abort();
    cancelRequest.current = null;
    setCancellingId(null);
    selectedId.current = job.id;
    setView({ id: job.id, job });
    setPollError(null);
    setPollPaused(false);
    setActionError(null);
    setNotice(null);
    setPollVersion((value) => value + 1);
    writeStorage(LAST_JOB, job.id);
  }

  function clearSelection() {
    if (xhrRef.current) return;
    canRestore.current = false;
    cancelRequest.current?.abort();
    cancelRequest.current = null;
    setCancellingId(null);
    selectedId.current = null;
    setView({ id: null, job: null });
    setPollError(null);
    setPollPaused(false);
    setActionError(null);
    setNotice(view.id && (!view.job || !isTerminal(view.job))
      ? "This conversion remains on the server. Find it in Recent conversions to check progress or cancel it."
      : null);
    writeStorage(LAST_JOB, null);
  }

  function start(input: ConversionInput, onAccepted: (id: string) => void) {
    if (xhrRef.current) return;
    if (input.source.type === "file") {
      const problem = validateFile(input.source.file);
      if (problem) { setActionError(problem); return; }
    }
    canRestore.current = false;
    selectedId.current = null;
    setView({ id: null, job: null });
    setPollError(null);
    setPollPaused(false);
    setActionError(null);
    setNotice(null);
    const generation = ++uploadGeneration.current;
    const body = new FormData();
    body.append("voice", input.voice);
    body.append("quality", input.quality);
    body.append("output_format", input.outputFormat);
    if (input.source.type === "saved") body.append("source_job_id", input.source.jobId);
    else body.append("file", input.source.file);

    const reused = input.source.type === "saved";
    setUpload({ percent: reused ? null : 0, waiting: reused, reused });
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    const isCurrent = () => mounted.current && uploadGeneration.current === generation && xhrRef.current === xhr;
    const finish = () => {
      detachUpload(xhr);
      xhrRef.current = null;
      setUpload(null);
    };
    const fail = (message: string, uncertain = false) => {
      if (!isCurrent()) return;
      finish();
      setActionError(message);
      if (uncertain) setNotice("No job ID was received. The server may have accepted the request; refresh Recent conversions before submitting again.");
      refreshHistory();
    };

    xhr.open("POST", apiUrl("/api/jobs"));
    xhr.timeout = 10 * 60 * 1000;
    xhr.upload.onprogress = (event) => {
      if (isCurrent() && !reused) setUpload({ percent: event.lengthComputable ? clampPercent(event.loaded / event.total * 100) : null, waiting: false, reused });
    };
    xhr.upload.onload = () => {
      if (isCurrent()) setUpload({ percent: reused ? null : 100, waiting: true, reused });
    };
    xhr.onerror = () => fail(errorMessage(new TypeError("Upload failed")), true);
    xhr.ontimeout = () => fail("The upload request timed out. Check your connection and refresh history before retrying.", true);
    xhr.onabort = () => fail("The upload request was interrupted. This does not confirm cancellation of a server job.", true);
    xhr.onload = () => {
      if (!isCurrent()) return;
      let payload: unknown;
      try { payload = JSON.parse(xhr.responseText); }
      catch { payload = null; }
      if (xhr.status < 200 || xhr.status >= 300) {
        const fallback = xhr.status === 429 ? "The queue is full (capacity: 8). Wait for a job to finish and retry."
          : xhr.status === 413 ? "The file is larger than the 512 MB limit." : `Could not create the conversion (HTTP ${xhr.status}).`;
        fail(responseError(payload, fallback));
        return;
      }
      if (!payload || typeof payload !== "object" || !("id" in payload) || typeof payload.id !== "string" || !ID_PATTERN.test(payload.id)) {
        fail("The upload response did not contain a valid job ID.", true);
        return;
      }
      const id = payload.id;
      finish();
      const outputKind = input.source.mediaKind === "video" && input.outputFormat === "original" ? "video" : "audio";
      const queued: Job = {
        id, status: "queued", voice: input.voice, quality: input.quality, output_format: input.outputFormat,
        output_kind: outputKind, output_ext: outputKind === "video" ? extensionOf(input.source.filename) : input.outputFormat === "mp3" ? ".mp3" : ".wav",
        source_kind: input.source.mediaKind, filename: input.source.filename, name: input.source.filename,
        size_bytes: input.source.size, source_reused: reused, created_at: Date.now() / 1000,
        progress: 0, preview: false, detail: "Request accepted. Fetching live status…", error: null,
        elapsed_seconds: 0, queue_position: 0,
      };
      selectedId.current = id;
      setView({ id, job: queued });
      setJobs((previous) => upsert(previous, queued));
      writeStorage(LAST_JOB, id);
      onAccepted(id);
      refreshHistory();
    };
    try { xhr.send(body); }
    catch (error) { fail(errorMessage(error), true); }
  }

  function abortUpload() {
    const xhr = xhrRef.current;
    if (!xhr) return;
    uploadGeneration.current += 1;
    detachUpload(xhr);
    xhrRef.current = null;
    xhr.abort();
    setUpload(null);
    setNotice("Upload request stopped. No job ID was received, so server-side cancellation is not confirmed. Refresh Recent conversions before retrying.");
    refreshHistory();
  }

  async function cancelJob() {
    const id = selectedId.current;
    if (!id || cancelRequest.current) return;
    const controller = new AbortController();
    cancelRequest.current = controller;
    setCancellingId(id);
    setActionError(null);
    try {
      const job = validateJob(await requestJson<Job>(`/api/jobs/${id}/cancel`, { method: "POST", signal: controller.signal }), id);
      if (controller.signal.aborted || !mounted.current) return;
      acceptJob(job);
      if (selectedId.current === id) setPollVersion((value) => value + 1);
      refreshHistory();
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) setActionError(`Could not confirm cancellation. ${errorMessage(error)}`);
    } finally {
      if (cancelRequest.current === controller) {
        cancelRequest.current = null;
        if (mounted.current) setCancellingId(null);
      }
    }
  }

  async function removeJob(job: Job, onDeleted: (id: string) => void) {
    if (deleteRequest.current || xhrRef.current) return;
    if (!isTerminal(job)) { setActionError("Cancel an active conversion before deleting it."); return; }
    if (!window.confirm(`Delete “${job.filename}” and this conversion's saved upload and downloads? This cannot be undone. Other conversions are kept.`)) return;
    const controller = new AbortController();
    deleteRequest.current = controller;
    setDeletingId(job.id);
    setActionError(null);
    try {
      await requestJson<{ ok: boolean }>(`/api/jobs/${job.id}`, { method: "DELETE", signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      if (selectedId.current === job.id) clearSelection();
      setJobs((previous) => previous.filter((item) => item.id !== job.id));
      onDeleted(job.id);
      refreshHistory();
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) {
        setActionError(`Could not delete the conversion. ${errorMessage(error)}`);
        refreshHistory();
      }
    } finally {
      if (deleteRequest.current === controller) {
        deleteRequest.current = null;
        if (mounted.current) setDeletingId(null);
      }
    }
  }

  function resumePolling() {
    setPollError(null);
    setPollPaused(false);
    setPollVersion((value) => value + 1);
  }

  return {
    jobs, historyLoading, historyError, refreshHistory,
    selectedId: view.id, job: view.job, selectJob, clearSelection,
    upload, start, abortUpload, pollError, pollPaused, resumePolling,
    actionError, notice, dismissError: () => setActionError(null), dismissNotice: () => setNotice(null),
    cancellingId, cancelJob, deletingId, removeJob,
  };
}