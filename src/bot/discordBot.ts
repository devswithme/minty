import "dotenv/config";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  MessageReaction,
  Partials,
  ThreadChannel,
  User,
} from "discord.js";
import { customAlphabet } from "nanoid";
import { prisma } from "../lib/prisma";
import { generateCertificateImage } from "../lib/certificate";

const token = process.env.DISCORD_BOT_TOKEN;
const mentorRoleId = process.env.MENTOR_ROLE_ID || "";
const appBaseUrl = process.env.APP_BASE_URL || "http://localhost:3000";

const CERT_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CERT_ID_LENGTH = 12;
const createCertificateId = customAlphabet(CERT_ID_ALPHABET, CERT_ID_LENGTH);

if (!token) {
  throw new Error("Missing DISCORD_BOT_TOKEN for bot gateway");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const STATUS_TAG_OPEN = "Open";
const STATUS_TAG_CLAIMED = "Claimed";
const STATUS_TAG_REVIEWED = "Reviewed";

type StatusTagIds = {
  openId?: string;
  claimedId?: string;
  reviewedId?: string;
};

const forumStatusTagCache = new Map<string, StatusTagIds>();

function isLeadMentor(message: Message | MessageReaction, user: User): boolean {
  const guild = "guild" in message ? message.guild : message.message.guild;
  if (!guild) return false;
  if (!mentorRoleId) return false;
  const member = guild.members.cache.get(user.id);
  if (!member) return false;
  return member.roles.cache.has(mentorRoleId);
}

type ThreadStatus = "OPEN" | "CLAIMED" | "REVIEWED";

function buildVerificationUrl(certificateId: string): string {
  const base = appBaseUrl.replace(/\/+$/, "");
  return `${base}/v/${certificateId}`;
}

async function getStatusTagIdsForForum(parent: any): Promise<StatusTagIds> {
  if (!parent || !parent.id) return {};

  const cached = forumStatusTagCache.get(parent.id);
  if (cached) return cached;

  const tags = Array.isArray((parent as any).availableTags)
    ? ((parent as any).availableTags as { id: string; name: string }[])
    : [];

  const findByName = (name: string): string | undefined => {
    const lower = name.toLowerCase();
    const tag = tags.find((t) => t.name.toLowerCase() === lower);
    return tag?.id;
  };

  const ids: StatusTagIds = {
    openId: findByName(STATUS_TAG_OPEN),
    claimedId: findByName(STATUS_TAG_CLAIMED),
    reviewedId: findByName(STATUS_TAG_REVIEWED),
  };

  forumStatusTagCache.set(parent.id, ids);

  if (!ids.openId || !ids.claimedId || !ids.reviewedId) {
    console.warn("Status tags not fully configured for forum channel", {
      forumId: parent.id,
      availableTags: tags.map((t) => ({ id: t.id, name: t.name })),
    });
  }

  return ids;
}

function parseStarterContent(
  content: string,
): { courseId: string | null; userDiscordId: string | null } {
  const lines = content.split("\n");
  const courseLine = lines.find((line) => line.startsWith("Course:")) || null;
  const userLine = lines.find((line) => line.startsWith("User:")) || null;

  let courseId: string | null = null;
  if (courseLine) {
    const match = courseLine.match(/\(([^)]+)\)\s*$/);
    if (match) {
      courseId = match[1];
    }
  }

  let userDiscordId: string | null = null;
  if (userLine) {
    const userMatch = userLine.match(/<@(\d+)>/);
    if (userMatch) {
      userDiscordId = userMatch[1];
    }
  }

  return { courseId, userDiscordId };
}

async function setThreadStatus(thread: ThreadChannel, status: ThreadStatus) {
  const parent = thread.parent;
  if (!parent || parent.type !== ChannelType.GuildForum) return;

  const { openId, claimedId, reviewedId } =
    await getStatusTagIdsForForum(parent);

  const statusTagIds: Record<ThreadStatus, string | undefined> = {
    OPEN: openId,
    CLAIMED: claimedId,
    REVIEWED: reviewedId,
  };

  const desiredTagId = statusTagIds[status];
  if (!desiredTagId) return;

  const statusIdsSet = new Set(
    [openId, claimedId, reviewedId].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
  );

  const existing = Array.isArray((thread as any).appliedTags)
    ? ((thread as any).appliedTags as string[])
    : [];

  const preserved = existing.filter((id) => !statusIdsSet.has(id));
  const nextApplied = [...preserved, desiredTagId];

  try {
    await (thread as any).setAppliedTags(nextApplied);
  } catch (err) {
    console.error("Failed to set thread status tags:", {
      threadId: thread.id,
      status,
      error: err,
    });
  }
}

