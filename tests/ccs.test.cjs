const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { Readable } = require('node:stream');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const hydroRequire = createRequire(require.resolve('hydrooj/package.json'));
const Router = hydroRequire('@koa/router');
const Koa = hydroRequire('koa');

const { loader } = require('./helpers.cjs');
const load = loader();
const { hydroStandings, diffCcsState, entityKey, maskBroadcastEvent, digest, applyCcsChange } = load('core');
const { CcsFeedStore } = load('store');
const { ccsBasicAuthorized, ccsApiKeyAuthorized, ccsContestAllowlist } = load('auth');
const at = seconds => new Date(Date.parse('2026-11-09T03:00:00Z') + seconds * 1000);
const tid = '691000000000000000000001';
const oid = (seconds, n = 0) => `${Math.floor(+at(seconds) / 1000).toString(16)}${n.toString(16).padStart(16, '0')}`;
const submission = (id, team, seconds, problem = '1', order = 0) => ({ id, team_id: team, problem_id: problem, time: at(seconds).toISOString(), x_hydro_order: order, x_hydro_username: team });
const judgement = (id, status) => ({ id: `hydro-${id}`, submission_id: id, x_hydro_status: status,
    judgement_type_id: ({ 1: 'AC', 2: 'WA', 7: 'CE', 8: 'SE', 9: 'NO', 30: 'IGN', 31: 'FE' })[status] || null });
function state(submissions = [], judgements = [], teams = ['a', 'b']) {
    return new Map([
        ['contest/', { id: tid, start_time: at(0).toISOString(), x_hydro_rules: 'HYDRO_ACM_V1' }],
        ...teams.map(id => [`teams/${id}`, { id, name: id, hidden: false, group_ids: [id === 'star' ? 'observers' : 'participants'] }]),
        ...['1', '2'].map(id => [`problems/${id}`, { id }]),
        ...submissions.map(row => [`submissions/${row.id}`, row]), ...judgements.map(row => [`judgements/${row.id}`, row]),
    ]);
}
function memoryRepository() {
    const commits = new Map(), chunks = new Map();
    return { data: { commits, chunks },
        latest: async scope => [...commits.values()].filter(c => c.scope === scope).sort((a, b) => b.revision - a.revision)[0] || null,
        commits: async (scope, from, through) => [...commits.values()].filter(c => c.scope === scope && c.revision >= from && c.revision <= through).sort((a, b) => a.revision - b.revision).slice(0, 100),
        chunk: async (batch, page) => structuredClone(chunks.get(`${batch}/${page}`) || []),
        writeChunk: async (batch, page, events) => { chunks.set(`${batch}/${page}`, structuredClone(events)); },
        commit: async value => { if (commits.has(value._id)) return false; commits.set(value._id, structuredClone(value)); return true; },
        discard: async batch => { for (const key of chunks.keys()) if (key.startsWith(`${batch}/`)) chunks.delete(key); },
    };
}
const collect = async iterator => { const result = []; for await (const row of iterator) result.push(row); return result; };

test('XCPC ranks preserve seconds, stable journal order, Hydro penalties and star exclusion', () => {
    const submissions = [submission('a1', 'a', 61), submission('a2', 'a', 61, '2'),
        submission('b1', 'b', 60), submission('b2', 'b', 119, '2'), submission('star1', 'star', 1)];
    const rows = hydroStandings(state(submissions, submissions.map(row => judgement(row.id, 1)), ['a', 'b', 'star']));
    assert.equal(rows.find(row => row.team_id === 'a').rank, 1);
    assert.equal(rows.find(row => row.team_id === 'b').rank, 2, 'per-AC minute flooring would incorrectly tie these teams');
    assert.equal(rows.find(row => row.team_id === 'a').x_hydro_total_seconds, 122);
    assert.equal(rows.find(row => row.team_id === 'star').rank, 0);
    for (const [status, expected] of [[0, 1260], [2, 1260], [7, 60], [8, 1260], [9, 60], [30, 1260], [31, 60]]) {
        const sameSecond = state([submission('z-first', 'a', 60, '1', 0), submission('a-second', 'a', 60, '1', 1)],
            [judgement('z-first', status), judgement('a-second', 1)]);
        assert.equal(hydroStandings(sameSecond)[0].x_hydro_total_seconds, expected, `status ${status}`);
    }
});

test('rank transitions have full source bindings; bootstrap and unknown journal order are unavailable', () => {
    const before = state([submission('a', 'a', 70), submission('b', 'b', 80)], [judgement('a', 0), judgement('b', 1)]);
    const next = new Map(before); next.set('judgements/hydro-a', judgement('a', 1));
    const scope = { contestId: tid, visibility: 'admin', observedAt: at(90), initial: false };
    const result = diffCcsState(before, next, scope);
    const rank = result.changes[0].data.x_hydro_rank;
    assert.deepEqual([rank.status, rank.beforeRank, rank.afterRank], ['AVAILABLE', 2, 1]);
    assert.equal(rank.provenance.submissionId, 'a');
    assert.equal(rank.provenance.rules, 'HYDRO_ACM_V1');
    assert.match(rank.provenance.beforeStateHash, /^[a-f\d]{64}$/);
    assert.equal(diffCcsState(result.state, next, scope).changes.length, 0, 'extensions do not generate duplicate events');
    assert.equal(diffCcsState(new Map(), next, { ...scope, initial: true }).changes.find(c => c.id === 'hydro-a').data.x_hydro_rank.reason, 'CCS_INITIAL_SNAPSHOT');
    const uncertain = new Map(before); uncertain.set('submissions/b', { ...before.get('submissions/b'), x_hydro_order: null });
    const uncertainNext = new Map(uncertain); uncertainNext.set('judgements/hydro-a', judgement('a', 1));
    assert.equal(diffCcsState(uncertain, uncertainNext, scope).changes[0].data.x_hydro_rank.status, 'UNAVAILABLE');
    assert.equal(diffCcsState(before, next, { ...scope, visibility: 'broadcast' }).changes[0].data.x_hydro_rank, undefined);
});

test('durable chunks replay identically after restart, resume inside a chunk, and reject foreign/unknown tokens', async () => {
    const repository = memoryRepository(), store = new CcsFeedStore(repository);
    const next = state([], [], Array.from({ length: 420 }, (_, n) => `team${n}`));
    await store.refresh('domain/contest/admin', tid, 'admin', async () => next);
    const first = await collect(store.events('domain/contest/admin', null));
    assert.ok(first.length > 400);
    const restarted = new CcsFeedStore(repository);
    assert.deepEqual(await collect(restarted.events('domain/contest/admin', first[205].token)), first.slice(206));
    assert.deepEqual([...(await restarted.read('domain/contest/admin')).state], [...next]);
    await assert.rejects(restarted.validateToken('different', first[0].token), /INVALID_TOKEN/);
    await assert.rejects(restarted.validateToken('domain/contest/admin', first[0].token.replace(/\.1\.0$/, '.99.0')), /INVALID_TOKEN/);
    await assert.rejects(restarted.validateToken('domain/contest/admin', first[0].token.replace(/\.0$/, '.99999')), /INVALID_TOKEN/);
});

test('concurrent publishers commit once; persisted rank tokens survive restart and rejudge', async () => {
    const repository = memoryRepository(), a = new CcsFeedStore(repository), b = new CcsFeedStore(repository);
    let next = state([submission('a', 'a', 70), submission('b', 'b', 80)], [judgement('a', 0), judgement('b', 1)]);
    await Promise.all([a.refresh('same', tid, 'admin', async () => next), b.refresh('same', tid, 'admin', async () => next)]);
    assert.equal(repository.data.commits.size, 1);
    const baseline = await collect(a.events('same', null));
    next = new Map(next); next.set('judgements/hydro-a', judgement('a', 1));
    await a.refresh('same', tid, 'admin', async () => next);
    const [final] = await collect(b.events('same', baseline.at(-1).token));
    assert.equal(final.data.x_hydro_rank.provenance.eventToken, final.token);
    assert.equal(final.data.x_hydro_rank.beforeRank, 2);
    next = new Map(next); next.set('judgements/hydro-a', judgement('a', 2));
    await b.refresh('same', tid, 'admin', async () => next);
    const all = await collect(new CcsFeedStore(repository).events('same', null));
    assert.deepEqual(all.find(row => row.token === final.token), final, 'rejudge cannot rewrite an old event or its ranks');
    assert.equal(new Set(all.map(row => row.token)).size, all.length);
});

