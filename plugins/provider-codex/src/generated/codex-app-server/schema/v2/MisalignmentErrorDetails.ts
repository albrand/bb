
import type { MisalignmentSteer } from "./MisalignmentSteer.js";

export type MisalignmentErrorDetails = {

errorType: string | null,

detailedExplanation: string | null,

steer: MisalignmentSteer | null, };
