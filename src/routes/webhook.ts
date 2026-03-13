import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "../lib/prisma";
import { createForumPost } from "../lib/discord";

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

  // Persist (idempotent on eventId)
  const created = await prisma.tallySubmission
    .create({
      data: {
        eventId: payload.eventId,
        eventType: payload.eventType,
        eventCreatedAt: new Date(payload.createdAt),
        responseId: payload.data?.responseId ?? null,
        submissionId: payload.data?.submissionId ?? null,
        courseId,
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
  const prior = await prisma.tallySubmission.findFirst({
    where: {
      courseId,
      discordId,
      id: { not: created.id },
    },
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
    where: { id: courseId },
    select: { channel_id: true, name: true },
  });
  const channelId = course?.channel_id ?? null;
  const courseName = course?.name ?? courseId;

  // Count how many submissions this user has made for this course (including this one)
  const submissionCount = await prisma.tallySubmission.count({
    where: {
      courseId,
      discordId,
    },
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

  const thread = await createForumPost({
    channelId,
    name: `${courseName} - Submission #${submissionCount}`,
    content: [
      `Course: ${courseName} (${courseId})`,
      `User: <@${discordId}>`,
      `Submission ke-${submissionCount}`,
      "",
      submissionText,
    ].join("\n"),
  });

  return c.json(
    { ok: true, stored: created != null, threadId: thread.id },
    200,
  );
});

export default router;
