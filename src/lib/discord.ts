type CreateForumPostArgs = {
  channelId: string;
  name: string;
  content: string;
  appliedTagIds?: string[];
};

type DiscordThreadResponse = {
  id: string;
};

export async function createForumPost(
  args: CreateForumPostArgs,
): Promise<DiscordThreadResponse> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("Missing DISCORD_BOT_TOKEN");

  const res = await fetch(
    `https://discord.com/api/v10/channels/${args.channelId}/threads`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: args.name,
        message: { content: args.content },
        ...(args.appliedTagIds && args.appliedTagIds.length
          ? { applied_tags: args.appliedTagIds }
          : {}),
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord API error ${res.status}: ${text}`);
  }

  return (await res.json()) as DiscordThreadResponse;
}
