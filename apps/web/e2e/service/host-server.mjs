// Minimal stand-in for the Maypop host page: embeds the Verity frontend in an
// iframe with the same sandbox flags Maypop's shell uses.
import { createServer } from "node:http";

const APP = process.env.APP_ORIGIN ?? "http://127.0.0.1:4180";
const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Host (Maypop stand-in)</title>
<style>html,body{margin:0;height:100%}iframe{border:0;display:block;width:100%;height:100%}</style></head>
<body>
<iframe id="verity" title="Verity" src="${APP}/"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-popups-to-escape-sandbox allow-downloads"></iframe>
</body></html>`;

createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}).listen(Number(process.env.PORT ?? 4190), "localhost");
