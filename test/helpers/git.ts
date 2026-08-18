import { execFileSync } from "node:child_process";

export const REVIEW_HEAD = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
export const REVIEW_BASE = execFileSync("git", ["rev-parse", "HEAD^"], { encoding: "utf8" }).trim();
export const REVIEW_COMMON_DIR = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
