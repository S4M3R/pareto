// Dev-only: serves view-host.html and proxies /mcp to a running `pnpm dev` server (same origin, so no CORS).
//   node dev/host-server.mjs [target=http://localhost:3000] [port=4173]
import { createServer, request } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const target = new URL(process.argv[2] ?? "http://localhost:3000");
const port = Number(process.argv[3] ?? 4173);
const page = fileURLToPath(new URL("./view-host.html", import.meta.url));

createServer(async (req, res) => {
  if (req.url?.startsWith("/mcp")) {
    const up = request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
    req.pipe(up);
    return;
  }
  if (req.url?.startsWith("/view-host.html") || req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(await readFile(page));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, "127.0.0.1", () => console.log(`view host: http://localhost:${port}/view-host.html  ->  ${target.origin}/mcp`));
