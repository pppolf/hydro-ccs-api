import type { GDoc } from 'hydrooj';

/** Read membership from domain groups, without relying on cached User.group. */
export function ccsDomainGroups(groups: GDoc[], teamUids: ReadonlySet<number>) {
    return groups.filter(group => !Number.isSafeInteger(+group.name)).map(group => {
        // CLICS IDs are ASCII and at most 36 characters. Reserve the generated
        // namespace so even a user group named after another group's ID is safe.
        const useName = /^(?![-.])(?!.*\.$)[a-zA-Z0-9_.-]{1,36}$/.test(group.name)
            && !['participants', 'observers'].includes(group.name) && !group.name.startsWith('hydro-group-');
        return { id: useName ? group.name : `hydro-group-${group._id}`, name: group.name,
            uids: new Set(group.uids.filter(uid => teamUids.has(uid))) };
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export type CcsGroupRule = {
    id: string;
    name: string;
    schools?: string[];
    teams?: string[];
    contests?: string[];
};

export function ccsGroups(value: unknown): CcsGroupRule[] {
    if (value == null || (typeof value === 'string' && !value.trim())) return [];
    const invalid = (): never => { throw new Error('CCS_GROUPS_INVALID'); };
    if (typeof value !== 'string') return invalid();
    let parsed: unknown;
    try { parsed = JSON.parse(value); }
    catch { return invalid(); }
    if (!Array.isArray(parsed)) return invalid();
    const strings = (value: unknown): string[] | undefined => {
        if (value === undefined) return undefined;
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) return invalid();
        return [...new Set<string>(value.map(item => item.trim()))];
    };
    const ids = new Set(['participants', 'observers']);
    return parsed.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row)
            || Object.keys(row).some(key => !['id', 'name', 'schools', 'teams', 'contests'].includes(key))
            || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.id) || ids.has(row.id)
            || typeof row.name !== 'string' || !row.name.trim() || row.name.trim().length > 128) return invalid();
        ids.add(row.id);
        const schools = strings(row.schools), teams = strings(row.teams), contests = strings(row.contests);
        // An omitted selector is unrestricted; an explicit empty list matches nobody.
        if (schools === undefined && teams === undefined) return invalid();
        if (contests && (!contests.length || contests.some(contest => !/^[a-zA-Z0-9_-]+\/[a-f\d]{24}$/i.test(contest)))) return invalid();
        return { id: row.id, name: row.name.trim(), schools, teams,
            contests: contests?.map(contest => contest.slice(0, contest.indexOf('/') + 1) + contest.slice(contest.indexOf('/') + 1).toLowerCase()) };
    });
}

export function ccsTeamGroupIds(groups: CcsGroupRule[], school: string, username: string): string[] {
    return groups.filter(group => (group.schools === undefined || group.schools.includes(school))
        && (group.teams === undefined || group.teams.includes(username))).map(group => group.id);
}
