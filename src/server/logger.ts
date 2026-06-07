import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const logsDir = path.resolve(process.cwd(), 'logs');

type LogLevel = 'info' | 'warn' | 'error';
type LogName = 'scraper' | 'server';

function formatLine(level: LogLevel, message: string, meta?: unknown) {
  const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
  return `${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}\n`;
}

export async function writeLog(name: LogName, level: LogLevel, message: string, meta?: unknown) {
  const line = formatLine(level, message, meta);
  await mkdir(logsDir, { recursive: true });
  await appendFile(path.join(logsDir, `${name}.log`), line, 'utf8');

  const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleMethod(line.trim());
}

export function logScraper(level: LogLevel, message: string, meta?: unknown) {
  void writeLog('scraper', level, message, meta).catch((error) => {
    console.error(`Failed to write scraper log: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export function logServer(level: LogLevel, message: string, meta?: unknown) {
  void writeLog('server', level, message, meta).catch((error) => {
    console.error(`Failed to write server log: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export async function readLogTail(name: LogName, lines = 200) {
  const safeLines = Math.max(1, Math.min(lines, 1000));
  try {
    const content = await readFile(path.join(logsDir, `${name}.log`), 'utf8');
    return content.trimEnd().split(/\r?\n/).slice(-safeLines);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
