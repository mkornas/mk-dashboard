/**
 * Tiny append-only JSONL ring on disk (optional). Keeps the last `max`
 * records in memory; the file is rewritten when it grows past 2× that.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class JsonlStore<T> {
  private readonly items: T[] = [];
  private readonly file: string | null;
  private readonly max: number;
  private appended = 0;

  constructor(dataDir: string, name: string, max: number) {
    this.max = max;
    this.file = dataDir ? join(dataDir, name) : null;
    if (this.file) {
      try {
        mkdirSync(dataDir, { recursive: true });
        if (existsSync(this.file)) {
          const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
          for (const l of lines.slice(-max)) {
            try {
              this.items.push(JSON.parse(l) as T);
            } catch {
              /* skip */
            }
          }
        }
      } catch (e) {
        console.warn(`store ${this.file}: ${(e as Error).message}`);
        this.file = null;
      }
    }
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    if (!this.file) return;
    try {
      appendFileSync(this.file, JSON.stringify(item) + '\n');
      if (++this.appended > this.max) {
        writeFileSync(this.file, this.items.map((i) => JSON.stringify(i)).join('\n') + '\n');
        this.appended = 0;
      }
    } catch (e) {
      console.warn(`store ${this.file}: ${(e as Error).message}`);
    }
  }

  /** Newest first. */
  list(limit = this.max, filter?: (i: T) => boolean): T[] {
    const out: T[] = [];
    for (let i = this.items.length - 1; i >= 0 && out.length < limit; i--) {
      if (!filter || filter(this.items[i])) out.push(this.items[i]);
    }
    return out;
  }
}
