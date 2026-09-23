export type ScssProblem = {
    /** The file the finding belongs to. */
    file: string;
    what: string;
    why: string;
};

export type ScssStandardsInspection = {
    problems: ScssProblem[];
    /** Every `.scss` and `.vue` file swept, repo-relative. */
    styleFiles: string[];
    /** The palette names found, in the project's own vocabulary. */
    palettes: string[];
    /** How many tokens the reference palette declares. */
    tokenCount: number;
};

/** A module the entry point must `@use`, with the reason its absence matters. */
export type EmittingModule = {
    /** Matched against the `@use` specifier, so the partial's bare name. */
    module: string;
    why: string;
};

/**
 * Where the palettes live. This is the gate's only switch, and it is a switch
 * because the difference is a real architectural choice rather than drift:
 *
 *   • `scss-maps`  — palettes are Sass maps run through an `emit-theme` mixin.
 *                    This is what the standard specifies.
 *   • `css-blocks` — palettes are written out as literal custom-property blocks,
 *                    so stylelint's `no-unknown-custom-properties` can see them.
 *                    A Sass map is opaque to it, and to this gate.
 *   • `json-presets` — palettes are JSON files on disk, seeded into the user's
 *                    profile for hand-editing. A product feature, not a style.
 */
export type ThemeSource = ScssMapThemes | CssBlockThemes | JsonPresetThemes;

export type ScssMapThemes = {
    source: 'scss-maps';
    /** The partial holding the `$theme-*` maps. */
    file: string;
    /** The palette every other one is compared against, without any `theme-` prefix. */
    reference: string;
    /**
     * The map that registers which palettes get emitted, without its `$`. Absent
     * means the project emits one literal `[data-theme='…']` block per palette
     * instead, which is what the standard shows.
     */
    registryName?: string;
    /** Where `emit-theme` and `color-scheme` live, if not alongside the maps. */
    mixinFile?: string;
    /**
     * Where the maps are actually turned into CSS — the `[data-theme='…']` blocks
     * or the loop over the registry. Defaults to `file`. It is a separate option
     * because a map is a declaration and emitting it is an effect: the moment a
     * project moves its emission out of the injected module, which is what this
     * gate pushes for, the two part company.
     */
    emitFile?: string;
};

export type CssBlockThemes = {
    source: 'css-blocks';
    /** The partial holding one custom-property block per palette. */
    file: string;
    reference: string;
    /** How a palette is selected. `data-theme` is what the standard specifies. */
    selector: 'data-theme' | 'app-class';
    /**
     * A partial holding colours that are the same in every palette, declared on
     * `:root`. They take no part in the parity comparison — there is nothing for
     * them to disagree with — but a `var()` naming one resolves perfectly well,
     * so the sweep has to know about them.
     */
    invariantFile?: string;
};

export type JsonPresetThemes = {
    source: 'json-presets';
    /** The directory of bundled `<id>.json` presets. */
    dir: string;
    /** The preset id every other one is compared against. */
    reference: string;
    /** The partial whose `:root` block is the compiled-in fallback layer. */
    fallbackFile: string;
};

export type ScssStandardsOptions = {
    /** Defaults to the repo root resolved from the process cwd. */
    root?: string;
    /** The instructions file to point at on failure. */
    standard?: string;
    /** The styles directory, repo-relative. Every file option below is relative to it. */
    styles: string;
    /** The source tree swept for SFCs and stylesheets, repo-relative. */
    src: string;
    /** The file holding the `@forward`s. Defaults to `index.scss`. */
    barrel?: string;
    /**
     * The file `main.ts` imports, which `@use`s the emitting modules. Defaults to
     * the barrel. It is a second file only when the barrel itself is injected.
     */
    entry?: string;
    /** The module Vite prepends to every SFC. Defaults to `_variables.scss`. */
    injected?: string;
    /** The script that imports the entry point, repo-relative. */
    mainScript: string;
    /** Every Vite config that compiles these SFCs. More than one means more than one build target. */
    viteConfigs: string[];
    /** The specifier `additionalData` must inject, exactly as written there. */
    injectedSpecifier: string;
    /**
     * Text the `additionalData` guard must contain, once the injected specifier
     * itself is discounted — because that specifier always mentions the styles
     * folder, and matching on it made the check pass unconditionally.
     *
     * Vite only hands the preprocessor the entry stylesheet and each SFC style
     * block; partials are resolved inside Sass and never reach it. So a project
     * whose entry is the only styles-tree file Vite sees can guard on just that
     * filename, while one that injects the barrel must exempt the whole folder.
     * Defaults to `'styles'`.
     */
    injectionGuard?: string;
    /** Modules the barrel must `@forward`. Defaults to `['variables']`. */
    forwarded?: string[];
    /** Modules the entry point must `@use`, since nothing else can reach them. */
    emitters?: EmittingModule[];
    themes: ThemeSource;
    /**
     * Custom properties a component sets on itself through a `:style` binding, so
     * they are deliberately absent from every palette. Mapped to the reason, kept
     * with the name so the exemption has to justify itself.
     */
    componentLocalVars?: Record<string, string>;
    /** Extra files swept for remote fonts, e.g. `index.html`. */
    html?: string[];
    /** Where vendored fonts live. Only consulted if the project declares `@font-face`. */
    fontDir?: string;
    /** The partial that declares `@font-face`. Absent or empty means a system font stack. */
    fontFaceFile?: string;
    /** The manifest checked for `@fontsource*` dependencies. */
    packageJson?: string;
};

export type ScssStandardsInput = Omit<ScssStandardsOptions, 'standard' | 'root'> & { root: string };

export declare function inspectScssStandards(options: ScssStandardsInput): ScssStandardsInspection;
export declare function checkScssStandards(options: ScssStandardsOptions): void;
export default checkScssStandards;
