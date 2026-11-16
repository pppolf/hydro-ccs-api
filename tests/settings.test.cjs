const assert = require('node:assert/strict');
const test = require('node:test');
const { createRequire } = require('node:module');
const { loader } = require('./helpers.cjs');

// This uses Hydro 5.1's real settings registry, without a server or MongoDB.
const hydroRequire = createRequire(require.resolve('hydrooj/package.json'));
hydroRequire('@hydrooj/register');
global.Hydro = { model: {}, locales: {}, module: {}, script: {}, ui: {} };
const nativeSettings = hydroRequire('./src/model/setting.ts');
class ValidationError extends Error {}

function settingsContext() {
    const disposers = [], hooks = {}, locales = {};
    const ctx = {
        i18n: { load: (language, values) => { locales[language] = values; } },
        effect: callback => { disposers.push(callback()); },
        on: (event, callback) => { hooks[event] = callback; },
    };
    const load = loader({ SettingModel: nativeSettings, SystemModel: { get() {} }, ValidationError });
    load('settings').registerCcsSettings(ctx);
    return {
        hooks, locales,
        dispose: () => { for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose(); },
    };
}

test('real Hydro registry receives independent settings, secret fields and disposable registration', () => {
    const existing = new Set(nativeSettings.SYSTEM_SETTINGS.map(row => row.key));
    const f = settingsContext();
    try {
        const rows = nativeSettings.SYSTEM_SETTINGS.filter(row => row.key.startsWith('hydroCcsApi.'));
        assert.deepEqual(rows.map(row => row.key).sort(), ['adminApiKey', 'contests', 'groups', 'organizationIds', 'password', 'username'].map(key => `hydroCcsApi.${key}`));
        assert.ok(rows.every(row => row.family === 'setting_hydro_ccs_api'));
        assert.equal(f.locales.zh.setting_hydro_ccs_api, 'CCS 比赛数据接口');
        for (const key of ['password', 'adminApiKey']) {
            const row = nativeSettings.SYSTEM_SETTINGS_BY_KEY[`hydroCcsApi.${key}`];
            assert.equal(row.type, 'password');
            assert.equal(row.value, '');
            assert.ok(row.flag & nativeSettings.FLAG_SECRET);
        }
        assert.equal(nativeSettings.SYSTEM_SETTINGS_BY_KEY['hydroCcsApi.contests'].value, '');
        assert.equal(nativeSettings.SYSTEM_SETTINGS_BY_KEY['hydroCcsApi.organizationIds'].value, '');
        assert.equal(nativeSettings.SYSTEM_SETTINGS_BY_KEY['hydroCcsApi.organizationIds'].type, 'textarea');
        assert.equal(nativeSettings.SYSTEM_SETTINGS_BY_KEY['hydroCcsApi.groups'].value, '');
        assert.equal(nativeSettings.SYSTEM_SETTINGS_BY_KEY['hydroCcsApi.groups'].type, 'textarea');
    } finally { f.dispose(); }
    assert.deepEqual(new Set(nativeSettings.SYSTEM_SETTINGS.map(row => row.key)), existing);
});

test('organization mapping settings accept JSON text and reject ambiguous or unusable IDs before saving', () => {
    const f = settingsContext();
    const save = args => f.hooks['handler/before/SystemSetting']({ request: { method: 'POST' }, args });
    try {
        for (const value of ['', ' \n ', '{}', '{\n " 西华师范大学 ": "cwnu", "另一所学校": "School_2-2026"\n}']) {
            assert.doesNotThrow(() => save({ 'hydroCcsApi.organizationIds': value }));
            assert.doesNotThrow(() => save({ hydroCcsApi: { organizationIds: value } }));
        }
        const invalid = ['{', '[]', 'null', 'true', '42', '"cwnu"', { University: 'uni' }, ['uni'],
            '{"": "empty"}', '{" ": "blank"}', '{"University": "a", " University ": "b"}',
            '{"University": "same", "Another": "same"}',
            ...['', ' cwnu ', '西华师大', '../cwnu', 'a/b', 'a.b', 'a\n', 'a'.repeat(65), 123, null, [], {}]
                .map(id => JSON.stringify({ University: id }))];
        for (const value of invalid) {
            assert.throws(() => save({ 'hydroCcsApi.organizationIds': value }), ValidationError);
            assert.throws(() => save({ hydroCcsApi: { organizationIds: value } }), ValidationError);
        }
    } finally { f.dispose(); }
});

