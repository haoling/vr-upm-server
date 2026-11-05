import { run } from "./cli.js";

// `pnpm --filter @vr-upm/cli start ...` はパッケージのディレクトリで実行されるので、
// 相対パスは pnpm を起動したディレクトリ(INIT_CWD)を基準にする
const code = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.env.INIT_CWD ?? process.cwd(),
});
process.exitCode = code;
