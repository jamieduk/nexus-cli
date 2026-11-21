import { loadPermissionStore, savePermissionStore } from './settings.js';
export class PermissionManager {
    store;
    prompter;
    sessionGrants = new Set();
    autoAllow;
    lastDenialReason = '';
    constructor(prompter = null, autoAllow = new Set()) {
        this.store = loadPermissionStore();
        this.prompter = prompter;
        this.autoAllow = autoAllow;
    }
    setPrompter(prompter) {
        this.prompter = prompter;
    }
    has(id) {
        return this.autoAllow.has(id) || this.sessionGrants.has(id) || Boolean(this.store.grants[id]);
    }
    grant(id, persist) {
        if (persist) {
            this.store = loadPermissionStore();
            this.store.grants[id] = { grantedAt: Date.now() };
            savePermissionStore(this.store);
        }
        else {
            this.sessionGrants.add(id);
        }
    }
    revoke(id) {
        this.sessionGrants.delete(id);
        this.store = loadPermissionStore();
        delete this.store.grants[id];
        savePermissionStore(this.store);
    }
    revokeAll() {
        this.sessionGrants.clear();
        this.store = { grants: {} };
        savePermissionStore(this.store);
    }
    list() {
        this.store = loadPermissionStore();
        return Object.entries(this.store.grants)
            .map(([id, grant]) => ({ id, grantedAt: grant.grantedAt }))
            .sort((a, b) => a.id.localeCompare(b.id));
    }
    async ensure(request) {
        // Another Nexus instance (for example the web UI) may have changed grants.
        this.store = loadPermissionStore();
        if (this.has(request.id))
            return true;
        if (!this.prompter)
            return false;
        const options = [
            { label: 'Always allow (remember)', value: 'always' },
            { label: 'Allow for this session', value: 'once' },
            { label: 'Deny', value: 'deny' },
            { label: 'Deny and suggest an alternative', value: 'suggest' },
        ];
        const decision = await this.prompter(request, options);
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
    consumeDenialReason() {
        const reason = this.lastDenialReason;
        this.lastDenialReason = '';
        return reason;
    }
}
