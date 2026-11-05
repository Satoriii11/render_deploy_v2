import { readFile } from "node:fs/promises";

const text = file => readFile(new URL("../public/" + file, import.meta.url), "utf8");

export async function loadAssets() {
  const [page, style, script, icon] = await Promise.all(["desk/index.html","desk/style.css","desk/desk.js","favicon.svg"].map(text));
  return {
    "/":["text/html; charset=utf-8",page],
    "/style.css":["text/css; charset=utf-8",style],
    "/desk.js":["application/javascript; charset=utf-8",script],
    "/favicon.svg":["image/svg+xml; charset=utf-8",icon],
  };
}

