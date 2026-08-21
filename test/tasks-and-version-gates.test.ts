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

test("client version gates require the exact persisted verified version", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-team-version-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const aiTeamHome = join(root, "config"); const userHome = join(root, "user"); const bin = join(root, "bin");
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(userHome, { recursive: true })]);
  const service = new EnvironmentService(aiTeamHome, userHome);
  await service.bootstrap();
  await assert.rejects(service.validateClientVersions(["codex"]), /version gate blocked/);
  await assert.rejects(service.generate("balanced", ["codex"]), /version gate blocked/);
  const originalPath = process.env.PATH; process.env.PATH = bin;
  try {
    await writeFile(join(bin, "codex"), "#!/bin/sh\necho codex-cli 0.100.0\n"); await chmod(join(bin, "codex"), 0o700);
    await service.doctor(true);
    await assert.rejects(service.validateClientVersions(["codex"]), /version gate blocked/);
    await writeFile(join(bin, "codex"), "#!/bin/sh\necho codex-cli 99.0.0\n");
    await service.doctor(true);
    await assert.rejects(service.validateClientVersions(["codex"]), (error: unknown) => {
      assert.equal((error as { code?: number }).code, 4);
      assert.deepEqual((error as { details?: { reason_code?: string; next_action?: string } }).details, {
        reason_code: "client_version_not_verified",
        next_action: "reset",
        clients: [{ platform: "codex", status: "incompatible", version: "99.0.0" }],
      });
      return true;
    });
    const config = YAML.parse(await readFile(join(aiTeamHome, "config.yaml"), "utf8"));
    assert.equal(config.client_versions.codex.detected_version, "99.0.0");
    config.client_versions.codex.detected_version = "0.145.0";
    config.client_versions.codex.verified = "99.0.0";
    await writeFile(join(aiTeamHome, "config.yaml"), YAML.stringify(config));
    await assert.rejects(service.validateClientVersions(["codex"]), (error: unknown) => {
      assert.deepEqual((error as { details?: unknown }).details, {
        reason_code: "client_version_metadata_mismatch",
        next_action: "reset",
        platform: "codex",
      });
      return true;
    });
  } finally { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; }
});
