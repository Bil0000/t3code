import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it, vi } from "vite-plus/test";

import { watchBuildFiles } from "./watch-build-files.mjs";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal()),
  watch: vi.fn(),
}));

it("ignores metadata changes while preserving rebuild and replacement notifications", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-build-watch-"));
  const file = NodePath.join(directory, "main.cjs");
  const onChange = vi.fn();
  try {
    NodeFS.writeFileSync(file, "first build");
    watchBuildFiles(directory, new Set(["main.cjs"]), onChange);
    const notify = NodeFS.watch.mock.calls.at(-1)[2];

    NodeFS.chmodSync(file, 0o600);
    notify("change", "main.cjs");
    notify("rename", "main.cjs");
    assert.equal(onChange.mock.calls.length, 0);

    const timestamp = NodeFS.statSync(file).mtime;
    NodeFS.writeFileSync(file, "other build");
    NodeFS.utimesSync(file, timestamp, timestamp);
    notify("change", "main.cjs");
    assert.equal(onChange.mock.calls.length, 1);

    notify("change", "main.cjs");
    notify("change", "main.cjs.map");
    notify("rename", null);
    assert.equal(onChange.mock.calls.length, 1);

    NodeFS.unlinkSync(file);
    notify("rename", "main.cjs");
    NodeFS.writeFileSync(file, "third build");
    notify("rename", "main.cjs");
    assert.equal(onChange.mock.calls.length, 3);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
