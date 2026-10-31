import { JOB_STATUSES, type Job } from "./studio-types";

export const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8001"
).replace(/\/+$/, "");

export function apiUrl(path: string) {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

export function jobUrl(id: string, resource?: "source" | "preview" | "download" | "audio" | "cancel") {
  return apiUrl(`/api/jobs/${encodeURIComponent(id)}${resource ? `/${resource}` : ""}`);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export function responseError(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object" || !("detail" in body)) return fallback;
  const detail = body.detail;
  if (typeof detail === "string") return detail.slice(0, 1000);
  if (Array.isArray(detail)) {
    const messages = detail.flatMap((item: unknown) => {
      if (item && typeof item === "object" && "msg" in item && typeof item.msg === "string") {
        return [item.msg];
      }
      return [];
    });
    if (messages.length) return messages.join(" · ").slice(0, 1000);
  }
  return fallback;
}

export function errorMessage(error: unknown) {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return "You appear to be offline. Reconnect, then retry. Existing server jobs may still be running.";
  }
  if (error instanceof TypeError) return "Cannot reach the backend. Check the connection and that the API is available.";
  return error instanceof Error ? error.message : "Something went wrong. Please retry.";
}

type RequestOptions = RequestInit & { timeoutMs?: number };

async function request<T>(path: string, options: RequestOptions, read: (response: Response) => Promise<T>): Promise<T> {
  const { signal, timeoutMs = 15000, ...init } = options;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(apiUrl(path), { cache: "no-store", ...init, signal: controller.signal });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      throw new ApiError(response.status, responseError(body, `The server returned HTTP ${response.status}. Please retry.`));
    }
    return await read(response);
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new ApiError(408, "The server took too long to respond. It may still be working; retry to reconnect.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request(path, options, async (response) => {
    try {
      return await response.json() as T;
    } catch {
      throw new ApiError(502, "The API returned an unreadable response. Please retry.");
    }
  });
}

export function requestSample(path: string, signal: AbortSignal): Promise<Blob> {
  // First-time reference TTS generation can take longer than a status request.
  return request(path, { signal, timeoutMs: 180000, cache: "default" }, async (response) => {
    const blob = await response.blob();
    if (!blob.size) throw new ApiError(502, "The sample was empty. Please try again.");
    return blob;
  });
}

export function validateJob(value: Job, expectedId?: string): Job {
  if (!value || typeof value.id !== "string" || !JOB_STATUSES.includes(value.status) || (expectedId && value.id !== expectedId)) {
    throw new ApiError(502, "The API returned an invalid conversion status. Please retry.");
  }
  return value;
}