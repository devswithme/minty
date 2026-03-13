import { Hono } from "hono";
import { auth } from "../lib/auth";
import { prisma } from "../lib/prisma";

const router = new Hono();

type SessionResponse =
  | null
  | {
      session: { userId: string } | null;
      user: { id: string } | null;
    };

router.get("/submit", async (c) => {
  const courseId = c.req.query("course_id");
  if (!courseId) return c.text("Missing course_id", 400);

  const origin = new URL(c.req.url).origin;
  const cookie = c.req.header("cookie") ?? "";

  const sessionReq = new Request(`${origin}/api/auth/get-session`, {
    method: "GET",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      Origin: origin,
    },
  });

  const sessionRes = await auth.handler(sessionReq);
  const sessionData = (await sessionRes.json()) as SessionResponse;
  const userId = sessionData?.user?.id ?? null;

  if (!userId) {
    const callbackURL = `/submit?course_id=${encodeURIComponent(courseId)}`;
    return c.redirect(
      `/api/auth/signin/discord?callbackURL=${encodeURIComponent(callbackURL)}`,
      302,
    );
  }

  // Ensure the course_id exists in the DB (create placeholder if missing)
  await prisma.course.upsert({
    where: { id: courseId },
    update: {},
    create: { id: courseId, name: courseId },
  });

  const discordAccount = await prisma.account.findFirst({
    where: { userId, providerId: "discord" },
    select: { accountId: true },
  });

  if (!discordAccount?.accountId) {
    const callbackURL = `/submit?course_id=${encodeURIComponent(courseId)}`;
    return c.redirect(
      `/api/auth/signin/discord?callbackURL=${encodeURIComponent(callbackURL)}`,
      302,
    );
  }

  const tally = new URL("https://tally.so/r/XxGO8z");
  tally.searchParams.set("discord_id", discordAccount.accountId);
  tally.searchParams.set("course_id", courseId);
  return c.redirect(tally.toString(), 302);
});

export default router;

