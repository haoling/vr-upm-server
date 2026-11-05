/**
 * 相対パスの基準ディレクトリを決める。
 *
 * `yarn workspace @vr-upm/cli start ...` はパッケージのディレクトリ(apps/cli)でスクリプトを実行し、
 * 呼び出し元のディレクトリは渡されない(`INIT_CWD` も apps/cli になる)。
 * Yarn が設定する `PROJECT_CWD`(リポジトリのルート)があればそれを基準にして、
 * `yarn workspace @vr-upm/cli start analyze fixtures/out/simple.unitypackage` のように
 * ルートからの相対パスで書けるようにする。Yarn 経由でなければ(`tsx src/main.ts` など)実際の cwd を使う。
 */
export function baseDir(env: Record<string, string | undefined>, cwd: string): string {
  return env.PROJECT_CWD || cwd;
}
