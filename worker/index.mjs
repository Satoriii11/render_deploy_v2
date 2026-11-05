import { handleApi } from "../lib/procurement.mjs";

export function createWorker(assets, local = false) {
  return {
    async fetch(request, env) {
      const {pathname} = new URL(request.url);
      if (pathname.startsWith("/api/")) {
        const signedInUser = local ? "local-procurement-owner" : request.headers.get("oai-authenticated-user-id");
        if (signedInUser || pathname !== "/api/analyze" || request.method !== "POST") {
          return handleApi(request, env, signedInUser);
        }

        const cookies = request.headers.get("Cookie") || "";
        const session = cookies.match(/(?:^|;\s*)__Host-procurement_session=([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:;|$)/)?.[1];
        const visitorId = session || crypto.randomUUID();
        const response = await handleApi(request, env, "visitor-" + visitorId);
        if (response.ok && !session) {
          response.headers.append("Set-Cookie",
            "__Host-procurement_session=" + visitorId + "; Path=/; Secure; HttpOnly; SameSite=Strict");
        }
        return response;
      }
      const asset = assets[pathname];
      if (!asset || !["GET","HEAD"].includes(request.method)) return new Response("Not found",{status:404});
      return new Response(request.method === "HEAD" ? null : asset[1], {headers:{
        "Content-Type":asset[0],
        "Cache-Control":"no-cache",
        "X-Content-Type-Options":"nosniff",
        "Content-Security-Policy":"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'",
      }});
    },
  };
}

