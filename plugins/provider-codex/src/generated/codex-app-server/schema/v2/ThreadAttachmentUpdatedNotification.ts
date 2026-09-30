
import type { ThreadAttachmentOperation } from "./ThreadAttachmentOperation.js";


export type ThreadAttachmentUpdatedNotification = { threadId: string, attachmentType: string, identityKey: string, attachmentId: string, operation: ThreadAttachmentOperation, };
