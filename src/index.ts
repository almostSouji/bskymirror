import { Agent } from "@atproto/api";
import { DidResolver, HandleResolver } from "@atproto/identity";
import { Jetstream, websocketTransport } from "@bsky/jetstream";
import { app } from "@bsky/sdk/lexicons";
import { REST } from "@discordjs/rest";
import process from "node:process";
import { fetchAtProtoRecords, handleCommit, verifyEnv } from "./functions.js";
import { logger } from "./logger.js";

const rest = new REST({ version: "10" });
const agent = new Agent({
  service: "https://public.api.bsky.app",
});

const didResolver = new DidResolver({});
const handleResolver = new HandleResolver({});

const { discordWebhookId, discordWebhookToken, bskyHandles, mentionRoleId } = verifyEnv(
  process.env,
  ["DISCORD_WEBHOOK_ID", "DISCORD_WEBHOOK_TOKEN", "BSKY_HANDLES", "MENTION_ROLE_ID"],
);

const profileCache = new Map<string, Awaited<ReturnType<typeof fetchAtProtoRecords>>>();
const hookBase = `webhooks/${discordWebhookId}/${discordWebhookToken}`;

for (const handle of bskyHandles) {
  try {
    const atProtoData = await fetchAtProtoRecords(handle, {
      handleResolver,
      didResolver,
      agent,
    });

    profileCache.set(atProtoData.did, atProtoData);
  } catch {
    logger.error(`Could not resolve hanlde ${handle}.`);
  }
}

const jetstream = new Jetstream("https://jetstream.us-east.bsky.network");
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

const listenDids = Array.from(profileCache.keys()) as `did:${string}:${string}`[];
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
    const bskyRecord = profileCache.get(evt.did);

    if (!bskyRecord) {
      logger.error(`Expected to find cached record for ${evt.did} but found none.`);
      continue;
    }

    if (evt.kind === "commit" && evt.commit.operation === "create") {
      logger.info("Received create commit event");
      void handleCommit(evt.commit.record, evt.did, evt.commit.rkey, {
        discordRest: rest,
        hookBase,
        record: bskyRecord,
        mentionRoleId,
      });
    }
  }
} catch (err) {
  if (controller.signal.aborted) {
    logger.info("Exiting...");
    process.exit(0);
  }
  throw err;
}
