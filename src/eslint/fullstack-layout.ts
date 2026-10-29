/**
 * The full-stack family's roles. Its source is in workspaces rather than folders, so its
 * layout is built apart from the single-package families'; presets.ts re-exports it.
 */

/**
 * A full-stack monorepo's workspaces, by the role each plays. Every full-stack rule is
 * written against a role, not a folder name, so a new workspace is one entry here and
 * every rule for its role reaches it. Each is a directory holding a `src/`.
 */
export type FullstackWorkspaces = {
    /** The Vue app. */
    frontend: string;
    /** The HTTP service: routes, middleware, the websocket gateway. */
    api: string;
    /** Node processes outside the request cycle — a queue consumer, a feed ingestor, a scheduled role. */
    services: string[];
    /** Framework-neutral packages the other workspaces import. */
    shared: string[];
};

/** Each role's source as globs — what the full-stack rules are given. */
export type FullstackLayout = {
    workspaces: FullstackWorkspaces;
    /** The frontend's TypeScript and components. */
    frontend: string[];
    /** The frontend's components alone. */
    vue: string[];
    api: string[];
    services: string[];
    /** The api and every service: the Node side. */
    backend: string[];
    shared: string[];
    /** Every workspace's shipped code. */
    source: string[];
};

/** The four the family started with. A project overrides any role with `larry({ workspaces })`. */
export const FULLSTACK_WORKSPACES: FullstackWorkspaces = {
    frontend: 'frontend',
    api: 'api',
    services: ['worker'],
    shared: ['packages/shared'],
};

export const fullstackLayout = (workspaces: Partial<FullstackWorkspaces> = {}): FullstackLayout => {
    const resolved = { ...FULLSTACK_WORKSPACES, ...workspaces };
    const api = [nodeSource(resolved.api)];
    const services = resolved.services.map(nodeSource);
    const shared = resolved.shared.map(nodeSource);
    const frontend = [`${resolved.frontend}/src/**/*.{ts,vue}`];
    return {
        workspaces: resolved,
        frontend,
        vue: [`${resolved.frontend}/src/**/*.vue`],
        api,
        services,
        backend: [...api, ...services],
        shared,
        source: [...frontend, ...api, ...services, ...shared],
    };
};

const nodeSource = (dir: string): string => `${dir}/src/**/*.ts`;
