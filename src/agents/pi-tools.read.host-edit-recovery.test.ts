import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EditToolOptions } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxFsBridge, SandboxFsStat } from "./sandbox/fs-bridge.js";

const mocks = vi.hoisted(() => ({
  mode: "pass" as "pass" | "mismatch" | "post-write-throw",
  beforeThrow: undefined as undefined | (() => Promise<void> | void),
}));

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    createEditTool: (cwd: string, options?: EditToolOptions) => {
      const base = actual.createEditTool(cwd, options);
      return {
        ...base,
        execute: async (...args: Parameters<typeof base.execute>) => {
          if (mocks.mode === "pass") {
            return base.execute(...args);
          }
          await mocks.beforeThrow?.();
          if (mocks.mode === "mismatch") {
            throw new Error(
              "Could not find the exact text in demo.txt. The old text must match exactly including all whitespace and newlines.",
            );
          }
          throw new Error("Simulated post-write failure (e.g. generateDiffString)");
        },
      };
    },
  };
});

const { createHostWorkspaceEditTool, createSandboxedEditTool } = await import("./pi-tools.read.js");

function createInMemoryBridge(root: string, files: Map<string, string>): SandboxFsBridge {
  const resolveAbsolute = (filePath: string, cwd?: string) =>
    path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd ?? root, filePath);

  const readStat = (absolutePath: string): SandboxFsStat | null => {
    const content = files.get(absolutePath);
    if (typeof content !== "string") {
      return null;
    }
    return {
      type: "file",
      size: Buffer.byteLength(content, "utf8"),
      mtimeMs: 0,
    };
  };

  return {
    resolvePath: ({ filePath, cwd }) => {
      const absolutePath = resolveAbsolute(filePath, cwd);
      return {
        hostPath: absolutePath,
        relativePath: path.relative(root, absolutePath),
        containerPath: absolutePath,
      };
    },
    readFile: async ({ filePath, cwd }) => {
      const absolutePath = resolveAbsolute(filePath, cwd);
      const content = files.get(absolutePath);
      if (typeof content !== "string") {
        throw new Error(`ENOENT: ${absolutePath}`);
      }
      return Buffer.from(content, "utf8");
    },
    writeFile: async ({ filePath, cwd, data }) => {
      const absolutePath = resolveAbsolute(filePath, cwd);
      files.set(absolutePath, typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    },
    mkdirp: async () => {},
    remove: async ({ filePath, cwd }) => {
      files.delete(resolveAbsolute(filePath, cwd));
    },
    rename: async ({ from, to, cwd }) => {
      const fromPath = resolveAbsolute(from, cwd);
      const toPath = resolveAbsolute(to, cwd);
      const content = files.get(fromPath);
      if (typeof content !== "string") {
        throw new Error(`ENOENT: ${fromPath}`);
      }
      files.set(toPath, content);
      files.delete(fromPath);
    },
    stat: async ({ filePath, cwd }) => readStat(resolveAbsolute(filePath, cwd)),
  };
}

describe("edit tool recovery hardening", () => {
  let tmpDir = "";

  afterEach(async () => {
    mocks.mode = "pass";
    mocks.beforeThrow = undefined;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("adds current file contents to exact-match mismatch errors", async () => {
    mocks.mode = "mismatch";
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, "actual current content", "utf-8");

    const tool = createHostWorkspaceEditTool(tmpDir);
    await expect(
      tool.execute(
        "call-1",
        { path: filePath, oldText: "missing", newText: "replacement" },
        undefined,
      ),
    ).rejects.toThrow(/Current file contents:\nactual current content/);
  });

  it("recovers success after a post-write throw when CRLF output contains newText and oldText is only a substring", async () => {
    mocks.mode = "post-write-throw";
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, 'const value = "foo";\r\n', "utf-8");
    mocks.beforeThrow = async () => {
      await fs.writeFile(filePath, 'const value = "foobar";\r\n', "utf-8");
    };

    const tool = createHostWorkspaceEditTool(tmpDir);
    const result = await tool.execute(
      "call-1",
      {
        path: filePath,
        oldText: 'const value = "foo";\n',
        newText: 'const value = "foobar";\n',
      },
      undefined,
    );

    expect(result).toMatchObject({ isError: false });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: `Successfully replaced text in ${filePath}.`,
    });
  });

  it("does not recover false success when the file never changed", async () => {
    mocks.mode = "post-write-throw";
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, "replacement already present", "utf-8");

    const tool = createHostWorkspaceEditTool(tmpDir);
    await expect(
      tool.execute(
        "call-1",
        { path: filePath, oldText: "missing", newText: "replacement already present" },
        undefined,
      ),
    ).rejects.toThrow("Simulated post-write failure");
  });

  it("recovers deletion edits when the file changed and oldText is gone", async () => {
    mocks.mode = "post-write-throw";
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    await fs.writeFile(filePath, "before delete me after\n", "utf-8");
    mocks.beforeThrow = async () => {
      await fs.writeFile(filePath, "before  after\n", "utf-8");
    };

    const tool = createHostWorkspaceEditTool(tmpDir);
    const result = await tool.execute(
      "call-1",
      { path: filePath, oldText: "delete me", newText: "" },
      undefined,
    );

    expect(result).toMatchObject({ isError: false });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: `Successfully replaced text in ${filePath}.`,
    });
  });

  it("applies the same recovery path to sandboxed edit tools", async () => {
    mocks.mode = "post-write-throw";
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "demo.txt");
    const files = new Map<string, string>([[filePath, "before old text after\n"]]);
    mocks.beforeThrow = () => {
      files.set(filePath, "before new text after\n");
    };

    const tool = createSandboxedEditTool({
      root: tmpDir,
      bridge: createInMemoryBridge(tmpDir, files),
    });
    const result = await tool.execute(
      "call-1",
      { path: filePath, oldText: "old text", newText: "new text" },
      undefined,
    );

    expect(result).toMatchObject({ isError: false });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: `Successfully replaced text in ${filePath}.`,
    });
  });
});
