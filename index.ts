import type { Context } from 'hydrooj';
import { registerCcsApi } from './src/api';
import { registerCcsSettings } from './src/settings';

export const name = 'hydro-ccs-api';

export function apply(ctx: Context) {
    registerCcsSettings(ctx);
    registerCcsApi(ctx);
}
