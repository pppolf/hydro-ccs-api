/** School names are matched after trimming, just like Hydro's school field. */
export function ccsOrganizationIds(value: unknown): Map<string, string> {
    const result = new Map<string, string>();
    if (value == null || (typeof value === 'string' && !value.trim())) return result;
    if (typeof value !== 'string') throw new Error('CCS_ORGANIZATION_IDS_INVALID');
    let parsed: unknown;
    try { parsed = JSON.parse(value); }
    catch { throw new Error('CCS_ORGANIZATION_IDS_INVALID'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('CCS_ORGANIZATION_IDS_INVALID');
    const ids = new Set<string>();
    for (const [name, id] of Object.entries(parsed)) {
        const school = name.trim();
        if (!school || result.has(school) || typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id)) {
            throw new Error('CCS_ORGANIZATION_IDS_INVALID');
        }
        result.set(school, id);
        ids.add(id);
    }
    return result;
}