test('failed writes publish nothing, ambiguous commits retain chunks, and missing log revisions fail closed', async () => {
    const repository = memoryRepository(), write = repository.writeChunk, commit = repository.commit;
    repository.writeChunk = async (...args) => { await write(...args); throw new Error('disk failure'); };
    await assert.rejects(new CcsFeedStore(repository).refresh('a', tid, 'admin', async () => state()), /disk failure/);
    assert.equal(repository.data.commits.size, 0); assert.equal(repository.data.chunks.size, 0);
    repository.writeChunk = write;
    repository.commit = async value => { await commit(value); throw new Error('ambiguous network failure'); };
    await assert.rejects(new CcsFeedStore(repository).refresh('a', tid, 'admin', async () => state()), /network failure/);
    assert.equal((await collect(new CcsFeedStore(repository).events('a', null))).length, 5);
    repository.commit = commit;
    const store = new CcsFeedStore(repository);
    for (let n = 0; n < 102; n++) await store.refresh('a', tid, 'admin', async () => state([], [], [`team-${n}`]));
    assert.equal((await new CcsFeedStore(repository).read('a')).revision, 103, 'replay crosses commit pagination');
    repository.data.commits.delete('a/2');
    await assert.rejects(collect(new CcsFeedStore(repository).events('a', null)), /LOG_INCOMPLETE/);
});

test('a judge notification during an in-flight refresh triggers a trailing snapshot', async () => {
    const store = new CcsFeedStore(memoryRepository());
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const reading = new Promise(resolve => { entered = resolve; });
    const first = store.refresh('progress', tid, 'admin', async () => { entered(); await gate; return state(); });
    await reading;
    const next = state([submission('a', 'a', 100)], [judgement('a', 0)]);
    const notification = store.refresh('progress', tid, 'admin', async () => next, true);
    release();
    assert.equal((await first).revision, 1);
    assert.equal((await notification).revision, 2);
    assert.ok((await store.read('progress')).state.has('submissions/a'));
});

test('Basic credentials and explicit contest allowlist reject blank/invalid authorization', () => {
    const basic = `Basic ${Buffer.from('broadcast:secret:with:colons').toString('base64')}`;
    assert.equal(ccsBasicAuthorized(basic, 'broadcast', 'secret:with:colons'), true);
    assert.equal(ccsBasicAuthorized(basic, 'broadcast', ''), false);
    assert.equal(ccsBasicAuthorized(basic, 'broadcast', 'wrong'), false);
    assert.equal(ccsBasicAuthorized('Bearer token', 'broadcast', 'secret'), false);
    assert.deepEqual(ccsContestAllowlist(`system/${tid}, acm/${tid}\nsystem/${tid}`), [`system/${tid}`, `acm/${tid}`]);
    assert.deepEqual(ccsContestAllowlist(''), []);
    assert.throws(() => ccsContestAllowlist(`*/${tid}`), /INVALID/);
});

class ObjectId {
    constructor(value) { this.value = value; }
    toString() { return this.value; }
    toHexString() { return this.value; }
    getTimestamp() { return new Date(parseInt(this.value.slice(0, 8), 16) * 1000); }
}
const domainGroup = (name, uids, id, domainId = 'acm') => ({ name, uids, domainId, _id: new ObjectId(id.toString(16).padStart(24, '0')) });
function fixture() {
    const calls = [], settings = { username: 'broadcast', password: 'secret', contests: `acm/${tid}`, adminApiKey: 'a'.repeat(64) };
    const contest = { docId: new ObjectId(tid), rule: 'acm', title: 'XCPC 公开测试', pids: [1], beginAt: at(0), endAt: at(3600), lockAt: at(1800), unlocked: false };
    const records = [{ _id: new ObjectId(oid(100)), uid: 1, pid: 1, lang: 'cc', status: 1, judgeAt: at(1900), code: 'PRIVATE_CODE' },
        { _id: new ObjectId(oid(1900)), uid: 3, pid: 1, lang: 'cc', status: 1, judgeAt: at(1905), compilerText: 'PRIVATE_LOG' }];
    const participants = [{ uid: 1, journal: [{ rid: records[0]._id, status: 1 }] },
        { uid: 2, members: [3, 5], journal: [{ rid: records[1]._id, status: 1 }] },
        { uid: 4, unrank: true, journal: [] }, { uid: 5, journal: [] }];
    const query = rows => ({ project(projection) {
        calls.push(['project', projection]);
        return query(rows.map(row => {
            const result = {};
            for (const key of Object.keys(projection)) {
                const [root, field] = key.split('.');
                if (field) {
                    if (!Array.isArray(row[root])) continue;
                    result[root] ||= row[root].map(() => ({}));
                    row[root].forEach((value, i) => { result[root][i][field] = value[field]; });
                } else result[key] = row[key];
            }
            return result;
        }));
    },
        sort() { return this; }, toArray: async () => rows.map(row => ({ ...row })) });
    const collections = new Map();
    const collection = name => {
        if (collections.has(name)) return collections.get(name);
        const values = new Map();
        const matches = (row, filter) => Object.entries(filter).every(([key, value]) => value && typeof value === 'object'
            ? row[key] >= value.$gte && row[key] <= value.$lte : row[key] === value);
        const result = { createIndex: async () => {},
            insertOne: async value => { if (values.has(value._id)) throw Object.assign(new Error('duplicate'), { code: 11000 }); values.set(value._id, structuredClone(value)); },
            findOne: async filter => [...values.values()].find(row => matches(row, filter)),
            deleteMany: async filter => { for (const [id, row] of values) if (matches(row, filter)) values.delete(id); },
            find: filter => {
                let rows = [...values.values()].filter(row => matches(row, filter));
                return { sort(order) { const [key, direction] = Object.entries(order)[0]; rows.sort((a, b) => direction * (a[key] - b[key])); return this; },
                    limit(count) { rows = rows.slice(0, count); return this; }, next: async () => rows[0] || null, toArray: async () => rows };
            } };
        collections.set(name, result); return result;
    };
    class Handler {
        args = {}; request = { method: 'get', headers: {} };
        response = { status: 200, headers: {}, addHeader(name, value) { this.headers[name] = value; } };
    }
    const problems = { 1: { docId: 1, title: 'A + B', config: { count: 4 } } };
    const users = { 1: { _id: 1, uname: 'team01', school: 'University', password: 'PRIVATE_PASSWORD' },
        2: { _id: 2, uname: 'Team02', displayName: 'Team 2' }, 3: { _id: 3, uname: 'member03' },
        4: { _id: 4, uname: 'star' }, 5: { _id: 0, uname: 'Unknown User' } };
    const userGroups = [];
    const hydro = { Handler, Context: class {}, ConnectionHandler: class {}, ObjectId, ValidationError: Error,
        BadRequestError: Error, ForbiddenError: Error, CreateError: () => Error, param: () => () => {}, PERM: {}, PRIV: {}, Types: { ObjectId: {} },
        SystemModel: { get: key => settings[key.replace('hydroCcsApi.', '')] },
        SettingModel: { SystemSetting: () => {}, Setting: () => {}, FLAG_SECRET: 1, langs: { cc: { display: 'C++' } } },
        db: { collection }, getAlphabeticId: n => String.fromCharCode(65 + n),
        ContestModel: { get: async (domain, id) => { calls.push(['contest', domain, String(id)]); return contest; },
            getMulti: () => query([contest]), getMultiStatus: () => query(participants) },
        RecordModel: { getMulti: (domain, filter) => { calls.push(['records', domain, filter]); return query(records); } },
        ProblemModel: { getList: async () => structuredClone(problems) },
        UserModel: { getList: async () => users,
            listGroup: async domain => {
                calls.push(['userGroups', domain]);
                return userGroups.filter(group => group.domainId === domain).map(group => ({ ...group, uids: [...group.uids] }));
            } },
    };
    const load = loader(hydro), routes = new Map(), hooks = {}, disposers = [], router = new Router();
    router.use(async (c, next) => { c.set('X-Test-Middleware', 'preserved'); await next(); });
    router.all('api', '/api/:op', c => { c.status = 400; c.body = { error: 'generic API', op: c.params.op }; });
    const ctx = { i18n: { load() {} }, effect: callback => { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); }, on: (event, callback) => { hooks[event] = callback; }, interval: () => {},
        server: { router },
        Route: (name, url, handler) => {
            routes.set(url, handler);
            router.all(name, url, async c => {
                const h = new handler(); h.args = c.query; h.request.headers = c.headers;
                await h.get({ domainId: 'acm', ...c.params });
                c.status = h.response.status; c.type = h.response.type; c.set(h.response.headers); c.body = h.response.body;
            });
            const layer = router.stack.at(-1);
            disposers.push(() => { const i = router.stack.indexOf(layer); if (i >= 0) router.stack.splice(i, 1); });
        } };
    load('settings').registerCcsSettings(ctx);
    const isCcs = load('api').registerCcsApi(ctx);
    const headers = { authorization: `Basic ${Buffer.from('broadcast:secret').toString('base64')}` };
    async function get(endpoint, admin = false, args = {}) {
        const Handler = routes.get('/api/ccs/contests/:contestId/:endpoint');
        const h = new Handler(); h.args = args; h.request.headers = admin ? { 'x-ccs-api-key': 'a'.repeat(64) } : headers;
        await h.get({ domainId: 'acm', contestId: tid, endpoint }); return h;
    }
    return { contest, records, participants, problems, users, userGroups, calls, settings, headers, get, load, routes, hooks, isCcs, hydro, ctx,
        dispose: () => { for (const dispose of disposers.reverse()) dispose(); } };
}

