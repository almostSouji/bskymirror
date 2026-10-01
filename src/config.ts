import * as z from "zod";

export const MirrorConfigEntry = z.object({
  discord_webhook_token: z.string(),
  discord_webhook_id: z.string(),
  bsky_handles: z.array(z.string()),
  discord_notification_role_id: z.string().optional(),
  description: z.string().optional(),
  mirror_replies: z.boolean().optional(),
});

export const MirrorConfig = z.array(MirrorConfigEntry);
