import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface HomePaths {
  root: string;
  state: string;
  database: string;
  backups: string;
  environments: string;
  schemas: string;
  templates: string;
  artifacts: string;
  staging: string;
}

export const getHomePaths = (override = process.env.AI_TEAM_HOME): HomePaths => {
  const root = resolve(override ?? join(homedir(), ".config", "ai-team"));
  return {
    root,
    state: join(root, "state"),
    database: join(root, "state", "state.sqlite"),
    backups: join(root, "backups"),
    environments: join(root, "environments"),
    schemas: join(root, "schemas"),
    templates: join(root, "templates"),
    artifacts: join(root, "state", "artifacts"),
    staging: join(root, "state", "staging"),
  };
};
