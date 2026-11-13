/**
 * A line that turns while something runs, for a terminal only. It redraws itself in place
 * and clears itself when stopped, so nothing it drew stays on the screen.
 */
import { styleText } from 'node:util';

type Spinner = {
    /** Clears the line and brings the cursor back. */
    stop: () => void;
};

/** The frames and pace of init's spinner, so the two commands turn alike. */
const FRAMES = ['◒', '◐', '◓', '◑'];
const INTERVAL_MS = 80;

const CLEAR_LINE = '\r\u001b[2K';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';

/**
 * @param stream The terminal to draw on.
 * @param label What is running, shown beside the frame with the seconds it has taken.
 */
export function spinner(stream: NodeJS.WritableStream, label: string): Spinner {
    const started = performance.now();
    let frame = 0;
    const draw = (): void => {
        const mark = styleText('magenta', FRAMES[frame % FRAMES.length] ?? '', { stream });
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        stream.write(`${CLEAR_LINE}${mark} ${label} ${styleText('dim', `${seconds}s`, { stream })}`);
        frame += 1;
    };

    stream.write(HIDE_CURSOR);
    draw();
    const timer = setInterval(draw, INTERVAL_MS);
    return {
        stop(): void {
            clearInterval(timer);
            stream.write(`${CLEAR_LINE}${SHOW_CURSOR}`);
        },
    };
}
