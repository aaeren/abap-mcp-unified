/** Escape HTML special characters to prevent XSS. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Self-contained login page HTML. Served at /login?session=<id>.
 * The user enters SAP credentials, the form POSTs back to the server.
 * Credentials never pass through Claude or the LLM context.
 */
export function renderLoginPage(sapUrl: string, sessionId: string, error?: string): string {
  const host = escapeHtml(new URL(sapUrl).hostname.split('.')[0].toUpperCase()); // e.g. D25APP → D25APP
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>dassian-adt — SAP Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); padding: 32px; width: 100%; max-width: 400px; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    .subtitle { color: #666; font-size: 14px; margin-bottom: 24px; }
    .system { display: inline-block; background: #e8f4fd; color: #1a73e8; padding: 2px 8px; border-radius: 4px; font-family: monospace; font-size: 13px; }
    label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 4px; margin-top: 16px; }
    input { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
    input:focus { outline: none; border-color: #1a73e8; box-shadow: 0 0 0 2px rgba(26,115,232,0.2); }
    button { width: 100%; padding: 12px; background: #1a73e8; color: white; border: none; border-radius: 6px; font-size: 15px; font-weight: 500; cursor: pointer; margin-top: 24px; }
    button:hover { background: #1557b0; }
    .error { background: #fce8e6; color: #c5221f; padding: 10px 12px; border-radius: 6px; font-size: 13px; margin-bottom: 16px; }
    .success { background: #e6f4ea; color: #137333; padding: 16px; border-radius: 6px; text-align: center; }
    .success h2 { margin-bottom: 8px; }
    .footer { text-align: center; margin-top: 16px; font-size: 12px; color: #999; }
  </style>
</head>
<body>
  <div class="card">
    <h1>dassian-adt</h1>
    <p class="subtitle">Connect to SAP system <span class="system">${host}</span></p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/login">
      <input type="hidden" name="session" value="${escapeHtml(sessionId)}">
      <label for="username">SAP Username</label>
      <input type="text" id="username" name="username" placeholder="e.g. PMCFARLING" required autocomplete="username" autofocus>
      <label for="password">SAP Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
      <button type="submit">Connect</button>
    </form>
    <p class="footer">Credentials are stored in server memory only. They are never sent to Claude or any AI model.</p>
  </div>
</body>
</html>`;
}

export function renderLoginSuccess(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>dassian-adt — Connected</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); padding: 32px; width: 100%; max-width: 400px; text-align: center; }
    .check { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 20px; margin-bottom: 8px; }
    p { color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">&#10003;</div>
    <h1>Connected to SAP</h1>
    <p>You can close this tab and return to Claude. Your SAP tools are now active.</p>
  </div>
</body>
</html>`;
}
