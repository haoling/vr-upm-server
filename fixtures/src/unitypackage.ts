/**
 * 合成 unitypackage の組み立て。
 *
 * unitypackage は tar.gz で、各アセットが `<guid>/asset`, `<guid>/asset.meta`, `<guid>/pathname`
 * (と任意の `<guid>/preview.png`)を持つ。フォルダは `asset` を持たず、.meta と pathname だけになる。
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gzipSync } from "node:zlib";
import { type TarBody, tarChunks, type TarEntry } from "./tar.js";

export interface FixtureAsset {
  /** pathname ファイルに書く内容 */
  pathname: string;
  /** 省略するとフォルダ(asset を持たないエントリ)になる */
  content?: TarBody;
  /** 省略すると pathname から決定的に作る */
  guid?: string;
  /** .meta の中身。null なら .meta を入れない。省略すると guid に合わせた .meta を作る */
  meta?: string | null;
  /** .meta に書く guid だけを変える(guid 不一致の再現用) */
  metaGuid?: string;
  preview?: boolean;
}

export function fixtureGuid(seed: string): string {
  return createHash("md5").update(seed).digest("hex");
}

export function fixtureMeta(guid: string, folder = false): string {
  return folder
    ? `fileFormatVersion: 2\nguid: ${guid}\nfolderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n  userData:\n  assetBundleName:\n  assetBundleVariant:\n`
    : `fileFormatVersion: 2\nguid: ${guid}\nDefaultImporter:\n  externalObjects: {}\n  userData:\n  assetBundleName:\n  assetBundleVariant:\n`;
}

/** アセット定義を tar エントリ列にする(GUID 順) */
export function unitypackageEntries(assets: FixtureAsset[], extra: TarEntry[] = []): TarEntry[] {
  const groups = assets.map((asset) => {
    const guid = asset.guid ?? fixtureGuid(asset.pathname);
    const entries: TarEntry[] = [{ path: `${guid}/`, type: "directory" }];
    if (asset.content !== undefined) entries.push({ path: `${guid}/asset`, body: asset.content });
    if (asset.meta !== null) {
      entries.push({
        path: `${guid}/asset.meta`,
        body: asset.meta ?? fixtureMeta(asset.metaGuid ?? guid, asset.content === undefined),
      });
    }
    entries.push({ path: `${guid}/pathname`, body: asset.pathname });
    if (asset.preview) entries.push({ path: `${guid}/preview.png`, body: new Uint8Array(8) });
    return { guid, entries };
  });
  groups.sort((a, b) => (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0));
  return [...groups.flatMap((g) => g.entries), ...extra];
}

/** 小さな unitypackage をメモリ上に作る(テスト用) */
export function buildUnitypackage(entries: TarEntry[]): Buffer {
  return gzipSync(Buffer.concat([...tarChunks(entries)]));
}

/** unitypackage をファイルに書き出す。巨大なエントリもストリームで書く */
export async function writeUnitypackageFile(file: string, entries: TarEntry[]): Promise<void> {
  await pipeline(Readable.from(tarChunks(entries)), createGzip(), createWriteStream(file));
}
