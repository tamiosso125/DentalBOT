import "server-only";

/** Panel settings, read on the server only. The API token never reaches the browser. */
export function panelConfig() {
  const apiUrl = process.env.DENTALBOT_API_URL ?? "http://localhost:3000";
  const apiToken = process.env.ADMIN_API_TOKEN;
  const password = process.env.PANEL_PASSWORD;
  const sessionSecret = process.env.PANEL_SESSION_SECRET;
  if (!apiToken || !password || !sessionSecret || sessionSecret.length < 32)
    throw new Error(
      "Panel needs ADMIN_API_TOKEN, PANEL_PASSWORD and PANEL_SESSION_SECRET (32+ chars)",
    );
  return { apiUrl, apiToken, password, sessionSecret };
}
