/** The SQLite console's API. Reads for everyone signed in; snapshot and restore need `canAct`. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import { BadQuery, NotFound, NotWritable, Timeout, type SqliteConsole } from './sqlite.ts';
import type {
  ActionResult,
  SqliteDb,
  SqliteDbDetail,
  SqliteHealth,
  SqliteQueryResult,
  SqliteRows,
  SqliteSnapshot,
} from '../../shared/types.ts';

export function registerSqliteRoutes(
  app: FastifyInstance,
  cfg: Config,
  sqlite: SqliteConsole,
): void {
  const requireAct = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.identity?.canAct) return true;
    reply.code(403).send({
      ok: false,
      message: cfg.readonly ? 'the dashboard is read-only' : 'actions need a signed-in admin',
    });
    return false;
  };
  const path = (req: FastifyRequest<{ Querystring: { path?: string } }>): string => {
    const p = req.query.path;
    if (typeof p !== 'string' || !p.startsWith('/')) throw new BadQuery('path is required');
    return p;
  };
  const wrap = <T>(fn: () => Promise<T>, reply: FastifyReply): Promise<T | FastifyReply> =>
    fn().catch((e: unknown) => {
      if (e instanceof NotFound) return reply.code(404).send({ ok: false, message: e.message });
      if (e instanceof BadQuery) return reply.code(400).send({ ok: false, message: e.message });
      if (e instanceof NotWritable) return reply.code(409).send({ ok: false, message: e.message });
      if (e instanceof Timeout) return reply.code(408).send({ ok: false, message: e.message });
      throw e;
    });

  app.get('/api/sqlite', async (_req, reply): Promise<SqliteDb[] | FastifyReply> =>
    wrap(() => sqlite.list(), reply),
  );
  app.get<{ Querystring: { path?: string } }>(
    '/api/sqlite/db',
    async (req, reply): Promise<SqliteDbDetail | FastifyReply> =>
      wrap(() => sqlite.detail(path(req)), reply),
  );
  app.get<{
    Querystring: {
      path?: string;
      table?: string;
      offset?: string;
      limit?: string;
      sort?: string;
      dir?: string;
    };
  }>('/api/sqlite/rows', async (req, reply): Promise<SqliteRows | FastifyReply> =>
    wrap(
      () =>
        sqlite.rows(path(req), String(req.query.table ?? ''), {
          offset: Number(req.query.offset) || 0,
          limit: Number(req.query.limit) || 100,
          sort: req.query.sort,
          dir: req.query.dir === 'desc' ? 'desc' : 'asc',
        }),
      reply,
    ),
  );
  app.get<{ Querystring: { path?: string; table?: string; format?: string } }>(
    '/api/sqlite/export',
    async (req, reply) =>
      wrap(async () => {
        const format = req.query.format === 'json' ? 'json' : 'csv';
        const text = await sqlite.exportTable(path(req), String(req.query.table ?? ''), format);
        const name = `${String(req.query.table)}.${format}`;
        return reply
          .header(
            'Content-Type',
            format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
          )
          .header('Content-Disposition', `attachment; filename="${name}"`)
          .send(text);
      }, reply),
  );
  app.post<{ Body: { path?: string; sql?: string } }>(
    '/api/sqlite/query',
    async (req, reply): Promise<SqliteQueryResult | FastifyReply> => {
      const p = req.body?.path;
      if (typeof p !== 'string')
        return reply.code(400).send({ ok: false, message: 'path is required' });
      return wrap(() => sqlite.query(p, String(req.body?.sql ?? '')), reply);
    },
  );
  app.get<{ Querystring: { path?: string } }>(
    '/api/sqlite/health',
    async (req, reply): Promise<SqliteHealth | FastifyReply> =>
      wrap(() => sqlite.health(path(req)), reply),
  );

  app.post<{ Body: { path?: string } }>(
    '/api/sqlite/snapshot',
    async (req, reply): Promise<SqliteSnapshot | FastifyReply> => {
      if (!requireAct(req, reply)) return reply;
      const p = req.body?.path;
      if (typeof p !== 'string')
        return reply.code(400).send({ ok: false, message: 'path is required' });
      return wrap(() => sqlite.snapshot(p), reply);
    },
  );
  app.post<{ Body: { path?: string; file?: string } }>(
    '/api/sqlite/restore',
    async (req, reply): Promise<ActionResult | FastifyReply> => {
      if (!requireAct(req, reply)) return reply;
      const p = req.body?.path;
      if (typeof p !== 'string')
        return reply.code(400).send({ ok: false, message: 'path is required' });
      return wrap(async () => {
        const r = await sqlite.restore(p, String(req.body?.file ?? ''));
        return {
          ok: true,
          message: `${p.split('/').pop()} restored from ${req.body?.file}${r.stopped ? `; ${r.stopped} was stopped and started again` : ''}; the previous file is kept as ${r.kept}`,
        };
      }, reply);
    },
  );
}
