/** Container image gate — everything about an image that needs no daemon. See docker.js. */

export type DockerProblem = {
    /** `path`, or null for a finding that belongs to no single file. */
    file: string | null;
    what: string;
    why: string;
};

export type GlibcImage = {
    /** The Dockerfile, as a repo-relative path (`docker/worker.Dockerfile`). */
    file: string;
    /** Which native module needs glibc, and how it fails on musl. Printed on failure. */
    why: string;
};

export type DockerInput = {
    root?: string;
    /** Where the Dockerfiles live. `*.Dockerfile` and a plain `Dockerfile` are read. Defaults to `docker`. */
    dockerDir?: string;
    /** Defaults to `.dockerignore`. */
    dockerignore?: string;
    /** The manifest whose `engines.node` every `node:` base is held to. Defaults to `package.json`. */
    packageJson?: string;
    /** The workflow whose `docker/build-push-action` steps must build every Dockerfile. Defaults to `.github/workflows/build.yml`. */
    buildWorkflow?: string;
    /** The context every build must use. Defaults to `.`, the repo root, where the lockfile is. */
    buildContext?: string;
    /** Extra bases that run unprivileged by construction, as RegExp sources. nginx-unprivileged is built in. */
    nonrootBases?: string[];
    /** Dockerfile → the k8s manifest that deploys it. Omitted, EXPOSE is not compared with containerPort. */
    deployments?: Record<string, string>;
    /** The kustomization whose `images:` must name what the build pushes. Omitted, not checked. */
    kustomization?: string;
    /** Images that must stay on a glibc base, each with the reason. */
    glibc?: GlibcImage[];
};

export type DockerInspection = {
    problems: DockerProblem[];
    counts: { images: number; stages: number; nodeMajor: string | null };
};

export type DockerOptions = DockerInput & {
    /** The instructions file to point at on failure. */
    standard?: string;
};

export declare function inspectDocker(input: DockerInput): DockerInspection;
export declare function checkDocker(options: DockerOptions): void;
export default checkDocker;
