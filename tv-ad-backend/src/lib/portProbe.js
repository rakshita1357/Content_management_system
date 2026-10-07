/**
 * Who is answering on a port? Used to turn "address already in use" into something useful: is it another copy of this
 * backend (very common: an old window or service still running), or some other program?
 */
export async function whoUsesPort(port, { host = '127.0.0.1', tls = false, timeoutMs = 1500 } = {}) {
  try {
    const res = await fetch(`${tls ? 'https' : 'http'}://${host}:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json();
    if (body && body.ok === true && 'webVersion' in body) return { ours: true, version: body.version || null };
  } catch { /* not our backend, not http, or not answering */ }
  return { ours: false, version: null };
}

/** The message to show when the backend cannot take its port. */
export function portInUseMessage(port, who) {
  const how = process.platform === 'win32'
    ? `On Windows, "netstat -ano | findstr :${port}" shows the program's PID in the last column; stop it with "taskkill /PID <pid> /F".`
    : `"lsof -i :${port}" (or "ss -ltnp | grep ${port}") shows which program it is.`;
  return who.ours
    ? `Port ${port} is already in use by another copy of this backend${who.version ? ` (version ${who.version})` : ''}. It is probably still running in another window or as a service. Stop that one first, or start this one on a different port with PORT=${port + 1}. ${how}`
    : `Port ${port} is already in use by another program. Stop it, or start this backend on a different port with PORT=${port + 1}. ${how}`;
}
