import { randomUUID } from 'node:crypto';
import { applyCcsChange, diffCcsState, digest, type CcsChange, type CcsState } from './core';

export type CcsCommit = { _id: string; scope: string; revision: number; batch: string; count: number; pages: number; observedAt: Date };
export interface CcsRepository {
    latest(scope: string): Promise<CcsCommit | null>;
    commits(scope: string, from: number, through: number): Promise<CcsCommit[]>;
    chunk(batch: string, page: number): Promise<CcsChange[]>;
    writeChunk(batch: string, page: number, events: CcsChange[]): Promise<void>;
    commit(value: CcsCommit): Promise<boolean>;
    discard(batch: string): Promise<void>;
}
const pageSize = 200;
type Snapshot = { revision: number; state: CcsState; observedAt: Date };
export const ccsToken = (scope: string, revision: number, index: number) => `${digest(scope).slice(0, 24)}.${revision}.${index}`;

/** A commit is a single Mongo insert with unique _id=scope/revision. All event
 * chunks are immutable and written first. Concurrent workers race only on this
 * insert; losers discard their private chunks and retry. Standalone Mongo is
 * supported: neither a transaction nor an expiring lease is needed. */
export class CcsFeedStore {
    private cache = new Map<string, Snapshot>();
    private running = new Map<string, Promise<Snapshot>>();
    constructor(private repository: CcsRepository) {}

    private remember(scope: string, value: Snapshot) {
        if (this.cache.size >= 32 && !this.cache.has(scope)) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(scope, value);
        return value;
    }

    async read(scope: string) {
        const head = await this.repository.latest(scope);
        const cached = this.cache.get(scope) || { revision: 0, state: new Map(), observedAt: new Date(0) };
        if ((!head && cached.revision) || (head && head.revision < cached.revision)) throw new Error('CCS_LOG_INCOMPLETE');
        if (!head || head.revision === cached.revision) return cached;
        const state = new Map(cached.state);
        for await (const event of this.events(scope, null, head.revision, cached.revision + 1)) applyCcsChange(state, event);
        const result = { revision: head.revision, state, observedAt: head.observedAt };
        return this.remember(scope, result);
    }

    refresh(scope: string, contestId: string, visibility: 'admin' | 'broadcast', source: (previous: CcsState) => Promise<CcsState>, afterCurrent = false): Promise<Snapshot> {
        const running = this.running.get(scope);
        // A notification arriving during a database read needs a trailing read:
        // the in-flight snapshot may predate the newly completed test case.
        if (running) return afterCurrent ? running.catch(() => {}).then(() => this.refresh(scope, contestId, visibility, source)) : running;
        const task = this.refreshOnce(scope, contestId, visibility, source).finally(() => { this.running.delete(scope); });
        this.running.set(scope, task);
        return task;
    }

    private async refreshOnce(scope: string, contestId: string, visibility: 'admin' | 'broadcast', source: (previous: CcsState) => Promise<CcsState>) {
        for (let attempt = 0; attempt < 4; attempt++) {
            const before = await this.read(scope);
            const next = await source(before.state), observedAt = new Date();
            const { changes, state } = diffCcsState(before.state, next, { contestId, visibility, observedAt, initial: before.revision === 0 });
            if (!changes.length) return before;
            const revision = before.revision + 1, batch = randomUUID(), pages = Math.ceil(changes.length / pageSize);
            changes.forEach((change, index) => {
                if (change.data?.x_hydro_rank) change.data.x_hydro_rank.provenance.eventToken = ccsToken(scope, revision, index);
            });
            try {
                for (let page = 0; page < pages; page++) await this.repository.writeChunk(batch, page, changes.slice(page * pageSize, (page + 1) * pageSize));
            } catch (error) { await this.repository.discard(batch); throw error; }
            // An ambiguous network failure here must retain chunks: the commit
            // might already be durable. A later read resolves which one won.
            if (await this.repository.commit({ _id: `${scope}/${revision}`, scope, revision, batch, pages, count: changes.length, observedAt })) {
                return this.remember(scope, { revision, state, observedAt });
            }
            await this.repository.discard(batch);
        }
        throw new Error('CCS_CONCURRENT_UPDATE_RETRY');
    }

    async validateToken(scope: string, token: string | null) {
        if (!token) return { revision: 0, index: -1 };
        const match = /^([a-f0-9]{24})\.([1-9]\d*)\.(0|[1-9]\d*)$/.exec(token);
        if (!match || match[1] !== digest(scope).slice(0, 24)) throw new Error('CCS_INVALID_TOKEN');
        const revision = Number(match[2]), index = Number(match[3]);
        if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(index)) throw new Error('CCS_INVALID_TOKEN');
        const [commit] = await this.repository.commits(scope, revision, revision);
        if (!commit || index >= commit.count) throw new Error('CCS_INVALID_TOKEN');
        return { revision, index };
    }

    async *events(scope: string, token: string | null, through?: number, from = 1): AsyncGenerator<CcsChange> {
        const cursor = await this.validateToken(scope, token);
        const last = through ?? (await this.repository.latest(scope))?.revision ?? 0;
        let revision = Math.max(from, cursor.revision);
        while (revision <= last) {
            const commits = await this.repository.commits(scope, revision, last);
            if (!commits.length) throw new Error('CCS_LOG_INCOMPLETE');
            for (const commit of commits) {
                if (commit.revision !== revision || commit.count < 1 || commit.pages !== Math.ceil(commit.count / pageSize)) throw new Error('CCS_LOG_INCOMPLETE');
                for (let page = 0; page < commit.pages; page++) {
                    const changes = await this.repository.chunk(commit.batch, page);
                    if (changes.length !== Math.min(pageSize, commit.count - page * pageSize)) throw new Error('CCS_LOG_INCOMPLETE');
                    for (let i = 0; i < changes.length; i++) {
                        const index = page * pageSize + i;
                        if (commit.revision === cursor.revision && index <= cursor.index) continue;
                        yield { ...changes[i], token: ccsToken(scope, commit.revision, index) };
                    }
                }
                revision = commit.revision + 1;
            }
        }
    }
}
