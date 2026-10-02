/**
 * HTTP 服务：POST /execute 接收 JSON 请求体，返回执行结果或校验错误。
 *   GET  /health  → 200 { "ok": true }
 *   POST /execute → 200 { ok: true, columns, rows } | 422 { ok: false, errors }
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { executeQuery } from './index.js';

const MAX_BODY_BYTES = 1_000_000;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function createServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && req.url === '/execute') {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          tooBig = true;
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooBig) {
          sendJson(res, 413, { ok: false, errors: ['request body too large'] });
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          sendJson(res, 400, { ok: false, errors: ['request body is not valid JSON'] });
          return;
        }
        const result = executeQuery(body);
        sendJson(res, result.ok ? 200 : 422, result);
      });
      return;
    }
    sendJson(res, 404, { ok: false, errors: ['not found'] });
  });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`structured query engine listening on :${port}`);
  });
}