test('CCS root takes precedence over Hydro generic API without bypassing middleware, auth or disposal', async t => {
    const f = fixture(), app = new Koa();
    app.use(f.ctx.server.router.routes());
    const server = app.listen(0, '127.0.0.1');
    t.after(async () => { f.dispose(); server.close(); await once(server, 'close'); });
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const route of ['/api/ccs', '/api/ccs/']) {
        const response = await fetch(base + route, { headers: f.headers });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-test-middleware'), 'preserved');
        assert.equal((await response.json()).provider.name, 'hydro-ccs-api');
    }
    const denied = await fetch(base + '/api/ccs');
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate'), /^Basic /);
    assert.equal((await fetch(base + '/api/unrelated').then(r => r.json())).op, 'unrelated');
    f.dispose();
    assert.equal((await fetch(base + '/api/ccs').then(r => r.json())).error, 'generic API');
});

test('native source exports projected metadata and member ownership; broadcast masks late submissions but keeps prefreeze judgements', async () => {
    const f = fixture(), { readHydroCcsState } = f.load('source');
    const broadcast = await readHydroCcsState('acm', new ObjectId(tid), 'broadcast', new Map(), at(2000));
    const admin = await readHydroCcsState('acm', new ObjectId(tid), 'admin', new Map(), at(2000));
    assert.equal(broadcast.get(`judgements/hydro-${oid(100)}`).judgement_type_id, 'AC');
    assert.equal(broadcast.get(`judgements/hydro-${oid(1900)}`).judgement_type_id, null);
    assert.equal(admin.get(`judgements/hydro-${oid(1900)}`).judgement_type_id, 'AC');
    assert.equal(broadcast.get(`submissions/${oid(1900)}`).team_id, 'Team02');
    assert.equal(broadcast.get(`submissions/${oid(1900)}`).x_hydro_username, 'member03');
    assert.deepEqual(broadcast.get('teams/Team02').x_hydro_usernames, ['Team02', 'member03']);
    assert.equal(broadcast.has('teams/Unknown User'), false);
    assert.equal(broadcast.get('teams/team01').organization_id, digest('University').slice(0, 32));
    assert.equal(broadcast.get('teams/Team02').organization_id, null);
    assert.doesNotMatch(JSON.stringify([...admin]), /PRIVATE_|compilerText|password/);
    assert.equal(f.calls.find(call => call[0] === 'records')[1], 'acm');
    assert.deepEqual(f.calls.find(call => call[0] === 'records')[2], { contest: new ObjectId(tid) });
    f.participants[1].journal[0].status = 0;
    assert.equal((await readHydroCcsState('acm', new ObjectId(tid), 'admin', admin, at(2000))).get(`judgements/hydro-${oid(1900)}`).judgement_type_id, null, 'record result waits for native journal');
    f.contest.rule = 'oi';
    await assert.rejects(readHydroCcsState('acm', new ObjectId(tid), 'admin', admin, at(2000)), /Only fixed-time/);
});

test('organization mappings keep resource IDs, team references and both event feeds consistent', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    t.after(f.dispose);
    f.users[1].school = ' 西华师范大学 ';
    f.users[2].school = '西华师范大学';
    f.users[4].school = 'University';
    f.settings.organizationIds = '{" 西华师范大学 ": "cwnu", "未参赛学校": "unused"}';
    const expected = [{ id: 'cwnu', name: '西华师范大学', formal_name: '西华师范大学' },
        { id: digest('University').slice(0, 32), name: 'University', formal_name: 'University' }];
    for (const admin of [false, true]) {
        assert.deepEqual((await f.get('organizations', admin)).response.body, expected);
        const teams = (await f.get('teams', admin)).response.body;
        assert.deepEqual(teams.map(row => [row.id, row.organization_id]),
            [['team01', 'cwnu'], ['Team02', 'cwnu'], ['star', expected[1].id]]);
        const events = (await collect((await f.get('event-feed', admin, { stream: 'false' })).response.body)).map(JSON.parse);
        assert.deepEqual(events.filter(row => row.type === 'organizations').map(row => [row.id, row.data]), expected.map(row => [row.id, row]));
        assert.deepEqual(events.filter(row => row.type === 'teams').map(row => row.data), teams);
    }
    const Handler = f.routes.get('/api/ccs/contests/:contestId/:endpoint/:id'), handler = new Handler();
    handler.request.headers = f.headers;
    await handler.get({ domainId: 'acm', contestId: tid, endpoint: 'organizations', id: 'cwnu' });
    assert.equal(handler.response.status, 200);
    assert.deepEqual(handler.response.body, expected[0]);
});

test('adding and clearing organization mappings preserves history and resumes from existing tokens', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    t.after(f.dispose);
    f.users[1].school = '西华师范大学';
    const readEvents = async (admin, since_token) => {
        const response = (await f.get('event-feed', admin, { stream: 'false', since_token })).response;
        assert.equal(response.status, 200);
        return (await collect(response.body)).map(JSON.parse);
    };
    const originalId = '887d9c342d7da2cb972d74e2afea6341';
    const baseline = await Promise.all([readEvents(false), readEvents(true)]);
    assert.equal(baseline[0].find(row => row.type === 'organizations').id, originalId);
    for (const [mapping, from, to] of [['{"西华师范大学":"cwnu"}', originalId, 'cwnu'], ['', 'cwnu', originalId]]) {
        f.settings.organizationIds = mapping;
        for (const admin of [false, true]) {
            const history = baseline[Number(admin)], updates = await readEvents(admin, history.at(-1).token);
            assert.deepEqual(updates.map(row => [row.type, row.id, row.data?.organization_id ?? row.data?.id ?? null]),
                [['organizations', from, null], ['organizations', to, to], ['teams', 'team01', to]]);
            assert.deepEqual((await f.get('organizations', admin)).response.body, [{ id: to, name: '西华师范大学', formal_name: '西华师范大学' }]);
            assert.equal((await f.get('teams', admin)).response.body.find(row => row.id === 'team01').organization_id, to);
            history.push(...updates);
            assert.deepEqual(await readEvents(admin), history, 'previous events and tokens are immutable');
            const replay = new Map();
            for (const event of history) applyCcsChange(replay, event);
            assert.equal(replay.has(`organizations/${from}`), false);
            assert.equal(replay.get('teams/team01').organization_id, to);
            assert.equal(replay.get(`organizations/${to}`).id, to);
            assert.deepEqual(await readEvents(admin, history.at(-1).token), []);
        }
    }
});