async function findSubmissionByThread(
  thread: ThreadChannel,
  authorDiscordId: string | null,
) {
  // We currently only know courseId from the thread content created in webhook.ts.
  // Simpler mapping: find latest TallySubmission for this discordId and courseId.
  // Try to infer courseId and, if needed, student discordId from thread starter message content
  const starter = await thread.fetchStarterMessage().catch(() => null);
  const { courseId, userDiscordId } = starter
    ? parseStarterContent(starter.content)
    : { courseId: null, userDiscordId: null };

  let effectiveDiscordId: string | null = authorDiscordId;
  if (!effectiveDiscordId && userDiscordId) {
    effectiveDiscordId = userDiscordId;
  }

  if (!effectiveDiscordId) return null;

  const where: { discordId: string; courseId?: string } = {
    discordId: effectiveDiscordId,
  };
  if (courseId) {
    where.courseId = courseId;
  }

  const submission = await prisma.tallySubmission.findFirst({
    where,
    orderBy: { createdAt: "desc" },
  });

  return submission;
}

client.once(Events.ClientReady, (c) => {
  console.log(`Discord bot logged in as ${c.user.tag}`);

  const commands = [
    {
      name: "ev",
      description: "Evaluate a submission with PASS/FAIL and rubric scores",
      options: [
        {
          type: 3, // STRING
          name: "status",
          description: "Overall status",
          required: true,
          choices: [
            { name: "PASS", value: "PASS" },
            { name: "FAIL", value: "FAIL" },
          ],
        },
        {
          type: 4, // INTEGER
          name: "code_quality",
          description: "Code quality (0-5)",
          required: true,
          min_value: 0,
          max_value: 5,
        },
        {
          type: 4, // INTEGER
          name: "functionality",
          description: "Functionality (0-5)",
          required: true,
          min_value: 0,
          max_value: 5,
        },
        {
          type: 4, // INTEGER
          name: "conceptual",
          description: "Conceptual understanding (0-5)",
          required: true,
          min_value: 0,
          max_value: 5,
        },
      ],
    },
  ];

  const guildId = process.env.DISCORD_GUILD_ID;
  (async () => {
    try {
      if (guildId) {
        const guild = await c.guilds.fetch(guildId);
        await guild.commands.set(commands);
        console.log("Registered /ev command for guild", guildId);
      } else if (c.application) {
        await c.application.commands.set(commands);
        console.log("Registered /ev command globally");
      }
    } catch (err) {
      console.error("Failed to register /ev command:", err);
    }
  })();
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.PublicThread) return;

    if (!isLeadMentor(message, message.author)) return;

    const content = message.content.trim().toLowerCase();
    const [command] = content.split(/\s+/);
    const isPass = command === "!pass";
    const isFail = command === "!fail";

    if (!isPass && !isFail) return;

    await message.reply(
      "Perintah `!pass` dan `!fail` sudah digantikan. Silakan gunakan slash command `/ev` untuk melakukan evaluasi.",
    );
  } catch (err) {
    console.error("Error in MessageCreate handler:", err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "ev") return;

    const threadChannel = interaction.channel;
    if (!threadChannel || threadChannel.type !== ChannelType.PublicThread) {
      await interaction.reply({
        content:
          "Perintah ini hanya bisa digunakan di dalam thread submission.",
        ephemeral: true,
      });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        content: "Perintah ini hanya bisa digunakan di dalam server.",
        ephemeral: true,
      });
      return;
    }

    const member = await guild.members
      .fetch(interaction.user.id)
      .catch(() => null);
    if (!member || !mentorRoleId || !member.roles.cache.has(mentorRoleId)) {
      await interaction.reply({
        content: "Hanya mentor yang bisa melakukan evaluasi.",
        ephemeral: true,
      });
      return;
    }

    const thread = threadChannel as ThreadChannel;

    // Jika thread sudah di-claim, hanya mentor yang meng-claim yang boleh menilai
    const existingClaim = await prisma.mentorClaim
      .findUnique({
        where: { threadId: thread.id },
      })
      .catch(() => null);

    if (
      existingClaim &&
      existingClaim.mentorDiscordId !== interaction.user.id
    ) {
      await interaction.reply({
        content:
          `Thread ini sudah di-claim oleh <@${existingClaim.mentorDiscordId}> sebagai lead mentor. ` +
          "Hanya mentor tersebut yang bisa melakukan evaluasi.",
        ephemeral: true,
      });
      return;
    }

    const statusInput = interaction.options
      .getString("status", true)
      .toUpperCase();
    if (statusInput !== "PASS" && statusInput !== "FAIL") {
      await interaction.reply({
        content: "Status harus PASS atau FAIL.",
        ephemeral: true,
      });
      return;
    }

    const codeQuality =
      interaction.options.getInteger("code_quality", true) ?? 0;
    const functionality =
      interaction.options.getInteger("functionality", true) ?? 0;
    const conceptual = interaction.options.getInteger("conceptual", true) ?? 0;

    const mentorDisplayName =
      (member && (member.nickname || member.displayName)) ||
      interaction.user.globalName ||
      interaction.user.username;

    const submission = await findSubmissionByThread(thread, null);
    if (!submission) {
      await interaction.reply({
        content:
          "Tidak bisa menemukan submission untuk thread ini. Pastikan thread dibuat dari Tally.",
        ephemeral: true,
      });
      return;
    }

    const alreadyEvaluated = await prisma.submissionEvaluation.findUnique({
      where: { tallySubmissionId: submission.id },
    });
    if (alreadyEvaluated) {
      await interaction.reply({
        content: "Submission ini sudah direview dan tidak bisa diubah lagi.",
        ephemeral: true,
      });
      return;
    }

    const course = await prisma.course.findUnique({
      where: { id: submission.courseId },
      include: { subcourses: true },
    });

    const hasSubcourses = !!course && course.subcourses.length > 0;

    const certificateId =
      statusInput === "PASS" && !hasSubcourses ? createCertificateId() : null;

    const evaluation = await prisma.submissionEvaluation.create({
      data: {
        tallySubmissionId: submission.id,
        mentorDiscordId: interaction.user.id,
        leadMentorName: mentorDisplayName,
        status: statusInput,
        codeQuality,
        functionality,
        conceptualUnderstanding: conceptual,
        threadId: thread.id,
        messageId: "pending",
        certificateId,
        certificateIssuedAt: certificateId ? new Date() : null,
      } as any,
    });

    await setThreadStatus(thread, "REVIEWED");

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`mentor_rate:${evaluation.id}`)
        .setLabel("Beri rating ke mentor")
        .setStyle(ButtonStyle.Primary),
    );

    const reply = await interaction.reply({
      content: [
        `Evaluasi untuk <@${submission.discordId}>:`,
        `Status: **${statusInput}**`,
        `Code Quality: **${codeQuality}/5**`,
        `Functionality: **${functionality}/5**`,
        `Conceptual Understanding: **${conceptual}/5**`,
        "",
        "Klik tombol di bawah untuk memberi rating ke mentor.",
      ].join("\n"),
      components: [row],
      ephemeral: false,
    });

    await prisma.submissionEvaluation.update({
      where: { id: evaluation.id },
      data: { messageId: reply.id },
    });

    if (statusInput === "PASS") {
      try {
        const studentId = submission.discordId;
        const memberForStudent = await guild.members
          .fetch(studentId)
          .catch(() => null);
        const user =
          memberForStudent?.user ??
          (await client.users.fetch(studentId).catch(() => null));

        if (user && !hasSubcourses) {
          const displayName =
            (memberForStudent &&
              (memberForStudent.nickname || memberForStudent.displayName)) ||
            user.globalName ||
            user.username;

          const courseForCert = course;
          const courseName =
            courseForCert?.name ?? submission.courseId;
          const avgScore = (codeQuality + functionality + conceptual) / 3;
          const scoreText = avgScore.toFixed(2);

          const certId = certificateId ?? evaluation.id;
          const verificationUrl = buildVerificationUrl(certId);

          const imageBuffer = await generateCertificateImage({
            studentName: displayName,
            courseName,
            scoreText,
            certificateId: certId,
            verificationUrl,
            leadMentorName: mentorDisplayName,
          });

          const attachment = new AttachmentBuilder(imageBuffer, {
            name: "certificate.png",
          });

          await user.send({
            content: [
              `Selamat! Kamu lulus course ${courseName}. Berikut sertifikat kelulusanmu.`,
              "",
              `ID Sertifikat: ${certId}`,
              `Verifikasi: ${verificationUrl}`,
            ].join("\n"),
            files: [attachment],
          });
        }

        if (user && hasSubcourses) {
          const displayName =
            (memberForStudent &&
              (memberForStudent.nickname || memberForStudent.displayName)) ||
            user.globalName ||
            user.username;

          const parentCourse = course!;
          const subcourses = [...parentCourse.subcourses].sort(
            (a, b) => a.order - b.order,
          );

          const passEvaluations = [];
          for (const sc of subcourses) {
            const ev = await prisma.submissionEvaluation.findFirst({
              where: {
                status: "PASS",
                tallySubmission: {
                  courseId: parentCourse.id,
                  discordId: studentId,
                  subcourseId: sc.id,
                },
              } as any,
              orderBy: { createdAt: "asc" },
            } as any);

            if (!ev) {
              passEvaluations.push(null);
            } else {
              passEvaluations.push(ev);
            }
          }

          const allPassed =
            passEvaluations.length === subcourses.length &&
            passEvaluations.every((ev) => ev !== null);

          let inOrder = true;
          if (allPassed) {
            for (let i = 1; i < passEvaluations.length; i++) {
              const prev = passEvaluations[i - 1]!;
              const curr = passEvaluations[i]!;
              if (curr.createdAt < prev.createdAt) {
                inOrder = false;
                break;
              }
            }
          }

          if (allPassed && inOrder) {
            const existingParent = await prisma.parentCourseCompletion.findFirst(
              {
                where: {
                  discordId: studentId,
                  parentCourseId: parentCourse.id,
                },
              },
            );

            if (!existingParent) {
              const parentCertId = createCertificateId();
              const parentCompletion =
                await prisma.parentCourseCompletion.create({
                  data: {
                    discordId: studentId,
                    parentCourseId: parentCourse.id,
                    certificateId: parentCertId,
                  },
                });

              const avgScore =
                (codeQuality + functionality + conceptual) / 3;
              const scoreText = avgScore.toFixed(2);

              const verificationUrl =
                buildVerificationUrl(parentCompletion.certificateId);

              const imageBuffer = await generateCertificateImage({
                studentName: displayName,
                courseName: parentCourse.name,
                scoreText,
                certificateId: parentCompletion.certificateId,
                verificationUrl,
                leadMentorName: mentorDisplayName,
              });

              const attachment = new AttachmentBuilder(imageBuffer, {
                name: "certificate.png",
              });

              await user.send({
                content: [
                  `Selamat! Kamu telah menyelesaikan semua subcourse untuk course ${parentCourse.name}. Berikut sertifikat kelulusanmu untuk course ini.`,
                  "",
                  `ID Sertifikat: ${parentCompletion.certificateId}`,
                  `Verifikasi: ${verificationUrl}`,
                ].join("\n"),
                files: [attachment],
              });
            }
          }
        }
      } catch (err) {
        console.error("Failed to send certificate DM:", err);
      }
    }
  } catch (err) {
    console.error("Error in InteractionCreate (slash /ev) handler:", err);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({
          content:
            "Terjadi error saat memproses perintah /ev. Coba lagi atau hubungi admin.",
          ephemeral: true,
        });
      } catch {
        // ignore
      }
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    const button = interaction as ButtonInteraction;
    const [prefix, evaluationId] = button.customId.split(":");
    if (prefix !== "mentor_rate") return;

    const evaluation = await prisma.submissionEvaluation.findUnique({
      where: { id: evaluationId },
      include: { tallySubmission: true },
    });
    if (!evaluation) {
      await button.reply({
        content: "Evaluasi tidak ditemukan.",
        ephemeral: true,
      });
      return;
    }

    const studentDiscordId = evaluation.tallySubmission.discordId;
    if (button.user.id !== studentDiscordId) {
      await button.reply({
        content: "Hanya pemilik submission yang bisa memberi rating.",
        ephemeral: true,
      });
      return;
    }

    // Kirim pilihan rating 1–5 sebagai tombol
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...[1, 2, 3, 4, 5].map((value) =>
        new ButtonBuilder()
          .setCustomId(`mentor_rate_value:${evaluationId}:${value}`)
          .setLabel(String(value))
          .setStyle(ButtonStyle.Secondary),
      ),
    );

    await button.reply({
      content: "Pilih rating untuk lead mentor (1-5):",
      components: [row],
      ephemeral: true,
    });
  } catch (err) {
    console.error("Error in InteractionCreate (mentor_rate) handler:", err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    const button = interaction as ButtonInteraction;
    const [prefix, evaluationId, value] = button.customId.split(":");
    if (prefix !== "mentor_rate_value") return;

    const evaluation = await prisma.submissionEvaluation.findUnique({
      where: { id: evaluationId },
      include: { tallySubmission: true },
    });
    if (!evaluation) {
      await button.reply({
        content: "Evaluasi tidak ditemukan.",
        ephemeral: true,
      });
      return;
    }

    const studentDiscordId = evaluation.tallySubmission.discordId;
    if (button.user.id !== studentDiscordId) {
      await button.reply({
        content: "Hanya pemilik submission yang bisa memberi rating.",
        ephemeral: true,
      });
      return;
    }

    const rating = Number(value) || 0;
    if (rating < 1 || rating > 5) {
      await button.reply({
        content: "Rating tidak valid.",
        ephemeral: true,
      });
      return;
    }

    await prisma.mentorRating.create({
      data: {
        evaluationId: evaluation.id,
        userDiscordId: studentDiscordId,
        rating,
      },
    });

    // Tampilkan hasil penilaian di thread
    const channel = await client.channels
      .fetch(evaluation.threadId)
      .catch(() => null);
    if (channel && channel.isTextBased()) {
      await (channel as any).send(
        `Hasil penilaian untuk <@${studentDiscordId}>:\nStatus: **${evaluation.status}**\nRating kamu untuk mentor: **${rating}/5**`,
      );
    }

    await button.update({
      content: "Terima kasih, rating kamu sudah tercatat.",
      components: [],
    });
  } catch (err) {
    console.error(
      "Error in InteractionCreate (mentor_rate_value) handler:",
      err,
    );
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    const button = interaction as ButtonInteraction;
    const [prefix, threadId, courseId] = button.customId.split(":");
    if (prefix !== "mentor_claim") return;

    const guild = button.guild;
    if (!guild) {
      await button.reply({
        content: "Klaim hanya bisa dilakukan di dalam server.",
        ephemeral: true,
      });
      return;
    }

    const member = await guild.members.fetch(button.user.id).catch(() => null);
    if (!member) {
      await button.reply({
        content: "Tidak dapat menemukan data member di server.",
        ephemeral: true,
      });
      return;
    }

    const hasMentorRole = mentorRoleId && member.roles.cache.has(mentorRoleId);

    if (!hasMentorRole) {
      await button.reply({
        content: "Hanya mentor yang bisa meng-claim thread ini.",
        ephemeral: true,
      });
      return;
    }

    const claimChannel = button.channel;
    if (!claimChannel || !claimChannel.isThread()) {
      await button.reply({
        content:
          "Klaim hanya bisa dilakukan di dalam thread submission yang valid.",
        ephemeral: true,
      });
      return;
    }

    const thread = claimChannel as ThreadChannel;
    const starter = await thread.fetchStarterMessage().catch(() => null);
    const { userDiscordId: submitterDiscordId } = starter
      ? parseStarterContent(starter.content)
      : { userDiscordId: null as string | null };

    if (submitterDiscordId && submitterDiscordId === button.user.id) {
      await button.reply({
        content:
          "Kamu tidak bisa meng-claim thread ini sebagai lead mentor karena kamu adalah pemilik submission.",
        ephemeral: true,
      });
      return;
    }

    const existing = await prisma.mentorClaim
      .findUnique({
        where: { threadId },
      })
      .catch(() => null);

    if (existing) {
      await button.reply({
        content: `Thread ini sudah di-claim oleh <@${existing.mentorDiscordId}> sebagai lead mentor.`,
        ephemeral: true,
      });
      return;
    }

    await prisma.mentorClaim.create({
      data: {
        threadId,
        courseId: courseId ?? "unknown",
        mentorDiscordId: button.user.id,
      },
    });

    await button.update({
      content: `Thread ini sudah di-claim oleh <@${button.user.id}> sebagai lead mentor.`,
      components: [],
    });

    const statusChannel = button.channel;
    if (statusChannel && statusChannel.isThread()) {
      await setThreadStatus(statusChannel as ThreadChannel, "CLAIMED");
    }
  } catch (err) {
    console.error("Error in InteractionCreate (mentor_claim) handler:", err);
  }
});

