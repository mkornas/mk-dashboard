/**
 * Minimal Docker Engine API client over the unix socket. No dependencies:
 * node:http supports `socketPath`. Only what the dashboard needs.
 */
import http from 'node:http';
import type { Readable } from 'node:stream';

export class DockerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface DockerResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export class DockerClient {
  private readonly socketPath: string;
  private readonly apiVersion: string;
  constructor(socketPath: string, apiVersion = 'v1.44') {
    this.socketPath = socketPath;
    this.apiVersion = apiVersion;
  }

  private url(path: string): string {
    return path.startsWith('/v') ? path : `/${this.apiVersion}${path}`;
  }

  /** Buffered request. Throws DockerError on non-2xx. */
  request(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<DockerResponse> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          socketPath: this.socketPath,
          path: this.url(path),
          method,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              resolve({ status, headers: res.headers, body: buf });
            } else {
              let msg = buf.toString('utf8');
              try {
                msg = JSON.parse(msg).message ?? msg;
              } catch {
                /* plain text */
              }
              reject(new DockerError(status, msg || `docker ${method} ${path} → ${status}`));
            }
          });
          res.on('error', reject);
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`docker ${method} ${path} timed out`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async get<T>(path: string): Promise<T> {
    const r = await this.request('GET', path);
    return JSON.parse(r.body.toString('utf8')) as T;
  }

  async post<T = unknown>(path: string, body?: unknown, timeoutMs = 60_000): Promise<T | null> {
    const r = await this.request('POST', path, body, timeoutMs);
    if (r.body.length === 0) return null;
    try {
      return JSON.parse(r.body.toString('utf8')) as T;
    } catch {
      return null;
    }
  }

  /** Streaming GET (logs, events). Resolves with the raw response stream. */
  stream(path: string): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, path: this.url(path), method: 'GET' }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve(res);
        } else {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => reject(new DockerError(status, Buffer.concat(chunks).toString('utf8'))));
        }
      });
      req.on('error', reject);
      req.end();
    });
  }
}

/**
 * Splits a Docker log stream into text lines. Handles both the multiplexed
 * format (8-byte frame header: stream type, 3× 0, big-endian size) used for
 * non-TTY containers and the raw byte stream of TTY containers.
 */
export class LogDemuxer {
  private buf: Buffer = Buffer.alloc(0);
  private text = '';
  private readonly tty: boolean;

  constructor(tty: boolean) {
    this.tty = tty;
  }

  push(chunk: Buffer): string[] {
    if (this.tty) return this.pushText(chunk.toString('utf8'));
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const lines: string[] = [];
    while (this.buf.length >= 8) {
      const type = this.buf[0];
      const framed = (type === 0 || type === 1 || type === 2) && this.buf[1] === 0 && this.buf[2] === 0 && this.buf[3] === 0;
      if (!framed) {
        // Not a frame header after all (e.g. a TTY container reported wrongly): treat as text.
        const rest = this.buf;
        this.buf = Buffer.alloc(0);
        lines.push(...this.pushText(rest.toString('utf8')));
        break;
      }
      const size = this.buf.readUInt32BE(4);
      if (this.buf.length < 8 + size) break;
      const payload = this.buf.subarray(8, 8 + size).toString('utf8');
      this.buf = this.buf.subarray(8 + size);
      lines.push(...this.pushText(payload));
    }
    return lines;
  }

  /** Whatever is left without a trailing newline. */
  flush(): string[] {
    const out: string[] = [];
    if (this.buf.length) {
      out.push(...this.pushText(this.buf.toString('utf8')));
      this.buf = Buffer.alloc(0);
    }
    if (this.text) {
      out.push(this.text);
      this.text = '';
    }
    return out;
  }

  private pushText(s: string): string[] {
    this.text += s;
    const parts = this.text.split('\n');
    this.text = parts.pop() ?? '';
    return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  }
}

/** Parse a stream of newline-delimited JSON objects (docker events). */
export class NdjsonParser<T = unknown> {
  private text = '';
  push(chunk: Buffer): T[] {
    this.text += chunk.toString('utf8');
    const parts = this.text.split('\n');
    this.text = parts.pop() ?? '';
    const out: T[] = [];
    for (const p of parts) {
      const line = p.trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  }
}
