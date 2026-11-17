import { ContestModel, getAlphabeticId, ObjectId, ProblemModel, RecordModel, SettingModel, UserModel, type Context } from 'hydrooj';
import { digest, duration, entityKey, hydroVerdicts, judgementTypes, type CcsObject, type CcsState } from './core';
import { addCcsRuns } from './runs';
import { ccsOrganizationIds } from './organizations';
import { ccsSetting } from './settings';
import { ccsDomainGroups, ccsGroups, ccsTeamGroupIds, type CcsGroupRequest, type CcsGroupRule } from './groups';

export class CcsError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
export function assertXcpc(contest: any) {
    if (!contest) throw new CcsError(404, 'Contest not found');
    if (contest.rule !== 'acm' || contest.duration) throw new CcsError(400, 'Only fixed-time Hydro XCPC (acm) contests are supported');
}
export async function getCcsContest(domainId: string, tid: ObjectId) {
    try {
        const contest = await ContestModel.get(domainId, tid);
        assertXcpc(contest);
        return contest;
    } catch (error) {
        if ((error as Error)?.name === 'ContestNotFoundError') throw new CcsError(404, 'Contest not found');
        throw error;
    }
}

export function contestObject(contest: any) {
    assertXcpc(contest);
    return { id: String(contest.docId || contest._id), name: contest.title, formal_name: contest.title,
        start_time: contest.beginAt.toISOString(), end_time: contest.endAt.toISOString(), duration: duration(+contest.endAt - +contest.beginAt),
        scoreboard_type: 'pass-fail', penalty_time: 20,
        scoreboard_freeze_duration: contest.lockAt ? duration(Math.max(0, +contest.endAt - +contest.lockAt)) : null,
        x_hydro_rules: 'HYDRO_ACM_V1', x_hydro_time_unit: 'seconds' };
}