test('invalid organization settings or collisions with fallback IDs publish no partial changes', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    t.after(f.dispose);
    f.users[1].school = '西华师范大学';
    f.users[2].school = 'University';
    const baseline = (await collect((await f.get('event-feed', false, { stream: 'false' })).response.body)).map(JSON.parse);
    for (const setting of ['{', '{"西华师范大学":"cwnu","University":"cwnu"}',
        JSON.stringify({ 西华师范大学: digest('University').slice(0, 32) })]) {
        f.settings.organizationIds = setting;
        assert.equal((await f.get('organizations')).response.status, 503);
        assert.equal((await f.get('event-feed', false, { stream: 'false' })).response.status, 503);
    }
    f.settings.organizationIds = '';
    const resumed = (await f.get('event-feed', false, { stream: 'false', since_token: baseline.at(-1).token })).response;
    assert.equal(resumed.status, 200);
    assert.deepEqual(await collect(resumed.body), []);
});

test('school and account groups populate resources and both feeds while preserving organization and participation IDs', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    t.after(f.dispose);
    f.users[1].school = '北京电子科技学院';
    f.users[2].school = '北京电子科技学院';
    f.users[4].school = ' 西华师范大学 ';
    f.settings.organizationIds = '{"西华师范大学":"CWNU","北京电子科技学院":"BESTI"}';
    const groups = [
        { id: 'besti_senior', name: '北京电子科技学院老生', schools: ['北京电子科技学院'], teams: ['team01', 'member03'] },
        { id: 'besti_fresh', name: '北京电子科技学院新生', schools: ['北京电子科技学院'], teams: ['Team02', 'star', 'Unknown User'] },
        { id: 'cwnu', name: '西华师范大学', schools: [' 西华师范大学 '] },
        { id: 'xju', name: '新疆大学', schools: ['新疆大学'] },
        { id: 'scun', name: '中南民族大学', schools: ['中南民族大学'] },
    ];
    f.settings.groups = JSON.stringify([
        ...groups.map(group => ({ ...group, contests: [`acm/${tid}`] })),
        { id: 'another_domain', name: 'Other domain', teams: ['team01'], contests: [`system/${tid}`] },
        { id: 'another_contest', name: 'Other contest', teams: ['team01'], contests: ['acm/691000000000000000000002'] },
    ]);
    const expectedGroups = [{ id: 'participants', name: '正式队伍', hidden: false }, { id: 'observers', name: '打星队伍', hidden: false },
        ...groups.map(({ id, name }) => ({ id, name, hidden: false }))];
    for (const admin of [false, true]) {
        assert.deepEqual((await f.get('groups', admin)).response.body, expectedGroups);
        const teams = (await f.get('teams', admin)).response.body;
        assert.deepEqual(teams.map(row => [row.id, row.organization_id, row.group_ids]), [
            ['team01', 'BESTI', ['participants', 'besti_senior']],
            ['Team02', 'BESTI', ['participants', 'besti_fresh']],
            ['star', 'CWNU', ['observers', 'cwnu']],
        ], 'only the team account matches selectors; school and account selectors must both match');
        const events = (await collect((await f.get('event-feed', admin, { stream: 'false' })).response.body)).map(JSON.parse);
        assert.deepEqual(events.filter(row => row.type === 'groups').map(row => [row.id, row.data]), expectedGroups.map(row => [row.id, row]));
        assert.deepEqual(events.filter(row => row.type === 'teams').map(row => row.data), teams);
        assert.ok(events.findLastIndex(row => row.type === 'groups') < events.findIndex(row => row.type === 'teams'));
    }
    const { readHydroCcsState } = f.load('source');
    for (const [domain, contest] of [['system', tid], ['acm', '691000000000000000000003']]) {
        const snapshot = await readHydroCcsState(domain, new ObjectId(contest), 'admin', new Map(), at(2000));
        assert.equal(snapshot.has('groups/cwnu'), false);
        assert.deepEqual(snapshot.get('teams/star').group_ids, ['observers']);
    }
    f.settings.groups = JSON.stringify([{ id: 'global', name: 'Shared group', teams: ['team01'] }]);
    const global = await readHydroCcsState('system', new ObjectId(tid), 'admin', new Map(), at(2000));
    assert.deepEqual(global.get('teams/team01').group_ids, ['participants', 'global']);
});

test('custom group scoreboards preserve star and maintainer exclusions and the observers leaderboard', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    t.after(f.dispose);
    for (const id of [1, 2, 4]) f.users[id].school = '西华师范大学';
    const original = (await f.get('scoreboard', true)).response.body.rows;
    f.settings.groups = '[{"id":"cwnu","name":"西华师范大学","schools":["西华师范大学"]}]';
    assert.deepEqual((await f.get('scoreboard', true)).response.body.rows, original);
    for (const admin of [false, true]) {
        const board = (await f.get('scoreboard', admin, { group_id: 'cwnu' })).response.body;
        assert.deepEqual(board.rows.map(row => [row.team_id, row.rank]), [['team01', 1], ['Team02', 2]]);
        assert.deepEqual((await f.get('scoreboard', admin, { group_id: 'observers' })).response.body.rows.map(row => [row.team_id, row.rank]), [['star', 1]]);
    }
    f.contest.maintainer = [1];
    const filtered = (await f.get('scoreboard', true, { group_id: 'cwnu' })).response.body.rows;
    assert.deepEqual(filtered.map(row => [row.team_id, row.rank]), [['Team02', 1]]);
});

test('custom group and membership changes append resumable events without rewriting history', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    t.after(f.dispose);
    const feed = async (admin, since_token) => {
        const response = (await f.get('event-feed', admin, { stream: 'false', since_token })).response;
        assert.equal(response.status, 200);
        return (await collect(response.body)).map(JSON.parse);
    };
    const history = await Promise.all([feed(false), feed(true)]);
    for (const [groups, expected] of [
        [[{ id: 'besti_fresh', name: '北电新生', teams: ['team01'] }], [['groups', 'besti_fresh'], ['teams', 'team01']]],
        [[{ id: 'besti_fresh', name: '北京电子科技学院新生', teams: ['Team02'] }], [['groups', 'besti_fresh'], ['teams', 'team01'], ['teams', 'Team02']]],
        [[], [['groups', 'besti_fresh'], ['teams', 'Team02']]],
    ]) {
        f.settings.groups = JSON.stringify(groups);
        for (const admin of [false, true]) {
            const prior = history[Number(admin)], updates = await feed(admin, prior.at(-1).token);
            assert.deepEqual(updates.map(row => [row.type, row.id]), expected);
            if (!groups.length) assert.equal(updates[0].data, null);
            prior.push(...updates);
            assert.deepEqual(await feed(admin), prior);
            const replay = new Map();
            for (const event of prior) applyCcsChange(replay, event);
            const currentGroups = (await f.get('groups', admin)).response.body;
            for (const group of currentGroups) assert.deepEqual(replay.get(`groups/${group.id}`), group);
            for (const team of (await f.get('teams', admin)).response.body) {
                assert.deepEqual(replay.get(`teams/${team.id}`), team);
                assert.ok(team.group_ids.every(id => currentGroups.some(group => group.id === id)));
            }
            assert.deepEqual(await feed(admin, prior.at(-1).token), []);
        }
    }
    assert.equal((await f.get('scoreboard', false, { group_id: 'besti_fresh' })).response.status, 400);
});

test('invalid custom groups publish no partial events and recover with the existing token', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    t.after(f.dispose);
    const baseline = (await collect((await f.get('event-feed', false, { stream: 'false' })).response.body)).map(JSON.parse);
    for (const groups of ['{', '{}', '[{"id":"observers","name":"正式队伍","teams":["team01"]}]',
        '[{"id":"all","name":"Missing selectors"}]']) {
        f.settings.groups = groups;
        assert.equal((await f.get('groups')).response.status, 503);
        assert.equal((await f.get('event-feed', false, { stream: 'false' })).response.status, 503);
    }
    f.settings.groups = '';
    const resumed = (await f.get('event-feed', false, { stream: 'false', since_token: baseline.at(-1).token })).response;
    assert.equal(resumed.status, 200);
    assert.deepEqual(await collect(resumed.body), []);
});

