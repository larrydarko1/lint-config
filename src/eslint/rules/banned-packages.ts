/**
 * A `no-restricted-imports` pattern that bans packages by name, each with every subpath.
 *
 * `group` cannot say this: its entries are gitignore globs, so a bare `electron` in a group
 * matches that segment at any depth and bans `@/schemas/electron` and `./electron` along with
 * the package. An anchored regex matches the specifier from its first character, so only the
 * package itself and `<name>/…` are banned. A name ending in `:` is a scheme — `node:` bans
 * every `node:` specifier.
 */

const escape = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const alternative = (name: string): string => (name.endsWith(':') ? `${escape(name)}.*` : `${escape(name)}(?:/.*)?`);

export const bannedPackages = (names: string[], message: string) => ({
    regex: `^(?:${names.map(alternative).join('|')})$`,
    message,
});
