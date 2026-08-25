import { Jetstream, websocketTransport } from "@bsky/jetstream";
import { REST } from "@discordjs/rest";
import {
  APIComponentInContainer,
  APIMediaGalleryItem,
  ComponentType,
  MessageFlags,
} from "discord-api-types/v10";
import { app } from "@bsky/sdk/lexicons";
import process from "node:process";
import { logger } from "./logger.js";

const BSKY_CDN_BASE = "https://cdn.bsky.app";
const BSKY_IMAGE_CDN = `${BSKY_CDN_BASE}/img/feed_fullsize/plain`;
const BSKY_VIDEO_CDN = `https://enoki.us-east.host.bsky.network/xrpc/com.atproto.sync.getBlob`;

const rest = new REST({ version: "10" });

if (
  !process.env.DISCORD_WEBHOOK_ID ||
  !process.env.DISCORD_WEBHOOK_TOKEN ||
  !process.env.BSKY_HANDLES
) {
  logger.error(
    {
      BSKY_HANDLES: Boolean(process.env.BSKY_HANDLES),
      DISCORD_WEBHOOK_ID: Boolean(process.env.DISCORD_WEBHOOK_ID),
      DISCORD_WEBHOOK_TOKEN: Boolean(process.env.DISCORD_WEBHOOK_TOKEN),
    },
    `Missing required env vars`,
  );
  process.exit(1);
}

type BskyProfile = {
  did: `did:${string}:${string}`;
  handle: string;
  displayName: string;
  avatar?: string;
  createdAt: string;
  description?: string;
  indexedAt: string;
  banner?: string;
};

const profiles = new Map<`did:${string}:${string}`, BskyProfile>();
const hookBase = `webhooks/${process.env.DISCORD_WEBHOOK_ID}/${process.env.DISCORD_WEBHOOK_TOKEN}`;

const HANDLES = process.env.BSKY_HANDLES.split(",");

for (const handle of HANDLES) {
  try {
    const profile = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`,
    ).then((r) => r.json() as Promise<BskyProfile>);

    logger.info(`Retrieved profile for ${profile.did}`);
    profiles.set(profile.did, profile);
  } catch {
    logger.error(`Could not resolve hanlde ${handle}.`);
  }
}

async function handleCommit(
  record: app.bsky.feed.post.Main,
  did: `did:${string}:${string}`,
  rkey: string,
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
    const videoUrl = `${BSKY_VIDEO_CDN}?did=${did}&cid=${cid}`;

    media.push({
      media: {
        url: videoUrl,
      },
      description: record.embed.alt ?? undefined,
    });
  }

  const profile = profiles.get(did);

  if (!profile) {
    logger.error(`Expected to find profile for ${did}, but none found.`);
    return;
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
  const mentionRoleId = process.env.MENTION_ROLE_ID;

  if (mentionRoleId) {
    tailParts.push(`<@&${mentionRoleId}>`);
  }

  tailParts.push(`[Open on bsky ↗](${url})`);

  try {
    await rest.post(`/${hookBase}?wait=true&with_components=true`, {
      auth: false,
      body: {
        username: `${profile.displayName} (${profile.handle})`,
        avatar_url: profile.avatar ?? undefined,
        flags: MessageFlags.IsComponentsV2,
        allowed_mentions: mentionRoleId ? { roles: [mentionRoleId] } : { parse: [] },
        components: [
          {
            type: ComponentType.Container,
            components: [
              ...body,
              {
                type: ComponentType.Separator,
              },
              {
                type: ComponentType.TextDisplay,
                content: tailParts.join(" • "),
              },
            ],
          },
        ],
      },
    });
  } catch (_err) {
    const error = _err as Error;
    logger.error(error, error.message);
  }
}

const jetstream = new Jetstream("https://jetstream.us-east.bsky.network");
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

const listenDids = Array.from(profiles.values().map((profile) => profile.did));
try {
  logger.info("Attaching websocket...");
  logger.info({ listenDids }, "Listening...");

  for await (const evt of jetstream.live({
    signal: controller.signal,
    collections: [app.bsky.feed.post],
    dids: listenDids,
    liveTransport: websocketTransport({
      onOpen: () => {
        logger.info("WS opened");
      },
      onReconnect: (err, { attempt }) => {
        const error = err as { type: string; message: string; name: string };
        if (error.type === "IdleTimeoutError" || error.name === "IdleTimeoutError") {
          return;
        }

        logger.error({ attempt, error }, "reconnecting");
      },
    }),
  })) {
    if (evt.kind === "commit" && evt.commit.operation === "create") {
      logger.info("Received create commit event");
      void handleCommit(evt.commit.record, evt.did, evt.commit.rkey);
    }
  }
} catch (err) {
  if (controller.signal.aborted) {
    logger.info("Exiting...");
    process.exit(0);
  }
  throw err;
}
