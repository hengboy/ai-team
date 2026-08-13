import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { EnvironmentService } from "../src/environment.js";
import { runnableTaskBatches, validateTaskGraph, type TaskDefinition } from "../src/tasks.js";

const tasks = (): TaskDefinition[] => [
  { task_id: "TASK-001", title: "API", requirements: ["REQ-001"], acceptance_criteria: ["AC-001"], dependencies: [], allowed_write_paths: ["src/api/**"] },
  { task_id: "TASK-002", title: "UI", requirements: ["REQ-002"], acceptance_criteria: ["AC-002"], dependencies: [], allowed_write_paths: ["src/ui/**"] },
  { task_id: "TASK-003", title: "Integration", requirements: ["REQ-003"], acceptance_criteria: ["AC-003"], dependencies: ["TASK-001", "TASK-002"], allowed_write_paths: ["src/integration/**"] },
];

test("task graph produces non-overlapping dependency batches and rejects cycles", () => {
  assert.deepEqual(runnableTaskBatches(tasks()), [["TASK-001", "TASK-002"], ["TASK-003"]]);
  const overlapping = tasks(); overlapping[1]!.allowed_write_paths = ["src/api/client.ts"];
  assert.deepEqual(runnableTaskBatches(overlapping), [["TASK-001"], ["TASK-002"], ["TASK-003"]]);
  const cyclic = tasks(); cyclic[0]!.dependencies = ["TASK-003"];
  assert.throws(() => validateTaskGraph(cyclic), /dependency cycle/);
  const unknown = tasks(); unknown[2]!.dependencies = ["TASK-999"];
  assert.throws(() => validateTaskGraph(unknown), /unknown dependencies/);
});

test("client version gates use persisted probe facts and never silently downgrade", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-team-version-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const aiTeamHome = join(root, "config"); const userHome = join(root, "user"); const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const service = new EnvironmentService(aiTeamHome, userHome);
  await service.bootstrap();
  await assert.rejects(service.validateClientVersions(["codex"]), /version gate blocked/);
  const originalPath = process.env.PATH; process.env.PATH = bin;
  try {
    await writeFile(join(bin, "codex"), "#!/bin/sh\necho codex-cli 0.100.0\n"); await chmod(join(bin, "codex"), 0o700);
    await service.doctor(true);
    await assert.rejects(service.validateClientVersions(["codex"]), /version gate blocked/);
    await writeFile(join(bin, "codex"), "#!/bin/sh\necho codex-cli 99.0.0\n");
    await service.doctor(true);
    assert.deepEqual(await service.validateClientVersions(["codex"]), [{ platform: "codex", status: "warning-unverified", version: "99.0.0" }]);
    const config = YAML.parse(await readFile(join(aiTeamHome, "config.yaml"), "utf8"));
    assert.equal(config.client_versions.codex.detected_version, "99.0.0");
  } finally { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; }
});
