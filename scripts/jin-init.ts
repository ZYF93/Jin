import { initProject } from "../electron/core/project/init";
import { locateProject } from "../electron/core/project/config";

interface Args {
  name?: string;
  languages?: string[];
  force: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { force: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--name") {
      args.name = argv[index + 1];
      index += 1;
    } else if (arg === "--languages") {
      args.languages = (argv[index + 1] ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      index += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Usage: jin init [--name <name>] [--languages ts,react] [--force]

Initializes .jin/ in the current Git repository (or the current directory).
--force refreshes config.yaml and .gitignore but never truncates wal.jsonl.`);
  process.exit(0);
}

try {
  const location = locateProject(process.cwd());
  const root = location?.root ?? process.cwd();
  const result = initProject(root, {
    name: args.name,
    languages: args.languages,
    force: args.force,
  });
  console.log(
    `${result.created ? "Created" : "Already initialized"}: ${result.jinDir}`,
  );
  console.log(`Project: ${result.config.project.name}`);
  console.log(`Languages: ${result.config.project.languages.join(", ")}`);
  console.log(`WAL: ${result.walPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