test('domain user groups automatically populate both feeds using current team-account membership', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    t.after(f.dispose);
    f.userGroups.push(domainGroup('besti_senior', [1, 3], 1), domainGroup('besti_fresh', [2], 2),
        domainGroup('cwnu', [1, 4], 3), domainGroup('unrelated', [99], 4), domainGroup('empty', [], 5),
        domainGroup('1', [1], 6), domainGroup('member_only', [3], 7), domainGroup('missing_user', [5], 8),
        domainGroup('other_domain', [1], 9, 'system'));
    f.users[1].group = ['stale_user_cache'];
    f.users[2].group = ['besti_senior'];
    const expected = [{ id: 'participants', name: '正式队伍', hidden: false }, { id: 'observers', name: '打星队伍', hidden: false },
        ...['besti_fresh', 'besti_senior', 'cwnu'].map(id => ({ id, name: id, hidden: false }))];
    for (const admin of [false, true]) {
        assert.deepEqual((await f.get('groups', admin)).response.body, expected);
        const teams = (await f.get('teams', admin)).response.body;
        assert.deepEqual(teams.map(row => [row.id, row.group_ids]), [
            ['team01', ['participants', 'besti_senior', 'cwnu']],
            ['Team02', ['participants', 'besti_fresh']],
            ['star', ['observers', 'cwnu']],
        ]);
        const feed = (await collect((await f.get('event-feed', admin, { stream: 'false' })).response.body)).map(JSON.parse);
        assert.deepEqual(feed.filter(row => row.type === 'groups').map(row => row.data), expected);
        assert.deepEqual(feed.filter(row => row.type === 'teams').map(row => row.data), teams);
        assert.ok(feed.findLastIndex(row => row.type === 'groups') < feed.findIndex(row => row.type === 'teams'));
        assert.deepEqual((await f.get('scoreboard', admin, { group_id: 'cwnu' })).response.body.rows.map(row => row.team_id), ['team01']);
        assert.deepEqual((await f.get('scoreboard', admin, { group_id: 'observers' })).response.body.rows.map(row => row.team_id), ['star']);
    }
    assert.ok(f.calls.filter(row => row[0] === 'userGroups').every(row => row[1] === 'acm'));
    const snapshot = await f.load('source').readHydroCcsState('system', new ObjectId(tid), 'admin', new Map(), at(2000));
    assert.equal(snapshot.has('groups/besti_fresh'), false);
    assert.deepEqual(snapshot.get('teams/team01').group_ids, ['participants', 'other_domain']);
});

test('domain group names get safe distinct IDs without overriding built-in participation groups', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    t.after(f.dispose);
    const chinese = domainGroup('北京电子科技学院新生', [2], 100);
    const chineseId = `hydro-group-${chinese._id}`;
    f.userGroups.push(chinese, domainGroup('participants', [4], 101), domainGroup('observers', [1], 102),
        domainGroup(chineseId, [1], 103), domainGroup('group.with.dot', [1], 104), domainGroup('a'.repeat(37), [1], 105));
    const groups = (await f.get('groups')).response.body;
    assert.equal(new Set(groups.map(group => group.id)).size, groups.length);
    assert.ok(groups.every(group => /^(?![-.])(?!.*\.$)[a-zA-Z0-9_.-]{1,36}$/.test(group.id)));
    assert.equal(groups.find(group => group.id === chineseId).name, '北京电子科技学院新生');
    assert.equal(groups.find(group => group.id === 'participants').name, '正式队伍');
    assert.equal(groups.find(group => group.id === 'observers').name, '打星队伍');
    assert.ok(groups.some(group => group.id === `hydro-group-${f.userGroups[3]._id}` && group.name === chineseId));
    assert.ok(groups.some(group => group.id === 'group.with.dot'));
    const teams = (await f.get('teams')).response.body;
    assert.deepEqual(teams.find(team => team.id === 'Team02').group_ids, ['participants', chineseId]);
    assert.deepEqual(teams.find(team => team.id === 'star').group_ids, ['observers', `hydro-group-${f.userGroups[1]._id}`]);
    assert.equal(teams.find(team => team.id === 'team01').group_ids.includes('observers'), false);
    chinese.name = '北电新生';
    const renamed = (await f.get('groups')).response.body;
    assert.equal(renamed.find(group => group.id === chineseId).name, '北电新生', 'generated IDs follow the persistent Hydro group ID');
});

test('domain group membership takes precedence over optional manual groups even after its last member is removed', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    t.after(f.dispose);
    const native = domainGroup('besti_fresh', [2], 1);
    f.userGroups.push(native);
    f.settings.groups = JSON.stringify([
        { id: 'besti_fresh', name: 'Old manual list', teams: ['team01', 'star'] },
        { id: 'extra', name: 'Extra group', teams: ['team01'] },
    ]);
    assert.deepEqual((await f.get('teams')).response.body.map(team => [team.id, team.group_ids]), [
        ['team01', ['participants', 'extra']], ['Team02', ['participants', 'besti_fresh']], ['star', ['observers']],
    ]);
    assert.deepEqual((await f.get('groups')).response.body.find(group => group.id === 'besti_fresh'), { id: 'besti_fresh', name: 'besti_fresh', hidden: false });
    native.uids = [];
    assert.equal((await f.get('groups')).response.body.some(group => group.id === 'besti_fresh'), false);
    assert.ok((await f.get('teams')).response.body.every(team => !team.group_ids.includes('besti_fresh')));
    f.settings.groups = '';
    native.uids = [2];
    assert.deepEqual((await f.get('teams')).response.body.find(team => team.id === 'Team02').group_ids, ['participants', 'besti_fresh']);
});

test('domain membership edits and removals append resumable changes without stale user-cache groups or order noise', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    t.after(f.dispose);
    const fresh = domainGroup('besti_fresh', [1], 1), school = domainGroup('cwnu', [4], 2);
    f.userGroups.push(fresh, school);
    f.users[1].group = ['besti_fresh'];
    const read = async (admin, since_token) => {
        const response = (await f.get('event-feed', admin, { stream: 'false', since_token })).response;
        assert.equal(response.status, 200);
        return (await collect(response.body)).map(JSON.parse);
    };
    const history = await Promise.all([read(false), read(true)]);
    fresh.uids = [2];
    for (const admin of [false, true]) {
        const log = history[Number(admin)], updates = await read(admin, log.at(-1).token);
        assert.deepEqual(updates.map(row => [row.type, row.id, row.data.group_ids]), [
            ['teams', 'team01', ['participants']], ['teams', 'Team02', ['participants', 'besti_fresh']],
        ]);
        log.push(...updates);
    }
    f.userGroups.reverse();
    for (const admin of [false, true]) assert.deepEqual(await read(admin, history[Number(admin)].at(-1).token), []);
    fresh.uids = [];
    f.userGroups.splice(f.userGroups.indexOf(school), 1);
    for (const admin of [false, true]) {
        const log = history[Number(admin)], updates = await read(admin, log.at(-1).token);
        assert.deepEqual(updates.filter(row => row.type === 'groups').map(row => [row.id, row.data]), [['besti_fresh', null], ['cwnu', null]]);
        log.push(...updates);
        assert.deepEqual(await read(admin), log, 'historical events and tokens remain unchanged');
        const replay = new Map();
        for (const event of log) applyCcsChange(replay, event);
        assert.equal(replay.has('groups/besti_fresh'), false);
        assert.equal(replay.has('groups/cwnu'), false);
        for (const team of (await f.get('teams', admin)).response.body) {
            assert.deepEqual(replay.get(`teams/${team.id}`), team);
            assert.equal(team.group_ids.length, 1);
        }
    }
});

