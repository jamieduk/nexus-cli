import { loadPermissionStore, savePermissionStore } from './settings.js';
import type {
  PermissionDecision,
  PermissionOptionValue,
  PermissionPrompter,
  PermissionRequest,
  PermissionStore,
} from './types.js';

export class PermissionManager {
  private store: PermissionStore;
  private prompter: PermissionPrompter | null;
  private sessionGrants = new Set<string>();
  private readonly autoAllow: Set<string>;
  private lastDenialReason = '';

  constructor(prompter: PermissionPrompter | null = null, autoAllow: Set<string> = new Set()) {
    this.store = loadPermissionStore();
    this.prompter = prompter;
    this.autoAllow = autoAllow;
  }

  setPrompter(prompter: PermissionPrompter | null): void {
    this.prompter = prompter;
  }

  has(id: string): boolean {
    return this.autoAllow.has(id) || this.sessionGrants.has(id) || Boolean(this.store.grants[id]);
  }

  grant(id: string, persist: boolean): void {
    if (persist) {
      this.store = loadPermissionStore();
      this.store.grants[id] = { grantedAt: Date.now() };
      savePermissionStore(this.store);
    } else {
      this.sessionGrants.add(id);
    }
  }

  revoke(id: string): void {
    this.sessionGrants.delete(id);
    this.store = loadPermissionStore();
    delete this.store.grants[id];
    savePermissionStore(this.store);
  }

  revokeAll(): void {
    this.sessionGrants.clear();
    this.store = { grants: {} };
    savePermissionStore(this.store);
  }

  list(): Array<{ id: string; grantedAt: number }> {
    this.store = loadPermissionStore();
    return Object.entries(this.store.grants)
      .map(([id, grant]) => ({ id, grantedAt: grant.grantedAt }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async ensure(request: PermissionRequest): Promise<boolean> {
    // Another Nexus instance (for example the web UI) may have changed grants.
    this.store = loadPermissionStore();
    if (this.has(request.id)) return true;
    if (!this.prompter) return false;
    const options: Array<{ label: string; value: PermissionOptionValue }> = [
      { label: 'Always allow (remember)', value: 'always' },
      { label: 'Allow for this session', value: 'once' },
      { label: 'Deny', value: 'deny' },
      { label: 'Deny and suggest an alternative', value: 'suggest' },
    ];
    const decision: PermissionDecision = await this.prompter(request, options);
    if (decision.choice === 'always') {
      this.grant(request.id, true);
      return true;
    }
    if (decision.choice === 'once') {
      this.grant(request.id, false);
      return true;
    }
    this.lastDenialReason = decision.reason?.trim() ?? '';
    return false;
  }

  consumeDenialReason(): string {
    const reason = this.lastDenialReason;
    this.lastDenialReason = '';
    return reason;
  }
}
