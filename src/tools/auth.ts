/**
 * Sign-in tools: sac_login, sac_logout.
 *
 * Each person signs in to SAC with their own account through SSO.
 * API tools start the browser sign-in on their own when needed;
 * sac_login also waits for it to finish.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAccessToken, logout } from "../auth/sac-client.js";
import { describeToken, SignInRequiredError, startSignIn } from "../auth/user-login.js";
import { getConfig, toolError, toolSuccess } from "./_helpers.js";

/** Sign in (opening the browser only when needed) and return who is signed in. */
export async function signIn(): Promise<{ user?: string; email?: string }> {
  const cfg = getConfig();
  try {
    return describeToken(await getAccessToken(cfg));
  } catch (e) {
    if (!(e instanceof SignInRequiredError)) throw e;
    const { done } = await startSignIn(cfg);
    return describeToken((await done).access_token);
  }
}

export function registerAuthTools(server: McpServer): void {
  server.tool(
    "sac_login",
    "Sign in to SAP Analytics Cloud as yourself with SSO. Opens a browser window " +
      "and waits up to 5 minutes for you to finish. Returns the signed-in user. " +
      "No-op when already signed in.",
    {},
    async () => {
      try {
        return toolSuccess({ signedIn: true, ...(await signIn()) });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_logout",
    "Sign out of SAP Analytics Cloud and delete the stored tokens on this machine.",
    {},
    async () => {
      try {
        logout(getConfig());
        return toolSuccess({ signedIn: false });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