test('native save hook validates flat and nested settings before any writes', () => {
    const f = settingsContext();
    const save = args => f.hooks['handler/before/SystemSetting']({ request: { method: 'POST' }, args });
    try {
        for (const username of ['', 'bad:name', 'bad\nname', ' spaces ', 'a'.repeat(129)]) {
            assert.throws(() => save({ hydroCcsApi: { username } }), ValidationError);
        }
        for (const contests of ['*/691000000000000000000001', 'system/not-a-contest', ['system/691000000000000000000001']]) {
            assert.throws(() => save({ 'hydroCcsApi.contests': contests }), ValidationError);
        }
        for (const adminApiKey of ['short', 'a'.repeat(1025), 'a'.repeat(32) + '\n', 'a'.repeat(32) + ' b', '密'.repeat(32), 'a'.repeat(32) + '\t']) {
            assert.throws(() => save({ hydroCcsApi: { adminApiKey } }), ValidationError);
        }
        assert.doesNotThrow(() => save({ hydroCcsApi: { username: 'ccs', password: '', adminApiKey: '', contests: '' } }));
        assert.doesNotThrow(() => save({ 'hydroCcsApi.adminApiKey': 'a'.repeat(64), 'hydroCcsApi.contests': 'system/691000000000000000000001' }));
        assert.doesNotThrow(() => f.hooks['handler/before/SystemSetting']({ request: { method: 'GET' }, args: { hydroCcsApi: { username: '' } } }));
    } finally { f.dispose(); }
});

test('custom group settings validate selectors, reserved IDs and contest scopes before saving', () => {
    const f = settingsContext();
    const save = args => f.hooks['handler/before/SystemSetting']({ request: { method: 'POST' }, args });
    const group = { id: 'besti_fresh', name: '北京电子科技学院新生', teams: ['Team02'] };
    try {
        for (const value of ['', ' \n ', '[]', JSON.stringify([group]), JSON.stringify([
            { ...group, schools: [' 北京电子科技学院 '], contests: ['acm/6AC20790D61D6F63E08474E4'] },
            { id: 'cwnu', name: '西华师范大学', schools: ['西华师范大学'] },
            { id: 'empty', name: '待分配队伍', teams: [] },
        ])]) {
            assert.doesNotThrow(() => save({ 'hydroCcsApi.groups': value }));
            assert.doesNotThrow(() => save({ hydroCcsApi: { groups: value } }));
        }
        const invalidGroups = [null, [], {}, { id: 'missing', name: 'Missing selectors' },
            ...['participants', 'observers', '', 'a/b', 'a.b', 'a'.repeat(65), 123].map(id => ({ ...group, id })),
            ...['', ' ', 123, 'a'.repeat(129)].map(name => ({ ...group, name })),
            { ...group, school: '北京电子科技学院' },
            ...['teams', 'schools', 'contests'].flatMap(key => [null, 'text', {}, [''], [' '], [123]].map(value => ({ ...group, [key]: value }))),
            { ...group, contests: [] }, { ...group, contests: ['*/691000000000000000000001'] },
            { ...group, contests: ['system/not-a-contest'] },
        ];
        for (const value of ['{', '{}', 'null', 'true', '42', [group], JSON.stringify([group, group]),
            ...invalidGroups.map(row => JSON.stringify([row]))]) {
            assert.throws(() => save({ 'hydroCcsApi.groups': value }), ValidationError);
            assert.throws(() => save({ hydroCcsApi: { groups: value } }), ValidationError);
        }
    } finally { f.dispose(); }
});
