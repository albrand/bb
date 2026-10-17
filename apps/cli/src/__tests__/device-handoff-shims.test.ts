import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  copyFile,
  mkdir,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];
const shimSource = new URL("../../bin/", import.meta.url);

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createFixture(): Promise<{
  directory: string;
  shimBin: string;
  realBin: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "bb-device-handoff-"));
  fixtures.push(directory);
  const shimBin = join(directory, "shim-bin");
  const realBin = join(directory, "real-bin");
  await mkdir(shimBin);
  await mkdir(realBin);
  for (const name of [
    "bb-device-handoff-shim",
    "pbcopy",
    "open",
    "xdg-open",
    "bb-browser",
  ]) {
    await copyFile(new URL(name, shimSource), join(shimBin, name));
    await chmod(join(shimBin, name), 0o755);
  }
  await writeFile(
    join(shimBin, "bb"),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$BB_HANDOFF_LOG"\nexit "${BB_HANDOFF_STATUS:-0}"\n',
    { mode: 0o755 },
  );
  return { directory, shimBin, realBin };
}

async function writeOpener(
  path: string,
  logPath: string,
  status = 0,
): Promise<void> {
  await writeFile(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> '${logPath}'\nexit ${status}\n`,
    { mode: 0o755 },
  );
  await chmod(path, 0o755);
}

async function writeUname(realBin: string, platform: string): Promise<void> {
  const path = join(realBin, "uname");
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${platform}'\n`, {
    mode: 0o755,
  });
  await chmod(path, 0o755);
}

function runShim(args: {
  shimBin: string;
  realBin: string;
  name: string;
  env?: Record<string, string>;
}) {
  return spawnSync(
    join(args.shimBin, args.name),
    ["https://example.com/path"],
    {
      env: {
        ...process.env,
        PATH: `${args.shimBin}:${args.realBin}:/usr/bin:/bin`,
        ...args.env,
      },
    },
  );
}

