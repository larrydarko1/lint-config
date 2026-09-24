/** IPC architecture gate — the channel surface between main and renderer. See ipc-standards.js. */

export type IpcProblem = {
    /** `path` or `path:line`. */
    file: string;
    what: string;
    why: string;
};

export type IpcStandardsInput = {
    root: string;
    /** Holds the "IPC handler ownership:" table and any inline handlers. Default `src/main/index.ts`. */
    mainIndex?: string;
    /** One file per service; a table row `fs-service` means `<servicesDir>/fs.ts`. Default `src/main/services`. */
    servicesDir?: string;
    /** Default `src/preload/index.ts`. */
    preload?: string;
    /** The shared type file the bridge is typed against. Default `src/schemas/electron.d.ts`. */
    contract?: string;
    /** The type the exposed object must be annotated with. Default `ElectronAPI`. */
    contractType?: string;
};

export type IpcStandardsInspection = {
    problems: IpcProblem[];
    counts: { handlers: number; events: number; preloadChannels: number };
};

export type IpcStandardsOptions = Omit<IpcStandardsInput, 'root'> & {
    /** Default: the repo root. */
    root?: string;
    /** The instructions file to point at on failure. */
    standard?: string;
};

export declare function inspectIpcStandards(input: IpcStandardsInput): IpcStandardsInspection;
export declare function checkIpcStandards(options: IpcStandardsOptions): void;
export default checkIpcStandards;
