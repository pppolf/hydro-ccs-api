import { Context, SettingModel, SystemModel, ValidationError } from 'hydrooj';
import { ccsContestAllowlist, validCcsApiKey } from './auth';
import { ccsOrganizationIds } from './organizations';

export const SETTING_PREFIX = 'hydroCcsApi.';
export const SETTING_FAMILY = 'setting_hydro_ccs_api';
export const ccsSetting = (key: string): unknown => SystemModel.get(`${SETTING_PREFIX}${key}`);

export function registerCcsSettings(ctx: Context) {
    ctx.i18n.load('zh', { [SETTING_FAMILY]: 'CCS 比赛数据接口' });
    ctx.i18n.load('en', { [SETTING_FAMILY]: 'CCS Contest API' });
    const setting = (key: string, value: string, type: 'text' | 'password' | 'textarea', name: string, description: string, flag = 0) =>
        SettingModel.Setting(SETTING_FAMILY, `${SETTING_PREFIX}${key}`, value, type, name, description, flag);
    ctx.effect(() => SettingModel.SystemSetting(
        setting('username', 'ccs', 'text', 'CCS 直播用户名', 'HTTP Basic 用户名，不是 Hydro 登录账号。'),
        setting('password', '', 'password', 'CCS 直播密码', '独立直播密码；首次未设置时禁用 Basic 访问。保存时留空保持原值。', SettingModel.FLAG_SECRET),
        setting('contests', '', 'text', 'CCS 允许读取的比赛', '两种鉴权均仅允许此清单：域ID/24位比赛ID，以逗号或空白分隔。主站域为 system；清空禁止全部比赛。'),
        setting('organizationIds', '', 'textarea', 'CCS 组织 ID 映射', '学校名称到固定 ID 的 JSON 对象，例如 {"西华师范大学":"cwnu"}。名称去除首尾空白后精确匹配；ID 为 1–64 个英文字母、数字、下划线或连字符，不能重复。未配置的学校沿用原哈希 ID；留空清除映射。建议在准备直播 package 前配置。'),
        setting('adminApiKey', '', 'password', 'CCS 未封榜读取密钥', '可选，只读 x-ccs-api-key，32–1024 个可见 ASCII 字符，不含空白，推荐随机十六进制字符串；可读取允许清单内的未封榜结果。不要交给公开直播。留空保持原值，清空比赛清单可停用全部比赛访问。', SettingModel.FLAG_SECRET),
    ));
    ctx.on('handler/before/SystemSetting', handler => {
        if (String(handler.request.method).toLowerCase() !== 'post') return;
        const args = handler.args || {};
        const field = (key: string) => args[`${SETTING_PREFIX}${key}`] ?? args.hydroCcsApi?.[key];
        const invalid = (key: string, message: string) => { throw new ValidationError(`${SETTING_PREFIX}${key}`, null, message); };
        const contests = field('contests');
        if (contests !== undefined) {
            if (typeof contests !== 'string') invalid('contests', '比赛清单应为文本');
            try { ccsContestAllowlist(contests); }
            catch { invalid('contests', '请填写 域ID/24位比赛ID，最多 100 项'); }
        }
        const organizationIds = field('organizationIds');
        if (organizationIds !== undefined) {
            try { ccsOrganizationIds(organizationIds); }
            catch { invalid('organizationIds', '请填写学校名称到组织 ID 的 JSON 对象；名称不能为空或重复，ID 须为 1–64 个英文字母、数字、下划线或连字符，且不能重复'); }
        }
        const username = field('username');
        if (username !== undefined && (typeof username !== 'string' || !username.trim() || username !== username.trim()
            || username.length > 128 || /[:\r\n]/.test(username))) {
            invalid('username', '用户名不能为空、包含冒号或换行，长度须不超过 128 字符，且不能有首尾空格');
        }
        for (const key of ['password', 'adminApiKey']) {
            const value = field(key);
            if (value === undefined || value === '') continue; // Native Hydro preserves blank secret inputs.
            if (typeof value !== 'string' || value.length > 1024 || /[\r\n]/.test(value)) {
                invalid(key, '密钥或密码须为不超过 1024 字符的单行文本');
            }
            if (key === 'adminApiKey' && !validCcsApiKey(value)) {
                invalid(key, '未封榜读取密钥须为 32–1024 个可见 ASCII 字符且不含空白，推荐使用随机十六进制字符串');
            }
        }
    });
}
