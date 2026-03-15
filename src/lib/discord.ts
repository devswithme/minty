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

export async function getForumTagIdByName(
  channelId: string,
  tagName: string,
): Promise<string | null> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("Missing DISCORD_BOT_TOKEN");

  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bot ${token}`,
      },
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      "Discord API error while fetching channel for tags",
      res.status,
      text,
    );
    return null;
  }

  const data = (await res.json()) as any;
  const tags: { id: string; name: string }[] = Array.isArray(data.available_tags)
    ? data.available_tags
    : [];

  const lower = tagName.toLowerCase();
  const found = tags.find((t) => t.name.toLowerCase() === lower);
  return found?.id ?? null;
}
