export function parseTerminalProgressOsc(payload: string): number | null | undefined {
  if (payload === "4;0") {
    return null;
  }
  const match = /^4;[124];(\d{1,3})$/u.exec(payload);
  const percent = match?.[1];
  if (percent === undefined) {
    return undefined;
  }
  const value = Number(percent);
  return value <= 100 ? value / 100 : undefined;
}
