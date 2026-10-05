// Enforce each endpoint's byte budget while reading, including chunked requests,
// before allocating/parsing a whole body. Access endpoints retain a 4-KiB default.
export class AccessInputError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export async function readAccessBody(request: Request, options: { limit?: number; label?: string } = {}): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new AccessInputError("Send an application/json request.", 415);
  const limit = options.limit ?? 4096;
  const tooLarge = `${options.label ?? "Access"} request is too large.`;
  if (Number(request.headers.get("content-length")) > limit)
    throw new AccessInputError(tooLarge, 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AccessInputError("Send a JSON object.");
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new AccessInputError(tooLarge, 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new AccessInputError("Send valid JSON."); }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new AccessInputError("Send a JSON object.");
  return body as Record<string, unknown>;
}

export function accessError(error: unknown, message: string) {
  // Raw PostgreSQL errors can contain submitted values or connection details.
  return error instanceof AccessInputError
    ? Response.json({ error: error.message }, { status: error.status })
    : Response.json({ error: message }, { status: 503 });
}
