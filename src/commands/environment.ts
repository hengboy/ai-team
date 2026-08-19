import { Command, Option } from "commander";
import { ROLES, type Role } from "../constants.js";
import { EnvironmentService, PLATFORMS, type Platform } from "../environment.js";
import { ArgumentError } from "../errors.js";

type Output = (value: unknown) => void;

const platformList = (value: string): Platform[] => {
  const platforms = value.split(",") as Platform[];
  if (platforms.some((item) => !PLATFORMS.includes(item))) throw new ArgumentError(`invalid platform list: ${value}`);
  return platforms;
};

export const registerEnvironmentCommands = (program: Command, output: Output): void => {
  program.command("install").option("--platform <list>", "comma-separated platforms", platformList).option("--dry-run").action(async (options) => {
    const service = new EnvironmentService();
    const environment = await service.load(await service.active());
    const platforms = options.platform ?? environment.platforms;
    const versions = await service.validateClientVersions(platforms);
    output({ versions, plan: await service.generate(environment.name, platforms, options.dryRun) });
  });
  const env = program.command("env");
  env.command("list").action(async () => output(await new EnvironmentService().list()));
  env.command("show").argument("<name>").option("--resolved").action(async (name, options) => {
    const service = new EnvironmentService();
    output(options.resolved ? await service.resolved(name) : await service.load(name));
  });
  env.command("validate").argument("<name>").action(async (name) => output(await new EnvironmentService().validate(name)));
  env.command("explain").argument("<name>")
    .addOption(new Option("--role <role>").choices([...ROLES]).makeOptionMandatory())
    .addOption(new Option("--platform <platform>").choices([...PLATFORMS]).makeOptionMandatory())
    .action(async (name, options) => output(await new EnvironmentService().explain(name, options.role as Role, options.platform as Platform)));
  env.command("diff").argument("<from>").argument("<to>")
    .addOption(new Option("--role <role>").choices([...ROLES]))
    .addOption(new Option("--platform <platform>").choices([...PLATFORMS]))
    .action(async (from, to, options) => output(await new EnvironmentService().diff(from, to, options.role as Role | undefined, options.platform as Platform | undefined)));
  env.command("edit").argument("<name>").action(async (name) => {
    const service = new EnvironmentService();
    await service.load(name);
    output({ path: `${service.paths.environments}/${name}.yaml`, edited: false, note: "edit the validated YAML file with your preferred editor" });
  });
  env.command("generate").option("--platform <list>", "comma-separated platforms", platformList).option("--dry-run").action(async (options) => {
    const service = new EnvironmentService();
    output(await service.generate(await service.active(), options.platform, options.dryRun));
  });
  env.command("switch").argument("<name>").option("--dry-run").action(async (name, options) => output(await new EnvironmentService().generate(name, undefined, options.dryRun)));
  env.command("status").action(async () => output(await new EnvironmentService().status()));
  env.command("doctor").option("--probe").action(async ({ probe }) => output(await new EnvironmentService().doctor(probe)));
  const backup = program.command("backup");
  backup.command("restore").argument("<path>").option("--dry-run").action(async (path, options) => output(await new EnvironmentService().restore(path, options.dryRun)));
  program.command("uninstall").option("--dry-run").action(async ({ dryRun }) => output(await new EnvironmentService().uninstall(dryRun)));
};
