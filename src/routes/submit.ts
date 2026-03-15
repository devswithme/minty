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

  const subcourseId = c.req.query("subcourse_id") ?? null;

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
    const callbackURL = `/submit?course_id=${encodeURIComponent(
      courseId,
    )}${subcourseId ? `&subcourse_id=${encodeURIComponent(subcourseId)}` : ""}`;
    return c.redirect(
      `/api/auth/signin/discord?callbackURL=${encodeURIComponent(callbackURL)}`,
      302,
    );
  }

  // Ensure the course_id exists in the DB (create placeholder if missing)
  const course = await prisma.course.upsert({
    where: { id: courseId },
    update: {},
    create: { id: courseId, name: courseId },
  });

  const hasSubcourses = await prisma.subcourse.findFirst({
    where: { parentCourseId: course.id },
    select: { id: true },
  });

  if (hasSubcourses && !subcourseId) {
    return c.text(
      "This course requires a subcourse_id. Please use a link that includes subcourse_id.",
      400,
    );
  }

  const discordAccount = await prisma.account.findFirst({
    where: { userId, providerId: "discord" },
    select: { accountId: true },
  });

  if (!discordAccount?.accountId) {
    const callbackURL = `/submit?course_id=${encodeURIComponent(
      courseId,
    )}${subcourseId ? `&subcourse_id=${encodeURIComponent(subcourseId)}` : ""}`;
    return c.redirect(
      `/api/auth/signin/discord?callbackURL=${encodeURIComponent(callbackURL)}`,
      302,
    );
  }

  const tally = new URL("https://tally.so/r/XxGO8z");
  tally.searchParams.set("discord_id", discordAccount.accountId);
  tally.searchParams.set("course_id", courseId);
  if (subcourseId) {
    tally.searchParams.set("subcourse_id", subcourseId);
  }
  return c.redirect(tally.toString(), 302);
});

export default router;

