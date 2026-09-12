import { atom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useId, useMemo } from "react";

interface MountedTerminalRegistration {
  registrationId: string;
  terminalId: string | null;
}

type MountedTerminalsByScope = Readonly<
  Record<string, readonly MountedTerminalRegistration[]>
>;

const EMPTY_REGISTRATIONS: readonly MountedTerminalRegistration[] = [];
const EMPTY_TERMINAL_IDS: ReadonlySet<string> = new Set<string>();

export const mountedTerminalsAtom = atom<MountedTerminalsByScope>({});

interface SetMountedTerminalArgs {
  registrationId: string;
  scopeKey: string;
  terminalId: string | null;
}

export const setMountedTerminalAtom = atom(
  null,
  (get, set, args: SetMountedTerminalArgs) => {
    const current = get(mountedTerminalsAtom);
    const registrations = current[args.scopeKey] ?? EMPTY_REGISTRATIONS;
    const existing = registrations.find(
      (registration) => registration.registrationId === args.registrationId,
    );
    if (existing?.terminalId === args.terminalId) {
      return;
    }
    const next = existing
      ? registrations.map((registration) =>
          registration.registrationId === args.registrationId
            ? { ...registration, terminalId: args.terminalId }
            : registration,
        )
      : [
          ...registrations,
          {
            registrationId: args.registrationId,
            terminalId: args.terminalId,
          },
        ];
    set(mountedTerminalsAtom, { ...current, [args.scopeKey]: next });
  },
);

interface ClearMountedTerminalArgs {
  registrationId: string;
  scopeKey: string;
}

export const clearMountedTerminalAtom = atom(
  null,
  (get, set, args: ClearMountedTerminalArgs) => {
    const current = get(mountedTerminalsAtom);
    const registrations = current[args.scopeKey];
    if (registrations === undefined) {
      return;
    }
    const next = registrations.filter(
      (registration) => registration.registrationId !== args.registrationId,
    );
    if (next.length === registrations.length) {
      return;
    }
    if (next.length === 0) {
      const { [args.scopeKey]: _removed, ...rest } = current;
      set(mountedTerminalsAtom, rest);
      return;
    }
    set(mountedTerminalsAtom, { ...current, [args.scopeKey]: next });
  },
);

interface UseMountedTerminalRegistrationArgs {
  isMounted: boolean;
  scopeKey: string;
  terminalId: string | null;
}

export function useMountedTerminalRegistration({
  isMounted,
  scopeKey,
  terminalId,
}: UseMountedTerminalRegistrationArgs): void {
  const registrationId = useId();
  const setMountedTerminal = useSetAtom(setMountedTerminalAtom);
  const clearMountedTerminal = useSetAtom(clearMountedTerminalAtom);

  useEffect(() => {
    if (!isMounted) {
      clearMountedTerminal({ registrationId, scopeKey });
      return;
    }
    setMountedTerminal({ registrationId, scopeKey, terminalId });
    return () => {
      clearMountedTerminal({ registrationId, scopeKey });
    };
  }, [
    clearMountedTerminal,
    isMounted,
    registrationId,
    scopeKey,
    setMountedTerminal,
    terminalId,
  ]);
}

export function useMountedTerminalIds(
  scopeKey: string | null,
): ReadonlySet<string> {
  const mountedTerminals = useAtomValue(mountedTerminalsAtom);
  const registrations =
    scopeKey === null ? undefined : mountedTerminals[scopeKey];
  return useMemo(() => {
    if (registrations === undefined) {
      return EMPTY_TERMINAL_IDS;
    }
    const terminalIds = new Set<string>();
    for (const registration of registrations) {
      if (registration.terminalId !== null) {
        terminalIds.add(registration.terminalId);
      }
    }
    return terminalIds;
  }, [registrations]);
}
