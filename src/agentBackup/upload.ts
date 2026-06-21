import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as url from 'url';

export interface UploadResult {
  id: string;
  filename: string;
  downloadUrl: string;
}

/** Upload a backup zip to `POST /api/agents/{agentId}/exports`. */
export async function uploadAgentBackup(
  zipPath: string,
  agentId: string,
  serverBaseUrl: string,
  serverApiKey: string,
): Promise<UploadResult> {
  const fileBuffer = fs.readFileSync(zipPath);
  const filename = path.basename(zipPath);
  const boundary = `----AutodevBoundary${Date.now()}`;

  const preamble = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="zip"; filename="${filename}"\r\n` +
    `Content-Type: application/zip\r\n\r\n`,
    'utf8',
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([preamble, fileBuffer, epilogue]);

  const parsed = new url.URL(`${serverBaseUrl.replace(/\/$/, '')}/api/agents/${agentId}/exports/upload`);
  const transport = parsed.protocol === 'https:' ? https : http;
  const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serverApiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          'Accept': 'application/json',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
        res.on('end', () => {
          try {
            const json = JSON.parse(raw) as Record<string, unknown>;
            if (!json['success']) { reject(new Error(String(json['error'] ?? `HTTP ${res.statusCode}`))); return; }
            const data = json['data'] as Record<string, unknown>;
            resolve({
              id: String(data['id'] ?? ''),
              filename: String(data['filename'] ?? filename),
              downloadUrl: String(data['downloadUrl'] ?? ''),
            });
          } catch { reject(new Error(`Parse error: ${raw.slice(0, 200)}`)); }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Download a zip from a URL (authenticated) and save to destPath. */
export async function downloadAgentBackup(
  downloadUrl: string,
  destPath: string,
  serverApiKey: string,
): Promise<void> {
  const parsed = new url.URL(downloadUrl);
  const transport = parsed.protocol === 'https:' ? https : http;
  const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port,
        path: parsed.pathname + (parsed.search || ''),
        method: 'GET',
        headers: { 'Authorization': `Bearer ${serverApiKey}` },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        const out = fs.createWriteStream(destPath);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}
