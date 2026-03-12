import { createServer, type IncomingMessage } from "node:http";

const host = process.env.RPC_PROXY_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.RPC_PROXY_PORT ?? "8789", 10);
const targetUrl = process.env.RPC_PROXY_TARGET ?? "https://soroban-testnet.stellar.org";
const timeoutMs = Number.parseInt(process.env.RPC_PROXY_TIMEOUT_MS ?? "45000", 10);

if (!Number.isFinite(port) || port <= 0) {
  throw new Error(`invalid RPC_PROXY_PORT: ${process.env.RPC_PROXY_PORT}`);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = await readBody(req);
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: new Uint8Array(body),
      signal: controller.signal,
    });

    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.statusCode = 502;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: "rpc proxy request failed",
        detail: message,
      }),
    );
  } finally {
    clearTimeout(timer);
  }
});

server.listen(port, host, () => {
  console.log(`[dev-rpc-proxy] listening on http://${host}:${port}`);
  console.log(`[dev-rpc-proxy] forwarding to ${targetUrl}`);
});
