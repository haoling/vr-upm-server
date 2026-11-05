// libnpmpublish は型定義を持たないので、使う部分だけ宣言する
declare module "libnpmpublish" {
  export interface PublishOptions {
    registry?: string;
    /** 認証(この指定だけを使い、~/.npmrc などは見ない)。`token` は Bearer トークン */
    forceAuth?: { token?: string };
    npmVersion?: string;
    defaultTag?: string;
    access?: "public" | "restricted" | null;
    algorithms?: string[];
  }
  /** 失敗時は npm-registry-fetch のエラー(`statusCode`、`code` など)を投げる */
  export function publish(manifest: Record<string, unknown>, tarData: Buffer, opts?: PublishOptions): Promise<unknown>;
}
