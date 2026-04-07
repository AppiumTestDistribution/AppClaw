/**
 * Report server — lightweight HTTP server for viewing AppClaw flow reports.
 *
 * Routes:
 *   GET /                          → Run index page
 *   GET /runs/:runId               → Run detail page
 *   GET /artifacts/:runId/*        → Serve screenshots/artifacts
 *   GET /health                    → Health check
 *   GET /api/runs                  → JSON run index
 *   GET /api/runs/:runId           → JSON run manifest
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadRunIndex, loadRunManifest, getArtifactPath } from './writer.js';
import { renderIndexPage, renderRunPage } from './renderer.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

function respond(
  res: http.ServerResponse,
  status: number,
  body: string,
  type = 'text/html; charset=utf-8'
) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function respondJson(res: http.ServerResponse, status: number, data: unknown) {
  respond(res, status, JSON.stringify(data, null, 2), 'application/json; charset=utf-8');
}

function respond404(res: http.ServerResponse) {
  respond(
    res,
    404,
    `<!doctype html><html><body style="font-family:sans-serif;padding:40px;text-align:center"><h1>404</h1><p>Not found</p><a href="/">Back to reports</a></body></html>`
  );
}

export interface ReportServerOptions {
  port?: number;
  projectRoot?: string;
  onListening?: (port: number) => void;
}

export function startReportServer(options: ReportServerOptions = {}): http.Server {
  const port = options.port ?? 4173;
  const projectRoot = options.projectRoot ?? process.cwd();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = url.pathname;

    try {
      // ── Health check ──
      if (pathname === '/health') {
        respondJson(res, 200, { status: 'ok' });
        return;
      }

      // ── API: JSON endpoints ──
      if (pathname === '/api/runs') {
        const index = await loadRunIndex(projectRoot);
        respondJson(res, 200, index);
        return;
      }

      const apiRunMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (apiRunMatch) {
        const manifest = await loadRunManifest(projectRoot, apiRunMatch[1]);
        if (!manifest) {
          respondJson(res, 404, { error: 'Run not found' });
          return;
        }
        respondJson(res, 200, manifest);
        return;
      }

      // ── Artifact serving ──
      const artifactMatch = pathname.match(/^\/artifacts\/([^/]+)\/(.+)$/);
      if (artifactMatch) {
        const [, runId, artifactPath] = artifactMatch;
        const fullPath = getArtifactPath(projectRoot, runId, ...artifactPath.split('/'));

        // Security: prevent path traversal
        const normalizedPath = path.normalize(fullPath);
        const expectedBase = path.join(projectRoot, '.appclaw', 'runs', runId);
        if (!normalizedPath.startsWith(expectedBase)) {
          respond(res, 403, 'Forbidden');
          return;
        }

        if (!fs.existsSync(fullPath)) {
          respond404(res);
          return;
        }

        const stat = fs.statSync(fullPath);
        res.writeHead(200, {
          'Content-Type': contentType(fullPath),
          'Content-Length': stat.size,
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*',
        });
        fs.createReadStream(fullPath).pipe(res);
        return;
      }

      // ── Run detail page ──
      const runMatch = pathname.match(/^\/runs\/([^/]+)$/);
      if (runMatch) {
        const manifest = await loadRunManifest(projectRoot, runMatch[1]);
        if (!manifest) {
          respond404(res);
          return;
        }
        respond(res, 200, renderRunPage(manifest));
        return;
      }

      // ── Index page ──
      if (pathname === '/' || pathname === '/index.html') {
        const index = await loadRunIndex(projectRoot);
        respond(res, 200, renderIndexPage(index));
        return;
      }

      respond404(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respond(
        res,
        500,
        `<!doctype html><html><body style="font-family:sans-serif;padding:40px"><h1>500 Internal Error</h1><pre>${msg}</pre></body></html>`
      );
    }
  });

  server.listen(port, () => {
    options.onListening?.(port);
  });

  return server;
}
