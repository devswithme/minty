import { Hono } from "hono";
import type { AuthType } from "./lib/auth";
import { prisma } from "./lib/prisma";
import auth from "./routes/auth";
import submit from "./routes/submit";
import webhook from "./routes/webhook";
import mentor from "./routes/mentor";

const app = new Hono({
  strict: false,
});

// Root (non-/api) routes
app.route("/", submit as any);
app.route("/webhook", webhook as any);

app.get("/v/:certificateId", async (c) => {
  const certificateId = c.req.param("certificateId");

  const evaluation = (await prisma.submissionEvaluation.findFirst({
    where: { certificateId } as any,
    include: {
      tallySubmission: true,
    } as any,
  } as any)) as any;

  if (evaluation) {
    const submission = evaluation.tallySubmission;
    const course = await prisma.course
      .findUnique({
        where: { id: submission.courseId },
        select: { name: true },
      })
      .catch(() => null);

    const avgScore =
      (evaluation.codeQuality +
        evaluation.functionality +
        evaluation.conceptualUnderstanding) /
      3;

    return c.json({
      valid: true,
      certificateId,
      status: evaluation.status,
      issuedAt: evaluation.certificateIssuedAt,
      courseId: submission.courseId,
      courseName: course?.name ?? submission.courseId,
      studentDiscordId: submission.discordId,
      leadMentorDiscordId: evaluation.mentorDiscordId,
      leadMentorName: evaluation.leadMentorName ?? null,
      rubrics: {
        codeQuality: evaluation.codeQuality,
        functionality: evaluation.functionality,
        conceptualUnderstanding: evaluation.conceptualUnderstanding,
        average: Number.isFinite(avgScore) ? avgScore : null,
      },
    });
  }

  const parentCompletion = await prisma.parentCourseCompletion.findFirst({
    where: { certificateId },
    include: {
      parentCourse: true,
    },
  });

  if (!parentCompletion) {
    return c.json({ valid: false, error: "Certificate not found" }, 404);
  }

  return c.json({
    valid: true,
    certificateId,
    status: "PASS",
    issuedAt: parentCompletion.issuedAt,
    courseId: parentCompletion.parentCourseId,
    courseName: parentCompletion.parentCourse.name,
    studentDiscordId: parentCompletion.discordId,
    leadMentorDiscordId: null,
    leadMentorName: null,
    rubrics: {
      codeQuality: null,
      functionality: null,
      conceptualUnderstanding: null,
      average: null,
    },
  });
});

// /api routes
const routes = [auth, mentor] as const;

routes.forEach((route) => {
  app.basePath("/api").route("/", route as any);
});

export default app;
