import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { ActionResult, AlertsInfo, BackupsInfo, CheckResult, DockerEvent, HistoryRange, HostHistory, Identity, PushSubscriptionInfo, ContainerAction, ContainerDetail, ContainerHistory, ContainerLogs, ContainerTop, Meta, Overview, SqliteDb, SqliteDbDetail, SqliteHealth, SqliteQueryResult, SqliteRows, SqliteSnapshot, SystemInfo, NasInfo } from '../../../../shared/types';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  meta(): Promise<Meta> {
    return firstValueFrom(this.http.get<Meta>('/api/meta'));
  }

  overview(): Promise<Overview> {
    return firstValueFrom(this.http.get<Overview>('/api/overview'));
  }

  history(range: HistoryRange): Promise<HostHistory> {
    return firstValueFrom(this.http.get<HostHistory>('/api/history', { params: new HttpParams().set('range', range) }));
  }

  containerHistory(name: string, range: HistoryRange): Promise<ContainerHistory> {
    return firstValueFrom(this.http.get<ContainerHistory>('/api/history/container', { params: new HttpParams().set('name', name).set('range', range) }));
  }

  container(id: string): Promise<ContainerDetail> {
    return firstValueFrom(this.http.get<ContainerDetail>(`/api/containers/${encodeURIComponent(id)}`));
  }

  top(id: string): Promise<ContainerTop> {
    return firstValueFrom(this.http.get<ContainerTop>(`/api/containers/${encodeURIComponent(id)}/top`));
  }

  logs(id: string, tail = 500): Promise<ContainerLogs> {
    return firstValueFrom(this.http.get<ContainerLogs>(`/api/containers/${encodeURIComponent(id)}/logs`, { params: new HttpParams().set('tail', tail) }));
  }

  action(id: string, action: ContainerAction): Promise<ActionResult> {
    return firstValueFrom(this.http.post<ActionResult>(`/api/containers/${encodeURIComponent(id)}/${action}`, {}));
  }

  system(): Promise<SystemInfo> {
    return firstValueFrom(this.http.get<SystemInfo>('/api/system'));
  }

  prune(images: 'dangling' | 'unused', buildCache: boolean): Promise<ActionResult> {
    return firstValueFrom(this.http.post<ActionResult>('/api/system/prune', { images, buildCache }));
  }

  // ---- SQLite console ----
  sqliteList(): Promise<SqliteDb[]> {
    return firstValueFrom(this.http.get<SqliteDb[]>('/api/sqlite'));
  }
  sqliteDb(path: string): Promise<SqliteDbDetail> {
    return firstValueFrom(this.http.get<SqliteDbDetail>('/api/sqlite/db', { params: new HttpParams().set('path', path) }));
  }
  sqliteRows(path: string, table: string, opts: { offset: number; limit: number; sort?: string; dir?: 'asc' | 'desc' }): Promise<SqliteRows> {
    let params = new HttpParams().set('path', path).set('table', table).set('offset', String(opts.offset)).set('limit', String(opts.limit));
    if (opts.sort) params = params.set('sort', opts.sort).set('dir', opts.dir ?? 'asc');
    return firstValueFrom(this.http.get<SqliteRows>('/api/sqlite/rows', { params }));
  }
  sqliteQuery(path: string, sql: string): Promise<SqliteQueryResult> {
    return firstValueFrom(this.http.post<SqliteQueryResult>('/api/sqlite/query', { path, sql }));
  }
  sqliteHealth(path: string): Promise<SqliteHealth> {
    return firstValueFrom(this.http.get<SqliteHealth>('/api/sqlite/health', { params: new HttpParams().set('path', path) }));
  }
  sqliteExportUrl(path: string, table: string, format: 'csv' | 'json'): string {
    return `/api/sqlite/export?path=${encodeURIComponent(path)}&table=${encodeURIComponent(table)}&format=${format}`;
  }
  sqliteSnapshot(path: string): Promise<SqliteSnapshot> {
    return firstValueFrom(this.http.post<SqliteSnapshot>('/api/sqlite/snapshot', { path }));
  }
  sqliteRestore(path: string, file: string): Promise<ActionResult> {
    return firstValueFrom(this.http.post<ActionResult>('/api/sqlite/restore', { path, file }));
  }

  nas(): Promise<NasInfo> {
    return firstValueFrom(this.http.get<NasInfo>('/api/nas'));
  }
  backups(): Promise<BackupsInfo> {
    return firstValueFrom(this.http.get<BackupsInfo>('/api/backups'));
  }

  runChecks(): Promise<CheckResult[]> {
    return firstValueFrom(this.http.post<CheckResult[]>('/api/checks/run', {}));
  }

  events(limit = 200, container?: string): Promise<DockerEvent[]> {
    let params = new HttpParams().set('limit', limit);
    if (container) params = params.set('container', container);
    return firstValueFrom(this.http.get<DockerEvent[]>('/api/events', { params }));
  }

  alerts(): Promise<AlertsInfo> {
    return firstValueFrom(this.http.get<AlertsInfo>('/api/alerts'));
  }

  me(): Promise<Identity> {
    return firstValueFrom(this.http.get<Identity>('/api/me'));
  }

  pushInfo(): Promise<PushSubscriptionInfo> {
    return firstValueFrom(this.http.get<PushSubscriptionInfo>('/api/push'));
  }

  pushSubscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<ActionResult> {
    return firstValueFrom(this.http.post<ActionResult>('/api/push/subscribe', sub));
  }

  pushUnsubscribe(endpoint: string): Promise<ActionResult> {
    return firstValueFrom(this.http.post<ActionResult>('/api/push/unsubscribe', { endpoint }));
  }

  notifyTest(): Promise<ActionResult> {
    return firstValueFrom(this.http.post<ActionResult>('/api/notify/test', {}));
  }
}

/** Message out of an HTTP error, for toasts. */
export function errorMessage(e: unknown): string {
  const err = e as { error?: { message?: string }; message?: string; status?: number };
  return err?.error?.message ?? err?.message ?? 'Request failed';
}
