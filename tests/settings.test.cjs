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
        assert.deepEqual(rows.map(row => row.key).sort(), ['adminApiKey', 'contests', 'password', 'username'].map(key => `hydroCcsApi.${key}`));
        assert.ok(rows.every(row => row.family === 'setting_hydro_ccs_api'));
        assert.equal(f.locales.zh.setting_hydro_ccs_api, 'CCS 比赛数据接口');
        for (const key of ['password', 'adminApiKey']) {
            const row = nativeSettings.SYSTEM_SETTINGS_BY_KEY[`hydroCcsApi.${key}`];
            assert.equal(row.type, 'password');
            assert.equal(row.value, '');
            assert.ok(row.flag & nativeSettings.FLAG_SECRET);
        }
        assert.equal(nativeSettings.SYSTEM_SETTINGS_BY_KEY['hydroCcsApi.contests'].value, '');
    } finally { f.dispose(); }
    assert.deepEqual(new Set(nativeSettings.SYSTEM_SETTINGS.map(row => row.key)), existing);
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
        for (const adminApiKey of ['short', 'a'.repeat(1025), 'a'.repeat(32) + '\n']) {
            assert.throws(() => save({ hydroCcsApi: { adminApiKey } }), ValidationError);
        }
        assert.doesNotThrow(() => save({ hydroCcsApi: { username: 'ccs', password: '', adminApiKey: '', contests: '' } }));
        assert.doesNotThrow(() => save({ 'hydroCcsApi.adminApiKey': 'a'.repeat(64), 'hydroCcsApi.contests': 'system/691000000000000000000001' }));
        assert.doesNotThrow(() => f.hooks['handler/before/SystemSetting']({ request: { method: 'GET' }, args: { hydroCcsApi: { username: '' } } }));
    } finally { f.dispose(); }
});
