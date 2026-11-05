import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createWorker } from "./worker/index.mjs";
import { loadAssets } from "./scripts/assets.mjs";

const publicUrl = process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL;
const hosted = Boolean(publicUrl);
const port = Number(process.env.PORT || (hosted ? 10000 : 4173));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid PORT.");

const endpoint = new URL(publicUrl || "http://127.0.0.1:" + port);
if (hosted && (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)) {
  throw new Error("The public origin must be an HTTPS URL.");
}
if (hosted && !process.env.DIFY_API_KEY?.trim()) {
  throw new Error("Set DIFY_API_KEY in the hosting service's environment variables.");
}
const {origin} = endpoint;
const site = createWorker(await loadAssets(), !hosted);
const server = createServer(async (req,res) => {
  try {
    if (!req.url?.startsWith("/")) {
      res.writeHead(400).end();
      return;
    }
    const headers = new Headers(req.headers);
    // Render requests do not pass through the Sites identity gateway.
    headers.delete("oai-authenticated-user-id");
    const body = ["GET","HEAD"].includes(req.method) ? undefined : Readable.toWeb(req);
    const request = new Request(origin + req.url,{
      method:req.method,headers,body,duplex:body ? "half" : undefined,
    });
    const response = await site.fetch(request,process.env);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch {
    res.writeHead(500,{"Content-Type":"text/plain; charset=utf-8"}).end("页面服务暂时不可用。");
  }
});
server.listen(port,hosted ? "0.0.0.0" : "127.0.0.1",()=>console.log("Listening at " + origin));

