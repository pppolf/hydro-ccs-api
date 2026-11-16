import { duration, hydroVerdicts, type CcsObject, type CcsState } from './core';

/** Hydro identifies cases by (subtaskId, id), not a contest-wide ordinal.
 * Remember the first observed ordering on the problem so parallel completion,
 * subsequent submissions, rejudging and restarts cannot renumber a case. */
export function addCcsRuns(state: CcsState, previous: CcsState, record: { testCases?: unknown }, judgement: CcsObject, problemId: string, now: Date) {
    const problem = state.get(`problems/${problemId}`)!;
    const count = problem.test_data_count;
    if (!Number.isSafeInteger(count) || count < 1 || !Array.isArray(record.testCases)) return;
    const order: string[] = problem.x_hydro_testcase_order;
    const tests = new Map<string, { status: number; time: number }>();
    for (const test of record.testCases) {
        if (!test || !Number.isSafeInteger(test.id) || test.id < 1
            || !Number.isSafeInteger(test.subtaskId ?? 0) || (test.subtaskId ?? 0) < 0
            || !hydroVerdicts[test.status] || !Number.isFinite(test.time) || test.time < 0) continue;
        const key = `${test.subtaskId ?? 0}/${test.id}`;
        tests.set(key, test); // A corrected report updates the same run.
    }
    for (const [key, test] of tests) {
        let ordinal = order.indexOf(key) + 1;
        if (!ordinal) {
            if (order.length >= count) continue;
            order.push(key);
            ordinal = order.length;
        }
        const id = `${judgement.id}-run-${key.replace('/', '-')}`;
        const old = previous.get(`runs/${id}`), verdict = hydroVerdicts[test.status];
        const runtime = Math.round(test.time) / 1000;
        // Hydro stores execution time, but no per-case wall-clock completion time.
        // Keep the first CCS observation time stable across unchanged reads.
        const time = old?.judgement_type_id === verdict && old?.run_time === runtime ? old.time : now.toISOString();
        state.set(`runs/${id}`, { id, judgement_id: judgement.id, ordinal, judgement_type_id: verdict,
            time, contest_time: duration(Date.parse(time) - Date.parse(state.get('contest/')!.start_time)),
            run_time: runtime, x_hydro_time_source: 'CCS_OBSERVED' });
    }
}
