import { timingSafeEqual } from 'node:crypto';

export function ccsContestAllowlist(value: unknown): string[] {
    if (typeof value !== 'string') return [];
    const entries = value.split(/[,\s]+/).filter(Boolean);
    if (entries.length > 100 || entries.some(entry => !/^[a-zA-Z0-9_-]+\/[a-f\d]{24}$/i.test(entry))) throw new Error('CCS_CONTEST_ALLOWLIST_INVALID');
    return [...new Set(entries.map(entry => entry.slice(0, entry.indexOf('/') + 1) + entry.slice(entry.indexOf('/') + 1).toLowerCase()))];
}
export function ccsBasicAuthorized(header: unknown, username: unknown, password: unknown) {
    if (typeof header !== 'string' || header.length > 8192 || !/^Basic [a-zA-Z0-9+/]+=*$/i.test(header) || typeof username !== 'string'
        || !username || username.includes(':') || typeof password !== 'string' || !password) return false;
    const actual = Buffer.from(header.slice(6), 'base64'), expected = Buffer.from(`${username}:${password}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function validCcsApiKey(value: unknown): value is string {
    return typeof value === 'string' && /^[\x21-\x7e]{32,1024}$/.test(value);
}

export function ccsApiKeyAuthorized(header: unknown, configuredKey: unknown) {
    if (typeof header !== 'string' || !validCcsApiKey(configuredKey) || header.length > 1024) return false;
    const actual = Buffer.from(header), expected = Buffer.from(configuredKey);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