client.on(Events.MessageReactionAdd, async (reaction) => {
  try {
    const message = reaction.message;
    const user = reaction.users.cache.first();
    if (!user || user.bot) return;

    if (reaction.emoji.name !== "✅") return;
    if (!message.channel.isThread()) return;

    if (!isLeadMentor(reaction as MessageReaction, user)) return;

    const thread = message.channel as ThreadChannel;

    const starter = await thread.fetchStarterMessage().catch(() => null);
    const courseLine = starter?.content
      ?.split("\n")
      .find((line) => line.startsWith("Course:"));

    let courseId = "unknown";
    if (courseLine) {
      const match = courseLine.match(/\(([^)]+)\)\s*$/);
      if (match) {
        courseId = match[1];
      }
    }

    await prisma.mentorReactionLog.create({
      data: {
        courseId,
        threadId: thread.id,
        messageId: message.id,
        mentorDiscordId: user.id,
      },
    });
  } catch (err) {
    console.error("Error in MessageReactionAdd handler:", err);
  }
});

client.on(Events.ThreadCreate, async (thread) => {
  try {
    console.log("ThreadCreate event received:", {
      id: thread.id,
      type: thread.type,
      name: thread.name,
      parentId: thread.parentId,
    });

    if (thread.type !== ChannelType.PublicThread) return;

    const starter = await thread.fetchStarterMessage().catch((err) => {
      console.error(
        "Failed to fetch starter message for thread in ThreadCreate:",
        err,
      );
      return null;
    });
    if (!starter) {
      console.warn(
        "ThreadCreate: starter message is null, skipping claim button for thread:",
        thread.id,
      );
      return;
    }

    const lines = starter.content.split("\n");
    const courseLine = lines.find((line) => line.startsWith("Course:"));
    const userLine = lines.find((line) => line.startsWith("User:"));

    if (!courseLine || !userLine) {
      console.warn(
        "ThreadCreate: missing Course:/User: lines in starter content, skipping claim button. Content:",
        starter.content,
      );
      return;
    }

    const match = courseLine.match(/\(([^)]+)\)\s*$/);
    if (!match) {
      console.warn(
        "ThreadCreate: failed to extract courseId from courseLine, skipping claim button. courseLine:",
        courseLine,
      );
      return;
    }

    const courseId = match[1];

    const existingClaimMessage = await prisma.mentorClaim
      .findFirst({
        where: { threadId: thread.id },
      })
      .catch(() => null);

    // If there is already a claim recorded for some reason, don't send a button
    if (existingClaimMessage) {
      console.log(
        "ThreadCreate: mentorClaim already exists for thread, not sending claim button:",
        { threadId: thread.id, claimId: existingClaimMessage.id },
      );
      return;
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`mentor_claim:${thread.id}:${courseId}`)
        .setLabel("Claim as lead mentor")
        .setStyle(ButtonStyle.Secondary),
    );

    console.log(
      "ThreadCreate: sending claim button message for thread:",
      thread.id,
    );

    await setThreadStatus(thread as ThreadChannel, "OPEN");

    await thread.send({
      content:
        "Klik tombol di bawah untuk meng-claim thread ini sebagai lead mentor.",
      components: [row],
    });
  } catch (err) {
    console.error("Error in ThreadCreate handler (claim button):", err);
  }
});

client.login(token).catch((err) => {
  console.error("Failed to login Discord bot:", err);
});
