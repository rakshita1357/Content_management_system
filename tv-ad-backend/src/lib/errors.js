// Errors with an HTTP status and an optional "how to fix it" hint shown in the admin page.
export class AppError extends Error {
  constructor(status, message, hint = null, code = null) {
    super(message);
    this.status = status;
    this.hint = hint;
    this.code = code;
  }
}

// Turns a failed Google API response into a readable error.
export async function driveError(res, action) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || body?.error_description || '';
  } catch { /* body was not JSON */ }
  const text = `${detail}`.toLowerCase();
  let hint = null;
  if (res.status === 404) {
    hint = 'Check DRIVE_FOLDER_ID, and make sure the Google account you signed in with (npm run auth) can open that folder. Without OAuth, the folder must be shared as "Anyone with the link: Viewer".';
  } else if (text.includes('api key not valid') || text.includes('api_key_invalid')) {
    hint = 'DRIVE_API_KEY is wrong. Copy it again from Google Cloud > APIs & Services > Credentials.';
  } else if (text.includes('has not been used') || text.includes('is disabled')) {
    hint = 'Enable the Google Drive API for this Google Cloud project, wait two minutes, then retry.';
  } else if (text.includes('referer') || text.includes('blocked')) {
    hint = 'The API key has an application restriction that blocks the backend. Use "None" for application restrictions and restrict it to the Drive API instead.';
  } else if (res.status === 401) {
    hint = 'Google rejected the login. Run "npm run auth" again to get a new refresh token.';
  } else if (res.status === 403 && text.includes('insufficient')) {
    hint = 'The OAuth token lacks Drive write access. Run "npm run auth" again.';
  } else if (res.status === 403 && text.includes('quota')) {
    hint = 'Google API quota reached. It resets on its own; increase SYNC_INTERVAL_SEC if this repeats.';
  }
  const err = new AppError(502, `Google Drive refused to ${action} (HTTP ${res.status})${detail ? `: ${detail}` : ''}`, hint);
  err.googleStatus = res.status;
  return err;
}
