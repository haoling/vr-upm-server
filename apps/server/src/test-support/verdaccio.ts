import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfigFile, runServer } from "verdaccio";

/** リポジトリに置いてあるローカル確認用の設定例(docker compose が使うものと同じファイル) */
export const EXAMPLE_CONFIG_PATH = fileURLToPath(new URL("../../../../verdaccio/conf/config.yaml", import.meta.url));

export interface TestUser {
  name: string;
  password: string;
}

export interface TestVerdaccio {
  /** `http://127.0.0.1:<port>` */
  url: string;
  close(): Promise<void>;
}

/** htpasswd の `{SHA}` 形式の行(`max_users: -1` で自己登録できないので、ユーザーはファイルに直接書く) */
const htpasswdLine = (u: TestUser) => `${u.name}:{SHA}${createHash("sha1").update(u.password, "utf8").digest("base64")}`;

/**
 * Verdaccio をプロセス内で起動する(Docker は使わない。テストと `yarn dev:registry` が使う)。
 * 設定は `verdaccio/conf/config.yaml` をそのまま読み、storage・htpasswd のパス、ログ、待ち受けだけ差し替える。
 * つまり `$authenticated` / uplink なし / `max_users: -1` / publish 権限の制限は、実際に配る設定のままテストされる。
 */
export async function startVerdaccio(
  dir: string,
  users: TestUser[],
  { port = 0, logLevel = "fatal" }: { port?: number; logLevel?: string } = {},
): Promise<TestVerdaccio> {
  const htpasswd = join(dir, "htpasswd");
  await writeFile(htpasswd, `${users.map(htpasswdLine).join("\n")}\n`);

  // biome-ignore lint/suspicious/noExplicitAny: Verdaccio の設定オブジェクト(型が緩い)を書き換える
  const config = parseConfigFile(EXAMPLE_CONFIG_PATH) as Record<string, any>;
  config.storage = join(dir, "storage");
  config.auth.htpasswd.file = htpasswd;
  config.log = { type: "stdout", format: "pretty", level: logLevel };

  const app = await runServer(config);
  const server = await new Promise<import("node:http").Server>((resolve, reject) => {
    const s = app.listen(port, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve(s)));
  });
  const { port: actualPort } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** ユーザー名・パスワードでログインして、レジストリのトークンを得る(`npm login` と同じ API) */
export async function loginForToken(registryUrl: string, user: TestUser): Promise<string> {
  const res = await fetch(`${registryUrl}/-/user/org.couchdb.user:${encodeURIComponent(user.name)}`, {
    method: "PUT",
    // 既存ユーザーのログインは Basic 認証つきの PUT(認証なしの PUT は新規登録扱いになり、max_users: -1 で拒否される)
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${user.name}:${user.password}`).toString("base64")}`,
    },
    body: JSON.stringify({ name: user.name, password: user.password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}
