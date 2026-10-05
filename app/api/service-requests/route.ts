import { requireUser } from "../../../lib/pin-auth";

type RuntimeEnv = {
  ADMIN_SHARED_SECRET?: string;
  SERVICE_REQUEST_API_URL?: string;
};

function runtime() {
  return (
    globalThis as typeof globalThis & {
      __ASSET_TRACKER_ENV__?: RuntimeEnv;
    }
  ).__ASSET_TRACKER_ENV__;
}

async function forward(request: Request, method: "GET" | "PATCH" | "DELETE") {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  const secret = runtime()?.ADMIN_SHARED_SECRET;
  const endpoint = runtime()?.SERVICE_REQUEST_API_URL;
  if (!secret || !endpoint)
    return Response.json(
      { error: "Service request synchronization is not configured." },
      { status: 503 },
    );

  const incomingUrl = new URL(request.url);
  const target = new URL(endpoint);
  target.search = incomingUrl.search;

  const response = await fetch(target, {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(method === "PATCH" ? { "content-type": "application/json" } : {}),
    },
    body: method === "PATCH" ? await request.text() : undefined,
  });

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type":
        response.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function GET(request: Request) {
  return forward(request, "GET");
}

export function PATCH(request: Request) {
  return forward(request, "PATCH");
}

export function DELETE(request: Request) {
  return forward(request, "DELETE");
}
