import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "../lib/prisma";
import { createForumPost, getForumTagIdByName } from "../lib/discord";

type TallyField = {
  key: string;
  label?: string;
  type?: string;
  value?: unknown;
};

type TallyWebhookPayload = {
  eventId: string;
  eventType: string;
  createdAt: string;
  data?: {
    responseId?: string;
    submissionId?: string;
    respondentId?: string;
    formId?: string;
    formName?: string;
    createdAt?: string;
    fields?: TallyField[];
  };
};

function normalizeProvidedSignature(sigRaw: string): Buffer | null {
  const sig = sigRaw.trim();
  const shaPrefix = "sha256=";
  const raw = sig.toLowerCase().startsWith(shaPrefix)
    ? sig.slice(shaPrefix.length)
    : sig;

  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  try {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) return b;
  } catch {
    // ignore
  }
  return null;
}

function getFieldValueByLabel(
  fields: TallyField[] | undefined,
  label: string,
): string | null {
  const field = fields?.find((f) => f.label === label);
  if (!field) return null;
  const v = field.value;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return v == null ? null : JSON.stringify(v);
}

const router = new Hono({ strict: false });

router.post("/tally", async (c) => {
  const signingSecret = process.env.TALLY_SIGNING_SECRET ?? "tally.abc";

  const rawBody = Buffer.from(await c.req.raw.arrayBuffer());
  const providedHeader =
    c.req.header("tally-signature") ?? c.req.header("x-tally-signature") ?? "";
  const provided = providedHeader
    ? normalizeProvidedSignature(providedHeader)
    : null;

  const expected = createHmac("sha256", signingSecret).update(rawBody).digest();
  const ok =
    provided != null &&
    provided.length === expected.length &&
    timingSafeEqual(provided, expected);
  if (!ok) return c.json({ ok: false, error: "Invalid signature" }, 401);

  let payload: TallyWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as TallyWebhookPayload;
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const fields = payload.data?.fields ?? [];
  const courseId = getFieldValueByLabel(fields, "course_id");
  const discordId = getFieldValueByLabel(fields, "discord_id");
  const submissionText = getFieldValueByLabel(fields, "Submission");
  const subcourseId = getFieldValueByLabel(fields, "subcourse_id");

  if (!payload.eventId || !payload.eventType || !payload.createdAt) {
    return c.json(
      { ok: false, error: "Missing required top-level fields" },
      400,
    );
  }
  if (!courseId || !discordId || submissionText == null) {
    return c.json(
      {
        ok: false,
        error:
          "Missing required field labels: course_id, discord_id, Submission",
      },
      400,
    );
  }

  const existingSubcourse = await prisma.subcourse.findFirst({
    where: { parentCourseId: courseId },
    select: { id: true },
  });

  if (existingSubcourse && !subcourseId) {
    return c.json(
      {
        ok: false,
        error:
          "This course requires subcourse_id in the Tally payload but it is missing.",
      },
      400,
    );
  }

  // Persist (idempotent on eventId)
  let effectiveCourseId = courseId;
  let effectiveSubcourseId: string | null = null;
  let subcourseName: string | null = null;

  if (subcourseId) {
    const subcourse = await prisma.subcourse.findUnique({
      where: { id: subcourseId },
      include: { parentCourse: true },
    });

    if (!subcourse) {
      return c.json(
        { ok: false, error: `Invalid subcourse_id: ${subcourseId}` },
        400,
      );
    }

    if (subcourse.parentCourseId !== courseId) {
      return c.json(
        {
          ok: false,
          error:
            "subcourse_id does not belong to the provided course_id (parent course mismatch)",
        },
        400,
      );
    }

    effectiveCourseId = subcourse.parentCourseId;
    effectiveSubcourseId = subcourse.id;
    subcourseName = subcourse.name;
  }

  const created = await prisma.tallySubmission
    .create({
      data: {
        eventId: payload.eventId,
        eventType: payload.eventType,
        eventCreatedAt: new Date(payload.createdAt),
        responseId: payload.data?.responseId ?? null,
        submissionId: payload.data?.submissionId ?? null,
        courseId: effectiveCourseId,
        subcourseId: effectiveSubcourseId,
        discordId,
        submissionText,
      },
      select: { id: true },
    })
    .catch((e: unknown) => {
      // Prisma unique constraint violation (eventId already stored)
      if (
        typeof e === "object" &&
        e &&
        "code" in e &&
        (e as any).code === "P2002"
      )
        return null;
      throw e;
    });

  // If this event was already processed, don't create another Discord thread
  if (!created) {
    return c.json(
      {
        ok: true,
        stored: false,
        warning: "Duplicate eventId, Discord thread creation skipped",
      },
      200,
    );
  }

  // Ensure only one active (unreviewed) submission thread per user per course.
  // Look up the most recent prior submission for this user & course.
  const priorWhere: any = {
    courseId: effectiveCourseId,
    discordId,
    id: { not: created.id },
  };

  if (effectiveSubcourseId) {
    priorWhere.subcourseId = effectiveSubcourseId;
  }

  const prior = await prisma.tallySubmission.findFirst({
    where: priorWhere,
    orderBy: { createdAt: "desc" },
    include: { evaluation: true },
  });

  if (prior && !prior.evaluation) {
    return c.json(
      {
        ok: true,
        stored: created != null,
        warning:
          "Previous submission for this course is not yet reviewed; forum thread creation skipped.",
      },
      200,
    );
  }

  const course = await prisma.course.findUnique({
    where: { id: effectiveCourseId },
    select: { channel_id: true, name: true },
  });
  const channelId = course?.channel_id ?? null;
  const courseName = course?.name ?? effectiveCourseId;

  // Count how many submissions this user has made for this course (including this one)
  const submissionCountWhere: any = {
    courseId: effectiveCourseId,
    discordId,
  };
  if (effectiveSubcourseId) {
    submissionCountWhere.subcourseId = effectiveSubcourseId;
  }

  const submissionCount = await prisma.tallySubmission.count({
    where: submissionCountWhere,
  });
  if (!channelId) {
    return c.json(
      {
        ok: true,
        stored: created != null,
        warning: "Course missing channel_id",
      },
      202,
    );
  }

  let appliedTagIds: string[] | undefined;
  if (subcourseName) {
    const tagId = await getForumTagIdByName(channelId, subcourseName);
    if (tagId) {
      appliedTagIds = [tagId];
    } else {
      console.warn(
        "Webhook: subcourse tag not found in forum; continuing without tag",
        {
          channelId,
          subcourseName,
        },
      );
    }
  }

  const threadTitleBase = subcourseName
    ? `[${subcourseName}] ${courseName}`
    : courseName;

  const headerLines = [
    `Course: ${courseName} (${effectiveCourseId})`,
    subcourseName ? `Subcourse: ${subcourseName} (${effectiveSubcourseId})` : null,
    `User: <@${discordId}>`,
    `Submission ke-${submissionCount}`,
    "",
  ].filter((line): line is string => Boolean(line));

  const thread = await createForumPost({
    channelId,
    name: `${threadTitleBase} - Submission #${submissionCount}`,
    content: [...headerLines, submissionText].join("\n"),
    appliedTagIds,
  });

  return c.json(
    { ok: true, stored: created != null, threadId: thread.id },
    200,
  );
});

export default router;
