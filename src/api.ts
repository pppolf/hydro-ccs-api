import { Readable } from 'node:stream';
import { Context, ContestModel, db, Handler, ObjectId } from 'hydrooj';
import { ccsApiKeyAuthorized, ccsBasicAuthorized, ccsContestAllowlist } from './auth';
import { ccsTypes, duration, entities, hydroStandings, maskBroadcastEvent, type CcsChange } from './core';
import { CcsFeedStore, type CcsCommit, type CcsRepository } from './store';
import { CcsError, contestObject, getCcsContest, readHydroCcsState } from './source';
import { PLUGIN_VERSION } from './version';
import { ccsSetting as setting } from './settings';

declare module 'hydrooj' {
    interface Collections {
        'hydro.ccs.api.commits': CcsCommit;
        'hydro.ccs.api.chunks': { _id: string; batch: string; page: number; events: CcsChange[] };
    }
}
const ccsProperties: Record<string, string[]> = {
    contest: ['id', 'name', 'formal_name', 'start_time', 'end_time', 'duration', 'scoreboard_type', 'penalty_time', 'scoreboard_freeze_duration'],
    state: ['started', 'ended', 'frozen', 'thawed', 'finalized', 'end_of_updates'],
    'judgement-types': ['id', 'name', 'solved', 'penalty'],
    languages: ['id', 'name'], groups: ['id', 'name', 'hidden'],
    organizations: ['id', 'name', 'formal_name'],
    teams: ['id', 'label', 'name', 'organization_id', 'group_ids', 'hidden'],
    problems: ['id', 'label', 'ordinal', 'name', 'test_data_count', 'color', 'rgb'],
    submissions: ['id', 'team_id', 'problem_id', 'language_id', 'time', 'contest_time'],
    judgements: ['id', 'submission_id', 'judgement_type_id', 'start_time', 'start_contest_time', 'end_time', 'end_contest_time'],
    runs: ['id', 'judgement_id', 'ordinal', 'judgement_type_id', 'time', 'contest_time', 'run_time'],
};

