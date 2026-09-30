
import type { GatewayOAuthStatus } from "./GatewayOAuthStatus.js";

export type GatewayOAuthChangedNotification = {

authUrl: string | null, providerId: string, status: GatewayOAuthStatus, error: string | null, };
