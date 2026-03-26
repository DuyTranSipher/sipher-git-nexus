/**
 * Spinner helper for long-running Unreal CLI commands.
 * Uses braille-dot animation with elapsed time — CLI layer only.
 */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const GREEN = '\x1b[92m';
const RED = '\x1b[91m';
const YELLOW = '\x1b[93m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

export interface SpinnerOptions {
  phaseLabel: string;
  successLabel?: string;
  failLabel?: string;
  /** Check if the result indicates an error (for non-throwing error returns). */
  isError?: (result: any) => boolean;
}

export async function withUnrealProgress<T>(
  operation: () => Promise<T>,
  opts: SpinnerOptions,
): Promise<T> {
  const start = Date.now();
  let frame = 0;
  let aborted = false;

  const clearLine = () => process.stdout.write('\r\x1b[2K');

  const render = () => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    const time = elapsed > 0 ? ` ${DIM}(${elapsed}s)${RESET}` : '';
    clearLine();
    process.stdout.write(`  ${YELLOW}${spinner}${RESET} ${opts.phaseLabel}...${time}`);
    frame++;
  };

  // Initial render + tick every 80ms for smooth animation
  render();
  const timer = setInterval(render, 80);

  const sigintHandler = () => {
    if (aborted) process.exit(1);
    aborted = true;
    clearInterval(timer);
    clearLine();
    process.stdout.write(`  ${RED}✗${RESET} Interrupted\n`);
    process.exit(130);
  };
  process.on('SIGINT', sigintHandler);

  const cleanup = () => {
    clearInterval(timer);
    process.removeListener('SIGINT', sigintHandler);
  };

  try {
    const result = await operation();
    cleanup();
    const totalSec = ((Date.now() - start) / 1000).toFixed(1);
    if (opts.isError?.(result)) {
      const label = opts.failLabel || 'Failed';
      clearLine();
      process.stdout.write(`  ${RED}${BOLD}✗${RESET} ${label} ${DIM}(${totalSec}s)${RESET}\n`);
    } else {
      const label = opts.successLabel || 'Done';
      clearLine();
      process.stdout.write(`  ${GREEN}${BOLD}✓${RESET} ${label} ${DIM}(${totalSec}s)${RESET}\n`);
    }
    return result;
  } catch (error) {
    cleanup();
    const totalSec = ((Date.now() - start) / 1000).toFixed(1);
    const label = opts.failLabel || 'Failed';
    clearLine();
    process.stdout.write(`  ${RED}${BOLD}✗${RESET} ${label} ${DIM}(${totalSec}s)${RESET}\n`);
    throw error;
  }
}
