import { createHash } from 'node:crypto';

export type CcsObject = Record<string, any>;
export type CcsChange = { type: string; id: string | null; data: CcsObject | null; token?: string };
export type CcsState = Map<string, CcsObject>;
export const ccsTypes = ['contest', 'state', 'judgement-types', 'languages', 'groups', 'organizations', 'teams', 'problems', 'submissions', 'judgements', 'runs'] as const;
export const entityKey = (type: string, id: string | null) => `${type}/${id || ''}`;
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const entities = (state: CcsState, type: string) => [...state.entries()].filter(([key]) => key.startsWith(`${type}/`)).map(([, value]) => value);
export function applyCcsChange(state: CcsState, change: CcsChange) {
    const key = entityKey(change.type, change.id);
    if (change.data === null) state.delete(key); else state.set(key, change.data);
}
export function duration(milliseconds: number) {
    const negative = milliseconds < 0 ? '-' : '', ms = Math.abs(Math.trunc(milliseconds));
    return `${negative}${Math.floor(ms / 3600000)}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
export const hydroVerdicts: Record<number, string> = { 1: 'AC', 2: 'WA', 3: 'TLE', 4: 'MLE', 5: 'OLE', 6: 'RTE', 7: 'CE', 8: 'SE', 9: 'NO', 10: 'FAILED', 11: 'HK', 30: 'IGN', 31: 'FE' };
export const judgementTypes = Object.entries(hydroVerdicts).map(([status, id]) => ({ id, name: id, solved: id === 'AC', penalty: ![1, 7, 9, 31].includes(Number(status)) }));

// Reapply the current freeze to historical broadcast events as well. This
// prevents a replay from exposing old results after an organizer moves the
// freeze earlier or locks an already thawed contest again.
export function maskBroadcastEvent(event: CcsChange, lockAt: Date | null): CcsChange {
    if (!lockAt || !['judgements', 'runs'].includes(event.type) || !event.data) return event;
    const id = event.type === 'runs' ? /^hydro-([a-f\d]{24})$/.exec(event.data.judgement_id)?.[1] : event.data.submission_id;
    const submittedAt = typeof id === 'string' && /^[a-f\d]{24}$/.test(id) ? parseInt(id.slice(0, 8), 16) * 1000 : Infinity;
    if (submittedAt <= +lockAt) return event;
    // A masked run must not count towards a client's progress bar. Retain the
    // token as a deletion, including when replaying a previously unfrozen log.
    if (event.type === 'runs') return { ...event, data: null };
    const { x_hydro_rank: _privateRank, ...data } = event.data;
    return { ...event, data: { ...data, judgement_type_id: null, end_time: null, end_contest_time: null, x_hydro_status: 0,
        ...(data.x_hydro_journal_status === undefined ? {} : { x_hydro_journal_status: 0 }) } };
}

/** Mirrors Hydro RULES.acm.stat: seconds (not minute-floor), 20 minutes for
 * statuses other than AC/CE/FORMAT_ERROR/CANCELED, including pending and SE.
 * Journal ordinal disambiguates records created in the same ObjectId second. */
export function hydroStandings(state: CcsState, groupId?: string) {
    const contest = state.get('contest/');
    if (!contest || contest.x_hydro_rules !== 'HYDRO_ACM_V1') throw new Error('UNSUPPORTED_XCPC_RULES');
    const problems = entities(state, 'problems');
    const judgements = new Map(entities(state, 'judgements').map(row => [row.submission_id, row]));
    const byTeam = new Map<string, CcsObject[]>();
    for (const submission of entities(state, 'submissions')) {
        const rows = byTeam.get(submission.team_id) || []; rows.push(submission); byTeam.set(submission.team_id, rows);
    }
    const teams = entities(state, 'teams').filter(team => !groupId || team.group_ids?.includes(groupId));
    const rows = teams.map(team => {
        let solved = 0, seconds = 0, orderReliable = true;
        const submissions = (byTeam.get(team.id) || []).sort((a, b) => Date.parse(a.time) - Date.parse(b.time)
            || (a.x_hydro_order ?? Number.MAX_SAFE_INTEGER) - (b.x_hydro_order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
        const scores = problems.map(problem => {
            let penalties = 0, judged = 0, pending = 0, acceptedAt: number | null = null;
            for (const submission of submissions.filter(row => row.problem_id === problem.id)) {
                if (acceptedAt !== null) break;
                const judgement = judgements.get(submission.id), status = judgement?.x_hydro_journal_status ?? judgement?.x_hydro_status ?? 0;
                if (!Number.isInteger(submission.x_hydro_order)) orderReliable = false;
                if (hydroVerdicts[status]) judged++; else pending++;
                if (![1, 7, 9, 31].includes(status)) penalties++;
                if (status === 1) {
                    acceptedAt = Math.floor((Date.parse(submission.time) - Date.parse(contest.start_time)) / 1000);
                    solved++; seconds += acceptedAt + 1200 * penalties;
                }
            }
            return { problem_id: problem.id, num_judged: judged, num_pending: pending, solved: acceptedAt !== null,
                ...(acceptedAt === null ? {} : { time: Math.floor(acceptedAt / 60), x_hydro_time_seconds: acceptedAt }) };
        });
        return { team_id: team.id, rank: 0, score: { num_solved: solved, total_time: Math.floor(seconds / 60) },
            x_hydro_total_seconds: seconds, x_order_reliable: orderReliable, x_unranked: team.hidden === true || (!groupId && Boolean(team.group_ids?.includes('observers'))),
            name: team.name, problems: scores };
    });
    rows.sort((a, b) => b.score.num_solved - a.score.num_solved || a.x_hydro_total_seconds - b.x_hydro_total_seconds || String(a.name).localeCompare(String(b.name), 'en-US'));
    let count = 0, previous: typeof rows[number] | undefined;
    for (const row of rows) {
        if (row.x_unranked) continue;
        count++;
        row.rank = previous && previous.score.num_solved === row.score.num_solved && previous.x_hydro_total_seconds === row.x_hydro_total_seconds ? previous.rank : count;
        previous = row;
    }
    return rows;
}

const semantic = (value: CcsObject) => { const { x_hydro_rank: _rank, ...data } = value; return data; };

/** Persist changes in a deterministic observation order. The extension on a
 * final judgement records its immutable before/after rank at the CCS source. */
export function diffCcsState(previous: CcsState, next: CcsState, scope: { contestId: string; visibility: 'admin' | 'broadcast'; observedAt: Date; initial: boolean }) {
    const working = new Map(previous), changes: CcsChange[] = [];
    // Reverse dependency order for deletions, then forward order for upserts.
    for (const type of [...ccsTypes].reverse()) for (const [key, value] of working) {
        if (!key.startsWith(`${type}/`) || next.has(key)) continue;
        const change = { type, id: ['contest', 'state'].includes(type) ? null : String(value.id), data: null };
        changes.push(change); applyCcsChange(working, change);
    }
    for (const type of ccsTypes) for (const [key, source] of next) {
        if (!key.startsWith(`${type}/`)) continue;
        const old = working.get(key);
        if (old && digest(semantic(old)) === digest(semantic(source))) continue;
        const data = { ...source };
        const change = { type, id: ['contest', 'state'].includes(type) ? null : String(data.id), data };
        if (type === 'judgements' && data.judgement_type_id && scope.visibility === 'admin') {
            const submission = working.get(`submissions/${data.submission_id}`);
            const before = hydroStandings(working);
            applyCcsChange(working, change);
            const after = hydroStandings(working);
            const a = before.find(row => row.team_id === submission?.team_id), b = after.find(row => row.team_id === submission?.team_id);
            const available = !scope.initial && a && b && !a.x_unranked && !b.x_unranked && before.every(row => row.x_unranked || row.x_order_reliable) && after.every(row => row.x_unranked || row.x_order_reliable);
            data.x_hydro_rank = { version: 1, status: available ? 'AVAILABLE' : 'UNAVAILABLE',
                source: 'HYDRO_CCS_OBSERVED_ORDER', beforeRank: available ? a.rank : null, afterRank: available ? b.rank : null,
                observedAt: scope.observedAt.toISOString(), reason: available ? undefined : scope.initial ? 'CCS_INITIAL_SNAPSHOT' : 'UNRANKED_OR_JOURNAL_ORDER_UNAVAILABLE',
                provenance: { contestId: scope.contestId, teamId: submission?.x_hydro_username || '', ccsTeamId: submission?.team_id,
                    submissionId: data.submission_id, judgementId: data.id, verdict: data.judgement_type_id,
                    rules: 'HYDRO_ACM_V1', visibility: 'UNFROZEN_ADMIN', ordering: 'CCS_PERSISTED_OBSERVATION_ORDER',
                    beforeStateHash: digest(before), afterStateHash: digest(after),
                    caveat: 'Ranks bracket this CCS observation, not the original Hydro database transaction.' } };
        }
        changes.push(change); applyCcsChange(working, change);
    }
    return { changes, state: working };
}
