import { Hono } from "hono";
import { prisma } from "../lib/prisma";

const INTERNAL_TOKEN = process.env.DISCORD_INTERNAL_TOKEN;

const router = new Hono();

router.use("*", async (c, next) => {
  if (!INTERNAL_TOKEN) return c.text("Missing internal token", 500);
  const header = c.req.header("x-internal-token") ?? "";
  if (header !== INTERNAL_TOKEN) {
    return c.text("Unauthorized", 401);
  }
  await next();
});

router.post("/mentor/evaluate", async (c) => {
  const body = await c.req.json<{
    discordId: string;
    courseId: string;
    tallySubmissionId: string;
    mentorDiscordId: string;
    status: string;
    threadId: string;
    messageId: string;
  }>();

  if (
    !body.discordId ||
    !body.courseId ||
    !body.tallySubmissionId ||
    !body.mentorDiscordId ||
    !body.status ||
    !body.threadId ||
    !body.messageId
  ) {
    return c.json({ ok: false, error: "Missing required fields" }, 400);
  }

  const submission = await prisma.tallySubmission.findUnique({
    where: { id: body.tallySubmissionId },
  });
  if (!submission || submission.discordId !== body.discordId) {
    return c.json({ ok: false, error: "Submission mismatch" }, 400);
  }

  const existingEvaluation = await prisma.submissionEvaluation.findUnique({
    where: { tallySubmissionId: submission.id },
  });
  if (existingEvaluation) {
    return c.json(
      { ok: false, error: "Submission already evaluated and cannot be updated" },
      409,
    );
  }

  const evaluation = await prisma.submissionEvaluation.create({
    data: {
      tallySubmissionId: submission.id,
      mentorDiscordId: body.mentorDiscordId,
      status: body.status,
      threadId: body.threadId,
      messageId: body.messageId,
    },
  });

  return c.json({ ok: true, evaluation }, 200);
});

router.post("/mentor/rate", async (c) => {
  const body = await c.req.json<{
    evaluationId: string;
    userDiscordId: string;
    rating: number;
  }>();

  if (!body.evaluationId || !body.userDiscordId || !body.rating) {
    return c.json({ ok: false, error: "Missing required fields" }, 400);
  }

  if (body.rating < 1 || body.rating > 5) {
    return c.json({ ok: false, error: "Invalid rating" }, 400);
  }

  const evaluation = await prisma.submissionEvaluation.findUnique({
    where: { id: body.evaluationId },
    include: { tallySubmission: true },
  });
  if (!evaluation) {
    return c.json({ ok: false, error: "Evaluation not found" }, 404);
  }
  if (evaluation.tallySubmission.discordId !== body.userDiscordId) {
    return c.json({ ok: false, error: "Only owner can rate" }, 403);
  }

  const rating = await prisma.mentorRating.create({
    data: {
      evaluationId: evaluation.id,
      userDiscordId: body.userDiscordId,
      rating: body.rating,
    },
  });

  return c.json({ ok: true, rating }, 200);
});

router.post("/mentor/reaction-log", async (c) => {
  const body = await c.req.json<{
    courseId: string;
    threadId: string;
    messageId: string;
    mentorDiscordId: string;
  }>();

  if (!body.courseId || !body.threadId || !body.messageId || !body.mentorDiscordId) {
    return c.json({ ok: false, error: "Missing required fields" }, 400);
  }

  const log = await prisma.mentorReactionLog.create({
    data: {
      courseId: body.courseId,
      threadId: body.threadId,
      messageId: body.messageId,
      mentorDiscordId: body.mentorDiscordId,
    },
  });

  return c.json({ ok: true, log }, 200);
});

export default router;

