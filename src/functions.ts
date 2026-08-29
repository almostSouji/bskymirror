import { Agent } from "@atproto/api";
import { DidResolver, HandleResolver } from "@atproto/identity";
import { app } from "@bsky/sdk/lexicons";
import { REST } from "@discordjs/rest";
import {
  APIComponentInContainer,
  APIMediaGalleryItem,
  ComponentType,
  MessageFlags,
} from "discord-api-types/v10";

export function verifyEnv(env: typeof process.env, requiredKeys: string[]) {
  const mapping = requiredKeys.map((key) => ({
    key,
    value: env[key],
  }));

  const missing = mapping.filter((pair) => !pair.value);
  if (missing.length > 0) {
    throw new Error(
      `Missing environment variable(s) ${missing.map((pair) => pair.key).join(", ")}.`,
    );
  }

  const [webhookId, webhookToken, handles, mentionRoleId] = mapping;

  return {
    discordWebhookId: webhookId.value!,
    discordWebhookToken: webhookToken.value!,
    bskyHandles: handles.value!.split(","),
    mentionRoleId: mentionRoleId.value!,
  };
}

export type BskyRecordData = Awaited<ReturnType<typeof fetchAtProtoRecords>>;

export async function fetchAtProtoRecords(
  handle: string,
  {
    handleResolver,
    didResolver,
    agent,
  }: {
    handleResolver: HandleResolver;
    didResolver: DidResolver;
    agent: Agent;
  },
) {
  const did = await handleResolver.resolve(handle);

  if (!did) {
    throw new Error(`Could not resolve did from handle ${handle}.`);
  }

  const plcData = await didResolver.resolve(did);

  if (!plcData) {
    throw new Error(`Could not resolve profile from did ${did}`);
  }

  const pdsService = plcData.service?.find(
    (service) => service.type === "AtprotoPersonalDataServer",
  );

  if (!pdsService) {
    throw new Error(`Expected to find personald data server, but found none for ${did}`);
  }

  const profile = (await agent.getProfile({ actor: did })).data;
  return { did, profile, plcData, pds: pdsService.serviceEndpoint };
}

async function executeDiscordWebhook(
  components: APIComponentInContainer[],
  {
    username,
    avatarUrl,
    discordRest,
    hookBase,
    mentionRoleId,
  }: {
    username: string;
    avatarUrl?: string;
    discordRest: REST;
    hookBase: string;
    mentionRoleId?: string;
  },
) {
  await discordRest.post(`/${hookBase}?wait=true&with_components=true`, {
    auth: false,
    body: {
      username,
      avatar_url: avatarUrl,
      flags: MessageFlags.IsComponentsV2,
      allowed_mentions: mentionRoleId ? { roles: [mentionRoleId] } : { parse: [] },
      components: [
        {
          type: ComponentType.Container,
          components,
        },
      ],
    },
  });
}

const BSKY_CDN_BASE = "https://cdn.bsky.app";
const BSKY_IMAGE_CDN = `${BSKY_CDN_BASE}/img/feed_fullsize/plain`;

export async function handleCommit(
  record: app.bsky.feed.post.Main,
  did: string,
  rkey: string,
  {
    discordRest,
    record: profile,
    hookBase,
    mentionRoleId,
  }: {
    discordRest: REST;
    record: BskyRecordData;
    hookBase: string;
    mentionRoleId: string;
  },
) {
  const url = `https://bsky.app/profile/${did}/post/${rkey}`;
  const media: APIMediaGalleryItem[] = [];

  if (record.embed && "images" in record.embed) {
    for (const image of record.embed.images) {
      // @ts-expect-error lexicon does not match jetstream
      const cid = image.image.ref.toString();

      const imageUrl = `${BSKY_IMAGE_CDN}/${did}/${cid}@${image.image.mimeType.split("/").at(1) ?? "jpeg"}`;

      media.push({
        media: {
          url: imageUrl,
        },
        description: image.alt ?? undefined,
      });
    }
  }

  if (record.embed && "video" in record.embed) {
    // @ts-expect-error lexicon does not match jetstream
    const cid = record.embed.video.ref.toString();
    const videoUrl = `${profile.pds}/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${cid}`;

    media.push({
      media: {
        url: videoUrl,
      },
      description: record.embed.alt ?? undefined,
    });
  }

  const body: APIComponentInContainer[] = [];

  if (record.text) {
    body.push({
      type: ComponentType.TextDisplay,
      content: record.text?.slice(0, 3_000),
    });
  }

  if (media.length > 0) {
    body.push({
      type: ComponentType.MediaGallery,
      items: media.slice(0, 10),
    });
  }

  const tailParts = [];

  if (mentionRoleId) {
    tailParts.push(`<@&${mentionRoleId}>`);
  }

  tailParts.push(`[Open on bsky ↗](${url})`);

  await executeDiscordWebhook(
    [
      ...body,
      {
        type: ComponentType.Separator,
      },
      {
        type: ComponentType.TextDisplay,
        content: tailParts.join(" • "),
      },
    ],
    {
      discordRest,
      mentionRoleId,
      hookBase,
      username: `${profile.profile.displayName} (${profile.profile.handle})`,
      avatarUrl: profile.profile.avatar ?? undefined,
    },
  );
}
