import * as vscode from 'vscode';

export const channel = vscode.window.createOutputChannel('CanMV');

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const scopedMessagePattern = /^\[([A-Za-z0-9 _./:-]+)\]\s*(.*)$/;

export function log(msg: string): void {
  const normalized = normalizeLegacyMessage(msg);
  writeLog(normalized.level, normalized.scope, normalized.message);
}

export function logDebug(scope: string, msg: string): void {
  writeLog('DEBUG', scope, msg);
}

export function logInfo(scope: string, msg: string): void {
  writeLog('INFO', scope, msg);
}

export function logWarn(scope: string, msg: string): void {
  writeLog('WARN', scope, msg);
}

export function logError(scope: string, msg: string): void {
  writeLog('ERROR', scope, msg);
}

export function logBlock(scope: string, title: string, content: string, maxLines = 80): void {
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) return;
  writeLog('INFO', scope, `${title} (${lines.length} line${lines.length === 1 ? '' : 's'})`);
  for (const line of lines.slice(0, maxLines)) {
    channel.appendLine(`${timestamp()} [INFO] [${scope}]   ${line}`);
  }
  if (lines.length > maxLines) {
    channel.appendLine(`${timestamp()} [INFO] [${scope}]   ... ${lines.length - maxLines} more lines omitted`);
  }
}

function writeLog(level: LogLevel, scope: string, msg: string): void {
  const ts = new Date().toISOString().split('T')[1].split('.')[0];
  const prefix = `[${ts}] [${level}] [${scope}]`;
  const lines = String(msg || '').split(/\r?\n/);
  for (const line of lines) {
    channel.appendLine(`${prefix} ${line}`);
  }
}

function normalizeLegacyMessage(msg: string): { level: LogLevel; scope: string; message: string } {
  let message = String(msg || '');
  let level: LogLevel = 'INFO';
  if (/^(ERROR|Error):\s*/.test(message)) {
    level = 'ERROR';
    message = message.replace(/^(ERROR|Error):\s*/, '');
  } else if (/^(WARN|Warning):\s*/.test(message)) {
    level = 'WARN';
    message = message.replace(/^(WARN|Warning):\s*/, '');
  }

  const match = message.match(scopedMessagePattern);
  if (match) {
    return { level, scope: match[1].trim(), message: match[2] || '' };
  }
  return { level, scope: 'Core', message };
}

function timestamp(): string {
  return `[${new Date().toISOString().split('T')[1].split('.')[0]}]`;
}
