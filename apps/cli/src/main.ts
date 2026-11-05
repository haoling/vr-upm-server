import { run } from "./cli.js";
import { baseDir } from "./base-dir.js";

const code = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: baseDir(process.env, process.cwd()),
});
process.exitCode = code;