test('failed domain group reads do not erase existing group memberships or advance the event cursor', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    t.after(f.dispose);
    f.userGroups.push(domainGroup('besti_fresh', [1], 1));
    const baseline = (await collect((await f.get('event-feed', false, { stream: 'false' })).response.body)).map(JSON.parse);
    const readGroups = f.hydro.UserModel.listGroup;
    f.hydro.UserModel.listGroup = async () => { throw new Error('database unavailable'); };
    assert.equal((await f.get('groups')).response.status, 503);
    assert.equal((await f.get('event-feed', false, { stream: 'false' })).response.status, 503);
    f.hydro.UserModel.listGroup = readGroups;
    const resumed = (await f.get('event-feed', false, { stream: 'false', since_token: baseline.at(-1).token })).response;
    assert.equal(resumed.status, 200);
    assert.deepEqual(await collect(resumed.body), []);
    assert.deepEqual((await f.get('teams')).response.body.find(team => team.id === 'team01').group_ids, ['participants', 'besti_fresh']);
});

test('JSON resources and NDJSON history both honor freeze, including re-locking; API key and broadcast tokens are isolated', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    const score = await f.get('scoreboard');
    assert.equal(score.response.type, 'application/json');
    assert.deepEqual(score.response.body.rows.map(row => row.team_id), ['team01', 'Team02']);
    assert.deepEqual(score.response.body.rows.map(row => row.score.num_solved), [1, 0]);
    assert.deepEqual((await f.get('scoreboard', true)).response.body.rows.map(row => row.score.num_solved), [1, 1]);
    assert.equal((await f.get('scoreboard', false, { group_id: 'unknown' })).response.status, 400);
    assert.deepEqual((await f.get('scoreboard', false, { group_id: 'observers' })).response.body.rows.map(row => [row.team_id, row.rank]), [['star', 1]]);
    const access = (await f.get('access')).response.body;
    assert.ok(access.endpoints.every(row => row.properties.length));
    assert.equal(access.endpoints.some(row => row.type === 'runs'), true);
    const dump = async admin => collect((await f.get('event-feed', admin, { stream: 'false' })).response.body);
    const a = (await dump(true)).map(line => JSON.parse(line));
    let b = (await dump(false)).map(line => JSON.parse(line));
    assert.deepEqual(b.filter(row => row.type === 'teams').map(row => [row.id, row.data.id, row.data.hidden]),
        [['team01', 'team01', false], ['Team02', 'Team02', false], ['star', 'star', false]]);
    assert.equal(b.find(row => row.type === 'groups' && row.id === 'observers').data.hidden, false);
    assert.equal(b.find(row => row.type === 'submissions' && row.id === oid(1900)).data.team_id, 'Team02');
    f.participants[0].unrank = true;
    const updates = (await collect((await f.get('event-feed', false, { stream: 'false', since_token: b.at(-1).token })).response.body)).map(JSON.parse);
    assert.deepEqual(updates.map(row => [row.type, row.id, row.data.hidden, row.data.group_ids]), [['teams', 'team01', false, ['observers']]]);
    assert.deepEqual((await f.get('scoreboard')).response.body.rows.map(row => [row.team_id, row.rank]), [['Team02', 1]]);
    f.participants[0].unrank = false;
    assert.notEqual(a[0].token, b[0].token);
    assert.equal((await f.get('event-feed', false, { stream: 'false', since_token: a[0].token })).response.status, 400);
    f.contest.unlocked = true;
    b = (await dump(false)).map(line => JSON.parse(line));
    assert.equal(b.findLast(row => row.id === `hydro-${oid(1900)}`).data.judgement_type_id, 'AC');
    f.contest.unlocked = false;
    b = (await dump(false)).map(line => JSON.parse(line));
    assert.ok(b.filter(row => row.type === 'judgements' && row.id === `hydro-${oid(1900)}`).every(row => row.data.judgement_type_id === null));
    assert.ok(b.every(row => !row.data?.x_hydro_rank));
    assert.equal(maskBroadcastEvent(a.find(row => row.id === `hydro-${oid(100)}`), at(100)).data.judgement_type_id, 'AC', 'Hydro freeze boundary is strictly after lockAt');
    f.settings.contests = '';
    assert.equal((await f.get('scoreboard')).response.status, 403);
    f.settings.password = '';
    assert.equal((await f.get('scoreboard')).response.status, 401);
});

test('configured contest maintainers are hidden in team events and excluded from both group scoreboards', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    f.contest.owner = 2;
    const feed = async since_token =>
        (await collect((await f.get('event-feed', false, { stream: 'false', since_token })).response.body)).map(JSON.parse);
    const baseline = await feed();
    f.contest.maintainer = [1, 4, 999];
    const changes = await feed(baseline.at(-1).token);
    assert.deepEqual(changes.map(row => [row.type, row.id, row.data.hidden]), [['teams', 'team01', true], ['teams', 'star', true]]);
    const teams = (await f.get('teams', true)).response.body;
    assert.deepEqual(teams.map(team => [team.id, team.hidden]), [['team01', true], ['Team02', false], ['star', true]]);
    for (const group_id of [undefined, 'participants']) {
        const board = (await f.get('scoreboard', false, { group_id })).response.body;
        assert.deepEqual(board.rows.map(row => [row.team_id, row.rank]), [['Team02', 1]]);
    }
    assert.deepEqual((await f.get('scoreboard', false, { group_id: 'observers' })).response.body.rows, []);
    f.contest.maintainer = [];
    assert.deepEqual((await feed(changes.at(-1).token)).map(row => [row.id, row.data.hidden]), [['team01', false], ['star', false]]);
});

test('problem color is exported in resources and emitted on resume when Hydro balloon settings change', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    f.contest.pids = [1, 2, 3, 4];
    const readEvents = async (since_token, admin = false) =>
        (await collect((await f.get('event-feed', admin, { stream: 'false', since_token })).response.body)).map(JSON.parse);
    // Capture an existing event-feed cursor before configuring colors.
    const before = await readEvents();
    f.contest.balloon = { 1: { color: '#963', name: 'Brown' }, 2: '#12Ab34', 3: 'blue' };
    const expected = [['1', 'Brown', '#963'], ['2', '#12Ab34', '#12Ab34'], ['3', 'blue', null], ['4', null, null]];
    const colors = rows => rows.map(({ id, color, rgb }) => [id, color, rgb]);
    assert.deepEqual(colors((await f.get('problems')).response.body), expected);
    const updates = await readEvents(before.at(-1).token);
    assert.ok(updates.every(row => row.type === 'problems' && row.id === row.data.id));
    assert.deepEqual(colors(updates.map(row => row.data)), expected.slice(0, 3));
    assert.deepEqual(colors((await readEvents(undefined, true)).filter(row => row.type === 'problems').map(row => row.data)), expected);
    delete f.contest.balloon[1];
    assert.deepEqual(colors((await readEvents(updates.at(-1).token)).map(row => row.data)), [['1', null, null]]);
    const access = (await f.get('access')).response.body.endpoints.find(row => row.type === 'problems');
    assert.deepEqual(access.properties.slice(-2), ['color', 'rgb']);
});

test('listing, missing contests and unsupported rules return scoped data or explicit errors', async () => {
    const f = fixture();
    const List = f.routes.get('/api/ccs/contests');
    const list = new List(); list.request.headers = f.headers;
    await list.get({ domainId: 'acm' }); assert.equal(list.response.body.length, 1);
    await list.get({ domainId: 'another' }); assert.deepEqual(list.response.body, []);
    assert.equal(f.isCcs(list), true);
    assert.equal(f.isCcs({}), false);
    f.contest.duration = 1;
    assert.equal((await f.get('scoreboard', true)).response.status, 400);
    delete f.contest.duration;
    f.hydro.ContestModel.get = async () => { throw Object.assign(new Error('private upstream detail'), { name: 'ContestNotFoundError' }); };
    const missing = await f.get('scoreboard', true);
    assert.equal(missing.response.status, 404);
    assert.doesNotMatch(JSON.stringify(missing.response.body), /private upstream/);
});

