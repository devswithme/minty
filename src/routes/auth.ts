import { Hono } from "hono";
import { auth } from "../lib/auth";
import type { AuthType } from "../lib/auth";

const router = new Hono<{ Bindings: AuthType }>({
  strict: false,
});

// GET /auth/signin/:provider → converts to POST /sign-in/social and redirects to OAuth URL
router.get("/auth/signin/:provider", async (c) => {
  const provider = c.req.param("provider");
  const callbackURL = c.req.query("callbackURL") || "/";
  const origin = new URL(c.req.url).origin;

  const internalReq = new Request(`${origin}/api/auth/sign-in/social`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(c.req.header("cookie") ? { Cookie: c.req.header("cookie")! } : {}),
    },
    body: JSON.stringify({ provider, callbackURL }),
  });

  const response = await auth.handler(internalReq);
  const data = (await response.json()) as { url?: string; redirect?: boolean };

  if (data?.url) {
    // Forward all Set-Cookie headers so the state cookie reaches the browser
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") {
        c.header("Set-Cookie", value, { append: true });
      }
    });
    return c.redirect(data.url, 302);
  }
  return c.text("Failed to initiate OAuth flow", 500);
});

router.on(["POST", "GET"], "/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

export default router;
