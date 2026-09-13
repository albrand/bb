import { useRef } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import {
  REAUTH_NOTIFICATION_CHANNEL,
  reauthNotificationSchema,
  type ReauthNotification,
  type providerReauthRpcContract,
} from "./contract.js";

function showDesktopNotification(notification: ReauthNotification): void {
  if (typeof Notification === "undefined" || !window.isSecureContext) return;
  if (Notification.permission !== "granted") return;
  new Notification(notification.title, {
    body: notification.body,
    tag: `bb-provider-reauth-${notification.providerId}-${notification.hostId}`,
  });
}

function ReauthNotices() {
  const rpc = useRpc<typeof providerReauthRpcContract>();
  const seen = useRef(new Set<string>());
  useRealtime(REAUTH_NOTIFICATION_CHANNEL, (payload) => {
    const parsed = reauthNotificationSchema.safeParse(payload);
    if (!parsed.success || seen.current.has(parsed.data.id)) return;
    seen.current.add(parsed.data.id);
    const notification = parsed.data;
    toast(notification.title, {
      description: notification.body,
      ...(notification.canRetry
        ? {
            action: {
              label: "Retry sign-in",
              onClick: () => {
                void rpc.call("reauth.start", {
                  providerId: notification.providerId,
                  hostId: notification.hostId,
                });
              },
            },
          }
        : {}),
    });
    showDesktopNotification(notification);
  });
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "provider-reauth-notices",
    component: ReauthNotices,
  });
});