describe("device handoff command shims", () => {
  it("tees pbcopy input and succeeds when device delivery succeeds despite native failure", async () => {
    const { directory, shimBin, realBin } = await createFixture();
    const copiedPath = join(directory, "real-pbcopy-input");
    const realPbcopy = join(realBin, "pbcopy");
    await writeFile(realPbcopy, `#!/bin/sh\ncat > '${copiedPath}'\nexit 23\n`, {
      mode: 0o755,
    });
    await chmod(realPbcopy, 0o755);
    const result = spawnSync(join(shimBin, "pbcopy"), [], {
      env: { ...process.env, PATH: `${shimBin}:${realBin}:/usr/bin:/bin` },
      input: "clipboard fixture",
    });

    expect(result.status).toBe(0);
    expect(await readFile(copiedPath, "utf8")).toBe("clipboard fixture");
  });

  it("uses native pbcopy status when delivery fails", async () => {
    const { directory, shimBin, realBin } = await createFixture();
    const copiedPath = join(directory, "real-pbcopy-input");
    await writeFile(
      join(realBin, "pbcopy"),
      `#!/bin/sh\ncat > '${copiedPath}'\nexit 0\n`,
      { mode: 0o755 },
    );
    await chmod(join(realBin, "pbcopy"), 0o755);
    const result = spawnSync(join(shimBin, "pbcopy"), [], {
      env: {
        ...process.env,
        PATH: `${shimBin}:${realBin}:/usr/bin:/bin`,
        BB_HANDOFF_STATUS: "7",
      },
      input: "clipboard fixture",
    });

    expect(result.status).toBe(0);
    expect(await readFile(copiedPath, "utf8")).toBe("clipboard fixture");
  });

  it("fails clearly when delivery fails and no native pbcopy exists", async () => {
    const { shimBin, realBin } = await createFixture();
    const result = spawnSync(join(shimBin, "pbcopy"), [], {
      env: {
        ...process.env,
        PATH: `${shimBin}:${realBin}:/usr/bin:/bin`,
        BB_HANDOFF_STATUS: "7",
      },
      input: "clipboard fixture",
    });

    expect(result.status).toBe(7);
    expect(result.stderr.toString()).toContain("no native pbcopy is available");
  });

  it("treats successful Linux device delivery as success without calling /usr/bin/open", async () => {
    const { directory, shimBin, realBin } = await createFixture();
    const openLog = join(directory, "open-log");
    await writeOpener(join(realBin, "open"), openLog, 23);
    await writeUname(realBin, "Linux");

    const result = runShim({
      shimBin,
      realBin,
      name: "open",
      env: {
        BB_HANDOFF_STATUS: "0",
        BB_HANDOFF_LOG: join(directory, "bb-log"),
      },
    });

    expect(result.status).toBe(0);
    expect(await readFile(join(directory, "bb-log"), "utf8")).toContain(
      "device open https://example.com/path",
    );
    await expect(readFile(openLog, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses xdg-open only with a display and ignores its failure after successful delivery", async () => {
    const { directory, shimBin, realBin } = await createFixture();
    const openLog = join(directory, "xdg-open-log");
    const nativeOpenLog = join(directory, "open-log");
    await writeOpener(join(realBin, "xdg-open"), openLog, 23);
    await writeOpener(join(realBin, "open"), nativeOpenLog, 23);
    await writeUname(realBin, "Linux");

    const result = runShim({
      shimBin,
      realBin,
      name: "xdg-open",
      env: {
        DISPLAY: ":0",
        BB_HANDOFF_STATUS: "0",
        BB_HANDOFF_LOG: join(directory, "bb-log"),
      },
    });

    expect(result.status).toBe(0);
    expect(await readFile(openLog, "utf8")).toContain(
      "https://example.com/path",
    );
    await expect(readFile(nativeOpenLog, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not run xdg-open without a display and returns nonzero when delivery fails", async () => {
    const { directory, shimBin, realBin } = await createFixture();
    const openLog = join(directory, "xdg-open-log");
    await writeOpener(join(realBin, "xdg-open"), openLog, 0);
    await writeUname(realBin, "Linux");

    const result = runShim({
      shimBin,
      realBin,
      name: "xdg-open",
      env: {
        DISPLAY: "",
        WAYLAND_DISPLAY: "",
        BB_HANDOFF_STATUS: "7",
        BB_HANDOFF_LOG: join(directory, "bb-log"),
      },
    });

    expect(result.status).toBe(7);
    await expect(readFile(openLog, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("lets BROWSER succeed on Linux when device delivery succeeds and no opener is usable", async () => {
    const { directory, shimBin, realBin } = await createFixture();
    const openLog = join(directory, "open-log");
    await writeOpener(join(realBin, "open"), openLog, 23);
    await writeUname(realBin, "Linux");

    const result = runShim({
      shimBin,
      realBin,
      name: "bb-browser",
      env: {
        DISPLAY: "",
        WAYLAND_DISPLAY: "",
        BB_HANDOFF_STATUS: "0",
        BB_HANDOFF_LOG: join(directory, "bb-log"),
      },
    });

    expect(result.status).toBe(0);
    expect(await readFile(join(directory, "bb-log"), "utf8")).toContain(
      "device open https://example.com/path",
    );
    await expect(readFile(openLog, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("falls back to a real displayed xdg-open when device delivery fails", async () => {
    const { directory, shimBin, realBin } = await createFixture();
    const openLog = join(directory, "xdg-open-log");
    await writeOpener(join(realBin, "xdg-open"), openLog, 19);
    await writeUname(realBin, "Linux");

    const result = runShim({
      shimBin,
      realBin,
      name: "xdg-open",
      env: {
        WAYLAND_DISPLAY: "wayland-0",
        BB_HANDOFF_STATUS: "7",
        BB_HANDOFF_LOG: join(directory, "bb-log"),
      },
    });

    expect(result.status).toBe(19);
    expect(await readFile(openLog, "utf8")).toContain(
      "https://example.com/path",
    );
  });

  it("returns xdg-open success when device delivery fails on Linux with a display", async () => {
    const { directory, shimBin, realBin } = await createFixture();
    const openLog = join(directory, "xdg-open-log");
    await writeOpener(join(realBin, "xdg-open"), openLog, 0);
    await writeUname(realBin, "Linux");

    const result = runShim({
      shimBin,
      realBin,
      name: "xdg-open",
      env: {
        DISPLAY: ":0",
        BB_HANDOFF_STATUS: "7",
        BB_HANDOFF_LOG: join(directory, "bb-log"),
      },
    });

    expect(result.status).toBe(0);
    expect(await readFile(openLog, "utf8")).toContain("https://example.com/path");
  });

  it.each(["open", "xdg-open", "bb-browser"])(
    "%s returns native success when device delivery fails",
    async (name) => {
      const { directory, shimBin, realBin } = await createFixture();
      const openLog = join(directory, "native-open-log");
      await writeOpener(join(realBin, "xdg-open"), openLog, 0);
      await writeOpener(join(realBin, "open"), openLog, 0);
      await writeUname(realBin, "Darwin");

      const result = runShim({
        shimBin,
        realBin,
        name,
        env: {
          DISPLAY: ":0",
          BB_HANDOFF_STATUS: "7",
          BB_HANDOFF_LOG: join(directory, "bb-log"),
        },
      });

      expect(result.status).toBe(0);
      expect(await readFile(openLog, "utf8")).toContain(
        "https://example.com/path",
      );
    },
  );

  it.each(["open", "xdg-open", "bb-browser"])(
    "%s fails clearly when delivery fails and no native URL opener is usable",
    async (name) => {
      const { directory, shimBin, realBin } = await createFixture();
      await writeUname(realBin, "Linux");
      const dirnamePath = join(realBin, "dirname");
      await writeFile(dirnamePath, "#!/bin/sh\nexec /usr/bin/dirname \"$@\"\n", {
        mode: 0o755,
      });
      await chmod(dirnamePath, 0o755);

      const result = runShim({
        shimBin,
        realBin,
        name,
        env: {
          PATH: `${shimBin}:${realBin}`,
          DISPLAY: "",
          WAYLAND_DISPLAY: "",
          BB_HANDOFF_STATUS: "7",
          BB_HANDOFF_LOG: join(directory, "bb-log"),
        },
      });

      expect(result.status).toBe(7);
      expect(result.stderr.toString()).toContain(
        "no native URL opener is available",
      );
    },
  );

  it("uses macOS open alongside delivery and ignores its status after delivery", async () => {
    const { directory, shimBin, realBin } = await createFixture();
    const openLog = join(directory, "open-log");
    const xdgOpenLog = join(directory, "xdg-open-log");
    await writeOpener(join(realBin, "open"), openLog, 23);
    await writeOpener(join(realBin, "xdg-open"), xdgOpenLog, 23);
    await writeUname(realBin, "Darwin");

    const result = runShim({
      shimBin,
      realBin,
      name: "bb-browser",
      env: {
        BB_HANDOFF_STATUS: "0",
        BB_HANDOFF_LOG: join(directory, "bb-log"),
      },
    });

    expect(result.status).toBe(0);
    expect(await readFile(openLog, "utf8")).toContain(
      "https://example.com/path",
    );
    await expect(readFile(xdgOpenLog, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