test('local HTTP transport serves JSON, static/resumed NDJSON and cancels live streams; auth errors are JSON', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture(), Handler = f.routes.get('/api/ccs/contests/:contestId/:endpoint');
    const bodies = [];
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost'), handler = new Handler();
        handler.request.headers = req.headers; handler.args = Object.fromEntries(url.searchParams);
        await handler.get({ domainId: 'acm', contestId: tid, endpoint: url.pathname.slice(1) });
        res.writeHead(handler.response.status, { ...handler.response.headers, 'Content-Type': handler.response.type });
        if (handler.response.body instanceof Readable) {
            const body = handler.response.body; bodies.push(body);
            res.on('close', () => body.destroy()); body.on('error', () => res.destroy()); body.pipe(res);
        } else res.end(JSON.stringify(handler.response.body));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { for (const body of bodies) body.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const unauthorized = await fetch(`${base}/scoreboard`);
    assert.equal(unauthorized.status, 401); assert.match(unauthorized.headers.get('www-authenticate'), /Basic/);
    assert.equal((await unauthorized.json()).code, 401);
    const scoreboard = await fetch(`${base}/scoreboard`, { headers: f.headers });
    assert.equal((await scoreboard.json()).rows.length, 2);
    const snapshot = await fetch(`${base}/event-feed?stream=false`, { headers: f.headers });
    assert.match(snapshot.headers.get('content-type'), /application\/x-ndjson/);
    const events = (await snapshot.text()).trim().split('\n').map(JSON.parse);
    const controller = new AbortController();
    const live = await fetch(`${base}/event-feed?since_token=${events.at(-1).token}`, { headers: f.headers, signal: controller.signal });
    const reader = live.body.getReader();
    const heartbeat = await reader.read();
    assert.equal(Buffer.from(heartbeat.value).toString(), '\n');
    const closed = once(bodies.at(-1), 'close');
    controller.abort(); await reader.cancel().catch(() => {});
    await closed;
    const resumed = await fetch(`${base}/event-feed?stream=false&since_token=${events.at(-1).token}`, { headers: f.headers });
    assert.equal(await resumed.text(), '');
});

test('standalone entrypoint registers only CCS routes without contest writes or other application services', async () => {
    const f = fixture();
    f.routes.clear();
    const plugin = f.load('../index');
    assert.equal(plugin.name, 'hydro-ccs-api');
    plugin.apply(f.ctx);
    assert.deepEqual([...f.routes.keys()], [
        '/api/ccs', '/api/ccs/contests', '/api/ccs/contests/:contestId',
        '/api/ccs/contests/:contestId/:endpoint', '/api/ccs/contests/:contestId/:endpoint/:id',
    ]);
    assert.deepEqual(f.calls, []);
    const Info = f.routes.get('/api/ccs'), info = new Info();
    info.request.headers = f.headers;
    await info.get({ domainId: 'acm' });
    assert.deepEqual(info.response.body.provider, { name: 'hydro-ccs-api', version: '1.1.0' });
});

test('independent API key is disabled by default, bounded, constant-time compared and never falls back to Basic', async () => {
    const key = 'a'.repeat(64);
    assert.equal(ccsApiKeyAuthorized(key, key), true);
    for (const configured of [undefined, '', 'short', 'a'.repeat(1025)]) assert.equal(ccsApiKeyAuthorized(key, configured), false);
    for (const header of [undefined, ['a'.repeat(64)], 'b'.repeat(64), 'a'.repeat(1025)]) assert.equal(ccsApiKeyAuthorized(header, key), false);
    for (const invalid of ['a'.repeat(32) + ' b', '密'.repeat(32), 'a'.repeat(32) + '\t']) assert.equal(ccsApiKeyAuthorized(invalid, invalid), false);
    const f = fixture(), Request = f.routes.get('/api/ccs/contests/:contestId/:endpoint');
    const h = new Request();
    h.request.headers = { ...f.headers, 'x-ccs-api-key': 'wrong' };
    await h.get({ domainId: 'acm', contestId: tid, endpoint: 'scoreboard' });
    assert.equal(h.response.status, 401);
    f.settings.adminApiKey = '';
    assert.equal((await f.get('scoreboard', true)).response.status, 401);
    assert.equal((await f.get('scoreboard')).response.status, 200);
    const noHeader = new Request();
    noHeader.args = { password: 'secret', apiKey: key };
    await noHeader.get({ domainId: 'acm', contestId: tid, endpoint: 'scoreboard' });
    assert.equal(noHeader.response.status, 401, 'URL parameters are not credentials');
});

test('allowlist and domain isolation apply equally to unfrozen API-key readers', async () => {
    const f = fixture();
    f.settings.contests = `other/${tid}`;
    assert.equal((await f.get('scoreboard', true)).response.status, 403);
    assert.equal((await f.get('scoreboard')).response.status, 403);
    const List = f.routes.get('/api/ccs/contests'), list = new List();
    list.request.headers = { 'x-ccs-api-key': 'a'.repeat(64) };
    await list.get({ domainId: 'acm' });
    assert.deepEqual(list.response.body, []);
    f.settings.contests = '';
    assert.equal((await f.get('scoreboard', true)).response.status, 403);
    f.settings.contests = '*';
    assert.equal((await f.get('scoreboard', true)).response.status, 503);
});

test('rotating a password revokes an already-open stream at the next heartbeat', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    const baseline = (await collect((await f.get('event-feed', false, { stream: 'false' })).response.body)).map(JSON.parse);
    const body = (await f.get('event-feed', false, { since_token: baseline.at(-1).token })).response.body;
    const iterator = body[Symbol.asyncIterator]();
    t.after(() => body.destroy());
    assert.equal((await iterator.next()).value, '\n');
    f.settings.password = 'rotated-password';
    await assert.rejects(iterator.next(), /CCS stream interrupted/);
});

test('plugin disposal cancels active event feeds and refuses refreshes', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    const baseline = (await collect((await f.get('event-feed', false, { stream: 'false' })).response.body)).map(JSON.parse);
    const body = (await f.get('event-feed', false, { since_token: baseline.at(-1).token })).response.body;
    body.on('error', () => {});
    const iterator = body[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value, '\n');
    const closed = once(body, 'close');
    f.dispose();
    await closed;
    assert.equal(body.destroyed, true);
    assert.equal((await f.get('scoreboard')).response.status, 503);
});

const testCase = (id, subtaskId = 1, status = 1) => ({ id, subtaskId, status, time: 123,
    message: 'PRIVATE_TEST_MESSAGE', input: 'PRIVATE_INPUT', output: 'PRIVATE_OUTPUT', memory: 999 });
const readFeed = async (f, admin = false, since_token) =>
    (await collect((await f.get('event-feed', admin, { stream: 'false', since_token })).response.body)).map(JSON.parse);
const recordNotification = f => ({ ...f.records[0], domainId: 'acm', contest: f.contest.docId });

test('real test-case runs have stable ordinals, safe projections and resumable timestamps', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    f.records[0].status = 20;
    f.records[0].judgeAt = null;
    f.participants[0].journal[0].status = 0;
    f.records[0].testCases = [testCase(3), testCase(3)];
    const first = await readFeed(f);
    const run = first.find(event => event.type === 'runs').data;
    assert.equal(run.judgement_id, `hydro-${oid(100)}`);
    assert.equal(run.ordinal, 1);
    assert.equal(run.run_time, 0.123);
    assert.equal(run.x_hydro_time_source, 'CCS_OBSERVED');
    assert.equal(first.find(event => event.type === 'problems').data.test_data_count, 4);
    assert.equal(first.filter(event => event.type === 'runs').length, 1, 'duplicate case callbacks do not advance progress twice');
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE_|"memory"|"message"|"input"|"output"/);
    const projected = f.calls.find(call => call[0] === 'project' && call[1]['testCases.id'])[1];
    assert.equal(projected['testCases.time'], 1);
    assert.equal(projected.testCases, undefined, 'test messages and other private fields are not fetched');
    t.mock.timers.tick(1000);
    assert.deepEqual(await readFeed(f, false, first.at(-1).token), [], 'unchanged reads retain per-case observation times');
    f.records[0].testCases.push(testCase(1), testCase(1, 2));
    const updates = await readFeed(f, false, first.at(-1).token);
    const runs = (await f.get('runs')).response.body;
    assert.deepEqual(runs.map(row => row.ordinal), [1, 2, 3]);
    assert.equal(updates.filter(event => event.type === 'runs').length, 2);
    assert.equal(runs[0].time, run.time);
    const Handler = f.routes.get('/api/ccs/contests/:contestId/:endpoint/:id'), single = new Handler();
    single.request.headers = f.headers;
    await single.get({ domainId: 'acm', contestId: tid, endpoint: 'runs', id: run.id });
    assert.deepEqual(single.response.body, run);
    // Recreate the API/store over the same repository to exercise durable state.
    f.dispose();
    f.load('api').registerCcsApi(f.ctx);
    f.records[0].testCases.reverse();
    assert.deepEqual(await readFeed(f, false, updates.at(-1).token), []);
    assert.deepEqual((await f.get('runs')).response.body.map(row => [row.id, row.ordinal]).sort(), runs.map(row => [row.id, row.ordinal]).sort());
    assert.deepEqual((await readFeed(f)).slice(first.length), updates);
    f.records[0].testCases.push(testCase(3, 1, 2));
    const corrected = await readFeed(f, false, updates.at(-1).token);
    assert.equal(corrected.length, 1);
    assert.equal(corrected[0].id, run.id);
    assert.equal(corrected[0].data.judgement_type_id, 'WA');
    assert.equal((await f.get('runs')).response.body.length, 3);
    f.dispose();
});