export function registerCcsApi(ctx: Context) {
    const commits = db.collection('hydro.ccs.api.commits'), chunks = db.collection('hydro.ccs.api.chunks');
    const repository: CcsRepository = {
        latest: scope => commits.find({ scope }).sort({ revision: -1 }).limit(1).next(),
        commits: (scope, from, through) => commits.find({ scope, revision: { $gte: from, $lte: through } }).sort({ revision: 1 }).limit(100).toArray(),
        chunk: async (batch, page) => (await chunks.findOne({ _id: `${batch}/${page}` }))?.events || [],
        writeChunk: async (batch, page, events) => { await chunks.insertOne({ _id: `${batch}/${page}`, batch, page, events }); },
        commit: async value => {
            try { await commits.insertOne(value); return true; }
            catch (error) { if ((error as { code?: number }).code === 11000) return false; throw error; }
        },
        discard: async batch => { await chunks.deleteMany({ batch }); },
    };
    const ready = Promise.all([
        commits.createIndex({ scope: 1, revision: 1 }, { unique: true }), chunks.createIndex({ batch: 1, page: 1 }, { unique: true }),
    ]);
    // Handle initialization errors without an unhandled background rejection;
    // each request still awaits and reports an unavailable CCS service.
    void ready.catch(() => {});
    const store = new CcsFeedStore(repository);
    const watched = new Map<string, { domainId: string; tid: ObjectId; visibility: 'admin' | 'broadcast'; accessedAt: number }>();
    const streams = new Map<Readable, AbortController>();
    const revisions = new Map<string, number>();
    const waiters = new Map<string, Set<() => void>>();
    function waitForChange(scope: string, through: number, signal: AbortSignal) {
        if (signal.aborted || (revisions.get(scope) || 0) > through) return Promise.resolve();
        return new Promise<void>(resolve => {
            const listeners = waiters.get(scope) || new Set<() => void>();
            const done = () => {
                clearTimeout(timer);
                signal.removeEventListener('abort', done);
                listeners.delete(done);
                if (!listeners.size) waiters.delete(scope);
                resolve();
            };
            const timer = setTimeout(done, 2000);
            listeners.add(done);
            waiters.set(scope, listeners);
            signal.addEventListener('abort', done, { once: true });
        });
    }
    let disposed = false;
    ctx.effect(() => () => {
        disposed = true;
        watched.clear();
        for (const [stream, cancellation] of streams) { cancellation.abort(); stream.destroy(); }
    });
    // Bind tokens to this plugin's independent log, domain, contest and view.
    const scopeFor = (domainId: string, contestId: string, visibility: string) => JSON.stringify([domainId, contestId, visibility, 'hydro-ccs-api-v1']);
    async function refresh(domainId: string, tid: ObjectId, visibility: 'admin' | 'broadcast', touch = true, afterCurrent = false) {
        await ready;
        if (disposed) throw new CcsError(503, 'CCS plugin is shutting down');
        const scope = scopeFor(domainId, String(tid), visibility);
        const watch = watched.get(scope) || { domainId, tid, visibility, accessedAt: Date.now() };
        if (touch) watch.accessedAt = Date.now();
        watched.set(scope, watch);
        const current = await store.refresh(scope, String(tid), visibility, previous => {
            if (disposed) throw new CcsError(503, 'CCS plugin is shutting down');
            return readHydroCcsState(domainId, tid, visibility, previous, new Date(), ctx);
        }, afterCurrent);
        if (current.revision > (revisions.get(scope) || 0)) {
            revisions.set(scope, current.revision);
            for (const wake of [...(waiters.get(scope) || [])]) wake();
        }
        return current;
    }
    const recordChanged = (record: { domainId: string; contest?: unknown } | null) => {
        if (disposed || !record?.contest) return;
        const contestId = String(record.contest);
        let allowed: string[];
        try { allowed = ccsContestAllowlist(setting('contests')); } catch { return; }
        if (!allowed.includes(`${record.domainId}/${contestId}`)) return;
        return Promise.all([...watched.values()]
            .filter(watch => watch.domainId === record.domainId && String(watch.tid) === contestId && Date.now() - watch.accessedAt <= 300_000)
            .map(watch => refresh(watch.domainId, watch.tid, watch.visibility, false, true).catch(() => {})));
    };
    ctx.on('record/change', recordChanged);
    // The final record/change precedes Hydro's contest journal update.
    ctx.on('record/judge', recordChanged);
    ctx.interval(() => {
        for (const [scope, watch] of watched) {
            if (Date.now() - watch.accessedAt > 300_000) { watched.delete(scope); revisions.delete(scope); continue; }
            void refresh(watch.domainId, watch.tid, watch.visibility, false).catch(() => {});
        }
    }, 2000);

    class CcsHandler extends Handler {
        noCheckPermView = true;
        authenticate(domainId: string, contestId?: string): 'admin' | 'broadcast' {
            let visibility: 'admin' | 'broadcast' = 'broadcast';
            if (this.request.headers['x-ccs-api-key'] !== undefined) {
                if (!ccsApiKeyAuthorized(this.request.headers['x-ccs-api-key'], setting('adminApiKey'))) throw new CcsError(401, 'Invalid CCS API key');
                visibility = 'admin';
            } else if (!ccsBasicAuthorized(this.request.headers.authorization, setting('username') ?? 'ccs', setting('password'))) {
                throw new CcsError(401, 'CCS authentication required');
            }
            let allowed: string[];
            try { allowed = ccsContestAllowlist(setting('contests')); } catch { throw new CcsError(503, 'CCS configuration unavailable'); }
            if (contestId && !allowed.includes(`${domainId}/${contestId}`)) throw new CcsError(403, 'Contest is not enabled for CCS access');
            return visibility;
        }

        async get({ domainId, contestId: rawId, endpoint, id }: { domainId: string; contestId?: string; endpoint?: string; id?: string }) {
            // Hydro's base middleware serializes response.body unless type is
            // set explicitly. A Content-Type header alone would serialize a
            // Readable instead of sending NDJSON, and allow UI data injection.
            this.response.type = 'application/json';
            this.response.template = undefined;
            this.response.addHeader('Cache-Control', 'no-store');
            this.response.addHeader('Vary', 'Authorization, x-ccs-api-key');
            try {
                const contestId = rawId?.toString().toLowerCase();
                const visibility = this.authenticate(domainId, contestId);
                this.response.addHeader('Content-Type', 'application/json; charset=utf-8');
                if (!contestId) {
                    if (!endpoint) { this.response.body = { version: '2023-06', version_url: 'https://ccs-specs.icpc.io/2023-06/contest_api', name: 'Hydro XCPC CCS', provider: { name: 'hydro-ccs-api', version: PLUGIN_VERSION } }; return; }
                    const allowed = ccsContestAllowlist(setting('contests'));
                    const list = await ContestModel.getMulti(domainId, { rule: 'acm' }).toArray();
                    this.response.body = list.filter(contest => !contest.duration && allowed.includes(`${domainId}/${contest.docId}`)).map(contestObject);
                    return;
                }
                if (!/^[a-f\d]{24}$/.test(contestId)) throw new CcsError(400, 'Invalid contest id');
                const tid = new ObjectId(contestId), scope = scopeFor(domainId, contestId, visibility);
                // Revalidate even when the snapshot cache is warm.
                await getCcsContest(domainId, tid);
                const current = await refresh(domainId, tid, visibility);
                if (endpoint === 'event-feed') {
                    const streamValue = this.args.stream;
                    if (streamValue !== undefined && !['true', 'false', true, false].includes(streamValue)) throw new CcsError(400, 'Invalid stream flag');
                    const streaming = streamValue !== 'false' && streamValue !== false;
                    let token = this.args.since_token == null ? null : String(this.args.since_token);
                    try { await store.validateToken(scope, token); } catch { throw new CcsError(400, 'Invalid event feed token'); }
                    this.response.addHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
                    this.response.type = 'application/x-ndjson';
                    this.response.addHeader('X-Accel-Buffering', 'no');
                    const self = this, cancellation = new AbortController();
                    const body = Readable.from((async function* () {
                        let through = current.revision;
                        try {
                            do {
                                if (self.authenticate(domainId, contestId) !== visibility) throw new CcsError(403, 'CCS authorization changed');
                                const contest = await getCcsContest(domainId, tid);
                                const lockAt = visibility === 'broadcast' && contest.lockAt && !contest.unlocked ? contest.lockAt : null;
                                for await (const event of store.events(scope, token, through)) {
                                    self.authenticate(domainId, contestId);
                                    token = event.token!;
                                    yield `${JSON.stringify(maskBroadcastEvent(event, lockAt))}\n`;
                                }
                                if (!streaming) break;
                                yield '\n'; // heartbeat, also flushes headers for an empty contest
                                await waitForChange(scope, through, cancellation.signal);
                                if (cancellation.signal.aborted) break;
                                self.authenticate(domainId, contestId);
                                through = (await refresh(domainId, tid, visibility)).revision;
                            } while (!cancellation.signal.aborted);
                        } catch { if (!cancellation.signal.aborted) throw new Error('CCS stream interrupted; reconnect with the last token'); }
                    })());
                    if (disposed) { body.destroy(); throw new CcsError(503, 'CCS plugin is shutting down'); }
                    streams.set(body, cancellation);
                    body.once('close', () => { streams.delete(body); cancellation.abort(); });
                    this.response.body = body;
                    return;
                }
                if (endpoint === 'scoreboard') {
                    const contest = current.state.get('contest/')!;
                    const group = this.args.group_id === undefined ? undefined : String(this.args.group_id);
                    if (group !== undefined && !current.state.has(`groups/${group}`)) throw new CcsError(400, 'Invalid group id');
                    this.response.body = { time: current.observedAt.toISOString(), contest_time: duration(+current.observedAt - Date.parse(contest.start_time)),
                        state: current.state.get('state/'), rows: hydroStandings(current.state, group).filter(row => !row.x_unranked).map(({ name: _name, x_order_reliable: _order, x_unranked: _unranked, ...row }) => row) };
                    return;
                }
                if (endpoint === 'access') { this.response.body = { capabilities: [], endpoints: Object.entries(ccsProperties).map(([type, properties]) => ({ type, properties })) }; return; }
                if (!endpoint || endpoint === 'state') { this.response.body = current.state.get(`${endpoint || 'contest'}/`); return; }
                if (!(ccsTypes as readonly string[]).includes(endpoint)) throw new CcsError(404, 'Unsupported endpoint');
                const rows = entities(current.state, endpoint);
                const result = id ? rows.find(row => row.id === id) : rows;
                if (!result) throw new CcsError(404, 'Object not found');
                this.response.body = result;
            } catch (error) {
                const known = error instanceof CcsError;
                this.response.type = 'application/json';
                this.response.status = known ? error.status : 503;
                if (this.response.status === 401) this.response.addHeader('WWW-Authenticate', 'Basic realm="Hydro CCS", charset="UTF-8"');
                this.response.body = { code: this.response.status, message: known ? error.message : 'CCS data unavailable; retry later' };
            }
        }
    }
    const root = '/api/ccs';
    ctx.Route('hydro_ccs_api_info', root, CcsHandler);
    // Hydro registers /api/:op before addons. Give only our exact root route
    // precedence while preserving the middleware layers and route disposal.
    const stack = ctx.server.router.stack;
    const genericApi = stack.findIndex(layer => layer.name === 'api' && layer.path === '/api/:op');
    const info = stack.findIndex(layer => layer.name === 'hydro_ccs_api_info');
    if (genericApi >= 0 && info > genericApi) stack.splice(genericApi, 0, stack.splice(info, 1)[0]);
    // A default endpoint argument distinguishes the collection from /api.
    class CcsContestsHandler extends CcsHandler { async get(args: any) { return super.get({ ...args, endpoint: 'contests' }); } }
    ctx.Route('hydro_ccs_api_contests', `${root}/contests`, CcsContestsHandler);
    ctx.Route('hydro_ccs_api_contest', `${root}/contests/:contestId`, CcsHandler);
    ctx.Route('hydro_ccs_api_endpoint', `${root}/contests/:contestId/:endpoint`, CcsHandler);
    ctx.Route('hydro_ccs_api_object', `${root}/contests/:contestId/:endpoint/:id`, CcsHandler);
    return (handler: Handler) => handler instanceof CcsHandler;
}
