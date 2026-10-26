/** What `larry` writes, formatted as the project's own `format:check` will read it. */
import { format } from 'prettier';

import { prettierConfig } from '../prettier.ts';

/** The files Prettier formats; the hooks and ignore files are not code. */
export const FORMATTED = /\.(?:[cm]?js|ts|json|ya?ml)$/;

export const prettify = (file: string, content: string): Promise<string> =>
    format(content, { ...prettierConfig, filepath: file });