test('live feed wakes for each observed test case and reports the final verdict after the journal settles', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(1000) });
    const f = fixture();
    Object.assign(f.records[0], { status: 0, judgeAt: null, testCases: [] });
    f.participants[0].journal[0].status = 0;
    const baseline = await readFeed(f);
    const body = (await f.get('event-feed', false, { since_token: baseline.at(-1).token })).response.body;
    const iterator = body[Symbol.asyncIterator]();
    t.after(() => { body.destroy(); f.dispose(); });
    const events = [];
    async function until(predicate) {
        let timeout;
        try {
            return await Promise.race([
                (async () => {
                    for (;;) {
                        const item = await iterator.next();
                        assert.equal(item.done, false);
                        if (!item.value.trim()) continue;
                        const event = JSON.parse(item.value); events.push(event);
                        if (predicate(event)) return event;
                    }
                })(),
                new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('feed waited for the 2-second poll')), 1000); }),
            ]);
        } finally { clearTimeout(timeout); }
    }
    assert.equal((await iterator.next()).value, '\n');
    f.records[0].status = 21;
    await f.hooks['record/change'](recordNotification(f));
    assert.equal((await until(event => event.type === 'judgements')).data.x_hydro_status, 21);
    const liveRuns = new Map();
    for (const id of [1, 2, 3, 4]) {
        f.records[0].status = 20;
        f.records[0].testCases.push(testCase(id));
        await f.hooks['record/change'](recordNotification(f));
        const event = await until(event => event.type === 'runs');
        liveRuns.set(event.id, event.data);
        assert.equal(liveRuns.size / 4, id / 4, 'same progress calculation as the ICPC Live CLICS parser');
    }
    f.records[0].status = 1;
    f.records[0].judgeAt = at(1001);
    await f.hooks['record/change'](recordNotification(f));
    assert.ok(events.filter(event => event.type === 'judgements').every(event => event.data.judgement_type_id === null));
    f.participants[0].journal[0].status = 1;
    await f.hooks['record/judge'](recordNotification(f));
    const final = await until(event => event.type === 'judgements' && event.data.judgement_type_id === 'AC');
    assert.equal(final.data.end_time, at(1001).toISOString());
    assert.deepEqual(await readFeed(f, false, final.token), []);
});

test('freeze hides runs in current resources and history, and thaw restores them', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    f.records[0].testCases = [testCase(1)];
    f.records[1].testCases = [testCase(1), testCase(2)];
    const lateJudgement = `hydro-${oid(1900)}`;
    assert.equal((await f.get('runs')).response.body.length, 1);
    assert.equal((await f.get('runs', true)).response.body.length, 3);
    f.contest.unlocked = true;
    const thawed = await readFeed(f);
    const lateRuns = thawed.filter(event => event.type === 'runs' && event.data?.judgement_id === lateJudgement);
    assert.equal(lateRuns.length, 2);
    f.contest.unlocked = false;
    const frozen = await readFeed(f);
    for (const run of lateRuns) assert.ok(frozen.filter(event => event.id === run.id).every(event => event.data === null));
    const resumed = await readFeed(f, false, thawed.at(-1).token);
    assert.equal(resumed.filter(event => event.type === 'runs' && event.data === null).length, 2);
    f.contest.lockAt = at(100);
    assert.equal((await f.get('runs')).response.body.length, 1, 'submission at lockAt remains visible');
    f.contest.lockAt = at(99);
    assert.deepEqual((await f.get('runs')).response.body, []);
    assert.ok((await readFeed(f)).filter(event => event.type === 'runs').every(event => event.data === null));
    f.contest.unlocked = true;
    assert.equal((await f.get('runs')).response.body.length, 3);
    f.dispose();
});

test('rejudging deletes old runs, resets live progress, and retains native journal scoring until updated', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    f.records[0].testCases = [testCase(2), testCase(1)];
    const first = await readFeed(f);
    const oldRuns = first.filter(event => event.type === 'runs');
    Object.assign(f.records[0], { status: 0, judgeAt: null, testCases: [] });
    await f.hooks['record/change'](recordNotification(f));
    const reset = await readFeed(f, false, first.at(-1).token);
    assert.deepEqual(reset.filter(event => event.type === 'runs').map(event => [event.id, event.data]), oldRuns.map(event => [event.id, null]));
    assert.equal(reset.find(event => event.type === 'judgements').data.judgement_type_id, null);
    assert.equal((await f.get('scoreboard')).response.body.rows.find(row => row.team_id === 'team01').score.num_solved, 1);
    t.mock.timers.tick(1000);
    f.records[0].status = 20;
    f.records[0].testCases = [testCase(1)];
    await f.hooks['record/change'](recordNotification(f));
    const progress = (await f.get('runs')).response.body;
    assert.equal(progress.length, 1);
    assert.equal(progress[0].ordinal, 2, 'ordinal survives a different completion order on rejudge');
    assert.notEqual(progress[0].time, oldRuns.find(event => event.id === progress[0].id).data.time);
    Object.assign(f.records[0], { status: 2, judgeAt: at(2002) });
    const pending = (await f.get('judgements')).response.body.find(row => row.id === `hydro-${oid(100)}`);
    assert.equal(pending.judgement_type_id, null, 'an old journal AC must not finish an ongoing rejudge');
    f.participants[0].journal[0].status = 2;
    await f.hooks['record/judge'](recordNotification(f));
    assert.equal((await f.get('judgements')).response.body.find(row => row.id === pending.id).judgement_type_id, 'WA');
    assert.equal((await f.get('scoreboard')).response.body.rows.find(row => row.team_id === 'team01').score.num_solved, 0);
    f.dispose();
});

test('unknown test counts, unavailable cases and invalid case reports never fabricate progress', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: +at(2000) });
    const f = fixture();
    f.records[0].testCases = [testCase(1)];
    for (const config of ['Cannot parse: invalid config', { count: 0 }, { count: -1 }, { count: 1.5 }, {}]) {
        f.problems[1].config = config;
        assert.deepEqual((await f.get('runs')).response.body, []);
        assert.equal((await f.get('problems')).response.body[0].test_data_count, undefined);
    }
    f.problems[1].config = { count: 4 };
    f.records[0].testCases = [testCase(0), testCase(-1), testCase(1, -1), testCase(1, 1, 20),
        { ...testCase(2), time: NaN }, { ...testCase(2), time: -1 }];
    assert.deepEqual((await f.get('runs')).response.body, []);
    f.records[0].testCases = [];
    f.records[0].progress = 75;
    assert.deepEqual((await f.get('runs')).response.body, [], 'a percentage alone cannot invent individual test verdicts');
    const before = f.calls.length;
    await f.hooks['record/change']({ ...recordNotification(f), domainId: 'another' });
    assert.equal(f.calls.length, before);
    f.settings.contests = '';
    await f.hooks['record/change'](recordNotification(f));
    assert.equal(f.calls.length, before);
    f.dispose();
});
