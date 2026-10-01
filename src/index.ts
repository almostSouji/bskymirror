import { Jetstream, websocketTransport } from "@bsky/jetstream";
import { app } from "@bsky/sdk/lexicons";
import { REST } from "@discordjs/rest";
import process from "node:process";
import { handleCommit, loadMirrorConfig } from "./functions.js";
import { logger } from "./logger.js";

const rest = new REST({ version: "10" });
const jetstream = new Jetstream("https://jetstream.us-east.bsky.network");
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

logger.info("Loading and hydrating mirror configuration...");
const profileCache = await loadMirrorConfig("../config.yml");
const listenDids = Array.from(profileCache.keys()) as `did:${string}:${string}`[];

logger.info(`Loaded mirror configuration for ${profileCache.size} bsky handle(s).`);

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

      const profileRecord = profileCache.get(evt.did);
      if (!profileRecord) {
        logger.error(`Expected to find cached record for ${evt.did} but found none.`);
        continue;
      }

      for (const mirror of profileRecord.mirrorConfig) {
        const hookBase = `webhooks/${mirror.discord_webhook_id}/${mirror.discord_webhook_token}`;

        if (evt.commit.record.reply) {
          logger.debug(evt.commit.record.reply, "Observed commit was a reply.");

          if (!mirror.mirror_replies) {
            continue;
          }
        }

        void handleCommit(evt.commit.record, evt.did, evt.commit.rkey, {
          discordRest: rest,
          hookBase,
          record: profileRecord.atproto,
          mentionRoleId: mirror.discord_notification_role_id ?? undefined,
        });
      }
    }
  }
} catch (err) {
  if (controller.signal.aborted) {
    logger.info("Exiting...");
    process.exit(0);
  }
  throw err;
}
