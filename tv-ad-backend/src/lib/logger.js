// Small logger for a service that runs unattended: levels, optional JSON lines (for log collectors), no secrets.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info', format = 'text', out = console, now = () => new Date() } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    const time = now().toISOString();
    const line = format === 'json'
      ? JSON.stringify({ time, level: lvl, msg: String(msg), ...fields })
      : `${time} ${lvl.toUpperCase().padEnd(5)} ${msg}${fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ''}`;
    (lvl === 'error' || lvl === 'warn' ? out.error : out.log).call(out, line);
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
