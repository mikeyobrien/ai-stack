import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { createBacklogStore } from './store.js';

export class BacklogService extends TypertRemoteService {
  static inject = ['fs', 'sessions'];
  constructor(ctx) {
    super(ctx, 'backlog');
    this.store = createBacklogStore({ fs: ctx.fs, sessions: ctx.sessions });
  }
  async run(request) { return this.store.run(request); }
}
Object.defineProperty(BacklogService.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
  value: Object.freeze({ version: 1, methods: Object.freeze([
    Object.freeze({ method: 'run', invocation: Object.freeze({ kind: 'direct' }) }),
  ]) }),
});
export function apply(ctx) { ctx.plugin(BacklogService); }