export async function readHydroCcsState(domainId: string, tid: ObjectId, visibility: 'admin' | 'broadcast', previous: CcsState,
    now = new Date(), ctx?: Pick<Context, 'parallel'>) {
    const contest = await getCcsContest(domainId, tid);
    let organizationIds: Map<string, string>;
    try { organizationIds = ccsOrganizationIds(ccsSetting('organizationIds')); }
    catch { throw new CcsError(503, 'CCS organization ID mapping is invalid'); }
    let groups: CcsGroupRule[];
    try { groups = ccsGroups(ccsSetting('groups')).filter(group => !group.contests || group.contests.includes(`${domainId}/${tid}`)); }
    catch { throw new CcsError(503, 'CCS custom group configuration is invalid'); }
    const [participants, records, problems, domainGroups] = await Promise.all([
        ContestModel.getMultiStatus(domainId, { docId: tid }).project({ uid: 1, attend: 1, unrank: 1, members: 1, journal: 1 }).toArray(),
        RecordModel.getMulti(domainId, { contest: tid }).project({ _id: 1, uid: 1, pid: 1, lang: 1, status: 1, judgeAt: 1,
            'testCases.id': 1, 'testCases.subtaskId': 1, 'testCases.status': 1, 'testCases.time': 1 }).sort({ _id: 1 }).toArray(),
        // getList resolves referenced problems and parses their test configuration.
        ProblemModel.getList(domainId, contest.pids, true, false, ['docId', 'title', 'config']),
        UserModel.listGroup(domainId),
    ]);
    const uids = [...new Set<number>(participants.flatMap(row => [row.uid, ...(row.members || [])]).concat(records.map(row => row.uid)))];
    const users = uids.length ? await UserModel.getList(domainId, uids) : {};
    const teamUids = new Set<number>(participants.filter(row => users[row.uid]?._id === row.uid && users[row.uid].uname).map(row => row.uid));
    const extension: CcsGroupRequest = { domainId, contestId: String(tid),
        teams: [...teamUids].map(uid => ({ uid, id: users[uid].uname, user: users[uid] })), groups: [] };
    await ctx?.parallel('hydro-ccs-api/groups', extension);
    let provided: CcsGroupRule[];
    try {
        if (!Array.isArray(extension.groups)) throw new Error('Expected group array');
        provided = ccsGroups(JSON.stringify(extension.groups))
            .filter(group => !group.contests || group.contests.includes(`${domainId}/${tid}`))
            .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    }
    catch { throw new CcsError(503, 'CCS group provider returned invalid groups'); }
    const providedIds = new Set(provided.map(group => group.id));
    groups = [...provided, ...groups.filter(group => !providedIds.has(group.id))];
    const nativeGroups = ccsDomainGroups(domainGroups, teamUids);
    // An existing domain group owns its membership even if it currently has
    // no contest teams; old manual lists must not re-add removed members.
    const nativeGroupIds = new Set(nativeGroups.map(group => group.id));
    groups = groups.filter(group => !nativeGroupIds.has(group.id));
    const state: CcsState = new Map();
    const add = (type: string, data: CcsObject) => state.set(entityKey(type, ['contest', 'state'].includes(type) ? null : data.id), data);
    add('contest', contestObject(contest));
    const oldState = previous.get('state/');
    add('state', { started: now >= contest.beginAt ? contest.beginAt.toISOString() : null,
        ended: now >= contest.endAt ? contest.endAt.toISOString() : null,
        frozen: contest.lockAt && now > contest.lockAt ? contest.lockAt.toISOString() : null,
        thawed: contest.lockAt && contest.unlocked && now > contest.lockAt ? oldState?.thawed || now.toISOString() : null,
        finalized: null, end_of_updates: null });
    for (const row of judgementTypes) add('judgement-types', row);
    for (const id of new Set([...Object.keys(SettingModel.langs || {}).filter(id => !SettingModel.langs[id]?.disabled), ...records.map(row => row.lang || 'unknown')])) {
        add('languages', { id, name: SettingModel.langs?.[id]?.display || id });
    }
    add('groups', { id: 'participants', name: '正式队伍', hidden: false });
    add('groups', { id: 'observers', name: '打星队伍', hidden: false });
    for (const group of nativeGroups) if (group.uids.size) add('groups', { id: group.id, name: group.name, hidden: false });
    for (const group of groups) add('groups', { id: group.id, name: group.name, hidden: false });
    const maintainers = new Set(contest.maintainer || []);
    const teamIds = new Map<number, string>();
    const owner = new Map<number, number>(), journal = new Map<string, { uid: number; order: number; status: number }>();
    for (const participant of participants) {
        const uid = participant.uid, user = users[uid];
        // Hydro substitutes its default user when the real account is missing.
        if (user?._id !== uid || !user.uname) continue;
        teamIds.set(uid, user.uname);
        owner.set(uid, uid);
        for (const member of participant.members || []) owner.set(member, uid);
        (participant.journal || []).forEach((entry: any, order: number) => journal.set(String(entry.rid), { uid, order, status: entry.status }));
        const school = String(user?.school || '').trim();
        const organizationId = school ? organizationIds.get(school) ?? digest(school).slice(0, 32) : null;
        if (organizationId) {
            // A configured ID must not overwrite another school's fallback hash.
            const existing = state.get(entityKey('organizations', organizationId));
            if (existing && existing.name !== school) throw new CcsError(503, 'CCS organization IDs conflict');
            add('organizations', { id: organizationId, name: school, formal_name: school });
        }
        add('teams', { id: user.uname, label: String(user.seat || uid), name: user.displayName || user.uname,
            organization_id: organizationId, group_ids: [participant.unrank ? 'observers' : 'participants',
                ...nativeGroups.filter(group => group.uids.has(uid)).map(group => group.id), ...ccsTeamGroupIds(groups, school, user.uname)], hidden: maintainers.has(uid),
            x_hydro_username: user.uname,
            x_hydro_usernames: [...new Set([uid, ...(participant.members || [])].filter(id => users[id]?._id === id).map(id => users[id].uname))] });
    }
    for (const [ordinal, pid] of contest.pids.entries()) {
        const label = getAlphabeticId(ordinal), balloon = contest.balloon?.[pid];
        const configuredColor = typeof balloon === 'string' ? balloon : balloon?.color;
        const color = typeof configuredColor === 'string' ? configuredColor.trim() : '';
        const colorName = typeof balloon === 'object' && typeof balloon?.name === 'string' ? balloon.name.trim() : '';
        const problem = problems[pid], count = typeof problem?.config === 'object' ? problem.config?.count : undefined;
        const knownCount = Number.isSafeInteger(count) && count! > 0;
        add('problems', { id: String(pid), label, ordinal, name: problem?.title || label,
            ...(knownCount ? { test_data_count: count,
                x_hydro_testcase_order: [...(previous.get(`problems/${pid}`)?.x_hydro_testcase_order || [])].slice(0, count) } : {}),
            color: colorName || color || null, rgb: /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color) ? color : null });
    }
    const frozen = visibility === 'broadcast' && contest.lockAt && now > contest.lockAt && !contest.unlocked;
    for (const record of records) {
        const id = record._id.toHexString(), entry = journal.get(id), uid = entry?.uid ?? owner.get(record.uid);
        const submittedAt = record._id.getTimestamp();
        const teamId = uid === undefined ? undefined : teamIds.get(uid);
        if (!teamId || !contest.pids.includes(record.pid) || submittedAt < contest.beginAt || submittedAt >= contest.endAt || submittedAt > now) continue;
        add('submissions', { id, team_id: teamId, problem_id: String(record.pid), language_id: record.lang || 'unknown',
            time: submittedAt.toISOString(), contest_time: duration(+submittedAt - +contest.beginAt),
            x_hydro_order: entry?.order ?? null, x_hydro_username: users[record.uid]?._id === record.uid ? users[record.uid].uname : '' });
        const withheld = frozen && contest.lockAt && submittedAt > contest.lockAt;
        // The native scoreboard is based on the journal. Record and journal
        // updates are not atomic: wait for the journal when a result is newer.
        const judgementId = `hydro-${id}`, old = previous.get(`judgements/${judgementId}`);
        const journalStatus = withheld ? 0 : entry?.status ?? record.status;
        const active = [0, 20, 21, 22].includes(record.status);
        const status = withheld ? 0 : active ? record.status
            : entry && entry.status !== record.status && old && !old.judgement_type_id ? old.x_hydro_status : journalStatus;
        const verdict = hydroVerdicts[status] || null;
        const end = verdict ? (record.status === status ? record.judgeAt?.toISOString() : null) || (old?.x_hydro_status === status ? old?.end_time : null) || now.toISOString() : null;
        const judgement = { id: judgementId, submission_id: id, judgement_type_id: verdict,
            start_time: submittedAt.toISOString(), start_contest_time: duration(+submittedAt - +contest.beginAt),
            end_time: end, end_contest_time: end ? duration(Date.parse(end) - +contest.beginAt) : null,
            x_hydro_status: status, x_hydro_journal_status: journalStatus };
        add('judgements', judgement);
        if (!withheld) addCcsRuns(state, previous, record, judgement, String(record.pid), now);
    }
    if (visibility === 'broadcast') {
        const latest = await getCcsContest(domainId, tid);
        const policy = (value: any) => digest([value.rule, value.beginAt, value.endAt, value.lockAt, value.unlocked, value.maintainer]);
        if (policy(latest) !== policy(contest)) throw new CcsError(503, 'Contest visibility changed; retry');
    }
    return state;
}
